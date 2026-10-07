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
Cloudflare Access (the sign-in step) protects the application's data routes
(`/login`, `/api/*`, `/ws`; see section 14), so both HTTP and WebSocket upgrades are
authenticated; the public page at `/` is static and holds no data; Worker +
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
app URL and stays enabled; Access protects its data routes (section 14).
Preview and version URLs are disabled (`preview_urls: false`) so there is no
second hostname Access does not know. The Worker additionally verifies the Access JWT
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

> **Superseded by section 13 (Stage 5):** roles now come from the registry, and `ADMIN_EMAILS` / `READ_ONLY_EMAILS` no longer exist (see 13.2). The text below describes Stage 3/4.

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

---

# 13. Multi-tenant model (Stage 5)

Status: **implemented and tested locally (Stage 5); nothing is deployed.** Sections 13.1-13.10 are the
design; 13.11-13.14 record what was actually built and where it differs.

## 13.1 Audit of Stage 4 against the new requirements

| Finding in Stage 4 | Why it is not enough |
|---|---|
| Every request is routed to one Durable Object, `getByName('workspace')` | There is exactly one workspace; no tenant exists |
| Roles come from global env lists (`ADMIN_EMAILS`, `READ_ONLY_EMAILS`) | Not per-tenant; any authenticated email that is on no list is silently an **editor**: authentication was treated as authorization |
| `/api/export`, `/api/revisions*`, `/ws` take no tenant | Nothing to isolate; a second tenant would share them |
| The workspace DO trusts the identity headers from the Worker and has no notion of which tenant it serves | A routing bug could serve the wrong tenant's data with no second line of defence |
| No way to remove access at runtime | Disabling a user would not close their open WebSocket |
| Client treats "role" as one flat value | Needs super-admin / admin / user and a storage mode |

What is already right and is kept: Access JWT verification, per-record optimistic concurrency, the
sync protocol, the Durable Object storage schema (3 rows per save), conflict handling, hibernation,
history, the link/first-run protections, local mode, EN/JA.

## 13.2 Principles

1. **Authentication is not authorization.** Access proves *who*; the application's own registry decides
   *what they may do*. An authenticated email that is not in the registry is refused (fail closed).
2. **The server derives the tenant.** `verified email → registry user → tenant`. A tenant id sent by
   the browser (path, query, body, header) is never used; if one is present and disagrees, the request
   is rejected.
3. **Isolation by construction.** Each tenant's data lives in its **own Durable Object instance**,
   addressed by a stable random tenant id. State, history, sockets and broadcasts cannot be shared
   between instances. The instance also records which tenant it belongs to and refuses a mismatch
   (defence in depth against a routing bug).
4. **Stable ids, never labels.** Tenants `ten_<uuid>`, users `usr_<uuid>`. Emails are normalised
   (trim + lowercase) and unique. Names are display text only and never a boundary.
5. **One authorization system.** The old "read-only / editor / admin" workspace roles are *derived*
   from the registry (admin gives `admin`; user with access `editor` gives `editor`; user with access
   `viewer` gives `viewer`) and passed to the workspace only as a computed fact. `ADMIN_EMAILS` and
   `READ_ONLY_EMAILS` are removed.

## 13.3 Components

```
Browser --> Worker --> Access JWT verify (email only)
                |
                +--> RegistryRoom  (one Durable Object, SQLite)              control plane
                |       tenants, users, deletion_audit
                |       email -> user -> tenant -> status/mode  =>  Principal | deny(reason)
                |
                +--> WorkspaceRoom (one Durable Object PER TENANT, id = tenant id)   data plane
                        records, history, revisions, sockets
```

* **RegistryRoom** holds only metadata (who exists, which tenant, role, status, storage mode, deletion
  requests, a minimal deletion audit). It never holds QA content.
* **WorkspaceRoom** (unchanged storage schema) gets a tenant binding and new operations: atomic
  import, verification by content hash, kick a user, close all connections, destroy.
* **Super Admin** is the set of emails in `SUPER_ADMIN_EMAILS` (config, not data), so the platform can
  never lock itself out and cannot be created by a tenant admin. A super admin has **no tenant**, so
  every tenant-data route (`/ws`, export, revisions, restore, users, migration) refuses them. They see
  only registry metadata and perform explicit privileged actions.

