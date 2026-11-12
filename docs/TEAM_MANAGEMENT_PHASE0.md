# Team Management — Phase 0 Implementation Map (TM-00)

**Status:** Architecture and migration baseline (produced 2026-11-05). **Phase 1 foundation implemented 2026-11-05** (see §10).
**Scope:** Reconciles the Team Management specification with the existing GanttChart architecture.
**Backlog items covered:** TM-001 (member/team models), TM-002 (roles/permissions), TM-003 (assignment/reporting dependencies), TM-004 (migration design), TM-005 (domain services and API conventions).

---

## 1. TM-001 — Existing member and team models

### 1.1 Member identity (what exists)

| Concept | Where | Notes |
|---|---|---|
| `RcsMember` profile | `src/types/index.ts:217` | `id` ("USER0003", permanent, never shown), `name`, `team` (**free-text label**), `role` ('sv'\|'tester'), `startDate`/`endDate` (inclusive, optional end = open), `active`, `email` (normalised, unique), `userId?` (server-set account link), `nameHistory?`, `removedAt?` |
| Account (control plane) | `shared/tenancy.ts:171` | `UserDto` / `TesterDto` in the REGISTRY Durable Object. Profile ↔ account are separate; link is `RcsMember.userId`, set only by the server |
| Pure member rules | `shared/members.ts` | `memberRoleOf`, `accountRoleOf`, `memberCommitError` (commit-time validation hook), `memberWithEmail` |
| ID generation | `worker/src/workspaceRoom.ts:382` + `src/domain/members/index.ts:290` | `USER` + zero-padded max+1, both sides |
| Directory selectors | `src/domain/teamMembers/directory.ts` | `selectableMembers`, `personOptions`, `isActiveMember`, `isLinked`, `directoryRows` — feeds every person dropdown |
| Member UI | `src/features/tenancy/TeamScreen.tsx`, `TeamDirectory.tsx`, `src/features/members/RcsMembersTab.tsx` | Screen id `team`; SV manages the directory, Tester sees only "My Team Member Profile" |

### 1.2 Team concept (what exists — and what does not)

**There is no Team entity.** "Team" today is:

1. A free-text label `RcsMember.team` (e.g. `'RCS'`, `'PrV'`), copied onto `AttendanceRecord.team` and `TesterProjectAssignment.team`.
2. A settings list `ReportSettings.teams: string[]` (`src/types/index.ts:758`), edited in Settings, default `['PrV', 'RCS']`.
3. `docs/CLOUD_ARCHITECTURE.md:95` explicitly defers multi-team: "a future multi-team version would use one object per team name".

**Conclusion:** the Team Management module introduces the first structured Team entity. The free-text `RcsMember.team` becomes a *derived display value* (primary team name), kept for backward compatibility with attendance/assignment history.

### 1.3 Persistence architecture (what the spec must adapt to)

The spec's §4 relational model (13 tables) **does not map 1:1 to this repository**. The actual architecture:

- **Local mode:** IndexedDB `GanttChartDB` (schema v2) + localStorage fallback; single JSON backup (version 1, additive-optional fields only — `docs/BACKUP_FORMAT.md`).
- **Web mode:** two Durable Objects with SQLite (`worker/wrangler.jsonc`): `WORKSPACE` (one per tenant, data plane — `worker/src/workspaceRoom.ts`) and `REGISTRY` (control plane — `worker/src/registryRoom.ts`).
- **The workspace is a document store, not a relational schema:** `WorkspaceStore` (`worker/src/store.ts:100`) keeps opaque JSON records keyed by `(kind, id)` in `records`, with append-only `record_history` and `revisions`. The server never interprets record contents; validation runs in shared pure modules via the `rules` hook (`qaCommitError`, `memberCommitError`).
- **No migration tooling exists.** Registry schema evolves via idempotent `CREATE TABLE IF NOT EXISTS` + `ADDED_COLUMNS` self-upgrading `ALTER TABLE`. Workspace data needs no SQL change for new kinds.
- **Record kinds** are a closed list: `RECORD_KINDS` in `shared/protocol.ts:14` (20 kinds today), mapped to `ReportsState` arrays in `src/lib/sync/records.ts` — the ONLY place state ↔ records mapping happens.

