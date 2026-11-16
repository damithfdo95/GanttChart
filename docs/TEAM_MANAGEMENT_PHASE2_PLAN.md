# Team Management — Full Implementation Plan (Phases 2–6)

**Status:** Plan (produced 2026-11-16). **Phase 1 is complete** (see `TEAM_MANAGEMENT_PHASE0.md` §10–11). This document is the working plan for **all remaining phases** — 2 through 6 — so the whole Team Management module can be delivered end-to-end.
**Scope:** Transfers (P2), schedules/leave/calendar (P3), capacity (P4), analytics (P5), hardening (P6).
**Backlog items covered:** TM-002 (team-scoped permissions), TM-003 (assignment dependencies), TM-005 (domain services and API conventions), TM-407 (leave approval), TM-702 (audit), TM-703 (migration tests).

---

## 0. Phase map (from `TEAM_MANAGEMENT_PHASE0.md` §7)

| Phase | Deliverable | Status |
|---|---|---|
| 0 | Architecture/migration baseline doc | ✅ done |
| 1 | Data layer + Members/Team Structure tabs + backfill + i18n + forward-compat | ✅ done |
| **2** | **Transfer services + `teamTransfer` + dual-approval + alarm expiry + Assignments & Transfers tab** | ⏸️ next |
| **3** | **`workSchedule`/`memberSchedule`/`holidayCalendar`/`leaveRequest` + leave routes + Calendar & Leave tab** | ⏸️ |
| **4** | **`shared/teamCapacity.ts` + `capacityAllocation` + Capacity Planning tab** | ⏸️ |
| **5** | **Analytics tab** | ⏸️ |
| **6** | **Hardening: permission tests, migration tests, e2e, docs** | ⏸️ |

Gating rules (from the spec): no analytics before capacity math is verified; no transfer automation before effective-dated memberships + transactional commits are in place (done in P1); no member-record migration before the Phase 0 assessment (done).

---

## 1. Current state (verified 2026-11-16)

| Piece | Status | Evidence |
|---|---|---|
| Phase-1 foundation | ✅ done | `teamRules.ts`, `teamDates.ts`, `teamBackfill.ts`, sync mapping, screen, Members/Team Structure tabs, backfill dialog, i18n, forward-compat |
| `teamTransfer` kind + service | ❌ | not in `RECORD_KINDS` / `teamRules.ts` / `workspaceRoom.ts` |
| `workSchedule`/`memberSchedule`/`holidayCalendar`/`leaveRequest` kinds | ✅ types + validators exist | `checkWorkSchedule`/`checkMemberSchedule`/`checkLeaveRequest`/`checkHolidayCalendar` in `teamRules.ts`; kinds in `RECORD_KINDS`; sync mapping in `records.ts` — **but no services, routes, or UI** |
| `capacityAllocation` kind | ✅ type + validator exist | `checkCapacityAllocation` in `teamRules.ts`; kind + sync mapping present — **no `teamCapacity.ts`, no UI** |
| `skill`/`memberSkill` kinds | ✅ types + validators exist | `checkSkill`/`checkMemberSkill` in `teamRules.ts`; kinds + sync mapping present — **no UI** |
| Assignments/Calendar/Capacity/Analytics tabs | ❌ placeholders | `TeamManagementScreen.tsx:75` renders `PhaseNote` for all four |
| `SV_ONLY_KINDS` | ❌ not extended | `shared/testerRules.ts:35` lacks `teamTransfer`; no per-record `leaveRequest` filtering |
| `shared/teamAccess.ts` / `canOnTeam` | ❌ | not present |
| `shared/teamCapacity.ts` | ❌ | not present |

**Key insight:** Phases 3–5's *record kinds, types, and validators already exist* from Phase 1. The remaining work is **services, routes, authorization, UI tabs, and tests** — not re-building the data layer.

---

# PHASE 2 — Transfers & Assignments

## 2.1 Objective

Deliver the transfer and assignment lifecycle: `teamTransfer` record kind, transactional `transferMember` service, dual-approval, daily-alarm expiry, and the Assignments & Transfers tab.

## 2.2 Data layer

### `TeamTransferRecord` type (`shared/teamRules.ts`, re-export from `src/types/index.ts`)

```ts
export interface TeamTransferRecord {
  id: string;
  memberId: string;
  fromTeamId: string;
  toTeamId: string;
  changeType: TransferChangeType; // PERMANENT_TRANSFER | TEMPORARY_PRIMARY_TRANSFER | TEMPORARY_SUPPORT | PERMANENT_SECONDARY_ASSIGNMENT
  effectiveDate: string;          // inclusive "YYYY-MM-DD"
  plannedEndDate?: string;        // EXCLUSIVE; set for temporary transfers
  status: TransferStatus;         // DRAFT | PENDING_APPROVAL | SCHEDULED | COMPLETED | CANCELLED
  reason?: string;
  sourceApproverId?: string;
  destinationApproverId?: string;
  createdBy: string;
  createdAt: string;
  completedAt?: string;
}
```