## 13.4 Roles and permissions

| Action | Super Admin | Admin (own tenant) | User (own tenant) |
|---|:-:|:-:|:-:|
| View tenant registry (metadata only) | yes | no | no |
| Create Admin + tenant, (de)activate a tenant | yes | no | no |
| Approve permanent deletion | yes (never the requester) | no | no |
| Read / write QA data, live sync | no | yes (web mode) | yes (web mode; write only if access = editor) |
| Restore history, replace workspace, reset/delete project for everyone | no | yes | no |
| Create / disable users, change a user's access level | no | yes (web mode) | no |
| Switch storage mode, migrate | no | yes | no |
| Request / cancel deletion of own tenant | no | yes | no |

Implemented as a table-driven `can(principal, action)` with default **deny**, unit-tested for every
role and action.

## 13.5 Registry data model (stable ids, constraints)

```
tenants(id PK 'ten_...', name, storage_mode 'local'|'web',
        status 'active'|'deactivated'|'deletion_requested'|'deleting',
        created_at, updated_at, deletion_requested_at, deletion_requested_by,
        owner_user_id  -- Stage 8B: the Owner SV (nullable only for a legacy tenant without any admin))
users  (id PK 'usr_...', email UNIQUE (normalised), tenant_id -> tenants, role 'admin'|'user',
        access 'editor'|'viewer', status 'invited'|'active'|'disabled',
        created_at, updated_at, created_by, last_login_at)
        (Stage 8B: the unique index 'one admin per tenant' was dropped; a tenant has several SVs and exactly one OWNER,
         enforced by tenants.owner_user_id and the triggers described in section 17)
deletion_audit(id, tenant_id, requested_by_email, requested_at, approved_by_email,
               approved_at, deleted_at, users_deleted)
        identities and timestamps only; never workspace content
```

Authorization chain (every request): `Access email -> users row -> tenants row -> checks`.
Unregistered: deny. `disabled`: deny. Tenant `deactivated` or `deleting`: deny. A **user** (not the
admin) of a tenant in `local` storage mode: deny (collaboration is not active). `invited` becomes
`active` on first successful sign-in. `deletion_requested` keeps working (the admin must be able to
export) and is shown as a warning.

## 13.6 Storage modes and migration

The mode belongs to the **tenant** (set by its Admin), not to individual users.

* **Local**: data stays in the Admin's browser; the Worker serves only the identity/registry; no shared
  workspace; users cannot be created and existing users are refused.
* **Web**: data in the tenant's Durable Object; users can be created; live sync and shared history.

**Local to Web** (retry-safe, never silently overwrites): inspect local and server, write a local
backup file, upload atomically as ONE revision (`importWorkspace`; the expected revision must match,
otherwise 409), the server returns a SHA-256 of the canonical record set, the client recomputes it and
re-reads the server copy, and only then `activate-web` flips the tenant mode (the server re-verifies
the hash itself). Repeating the same upload (same migration id / same content) is a no-op. A non-empty
server workspace is never replaced without an explicit, typed confirmation; the previous state stays in
history.

**Web to Local**: download the full snapshot, validate it, save it locally and read it back, warn that
users lose access, require a typed confirmation, then `deactivate-web` (the server re-verifies that
nothing changed since the downloaded revision and closes all sockets) and the mode becomes `local`.
**The cloud copy is kept** (archived, not deleted). If anything fails before the final step the mode
is unchanged.

## 13.7 Deletion workflow

`Admin requests deletion` -> tenant `deletion_requested` (cancellable) -> Super Admin reviews ->
explicit confirmation (type the tenant id and the admin's email) -> tenant `deleting` (all access
refused) -> workspace DO closes sockets and `deleteAll()` -> registry transaction removes users and
tenant and writes the minimal audit row. Re-approving a half-finished deletion completes it
(idempotent). The requester can never approve (a different principal by construction, and checked
explicitly).

## 13.8 WebSocket isolation

