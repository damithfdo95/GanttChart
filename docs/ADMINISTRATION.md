# Administration guide (accounts, workspaces, audit)

How accounts and workspaces are administered in the shared (web) version, and what is kept
as a record. For the security design see [CLOUD_ARCHITECTURE.md](CLOUD_ARCHITECTURE.md) (§13–§15);
for deployment see [DEPLOYMENT_PLAN.md](DEPLOYMENT_PLAN.md).

> **Cloudflare authentication is not GanttChart authorization.** Cloudflare Access proves who
> a person is. GanttChart's own registry decides whether they may use the application. Nobody is
> ever added automatically, and there is no public registration.

## 1. Who creates whom

```
Super Admin    configured by the platform operator (SUPER_ADMIN_EMAILS); sees workspace metadata only
   └─ creates an Admin together with their workspace (tenant)
        └─ the Admin creates Users, inside that workspace only (Web storage)
```

* A **workspace** (tenant) belongs to exactly one Admin and holds all of that Admin's QA data. Users
  work only inside their Admin's workspace; the workspace is always taken from the signed-in person,
  never from anything the browser sends.
* An **Admin** can manage their workspace, choose Local or Web storage, add/disable/reactivate Users
  (Web storage), and ask for the workspace to be deleted. An Admin cannot create another Admin, cannot
  touch another workspace and has no platform rights.
* A **User** works in the workspace according to their access level (*Can edit* or *Read-only*) and manages
  nothing.
* The **Super Admin** creates Admins, disables/reactivates workspaces, reviews and decides deletion
  requests and reads the platform audit log. The Super Admin **cannot read QA data**: there is no route
  for it.
* Email addresses of Admins and Users must belong to the **managed organization domain(s)**
  (`MANAGED_USER_EMAIL_DOMAINS`, exact domain match). Super Admin addresses are configuration and exempt.

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
| Users | cannot be added; existing Users are refused | can be added; they work together with the Admin |
| Live sync and shared history | no | yes |
| User management | not available (the Team / Users screen explains this) | available |

Changing mode is a deliberate, verified migration (Local → Web uploads and verifies before switching;
Web → Local downloads, saves and verifies before switching and keeps the cloud copy archived). Nothing is
migrated silently.

## 4. Audit trail (administrative history)

Separate from the QA revision history. Append-only: the database refuses any update or delete of an entry,
there is no API to write one, and the **actor is always the signed-in person as known to the server**, never
a value from the request.

| Recorded | Examples |
|---|---|
| time, action, who did it (email and role), workspace, target account/workspace, safe details | `admin.created`, `tenant.disabled`, `tenant.reactivated`, `tenant.deletion_requested` / `_cancelled` / `_rejected` / `_approved`, `tenant.deleted`, `user.created`, `user.disabled`, `user.reactivated`, `user.access_changed`, `storage.migration_uploaded`, `storage.web_activated`, `storage.local_activated` |
| **never** | passwords, Access tokens/JWTs, one-time codes, secrets, project/report content, exported workspace data |

Who sees what: the **Super Admin** sees workspace-level events across the platform (no account-level events
inside a workspace); an **Admin** sees only their own workspace's events; a **User** sees none. Entries
outlive the workspace they describe (a deletion stays accountable) and contain no QA content.

## 5. "Last activity"

Shown as the account's most recent sign-in, written at most **once per person every 12 hours**, and for a workspace the newest
sign-in of anyone in it. It costs no extra database writes (the sign-in time was already kept for this) and is
therefore approximate. Updating it on every request or WebSocket message was rejected: it would spend the free
plan's write allowance on a timestamp.

## 6. Navigation

Admin and User: Dashboard · Projects / Test Executions · Gantt · Daily Report · Tickets · Performance · Review · RCS Members ·
Reports & Export · History · **Team / Users (Admin only)** · Settings. Super Admin: the platform console only (Overview,
Admin workspaces, Deletion requests, Audit log), never QA screens.

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