### 1.4 Reconciled data model (spec §4 → this repository)

**Decision: implement the spec's logical model as new workspace record kinds (JSON documents), not as new SQL tables.** This preserves sync, revision history, backup, restore and tester-filtering for free, and requires zero database migration. The REGISTRY (accounts) is untouched.

Proposed new record kinds (added to `RECORD_KINDS` and `src/lib/sync/records.ts`):

| Spec table | Record kind | Shape (JSON fields per spec §4.1) |
|---|---|---|
| `teams` | `team` | `id, name, code, description, parentTeamId, timezone?, status, createdAt, updatedAt` |
| `team_memberships` | `teamMembership` | `id, memberId, teamId, membershipKind ('PRIMARY'\|'SECONDARY'\|'SUPPORT'), durationType ('PERMANENT'\|'TEMPORARY'), effectiveFrom, effectiveTo?, status, reason?, createdBy, createdAt` |
| `team_transfer_events` | `teamTransfer` | `id, memberId, fromTeamId, toTeamId, changeType, effectiveDate, plannedEndDate?, status, reason?, sourceApproverId?, destinationApproverId?, createdBy, createdAt, completedAt?` |
| `skills` + `member_skills` | `skill`, `memberSkill` | catalogue entries; `memberSkill` = `{id, memberId, skillId, proficiency, verifiedBy?, verifiedAt?}` |
| `work_schedule_templates` + `_days` | `workSchedule` | one document per template: `{id, name, timezone?, status, days: [{weekday, start, end, breakMinutes, workingMinutes}]}` |
| `member_schedule_periods` | `memberSchedule` | `{id, memberId, templateId, effectiveFrom, effectiveTo?}` |
| `leave_types` | settings | configurable list inside the `settings` record (small, rarely changes) — avoids a record kind |
| `leave_requests` + `leave_days` | `leaveRequest` | one document: `{id, memberId, leaveTypeId, startDate, endDate, status, reason?, approverId?, submittedAt, decidedAt?, decisionNote?, days: [{date, requestedMinutes}]}` |
| `holiday_calendars` + `holidays` | `holidayCalendar` | one document per calendar: `{id, name, timezone?, status, holidays: [{date, name, workingMinutesReduction}]}`; assignment to teams/members via `team.calendarId` / member profile |
| `capacity_allocations` | `capacityAllocation` | `{id, memberId, teamId, projectId?, hoursPerWeek, effectiveFrom, effectiveTo?, status, notes?}` |
| `team_supervisors` | `teamSupervisor` | `{id, teamId, memberId, role ('SUPERVISOR'\|'LEAD'), effectiveFrom, effectiveTo?}` |
| `member_profiles` (extended fields) | extend `RcsMember` | additive optional fields: `employeeCode?, jobTitle?, employmentType?, timezone?, defaultWeeklyMinutes?, adminNotes?` — profile stays ONE identity record; no separate `member_profiles` table |
| `audit_events` | **no new store** | `record_history` already captures before/after JSON per revision with actor+reason; account-touching events go to `admin_audit` via `registry.recordMemberEvent` (see §5.3) |

**Integrity rules (spec §4.2) map to the existing `rules` hook:** a new pure module `shared/teamRules.ts` (mirroring `shared/members.ts` / `shared/qaRules.ts`) exports `teamCommitError(...)` — no overlapping PRIMARY memberships, temporary requires end date, no circular team hierarchy, allocations within membership periods, schedule periods non-conflicting. It runs browser-side (pre-check) and server-side inside `WorkspaceStore.commit` (authoritative), exactly like `qaCommitError` today.

### 1.5 Date semantics — **spec conflict, must be resolved in Phase 1**

- Existing convention everywhere (`RcsMember`, `TesterProjectAssignment`, `isAssignedIn`): **inclusive start, inclusive end**, `undefined` end = open-ended.
- Spec §3.3/§4.2: **inclusive start, EXCLUSIVE end stored**, inclusive end displayed.

