# QA test execution management (Stage 8A)

This describes the QA-manager layer added in Stage 8A: test cycles, Tester assignment by stable user id, execution
metrics, risk indicators, the cycle screen, the dashboard panels, the Tester workload view and the Daily Report
Execution Summary. Everything here is **tenant-scoped**: a Super Admin never sees any of it.

## 1. What was reused (audit)

Nothing was replaced. Projects (`ProjectRecord`), daily execution entries (`DailyExecutionEntry`, which already hold
pass / fail / N/A / SPO / blocked per day), planning rows, `TesterProjectAssignment`, `RcsMember`, attendance, the
Needs-Attention rules (`projectNeedsAttention`) and the Daily Report are all used as they were. Added: the `cycle`
record kind, `ProjectRecord.cycleId`, `TesterProjectAssignment.userId`, domain modules `src/domain/cycles` and
`src/domain/qaMetrics`, and shared validation `shared/qaRules.ts`.

## 2. Test cycles

Fields: `id`, `name`, optional `version` label, optional `description`, `status` (Planned / Active / Completed /
Archived), `plannedStart`, `plannedEnd`, `completedAt`, `createdAt`, `updatedAt`. A project has at most one cycle
(`cycleId`; absent or null = none). Only an SV creates, edits, moves, completes or archives a cycle or changes a
project's cycle; this is enforced **by the server** (shared rules run inside the commit), not only in the UI.

| From | Allowed to |
|---|---|
| Planned | Active, Archived |
| Active | Planned, Completed, Archived |
| Completed | Active (reopen), Archived |
| Archived | Planned, Active |

A project cannot be put into an Archived cycle or a cycle that does not exist. Deleting is not offered: Archive
instead. Names, versions and ids are never translated.

## 3. Tester assignment

Assignments created through the SV-only API carry the Tester's stable `userId` (not an email or display name). The
server checks that the user is a Tester **of the same tenant** and not disabled (`tester_not_found` 404 /
`tester_disabled` 409). Account assignments cannot be created over the sync channel (`assignment_requires_api`), and
`userId` / `projectId` of an existing one cannot be changed. Ending an assignment keeps it (history); a disabled
Tester keeps historical assignments but cannot be newly assigned. Several Testers per project are allowed.
Endpoints: `GET /api/tenant/team`, `POST /api/tenant/assignments` (Admin only).

## 4. Metric definitions

| Metric | Definition |
|---|---|
| Planned | the project's total test cases |
| Executed | Passed + Failed |
| Completed | Passed + Failed + N/A + SPO (+ uncategorised completed) |
| Remaining | max(Planned − Completed, 0) |
| Blocked | the open blocked count; Blocked cases stay inside Remaining |
| Completion | Completed / Planned (— when Planned is 0) |
| Pass rate | Passed / Executed (— when nothing is executed; never Passed / Planned) |

Deviation from a naive "planned = executed + remaining": N/A and SPO count as completed work, so Executed alone does
not add up to Planned − Remaining. This matches the existing progress engine.

Server validation (`projectExecutionError`): counts are non-negative integers (≤ 10,000,000), Testers 0–100,000,
overtime 0–180 min, one entry per date, valid ISO dates, and an existing project's *completed* total cannot rise
above its planned total. Rules only inspect data a commit changes, so old data never blocks a save. Lowering Planned
below what was executed is allowed (history is preserved) and is shown as a warning in the UI.

## 5. Risk indicators (`RISK_THRESHOLDS` in `src/domain/qaMetrics`)

Deterministic, no scoring. Each signal has a code, a severity (info / warning / attention) and a translated message;
the UI always pairs colour with a symbol and a word. Project signals: overdue; behind plan; schedule attention
(existing rules); due within 2 days with more than 20% remaining; blocked cases (> 0 → attention); failed cases
(> 0 → warning); no activity for 3 days on an ongoing project; no Tester assigned (info); completed above planned.
Cycle signals: cycle overdue, due soon with much remaining, projects needing attention. Thresholds live in one object
and are covered by tests.

## 6. Screens

* **Cycles** (new nav item after Dashboard): list with progress and risk, create/edit form, cycle detail (projects,
  Testers, metrics, risks, move/add/remove projects, status actions with confirmation for Complete/Archive, CSV
  export). Testers see it read-only.
