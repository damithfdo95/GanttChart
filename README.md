# GanttChart — QA Test Execution Schedule Tracker

A local-first, offline-capable dashboard that answers one question:
**"Are we going to finish testing on time?"**

- Runs 100% locally in the browser — no server, no cloud, no accounts
- Data is stored locally in the browser database (IndexedDB, `GanttChartDB`), with the pre-V6.6 `localStorage` copy retained as a migration fallback, plus user-exported JSON files
- Japanese (default) / English UI switch, fully bilingual
- Zero runtime network requests — works with the network adapter disabled

See [docs/DATABASE.md](docs/DATABASE.md) for the local database architecture:
object stores, the automatic localStorage → IndexedDB migration and how to
add future database schema versions.

## Documentation

| Document | Language | Content |
|---|---|---|
| [docs/MANUAL.en.md](docs/MANUAL.en.md) | English | User manual — setup, every screen's features, data safety, troubleshooting, FAQ |
| [docs/MANUAL.ja.md](docs/MANUAL.ja.md) | 日本語 | ユーザーマニュアル — 起動方法、各画面の操作手順、データの安全、トラブルシューティング、FAQ |
| [docs/DATABASE.md](docs/DATABASE.md) | English | Local database architecture (object stores, migration, recovery) |

## V7: per-day plan windows & daily execution entries

The model separates **PLAN** (entered at project creation, edited in the Gantt
plan) from **EXECUTION** (entered daily on the Dashboard):

```
PROJECT CREATION (New Project form)           DAILY (Dashboard → Today's Execution)
┌─────────── THE PLAN ────────────┐          ┌─────── THE DAY'S EXECUTION ───────┐
│ Daily template: Start · End ·   │          │ Date (today default, past editable)│
│ Overtime · Interval (yes/no) · │          │ Actual Start / End / Overtime ·    │
│ Tester count per planned day    │          │ Interval taken? · Actual testers    │
│ (each Gantt row can override)   │          │ Pass · Fail · N/A · SPO · Blocked · │
└─────────────────────────────────┘          │ Retest / Questioned — for THAT day │
        Gantt = plan editor                  └─────────────────────────────────────┘
                                                  Σ entries = live cumulative totals
                                                  (Completed, Remaining, pace, forecast,
                                                   milestones — all derived)
```

- **Plan windows**: each planning row may override its own Start Time, End
  Time, Overtime (0–180 min) and whether the 12:00–13:00 lunch interval is
  taken. Unset fields fall back to the project defaults; the capacity
  engine, the finish walk, the daily plan and every export honor each day's
  own effective window. `intervalEnabled: false` removes the one-hour lunch
  deduction (9:00–17:30 becomes 8.5 productive hours).
- **Daily execution entries** (`QaInputs.dailyExecuted`) are the single
  source of truth for actuals: one entry per date with the actual time
  window, the actual tester count and that day's status counts. The legacy
  cumulative fields (`casesCompleted`, `casesPassed`, …) become a
  maintained projection — recomputed as Σ entries by
  `syncActualsFromDailyExecuted`/`applyDailyExecutionEntry`, and the
  end-of-day `dailyActuals` snapshots are regenerated from the entries on
  every entry save. Saving today's entry also syncs `currentTesters`
  (still directly editable).
- **Pace uses today's effective window**: when today's entry exists, the
  executive summary, status and recovery baseline use its actual start /
  interval instead of the plan defaults.
- **Migration** (`migrateDailyExecuted`, run at every load/import boundary):
  existing end-of-day snapshots become per-day delta entries (granular
  fields where recorded; a non-attributable completed remainder is preserved
  honestly as `uncategorizedCompleted`, never invented as Fail/N-A/SPO);
  the residual (current totals − latest snapshot) becomes one entry dated
  today; no snapshots at all → a single opening entry. The per-field sums
  are preserved, so every schedule calculation is unchanged after
  migration, and legacy snapshots survive verbatim until the first entry
  save. All existing data/backups import unchanged.

## Shared web version (optional)

The same app can run as a **shared web app** so a team sees the same data live.
Without the backend it is exactly the local-only app described above.

* Design and decisions: [docs/CLOUD_ARCHITECTURE.md](docs/CLOUD_ARCHITECTURE.md)
* The production model, the Cloudflare configuration, the manual rollout and rollback
  steps and the cost ($0 on the Free plans):
  [docs/DEPLOYMENT_PLAN.md](docs/DEPLOYMENT_PLAN.md)

Administration (accounts, workspaces, audit trail, storage modes) is described in
[docs/ADMINISTRATION.md](docs/ADMINISTRATION.md), including the design notes for the next stage of QA-manager features.