**Recommendation:** new Team Management kinds follow the spec (exclusive stored end, inclusive display) because effective-dated membership chains (close old + open new) are far easier to reason about with half-open intervals — but the conversion must live in ONE pure helper (`shared/teamDates.ts`) with exhaustive tests, and every UI must go through it. Document the difference loudly: mixing conventions silently is the top data-integrity risk of this project.

---

## 2. TM-002 — Existing roles and permissions

### 2.1 What exists

- **One authorization system:** `worker/src/permissions.ts` — pure, default-DENY `can(principal, action)` with a closed `Action` union (~25 actions: `users.manage`, `team.view`, `assignments.manage`, `data.read/write/restore`, ...). Exhaustively tested.
- **Principal:** verified Cloudflare Access JWT → registry lookup → `MemberPrincipal` (role `admin`/`user`, `isOwner`, `access`, tenant). Tenant always from the principal, never the request.
- **Frontend mirror:** `src/app/access.ts` — `SCREEN_ACCESS` table (one place deciding what the browser *offers*); the Worker enforces the same rules per request and per commit.
- **Roles:** SV = `admin`, Tester = `user`, plus platform `super_admin` (console only, no QA data). **There is no team-scoped dimension today** — an SV can manage everything in their workspace.
- **Tester commit sandbox:** `shared/testerRules.ts` — field-level rules for what a Tester may change inside project records; `SV_ONLY_KINDS` filters what Testers receive.

### 2.2 Team-scoped permissions design (spec §3.4 → this repository)

Extend, never replace, the existing model:

1. **New actions** in the `Action` union: `teams.manage` (create/edit/archive teams, hierarchy — admins only), `assignments.manage` already exists (reuse for cross-team assignment creation), plus `leave.approve`, `leave.submit`, `capacity.manage`, `transfers.approve`.
2. **New resource-scoped check:** `canOnTeam(principal, action, teamId, supervisors)` — a pure function in `worker/src/permissions.ts` (or a new `shared/teamAccess.ts` so the browser can mirror it) that answers "is this principal an admin, or a supervisor of THIS team for TODAY?". Supervisor truth comes from `teamSupervisor` records (effective-dated), never from a request field.
3. **Cross-team transfer confirmation (spec §3.4):** enforced in the transfer service (§5.1) — a primary transfer commit is only accepted when both `sourceApproverId` and `destinationApproverId` are filled by authorized users, or an admin override with `reason` is recorded (audited via the commit `reason` + `record_history`).
4. **Frontend:** extend `SCREEN_ACCESS` with the new screen (§6); supervisors see management controls only for their teams — computed with the same shared pure function, so UI and server never diverge.
5. **Leave approval authorization (TM-407):** `leave.approve` checks the approver stored on the request (`leaveRequest.approverId`, set at submission from the primary-team supervisor of the first leave date) OR an admin — matching spec §3.5's "approver stored at submission" rule.

---

## 3. TM-003 — Project assignments and reporting dependencies

### 3.1 What must not break

| Dependency | Where | Impact of Team Management |
|---|---|---|
| `TesterProjectAssignment` (`src/types/index.ts:891`) | projectId + memberId/userId + inclusive dates + `active` | **Unchanged.** Team memberships are a parallel concept; project assignment stays the unit of "who executes what" |
| QA execution history | `caseExecution` (append-only), `caseResult`, `dailyActuals` inside project records | Read-only history; member identity via `memberId` — untouched |
| Attendance | `AttendanceRecord` (per-day actuals: PRESENT/ABSENT/PAID_LEAVE/...) | **Unchanged.** Planned leave (`leaveRequest`) is a NEW, separate concept; the calendar derives from both |
| Reports | finalized reports freeze activity copies; `ExecutiveSummary`, `DailyProgressPanel`, `useReportsState` | Must keep reading `RcsMember` fields; new profile fields are additive-optional |
| Identity resolution | `src/domain/members/index.ts` centralised resolver; `ExternalIdentity` (JIRA/TestRail) | `RcsMember.id` remains THE identity; new kinds reference `memberId` only |
| Tester filtering | `SV_ONLY_KINDS` + `qaCommitError` | New kinds must be classified (see §6.3) |

