# GanttChart — production operations plan (Cloudflare Free, `workers.dev`)

Status: **Stage 5 is deployed.** This document describes the **Stage 6 target state**
(public sign-in page, protected application routes, safer configuration) and the
manual steps to reach it. **Nothing in this document has been executed by the
development tooling:** no deployment, no secret, no Access change, no DNS change.
Every step marked *you run* is performed manually by the owner.

> **Cloudflare authentication is not GanttChart authorization.**
> Cloudflare Access proves **who** a person is (a verified email). GanttChart's own
> registry decides **whether** that person may use the application, as which role,
> in which workspace. An authenticated `@rakuten.com` employee who has no GanttChart
> account is shown "no account" and is never added automatically.

## 1. Model

```
anyone ──► https://ganttchart.damithfdo.workers.dev/        PUBLIC  (static sign-in page, no data)
                │  click "Sign in"
                ▼
           /login        ── Cloudflare Access (login, one-time PIN) ──► Worker verifies the Access JWT ──► 302 "/"
                │
                ▼ the app calls (same origin, with the Access cookie)
           /api/*        ── Access ──► Worker: JWT → registry lookup → role/tenant/status → permission
           /ws           ── Access ──► Worker: same pipeline, then the tenant's own Durable Object
```

| Path | Who may reach it | What it serves |
|---|---|---|
| `/`, `/assets/*` and every other path not listed below (single-page-app fallback) | **Anyone** (public) | The built SPA: code and static text. **No data, ever.** |
| `/login` | Passes through **Access**; the Worker also verifies the token | A redirect to `/` for a verified token, otherwise back to `/?signin=unavailable` |
| `/api/*` | **Access** + Worker JWT check + registry + permission | Every API |
| `/ws` | **Access** + Worker JWT check + registry + permission | Live sync WebSocket |

The list `/api/*`, `/ws`, `/login` is the single source of truth in `shared/routes.ts`.
`wrangler.jsonc` (`assets.run_worker_first`), the Worker routing and these Access
destinations are kept identical by a unit test and by the pre-deployment guard (§8).

### Why this design (audit findings)

* **Only three kinds of URL matter for security** — the Worker's own routes. Static
  files are code, so serving them publicly is safe; everything with data is behind the
  Worker.
* **Access is defence in depth, not the only gate.** The Worker verifies the Access
  token (RS256, exact issuer, exact AUD, expiry) on **every** `/api/*`, `/ws` and
  `/login` request and fails closed. This is tested with Access *absent*: an anonymous
  request that reaches the Worker directly still gets `401` and no information
  (`worker/test/prod-sim`). So even a wrong or missing Access destination cannot expose
  tenant data; it can only make sign-in fail.
* **The SPA stays one bundle at `/`.** A separate `/app` route would need a second HTML
  entry, client-side routing changes and a redirect back from Access for no security
  gain: the data lives behind `/api` and `/ws`, not behind a page URL. `/login` is the
  smallest thing that gives "Sign in" a URL Access can protect.
* **Same origin, so WebSockets just work.** Access sets its `CF_Authorization` cookie
  for the hostname, so after sign-in the browser sends it on `/api/*` and on the
  `/ws` upgrade, exactly as it did when Access covered the whole hostname. *This is the
  one Cloudflare behaviour the documentation does not state explicitly;* rollout step 8
  verifies it, and a failure there fails closed (you see the sign-in page again), never open.
* **Path matching quirks cannot expose data.** Case changes, `//api`, `%61pi`,
  `/api/../`, trailing slashes: whatever Access decides about such a path, the Worker
  only treats `/api/…` and `/ws` as data routes and refuses them without a token; all
  other paths are the public shell. Tested (`path tricks` in the prod-sim suite).
* **No query strings, no ports in Access paths** (Cloudflare does not support them); the design uses none.

## 2. Accounts: who creates whom

