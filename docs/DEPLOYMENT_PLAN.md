# GanttChart — deployment plan (Cloudflare Free, `workers.dev`)

Status: **PROPOSAL — nothing in this document has been executed.** No Cloudflare
login, resource, Zero Trust setting, DNS record or deployment has been created
by anyone. Each step in §4 is run only after the owner approves it.

## 1. Model

```
people (invited emails only)
   │  https://ganttchart.<your-subdomain>.workers.dev        ← the app URL (no custom domain)
   ▼
Cloudflare Access  (Zero Trust Free, hostname-based self-hosted application)
   │  login (one-time PIN to an approved email) → signed JWT
   │  anyone not on the list: login page / blocked — the Worker is never reached
   ▼
Worker "ganttchart"  (Workers Free)
   ├─ static SPA files (free, unlimited)              ← served after Access
   ├─ /api/*  and  /ws   → verify the Access JWT again (signature, issuer, audience,
   │                        expiry); fail closed if Access is not configured
   ▼
Durable Object "RegistryRoom" (one, SQLite)  ← who exists, which workspace, role, status (no QA data)
   ▼
Durable Object "WorkspaceRoom" (SQLite, one PER workspace)  ← that workspace only + live sync
```

* **No custom domain, no purchase, no DNS change.** The URL is
  `ganttchart.<subdomain>.workers.dev`; the exact hostname is only known when
  the account's `workers.dev` subdomain is read at deployment.
* **Access is hostname-based, not Worker-attached**, as requested. It protects
  HTTP and WebSocket upgrades on that exact hostname (the browser sends its
  Access cookie on the same-origin upgrade request).
* **Defence in depth:** even if Access were misconfigured, `/api/*` and `/ws`
  still require a valid Access JWT for *this* application's audience, and the
  Durable Object refuses unauthenticated connections.
* **Preview and version URLs are OFF** (`preview_urls: false`). Only the one
  production hostname exists, and it is the one Access protects.

## 2. Exact resources that would be created

| # | Resource | Created by | Plan / cost |
|---|---|---|---|
| 1 | Worker script `ganttchart` (with the SPA as static assets, ≈63 KiB) | `wrangler deploy` | Workers **Free** — $0 |
| 2 | Durable Object namespaces `WorkspaceRoom` (migration `v1`; one instance per workspace, named by its tenant id, created on first use) and `RegistryRoom` (migration `v2`; one instance `registry`), both SQLite | `wrangler deploy` (migrations) | Workers **Free** — $0 |
| 3 | `workers.dev` route for the Worker → `ganttchart.<subdomain>.workers.dev` | `wrangler deploy` (`workers_dev: true`) | $0 |
| 4 | **Only if the account has none:** a `workers.dev` account subdomain | `wrangler deploy` prompts / dashboard | $0 — *an account setting; see §5* |
| 5 | **Only if not yet set up:** the Zero Trust organization (team name → `https://<team>.cloudflareaccess.com`) on the **Free** plan | dashboard | $0 on Free — *verify, see §6* |
| 6 | Login method: **One-time PIN** identity provider (approved emails receive a code) | dashboard / API | $0 |
| 7 | Access **self-hosted application** "GanttChart", domain `ganttchart.<subdomain>.workers.dev`, session 24 h | dashboard / API | $0 |
| 8 | Access **policy** "Approved emails": *Allow → Include → Emails →* the explicit list you give me. No bypass, no "everyone", no email-domain rule | dashboard / API | $0 |
| 9 | Worker variables: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`; Worker variable **`SUPER_ADMIN_EMAILS`** (the platform operators; comma separated; empty = nobody can administer). `ADMIN_EMAILS` / `READ_ONLY_EMAILS` no longer exist: roles come from the registry | `wrangler deploy --var`, `wrangler secret put` | $0 |

**Not created / not used:** D1, KV, R2, Queues, Workflows, Hyperdrive, Workers
Paid, Logpush, Argo, Load Balancing, Cloudflare Tunnel, a custom domain or zone,
any DNS record, any WAF/rate-limit rule.

## 3. Wrangler configuration changes (already made in the repo, not deployed)

`worker/wrangler.jsonc`:

* `workers_dev: false → true` — the production `workers.dev` hostname is the
  app URL (your requirement). **Must be paired with Access on that hostname
  before the first deploy** (§4 step 3).
* `preview_urls: false` — unchanged; previews stay off so no second hostname
  exists.
* `HISTORY_RETENTION_DAYS: 90 → 30` — keeps history storage far below the 5 GB
  free cap.
* Everything else unchanged: assets binding with SPA fallback and
  `run_worker_first: ["/api/*","/ws"]`, Durable Object binding `WORKSPACE`,
  migration `v1` (`new_sqlite_classes`), `observability` on.
* Account IDs, team domain, audience tag and emails are **not** committed; they
  are supplied at deploy time (variables/secrets above).

## 4. Proposed deployment sequence (each step needs your approval)

0. **Local only, no account access:** `npm run build` (the SPA) and
   `npm run validate` in `worker/` (a dry-run deploy that uploads nothing).
1. **Read-only discovery** — you run (or I run with your login, read-only):
   `wrangler whoami`; check whether the account already has a `workers.dev`
   subdomain and a Zero Trust organization. *I will report what exists before
   changing anything.*
2. *(Only if missing)* register the `workers.dev` subdomain and create the Zero
   Trust org (Free). You choose the names. **I will not enter payment details.**
3. **Create the Access application and policy first** — for the hostname
   `ganttchart.<subdomain>.workers.dev` — **before** the Worker exists, so
   there is never a moment when the hostname serves the app unprotected. An
   application with no matching policy denies everyone, so the safe default
   even while the Worker does not exist.
   Exact request I would send (shown for review, not run):
   ```jsonc
   // POST /accounts/{account_id}/access/apps
   {
     "type": "self_hosted",
     "name": "GanttChart",
     "domain": "ganttchart.<subdomain>.workers.dev",
     "session_duration": "24h",
     "allowed_idps": ["<one-time-pin idp id>"],
     "auto_redirect_to_identity": true,
     "policies": [
       { "name": "Approved emails", "decision": "allow",
         "include": [ { "email": { "email": "person1@example.com" } },
                      { "email": { "email": "person2@example.com" } } ] }
     ]
   }
   ```
   Result I would record: the application's **AUD tag** and the **team domain**.
4. Set `SUPER_ADMIN_EMAILS` (a variable, or `wrangler secret put SUPER_ADMIN_EMAILS`; value from you). Every person who will ever sign in (Super Admin, each Admin, each User) must ALSO be in the Access policy of step 3; the registry does not change Access.
5. `wrangler deploy --var ACCESS_TEAM_DOMAIN:https://<team>.cloudflareaccess.com --var ACCESS_AUD:<aud>`
   (first deploy creates the Worker, the Durable Object namespace and the
   `workers.dev` route).
