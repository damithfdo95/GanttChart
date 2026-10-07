# Administration guide (accounts, workspaces, audit)

How accounts and workspaces are administered in the shared (web) version, and what is kept
as a record. For the security design see [CLOUD_ARCHITECTURE.md](CLOUD_ARCHITECTURE.md) (§13–§15);
for deployment see [DEPLOYMENT_PLAN.md](DEPLOYMENT_PLAN.md).

> **Cloudflare authentication is not GanttChart authorization.** Cloudflare Access proves who
> a person is. GanttChart's own registry decides whether they may use the application. Nobody is
> ever added automatically, and there is no public registration.

## 1. Who creates whom

```
Super Admin     configured by the platform operator (SUPER_ADMIN_EMAILS); sees workspace metadata only
   └─ creates a workspace (tenant) together with its first SV, who becomes the Owner SV
        └─ SVs (the Owner SV and any other SV) add Team Members, inside that workspace only (Web storage):
             ├─ more SVs
             └─ Testers
```

**Words.** In every QA-facing screen (English and Japanese) the two workspace roles are **SV** and **Tester**. Internally the stored
role values are unchanged: **SV = `admin`** and **Tester = `user`**. Renaming stored values would only add migration risk, so
`admin` / `user` appear only in code, the database and this document. The Super Admin keeps its name.

* A **workspace** (tenant) holds all of one team's QA data. Its people work only inside it; the workspace is always taken from the
  signed-in person, never from anything the browser sends.
* A workspace has **one Owner SV, any number of other SVs and any number of Testers.** The one-admin-per-workspace rule of earlier
  stages was removed on purpose (§8): the registry no longer has a unique index on the admin role.
* The **Owner SV** is recorded in `tenants.owner_user_id` (not inferred from an email or an order). The first SV of a new workspace is
  its Owner SV; for every existing workspace the existing Admin became the Owner SV automatically on the first start of this version.
  Only the Owner SV can **request deletion of the workspace** and **transfer ownership**. The Owner SV cannot be disabled, demoted or
  removed (the database refuses it, not just the screen); to step down they transfer ownership to another enabled SV first.
* An **SV** manages the workspace: projects, plans, cycles, tickets, performance, daily reports, reviews, Team Members, History and
  Settings; chooses Local or Web storage; adds, disables and reactivates Team Members (Web storage). An SV cannot touch another
  workspace and has no platform rights.
* A **Tester** works in the workspace according to their access level (*Can edit* or *Read-only*) and manages nothing (matrix in §9).
* The **Super Admin** creates workspaces (with their first SV), disables/reactivates workspaces, reviews and decides deletion requests
  and reads the platform audit log. The Super Admin does **not** create Testers or other members and **cannot read QA data**: there
  is no route for it.
* Email addresses of SVs and Testers must belong to the **managed organization domain(s)** (`MANAGED_USER_EMAIL_DOMAINS`, exact
  domain match, no `fake-rakuten.com`, no subdomain tricks). Super Admin addresses are configuration and exempt.

### Team Members and the flow of adding one

1. An SV (Web storage) opens **Team Members → Add Member** and enters the person's organization email address, an optional display
   name, and the role **SV** or **Tester** (and, for a Tester, *Can edit* / *Read-only*). The form has no tenant selector, no internal
   role names, no password, no invitation code and no Cloudflare setting.
2. The server normalizes the email and creates the account **bound permanently to the SV's workspace**. The workspace comes from the
   SV's own verified identity. It also creates the person's **Team Member profile** (the roster entry attendance, performance and
   tickets point at), linked to the account by its stable id.
3. Later the person signs in through Cloudflare Access with the same address. The registry matches the verified email and puts them in
   that workspace. No invitation code, no password, no Super Admin approval, no public registration, and no account is ever created
   just because someone authenticated.
