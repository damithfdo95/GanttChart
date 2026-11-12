# GanttChart — production operations plan (Cloudflare Free, `workers.dev`)

Status: **Stage 5 is deployed.** This document describes the **Stage 6 target state**
(public sign-in page, protected application routes, safer configuration) and the
manual steps to reach it. **Nothing in this document has been executed by the
development tooling:** no deployment, no secret, no Access change, no DNS change.
Every step marked *you run* is performed manually by the owner.

> **Sign-in is dual: Cloudflare Access SSO *or* the Worker's own password sign-in — either is enough.**
> The Worker proves **who** a person is (a verified Access JWT or a verified session). GanttChart's own
> registry decides **whether** that person may use the application, as which role,
> in which workspace. An authenticated `@rakuten.com` employee who has no GanttChart
> account is shown "no account" and is never added automatically.

## 1. Model

```
anyone ──► https://ganttchart.damithfdo.workers.dev/        PUBLIC  (static sign-in page, no data)
                │  "Sign in with SSO"                        "Sign in with a password"
                ▼                                            ▼
           /login  (Access in front)                   /signin  (the SPA's password form)
                │ Access JWT on every request                  │
                │                                              └─► POST /api/auth/login ──► session cookie ──► "/"
                ▼ the app calls (same origin, with the Access JWT or the session cookie)
           /api/*        ── Worker: authenticate (Access JWT OR session) → registry lookup → role/tenant/status → permission
           /ws           ── Worker: same pipeline, then the tenant's own Durable Object
```