### Registration

1. `shared/protocol.ts` — add `'teamTransfer'` to `RECORD_KINDS`.
2. `shared/teamRules.ts` — add `'teamTransfer'` to `TEAM_KINDS`; add `checkTeamTransfer` + a `case 'teamTransfer'` in `teamCommitError`.
3. `src/lib/sync/records.ts` — `ReportsState.teamTransfers?: TeamTransferRecord[]`, `ORDER`/`ARRAY_FIELDS`/`FIELD_BY_KIND` (`r.effectiveDate ?? ''`), empty-state `teamTransfers: []`.

### Cross-record integrity (in `teamCommitError`)

- `fromTeamId !== toTeamId`.
- No overlapping PRIMARY membership for the member on `effectiveDate`.
- `TEMPORARY_*` requires `plannedEndDate > effectiveDate`.
- Referenced member/team must exist.

## 2.3 Domain services (`worker/src/workspaceRoom.ts`)

### `transferMember(...)`

Validate, then **one** `commitServerChange('team-transfer', [closedOld, newPrimary, transfer], [], actor)` — atomic. Builds:
1. Closed old PRIMARY membership (`effectiveTo = effectiveDate`, `status = 'ENDED'`).
2. New PRIMARY membership (`effectiveFrom = effectiveDate`, `effectiveTo = plannedEndDate` for temporary).
3. `teamTransfer` event (`COMPLETED` for permanent, `SCHEDULED` for temporary).

### Dual-approval

Primary transfers require `sourceApproverId` + `destinationApproverId` filled by authorized users, or an SV admin override with `reason` (audited via commit `reason` + `record_history`). Enforced server-side.

### Daily-alarm expiry

`maybeRunAssignmentExpiry(clock.date)` in `alarm()`, idempotent per-day flag (mirrors `maybeRunRetention` at `workspaceRoom.ts:746`):
- Memberships with `effectiveTo < today` and `status === 'ACTIVE'` → `ENDED`.
- `SCHEDULED` transfers whose `plannedEndDate` passed → `COMPLETED` + `completedAt`.
- Batch via `commitServerChange('assignment-expiry', puts, [], 'retention')` in chunks of 400.
- Expose testable `runAssignmentExpiry(tenantId, nowMs)`.

## 2.4 Authorization

- New `shared/teamAccess.ts`: `canOnTeam(principal, action, teamId, supervisors, date)` — admin or supervisor/lead of the team for the date; truth from `teamSupervisor` records.
- New `Action` members in `worker/src/permissions.ts`: `teams.manage`, `transfers.approve`, `transfers.cancel` (reuse `assignments.manage`).
- `SV_ONLY_KINDS` += `'teamTransfer'` in `shared/testerRules.ts:35`.

## 2.5 API routes (`worker/src/routes/tenant.ts`)

```
POST   /api/tenant/memberships                 assignments.manage (+ canOnTeam)
POST   /api/tenant/memberships/:id/end         assignments.manage (+ canOnTeam)
POST   /api/tenant/transfers                   assignments.manage (dual-approval in room)
POST   /api/tenant/transfers/:id/approve       transfers.approve (scoped)
POST   /api/tenant/transfers/:id/cancel        assignments.manage (scoped)
```

## 2.6 Frontend

- `useReportsState.ts`: `upsertTeamTransfer`, `applyTransfer`.
- `AssignmentsTab.tsx`: memberships list, transfers list, create-transfer dialog (SV), approve/cancel actions.
- i18n keys under `teamMgmt.*` in both locales.

---

# PHASE 3 — Schedules, Leave & Calendar

## 3.1 Objective

Deliver working schedules, leave requests, and holiday calendars: leave routes + approval workflow, per-record tester filtering for `leaveRequest`, and the Calendar & Leave tab. **The record kinds, types, and validators already exist** (`checkWorkSchedule`, `checkMemberSchedule`, `checkLeaveRequest`, `checkHolidayCalendar`).

## 3.2 Leave types (settings-embedded)

Add a configurable `leaveTypes` list to `ReportSettings` (`src/types/index.ts:835`) — small, rarely changes; avoids a new record kind. Defaults: annual, sick, unpaid.

## 3.3 Domain services (`worker/src/workspaceRoom.ts`)

### `submitLeave(...)`

- Authorization: `leave.submit` — a member submits **their own** request (Testers too).
- `approverId` set at submission from the primary-team supervisor of the first leave date (spec §3.5).
- `days` derived from the member's schedule on write.

