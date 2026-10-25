# Backup file format

A full backup is one JSON file (`ganttchart-backup-<date>.json`):

```json
{ "app": "ganttchart", "kind": "backup", "version": 1, "exportedAt": "<ISO>", "data": { "appState": { }, "reportsState": { } } }
```

- `appState`: the active project's inputs and language. `reportsState`: settings, projects (each with plan, daily execution entries,
  tickets), daily reports (including finalized snapshots and **publication metadata**), attendance, topics, Team Members and
  assignments, Test Management (scopes - with QA **work type** -, cases, results, the append-only `caseExecutions` history), cycles,
  meeting plans/notes, notification definitions, the workspace logo and QA policy.
- **Never included:** JIRA / TestRail connections and credentials (device-local), and notification acknowledgments (per-person state).
- **Daily execution provenance** (`source`: manual / caseExecution / testrail) travels with each daily entry.

## Compatibility rules

- `version` is a whole number checked against the supported list (currently `[1]`). A **newer or unknown version is rejected clearly**,
  never half-read. A payload that is not a GanttChart backup, or fails shape validation, is rejected before anything is written.
- Every field added since version 1 is **optional**, so older backups load unchanged: a finalized report without publication fields
  restores as *Not Published*; a scope without a work type is *Unspecified*; entries without provenance read as *manual*; missing QA
  policy means the default policy. Do not bump `version` for an additive optional field - bump it only for an incompatible change,
  together with a migration in `src/lib/backup/backup.ts`.
- On restore, normalisation fills defaults (stable project ids, identity migration), **drops** records that fail their validators
  (never repairs them silently) and drops damaged publication metadata (the report reads as Not Published).
- Round trip invariant (tested): export → restore into a clean state → export gives the same logical content.