4. An address that already belongs to a **different** workspace is refused (`email_in_other_workspace`) with a message that never says
   whose it is; it is not moved or duplicated. An address already in **this** workspace is refused as a duplicate. An address outside the
   managed domain is refused. Cross-workspace transfer does not exist.
5. A Local-mode workspace cannot have members (explained on the screen); nothing silently enables Web storage.
6. **Disable / reactivate** works for Testers and for non-owner SVs: access stops at once and any live connection is closed; the
   record, the name, the assignments, the history and the audit entries stay; reactivating restores the same account. Nobody can
   disable themselves, and the Owner SV cannot be disabled.
7. **Transfer ownership** (Owner SV only): Team Members → *Make Owner…* on another **enabled SV**, confirmed in a dialog and by the typed
   word `TRANSFER` (the server checks it too). It is one statement on one row, so there is never a moment with no owner or two owners;
   the database also refuses an owner that is not an enabled SV of the same workspace. It is recorded in the workspace audit trail.

### Team Members and the RCS roster ("RCS Members" and "Team / Testers" are one screen now)

The old **RCS Members** screen and the old **Team / Testers** screen were merged into **Team Members**. There is one list of people with
two halves that are joined by the account's stable id:

| Half | What it is | Where it lives |
|---|---|---|
| **Account** | who may sign in and as what (email = login identity, role, access, status) | the registry |
| **Profile** | the roster entry that attendance, tickets, assignments, performance and reviews refer to (`USER0001`, name, team, role label, dates, name history) | the shared workspace (`member` records) |

`RcsMember.userId` is the link. It is set **only by the server**: when a member is added (a profile is created and linked), or when an SV
explicitly links an older roster-only entry to an account (**Link to roster member…**) or gives an account that predates profiles
its profile (**Create profile**). A browser cannot set, change or drop it (`member_link_requires_api`), and editing a profile in the
roster never loses it. Roster entries from before this stage have **no email** and therefore cannot be matched automatically; they stay as
roster-only entries until an SV links them. The screen may point out an account and a roster entry with exactly the same name, but that
is only a hint: **identity is never guessed from a name.** Nothing is merged, deleted or duplicated automatically.

A Tester's Team Members screen is **My Team Member Profile**: their own name, email, role, status, workspace, profile id and assigned
test executions, read-only. They never see the member list.

## 2. Account lifecycle

| Object | States | Notes |
|---|---|---|
| Workspace | **Active** → **Disabled** → Active; **Active** → **Deletion requested** → Active (cancelled or rejected) or → *Deleting* → removed | Defined once in `shared/lifecycle.ts` as a transition table. Anything not in the table is refused. |
| Account (Admin / User) | **Active** ⇄ **Disabled** | Two states only. |

* **Disabled is not deleted.** Disabling a workspace locks out its Admin and all Users at once (open
  sessions are closed) and changes nothing else: data, history and storage stay as they are. Reactivating
  restores access. Disabling a User does the same for one person; their record and everything they did stay.
* **Deletion is a separate, reviewed path.** The Admin requests it by typing `DELETE` (checked on the
  server too); nothing is destroyed. The Super Admin sees workspace metadata only and either **rejects**
  (the workspace is simply active again), or **approves** by typing the workspace id and the Admin's email.
  Approval permanently deletes the workspace data, the Admin, all Users, history and sync metadata, and
  keeps a content-free record. The requester can never approve.
* There is **no "invited" state**. Nothing is emailed; a new account is active immediately and signs in
  with Cloudflare Access. (Accounts created before Stage 7 may be stored as "invited"; they are shown
  and behave as Active, and nothing is migrated.)
* Naming: the stored word for a disabled workspace is `deactivated` (kept for compatibility); the product
  calls it **Disabled**.

## 3. Storage mode

| | Local | Web |
|---|---|---|
| Where the data is | this device / browser | the server, for this workspace only |
| Team Members | cannot be added; existing Testers are refused | can be added; SVs and Testers work together |
| Live sync and shared history | no | yes |
| Member management | not available (the Team Members screen explains this) | available |

