# GanttChart — shared web deployment (Cloudflare)

Status: **design (Stages 1–2), revised for Workers Free + `workers.dev`**. Nothing here is deployed.
The concrete, reviewable deployment proposal is in [DEPLOYMENT_PLAN.md](DEPLOYMENT_PLAN.md). No Cloudflare
account state, DNS or production resource is created by the code in this
repository until the owner approves the exact commands listed in
[§10 Actions that need approval](#10-actions-that-need-approval).

## 1. Goal

Turn the single-browser, local-only app into a web app where invited users
see and edit the **same** data, with changes appearing for other connected
users within about a second. The UI, calculation engine and domain model stay
as they are.

Decisions already made by the owner: private GitHub repo; Cloudflare hosting
on the **Free plans only** ($0, no purchased/custom domain); the app lives at
the Cloudflare-provided `https://ganttchart.<subdomain>.workers.dev`;
**hostname-based** Cloudflare Access (invited emails only) protects that
hostname, so both HTTP and WebSocket upgrades are authenticated; Worker +
Durable Object (SQLite) for the shared workspace and WebSocket coordination;
near-real-time sync; the existing local storage kept only as an offline
cache/fallback; the existing revision history adapted to the shared backend.
Keep it simple — this is a small internal tool, not a SaaS product.

## 2. Audit of the current app (Stage 1)

### 2.1 Data model

| Piece | Size (real backup) | Notes |
|---|---|---|
| `ReportsState` | ~25 KB | projects, reports, attendance, topics, settings, plus collections (tester assignments, reviews, RCS members, identity audit log, external identities) |
| `AppState` | ~2 KB | the **editing surface of the active project** (`QaInputs`) + `language`, `dashboardView`, project names |
| Whole workspace | ~27 KB | tiny; will stay in the low MB even after years of use |

Every record type has a stable string `id` (`ProjectRecord`, `DailyReport`,
`AttendanceRecord`, `DailyTopic`, `TesterProjectAssignment`, `TesterReview`,
`RcsMember`, `IdentityAuditEntry`, `ExternalIdentity`). `ProjectRecord`
carries all per-project inputs (planning rows, daily executions, tickets,
tester performance, milestones…) and an `updatedAt`.

### 2.2 Persistence today

`useAppState` / `useReportsState` hold React state → a debounced effect in
`state-contexts.tsx` calls `persistWorkspaceAsync` → `persistenceBackend.ts`
diffs against a mirror (`planWorkspaceWrite`) and writes ONLY changed records
plus a manifest and a journal entry in one IndexedDB transaction. Startup is
`initPersistence()` (migration, recovery, fallback). ~4.9k lines in
`src/lib/storage`. Only ~8 files touch the persistence API, which makes a
second backend feasible without touching the UI broadly.

### 2.3 What breaks in a multi-user world

1. **Per-user data lives inside the shared state.** `AppState.language`,
   `AppState.dashboardView`, `ReportsState.activeProjectId` and
   `settings.autoBackup` (a per-device folder handle) must NOT be shared, or
   one user switching project/language would switch it for everyone.
2. **`AppState` is a copy of the active project.** `useProjectWriteBack`
   copies it into the project record; a remote change to the active project
   must flow back into `AppState` or the next local edit would overwrite it.
3. **`usePortfolioSeed`** seeds a first project when none exists. Every fresh
   client would seed its own — it must only seed on an empty *server* (and
   then once).
4. **Destructive actions become shared-destructive:** "Clear All Local Data",
   "Reset", workspace import/restore, point-in-time restore. They need to be
   either local-only (clear the cache, never the server) or explicit,
   confirmed and journaled.
5. **Auto daily backup** downloads a file / writes to a local folder. It stays
   per-device and is unchanged.
6. **Revision journal** stores a full workspace snapshot per revision
   (retention: last 100 revisions). At one revision per 400 ms of typing this
   covers only minutes of editing (audit finding #6).

## 3. Persistence choice: Durable Object SQLite vs D1

| Requirement | DO SQLite | D1 |
|---|---|---|
| Serialize writes + revision numbers + broadcast to sockets | One object does all three; storage is synchronous and local | DO would call D1 over the network for each commit; ordering across two systems must be reasoned about |
| Atomic "records + revision + history" commit | `transactionSync` in the same object | Possible (`batch`), but separate from the coordinator |
| Live sync (WebSockets, hibernation) | Native | Needs a DO anyway |
| Backup / recovery | Built-in point-in-time recovery (bookmarks, 30 days) + JSON export | Time Travel (30 days) + export |
| Cross-entity SQL / analytics | Single workspace only | Better (shared across many DOs) |
| Size / scale needed | 27 KB now; limit is GBs | Not a factor |
| Moving parts | 1 Worker + 1 DO class | Worker + DO + D1 binding |

**Decision: Durable Object SQLite.** The workload is one small shared
workspace whose hard problems (ordering, atomic commits, fan-out) are exactly
what a Durable Object solves, and putting storage next to the coordinator
removes a failure mode instead of adding a system. D1 would only win if we
needed SQL across many independent workspaces — not a requirement. If that
changes later, the DO can mirror to D1 without changing the protocol.

One workspace = one Durable Object, addressed `getByName("workspace")`. (A
future multi-team version would use one object per team name.)

## 4. Architecture

```
Browser (React SPA, unchanged UI)
  ├─ local IndexedDB  ── offline cache + unsent-edit safety net
  └─ SyncClient ──────── WebSocket  /ws   (JSON messages)
                         HTTPS      /api/* (export, health, whoami)
                              │
        Cloudflare Access (SSO, invited emails)  ← in front of everything
                              │  adds Cf-Access-Jwt-Assertion
                              ▼
        Worker  (static assets + routing)
          1. verify Access JWT (signature, iss, aud, exp)  — never trust headers alone
          2. check Origin on WebSocket upgrades
          3. forward to the DO with the verified identity
                              ▼
        WorkspaceRoom  (Durable Object, SQLite)
          records · record_history · meta  → serialized commits
          hibernatable WebSockets → broadcast of each committed change
```

One Worker deployment serves the SPA (Workers Static Assets with SPA
fallback), `/api/*` and `/ws`. The production `workers.dev` hostname **is** the
app URL and stays enabled; a hostname-based Access application protects it.
Preview and version URLs are disabled (`preview_urls: false`) so there is no
second, unprotected hostname. The Worker additionally verifies the Access JWT
itself, so a misconfigured Access policy alone cannot expose data.

## 5. Server data model

Everything is a **record** `(kind, id) → json`:

| kind | source | shared? |
|---|---|---|
| `project` | `ReportsState.projects[]` (inputs inline, snapshots included) | yes |
| `report` / `attendance` / `topic` | `ReportsState.*[]` | yes |
| `assignment` / `review` / `member` / `identityAudit` / `externalIdentity` | collections | yes |
| `settings` | `ReportSettings` **minus** `autoBackup` | yes |
| — | `AppState` prefs, `activeProjectId`, `autoBackup` | **no — per-user, stay in localStorage** |

Tables:

* `records(kind, id, json, rev, PRIMARY KEY(kind,id))` — current state; `rev`
  is the revision that last changed the record.
* `record_history(rev, kind, id, json NULL)` — append-only log of every
  change (`NULL` = deleted). State at revision N = latest row per key with
  `rev ≤ N`. No full snapshots, so storage grows with *changes*, and
  retention can be **time-based** (default 90 days; older rows are folded into
  a baseline) instead of "last 100 saves".
* `revisions(rev, committed_at, actor, reason, summary)` — one row per
  commit; powers the History screen.
* `meta(key, value)` — current revision, schema version, workspace id.

## 6. Sync protocol

JSON over one WebSocket (hibernatable). Defined once in `shared/protocol.ts`
and validated at runtime on the server.

Client → server

* `hello {clientId, lastRevision}` — on connect.
* `commit {id, baseRevision, puts[{kind,id,json}], deletes[{kind,id}], reason?}`
* `ping`

Server → client

* `snapshot {revision, records[]}` — first connect, or the client is too far
  behind.
* `changes {revision, actor, puts[], deletes[]}` — everything committed since
  `lastRevision` on reconnect, and a live broadcast for every commit.
* `ack {id, revision}` / `reject {id, reason, conflicts[]}`
* `error {code}`

Commit rule (**per-record optimistic concurrency**): a commit is accepted iff
none of the records it touches changed after `baseRevision`. Edits to
*different* records (two people on different projects, or one on a project
and one on a report) never conflict and merge automatically. Edits to the
same record are rejected with the current server version attached.

Conflict handling (client): apply the server's version of the conflicting
records, tell the user which of their changes were not applied, and keep a
local copy of the rejected data so nothing is silently lost. A future
refinement is a 3-way merge inside a project record (different top-level
input fields merge; same field conflicts).

Reconnect: exponential backoff with jitter; resend nothing blindly — send
`hello{lastRevision}`, receive missed `changes`, then re-diff local state
against the new server mirror and commit what is still different.

## 7. Authentication and authorization

* **Cloudflare Access** application covering the production hostname, policy
  = allow listed emails (or an email domain). Identity provider: one-time PIN
  (email) is enough; Google/Microsoft SSO is optional.
* The Worker **verifies** the `Cf-Access-Jwt-Assertion` JWT on every request
  and WebSocket upgrade: RS256 signature against the team's JWKS
  (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, cached), `iss`,
  `aud` (the Access application tag), `exp`/`nbf`. Reading the header without
  verifying would be bypassable if the Worker were reachable another way.
* The verified email becomes the **actor** recorded in the history.
* Authorization: every authenticated user can read and write by default.
  Optional `READ_ONLY_EMAILS` (config, not code) makes selected users
  viewers; the DO rejects their commits. Destructive shared actions
  (restore a revision, import a whole workspace) require `ADMIN_EMAILS`.
* WebSocket upgrades also require `Origin` to equal the app's own origin
  (cross-site WebSocket hijacking protection).
* **Session lifetime:** the Durable Object remembers when each connection's
  Access JWT expires and closes the socket (code 4401) on the next message or
  broadcast after that, so an expired or revoked session stops receiving data.
* Local development: `ENVIRONMENT=development` (a var set only by the dev
  config) enables a fixed dev identity. The production config never sets it
  and the Worker refuses to start the bypass unless the var is exactly
  `development`.

## 8. Backup, recovery and revision history

* Every commit appends to `revisions` + `record_history` in the same
  `transactionSync` as the record changes — history can never disagree with
  state.
* **History screen** keeps its semantics: list revisions, preview, restore as
  a *new* revision (append-only, admin only). Reconstruction replays
  `record_history`.
* **Retention** is by age (default **30 days**, because full-record history
  must stay far below the Workers Free 5 GB storage cap) with a baseline fold,
  run from a daily alarm; a size guard prunes to 7 days above 2 GB. This fixes
  audit finding #6.
* **Disaster recovery:** DO SQLite point-in-time recovery (30 days) via
  bookmarks — an admin-only, confirmed operation — plus a JSON **export**
  endpoint that produces the existing backup file format (so the current
  import/backup tooling works unchanged). Optional later: a daily alarm that
  writes the export to R2 for off-platform copies.
* The client keeps the existing automatic daily local backup unchanged.

## 9. Client changes

* New `ServerBackend` next to the IndexedDB one (`mode: 'server'`): boot from
  the server snapshot, diff local state against the server mirror (reusing the
  record-diff logic), send commits, apply incoming changes to the React state.
* Remote change to the *active* project is applied to `AppState` (guarded: if
  the user has an unsent edit on that same project, it goes through the
  conflict path instead of being overwritten).
* Per-user prefs and `activeProjectId` remain local.
* `usePortfolioSeed` only runs for an empty server workspace.
* "Clear All Local Data" clears only the cache in server mode; "Import /
  Restore workspace" becomes an admin, confirmed, journaled action.
* Connection indicator (Connected / Reconnecting / Offline) next to the
  existing save status; editing stays possible offline and re-syncs.
* **First run:** if the server workspace is empty and the browser has local
  data, the user is offered "Upload this browser's data to the shared
  workspace" — explicit, non-destructive (local data is kept). If both have
  data, nothing is merged automatically: the user downloads a backup and
  chooses.

## 10. Actions that need approval

None of these are run by the code or by me without the exact command being
shown to the owner first:

0. Registering a `workers.dev` account subdomain or creating the Zero Trust
   organization, if the account has neither.
1. `wrangler login` / creating anything in the Cloudflare account.
2. `wrangler deploy` (first creation of the Worker and the DO migration
   `v1 → new_sqlite_classes: ["WorkspaceRoom"]`).
3. Creating the Cloudflare Access application + policy (dashboard or API) and
   copying its `aud` tag / team domain into Worker vars.
4. Attaching the custom domain / route (DNS change). Until then the app is
   only available via `wrangler dev` locally.
5. Setting secrets/vars (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ADMIN_EMAILS`,
   `READ_ONLY_EMAILS`).
6. Importing existing local data into the shared workspace (user-initiated in
   the UI, shown with counts before it runs).
7. Any DO migration that deletes or renames a class, and any point-in-time
   restore.

## 11. Implementation stages

1. Audit — this document.
2. Design — this document.
3. `worker/` package: protocol, Access JWT verification, `WorkspaceRoom`
   (SQLite schema, commit/conflict logic, history), routing, config, tests.
4. Client server-backend + state integration + first-run upload.
5. WebSocket live sync, reconnect, status UI.
6. Access integration docs and deployment config.
7. Shared revision history UI + retention alarm + export.
8. Failure / reconnect / conflict tests, offline behavior.
9. Security and deployment-readiness audit.

## 12. Free-plan write budget (design constraint)

Workers Free allows 100,000 SQLite rows written per day and every index entry
counts. The store therefore writes exactly **3 rows per single-record save**
(`records`, `record_history`, `revisions`): the first two are `WITHOUT ROWID`
tables keyed directly, `revisions.rev` is the rowid, and the revision counter
is derived with `MAX(rev)` instead of being stored. This is pinned by tests
(`worker/test/store.test.ts`, "write budget"). See DEPLOYMENT_PLAN.md §7 for
the full operating budget.