How it is organized in short: the site address shows a **public sign-in page** (static, no
data); **Sign in** goes through Cloudflare Access; the application then looks the verified email
up in its own registry. **Cloudflare authentication is not GanttChart authorization:** a verified
person with no GanttChart account sees "no account" and is never added automatically. Accounts
are created only top-down: the configured Super Admin creates Admins, an Admin creates Users
(both limited to the managed organization domains). There is no public registration.

Try it locally (needs Node 22; uses the real Workers runtime, no Cloudflare account):

```powershell
npm run build
cd worker
npm install
npm run dev -- --env dev          # http://127.0.0.1:8787  (local identity, loopback only)
```

Open `http://127.0.0.1:8787` and `http://localhost:8787` — two different browser
origins behave like two people's computers.

Tests: `npm run test` (app, Node 20/22) · `cd worker && npm run test` (Worker unit
tests, the real-runtime Durable Object and WebSocket tests, and the production-configuration
simulation) · `cd worker && npm run typecheck` (needs `npm run build` first because of the
pre-deployment guard) · `cd worker && npm run validate` (guard + deploy dry-run, uploads nothing).

## Requirements

- Node.js 18+ (needed only to build/develop; the built app runs in any modern browser)
- Windows 10/11 primary target; any OS with a modern browser works

## Getting started (development)

```powershell
npm install
npm run dev
```