Changing mode is a deliberate, verified migration (Local → Web uploads and verifies before switching;
Web → Local downloads, saves and verifies before switching and keeps the cloud copy archived). Nothing is
migrated silently.

## 4. Audit trail (administrative history)

Separate from the QA revision history. Append-only: the database refuses any update or delete of an entry,
there is no API to write one, and the **actor is always the signed-in person as known to the server**, never
a value from the request.

| Recorded | Examples |
|---|---|
| time, action, who did it (email and role), workspace, target account/workspace, safe details | `admin.created`, `tenant.disabled`, `tenant.reactivated`, `tenant.deletion_requested` / `_cancelled` / `_rejected` / `_approved`, `tenant.deleted`, `user.created` (the record says whether an SV or a Tester was created), `user.disabled`, `user.reactivated`, `user.access_changed`, `owner.transferred`, `storage.migration_uploaded`, `storage.web_activated`, `storage.local_activated` |
| **never** | passwords, Access tokens/JWTs, one-time codes, secrets, project/report content, exported workspace data |

Who sees what: the **Super Admin** sees workspace-level events across the platform (no account-level events
inside a workspace, and not ownership transfers); an **SV** sees only their own workspace's events; a **Tester** sees none. Entries
outlive the workspace they describe (a deletion stays accountable) and contain no QA content.

## 5. "Last activity"

Shown as the account's most recent sign-in, written at most **once per person every 12 hours**, and for a workspace the newest
sign-in of anyone in it. It costs no extra database writes (the sign-in time was already kept for this) and is
therefore approximate. Updating it on every request or WebSocket message was rejected: it would spend the free
plan's write allowance on a timestamp.

## 6. Navigation

One table decides it (`SCREEN_ACCESS` in `src/app/access.ts`); the same table drives the menu and the controls on each screen.

* **SV:** Dashboard · Cycles / Releases · Projects / Test Executions · Gantt · Daily Report · Tickets · Performance · Review · Reports &
  Export · **Team Members** · History · Settings.
* **Tester:** Dashboard · Projects / Test Executions · Gantt · Tickets · Performance · Team Members (their own profile).
* **Super Admin:** the platform console only (Overview, Workspaces, Deletion requests, Audit log), never QA screens.

Gone from the menu: **RCS Members** (now part of Team Members) and **Team / Testers**. Backup controls moved out of the Dashboard
(§9). The **Performance** screen stays as it is (§9).

## 7. Schema changes in Stage 7 (additive)

* `users.display_name TEXT` (nullable), added in place on first start (`ALTER TABLE … ADD COLUMN` if missing).
* `admin_audit` table, index and two append-only triggers (`CREATE … IF NOT EXISTS`).
* No new Durable Object class, **no Wrangler migration tag**, no data migration. Existing rows are untouched; an
  existing registry upgrades itself the first time the new code starts (tested against the Stage 5/6 schema).

## 8. Stage 8 design notes (QA manager features) — not implemented

What the current data model already supports, and where it will need to grow:

