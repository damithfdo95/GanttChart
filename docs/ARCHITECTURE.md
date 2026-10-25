# Architecture overview

A high-level map. Details: [CLOUD_ARCHITECTURE.md](CLOUD_ARCHITECTURE.md) (design record), [DEPLOYMENT_PLAN.md](DEPLOYMENT_PLAN.md)
(production operations), [DATABASE.md](DATABASE.md) (local database), [QA_EXECUTION.md](QA_EXECUTION.md) (execution model).

```
 Browser (React + TypeScript, Vite)                     Cloudflare
 ┌───────────────────────────────────┐   HTTPS/WS   ┌──────────────────────────────────────────┐
 │ screens ── domain (pure selectors)│◄────────────►│ Worker (index.ts): Access JWT → registry │
 │ local DB (IndexedDB) / sync client│              │  → principal → permission → tenant room  │
 └───────────────┬───────────────────┘              │ RegistryRoom (DO): accounts, tenants     │
                 │ opt-in, device-local credentials  │ WorkspaceRoom (DO, one per tenant):      │
                 ▼                                  │  SQLite record store + revisions         │
        jira-proxy / testrail-proxy ──► JIRA / TestRail └──────────────────────────────────────────┘
```

- **Frontend** (`src/`): screens in `src/features/*`; business logic is pure and lives in `src/domain/*` and `src/lib/*` (readiness,
  supervisor operations, report preparation/publication, improvement analytics, execution history). Components never aggregate.
  The same bundle runs in local mode and in shared mode.
- **Shared rules** (`shared/`): plain TypeScript used by both the browser and the Worker: the sync protocol and its limits, record
  validators, QA rules (`qaRules.ts`), Tester rules, test-management rules, QA policy, report-publication rules, business time (Asia/Tokyo).
- **Worker** (`worker/`): one pipeline per request - origin/CSRF check → authenticate (Cloudflare Access JWT) → resolve principal in
  the registry → tenant guard → named permission → act on the tenant taken from the principal. Static assets are public; only
  `/api/*`, `/ws`, `/login` run the Worker first.
- **Durable Objects**: `RegistryRoom` (platform registry: tenants, users, audit) and `WorkspaceRoom` (one per workspace: opaque JSON
  records by *kind*, a revision journal, live WebSocket sync). The server interprets records only through the shared commit rules.
- **Record sync**: the browser holds the workspace state, commits batches of record puts/deletes against a base revision, and
  receives other people's changes live. Every commit is a revision; history, preview and restore are built on that journal.
- **Role model**: Super Admin (control plane, no QA data), SV (manages the workspace), Tester (assigned work only). See SECURITY.md.
- **Test Management**: scopes → test cases → case results and an append-only `caseExecution` history; daily aggregates can be
  reconciled from case history only by an explicit, previewed SV action.
- **Integrations**: JIRA and TestRail clients run in the browser against a configured address (normally a proxy Worker). Credentials
  are device-local. TestRail case import uses `get_cases/{project_id}&suite_id={suite_id}` (project resolved from the run or
  `get_suite`), paged, idempotent by TestRail case id.
- **Backups**: a versioned JSON file (see [BACKUP_FORMAT.md](BACKUP_FORMAT.md)); integration credentials and notification
  acknowledgments are never included.
