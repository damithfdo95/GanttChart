# GanttChart User Manual (English)

A practical guide to this QA management tool — what it does, how to run it, and how to use every screen.

> 日本語版は [MANUAL.ja.md](MANUAL.ja.md) を参照してください。

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Getting Started](#2-getting-started)
3. [Basic Concepts](#3-basic-concepts)
4. [Screen Guide](#4-screen-guide)
   - [Dashboard — Operator View](#41-dashboard--operator-view)
   - [Dashboard — Manager View](#42-dashboard--manager-view)
   - [Creating a Project](#43-creating-a-project)
   - [Overall (Portfolio)](#44-overall-portfolio)
   - [Gantt](#45-gantt)
   - [Daily Report](#46-daily-report)
   - [Tickets](#47-tickets)
   - [Performance](#48-performance)
   - [Review](#49-review)
   - [RCS Members](#410-rcs-members)
   - [Reports & Export](#411-reports--export)
   - [Settings](#412-settings)
   - [Revision History](#413-revision-history)
5. [App-Level Features](#5-app-level-features)
6. [Data Safety](#6-data-safety)
7. [Troubleshooting](#7-troubleshooting)
8. [Tips & Easy-to-Miss Features](#8-tips--easy-to-miss-features)
9. [FAQ](#9-faq)
10. [Glossary](#10-glossary)

---

## 1. Introduction

GanttChart answers one question: **"Are we going to finish testing on time?"**

It is a local-first dashboard for tracking QA test execution — total cases, completed/passed/failed counts, tester staffing, daily pace, and risk status — and for projecting the actual finish date from real team capacity.

Key characteristics:

- **100% offline.** The app runs entirely in your browser and makes zero network requests. All data stays on your machine, in the browser's own database.
- **Bilingual.** The UI switches between English and Japanese instantly. Daily reports can be generated in either language regardless of the UI language.
- **Autosaving.** Every change is saved automatically within moments — there is no Save button for the workspace itself.
- **Multi-project.** Manage an entire QA portfolio: lifecycle statuses, deadlines, progress, capacity and risk, all in one place.
- **Recoverable.** Full JSON backup/restore, a revision history with point-in-time restore, and automatic data-integrity protections.

---

## 2. Getting Started

### Requirements

- **To run the built app**: any modern browser (Chrome, Edge, Firefox). Nothing else.
- **To develop/build**: Node.js 18 or later (needed only to build; the built app runs in any modern browser).

### Development mode

```powershell
npm install    # one-time; needs network access
npm run dev    # starts the dev server (e.g. http://localhost:5173)
```

### Production build

```powershell
npm run build     # type-checks, bundles into dist/
npm run preview   # serves the built app locally (e.g. http://localhost:4173)
```

The `dist/` folder is a complete static site — serve it with any static file server. Note: opening `dist/index.html` directly via `file://` is blocked by browsers for ES modules; use `npm run preview` or any local static server instead.

### For developers

```powershell
npm run test        # Vitest suite (1,200+ tests)
```

The application architecture and local database design are documented in [DATABASE.md](DATABASE.md).

---

## 3. Basic Concepts

### The navigation

The header contains ten screens: **Dashboard | Overall | Gantt | Daily Report | Tickets | Performance | Review | RCS Members | Reports & Export | Settings**, plus the save-status indicator (✓ Saved locally / … Saving / ⚠ Save failed). The language switcher (EN / 日本語) is on the Dashboard header and applies app-wide.

### Plan vs Execution

The model separates two kinds of data:

- **The Plan** (entered at project creation, edited on the Gantt screen): daily staffing, work windows, overtime, target dates.
- **The Execution** (entered daily on the Dashboard): the day's actual time window, actual testers, and status counts (Pass / Fail / N/A / SPO / Blocked / Retest / Question).

Cumulative totals, pace, forecasts and milestones are **derived** from the execution entries — enter the day's results and every calculation updates automatically.

### Operator view vs Manager view

The Dashboard has two modes (toggle in its header):

- **Operator** — for daily execution entry: status, live pace, Today's Execution form, timelines, what-if.
- **Manager** — for analysis: recovery scenarios, plan vs actual gaps, blocking/lost time, milestones.

### Lifecycle status vs planning status

- **Lifecycle status** is *manually* set by you: Scheduled / In Progress / Extended / On Hold / Done. Progress reaching 100% never auto-completes a project.
- **Planning status** is *calculated* from the schedule: On Track / At Risk / Capacity Shortage / Completed, plus a derived Overdue flag (deadline passed).

### Autosave

There is no Save button for the workspace. Changes are saved automatically (about 0.4 s after you stop typing) into the browser database. Destructive operations (delete, reset, import) always ask for confirmation first, and several of them download a backup of the current data automatically before running.

---

## 4. Screen Guide

### 4.1 Dashboard — Operator View

The working surface for the **active project**. Everything below reflects the project selected in Gantt/Overall.

**Status card.** The big colored verdict — Not Started / On Track / Ahead / Delayed / Completed — with Planned Finish, Deadline, Buffer (or Delay), and the current time. Expand **"Why this status?"** to see the evidence: execute/pass achievement, QA unavailable time, forecast finish, variance vs target.

**Executive summary.** A strip of metric cards: Total Cases, Cases Completed, Tested (excl. SPO), Remaining, Progress %, Current/Required Testers, Current/Required Cases per Hour, Planned/Forecast/Target Finish, Schedule Variance — plus an execution breakdown (Pass / Fail / N/A / SPO / Blocked / Retest / Question).

**Portfolio cards.** Active Projects, In Progress, Scheduled, Extended, On Hold, Done, At Risk — click any card to open Overall pre-filtered.

**Input section.** Total Cases, Current Testers, Start Date, deadline (End Date), Cases/Hour/Tester, Daily Overtime (0–180 min). These drive every calculation.

**Capacity section.** Lunch hours, productive hours/day, team capacity per hour and per day.

**Projection section.** Required testers, required hours, planned finish, buffer vs deadline, and the verdict: feasible within target / overtime required.

**Today's Execution form.** The single source of truth for actuals:

1. **Date** — defaults to today; past days stay editable. Use the **Recorded Day** dropdown to jump to any saved day.
2. **Actual Start / Actual End / Actual Overtime (min) / Interval Taken / Actual Testers.**
3. Choose the input mode:
   - **Cumulative totals** (default) — enter totals as of the end of the day; the day's own values are calculated as the difference from the previous day.
   - **Per day** — enter only that day's own counts.
4. Fill the counts: Pass, Fail, N/A, SPO Assigned, Blocked, Retest, Question (plus "Other" for a remainder that fits no status).
5. Press **Save Day**.

Saving recomputes all cumulative totals, regenerates the end-of-day snapshot, and syncs the current tester count.

**Live status / risk strip.** Execution status, actual rate, forecast finish, and open execution statuses (Blocked / Retest / Question chips) or "No open execution statuses".

**Timelines.** An intraday timeline (start / now / expected / projected / target / lunch) and — when the plan spans days — a cumulative multi-day progress chart with a per-project dropdown.

**What-If: Tester Count.** A table of tester counts with the resulting required time and finish. **Click a row to apply that tester count** to the project instantly.

**Export / Import / Reset** (header): export the active project as JSON, import a file, or reset the project's inputs to demo data (confirmation required).

### 4.2 Dashboard — Manager View

Four collapsible analysis panels (Recovery and Daily Progress are open by default):

**Recovery Analysis.** When execution is behind: adjust **Testers**, **Execution Rate**, **Blocking Reduction** and **Additional Productive Time** in the what-if simulation, or use the presets (+1 Tester, +2 Testers, +10% Rate, +20% Rate, −30 min Blocking, Balanced Recovery). The panel shows the scenario's projected finish, a target/current/scenario chart, the recovery gap in minutes and cases, three scenario tables, and a generated "Why?" explanation. **Find Recovery Options** generates a ranked list of scenarios that recover the schedule. **Apply Scenario** writes only the tester count and execution rate to the project (after confirmation); time and blocking adjustments are simulation-only.

**Daily Progress.** Plan vs actual: set the target pass rate, review per-day execute/pass gaps and achievement, and the cumulative trend chart. Each plan row is **AUTO** by default; click the badge to switch a day to **MANUAL** — its planned values become an override that survives every recalculation. Below, the **Daily Execution Entries** table lists every saved day (newest first, paginated) with **Edit** and **Remove** buttons. Editing a past day recomputes all later cumulative totals.

**QA Blocking / Lost Time.** Cards for today's unavailable time, effective QA time, lost capacity, available capacity and tester utilization. **Add Blocking Event**, then categorize (Environment / Build / Test Data / Requirement / System Issue / Other), set minutes and a note. Category totals are shown as pills.

**Milestones.** Define Execute % or Pass % milestones (defaults: 50/80/100 % of each). When a milestone's target is actually reached, its **Actual** time is stamped automatically; the panel shows variance and Pending / Reached / Overdue status.

### 4.3 Creating a Project

On **Overall**, press **Add Project**. The New Project dialog has three sections:

- **PROJECT** — name (required), description, owner, and status (Scheduled / In Progress / Done).
- **TEST PLAN** — total cases, testers, cases/hour/tester, target pass rate.
- **SCHEDULE** — start date, target finish date, daily overtime, daily start/end times, and whether the 12:00–13:00 lunch interval is taken.

A live **Calculation Preview** shows the resulting capacity, required testers, required hours, planned finish and planned days before you commit. Press **Create Project** — the project is stored, activated, and the app navigates to the Dashboard.

### 4.4 Overall (Portfolio)

Answers "What is the state of all my projects?"

- **Nine summary cards** (Total, Scheduled, In Progress, Extended, On Hold, Done, At Risk, Overdue, Capacity Shortage) — clicking a card filters the table.
- **Search** by project name (EN/JA) or Project ID; **filter** by lifecycle status or planning status (including the derived **Needs Attention** view: At Risk, Capacity Shortage, Overdue, deadline within 7 days, or no update for 14+ days); **sort** any column.
- **Bulk actions**: select rows and use **Change Status** (bulk Done asks for confirmation with a completion summary).
- **Per-row actions**: change the lifecycle status (marking Done asks for confirmation), **Open Gantt** to edit the project, export, or delete (confirmation required — no data resurrection afterwards).
- **Done projects** can be reopened as any status; their completion history is preserved.
- **Import / Export All Projects**: import auto-detects full backups, single-project files and legacy exports; each import requires confirmation.

### 4.5 Gantt

Answers "How is each project scheduled and executed?"

- **Schedule Overview** — a real Gantt chart: one horizontal bar per project (start → deadline), progress fill, today marker, status coloring. Click a bar to select the project; hover for details.
- **Project selector + status filter** (Active / All / Scheduled / In Progress / Extended / On Hold / Done).
- **Daily Plan (planning editor)** for the selected project: per-day rows with planned/absent testers, per-row overrides for start/end/overtime/interval, non-working-day flags and notes. **Add Next Day** only ever creates business days (weekends and Japanese public holidays are skipped automatically).
- **Multi-Day Capacity**: daily and cumulative capacity, remaining cases per day, projected completion (highlighted), shortage/extra days, recommended testers, and variance vs target.
- **Project list**: collapsible per-project headers with a read-only per-day projection table for each.

### 4.6 Daily Report

Generates the SPO-style daily report (and the morning report). The **date picker** and **report language** selector (English / 日本語 — independent of the UI language) are in the header, next to the **Daily Report / Morning Report** mode toggle.

**Lifecycle**: visiting a date creates a draft automatically. **Finalize** freezes an immutable snapshot (finalized reports never recalculate). **Edit (create revision)** on a finalized report creates a new draft that supersedes it while preserving the original. The **Report History** table (paginated) lists every draft/finalized/revision with a **View** button.

**End-of-day report sections:**

- **Attendance** — record absences only (members without a record count as attending). Per row: member (RCS member select or free text), status (Absent / Paid Leave / Half Day / Late / Other), working start/end, leave type, comment. Team attendance summaries are calculated automatically.
- **Today's Activities** — auto-seeded from the live QA plan; freely editable. Each row can copy the day's execution counts with **⟳ Copy from execution entries**, and can be reordered. These are report-local copies — editing them never modifies the plan.
- **Progress Report** — read-only progress lines computed from the activities.
- **Today's Topics** — free-text updates (title + description), reorderable.
- **Next Business Day** — auto-suggestions (remaining work, capacity risk, scheduled staffing) plus manual items; business days only.
- **JIRA URL** — report-level; falls back to the project JIRA URL in Settings.
- **Preview**: **Generate**, **Refresh Data** (re-seeds automatic content, keeps manual edits; confirmation required), **Save Draft**, **Finalize** (confirmation), **Delete draft**. The preview text is editable. Then **Copy to Clipboard / Export TXT / Export PDF / Export Excel**.

**Morning report mode**: a **Today's Schedule** section (auto-seeded + suggestions), its own preview, and the same export buttons.

### 4.7 Tickets

Bug-ticket management for the active project.

- Summary cards: Total, This Month, Open, Critical/Major, Closed, Unique Reporters.
- **Add/Edit Ticket**: JIRA ticket key, title, JIRA URL, created date, reporter (RCS member or external), severity (Critical / Major / Minor / Trivial), status (Open / In Progress / Resolved / Closed / Rejected / Duplicate), memo. Duplicate key/URL detection warns you.
- The ticket table (newest first, paginated) has an **Open in JIRA** link, identity hints for reporters, and Edit / Delete actions.

### 4.8 Performance

Tester-level execution analysis for supervisors.

- **Period selector** (Month / H1 / H2 / Year / Custom Range) and project scope; summary cards (Total Testers, Cases Tested, Bugs Found, Active Tester Days, Projects).
- **Tester Performance table**: cases, average/day, pass/fail/blocked/retest, bugs, execution source (Automatic / Assisted / Manual / Manual Override) per tester; **View Details** opens metric cards, bug discovery rate, project breakdown and a monthly trend chart.
- **Tester Attribution — Daily Execution**: enter or correct a tester's daily numbers with the same form used for the project; consistency pills flag any date where the testers' records disagree with the project's daily execution entry. The recorded table (paginated) supports Edit / Remove.
- **Tester Performance Sync**: **Preview Changes** → **Sync Current Project** or sync all projects (confirmation required). Manual entries become "Manual Override" and are never overwritten by sync.
- **Tester Assignments**: add per-tester assignment periods (from/to dates) for the active project; toggle active/inactive; remove.
- **Assisted Allocation**: for each executed day, an attendance-aware suggestion pre-splits the day's counts per assigned tester; every cell is editable, with live validation (over-allocation, overlaps). Edited rows are tagged **Manual override**.
- **Attendance Check**: flags records where attendance says absent but cases are recorded.

### 4.9 Review

The supervisor's periodic tester-review workflow:

1. Pick a **period** and a **tester**.
2. Review the **Objective Metrics**: projects, active days, cases, average/day, bugs, bug discovery rate, status-count breakdown and project contribution.
3. Compare with the **Previous Period → Current Period** table (per-metric deltas).
4. Write **Supervisor Review Notes**: status (Draft / Completed), summary, strengths, improvement, notes — then **Save Review**.
5. **Review History** lists past reviews; **Load this period** re-opens it in the selectors; delete is confirmed and never affects the objective data.

Objective data is evidence only — ratings and bonus decisions stay with the supervisor.

### 4.10 RCS Members

The member master (stable identities behind all records):

- **Member table**: name (the profile id is internal and is never shown), role, start/end dates, Active/Inactive status, and **Name History**. Renaming a member never breaks old records — historical names resolve to the same stable ID.
- **Add / Edit Member** with a name-history editor (validates duplicates and date order).
- **Identity Resolution Center** (appears when legacy, name-based records need attention): review each unmatched or ambiguous name, resolve it to a member individually or in bulk. Ambiguous records are never auto-resolved. A data-quality panel summarizes issues by type.

### 4.11 Reports & Export

- **Filters**: date range and attendance status (apply to report-based datasets).
- **Data Exports**: 15 datasets (Projects, Attendance, Daily Reports, Daily Progress, Execution Logs, Execution History, Bug Tickets, Tester Performance, Tester Daily Detail, Tester Reviews, RCS Members, Tester Assignments, WBS/Planning, Tester Capacity, Overtime) — each as **CSV / XLSX / JSON**.
- **Export Full Workbook (XLSX)**: all datasets as one multi-sheet workbook (frozen headers, auto-filters, formatted dates/percentages).
- **Management Report** (XLSX / PDF): one row per project — due date, remaining cases, current/required testers, capacity gap, predicted finish, required overtime, risk status.
- **Backup & Restore**: **Export Backup** writes the complete workspace (both storages) as one JSON file. **Import Backup** requires confirmation, **automatically downloads a backup of the current data first**, then replaces the workspace with the file's contents.

### 4.12 Settings

- **Supervisor Name** (used as the report author/finalizer) and **Project JIRA URL** (fallback for daily reports).
- **Extra holidays**: one `YYYY-MM-DD` per line; used for next-business-day suggestions (weekends and Japanese public holidays are always excluded automatically).
- **Progress Calculation Rules**: choose the denominators for Working % and Complete %.
- **Report Templates**: editable EN/JA templates for the daily report, with placeholders (`{active_test_names}`, `{attendance}`, `{activities}`, `{topics}`, `{progress}`, `{jira_url}`, `{next_business_day}`); reset to default anytime.
- **Danger Zone**: storage diagnostics (mode, revision, integrity, snapshots, last save), **Download backup**, and **Clear All Local Data** (confirmation + automatic backup download first; wipes everything and reseeds the initial project).

### 4.13 Revision History

(Inside Settings.) Every workspace change is committed as a numbered revision with a reason (edit, import, recovery, project created/deleted, report finalized, …) and a change summary.

- Click any row for a **read-only preview** of what changed.
- **Restore Revision #n** asks for confirmation, then creates a **new** revision whose state equals that point in time. Nothing is deleted — newer history is kept.
- **Export history backup** downloads the retained journal plus the current state.
- The latest 50 revisions are retained locally; integrity is shown as a card (Verified / Warning / Unavailable).

---

## 5. App-Level Features

- **Language switcher** — `EN | 日本語` on the Dashboard header; persists across screens. Report language is chosen independently on the Daily Report screen.
- **Autosave & save status** — the indicator next to the navigation shows ✓ Saved locally / … Saving / ⚠ Save failed at all times.
- **Pagination** — long tables (execution entries, report history, tickets, revision history, tester records, assignments, …) paginate at 10 rows per page with a Previous/Next pager. The pager disappears when everything fits.
- **Confirmations** — every destructive action asks first. Import/restore/clear operations additionally download a backup of the current data before running.
- **Offline** — works with the network adapter disabled. The only external links are the JIRA URLs you enter, which open in new tabs.

---

## 6. Data Safety

**Where your data lives.** In your browser's local database (IndexedDB, database name `GanttChartDB`), with a legacy localStorage copy retained as a fallback. Nothing is ever sent to a server — there is no server.

**Backups.** Use **Reports & Export → Export Backup** (or Settings → Download backup) regularly — it produces one portable JSON file containing the entire workspace. Restore it on any machine or browser via **Import Backup**. Backups are also the way to **migrate between browsers or machines**.

**Recoverable states.** The app maintains a revision journal (latest 50 revisions) and recovery snapshots, so accidental edits can be rolled back via **Settings → Revision History**.

**Clearing data.** Settings → Danger Zone → **Clear All Local Data** removes every GanttChart key and the browser database after a confirmation. A backup is downloaded automatically first. Clearing browser data from the browser's own settings has the same effect but without the safety backup — export first.

---

## 7. Troubleshooting

The app shows plain-language banners at the top when something needs attention:

| Banner | Meaning | What to do |
|---|---|---|
| **"Using local browser storage fallback"** | The browser database is unavailable (e.g. private mode), so data is being saved to local storage instead. | Work continues normally. Close private mode / restart the browser to return to the database. |
| **"Recovery required"** | The browser database was lost and the retained local copy may not contain the latest changes. It has been opened as the best available data. | Review your data. If recent changes are missing, import your latest backup file (Reports & Export → Import Backup). |
| **"Database migration not completed"** (with a reason) | The one-time move from local storage to the browser database failed; data was preserved and migration is retried next start. | Usually resolves itself. If it repeats, export a backup, close all app tabs, clear the site's IndexedDB (browser devtools → Application → IndexedDB → delete `GanttChartDB`), reload, then import the backup if needed. |
| **"Invalid local data detected"** | Some stored data was unreadable; the app started from safe defaults. | The raw data was preserved — use **Export corrupted data**, then restore from your latest backup file. |
| **⚠ Save failed** (indicator) | A save could not be written. | Free disk space / check browser storage limits; the in-app state stays usable. Export a backup from the app menu while it is still in memory. |
| Missing data after switching browsers/machines | Browser storage is per-browser and per-machine. | Use backup files to move data (see Data Safety). |

Golden rule: **keep regular backup files** — they work everywhere, regardless of browser state.

---

## 8. Tips & Easy-to-Miss Features

1. **What-If rows are clickable** — clicking a tester-count row applies it immediately.
2. **"Why this status?"** — expandable panel under the status card shows the full calculation evidence.
3. **AUTO/MANUAL plan badges** — click a day's badge to freeze its planned values as an override that survives recalculation.
4. **Report language ≠ UI language** — e.g. an English UI can produce Japanese reports.
5. **⟳ Copy from execution entries** — per activity row in the Daily Report, pulls the day's canonical counts.
6. **Recorded Day dropdown** — in Today's Execution, jumps to any previously saved day for editing.
7. **Milestones auto-stamp** — actual times are recorded automatically when targets are reached.
8. **Find Recovery Options** — a toggle that generates a ranked list of recovery scenarios when behind schedule.
9. **Done projects are never deleted** — they are hidden from Active and reopenable, preserving finalized-report references.
10. **Export PDF** opens the browser print window — allow popups for the site.
11. **Manager view is a separate world** — don't miss the Recovery/Daily Progress/Blocking/Milestones panels behind the Operator/Manager toggle.
12. **Revision restore is non-destructive** — it always creates a new revision; you can go back again.

---

## 9. FAQ

**Q. Is my data sent anywhere?**
No. The app makes zero network requests. All data stays in your browser.

**Q. Can multiple people share the same data?**
Not directly — data is per-browser. Share data by exchanging backup (JSON) files, or export datasets (CSV/XLSX/JSON) for reporting.

**Q. What happens if I clear my browser data?**
All local app data is deleted. Export a backup first (Reports & Export → Export Backup).

**Q. The UI is in English but I need a Japanese report.**
Daily Report → Report Language selector — independent of the UI language.

**Q. Why is my status "Capacity Shortage" even though we're on track by cases?**
The planning engine compares required vs available capacity per day, not just totals. Check the Multi-Day Capacity table on the Gantt screen.

**Q. I finalized a report and need to fix a typo.**
Open the date → **Edit (create revision)**. The original stays immutable; the revision supersedes it.

**Q. How do I move the app to another machine?**
Copy the project folder (or just serve `dist/`), then move your data via backup files.

**Q. Does it work offline?**
Yes, fully — including all calculations, reports and exports.

**Q. What does SPO mean?**
See the [Glossary](#10-glossary). SPO counts cases handled outside the QA pass/fail flow.

**Q. Can I undo a change?**
Yes — Settings → Revision History → preview and restore any recent revision (creates a new revision, nothing is deleted).

**Q. Weekends/holidays — do I need to mark them?**
No. Weekends and Japanese public holidays (including substitute holidays) are excluded automatically everywhere; you can add extra company holidays in Settings.

**Q. My save indicator says "Save failed".**
See Troubleshooting — free up storage and export a backup while the app is still usable.

---

## 10. Glossary

| Term | Japanese | Meaning |
|---|---|---|
| Capacity | 処理能力 | Cases per hour/day the team can execute given testers, work hours and lunch. |
| Plan | 計画 | Staffing and schedule entered at project creation / edited in Gantt. |
| Execution | 実績 | The day's actual results, entered in Today's Execution. |
| SPO | SPO対応 | Cases handled outside the normal QA pass/fail flow. |
| Blocked | ブロック | Cases blocked from execution by an issue. |
| Retest | リテスト | Cases being re-executed after a fix. |
| Question | 質問中 | Cases pending clarification. |
| Milestone | マイルストーン | A target % of execution or pass, auto-detected when reached. |
| Recovery | リカバリー | A what-if scenario that gets the schedule back on target. |
| Revision | リビジョン | A numbered, immutable history entry of the whole workspace. |
| Lifecycle status | ライフサイクルステータス | The manually-set workflow state (Scheduled / In Progress / Extended / On Hold / Done). |
| Planning status | 計画ステータス | The calculated schedule risk (On Track / At Risk / Capacity Shortage / Completed / Overdue). |
| Needs Attention | 要注意 | Derived filter: at risk, overdue, deadline ≤ 7 days, or stale updates. |
| Finalize | 確定 | Freeze a report as an immutable snapshot. |
| Revision (report) | 改訂版 | A new draft created from a finalized report, preserving the original. |
| Backup | バックアップ | A portable JSON file containing the entire workspace. |
| Attendance | 出席状況 | Per-date member absence records for the daily report. |
| Identity Resolution | 本人特定 | Matching legacy name-based records to stable member IDs. |

---

*Manual version: 1.0 — matches the app version current as of October 2026.*

---

## Roles, Team Members and the menu (shared version)

In the shared (web) version the two roles are **SV** (manages the workspace; there can be several, one is the **Owner SV**) and **Tester**.
The screen list in section 3 is the SV's. The old **RCS Members** screen is now part of **Team Members**; **History** and **Settings** are SV-only;
Export / Import / Reset are under **Settings → Data & Backup**. A Tester sees Dashboard (Operator section and Today's Execution), Projects / Test
Executions (read-only), Gantt (read-only), Tickets, Performance (their own rows) and **My Team Member Profile**. Details: `docs/ADMINISTRATION.md`.


### Stage 8D: Total Test Cases, Team Members and the team meeting

* **Total Test Cases** is typed by an SV on **Test Management -> Scopes**. The project total is the sum of its scopes; you do not have to register every test case. A warning appears if more cases are registered than the total.
* **Team Members** is the one list of people. Add a person with or without a login; create the login later and the same person is linked. SVs can change a role (SV / Tester), remove or reactivate a person.
* **Meeting View** (SV): **Gantt -> Meeting View**, or **Open Morning Meeting / Open Evening Meeting** on the Dashboard. Morning shows today's plan for the whole team; Evening shows plan against actual and lets you prepare tomorrow's plan. **Present** hides the editing controls.