| Future feature | What exists today | What will be needed |
|---|---|---|
| **Test cycle / release** | `ProjectRecord` is the unit of work; `team`; `statusHistory` | A *Cycle* (or Release) record grouping projects, with dates and a lifecycle. New record kind `cycle` in the sync protocol (`RECORD_KINDS`); a nullable `cycleId` on `ProjectRecord`. |
| **Assignment of executions to testers** | `TesterProjectAssignment`, `RcsMember`, `AttendanceRecord`, `TesterDailyPerformance` | Per-case or per-suite assignment granularity (today it is per project/day); an `execution` or `suite` entity if per-case tracking is wanted. |
| **Pass / fail / blocked metrics** | Only `casesCompleted` and `totalCases` per project, `DailyExecutionEntry`, `BlockingEvent` | Per-day counters by result (`passed`, `failed`, `blocked`) on `DailyExecutionEntry`, or a results table; today these figures cannot be computed, so the dashboard does not show them. |
| **Planned vs actual progress** | `PlanningRow`, `planningRows`, capacity calculations, `DailyTargetOverride`, `DailyActualSnapshot` | Mostly present; a stored baseline snapshot per cycle to compare against later re-plans. |
| **Defect / bug references** | `BugTicket` (ticket tab) | Link tickets to a project/cycle and a result; optional external tracker id/URL (JIRA URL setting already exists). |
| **Execution velocity** | derivable from daily actuals | Define the window (3-day / 7-day) and store nothing: compute in the client. |
| **Risk / at-risk indicators** | `projectPlanningStatus`, `projectNeedsAttention`, `isProjectOverdue` | Already used for "Needs Attention"; add trend (velocity vs required rate) once velocity exists. |
| **Reusable templates** | project inputs are plain data; backup/import | A `template` record kind (inputs without dates/actuals), "create from template". |
| **Daily report generation** | `DailyReport`, `DailyTopic`, `NextDayItem`, report templates | Pull-in of attendance and results automatically once results exist. |
| **Management summary / export** | `ReportsExport`, `ExecutiveSummaryView` | A cross-project, cycle-level summary page and export (PDF/Excel) built from the same selectors as the dashboard strip (`managerSummary`). |

Constraints to keep: every new record kind must go through the existing opaque-record sync (3 rows written per
save on the free plan), stay inside the tenant, and be covered by the export/import/migration hash
(`canonicalRecordsHash`). Tables like results should be modelled as **per-day aggregates**, not per-case rows, to
stay inside the free-plan write budget. If per-case history is ever required, a relational store (D1) would be the
documented option; it is **not** used or needed now.

## 9. Stage 8A update

Section 8 above is now implemented (cycles, results metrics, risk indicators, Tester workload, Daily Report
integration); see [QA_EXECUTION.md](QA_EXECUTION.md). Navigation gains **Cycles** after Dashboard. Admins gain
`GET /api/tenant/team` and `POST /api/tenant/assignments`; permissions `team.view` and `assignments.manage`. Still no
new Wrangler migration tag. Super Admin sees no QA data.

## 9. Stage 8B: SV and Tester roles, Team Members, permissions

### Permission matrix

| Area | SV | Tester |
|---|---|---|
| Dashboard | everything (manager panels, cycles, portfolio, control center) | **Operator section only**, plus **Today's Execution** for projects they are assigned to; the manager data is not shown (and the server does not send them the SV-only records) |
| Today's Execution | any project, any day | **today only** (the server allows yesterday/tomorrow only for time zones), **only on a project they are assigned to by account**, nothing else in the project may change |
| Projects / Test Executions (Overall) | create, edit, status, delete, export | **read-only** (no add, import, export, status change, delete) |
| Gantt | edit the plan | **read-only** |
| Cycles / Releases | manage | not offered; the server refuses any cycle change |
| Tickets | every ticket, all actions | **sees every ticket**; raises tickets **as themself**; changes or removes **only their own** (a ticket's reporter and project cannot be changed) |
| Performance | every row, sync and allocation tools | **their own rows only**, fixed to their linked Team Member profile; the sync/allocation tools are not shown; the existing per-person tables stay visible (unchanged exposure) |
| Daily Report, Review, Reports & Export | manage | not offered; the server never sends them reports, reviews, topics or the identity logs |
| Team Members | manage members, link/create profiles, transfer ownership (Owner SV) | **My Team Member Profile** only |
| History (shared QA history) | view, preview, restore; paged 25 / 50 per page | none; the history API answers 403 |
| Settings (workspace settings, Workspace Appearance, **Data & Backup**, storage mode) | manage | none |
| Delete the workspace / transfer ownership | Owner SV only | none |

Every row is enforced **on the server**, not by hiding buttons:

* `worker/src/permissions.ts`: `history.read`, `users.manage`, `team.view`, `assignments.manage` are SV-only; `tenant.requestDeletion` and
  `tenant.transferOwnership` are Owner-SV-only.
* `shared/testerRules.ts`: every commit of a Tester (or read-only member) is checked against the table above. The three Tester inputs live
  inside a project record (`inputs.dailyExecuted` with its derived totals, `inputs.bugTickets`, `inputs.testerDailyPerformance`), so the
  rule is field-level: the rest of the project must be unchanged. The actor is the registry account of the WebSocket (set by the Worker),
  never anything in the message; "their own" means the Team Member profile linked to that account by the server. Refusals are
  `reject{invalid, message: <code>}` and the browser explains the code in plain words.
* A Tester's socket, catch-up, live changes and `/api/export` leave out the SV-only kinds (`review`, `report`, `topic`, `identityAudit`,
  `externalIdentity`).