The Worker derives the tenant from the registry, then routes the upgrade to that tenant's own Durable
Object; the socket attachment records tenant id and user id. A broadcast only iterates that object's own
sockets. Disabling a user, deactivating a tenant, switching to local mode or deleting a tenant calls the
workspace DO to close the affected sockets (codes 4403 / 4410) immediately; the existing session-expiry
check bounds anything that slips through.

## 13.9 Free-plan impact

* Every API call and WebSocket upgrade adds **one RegistryRoom RPC** (1 Durable Object request). Commits
  and broadcasts do not touch the registry. Expected extra load is small (sessions and admin actions,
  not edits).
* Per-tenant Durable Objects share the account-wide free limits (100,000 DO requests per day, 100,000
  rows written per day, 5 GB stored): the budget is divided among active tenants. With about 5 active
  tenants each has roughly 20%; documented in DEPLOYMENT_PLAN.md.
* No new paid product: the registry is a second SQLite-backed Durable Object class (migration `v2`).

## 13.10 Backward compatibility

The WorkspaceRoom storage schema is unchanged, so Stage 4 data is preserved. The old single instance
(`workspace`) is simply no longer routed. A Super Admin-only, audited, tested **adopt-legacy** action
copies it into a tenant whose workspace is empty. Local-only data is unaffected.

## 13.11 What was built

| Layer | Where |
|---|---|
| Shared vocabulary, normalisation, content hash, import validation | `shared/tenancy.ts` |
| Registry (tenants, users, deletion audit; pure SQL, unit-tested with sql.js) | `worker/src/registry.ts`, DO shell `registryRoom.ts` |
| Default-deny permission table | `worker/src/permissions.ts` |
| Principal derivation (`Access email -> user -> tenant -> checks`) | `worker/src/principal.ts`, `auth.ts` (identity only) |
| Tenant data plane (one DO per tenant, self-verifies its tenant, import / verify / freeze / thaw / disconnect / destroy) | `worker/src/workspaceRoom.ts` |
| Routes | `worker/src/index.ts` |
| Browser: principal detection, startup routing | `src/lib/sync/serverMode.ts`, `src/app/startupDecision.ts`, `src/app/Startup.tsx` |
| Browser: migration logic (pure, dependency-injected) | `src/lib/tenancy/migration.ts`, `api.ts` |
| Browser: UI | `src/features/tenancy/*` (`AccessDenied`, `SuperAdminConsole`, `WorkspacePanel`, `MigrateToWeb`, `MigrateToLocal`, `UsersManager`), `WorkspaceBadge` in `App.tsx`, panel mounted in Settings |

Routes (all require a verified Access identity, then a registered principal):
`/ws`, `/api/whoami`, `/api/tenant`, `/api/export`, `/api/stats`, `/api/revisions[/:n[/restore]]`,
`/api/tenant/users[/:id]`, `/api/tenant/deletion-request[/cancel]`,
`/api/tenant/storage/{inspect,upload,activate-web,deactivate-web}`,
`/api/super/{tenants,tenants/:id,tenants/:id/delete,audit,legacy/adopt}`, and `/api/dev/as` (development
only, loopback only). State-changing calls need the `X-GC-Intent` header.

### Deviations from the design

* **Close codes**: 4401 session expired, 4403 access revoked, 4410 storage moved, 4411 workspace deleted
  (the client treats all four as final: no reconnect, no further sends).
* **Typed confirmations**: `REPLACE` to replace existing cloud data, `LOCAL` to leave the cloud. Both are
  re-checked **on the server**, not only in the UI.
* **Disabling a user closes their sockets through an RPC to the tenant DO.** If that RPC fails the API
  answers `disconnected: false` (the UI says so) and the socket ends at session expiry at the latest.
* **A device copy only counts for the same person in the same workspace.** The device link now records
  the tenant id. A copy that belongs to someone else, to another workspace, or to an old link without a
  tenant id is *foreign*: it is forgotten and never offered for merging, so one workspace's data cannot
  be carried into another through a shared browser. A backup file is still written first.
* **Legacy adopt** (Super Admin, audited via `console.warn` only) reads the old single workspace and
  copies it into a tenant whose workspace is empty. It is the one place a Super Admin handles tenant data
  and is deliberately explicit.

## 13.12 Bootstrap and operations