* **Dashboard** (Admin, web storage): manager panel (cycle and portfolio summary, today's numbers, attention list) and
  a project control center (cycle, Testers, metrics, risks per project).
* **Team**: the Admin Tester workload table. "Shared remaining" is the remaining cases of each project the Tester is
  on, counted in full per project; there are **no workload percentages** because the data has no per-person weighting.
* **Performance tab**: kept unchanged. It reports per-Tester daily output from attendance and executions and
  complements the cycle views, so it was not merged into them.

## 7. Daily Report

The default EN/JA templates gain "■ Execution Summary" (`{execution_summary}`): today's Executed / Passed / Failed /
Blocked in total and per project (with the cycle name), the Testers, and projects needing attention. Attendance and
activity sections are unchanged; custom templates without the placeholder are unaffected. Project names, ids,
versions and emails are not translated.

## 8. Storage and free plan

Cycles are ordinary opaque records (3 rows per save like any record). Metrics are computed on the client from daily
aggregates; nothing is written per render or per heartbeat. QA history is the existing `record_history` (separate
from `admin_audit`); conflicts use the existing per-record optimistic concurrency.

## 9. Backward compatibility

No destructive migration, no new Durable Object class, **no Wrangler migration tag**. Old projects without a cycle
load as "no cycle"; old assignments without `userId` still work (name based). Older clients ignore the new fields.
Production data needs no migration.

## 10. Deferred to Stage 8B

Templates, trend forecasting, AI risk scoring, external tracker integration, weighted capacity, email/Slack
notifications, complex charts, cross-tenant organisation analytics, branding.

## 11. Roles (Stage 8B)

"Admin" in this document now reads **SV** in the product (internal role `admin`; there can be several SVs per workspace). A **Tester** (internal
role `user`) sees cycle information only through the screens they have (Dashboard, Projects / Test Executions, Gantt); the **Cycles** screen, the manager
panels, the control center and the Tester workload are SV-only, and a Tester can record **Today's Execution only on a project they are assigned to**.
See [ADMINISTRATION.md](ADMINISTRATION.md) §9.

## 12. Stage 8C: Test Management (scopes, test cases, case-level execution)

### Hierarchy

```
Cycle > Project / Test Execution > Test Scope > Test Case > Execution Result
```

A Scope belongs to exactly one project (its stable project id, `PRJ-001`, the same one assignments use) and a Test Case to exactly one Scope. There is no
cross-project case library yet. Archived scopes and cases stay as history, accept no new results and are excluded from every total.

### Records (opaque shared records, three new kinds: `scope`, `testCase`, `caseResult`)

| Record | Fields | Notes |
|---|---|---|
| Scope | internal id (`scp_...`), project id, name, optional short code (`ECO`), description, status `active`/`archived`, display order, timestamps | The code is unique within the project and only used to suggest case keys; it is never a primary key. Renaming a scope never changes existing case keys. |
| Test Case | internal id (`tc_...`), project id, scope id, **key** (`ECO-001`), title, description, preconditions, steps, expected result, priority (critical/high/medium/low), type, tags, status, order, timestamps | The key is the business-facing id and is shown; the internal id is never shown. A key is unique in the project (archived cases included), never changes, is never renumbered and is never handed out again by the generator (it takes the highest number ever used plus one). Scope and project of a case never change. |
| Result | id `res_<caseId>`, project, scope, case, status, retest, question, memo (500), device (80), OS/version (80), optional ticket reference, executed by/at, updated by/at | One current result per case, created on the FIRST change (no record = Not Started). The id is derived from the case id, so two people on the same case always touch the same record and the existing per-record conflict detection applies; two people on different cases never conflict. |

### Statuses and the SPO decision

Not Started, In Progress, Pass, Fail, N/A, Blocked, **Not Executable (SPO)**. The product already had SPO ("cases QA could not execute, handed to the SPO
side"); that is the same concept as the spreadsheet's Not Executable, so the stored value is `spo` and the screens say "Not Executable (SPO)" (JA: SPO対応
（実施不可）). No second term was invented. N/A stays "Not applicable" (JA 対象外). **Retest** and **Question** (質問中) are yes/no FLAGS on a result, not
statuses; the question's explanation goes in the memo.

### Formulas (`summarize` in `src/domain/testManagement`, one place, tested)

| Value | Definition |
|---|---|
| Total | active test cases |
| Started | status other than Not Started |
| Completed | Pass + Fail + N/A + Not Executable (SPO) |
| Blocked, In Progress | NOT completed |
| Remaining | max(Total - Completed, 0) (Blocked stays in it) |
| Progress | Completed / Total |
| Pass Rate | Pass / (Pass + Fail), never Pass / Total |
| Retest, Question | number of cases with the flag |

No denominator: shown as a dash (never NaN or a division error). Project totals cover the active scopes only.

### Source of truth next to Stage 8A (no double counting)

The Stage 8A numbers (daily execution entries: Dashboard, Cycles, Manager panel, Daily Report) and the Stage 8C case-based numbers are **separate sources**.
Case results are never added to the daily entries and daily entries are never turned into cases; a project without test cases works exactly as before. The
screens label them differently ("Aggregate execution metrics" vs "Test Case execution summary") and the Test Management overview says so. Rolling case
results up into the aggregate reports needs an explicit source-of-truth decision and is Stage 8D/8F work.

### Assignments

`TesterProjectAssignment.scopeId` (optional) limits an assignment to one scope; the same endpoint (`POST /api/tenant/assignments`, SV only) takes it and checks
that the scope exists, belongs to that project and is active. An assignment WITHOUT `scopeId` (every assignment made before Stage 8C) means **all active
scopes of that project**: nothing was migrated and no existing assignment lost access. The disabled/foreign Tester, tenant and archived rules are the Stage 8A
ones. Ending an assignment keeps it as history.

### Who can read and write (enforced by the server)

* **SV:** reads and manages every scope, case and result of their workspace; may record any result as themselves.
* **Tester write:** a result only for an ACTIVE case in an ACTIVE scope they are assigned to today (scope-level, or project-level), as themselves (`updatedBy`
  and `executedBy` must be the account the server knows, never what the message says). They cannot create, edit, archive or delete scopes, cases or results,
  or assign people. Scopes and cases of an archived scope are refused.
* **Tester read:** the server removes everything else from the snapshot, catch-up, live changes and `/api/export`: a scope only while it is active and an
  assignment applies; that scope's active cases and its results; account assignments of other people are not sent either. A new assignment pushes the scope to
  the Tester at once; ending it removes it; a reconnect after any assignment change gets a fresh filtered snapshot. No assignment, no definitions and no results.
  Overall and Gantt stay as in Stage 8B (readable by every Tester).
* Server rules: `shared/testManagement.ts` (commit rules), `shared/testManagementAccess.ts` (read filtering), `worker/src/workspaceRoom.ts`.

### Screens

* **SV, Test Management** (one project at a time): Overview (per-scope table and cards, assigned Testers by name), Scopes (add, edit, archive, reorder,
  assign / end), Test Cases (add, edit, archive, reorder, **Bulk Add**), Execution (filters by status, priority, text, retest, question, last updated by;
  summary; in-place editing).
* **Tester, My Testing:** the assigned scopes with "x / y completed" and Continue; the same grid, limited to those cases.
* **Bulk Add:** paste tab-separated cells from Excel (Key, Title, Priority, Type, Expected Result; only Title is required; a blank key gets the next free
  key); a header line is skipped; Japanese text and priorities (高/中/低/最高) work. The whole paste is checked first and shown as a preview; one bad line (bad
  or duplicate key, empty title, bad priority) refuses everything. Up to 500 lines per paste (one commit). Full `.xlsx` import is a later stage.

### Write cost (Cloudflare Free)

Nothing is written on render or by a heartbeat. A status, a flag or a stored field is written only when its value changes (clicking the status that is
already set writes nothing); memo, device and OS are saved when the field is left (or Enter), never per keystroke. Each changed result is one small record
(one revision, three SQLite row writes like any record); a Tester working through a scope costs about one revision per change, and commits made close
together are sent as one. A bulk add of N cases is ONE commit (N + 1 rows); results are created lazily, so adding cases creates no result rows. Revision
history gets one entry per commit, not one per field. The local database stores each of the three collections as one blob, so a very large workspace
(thousands of cases) rewrites it on each local save; this is local-only work. The server's per-workspace record limit (20,000) bounds a workspace: roughly
the cases plus the results.

### Project export and import

The single-project file (Overall, "export project") is a complete project: it now carries the project's scopes, test cases and results (nothing of any
other project). Account assignments are deliberately NOT in it. On import ids are kept when nothing collides, and replaced consistently (scope, case and
result ids together) when the project is re-IDed or an id is taken, so a second import never overwrites the first. Results are re-attributed to the person
importing them in a shared workspace (accounts of another workspace are never rebound); in plain local use they stay as exported and show as "Former
member". Files from before Stage 8C import unchanged, and an export of a project without test management has exactly the old format. A full workspace
backup always included everything, and still does.