* The browser also limits what a Tester's editing surface writes back to a project (`applyActiveProjectSyncRestricted`), so merely opening
  a project never produces a change the server would have to refuse.
* If an account has no profile yet, a Tester can still raise tickets, but cannot write performance rows until an SV links or creates the
  profile (the screen says so).
* Superseded by this stage: Testers could previously read History and the Tester roster and write anything. Existing Tester logins keep
  working unchanged; a Tester must now be **assigned** (Admin API / Cycles screen) before they can record Today's Execution.

### Roles in the registry

* `tenants.owner_user_id` (nullable, added in place). Triggers: the owner row cannot be disabled, demoted or moved to another tenant;
  `owner_user_id` can only point to an enabled `admin` user of the same tenant and can never be cleared.
* The unique index `users_one_admin_per_tenant` is dropped (`DROP INDEX IF EXISTS`).
* On every start: `UPDATE tenants SET owner_user_id = (the tenant's oldest non-disabled admin) WHERE owner_user_id IS NULL`. Idempotent;
  a workspace without any admin is left without an owner instead of failing the start.
* Email stays unique platform-wide; deletion and audit rows are untouched; no new Durable Object class and **no Wrangler migration tag**.
* API: `POST /api/tenant/users` takes `role: "sv" | "tester"` (the internal words are refused); `PATCH /api/tenant/users/:id` works for
  non-owner SVs and Testers; `POST /api/tenant/owner`; `POST /api/tenant/members/link`; `POST /api/tenant/members/profile`; whoami now
  carries `userId` and `isOwner`; the user list carries `isOwner`.

### Shared History

SV only. The server already paged by revision (`before`); the screen now asks for one row more than it shows (25 or 50) and walks
Newer / Older with a range indicator, so a page boundary can neither repeat nor skip a revision (new revisions appear on the first
page). Restoring an older revision keeps every profile-to-account link, because those links are not QA history. The QA history and
the administrative audit trail remain separate systems.

### Data & Backup

Export, Import and Reset were removed from the Dashboard header and are in **Settings → Data & Backup** (SV only; a Tester has no
Settings screen). The confirmations and the shared-workspace guards are the same as before; nothing was removed.

### Workspace Appearance

**Tool name** is implemented: an SV sets the workspace's own name for the tool in Settings; it is stored in the shared settings
record (1–40 characters, plain text, no `<` or `>`, validated by the server too), is shown in the Dashboard header and the browser tab
after sign-in, and the public sign-in page keeps the platform name. The **logo is deferred**: the free-plan-friendly approach is a
small (≤ 100 KB PNG/JPEG/WebP) image stored as a data URL in that same settings record, or a file bundled with the Worker's static
assets; both need size and type validation on the server, and sync every client's settings record on each change, so it was left out
of a role-migration stage. R2 is not used.

### Not done in this stage

Changing a member's role later (SV <-> Tester), editing a member's display name, cross-workspace transfer, notification scheduling,
the Morning/Evening Meeting Gantt, per-test-case execution, Excel import, weighted capacity.
