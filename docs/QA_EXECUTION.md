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
(`cycleId`; absent or null = none). Only an Admin creates, edits, moves, completes or archives a cycle or changes a
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

Assignments created through the Admin API carry the Tester's stable `userId` (not an email or display name). The
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