Then open the printed local URL (e.g. http://localhost:5173). `npm install` needs
one-time network access to download packages; the application itself never does.

## Production build

```powershell
npm run build     # type-checks with tsc, bundles into dist/
npm run preview   # serves dist/ locally, e.g. http://localhost:4173
```

The `dist/` directory contains everything the frontend needs with **relative
asset paths** (`base: './'`). Serve it with any local static file server. Note:
opening `dist/index.html` directly via `file://` is blocked by browsers for ES
modules — use `npm run preview` or any local static server instead. `localhost`
is your own machine, so this still works fully offline.

## Tests

```powershell
npm run test        # single run (Vitest)
npm run test:watch  # watch mode
```

Unit tests cover the pure calculation engine: lunch deduction, required-tester
rounding, expected finish across lunch, productive elapsed time in all day
phases, actual rate with zero elapsed time, status transitions with tolerance,
COMPLETED priority, positive/negative buffer handling — plus the V2 multi-day
suite: absences and clamping, zero-capacity and non-working days, cumulative
capacity, remaining cases by day, projected completion (including lunch
crossing and later-day completion), shortage and extra days, recommended
testers, v1→v2 storage migration, and strict JSON import validation. The i18n
suite covers both English and Japanese rendering: dictionary parity, template
interpolation with variables, locale-aware dates/numbers, bilingual name
fallback, and language-independent calculation explanations. The V3 suite
covers the daily-report module: progress calculations with independent
denominators, business-day and next-business-day logic, SPO-format section
rendering in both languages, draft/finalize/revision snapshots, CSV quoting,
the native XLSX writer (ZIP structure, CRC-32 vector, OOXML parts, frozen
headers and filters), export filters, the management report and the backup
round-trip. The V4 suite covers the portfolio: lifecycle transitions and
history, reopen semantics, planning status derived through the existing
engine, overdue/needs-attention detection, visibility (Active hides Done),
filtering (lifecycle/planning/team/search), sorting, summary counts and the
pre-V4 storage/backup backward compatibility (missing projects fields are
migrated safely). The V4.1 hardening suite covers stable Project ID
generation and duplicate protection, ID backfill migration, lifecycle
transitions and completion-history semantics, named selectors, multi-project
isolation (modify one project → others unchanged by reference), the backup
round-trip equivalence with the full registry, Daily Report project
references and finalized-report immutability, export field coverage and the
documented acceptance scenario. The V5 (Level 2) suite covers the daily plan
generator (AUTO capacity derivation, capping, non-working days, MANUAL
override survival across parameter changes, pass-rate derivation), per-day
and to-date gap analysis (live today actuals, snapshots, future nulls,
zero denominators), the blocking engine (sums by date and category,
effective/lost/available time, utilization, defensive clamps), milestone
evaluation (idempotent stamping, execute/pass routing, progress drop-back,
reference stability), planned/actual absolute-minute math with Tokyo-time
ISO conversion, the executive summary composition (including required
cases/hour with lunch exclusion), Level 2 validation rules and the
pre-V5 import normalization (backfilled defaults, seeded milestones). The V6
suite covers the recovery engine: baseline composition from the existing
engine (exact reproduction of the current projected finish), scenario
capacity (8×4=32 → 10×4=40), lunch-skipping and cross-midnight projections,
additional productive time extending the effective target, blocking
reduction (no-reduction baseline identity, full/partial pace effects),
the recovery gap (lunch-excluded delay content, case conversion), automatic
scenario generation (bounded tester/rate/blocking/overtime steps, preset
purity, best-first ordering, no-recovery reporting) and combined scenarios
flowing through the single capacity/time model.

## Internationalization (i18n)

- **Languages**: Japanese (`ja`, default) and English (`en`). The header
  switcher (`EN | 日本語`) updates the whole UI immediately — no reload.
- **Persistence**: the selected language is stored with the app state in
  `localStorage` (key `ganttchart.v2`). There is no user-profile database in
  this local-only app, so no server-side persistence applies.
- **Resource files**: all UI strings live in `src/locales/en.json` and
  `src/locales/ja.json` (namespaced keys such as `dashboard.title`,
  `status.onTrack`, `errors.testersMin`). Components never hardcode
  translated text; TypeScript enforces that both files define the same keys.
- **Statuses**: On Track / 順調, At Risk / リスクあり, Overdue / 期限超過,
  Capacity Shortage / キャパシティ不足, Completed / 完了, Working / 対応中,
  Not Started / 未着手, On Hold / 保留中.
- **Dates & numbers**: locale-aware via `Intl` — English `Oct 5, 2026`,
  Japanese `2026年10月5日`; numbers use locale grouping. Clock times always
  stay 24-hour (`09:00`, `17:30`). The default timezone is `Asia/Tokyo`.
- **User-generated data** (project names, notes) is never machine-translated.
  Optional bilingual project names are supported (`projectNameEn` /
  `projectNameJa`); when only one exists it is shown in either language.
- **Calculation explanations**: generated from translation templates with
  `{variables}` (e.g. `explanation.shortage`) — sentences are never assembled
  by concatenating translated fragments. Numeric results are identical in
  both languages; only wording and locale formatting differ.

## Architecture

```
React UI (components, features/dashboard)
        │  raw inputs + language (useAppState → localStorage)
        │  current time (useNow, 30s ticker)
        ▼
Pure calculation engine (src/lib/calculations) — no React, no Date.now(), no DOM
        │  derived results
        ▼
Status card / metric cards / timeline / what-if table
```

Key design points:

- **Business-day calendar**: every date calculation (expected/planned finish,
  projections, what-if, capacity tables, daily plan, next business day)
  counts working days only — Saturdays, Sundays and Japanese public
  holidays (incl. 振替休日 substitute holidays and 国民の休日 sandwich days,
  computed purely in `src/lib/dates/businessDays.ts`) always contribute zero
  capacity, and projected finish dates never land on them. The extra holiday
  list in Settings can exclude additional company days for the daily
  report's next-business-day suggestions.
- **Daily overtime (fixed, whole system)**: the per-project input
  `dailyOvertimeMinutes` (0–180) extends every day's productive window to
  17:30 + overtime — including the current day, so the planned finish can
  land today evening. Projections, what-if, capacity tables, the daily
  plan, the executive summary and the recovery baseline are all OT-aware;
  deadline/buffer comparisons stay at 17:30, so overtime always shows as a
  reduced delay ("overtime required"), never as a moved deadline.
- **The anchor day is never dropped**: when a projection runs from NOW and
  today is a business day without a planning row, today's remaining window
  still counts (an implicit working day). Days explicitly flagged
  non-working stay off.
- **All times are minutes since midnight** internally; `"HH:mm"` exists only at
  the UI boundary. This keeps the engine pure integer math.
- **Every calculation function receives `now` as a parameter.** The only impure
  time source is the `useNow` hook, which refreshes ~every 30 seconds and
  cleans up its interval on unmount.
- **Displayed times are floored** to whole minutes for conservative estimates
  (13:00 + 1.125h shows as 14:07). Values past midnight show a `(+1d)`
  annotation.
- **Status hysteresis:** actual progress is compared against expected progress
  with a tolerance of ~5 minutes of team throughput (min 1 case) so the status
  does not flicker due to rounding.
- **Division safety:** calculations return `null` instead of dividing by zero;
  formatters render `—`, so the UI can never show NaN/Infinity/undefined.

## Data & privacy

- Persisted state lives in `localStorage` under the versioned key
  `ganttchart.v2` (raw inputs + language only — no derived data). The daily
  report module (settings, attendance, topics, reports) is stored separately
  under `ganttchart.reports.v1`. Data saved by V1 under `ganttchart.v1` is
  migrated forward automatically on first load, and the old key is then
  removed.
- **Export** writes a JSON file via `Blob` + `URL.createObjectURL`
  (`input type="file"` + `FileReader` for import). Files never leave the
  machine; there is no server, no fetch/XHR anywhere in the codebase.
- **Reset** restores the demo defaults (keeps your language choice). The
  demo data is: 36 total cases, 8 testers, 13:00–17:00, no lunch (both lunch
  fields empty), 4 cases/h/tester, 15 completed / 11 passed — giving 32
  cases/h team capacity, 4 productive hours, 128 cases/day capacity, 3
  required testers, 1.125 required hours, expected finish ≈ 14:07 and 21
  remaining cases.
- No telemetry, no analytics, no cookies, no external assets. The system font
  stack includes Japanese fonts (`Meiryo`, `Yu Gothic UI`, `Segoe UI`).

Exported JSON shape (schema version 2):

```json
{
  "app": "ganttchart",
  "version": 2,
  "exportedAt": "2026-09-17T09:00:00.000Z",
  "data": {
    "totalCases": 36,
    "currentTesters": 8,
    "startTime": 780,
    "targetFinish": 1020,
    "lunchStart": 0,
    "lunchEnd": 0,
    "perHourPerTester": 4,
    "casesCompleted": 15,
    "language": "ja",
    "projectNameEn": "Login Regression Suite",
    "projectNameJa": "ログイン回帰テスト",
    "startDate": "2026-09-17",
    "targetCompletionDate": "2026-09-21",
    "targetCompletionTime": "17:00",
    "planningRows": [
      { "id": "a1", "date": "2026-09-17", "plannedTesters": 2, "absentTesters": 0, "nonWorkingDay": false, "note": "" },
      { "id": "a2", "date": "2026-09-18", "plannedTesters": 2, "absentTesters": 1, "nonWorkingDay": false, "note": "" }
    ]
  }
}
```

(Existing v1 fields keep minutes-since-midnight times; the new planning
fields use `YYYY-MM-DD` dates and an `HH:mm` target time per the V2 schema.
Times are minutes since midnight; an empty lunch is stored as
`lunchStart === lunchEnd` (both `0` in the demo), meaning "no lunch".)

## Project structure

```
src/
  app/                  # App shell, navigation, state providers
  domain/projects/       # project domain: lifecycle, selectors, migrations
  components/           # StatusCard, MetricCard, Timeline, WhatIfTable,
                         # StaffingEditor, PlanCapacityTable, PlanningPanel
  features/dashboard/   # Dashboard composition + hooks (useAppState, useNow)
  features/overall/     # Overall portfolio screen
  features/gantt/       # Gantt screen (project selection + planning detail)
  features/daily-report/  # Daily Report screen + section editors
  features/reports/     # Reports & Export screen
  features/settings/    # Settings screen
  i18n/                 # t() lookup, {var} interpolation, language metadata
  locales/               # en.json / ja.json translation resources
  lib/
    calculations/       # pure engine: capacity, schedule, execution, planning,
                          # localizable explanations, dailyPlan (V5),
                          # blocking, milestones, executive
    projects/           # portfolio: lifecycle, planning status, filters, sort
    reporting/          # daily-report engine: progress, business days,
                          # section renderers, templates, draft lifecycle
    export/             # CSV, native XLSX writer, datasets, management
                          # report, print-to-PDF, downloads
    backup/             # full-data JSON backup / restore
    dates/              # pure YYYY-MM-DD helpers (native Date, no libraries)
    formatting/         # HH:mm, 1h 08m, locale-aware number formatting
    storage/            # versioned localStorage (app + reports) + migrations
    validation/         # §24 input rules + V2 planning validation
    jsonio/             # local JSON export/import envelopes (schema v2)
    id.ts               # local row-id generation
  types/                # domain types
  test/                 # Vitest unit tests
```

- **Timeline chart (V6.1)**: "Daily progress (per project)" is a
  dependency-free inline SVG line chart — horizontal date X axis, numeric
  Y axis derived from the data, one plotted line + points per project in the
  existing color palette, native hover tooltips (date / project / value),
  non-working-day shading and an accessible `role="img"` label. Series are
  aligned **by date** (never by array index) via the pure, tested
  `buildTimelineChartData` transform; missing dates break the line instead
  of becoming misleading zeroes, while planned days with zero cases stay
  real zeroes. The chart scales with its container (900×320 viewBox,
  responsive width, no percentage-height collapse).

## V6: Recovery & What-If Analysis

When QA execution is behind schedule, the Manager view now answers
**"What would it take to recover the target schedule?"** quantitatively.

- **Recovery Analysis panel** (Manager view, above Planned vs Actual):
  current baseline from the existing engine, what-if simulation controls
  (testers, execution rate, blocking reduction, additional productive time),
  scenario result, a visual target/current/scenario chart, the recovery gap
  and a generated "WHY?" explanation with PLAN / ACTUAL / SIMULATION
  context.
- **Pure simulation engine** (`src/lib/calculations/recovery.ts`): the
  scenario model is separate from the project state; every function is
  deterministic (reference time passed explicitly). The untouched scenario
  reproduces the existing engine's projected finish exactly — the default
  scenario rate is anchored to the actual effective per-tester pace, and
  the blocking factor de-rates the pace by the still-expected blocked
  share of elapsed time.
- **Automatic options** ("Find Recovery Options"): a bounded scenario set —
  tester counts (stopping after the first clear recovery), rate steps
  (+5…+30%), blocking reductions (25…100%), overtime steps (15…60 min) and
  a "Balanced Recovery" combination — sorted best-first, with a factual
  no-recovery report when nothing reaches the target.
- **Dedicated recovery tables**: tester scenarios, rate scenarios and
  blocking-reduction scenarios, all data-driven.
- **Apply is explicit**: "Apply Scenario" shows exactly what will change
  (testers and execution rate only — additional time and blocking reduction
  are simulation-only) and requires confirmation before the project state
  is touched. "Reset Scenario" restores the simulation inputs without
  modifying the project.
- Scenario values are temporary React state — nothing is persisted, so no
  storage or export format changed in V6.

## V5 (Level 2): QA management dashboard

The Dashboard gained two presentation modes (`Operator / 管理切り替え`) plus a
management layer — all derived from the same project state (single source of
truth), all offline, all persisted in the existing storages.

- **Executive summary**: a 13-metric strip (totals, remaining, progress %,
  current/required testers, current/required cases per hour, expected /
  projected / target finish, schedule variance, current status) composed by
  `calculateExecutiveSummary` — no business math in React components.
- **Explainable status**: an expandable panel under the status card shows
  execute/pass actual vs planned-to-date, achievement %, today's QA
  unavailable time, projected finish and schedule variance.
- **Planned vs actual Gantt**: the timeline renders a planned-progress
  overlay and a team-capacity chip next to the existing markers.
- **Automatic daily plan** (`generateDailyPlan`): per-day planned
  execute/pass values from the existing capacity engine, capped at total
  cases. Rows are AUTO by default; toggling a row to MANUAL stores an
  override that survives every recalculation and parameter change. The pass
  plan uses a configurable target pass rate.
- **Plan vs actual gap** (`calculateDailyGaps` / `calculateCurrentGap`):
  execute gap, pass gap and achievement % per day and to-date. Today's
  actuals are the live casesCompleted/casesPassed fields; past days use
  end-of-day snapshots ("Record Today's Snapshot" freezes them); future
  days have no actuals yet. A cumulative trend chart visualizes both.
- **QA blocking / lost time** (`lib/calculations/blocking.ts`): categorized
  unavailable-time events (Environment, Build, Test Data, Requirement,
  System Issue, Other). Computes total unavailable, effective QA time, lost
  capacity, available capacity and tester utilization. Existing calculation
  semantics are untouched — these are additive metrics.
- **Milestones** (`lib/calculations/milestones.ts`): configurable Execute /
  Pass % milestones with automatic reach detection (idempotent, stamped
  once), planned date/time, variance and PENDING / REACHED / OVERDUE
  status. The default set seeds Execute 50/80/100 % and Pass 50/80/100 %.
- **Manager view**: daily plan vs actual, trend, blocking analysis,
  milestones and utilization. **Operator view**: the classic live
  execution panels. Both views share one project state.

Level 2 fields (`casesPassed`, `targetPassRate`, `dailyTargetOverrides`,
`dailyActuals`, `blockingEvents`, `milestones`, `dashboardView`) are optional
in every persisted shape and backfilled on load/import/restore, so all
pre-V5 data, backups and export files keep working unchanged.

## V4.1: Multi-project hardening, Project IDs & domain layer

A stabilization and data-integrity pass over the multi-project architecture.
No features were removed or redesigned; existing calculations, bilingual
support, data and backups are fully preserved.

- **Stable Project IDs**: every project has an immutable human-readable
  `projectId` (`PRJ-001`, `PRJ-002`, …), generated at creation/migration by
  scanning existing IDs (never array index, never the name, no reuse of
  gaps). IDs survive backup/restore, are shown in Overall/Gantt selectors
  ("PRJ-001 — Android 4.1.0"), searchable, included in exports, and used for
  project references. Internal `id` (UUID) remains for React keys.
- **Centralized project domain** (`src/domain/projects/`):
  - `lifecycle.ts` — the single implementation of
    `setProjectLifecycleStatus()` / `reopenProject()` / `newProjectRecord()`.
    No screen re-implements lifecycle logic.
  - `selectors.ts` — planning status (delegated to the existing engine),
    overdue/needs-attention, progress/capacity, filters, sorting, summary and
    named selectors (`getActiveProjects`, `getCompletedProjects`,
    `getProjectsByLifecycleStatus`, `getProjectsByPlanningStatus`,
    `getProjectsNeedingAttention`).
  - `migrations.ts` — old single-project migration, `ensureProjectIds`
    backfill and `applyActiveProjectSync` (the only write-back path).
- **Data isolation**: the app state is the editing surface of the *active*
  project; the write-back (`applyActiveProjectSync`) touches only that
  project and returns the same array when nothing changed. Planning
  calculations always use the selected project's own inputs. Dashboard,
  Overall and Gantt share one registry via React contexts — no second store.
- **Lifecycle vs planning (unchanged rules, now enforced in one place)**:
  lifecycle status (`todo`/`ongoing`/`done`) is **manually controlled by the
  user** — 100% progress or a calculated "Completed" never auto-completes a
  project. **Planning status is calculated by the existing planning engine**
  (`derivePlanStatus` / `calculateMultiDayProjection`); "Overdue" is a
  derived deadline flag. "Needs Attention" remains a derived filter
  (At Risk, Capacity Shortage, Overdue, deadline ≤ 7 days, or Ongoing
  without updates for ≥ 14 days).
- **Status history as audit trail**: every transition appends
  `{status, changedAt}`; completion events record `completedAt`/`completedBy`
  and reopening preserves them in history (re-completing adds a new event).
- **Daily Reports reference projects by Project ID** (plus a name snapshot
  in finalized activities), so renaming a project never breaks history.
  Finalized reports remain immutable — verified by tests.
- **Deletion policy**: no permanent project deletion exists by design. Done
  projects are retained, hidden from Active, and reopenable. A future
  archive/delete workflow should protect projects referenced by finalized
  reports.
- **Migration & backup**: pre-registry data seeds one `ongoing` project;
  pre-ID project records get unique `PRJ-xxx` backfilled on load; old
  backups import and migrate immediately (including ID assignment). An
  export → import → export round trip preserves the full registry
  (IDs, names, lifecycle, history, inputs, dates, team, completedAt,
  timestamps) — tested.
- **Exports**: the Projects dataset/worksheet now includes Project ID and
  Capacity; the Daily Reports dataset includes Project ID.

## V4: Overall — portfolio management + Gantt separation

The app now has six screens: **Dashboard | Overall | Gantt | Daily Report |
Reports & Export | Settings**. The key design principle: **Overall answers
"What is the state of all my projects?" while Gantt answers "How is each
project scheduled and executed?"**

### Data model (backward compatible)

- A project portfolio (`projects[]` + `activeProjectId`) lives inside the
  `ganttchart.reports.v1` storage (so it rides along in backups). Each
  `ProjectRecord` carries bilingual names, team, lifecycle status,
  `statusHistory[]`, `completedAt`/`completedBy`, timestamps and its own
  planning inputs — the same shape the Dashboard edits, so **all calculations
  reuse the existing pure engine**.
- **Migration**: on first launch with no projects, the existing single-project
  data is seeded as one project with lifecycle status `ongoing` (safe
  default). Old backups without the new fields import unchanged and are
  normalized on load. No data is lost.

### Two status concepts (never conflated)

- **Lifecycle status** (user-set workflow): `todo` (未着手) / `ongoing`
  (対応中) / `extended` (延長 — the deadline was officially extended; still
  active, measured against the extended target date) / `onHold` (保留 —
  work paused) / `done` (完了). All corrections are allowed, including
  reopening a Done project as any non-done status. Marking Done asks for
  confirmation and stores `completedAt`/`completedBy`; the audit trail stays
  in `statusHistory`. Progress reaching 100% never auto-sets Done.
  **Calculation effects**: On Hold masks the derived planning status to
  "On Hold", suspends the Overdue flag and the Needs Attention filter, and
  contributes zero active team capacity; Extended counts as active with the
  engine running normally against the (extended) deadline. Both have their
  own portfolio summary cards, filters, bulk actions and export labels.
- **Planning/risk status** (calculated): On Track / At Risk / Capacity
  Shortage / Completed via `derivePlanStatus`, plus a derived **Overdue**
  flag (deadline passed). Overall shows both, e.g. "Ongoing | At Risk".

### Overall (全体)

- Summary cards (Total, To Do, Ongoing, Extended, On Hold, Done, At Risk,
  Overdue, Capacity Shortage) — always computed from live data, clickable to
  filter.
- Full project table (all projects, not just the Gantt viewport): lifecycle
  selector per row, Reopen for Done projects, search (EN/JA names + id),
  lifecycle / planning / team / Needs Attention filters, sortable columns
  (default: To Do → Ongoing → Done, then earliest deadline), bulk selection
  with bulk status change (confirmation before bulk Done), per-project team
  assignment, and **Open Gantt**.
- **Needs Attention** filter (a filter, not a status): At Risk, Capacity
  Shortage, Overdue, deadline within 7 days, or Ongoing without updates for
  14+ days.
- Sticky header + sticky project-name column; horizontal scrolling only for
  overflow columns; Derived data is memoized so row interactions stay fast.

### Gantt (ガント)

- Project selector + status filter (Active default / All / To Do / Ongoing /
  Done). Done projects never occupy Gantt space but are never deleted.
- **Schedule overview bars** (usability pass): one horizontal bar per project
  (start date → deadline) with a progress fill, status coloring, a today
  marker line and click-to-select — a real Gantt view over the portfolio.
- Project summary card (name, lifecycle, planning status, start, deadline,
  progress, remaining, testers) + the full multi-day planning panel
  (previously on the Dashboard) for the selected project.
- Collapsible project list: each project expands to its per-day capacity
  rows; the active project edits write straight back to its record
  (`updatedAt` bumps only on meaningful data changes).

### Dashboard integration

The Dashboard gained portfolio summary cards (Active Projects, Ongoing, To
Do, Done, At Risk) that navigate to Overall with the corresponding filter
pre-applied. The detailed planning panel moved to the Gantt screen.

### Exports & reports

- Reports & Export includes a **Projects** dataset (CSV/XLSX/JSON) with
  Lifecycle Status, Planning Status, start/deadline, progress, remaining,
  testers, updated and Completed At; the XLSX workbook gained a Projects
  sheet.
- Changing a project's lifecycle status never touches finalized Daily
  Reports — they remain immutable historical snapshots.

## V3: Daily Report & Data Export module

The app now has six screens (header navigation): **Dashboard**, **Overall**,
**Gantt**, **Daily Report**, **Reports & Export** and **Settings**.

### Daily Report

- **Date selector** (default: today) and **report language selector**
  (English / Japanese). The report language is independent of the UI
  language — UI = English with Report = Japanese (and vice versa) works.
- **Attendance**: per-date records (member, team, status, working start/end,
  leave type, comment). Statuses: Present / Absent / Paid Leave / Half Day /
  Late / Other. The "2/2 PrV members attending" summary per team is
  calculated automatically (teams configurable in Settings; defaults
  PrV + RCS).
- **Today's Activities**: auto-seeded from the live QA plan (Refresh Data)
  and freely editable — include/exclude, reorder, override member counts and
  edit display names. Activities are report-owned copies, so edits never
  modify the original plan data.
- **Today's Topics**: multiline free-text updates (build released, pending
  questions, blocking issues, …).