* The first Super Admin is set by the `SUPER_ADMIN_EMAILS` worker variable (comma separated). There is no
  way to create one from the application.
* A Super Admin signs in, opens the platform console, and creates an Admin workspace (name + admin
  email). The Admin signs in with that email and chooses local or web storage.
* **Access policy and the registry are two separate gates** (updated in Stage 6, section 14): Access decides who can
  *authenticate* (an organization-wide rule such as "emails ending in @rakuten.com"); the registry decides who may
  *use* the application. Users are therefore **not** added to Access one by one. Nothing in the registry changes the
  Access policy.
* No email is sent anywhere. "Invited" only means "registered, has not signed in yet".

## 13.13 Test coverage added

Worker unit tests: registry, permissions, auth, shared tenancy helpers. Worker runtime tests (real
`workerd` and Durable Objects): isolation (Admin A -> B, User A -> B, forged tenant id in path / query /
body / header, WebSocket cross-tenant, conflict / revision / restore APIs, Admin -> Super actions,
User -> Admin actions, disabled users, unknown emails), lifecycle (storage modes, local-mode user
creation refused), migration (cannot silently overwrite, retry-safe, wrong hash refused, workspace
changed), deletion (requester cannot approve, idempotent, all data gone, only the audit remains).
Browser tests: migration state machine (25), startup decision (device ownership, denied, super admin),
`/api/whoami` detection (principal shape, denied vs sign-in), terminal close codes, panel capabilities,
deletion confirmation, error mapping, EN/JA key parity. Every security suite was mutation-checked
(guard removed, tests had to fail, guard restored).

## 13.14 Known limits

* The registry Durable Object is on the path of every API call and upgrade (1 DO request each); all
  tenants share the account-wide free limits (see DEPLOYMENT_PLAN.md section 7).
* `loadLocal` read-back during Web -> Local needs IndexedDB persistence; in the localStorage fallback the
  migration aborts safely instead of switching.
* Workers + Access on `workers.dev` has not been exercised against real Cloudflare.

## 14. Stage 6: public sign-in page, protected routes, provisioning rules

Status: implemented and tested locally; **not deployed**. The deployment steps are in
[DEPLOYMENT_PLAN.md](DEPLOYMENT_PLAN.md).

### 14.1 Audit of Stage 5 against the new requirement

| Finding | Consequence |
|---|---|
| Access protected the **whole hostname**, so even the page that asks someone to sign in required a sign-in | The public landing page was impossible |
| The Worker already verifies the Access JWT on `/api/*` and `/ws` and fails closed; unauthenticated calls return `401` before any routing | Opening `/` publicly does not weaken data protection |
| `run_worker_first` sent only `/api/*` and `/ws` to the Worker; any other path is the SPA | A sign-in URL for Access to protect needed a Worker route |
| An authenticated, unregistered email was refused `403 unregistered` and nothing is created | The "no account" behaviour already existed; the text and the log needed work |
| Admin/User creation checked only that the email was well formed | Any address (e.g. Gmail) could be provisioned |
| `ACCESS_AUD` / `SUPER_ADMIN_EMAILS` were supplied with `--var` at each deploy | A plain deploy would overwrite them with empty values and take the app offline |
| `startupDecision`: with no session and a linked device the app opened the device copy | With a public page this would show saved data to a signed-out visitor |

### 14.2 Route model (chosen)

* **Public:** `/`, `/assets/*` and every path that is not one of the three below (the SPA fallback). The page shows only
  static text, EN/JA, one **Sign in** link and no registration of any kind. A signed-out visitor is detected by the app's
  first call, `/api/whoami`, being refused (Access redirect or `401`).
* **Protected:** `/login`, `/api/*`, `/ws`. Access challenges them; the Worker verifies the token itself, resolves the
  registry principal and checks the permission. `/login` verifies the token and answers `302 /` (fixed target, no redirect
  parameter, so no open redirect); without a valid token it answers `302 /?signin=unavailable`.
* `shared/routes.ts` is the single source of truth, tied to `wrangler.jsonc` and the documented Access destinations by a
  unit test and by the deployment guard.

Considered and rejected: a separate `/app` page (second HTML entry, routing changes and an Access redirect back for no
security gain, since data is behind `/api` and `/ws`, not behind a page URL); keeping Access on the whole hostname (conflicts
with the public page).

