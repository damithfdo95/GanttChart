# Changelog

Meaningful user-facing and security changes only, newest first. Categories: Added, Changed, Fixed, Security.
The product version is `package.json`; formal releases are tagged `v` + that version (see [docs/RELEASING.md](docs/RELEASING.md)).

## 0.10.0-pilot.5 - responsive left sidebar (tag `v0.10.0-pilot.5` to be created by the owner at release)

### Changed
- **Left sidebar navigation:** a persistent vertical sidebar replaces the top tab strip on desktop. Below 900px it becomes a top bar with a
  Menu drawer (closes on selection or Escape).
- Role-based navigation is unchanged: every destination still comes from the existing access model, and Left Menu Visibility filters the sidebar.
- The sidebar shows the workspace brand (logo with name, or the name alone) and keeps the signed-in workspace, sync and save status visible.
- The EN/JA switch is consolidated into the sidebar (one primary control; the meeting presentation view keeps its own while presenting).
- Accessibility: the current screen is exposed with `aria-current` and marked by a bar as well as colour, with a visible keyboard focus outline;
  long Japanese labels wrap.

### Fixed
- Settings can no longer be hidden from the menu, even if a stored value names it.
- A long Daily Report suggestion no longer widens the page on narrow screens.

## 0.10.0-pilot.4 - Performance tabs, menu visibility, collapsible Settings (tag `v0.10.0-pilot.4` to be created by the owner at release)

### Added
- **Performance screen navigation:** the screen is split into Overview, Per-Tester, Unlinked Testers and Data Management tabs.
  Per-Tester shows one tester's operational view by day, week or month.
- **Unlinked Tester management:** recorded tester names that match no Team Member can be merged into an existing member or used to create one.
- **Left Menu Visibility:** an SV can hide selected menu items for the workspace (`hiddenNavItems`); Settings itself can never be hidden.
- **Collapsible Settings sections** for the rarely used groups; the Support & Pilot panel is kept.

### Fixed
- A malformed stored `hiddenNavItems` value is now sanitised on load instead of surviving as-is; only valid screen ids are kept.

## 0.10.0-pilot.3 - TestRail scope import (tag `v0.10.0-pilot.3` to be created by the owner at release)

### Changed
- TestRail scope import now assigns matched testers automatically, without the extra confirmation click.
- By-tester names are resolved through the linked Team Member first.
- Existing import behavior and permissions are unchanged.

## 0.10.0-pilot.2 - Durable Object read-cost fix (tag `v0.10.0-pilot.2` to be created by the owner at release)

### Fixed
- Optimized WorkspaceRoom commit validation: the scopes, test cases and case-execution history tables are now read once per commit
  instead of once per record, and rows are parsed once. This stops large TestRail imports and bulk commits from generating excessive
  Durable Object SQLite row reads (which count against the free plan's daily limit). No business-rule behavior change.

### Maintenance
- A test fixture that depended on the current date now pins its dates.

## 0.10.0-pilot.1 - pilot baseline (tag `v0.10.0-pilot.1` to be created by the owner at release)

Summary of what the pilot contains, by product area (not every commit):

- **Command Center** - one daily view: situation, readiness, attention items, execution, staffing, allocation, report block.
- **Release readiness** - explainable Ready / At Risk / Blocked with reasons (no score).
- **Staffing model** - Planned, Assigned and Actual testers are separate and labelled as staffing, not attendance.
- **Execution history** - append-only case-execution history, daily summaries from history, controlled reconciliation, provenance on daily figures.
- **Daily Reports** - prepared from operational data, work-type grouping, finalize/revise, and **publishing** (copy plain text / Teams-Slack, export, print, Mark as Published).
- **Improvement Analytics** - throughput, retest, failure, blocked, staffing accuracy, release schedule variance, period comparison (management only).
- **TestRail / JIRA** - TestRail `get_cases` contract fixed, https-only integration addresses, read-only proxies, device-local credentials.
- **Support & Pilot** - Settings section with build info and the Pilot channel, Copy Diagnostics, Report Feedback (copy only), Known Limitations, Error IDs on failed requests.
- **Hardening** - request ids, structured logs, recovery screen for a failing screen, security baseline tests, CI security workflows, SECURITY.md.

### Changed (pilot preparation)
- Deleting a project now says exactly what it removes (scopes, cases, results, history, plans and reports, including finalized and published ones).
- Empty workspace: Command Center, Daily Report and Improvement Analytics explain why they are empty and offer "Create a project".

## Earlier, after v0.9.0

### Added
- **Improvement Analytics** (management only): throughput, unique cases, retest load, failure and blocked trends, staffing plan
  accuracy, completed-release schedule variance, period comparison, "Areas to Review" / "Improved" signals, multi-sheet export.
- **Report publishing**: finalized Daily Reports can be copied (plain text / Teams-Slack ready), exported, printed and marked Published;
  the Command Center distinguishes Finalized from Published.
- **Daily Report preparation** from operational data; **Supervisor Command Center**; **QA work types and QA policy** with work-mix
  and needs-attention views; **explainable release readiness**.
- **Case-level execution history** (append-only), daily summaries from history, and controlled reconciliation with the saved daily total.
- A rendering failure in one screen no longer blanks the app (recovery screen with a short code).
- Security/operations documents: SECURITY.md, architecture overview, recovery procedures, backup format, SaaS readiness assessment,
  release checklist; CodeQL, dependency review, weekly audit, Dependabot, SBOM and licence scripts.

### Changed
- Planned / Assigned / Actual testers are separate concepts; execution provenance is shown on daily figures.
- Worker API errors now carry a stable code and a `requestId`; server logs are structured and content-free.
- README describes both local mode and the shared workspace.

### Fixed
- **TestRail case import used `get_cases/{suiteId}`.** It now uses the documented `get_cases/{project_id}&suite_id={suite_id}`,
  resolving the project from the run or `get_suite`, refusing a suite that belongs to another project, and never importing a case twice.

### Security
- Integration addresses must be `https://` (plain `http://` only for localhost); JIRA/TestRail proxies are read-only and reject encoded
  path traversal. `.gitignore` covers env files, keys and local secrets.

## v0.9.0 - 2026-10-18
Stable pre-SaaS production baseline (shared workspace on Cloudflare Workers + Durable Objects, Access sign-in, SV/Tester roles,
Test Management, JIRA/TestRail integrations, backups and history).