- **Progress Report**: per-activity Working / Complete percentages with
  explicitly stored, independent denominators (`totalCases`,
  `workingEligibleCases`, `startedCases`, `completedCases`, `blockedCases`,
  `notApplicableCases`) — Working and Complete never assume the same
  denominator. Calculation rules are configurable in Settings.
- **Next Business Day**: suggestions from unfinished work / capacity risk /
  scheduled staffing (weekends and the configured holiday list are skipped),
  plus manual add/remove/reorder.
- **JIRA URLs**: report-level, project-level (Settings) and per-activity
  due links; URLs stay clickable in TXT/PDF exports.
- **Preview & lifecycle**: Generate / Refresh Data / Save Draft / Finalize /
  Copy to Clipboard / Export TXT / Export PDF (browser print) / Export Excel.
  Finalizing stores `finalizedAt` / `finalizedBy` and a full snapshot, so
  historical reports reopen without recalculating. Revised versions are
  created from a finalized report while preserving the original.
- **Templates**: the SPO daily report template (EN/JA) is data, not code —
  editable in Settings with `{active_test_names}`, `{attendance}`,
  `{activities}`, `{topics}`, `{progress}`, `{jira_url}`,
  `{next_business_day}` placeholders.

### Reports & Export

- Filtered exports (date range, team, attendance status) of Attendance,
  Daily Reports, Daily Progress, Execution Logs, WBS/Planning, Tester
  Capacity and Overtime as **CSV**, **XLSX** or **JSON**.