### 3.2 Existing working-time model (reconciliation target)

- **One business clock:** `shared/businessTime.ts` — `BUSINESS_TIMEZONE = 'Asia/Tokyo'`, all "today" rules server-side. Per-member/team timezones are explicitly future work.
- **Fixed workday model:** `src/lib/calculations/workday.ts` — 09:00–17:30 with 12:00–13:00 lunch = **7.5 productive hours/day**; per-project start time + overtime (0–180 min); holidays via `settings.holidays` + `src/lib/dates/businessDays.ts`.
- **Capacity today is people-counts, not hours:** `testerCapacitySummary` (`src/domain/testerCapacity.ts`) counts planned/assigned/actual testers; team cases/day from `workdayProductiveHours`.

**Reconciliation decisions:**

1. `workSchedule` templates default to the existing model (Mon–Fri, 09:00–17:30, 60-min break → 7.5h/day, 37.5h/week) so existing capacity math and new hours-based math agree on the default.
2. **Phase 1–3 keep `BUSINESS_TIMEZONE` for all rules** (leave approval "today", expiry processing). Per-member timezone display is P2; per-timezone schedule evaluation is out of the initial scope — flagged as a deviation from spec §3.7, to revisit with the spec owner.
3. The capacity service (§5.1) is NEW pure math over `memberSchedule` + `holidayCalendar` + `leaveRequest` + `capacityAllocation`; it does not modify `workday.ts` (project planning keeps its own model). Both are documented as separate calculi with a shared default.

---

## 4. TM-004 — Migration design (and rollback)

### 4.1 What "migration" means here

- **No SQL migration is needed** for workspace data (new kinds are new rows in the existing `records` table) and none for the registry (untouched). This is the single biggest simplification vs the spec.
- **Data migration = backfill:** create `team` records from `ReportSettings.teams` labels, and one PRIMARY `teamMembership` per active `RcsMember` (matching on the free-text `RcsMember.team`), effective from the member's `startDate`. Unmatched labels create teams named after the label. Runs as a one-time client-side action (SV-triggered, like the existing identity-resolution flows) or lazily on first open of the Team Management screen — **never automatically on load**, and audited via a normal commit with reason `team-backfill`.
- **Backup format stays version 1:** new `ReportsState` arrays (`teams`, `teamMemberships`, ...) are additive-optional; older backups load unchanged; `docs/BACKUP_FORMAT.md` gets a new section listing the new fields.

### 4.2 Rollback story

- **Forward compatibility:** verify (worker test) that an OLD client receiving a snapshot containing NEW kinds ignores them gracefully — `src/lib/sync/records.ts` maps by kind, unknown kinds should be dropped, but this must be proven with a test before release (action item, see §8).
- **Rollback procedure:** redeploy previous worker + frontend; new-kind records remain in `records`/`record_history` and are ignored by the old client; the SV can delete stray records via the existing revision restore if desired. Because backfill is a normal commit, `data.restore` (admin-only) already provides point-in-time rollback.
- **Migration tests (TM-703):** worker tests asserting (a) backfill is idempotent, (b) existing QA/project/report records are byte-identical before/after, (c) old-client-ignores-new-kinds, (d) backup round-trip with new fields.

---

## 5. TM-005 — Domain services and API conventions

### 5.1 Backend services (spec §5 → this repository)

Business logic lives in **pure shared modules** (testable in both vitest suites), orchestrated by `WorkspaceRoom` methods — the established pattern (`createMemberProfile`, `linkMember`, ... all follow it):