### 14.3 Why this is safe with Access and WebSockets

1. The Worker authenticates `/api/*`, `/ws` and `/login` itself. The `prod-sim` suite runs the Worker configured like
   production with **no Access in front** and checks that every API, state-changing call and WebSocket upgrade without a valid
   token is refused with no information, and that forged identity headers/cookies, wrong key, audience, issuer, expiry,
   `alg: none`, HS256 and RS384 tokens are all refused.
2. Browsers send the same-origin Access cookie on the WebSocket upgrade exactly as before. Where this is not so, the result is
   fail-closed (the sign-in page), never open. The rollout verifies it explicitly.
3. There is no intermediate deployment state in which data is public: code first (Access still on the whole hostname), then
   Access narrowed to the three paths; or the reverse, or only half applied: the Worker's own checks hold in all of them.

### 14.4 Authentication versus authorization

Authentication (Cloudflare Access, the Worker's JWT verification) yields an email. Authorization is the registry:
`email -> user -> tenant -> status -> role -> permission`. An authenticated person with no account is refused
(`403`, reason `unregistered`) and **nothing is created**: tested, including repeated attempts and every create route.

### 14.5 Provisioning rules

* Only the configured Super Admin creates Admins; only a tenant's Admin creates its Users; the tenant comes from the verified
  principal, never from the request.
* `MANAGED_USER_EMAIL_DOMAINS` (exact domain match, comma separated, fail closed) is enforced inside the registry store, the
  single choke point for both creations, and the domain list is read inside the registry Durable Object so no caller can skip
  or alter it. Admin creation stays atomic: a rejected address creates no tenant.
* Older accounts outside the managed domains stay as they are. The Super Admin list marks them
  (`adminOutsideManagedDomains`); deletion remains the explicit request/approval workflow.

### 14.6 Production configuration and the guard

Non-secret settings live in `wrangler.jsonc`; `ACCESS_AUD` and `SUPER_ADMIN_EMAILS` are Worker secrets (never deleted by a
deploy) declared in `secrets.required`. `worker/scripts/check-production.mjs` runs before every deploy of that config and
refuses incomplete or drifting production settings (list in DEPLOYMENT_PLAN.md section 8). It deploys nothing.

### 14.7 Compatibility

No Durable Object migration and no schema change. `TenantSummaryDto` gains one computed field. Existing registry data,
workspaces and the existing Gmail test workspace are untouched. Device links are unchanged.

### 14.8 Stage 6.1: self-service sign-out

* One component (`LogoutButton`) and one pure flow (`src/lib/auth/logout.ts`) serve every role. The Super Admin console and
  the Admin/User shell mount the same control; an anonymous visitor never sees it.
* Flow: unsent shared edits (`sync.pending > 0`) -> a warning that offers Cancel and "Sign out anyway"; otherwise (or after
  confirming) `stopSync` (client `stop()`: socket closed with 1000, reconnect/heartbeat/flush timers cleared, listeners and the
  diagnostic trail dropped), save the device copy, replace the app with a neutral signed-out screen **synchronously**, then
  `navigate('/cdn-cgi/access/logout')`.
* It uses Cloudflare's own endpoint on the application's origin, with no parameters; it has no server side of its own and
  never changes a server record, account, tenant or storage mode. Force-signing-out other people is intentionally not offered.
* Session ends are unified in `src/app/sessionEnd.ts`: choosing to sign out, or an API call refused because the sign-in is gone
  (`401`, an Access redirect, or an invalid/missing token), both stop the app showing authenticated data at once; the second shows
  the public page with a notice. WebSocket close codes (4401 expiry, 4403 revoked, 4410 moved, 4411 deleted) keep their own
  banners because the person may still need to download or keep their unsent changes.
* Device ownership is unchanged: a different identity never inherits another's device-linked copy (see `startupDecision.ts`).

## 15. Stage 7: account lifecycle, administration, audit trail

Status: implemented and tested locally; **not deployed**. Operator-facing description: [ADMINISTRATION.md](ADMINISTRATION.md).

### 15.1 Audit of Stage 6 against the new requirements

| Finding | Consequence |
|---|---|
| Workspace status values (`active`, `deactivated`, `deletion_requested`, `deleting`) were checked by scattered comparisons | One transition table, `shared/lifecycle.ts`; the registry asks it for every change |
| `users.status = 'invited'` had no behaviour of its own (nothing is invited by email); it only flipped to `active` on first sign-in | Presented as `active`; new accounts are created `active`; stored legacy rows keep working and are never migrated |
| Only the requesting Admin could end a deletion request | Added the Super Admin's **reject** (`POST /api/super/tenants/:id/reject-deletion`) |
| Requesting deletion needed a click in the browser only | The server now requires the typed word `DELETE` |
| No record of who did what | `admin_audit` (append-only, below) |
| The Super Admin list returned everything, unsorted | Server-side search / filter / sort / paging (`GET /api/super/tenants?q&status&mode&sort&dir&limit&offset`), response `{ tenants, total }` |
| Admins and Users had no display names | Optional `users.display_name`, text only |
| Several consequential actions used `window.confirm` | One accessible `ConfirmDialog` (severity, typed words, focus handling) for the new administration actions |

### 15.2 Lifecycle model

See the transition table in `shared/lifecycle.ts` (tested exhaustively). In short: a workspace is Active, Disabled or
Deletion requested (then Deleting, then gone); an account is Active or Disabled. **Disabled never means
deletion-requested.** Disabling a workspace closes every open WebSocket of the Admin and all Users (close code 4403)
and refuses them at sign-in; reactivation restores access without touching data.

### 15.3 Audit trail design

* Table `admin_audit` in the **registry** Durable Object (control plane): `id`, `at`, `action`, `actor_user_id`,
  `actor_email`, `actor_role`, `tenant_id`, `target_type`, `target_id`, `target_email`, `meta` (JSON of short, content-free
  values; anything else is dropped at write time).
* **Written in the same transaction** as the change it records (a failed audit write undoes the change).
* **Append-only in the database**: `BEFORE UPDATE` and `BEFORE DELETE` triggers abort. There is no route that writes or edits
  entries; entries outlive deleted workspaces (no foreign key).
* **The actor is derived on the server** from the verified principal (`actorOf` in the Worker); no request field names an actor.
* **Scopes decided by the server**: `GET /api/super/admin-audit` (Super Admin: workspace-level actions only, i.e. not
  `user.*`); `GET /api/tenant/audit` (Admin: rows of their own tenant id, taken from the principal). Users and everyone else: refused.
* Kept separate from the QA revision history (`record_history` in the workspace Durable Object) and from `deletion_audit`
  (the minimal deletion record, unchanged).

### 15.4 Last activity

The existing `users.last_login_at` is written by the sign-in path at most once per person per 12 hours; a workspace's last
activity is the newest of its accounts. No new writes. Per-request or per-message timestamps were rejected for free-plan
efficiency.

### 15.5 Schema and compatibility

Additive only: `users.display_name`, the `admin_audit` table, its index and two triggers, created or added in place by
`RegistryStore.init()`. **No new Durable Object class or migration tag.** The Stage 5/6 schema is reproduced and upgraded in a unit
test (rows preserved, repeatable). Older Workers/clients: `displayName` is optional on the wire (the client tolerates its absence).

### 15.6 Interface changes

Public page unchanged. Authenticated shell: account badge (name, role, workspace, mode) + Logout; navigation adds **History** (moved
out of Settings) and **Team / Users** (Admin only; replaced by Team Members in Stage 8B); Platform Administration has Overview, Admin workspaces, Deletion requests and Audit
log. The dashboard gains an execution summary (needs attention, overdue, executing today, planned/remaining cases, progress) computed only from
existing project data.

### 15.6b Tester wording and the cross-workspace answer

The QA-facing name of the `user` role is **Tester** (EN/JA); the stored role, the API and the permission table are unchanged. Creating a Tester whose email already
belongs to another workspace now returns `email_in_other_workspace` (409) instead of the generic `email_taken`, so the Admin gets a clear message. The response carries
no workspace name, id or admin address; it only reveals that the address is registered somewhere in the platform, which the Admin could already infer. Same-workspace
duplicates keep `email_taken`. Nothing is moved, duplicated or created in either case.

### 15.7 Free-plan impact

Audit entries are written only on administrative actions (a few per day at most). No per-request writes were added. The list endpoint reads
the (small) registry with indexed filters. No new Cloudflare product.


## 16. Stage 8A: QA execution management

* New record kind `cycle`; `ProjectRecord.cycleId`; `TesterProjectAssignment.userId`. All opaque records in the
  tenant's `WorkspaceRoom`; **no new DO class and no new migration tag**.
* `shared/qaRules.ts` (`qaCommitError`) runs inside `WorkspaceStore.commit({rules})` using the role from the socket
  attachment: cycles Admin-only, project cycle references must exist and not be archived, account assignments only via
  the API, execution entries shape-validated. Violations return `reject{reason:'invalid', message}` (the client does
  not go read-only). Rules check only changed data, so existing clients cannot be wedged.
* `WorkspaceRoom.assignTester` (RPC) commits one revision and broadcasts; the Worker first checks the Tester in the
  `RegistryRoom` (`listTesters`, `getTester`). Tenant isolation is by DO name (covered by tests).
* Extra writes: none on read; cycles and assignments cost the usual 3 rows per save.
* Tests: `worker/test/qa-rules.test.ts`, `worker/test/workers/stage8a-qa.test.ts`.

See [QA_EXECUTION.md](QA_EXECUTION.md).

## 17. Stage 8B: SVs, Testers, Owner SV and Team Members

* **Roles.** The product says SV and Tester. The stored roles stay `admin` and `user`; a workspace role on the WebSocket is derived from them
  (`admin` -> `admin`, `user` + `editor`/`viewer` -> `editor`/`viewer`). An SV is any `admin`, not only the Owner.
* **Registry schema (additive, idempotent, run by `RegistryStore.init()`).** `ALTER TABLE tenants ADD COLUMN owner_user_id`; `DROP INDEX IF EXISTS
  users_one_admin_per_tenant`; backfill the owner of every tenant that has none (its oldest non-disabled admin); three triggers
  (`users_owner_guard`, `tenants_owner_valid`, `tenants_owner_not_cleared`). Existing rows, deletion audit and admin audit are untouched; no new
  Durable Object class; **no migration tag**.
* **Authorization.** `can()` gained `history.read` (SV), `tenant.transferOwnership` (Owner SV); `team.view` is SV-only; `tenant.requestDeletion` is
  Owner-SV-only. The principal carries `isOwner`, derived from `tenants.owner_user_id`.
* **Commit rules.** `qaCommitError` runs `testerCommitError` first for every non-SV sender (kind whitelist, field-level project diff, own tickets,
  own performance, assigned + today for Today's Execution) with the actor from the socket attachment and the server's UTC date; it also refuses any
  change of a profile's `userId` over sync. `WorkspaceStore.commit({rules})` now also gives the rules a `list(kind)` read.
* **Read filtering.** `WorkspaceRoom` removes `review`, `report`, `topic`, `identityAudit` and `externalIdentity` from the snapshot, catch-up,
  broadcast and `/api/export` for non-SV sockets (one pre-serialized frame per audience, so broadcast cost is unchanged).
* **Server-originated revisions.** `ensureMemberProfile` and `linkMember` (RPC) create or link a profile and broadcast it; `restoreRevision` re-applies
  the profile links after a restore. They are single ordinary revisions in `record_history`.
* **Free plan.** Member and role changes are rare administrative writes. A new member costs one registry insert and audit row plus one revision;
  nothing is written on reads, sign-in beyond the existing 12-hour bucket, or heartbeat.
* **Rollback caution.** The Stage 8A Worker recreates `users_one_admin_per_tenant` at start. Once a workspace has a second SV, rolling back to a
  Stage 8A Worker would make the registry fail to start; roll forward (or disable and delete the extra SV rows first, which is a manual data change).
* Tests: `worker/test/registry-stage8b.test.ts`, `worker/test/tester-rules.test.ts`, `worker/test/workers/stage8b-roles.test.ts`, `src/test/stage8bRoles.test.ts`.

See [ADMINISTRATION.md](ADMINISTRATION.md) §9 for the permission matrix.