- A full **XLSX workbook** with Summary, WBS, Daily Progress, Tester
  Capacity, Attendance, Execution Logs and Overtime worksheets — bold
  headers, frozen header rows, auto-filters, auto-sized columns, date and
  percentage formats. The .xlsx writer is dependency-free (ZIP + CRC-32
  built in `src/lib/export/xlsx.ts`).
- **Management report** (XLSX + PDF via print): Project, Due Date, Remaining
  Test Cases, Current/Required Testers, Capacity Gap, Predicted Finish,
  Required OT per Tester/Day, Total OT Person-Hours, Risk Status — all from
  the pure planning engine, identical in both languages.
- **Backup & Restore**: one JSON file containing both storages (app state +
  report module). Restore validates the file, warns, requires confirmation,
  and downloads a backup of the current data first. (SQLite is not available
  in a browser-only app, so the JSON full-data backup is the canonical
  format.)

Report module data (including the V4 project portfolio) lives in
`localStorage` under `ganttchart.reports.v1`.

## V2: multi-day QA capacity planning

V2 adds a multi-day planning layer on top of the unchanged single-day
execution dashboard:

- **Daily staffing editor** (日別計画): one row per execution day with date,
  planned testers, absent testers, auto-calculated available testers
  (`max(0, planned − absent)`), a non-working flag and a note. Quick-add next
  day, duplicate last row and per-row remove are supported; changing the plan
  start date shifts the whole plan, keeping day offsets. "Add Next Day" and
  the New Project form only ever create business days (weekends and Japanese
  public holidays are skipped), and rows that fall on one are automatically
  treated as non-working (they show the OFF tag and contribute zero
  capacity).