| Spec service | Implementation |
|---|---|
| Permanent transfer service | `WorkspaceRoom.transferMember(...)` — validates via `shared/teamRules.ts`, then ONE `commitServerChange('team-transfer', puts, [], actor)` writing the closed old membership + new membership + transfer event **transactionally** (commits are already atomic in `WorkspaceStore.commit`) |
| Temporary transfer & return | same service; writes destination PRIMARY membership + scheduled return membership (effective-dated chain, spec §3.3) |
| Temporary assignment expiry | **daily alarm** — `workspaceRoom.alarm()` already runs daily (`maybeRunRetention` pattern with a per-day flag, `workspaceRoom.ts:727`); add `maybeRunAssignmentExpiry(clock.date)` with the same idempotent flag convention, closing memberships whose exclusive end has passed and marking transfer events COMPLETED |
| Leave approval service | `WorkspaceRoom.decideLeave(...)` — authorization per §2.2(5); approved leave is just a status change (availability is always derived, never stored) |
| Working-hour calculation | `shared/teamCapacity.ts` (pure): minutes between dates from `workSchedule`/`memberSchedule` − `holidayCalendar` reductions − approved `leaveRequest` days |
| Capacity calculation | same module: net available, remaining = net − Σ active `capacityAllocation.hoursPerWeek` (prorated over the range by the member's schedule), utilization %, warning classification (spec §3.8) |
| Team permission validation | `shared/teamAccess.ts` (pure) consumed by routes, room methods and the UI |
| Audit event service | existing: `record_history` (workspace) + `registry.recordMemberEvent` (account-touching); extend `AuditAction` union in `shared/tenancy.ts` with `team.*`, `leave.*`, `transfer.*`, `allocation.*` actions |

### 5.2 API routes (follow `worker/src/routes/tenant.ts` conventions)

REST under `/api/tenant/...`, each with `need(ctx, '<action>')` default-deny check, JSON bodies, `actorOf(principal)` audit actor:

```
GET    /api/tenant/teams                      teams.view (SV)
POST   /api/tenant/teams                      teams.manage
PATCH  /api/tenant/teams/:id                   teams.manage
POST   /api/tenant/teams/:id/archive           teams.manage
POST   /api/tenant/memberships                 assignments.manage (+ canOnTeam)
POST   /api/tenant/memberships/:id/end         assignments.manage (+ canOnTeam)
POST   /api/tenant/transfers                   assignments.manage (dual-approval enforced in room)
POST   /api/tenant/transfers/:id/approve       transfers.approve (scoped)
POST   /api/tenant/transfers/:id/cancel        assignments.manage (scoped)
POST   /api/tenant/leave                       leave.submit (own member only — TESTERS TOO)
POST   /api/tenant/leave/:id/decide            leave.approve
POST   /api/tenant/leave/:id/cancel            leave.submit (own, while PENDING)
GET    /api/tenant/capacity?from&to&team       teams.view (computed, never stored)
GET    /api/tenant/calendar?from&to&team       teams.view (derived events)
```

Read paths (lists, calendar, capacity, analytics) can also be served from the synced workspace state client-side (the whole workspace is already on every SV client via `/ws`); routes are needed only where **authorization is finer than SV** (tester leave submission) or the operation must be server-transactional (transfers). Prefer the existing sync for reads — that is the established convention.

### 5.3 Audit mapping (spec §4.1 `audit_events`)

- Workspace-level changes (memberships, transfers, leave, allocations, schedules): the commit path already records actor, reason, before/after JSON (`record_history` + `revisions`). **No new audit store.** TM-702 is satisfied by making the UI read this history (the member profile "Change History" tab filters `record_history` by `memberId`-bearing kinds).
- Account-touching or cross-team approval events: `registry.recordMemberEvent` with new `AuditAction` values → `admin_audit` (append-only, trigger-enforced).

---

## 6. Frontend integration

### 6.1 Navigation and screens

- **One new `ScreenId`: `teamManagement`** (`src/types/navigation.ts`), in `NAV_ITEMS` after `team`. The spec's 7 areas (Overview, Members, Team Structure, Assignments & Transfers, Calendar & Leave, Capacity Planning, Analytics) become **tabs inside one screen**, following `TestManagementScreen` (overview/scopes/execution/analysis tabs + `useDirectory` hook pattern).
- `SCREEN_ACCESS`: `teamManagement: { sv: 'manage', tester: 'view' }` (Tester sees own assignments + leave request form — spec §3.4 "members can view their own assignments and request leave").
- Feature folder: `src/features/teamManagement/` with one file per tab + a `useTeamManagementState` hook; pure logic in `src/domain/teamManagement/` (or `shared/` where the worker needs it too).
- Lazy-loaded in `App.tsx` like every screen; i18n keys under `tm.*` in **both** `src/locales/*.json` (type-checked parity — ja is default).

### 6.2 Member profile (spec §6 Members page)

Extend `RcsMembersTab` / member profile with the spec's tabs (Overview, Team Assignments, Skills & Roles, Working Schedule, Leave History, Capacity, Change History). New `RcsMember` fields are additive-optional; linked-profile locks (`memberCommitError`) continue to apply.

### 6.3 Tester visibility of new kinds

`SV_ONLY_KINDS` must be extended with `teamTransfer` (approval info). `leaveRequest` needs **per-record** filtering (a Tester sees only their own) — this is a new capability: extend the snapshot/changes filter in `workspaceRoom.ts` (today it is kind-level) with an own-record predicate for `leaveRequest`. `team`, `teamMembership`, `workSchedule`, `holidayCalendar`, `skill` are readable by all (Testers need them for the calendar and their own profile).

---

## 7. Phase plan mapping (spec §8 → this repository)

| Phase | Deliverable in this repo |
|---|---|
| 0 (this doc) | `docs/TEAM_MANAGEMENT_PHASE0.md` (this file) |
| 1 | `shared/teamRules.ts` + kinds in `shared/protocol.ts` + `records.ts` mapping + `RcsMember` extension + `team`/`teamMembership` records + backfill + Members/Team Structure tabs |
| 2 | Transfer services + `teamTransfer` + dual-approval + alarm expiry + Assignments & Transfers tab |
| 3 | `workSchedule`/`memberSchedule`/`holidayCalendar`/`leaveRequest` + leave routes + Calendar & Leave tab |
| 4 | `shared/teamCapacity.ts` + `capacityAllocation` + Capacity Planning tab |
| 5 | Analytics tab (pure derivations from synced state) |
| 6 | Hardening: permission tests, migration tests, e2e, docs (MANUAL.en/ja, ADMINISTRATION, DATABASE, BACKUP_FORMAT updates) |

Gating rules from the spec hold: no analytics before capacity math is verified; no transfer automation before effective-dated memberships + transactional commits (already atomic here) are in place; no member-record migration before this Phase 0 assessment (done).

---

## 8. Open items / risks to resolve before Phase 1 coding

**Resolved 2026-11-05 (decisions):**
1. ✅ **Inclusive vs exclusive end dates** — new kinds follow the spec (exclusive stored end) via `shared/teamDates.ts` (implemented, tested).
2. ✅ **Per-member timezones** — deferred to P2; timezone is a display-only profile field in Phases 1–3.
3. ✅ **Backfill trigger** — SV-triggered dialog with preview (TestRail scope-import idiom); the pure planner is `shared/teamBackfill.ts`.
5. ✅ **Leave types** — settings-embedded (Phase 3).
7. ✅ **`RcsMember.team` free text** — after backfill it is derived; edits move to memberships (legacy attendance/assignment copies stay frozen historical truth).

**Still open:**
4. **`leaveRequest` per-record tester filtering** — needed in Phase 3 (own-record predicate in the snapshot/changes filter).
6. **Forward-compatibility test** — old client vs new kinds (worker test to add with the first release that ships the kinds).

---

## 9. Verification checklist (Phase 0 exit)

- [x] TM-001: member identity, relationships and persistence documented (§1)
- [x] TM-002: current permissions mapped without replacing the authorization model (§2)
- [x] TM-003: project and QA history dependencies documented (§3)
- [x] TM-004: migration design preserves existing records and supports rollback (§4)
- [x] TM-005: domain services and API conventions defined per existing architecture (§5)
- [x] Open items in §8 resolved or explicitly deferred with the spec owner

---

## 10. Phase 1 foundation — implemented (2026-11-05)

The data-layer foundation of Phase 1 is in place; the UI tabs are the next step.

| Piece | File | Notes |
|---|---|---|
| Date semantics | `shared/teamDates.ts` | Half-open helpers: `exclusiveEndOf`, `inclusiveEndOf`, `coversDate`, `periodsOverlap`, `periodIntersection`, conversions. The ONLY place the two conventions meet. |
| Domain records + rules | `shared/teamRules.ts` | All 10 record types, per-record `check*` validators, `teamCommitError` (references, one-PRIMARY-per-date, hierarchy acyclicity, schedule overlap, allocation-within-membership), read-side selectors (`primaryMembershipOf`, `membershipsOn`, `supervisorOf`) |
| Backfill planner | `shared/teamBackfill.ts` | Pure, idempotent `planTeamBackfill` (teams from labels, one PRIMARY membership per member, inclusive→exclusive conversion, code de-duplication) |
| Member profile fields | `src/types/index.ts` | `RcsMember` + `employeeCode`, `jobTitle`, `employmentType`, `employmentStatus`, `timezone`, `defaultWeeklyMinutes`, `adminNotes` (all optional); team record types re-exported |
| Record kinds | `shared/protocol.ts` | 10 new kinds in `RECORD_KINDS` |
| Sync mapping | `src/lib/sync/records.ts` | `ReportsState` arrays + `ORDER` + `ARRAY_FIELDS` + empty-state init for all 10 kinds |
| Server enforcement | `worker/src/workspaceRoom.ts` | `teamCommitError` chained after `qaCommitError` in the commit `rules` hook |
| Tests | `src/test/teamDates.test.ts` (17), `teamRules.test.ts` (30), `teamBackfill.test.ts` (8) | Full suite: 2,707 frontend + 343 + 323 + 16 worker tests pass; tsc, tsc:strict, lint, build clean |

**Not yet done (rest of Phase 1):** ~~the `teamManagement` screen with its tabs~~, ~~the SV-triggered backfill dialog~~, ~~i18n keys~~, ~~`SCREEN_ACCESS` entry~~, and ~~the forward-compatibility worker test~~ — **all completed 2026-11-05** (see §11). Remaining Phase 1 polish: member profile tab extensions (skills, schedule, leave history tabs on the profile), and the MANUAL.en/ja documentation section.

---

## 11. Phase 1 UI — implemented (2026-11-05)

| Piece | File | Notes |
|---|---|---|
| Screen | `src/features/teamManagement/TeamManagementScreen.tsx` | Seven tabs (Overview, Members, Team Structure + four Phase 2–5 placeholders); Overview shows the spec §3.9 dashboard metrics subset |
| Members tab | `src/features/teamManagement/MembersTab.tsx` | Roster with primary team, additional teams (with display periods), status; search + team filter |
| Team Structure tab | `src/features/teamManagement/TeamStructureTab.tsx` | Expandable hierarchy, supervisor, member count, status; create/edit/archive for SVs (validated by `checkTeam` before save) |
| Backfill dialog | `src/features/teamManagement/BackfillDialog.tsx` | SV-triggered preview of `planTeamBackfill` output; apply = one state update (one commit); client-side pre-check of the same rules the server enforces |
| State actions | `src/app/useReportsState.ts` | `upsertTeam`, `upsertTeamMembership`, `upsertTeamSupervisor`, `applyTeamBackfill` |
| Navigation | `src/types/navigation.ts`, `src/app/navigation.ts`, `src/app/access.ts`, `src/app/App.tsx` | `teamManagement` screen id, nav item after Team Members, `SCREEN_ACCESS: { sv: 'manage', tester: 'view' }`, lazy-loaded |
| i18n | `src/locales/en.json`, `ja.json` | ~60 `teamMgmt.*` keys + `nav.teamManagement` in both languages (type-checked parity) |
| Forward-compat fix | `src/lib/sync/records.ts` | `applyRecordChanges` now SKIPS unknown kinds instead of crashing on `FIELD_BY_KIND.get(kind)!` — an old client receiving new-kind records is safe |
| Forward-compat test | `worker/test/team-rules.test.ts` (5 tests) | Store accepts well-formed new-kind records through the production rules hook; rejects malformed/overlapping ones; unknown-kind records are skipped without data loss |

**Verification:** tsc + tsc:strict + lint clean; 2,707 frontend tests (137 files) + 348 + 323 + 16 worker tests pass; production build succeeds.