### `decideLeave(...)`

- Authorization: `leave.approve` — the stored `approverId` OR an admin.
- Approved leave is just a status change (`APPROVED`/`REJECTED`); availability is always derived, never stored.

### `cancelLeave(...)`

- `leave.submit` — own request, only while `PENDING`.

### Schedule/holiday management

- `upsertWorkSchedule`, `upsertMemberSchedule`, `upsertHolidayCalendar` — SV-only (`teams.manage`), validated by the existing `check*` functions.

## 3.4 Authorization & filtering

- New `Action` members: `leave.submit`, `leave.approve`.
- **Per-record `leaveRequest` filtering** (new capability): extend the snapshot/changes filter in `workspaceRoom.ts` (today kind-level) with an own-record predicate — a Tester sees only their own `leaveRequest`. This is the open item #4 from `TEAM_MANAGEMENT_PHASE0.md` §8.
- `team`, `teamMembership`, `workSchedule`, `holidayCalendar`, `skill` remain readable by all (Testers need them for the calendar and their own profile).

## 3.5 API routes

```
POST   /api/tenant/leave                       leave.submit (own member only — TESTERS TOO)
POST   /api/tenant/leave/:id/decide            leave.approve
POST   /api/tenant/leave/:id/cancel            leave.submit (own, while PENDING)
GET    /api/tenant/calendar?from&to&team       teams.view (derived events)
```

## 3.6 Frontend

- `CalendarTab.tsx`: month/week calendar combining `workSchedule` + `holidayCalendar` + approved `leaveRequest`; leave request form (member) + approve/reject (supervisor/admin).
- `useReportsState.ts`: `upsertLeaveRequest`, `upsertWorkSchedule`, `upsertMemberSchedule`, `upsertHolidayCalendar`, `decideLeave`.
- i18n keys under `teamMgmt.*`.

---

# PHASE 4 — Capacity Planning

## 4.1 Objective

Deliver hours-based capacity math and the Capacity Planning tab. **The `capacityAllocation` kind + `checkCapacityAllocation` already exist.**

## 4.2 `shared/teamCapacity.ts` (new pure module)

Pure math over `memberSchedule` + `holidayCalendar` + `leaveRequest` + `capacityAllocation`:

- **Working-hour calculation:** minutes between dates from `workSchedule`/`memberSchedule` − `holidayCalendar` reductions − approved `leaveRequest` days.
- **Capacity calculation:** net available; remaining = net − Σ active `capacityAllocation.hoursPerWeek` (prorated over the range by the member's schedule); utilization %; warning classification (spec §3.8).
- **Default alignment:** `workSchedule` templates default to the existing model (Mon–Fri, 09:00–17:30, 60-min break → 7.5h/day, 37.5h/week) so existing capacity math and new hours-based math agree.
- Does **not** modify `workday.ts` (project planning keeps its own model) — documented as separate calculi with a shared default.

## 4.3 Domain services

- `upsertCapacityAllocation` — SV-only (`capacity.manage`), validated by `checkCapacityAllocation`.
- Capacity is **computed, never stored** — served from synced state client-side.

## 4.4 Authorization

- New `Action` member: `capacity.manage`.

## 4.5 API route

```
GET    /api/tenant/capacity?from&to&team       teams.view (computed, never stored)
```

## 4.6 Frontend

- `CapacityTab.tsx`: per-member/team capacity table (net available, allocated, remaining, utilization, warnings); allocation editor (SV).
- `useReportsState.ts`: `upsertCapacityAllocation`.
- i18n keys under `teamMgmt.*`.

---

# PHASE 5 — Analytics

## 5.1 Objective

Deliver the Analytics tab — pure derivations from synced state. **Gated on Phase 4 capacity math being verified.**

## 5.2 Pure derivations (`src/domain/teamManagement/`)

- Team composition over time (membership counts by team/date).
- Transfer flow (counts by change type, period).
- Leave utilization (approved days by type, period).
- Capacity utilization trends (from Phase 4 math).
- Headcount / active-member trends.

## 5.3 Frontend

- `AnalyticsTab.tsx`: charts/tables from the pure derivations; no new record kinds, no new routes.
- i18n keys under `teamMgmt.*`.

---

# PHASE 6 — Hardening

## 6.1 Objective

Close out the module: permission tests, migration tests, e2e, and documentation.

## 6.2 Tests

- **Permission tests:** every new `Action` (`teams.manage`, `transfers.approve`, `transfers.cancel`, `leave.submit`, `leave.approve`, `capacity.manage`) default-deny; `canOnTeam` scoping; `SV_ONLY_KINDS` includes `teamTransfer`; per-record `leaveRequest` filtering.
- **Migration tests (TM-703):** backfill idempotent; existing QA/project/report records byte-identical before/after; old-client-ignores-new-kinds; backup round-trip with new fields.
- **Forward-compatibility test:** old client vs new kinds (worker test) — the open item #6 from `TEAM_MANAGEMENT_PHASE0.md` §8.
- **e2e:** Assignments & Transfers, Calendar & Leave, Capacity, Analytics flows.

## 6.3 Docs

- `docs/TEAM_MANAGEMENT_PHASE0.md` — mark Phases 2–6 done; add §12+ "implemented" tables.
- `docs/MANUAL.en.md` / `docs/MANUAL.ja.md` — Assignments & Transfers, Calendar & Leave, Capacity, Analytics sections.
- `docs/BACKUP_FORMAT.md` — document new `ReportsState` arrays (`teamTransfers`, `leaveRequests`, `workSchedules`, `memberSchedules`, `holidayCalendars`, `capacityAllocations`, `skills`, `memberSkills`) as additive-optional.
- `docs/ADMINISTRATION.md`, `docs/DATABASE.md` — new kinds, actions, routes.

---

# Cross-cutting concerns

## Verification commands (each phase)

```
npm run tsc && npm run tsc:strict && npm run lint
npm test          # frontend
npm run test:worker
npm run build
```

## Audit mapping (spec §4.1 `audit_events`)

- Workspace-level changes (memberships, transfers, leave, allocations, schedules): already captured by `record_history` + `revisions` (actor, reason, before/after JSON). **No new audit store.**
- Account-touching / cross-team approval events: `registry.recordMemberEvent` with new `AuditAction` values → `admin_audit`.

## Date semantics

All new kinds use the **half-open convention** from `shared/teamDates.ts` (inclusive start, exclusive end, `undefined` = open). UI displays inclusive ends via `inclusiveEndOf`. Never convert by hand.

---

# Task breakdown & dependencies

| # | Phase | Task | Depends on |
|---|---|---|---|
| 1 | 2 | `teamTransfer` type + kind + validators + sync mapping | — |
| 2 | 2 | `WorkspaceRoom.transferMember` service | 1 |
| 3 | 2 | Dual-approval + `shared/teamAccess.ts` + new actions | 2 |
| 4 | 2 | Daily-alarm expiry (`maybeRunAssignmentExpiry`) | 2 |
| 5 | 2 | API routes (transfers/memberships) | 3, 4 |
| 6 | 2 | `SV_ONLY_KINDS` += `teamTransfer` | 1 |
| 7 | 2 | State actions (`upsertTeamTransfer`/`applyTransfer`) | 1 |
| 8 | 2 | Assignments & Transfers tab | 7 |
| 9 | 2 | i18n keys (P2) | 8 |
| 10 | 3 | Leave types in `ReportSettings` | — |
| 11 | 3 | `submitLeave`/`decideLeave`/`cancelLeave` services | 10 |
| 12 | 3 | Per-record `leaveRequest` tester filtering | 11 |
| 13 | 3 | Leave + calendar routes | 11, 12 |
| 14 | 3 | Schedule/holiday management services | — |
| 15 | 3 | Calendar & Leave tab | 13, 14 |
| 16 | 3 | i18n keys (P3) | 15 |
| 17 | 4 | `shared/teamCapacity.ts` (pure math) | 14 |
| 18 | 4 | Capacity route + `upsertCapacityAllocation` | 17 |
| 19 | 4 | Capacity Planning tab | 18 |
| 20 | 4 | i18n keys (P4) | 19 |
| 21 | 5 | Analytics pure derivations | 17 |
| 22 | 5 | Analytics tab | 21 |
| 23 | 5 | i18n keys (P5) | 22 |
| 24 | 6 | Permission + migration + forward-compat tests | 6, 12, 17 |
| 25 | 6 | e2e tests | 8, 15, 19, 22 |
| 26 | 6 | Docs (MANUAL, BACKUP_FORMAT, ADMINISTRATION, DATABASE, PHASE0) | 25 |

**Recommended order:** Phase 2 (1–9) → Phase 3 (10–16) → Phase 4 (17–20) → Phase 5 (21–23) → Phase 6 (24–26).

---

# Risks / open items

- **`leaveRequest` per-record tester filtering** — new capability needed in Phase 3 (own-record predicate in the snapshot/changes filter). Highest-risk item; do it early in Phase 3.
- **Forward-compatibility test** — open item #6; add with the first release that ships the new kinds.
- **Dual-approval UX** — confirm the exact approval flow with the spec owner before finalizing the dialog.
- **Capacity math vs `workday.ts`** — two separate calculi with a shared default; document loudly to avoid drift.
- **Per-member timezones** — deferred to P2 (post-Phase-6); timezone is display-only in Phases 1–5.