- **Multi-day capacity table** (日別処理能力): daily capacity, cumulative
  capacity and remaining cases per day, with the projected completion row
  highlighted, non-working days muted and zero-capacity working days flagged.
- **Summary cards**: total planned capacity, remaining cases, projected
  completion date/time, capacity shortage, extra days needed, recommended
  testers for the target, and variance vs the target.
- The plan shares work hours, lunch and per-hour rate with the INPUT section
  and accounts for already-completed cases.

All multi-day logic lives in pure, independently tested functions in
`src/lib/calculations/planning.ts` (no `Date.now()`, no hidden state).
Intraday completion times reuse the v1 lunch-skipping engine. If the listed
days cannot cover the work, no extra rows are fabricated: completion is
`null`, and shortage/extra-days are shown instead.

### Storage / import migration notes

- localStorage moved from `ganttchart.v1` to `ganttchart.v2`. On first load,
  v1 data is migrated forward: all v1 fields are kept, and a single-day plan
  is seeded from the existing inputs (start today, staffing = current
  testers, target = today at the v1 target finish time). The v1 key is
  removed after a successful migration.
- JSON exports use schema `version: 2` and include `startDate`,
  `targetCompletionDate`, `targetCompletionTime` (`"HH:mm"` or `null`) and
  `planningRows`. Imports are validated strictly (negative staffing, invalid
  or out-of-order dates, bad target time, and v1 range violations are all
  rejected). V1 export files are still accepted and migrated on import.