### No default people, and no ids as names

* Nothing creates the eight old placeholder members (USER0001 to USER0008) any more: not a new workspace, not normalisation, not a backup restore, not a
  reset. An empty roster is valid; people are added through Team Members.
* Workspaces that still have them show a note in Team Members with **Clean up placeholders**: a member is a placeholder only if it is EXACTLY one of the
  original eight (id, name, team, role, start date, no end date, no name history, no account link). Unreferenced ones are removed; ones that attendance,
  assignments, tickets, performance or reviews refer to are kept but made inactive (so no selector offers them), and nothing is converted into a real account
  or matched by name. Inactive members never appear in the performance or assignment selectors; the ticket and attendance forms keep showing an inactive
  member only so an old record can still be edited.
* **Person labels** (`src/domain/people`): display name, then organization email, then "Former member" (JA 元メンバー). Anything that looks like an internal
  id (`usr_...`, `USER0001`, `tc_...`) is treated as missing, so it can never become a label. Account ids, roster ids and internal scope/case/result ids are
  never rendered; case KEYS (ECO-001), project ids (PRJ-001) and emails are business data and are shown. Human-facing exports use the same resolver.
* The old label "QA Test Execution Schedule Tracker" is gone from the product (and so is its subtitle); the neutral fallback is "QA Management" (JA QA管理),
  and a workspace's Tool Name replaces it everywhere after sign-in.

### Backward compatibility and upgrade

All new fields and records are optional or additive: old workspaces, backups and project files load with empty test management. No Durable Object class, no
Wrangler migration tag and no data migration. Existing Testers keep their project-level assignments (= all active scopes of the project).