6. **Verification (no cookies, i.e. as an anonymous visitor):**
   * `GET /` → redirected to the Access login (never the app).
   * `GET /api/export`, `GET /api/whoami` → blocked by Access.
   * A WebSocket upgrade to `/ws` → refused.
   * A request with a *forged* `Cf-Access-Jwt-Assertion` header, if it ever
     reached the Worker → 403 (JWT signature/audience check).
   * Signed in as an approved email → app loads, live sync works between two
     browsers; a non-listed email cannot get in.
7. **Rollback** (all reversible, none touches your data): disable the route
   (`workers_dev: false` + deploy) or delete the Access application; deleting
   the Worker (`wrangler delete`) would also delete the shared workspace — that
   **is** destructive and would be shown to you first.

## 5. Cloudflare account settings that would change

* Possibly: a **`workers.dev` account subdomain** is registered (step 2) — a
  one-time, account-wide setting that appears in every Workers URL.
* Possibly: the **Zero Trust organization** is created (team name, Free plan).
* Adding an **identity provider** (one-time PIN) to Zero Trust.
* A new **Access application + policy** (§2 rows 7–8).

Nothing else: no DNS, no zone settings, no existing Worker/Access application
is modified, no plan is changed.

## 6. Can any step cost money?

* **Workers Free + Durable Objects Free:** operations beyond a free limit
  **fail with an error; they are not billed** (Cloudflare docs: "If you exceed
  any one of the free tier limits, further operations of that type will
  fail"). Nothing charges automatically. I will not upgrade to Workers Paid.
* **Zero Trust Free:** $0. *To verify at step 2 (the docs I checked did not
  state them):* the current free **user limit** and whether sign-up asks for a
  **payment method**. If a payment method is requested I stop and tell you; I
  will not enter card details.
* **Custom domain / Cloudflare-registered domain:** not purchased.
* **Workers Logs (observability):** included in the free allowance; I will
  not enable Logpush or paid retention.

## 7. Free-plan limits and the expected operating budget

Limits from the Cloudflare docs (Workers Free / Durable Objects Free):

| Limit (free) | Value | This app |
|---|---|---|
| Worker requests | 100,000 / day | only `/ws` upgrades and `/api/*` count; static assets are free |
| Durable Object requests | 100,000 / day | 1 per connect + **1 per 20 WebSocket messages** + RPC calls + the daily alarm |
| DO duration | 13,000 GB-s / day | hibernation: idle connected clients cost nothing; heartbeats are answered by the runtime without waking the object |
| SQLite rows read | 5,000,000 / day | a snapshot per (re)connect + ≈60 per commit |
| SQLite rows written | **100,000 / day** | **3 per single-record save** (records, history, revision) — measured by a test |
| SQLite stored data | 5 GB total | history limited to 30 days; size guard prunes to 7 days above 2 GB |
| CPU per request | 10 ms | commits are a few SQL statements |

**Multi-tenant note:** every API call and WebSocket upgrade adds one `RegistryRoom` request (1 DO request), and all workspaces share these account-wide limits, so the budget is divided between active workspaces. Roughly: with 5 active workspaces each can use about a fifth of 100,000 DO requests and 100,000 rows written per day. Moving a workspace to **local** storage removes it from the shared budget entirely.

Worked example (ONE workspace) — 10 people actively editing all day, one save every ~20 s each
(a pessimistic upper bound): 14,400 saves/day → **43,200 rows written (43%)**,
≈720 DO requests (<1%), ≈0.9 M rows read (17%), storage ≈ 14,400 × 4 KB × 30
days ≈ 1.7 GB worst case (34%). A realistic day is 10–50× smaller.

Ways this could exceed a free limit, and what I built to prevent it:

* **Save storms** (a bug re-saving continuously) → the client coalesces edits
  (≥1.5 s debounce, one commit in flight), the server drops no-op commits
  without writing, and reconnects use exponential backoff.
* **Unbounded history growth** → age-based retention (30 days), daily prune,
  and a 2 GB size guard.
* If a limit *is* hit, the app keeps working locally: edits stay in the
  browser and sync when the limit resets at 00:00 UTC. I'll surface a clear
  "shared sync paused" status rather than failing silently.

## 8. Decisions I need from you before step 1

1. Preferred Worker name (default `ganttchart`) — it becomes part of the URL.
2. The approved email addresses (and which of them are admins).
3. Session length (default 24 h; shorter is safer, longer is fewer logins).
4. Whether you already have a Zero Trust organization and a `workers.dev`
   subdomain on the account (otherwise I'll ask you to create them in step 2).