```
Super Admin  (configuration: SUPER_ADMIN_EMAILS)        sees workspace metadata only, never QA data
   └─ creates an Admin  (with a workspace)              only the Super Admin can; Admin email must be in a managed domain
        └─ creates Users in that workspace              only that Admin can; User email must be in a managed domain
```

* **No public registration of any kind.** No Create Account, Request Account, sign-up,
  invitation-acceptance or tenant-selection page exists. A first successful sign-in only
  *activates* an account that an Admin/Super Admin already created.
* **Managed domains** (`MANAGED_USER_EMAIL_DOMAINS`, default `rakuten.com`; comma-separated
  for several): the registry refuses to create an Admin or User whose email domain is not
  exactly one of them. `user@fake-rakuten.com`, `user@rakuten.com.attacker.example`,
  `user@gmail.com` and `user@sub.rakuten.com` are rejected (a subdomain must be listed
  itself). An empty/invalid setting means **nobody can be created** (fail closed).
  Super Admin identities (`SUPER_ADMIN_EMAILS`) are configuration and exempt.
* **Older accounts outside the managed domains are never touched.** They keep working,
  are not deactivated or migrated, and the Super Admin console flags them. Removal is
  only through the existing deletion-request → Super Admin approval workflow.

### What Access policy is needed now

Access decides who may **reach** the app. The registry decides who may **use** it. Because the
registry is the real gate, the Access policy no longer lists individual Users:

| Access policy | Include | Purpose |
|---|---|---|
| "Organization" | Emails ending in `@rakuten.com` (One-time PIN) | Any employee can *authenticate*; without a registry account they only see "no account" |
| "Platform administrators" (today's temporary exact-email policy) | the Super Admin address(es) outside the organization domain | Needed only while a Super Admin or an older Admin is outside `@rakuten.com`. Keep it as small as possible; **not stored in the repository** |

A person outside every Access policy cannot even sign in, so an older Admin on a non-Rakuten
address (the existing Gmail test workspace) cannot reach the app unless the "Platform
administrators" policy lists them.

### Signing out

Every signed-in person (Super Admin, Admin, User) has a **Logout** control (Platform Administration header; the
application header for Admin and User, including an Admin in local mode). It signs out **this browser only**.

* **Endpoint:** `<application-domain>/cdn-cgi/access/logout`, i.e. for production
  `https://ganttchart.damithfdo.workers.dev/cdn-cgi/access/logout`. The page uses the relative path
  `/cdn-cgi/access/logout`, with no parameters. It is a Cloudflare-managed path, **not** a Worker route: the Worker has no
  logout API, accepts no user id or email for logging out, and cannot sign anyone else out.
* **What the page does first:** warns if edits are still unsent (Cancel keeps everything running), stops live sync
  (closes the WebSocket, cancels reconnect/heartbeat timers), saves the device's own copy, clears the signed-in state
  from memory, then navigates to the endpoint. The device's own data is kept (see below).
* **Cloudflare limitations** (from Cloudflare's documentation): Access logout is **not per application**; it ends the
  user's Access session **across every application in the same Zero Trust organization**. The cookie is cleared at once,
  but already-issued tokens can still be accepted for about **20–30 seconds**, so the page treats the browser as signed out
  immediately and does not rely on server-side revocation. The endpoint takes **no documented return URL**, so none is
  used: after logout Cloudflare shows its own page, and the person returns to `/` (the public page) themselves.
* **Not verified from here:** that `/cdn-cgi/access/logout` is answered by Cloudflare when Access protects only the three
  paths in §5 (not the whole hostname). Rollout step 7b checks it. If Access does *not* answer, the SPA is served at that URL
  and says that the sign-out was not completed, instead of looking signed out.
* **Kept on the device (never deleted by logout):** the local database and backups, the device's copy of a shared workspace
  and its link (reused only for the same person in the same workspace; anyone else is treated as foreign), language and
  other per-device preferences. "Clear this device" in Settings is a different, deliberate action.

## 3. Configuration (where each setting lives)

| Setting | Kind | Where | Why |
|---|---|---|---|
| `ACCESS_TEAM_DOMAIN` = `https://qa-internal.cloudflareaccess.com` | non-secret | `worker/wrangler.jsonc` → `vars` | It is public (it appears in the login URL). Committing it means a plain deploy can never blank it. |
| `MANAGED_USER_EMAIL_DOMAINS` = `rakuten.com` | non-secret | `wrangler.jsonc` → `vars` | Same reasoning. |
| `HISTORY_RETENTION_DAYS` = `30` | non-secret | `wrangler.jsonc` → `vars` | |
| `ACCESS_AUD` | **Worker secret** | `wrangler secret put` | Identifies the Access application. Not sensitive on its own, but kept out of `vars` so no config file can overwrite it. |
| `SUPER_ADMIN_EMAILS` | **Worker secret** | `wrangler secret put` | Names the platform administrator(s): personal data, and a high-value setting. |

Why secrets rather than `--var`: **deploying never deletes a Worker secret**, whereas a plain
deploy replaces every `vars` value with what the file says (the old risk: a plain deploy would
have blanked `ACCESS_AUD`). `wrangler.jsonc` also declares

```jsonc
"secrets": { "required": ["ACCESS_AUD", "SUPER_ADMIN_EMAILS"] }
```

so a deployment is refused if either is missing, and Wrangler itself rejects a config that
lists a name both as a var and a secret. The pre-deployment guard (§8) additionally refuses a
config where either name reappears under `vars`.

If the Worker is ever started without them it **fails closed** (HTTP 500 on every API call);
it never allows access.

### Stage 7 deployment notes (accounts, audit trail, navigation)

* **No Cloudflare change.** No Access destination, secret, variable or Wrangler migration tag changes. The registry Durable Object
  upgrades its own SQLite schema the first time the new code starts (adds one nullable column and one append-only table).
* **No data migration.** Existing workspaces, accounts (including any stored as "invited" and the existing non-managed test
  workspace) and deletion records are untouched. Older browsers keep working (they ignore the new fields).
* Roll out like any code deploy: `npm run build`, then `cd worker && npm run validate`, then `npx wrangler deploy --env=""` (the guard runs
  automatically). Rollback is `npx wrangler rollback`; the extra column and table are ignored by the previous code.
* After deploying, check: (1) sign in as the Super Admin: the console shows four tabs; (2) create/disable/reactivate a test workspace
  and see the entries in *Audit log*; (3) as an SV in Web storage open *Team Members*, add and disable a Tester; (4) the user's
  open session ends within seconds.

## 4. Free-plan resources (unchanged by Stage 6)

Worker `ganttchart` (Workers Free) with Durable Object classes `WorkspaceRoom` (one per workspace)
and `RegistryRoom` (one), static assets, `workers.dev` route, preview URLs **off**. No D1, KV, R2,
Queues, Workflows, Hyperdrive, Workers Paid, custom domain, zone or DNS record. Zero Trust **Free**.
**Stage 6 needs no Durable Object migration** (no new class, no schema change) and **no data
migration**.

## 5. Target Cloudflare Access configuration (*you run*)

In Zero Trust → Access → Applications → **GanttChart** (the existing self-hosted application):

| # | Destination (domain + path) |
|---|---|
| 1 | `ganttchart.damithfdo.workers.dev` + path `/login` |
| 2 | `ganttchart.damithfdo.workers.dev` + path `/api` |
| 3 | `ganttchart.damithfdo.workers.dev` + path `/ws` |

and **remove** the destination that has an empty path (the whole hostname). Per Cloudflare's
documentation a path without a wildcard protects that path **and everything under it**, so `/api`
covers `/api/whoami`, `/api/revisions/3`, … One application keeps **one AUD tag**, so
`ACCESS_AUD` does not change. (If your dashboard only allows one destination per application, create
one application per path instead; each has its own AUD. `ACCESS_AUD` accepts a comma-separated list
and every entry is matched exactly.)

Keep the existing policies attached to the application. Session length and login method are
unchanged.

## 6. Safe rollout sequence

**Principle:** the Worker protects `/api/*`, `/ws` and `/login` by itself, so there is no step at which
tenant data is public, whichever of the code or the Access change comes first. The order below
additionally keeps Stage 5's behaviour (whole hostname behind Access) until the new code is verified.

| Order | Result |
|---|---|
| **A. code first, then Access** (chosen) | After the deploy Access still covers the whole hostname: nothing is public that was not before. The Access change then opens only `/`, which holds no data. |
| B. Access first, then code | Safe for data (the old Worker also verifies the token on `/api` and `/ws`) but visitors would reach the *old* app shell with no public page and no `/login`: a broken sign-in for no benefit. |
| C. deploy without the secrets | Not possible: the config requires them (`secrets.required`). |

**0. Local (no account access)** — from the repository root:

```bash
npm run build
cd worker
npm run validate        # runs the safety guard, then a dry-run deploy that uploads nothing
```

**1. Move the two auth settings to secrets (*you run*).** Use the **same values** the Worker has today
(the AUD tag of the GanttChart Access application, and the Super Admin email list):

```bash
cd worker
npx wrangler secret put ACCESS_AUD            # paste the AUD tag when prompted
npx wrangler secret put SUPER_ADMIN_EMAILS    # paste e.g. admin@example.com  (several: a@x.com,b@y.com)
npx wrangler secret list                      # read-only: names only
```

Verify the current site still works for a signed-in Super Admin. *Unverified by me:* whether
Cloudflare accepts a secret with the same name as the existing plain-text variable. If `secret put`
refuses, open Workers & Pages → `ganttchart` → Settings → **Variables and secrets**, change each of
these two entries to type **Secret** (same value), or delete the plain variable and re-run the
command. The worst case is a few minutes in which every API call fails closed (HTTP 500); no data is
exposed.

**2. Deploy the new code (*you run*)** — Access is still on the whole hostname:

```bash
cd worker
npx wrangler deploy --env=""
```

The guard runs automatically before the upload (it is wired as the config's `build` command) and
aborts the deploy if anything in §8 fails. **Do not** pass `--var ACCESS_AUD…` or
`--var SUPER_ADMIN_EMAILS…`: those names are secrets now.

**3. Verify the deployment (Access unchanged).** Sign in as before; the app, live sync and Platform
Administration work. Anonymous requests are still stopped by Access.

**4. Change the Access destinations (*you run*)** as in §5 (add the three path destinations, then
remove the whole-hostname one).

**5. Anonymous checks** (no cookies; any machine):

```bash
BASE=https://ganttchart.damithfdo.workers.dev
curl -s -o /dev/null -w "root:   %{http_code} %{content_type}\n" $BASE/                    # 200 text/html (the public page)
curl -s -o /dev/null -w "whoami: %{http_code} %{redirect_url}\n" $BASE/api/whoami          # 302 to cloudflareaccess.com (or 401). NEVER 200
curl -s -o /dev/null -w "export: %{http_code} %{redirect_url}\n" $BASE/api/export          # 302 or 401
curl -s -o /dev/null -w "super:  %{http_code} %{redirect_url}\n" $BASE/api/super/tenants   # 302 or 401
curl -s -o /dev/null -w "login:  %{http_code} %{redirect_url}\n" $BASE/login               # 302 to cloudflareaccess.com
curl -s -o /dev/null -w "ws:     %{http_code}\n" -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Origin: $BASE" $BASE/ws                                                              # 302 or 401. NEVER 101
```

A `302` is Access answering; a `401` is the Worker answering (Access not in front of that path). Either
is correct. **Any `200` from an `/api` path, or `101` from `/ws`, means stop and roll back (§7).**

**6. Browser checks.** Open the site in a private window: the public page shows (EN/日本語, Sign in,
no Register). Sign in as the Super Admin → Platform Administration opens.

**7. Account checks.** (a) Sign in with an `@rakuten.com` address that has **no** account → "Your identity
was verified, but you do not have a GanttChart account." (b) Create an Admin with a `@rakuten.com` address as
Super Admin; creating one with a Gmail address must fail with a clear message. (c) Sign in as that Admin; as
Admin, create a User (managed domain only); sign in as the User.

**7b. Sign-out check.** Sign in, click **Logout**: the browser goes to Cloudflare's sign-out page; open the site address again:
the public page shows, and `/api/whoami` (in the same browser) is refused. If the browser stays signed in, or the public page
shows "Cloudflare Access did not complete the sign-out", Access is not handling `/cdn-cgi/access/logout` for this hostname:
tell the developer; nothing is exposed (the Worker still checks every token), but Logout is not effective until fixed.
Remember that this ends the person's Access session for **all** applications in the organization.

**8. WebSocket check.** As a web-mode Admin/User, edit in two browsers: the header shows "synced" and the edit
appears in the other browser. (Verifies the Access cookie is sent on the `/ws` upgrade.) If you are sent
back to the sign-in page after signing in, or sync never connects: roll back the Access change (§7), nothing
else.

**9. Clean up.** Rename the temporary maintenance policy to what it is ("Platform administrators") or remove it
once no Super Admin / older Admin needs it.

## 7. Rollback (all reversible; none touches data)

1. **Access (fastest, no deploy):** set the application's destination back to the **whole hostname** (empty
   path) and remove the three path destinations. Everything is behind Access again, exactly Stage 5's behaviour; the
   new Worker works with it (visitors just never see the public page).
2. **Code:** `npx wrangler rollback` (restores the previous Worker version; Durable Object data is not versioned
   and is untouched). The secrets of step 1 also work with the previous code (it reads the same names).
3. **Secrets:** `npx wrangler secret delete` is **not** part of any rollback and would take the app offline (fails
   closed).
4. Never `wrangler delete` the Worker: that would delete the Durable Objects and all workspaces.

## 8. Pre-deployment guard

`worker/scripts/check-production.mjs` runs before **every** `wrangler deploy` of `wrangler.jsonc` (and before
`wrangler types`/dry-runs), through the config's `build.command`. It deploys nothing and contacts no account.
It refuses the deployment when:

* `ACCESS_TEAM_DOMAIN` is not `https://<team>.cloudflareaccess.com` (no path, no trailing slash);
* `MANAGED_USER_EMAIL_DOMAINS` is empty or contains entries that are not plain domains;
* `ACCESS_AUD` or `SUPER_ADMIN_EMAILS` appears under `vars`, or is missing from `secrets.required`;
* any development variable (`ENVIRONMENT`, `DEV_EMAIL`, `ALLOWED_ORIGINS`) is in the production config;
* the `WORKSPACE`/`REGISTRY` bindings or `ASSETS` are missing;
* the Durable Object migrations `v1` (`WorkspaceRoom`) and `v2` (`RegistryRoom`) are not intact, or a migration
  deletes/renames/transfers a class;
* `assets.run_worker_first` differs from `["/api/*", "/ws", "/login"]`, or the SPA fallback is off;
* `preview_urls` is not `false`, or `account_id`/routes are committed;
* `../dist/index.html` (the production SPA) does not exist;
* observability is off or the sampling rate is invalid;
* this document no longer mentions the settings above.

It **cannot** see the account, so it reminds you that the two secrets and the Access destinations are manual
(`npm run check:production` runs it on its own). There is deliberately no deploy script.

## 9. Observability

`head_sampling_rate` stays **1**. Reasoning: the free Workers Logs allowance is 200,000 events/day; this app
produces a few thousand at most (a handful of API calls per person per session; WebSocket heartbeats are answered
without waking the Worker). Sampling would cut volume that is not a problem while dropping most of the rare events
the logs exist for: `access_denied` (an authenticated person with no account; logged with the reason and the email
**domain only**, never the mailbox name) and `auth_misconfigured`. If invocations ever approach ~100,000/day, set
`0.1` in `wrangler.jsonc`: the guard accepts any rate in (0, 1].

## 10. Can any step cost money?

* **Workers Free / Durable Objects Free:** operations beyond a free limit **fail**; nothing is billed. No upgrade
  is made or needed.
* **Zero Trust Free:** $0. Cloudflare's current free user limit was not confirmed from documentation; stop if a
  payment method is requested.
* Static files (the public page) are free and unlimited. A flood of anonymous `/api` requests that Access does not
  intercept would count against the Worker's 100,000 requests/day (availability, not billing). With `/api` behind
  Access, anonymous requests are stopped at Cloudflare's edge before reaching the Worker.

## 11. Free-plan limits and the operating budget

| Limit (free) | Value | This app |
|---|---|---|
| Worker requests | 100,000 / day | only `/ws` upgrades, `/api/*` and `/login` count; static assets are free |
| Durable Object requests | 100,000 / day | 1 per connect + 1 per 20 WebSocket messages + RPC calls + **1 registry call per API request** |
| DO duration | 13,000 GB-s / day | hibernation: idle connected clients cost nothing |
| SQLite rows read | 5,000,000 / day | a snapshot per (re)connect + ≈60 per commit |
| SQLite rows written | **100,000 / day** | **3 per single-record save** |
| SQLite stored data | 5 GB total | history limited to 30 days; size guard prunes above 2 GB |
| CPU per request | 10 ms | commits are a few SQL statements |

All workspaces share these account-wide limits; with five busy workspaces roughly a fifth each. Moving a
workspace to **local** storage removes it from the shared budget. Worked example for one workspace (10 people
editing all day, a save every ~20 s each): 43,200 rows written (43%), ≈720 DO requests (<1%), ≈0.9 M rows read
(17%).

## 12. Known limits and open questions

* Whether `wrangler secret put` can replace a same-named plain variable (step 1 has a dashboard fallback).
* The Access cookie reaching `/api` and `/ws` when only those paths are protected (step 8 verifies it).
* The Cloudflare Zero Trust Free user limit.
* A second Access application per path would create separate AUDs (handled by a comma-separated `ACCESS_AUD`).

## Stage 8B rollout notes (SV / Tester roles, Owner SV, Team Members)

* **No Cloudflare change** (Access, secrets, variables, DNS, bindings) and **no Wrangler migration tag**. The registry Durable Object upgrades its
  own SQLite on the first start of the new code: one new nullable column, the old one-admin index dropped, each workspace's existing Admin recorded as
  its Owner SV, three guard triggers.
* **No manual data migration.** Existing Testers keep signing in unchanged. Existing roster ("RCS") members stay as they are; an SV links them to
  accounts from *Team Members* when wanted. Existing Testers have no profile until an SV creates or links one; until then they can raise tickets but not
  write performance rows, and **they can record Today's Execution only on projects they are assigned to** (assign them first).
* Roll out like any code deploy: `npm run build`, `cd worker && npm run validate`, then `npx wrangler deploy --env=""`.
* **Rollback rules.** *Before any workspace has a second SV*, rolling back to the Stage 8A Worker is possible: the old code recreates its one-admin index
  (still satisfied), ignores `owner_user_id`, and the extra triggers do not get in its way. *After any workspace has a second SV*, **do not roll back to Stage 8A**:
  its start-up recreates `users_one_admin_per_tenant`, which fails for that workspace and can stop `RegistryRoom` from starting, locking everybody out. Fix forward
  instead (deploy a corrected Stage 8B build). To be able to roll back during the first checks, do not create a second SV until the rest of the checks below have passed.
* After deploying check: (1) as the Super Admin the console lists workspaces with their Owner SV; (2) as an existing workspace's SV, *Team Members* shows
  them as **SV ★ Owner**; (3) add a second SV and a Tester; (4) sign in as the Tester: the menu is Dashboard, Projects / Test Executions, Gantt, Tickets,
  Performance, Team Members; History and Settings are absent; (5) as an SV open *History* and page through it; (6) Settings shows Data & Backup.

## Stage 8C rollout notes (test scopes, test cases)

* **No Cloudflare change** and **no Wrangler migration tag**; no registry schema change. Deploy like any code release: `npm run build`, `cd worker && npm run validate`,
  then `npx wrangler deploy --env=""`.
* **No data migration.** Existing workspaces have no scopes or cases until an SV creates them. Existing Testers keep their project-level assignments, which now mean
  "all active scopes of the project". Workspaces that still hold the old placeholder members (USER0001 to USER0008) keep them until an SV uses Team Members ->
  Clean up placeholders; nothing is deleted automatically.
* **Rollback.** The previous (Stage 8B.1) Worker ignores the three new record kinds it has stored (it would still list them as opaque records and serve them to every
  Tester); roll forward rather than back once test management data exists. The rule from Stage 8B (do not roll back to Stage 8A after a second SV) still applies.
* After deploying check: (1) the header shows your Tool Name or "QA Management", never the old label; (2) as an SV, Test Management -> add a scope and a few cases,
  assign a Tester to one scope; (3) sign in as that Tester: My Testing lists only that scope, results save; (4) other scopes are not visible to them.

## Stage 8D rollout notes (Total Test Cases, Team Members directory, team meeting)

* **No Cloudflare change** and **no Wrangler migration tag**; no registry schema change. Deploy like any code release: `npm run build`, `cd worker && npm run validate`, then `npx wrangler deploy --env=""`.
* **No data migration.** Everything is optional: scopes have no Total until an SV types one (the project keeps its own Total), profiles have no email until one is added, and there are no plans or notes until
  the first meeting. Existing Testers, links and assignments are untouched. Accounts without a profile are listed on Team Members for an SV to give one.
* **Rollback.** The Stage 8C Worker does not know the two new record kinds, the email rules or the member endpoints; roll forward rather than back once profiles carry emails or plans exist.
* After deploying check: (1) Test Management -> Scopes: type a Total on a scope; the Dashboard Total for that project becomes the sum and its field is read-only; (2) Team Members: add a profile without a login,
  then Create login for it and confirm there is still one row for that person; change a Tester to SV and back (the person is signed out and in again with the new role); (3) Gantt -> Meeting View: enter today's
  plan, open the Evening view, enter tomorrow's plan; (4) as a Tester: no Meeting View, no Test Management, other people's emails are not in the Team Members data.

## Stage 8E rollout notes (notifications, logo, meeting history, retention)

* **No Cloudflare change** and **no Wrangler migration tag**; no registry schema change. Three additive record kinds (`notification`, `notificationAck`, `branding`) are opaque JSON in the existing record table. Deploy like any code release:
  `npm run build`, `cd worker && npm run validate`, then `npx wrangler deploy --env=""` (done by the operator, never by this repository's tooling).
* **No data migration.** Without definitions nothing is shown; without a logo the text mark is used; `planRetentionDays` defaults to 365, so after deployment the first housekeeping run removes plans and notes older than 365 days. If longer is needed, an SV should raise the setting to 730
  (and take a backup) before the first run, which happens when the daily alarm fires or an SV opens Meeting History.
* **Rollback.** The Stage 8D Worker does not know the three kinds: it would reject commits that contain them and ignore the new endpoints. Stored records stay. Roll forward rather than back once notifications exist.
  Pruned plans are not recoverable except from a backup.
* **Free plan.** No new request per page view; an acknowledgment is one small write per person per occurrence; housekeeping is at most one batch of deletes per workspace per day; the logo is at most 256 KiB once.
* After deploying check: (1) Settings -> Notifications: create a daily notification for everyone a couple of minutes ahead; as a Tester the banner appears and stays until Close, and is still closed after reload; (2) Settings -> Workspace logo: upload a PNG, check the shell and the Meeting header,
  confirm a Tester cannot change it; (3) Meeting View -> History: open yesterday; (4) Settings -> Shared History: filter by record type and person; (5) Data retention shows 365 days.