- `availableTesters` is never persisted — it is always derived, so stored
  data cannot drift out of sync.

## Future desktop packaging (Electron / Tauri)

The architecture is deliberately wrapper-friendly:

- All business logic lives in pure TypeScript modules with no browser-API
  coupling; only `storage/` and `jsonio/` touch `window`/`document`/`FileReader`,
  and each is isolated behind small functions that are trivial to swap or shim.
- **Electron:** create a minimal main process that loads `dist/index.html` via
  `win.loadFile('dist/index.html')`. No code changes needed — relative asset
  paths already work from the `file://` protocol.
- **Tauri:** set `frontendDist` to `../dist` (or run `npm run build` as the
  `beforeBuildCommand`). The webview serves the same local files.
- Because there are no network calls, packaged builds stay offline with no
  CSP exceptions beyond local file access.

## Stage 8A: QA test execution management

Test cycles/releases, Tester assignment by user id, execution metrics (Executed, Passed, Failed, Blocked, Remaining,
Pass rate = Passed / Executed), deterministic risk indicators, a manager dashboard, project control center, Tester
workload view and a Daily Report Execution Summary. Details and definitions: [docs/QA_EXECUTION.md](docs/QA_EXECUTION.md).

## Stage 8B: SVs, Testers, Team Members

Two workspace roles: **SV** (manages the workspace; there can be several, one of them the **Owner SV**) and **Tester** (enters their own Today's Execution,
tickets and performance; reads Overall and Gantt). Team Members replaces RCS Members and Team / Testers; History is SV-only and paged; Export / Import /
Reset moved to Settings → Data & Backup; a workspace can have its own tool name. Roles, the permission matrix, the Owner SV rules and the schema upgrade are
in [docs/ADMINISTRATION.md](docs/ADMINISTRATION.md) §1 and §9 and [docs/CLOUD_ARCHITECTURE.md](docs/CLOUD_ARCHITECTURE.md) §17.
