# Changelog

Meaningful user-facing and security changes only, newest first. Categories: Added, Changed, Fixed, Security.
The product version is `package.json`; formal releases are tagged `v` + that version (see [docs/RELEASING.md](docs/RELEASING.md)).

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