| Path | Who may reach it | What it serves |
|---|---|---|
| `/`, `/assets/*` and every other path not listed below (single-page-app fallback) | **Anyone** (public) | The built SPA: code and static text. **No data, ever.** |
| `/login` | Passes through **Access**; the Worker also verifies the token | A redirect to `/` for a verified token, otherwise the sign-in shell |
| `/signin` | **Anyone** (the Worker's own password form) | The SPA shell; `POST /api/auth/login` sets the session cookie |
| `/api/*` | **Access JWT or session** + Worker check + registry + permission | Every API |
| `/ws` | **Access JWT or session** + Worker check + registry + permission | Live sync WebSocket |

The list `/api/*`, `/ws`, `/login`, `/signin` is the single source of truth in `shared/routes.ts`.
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

### Who may sign in

The registry decides who may **use** the app: only a person with an account (created by the
Super Admin or an SV) can sign in, by **either** of the two doors — a Cloudflare Access
SSO sign-in (the `/login` path, verified by the Access JWT) or the Worker's own password
sign-in (the `/signin` path):

| Who | How they get a password |
|---|---|
| Super Admin | A stored hash in the `SUPER_ADMIN_PASSWORD` secret, set once at setup |
| Admin / User | The SV who creates the account sets an initial password; the person must choose their own at first sign-in (forced change) |

### Signing out

Every signed-in person (Super Admin, Admin, User) has a **Logout** control (Platform Administration header; the
application header for Admin and User, including an Admin in local mode). It signs out **this browser only**.

* **Endpoint:** `POST /api/auth/logout` — a Worker route. It revokes the session **server-side** (the registry deletes
  the session row, so the cookie becomes worthless at once) and clears the session cookie. It takes no user id or
  email: the session cookie names the person, and it signs out only the browser that clicked.
* **What the page does first:** warns if edits are still unsent (Cancel keeps everything running), stops live sync
  (closes the WebSocket, cancels reconnect/heartbeat timers), saves the device's own copy, then calls the endpoint.
  The device's own data is kept (see below).
* **Kept on the device (never deleted by logout):** the local database and backups, the device's copy of a shared workspace
  and its link (reused only for the same person in the same workspace; anyone else is treated as foreign), language and
  other per-device preferences. "Clear this device" in Settings is a different, deliberate action.

## 3. Configuration (where each setting lives)

| Setting | Kind | Where | Why |
|---|---|---|---|
| `MANAGED_USER_EMAIL_DOMAINS` = `rakuten.com` | non-secret | `wrangler.jsonc` → `vars` | Same reasoning. |
| `HISTORY_RETENTION_DAYS` = `30` | non-secret | `wrangler.jsonc` → `vars` | |
| `SESSION_SECRET` | **Worker secret** | `wrangler secret put` | The HMAC key that signs session tokens. Must be at least 32 characters of random data (`openssl rand -base64 32`). If it is lost or rotated, every session ends (everyone signs in again); it cannot decrypt anything else. |
| `SUPER_ADMIN_EMAILS` | **Worker secret** | `wrangler secret put` | Names the platform administrator(s): personal data, and a high-value setting. |

Why secrets rather than `--var`: **deploying never deletes a Worker secret**, whereas a plain
deploy replaces every `vars` value with what the file says. `wrangler.jsonc` also declares

```jsonc
"secrets": { "required": ["SESSION_SECRET", "SUPER_ADMIN_EMAILS"] }
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

## 5. Sign-in configuration (*you run*)

Sign-in is dual. The Worker's own password sign-in needs three secrets, and the Cloudflare
Access SSO path needs the two (optional) `vars` in `wrangler.jsonc` — `ACCESS_TEAM_DOMAIN`
and `ACCESS_AUD` — which must be set **as a pair** (both or neither; the guard refuses
half-configured Access because it fails closed at runtime):

```bash
cd worker
npx wrangler secret put SESSION_SECRET        # paste at least 32 random characters (e.g. `openssl rand -base64 32`)
npx wrangler secret put SUPER_ADMIN_EMAILS    # paste e.g. admin@example.com  (several: a@x.com,b@y.com)
npx wrangler secret put SUPER_ADMIN_PASSWORD  # paste a `hashPassword` output (see below)
npx wrangler secret list                      # read-only: names only
```

`ACCESS_TEAM_DOMAIN` is the Zero Trust team domain (`https://<team>.cloudflareaccess.com`)
and `ACCESS_AUD` the Access application's AUD tag (comma-separated for several). When both
are absent the deployment is password-only (`/login` then behaves like any other public
path); when both are set, a valid Access JWT on any Worker route is accepted as-is.

`SUPER_ADMIN_PASSWORD` is the **hash** of the Super Admin's password, not the password itself.
Generate it once and paste the whole line:

```bash
cd worker
npx tsx -e "import { hashPassword } from './src/passwords'; hashPassword('YOUR-PASSWORD').then(h => console.log(h));"
```

## 6. Safe rollout sequence

**Principle:** the Worker protects `/api/*`, `/ws` and `/login` by itself, so there is no step at which
tenant data is public.

| Order | Result |
|---|---|
| **A. secrets first, then code** (chosen) | The secrets exist before the new Worker runs; nobody is locked out by a missing `SESSION_SECRET`. |
| B. code first | Every request fails closed (HTTP 500) until the secrets exist; no data is exposed, but sign-in is broken meanwhile. |
| C. deploy without the secrets | Not possible: the config requires them (`secrets.required`). |

**0. Local (no account access)** — from the repository root:

```bash
npm run build
cd worker
npm run validate        # runs the safety guard, then a dry-run deploy that uploads nothing
```

**1. Set the three secrets (*you run*)** as in §5.

**2. Deploy the new code (*you run*)**:

```bash
cd worker
npx wrangler deploy --env=""
```

The guard runs automatically before the upload (it is wired as the config's `build` command) and
aborts the deploy if anything in §8 fails. **Do not** pass `--var SESSION_SECRET…` or
`--var SUPER_ADMIN_EMAILS…`: those names are secrets now.

**3. Verify the deployment.** Sign in as the Super Admin (email + password); the app, live sync and
Platform Administration work. Set each tenant user's initial password (the SV flow), sign in as one,
and confirm the forced password change appears.

**4. Keep the Cloudflare Access application (*you run*)** in Zero Trust → Access → Applications →
GanttChart, protecting `/login` (and `/api`, `/ws` if desired — the Worker verifies the token
itself either way). It is the SSO door of the dual sign-in; deleting it would remove SSO and
leave only the password door (`/signin`).

**5. Anonymous checks** (no cookies; any machine):

```bash
BASE=https://ganttchart.damithfdo.workers.dev
curl -s -o /dev/null -w "root:   %{http_code} %{content_type}\n" $BASE/                    # 200 text/html (the public page)
curl -s -o /dev/null -w "whoami: %{http_code}\n" $BASE/api/whoami                          # 401. NEVER 200
curl -s -o /dev/null -w "export: %{http_code}\n" $BASE/api/export                          # 401
curl -s -o /dev/null -w "super:  %{http_code}\n" $BASE/api/super/tenants                   # 401
curl -s -o /dev/null -w "login:  %{http_code} %{redirect_url}\n" $BASE/login               # 302 to /login (the sign-in page)
curl -s -o /dev/null -w "ws:     %{http_code}\n" -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Origin: $BASE" $BASE/ws                                                              # 401. NEVER 101
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

1. **Code:** `npx wrangler rollback` (restores the previous Worker version; Durable Object data is not
   versioned and is untouched). The secrets of step 1 also work with the previous code (it reads the same
   names).
2. **Secrets:** `npx wrangler secret delete` is **not** part of any rollback and would take the app offline (fails
   closed).
3. Never `wrangler delete` the Worker: that would delete the Durable Objects and all workspaces.

## 8. Pre-deployment guard

`worker/scripts/check-production.mjs` runs before **every** `wrangler deploy` of `wrangler.jsonc` (and before
`wrangler types`/dry-runs), through the config's `build.command`. It deploys nothing and contacts no account.
It refuses the deployment when:

* `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are not set **as a pair** (both or neither: Access sign-in is optional, but half-configured Access fails closed);
* `MANAGED_USER_EMAIL_DOMAINS` is empty or contains entries that are not plain domains;
* `SESSION_SECRET` or `SUPER_ADMIN_EMAILS` appears under `vars`, or is missing from `secrets.required`;
* any development variable (`ENVIRONMENT`, `DEV_EMAIL`, `ALLOWED_ORIGINS`) is in the production config;
* the `WORKSPACE`/`REGISTRY` bindings or `ASSETS` are missing;
* the Durable Object migrations `v1` (`WorkspaceRoom`) and `v2` (`RegistryRoom`) are not intact, or a migration
  deletes/renames/transfers a class;
* `assets.run_worker_first` differs from `["/api/*", "/ws", "/login", "/signin"]`, or the SPA fallback is off;
* `preview_urls` is not `false`, or `account_id`/routes are committed;
* `../dist/index.html` (the production SPA) does not exist;
* observability is off or the sampling rate is invalid;
* this document no longer mentions the settings above.

It **cannot** see the account, so it reminds you that the two secrets are manual
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
