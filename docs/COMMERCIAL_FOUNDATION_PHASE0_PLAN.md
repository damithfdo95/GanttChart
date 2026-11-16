# Commercial Foundation Phase 0 Implementation Plan

**Status:** implementation-ready plan; no code or infrastructure changes are part of this document  
**Prepared:** 2026-11-16  
**Repository baseline:** `v0.10.0-pilot.10`, commit `4355946abf20563b5ff6bc7169bb546e242d2945`  
**Primary roadmap:** [`COMMERCIAL_PRODUCT_AUDIT_2026.md`](COMMERCIAL_PRODUCT_AUDIT_2026.md)  
**Product position:** QA Operations and Release Readiness for Jira-centric manual/hybrid QA teams, supported by professional test execution

## 1. Purpose and Boundaries

This plan turns the audit's recommended Phase 0 into small implementation slices that make the existing platform safe enough for an external pilot. It does not implement the professional repository/run model, attachments, billing, AI, broad integrations or a database rewrite. It preserves the Command Center, Planned/Assigned/Actual staffing, daily reporting, readiness rules, append-only execution provenance, reconciliation, QA Gantt, cross-project views and EN/JA behavior.

The guiding constraint is **minimum safe change**: strengthen boundaries around the working pilot before changing business semantics. Every sub-phase is independently reviewable, tested and reversible. Infrastructure mutations require a separate owner-approved execution task after code and staging evidence exist.

Evidence labels used below:

- **Current:** verified in the repository.
- **Gap:** difference from the commercial audit or external-pilot requirement.
- **Plan:** smallest safe implementation.
- **Decision:** owner approval needed before coding or infrastructure work.

## 2. Repository Baseline and Durable Object Decision

### 2.1 Current architecture

- `worker/src/index.ts` authenticates requests, resolves a server-side principal and routes named permissions.
- `RegistryRoom` is a single control-plane Durable Object. Its SQLite schema in `worker/src/registry.ts` contains tenants, users, credentials, sessions, deletion audit and append-only administrative audit.
- `WorkspaceRoom` is one Durable Object per tenant. Its SQLite store contains tenant records, revisions and commit history; the tenant ID is derived from the verified principal, not trusted from the request.
- WebSockets are bound to the workspace and recheck session validity.
- `jira-proxy` and `testrail-proxy` are separate public Workers. They restrict path/method/upstream and use CORS, but accept any direct caller and relay that caller's authorization header.
- Jira and TestRail credentials live in device-local application settings. They are excluded from shared records and backups, but remain accessible to browser script on that device.
- Backups are user-downloaded JSON files plus revision restore. There is no scheduled operator-controlled SaaS backup to isolated object storage.
- Worker observability is enabled at full head sampling and `worker/src/log.ts` emits structured, content-minimized events. There is no repository-defined metric/alert/SLO contract.
- The only configured environments are the unnamed production configuration and `env.dev`; there is no isolated staging environment.

### 2.2 Why Durable Objects remain sufficient for Phase 0

The external-pilot foundation does not require global analytical joins, millions of cross-tenant rows, or independent high-write domain services. It requires strongly consistent tenant membership, sessions, secret metadata, audit, backup coordination and isolated workspace state. Those match current Durable Object strengths:

1. Registry mutations are serialized and transactional today.
2. Workspace data is already partitioned by stable tenant ID, limiting blast radius.
3. Revision sequencing, optimistic concurrency and restore already depend on the workspace coordinator.
4. Phase 0 organization and membership volume is small and control-plane oriented.
5. Background backup and metrics can use Queues/R2/Analytics Engine without moving primary data.

No Phase 0 domain requires PostgreSQL. A relational database should be reconsidered only when measured requirements demand cross-workspace relational queries, high-volume automation events, search/reporting that would duplicate most DO data, or recovery/scale targets DO SQLite cannot meet. D1 is also unnecessary for this phase: adding it would create a second system of record without solving a current query requirement.

### 2.3 Storage additions within the current architecture

| Need | Smallest storage choice | Reason |
|---|---|---|
| Organization/account/membership control plane | Registry DO SQLite | Transactional with existing sessions/audit; low pilot volume |
| Tenant integration metadata and encrypted credentials | Dedicated non-sync SQL tables in Workspace DO | Tenant isolation; never enters records, revisions, exports or WebSockets |
| Encrypted backup objects and manifests | Private R2 bucket | Large immutable objects, lifecycle and separate recovery plane |
| Backup jobs and delivery retries | Cloudflare Queue | Durable asynchronous fan-out and retry outside request path |
| Operational counters | Workers Analytics Engine plus platform metrics | Time-series aggregation without storing content in tenant data |
| Strict account lockout/lifecycle state | Registry DO SQLite | Global per-account consistency; current design already does this |

## 3. Dependency Order

```text
0A Integration Security
  └─> 0B Edge Protection & Abuse Controls
        └─> 0C Monitoring / Operational Readiness
              ├─> 0D Backups / Recovery
              └─> 0E Organization / Tenant Foundation
                    └─> 0F RBAC / Account Lifecycle
                          └─> 0G Staging / Release Engineering
                                └─> External Pilot Gate
```

0G is designed early but completed last because staging must include the bindings, migrations, limits, telemetry and backup flow introduced earlier. Schema migration discipline begins in 0A and is reused in every phase.

## 4. Cross-Cutting Engineering Rules

1. Existing business records and operational features are not redesigned.
2. Every new table has an explicit numbered, transactional SQL migration. `CREATE TABLE IF NOT EXISTS` is not the migration history.
3. Durable Object class migration tags and internal SQLite schema versions are separate concepts.
4. Every request derives organization/workspace scope from the authenticated principal and stored membership. IDs in URL/body never establish authority.
5. Secrets, tokens and authorization headers never enter logs, audit metadata, ordinary records, revision history, backup payloads or browser responses.
6. External calls use bounded timeouts, bounded response sizes, explicit methods/paths/headers, redirect refusal or validated redirect handling, and stable redacted errors.
7. All production configuration changes are staged and owner-approved in a separate task; this document changes none.
8. EN/JA parity and current differentiated workflows remain release blockers.

## Phase 0A — Integration Security

### Goal

Replace the public CORS relay model and browser-held commercial credentials with authenticated, tenant-scoped, same-origin connector APIs and encrypted server-side credential custody.

### Current state and audit comparison

`jira-proxy/src/worker.js` and `testrail-proxy/src/worker.js` have useful hardening: fixed upstream, path/method allowlists, suspicious-path rejection, minimal forwarded headers, streaming responses and best-effort per-isolate limits. However, direct callers are unauthenticated because CORS only constrains browsers. `JiraIntegration.tsx` and `TestRailIntegration.tsx` hold write-only tokens in device-local settings; browser clients construct upstream authorization. The audit marks both as external-pilot blockers.

### Exact gaps

- No application principal or tenant binding at the proxy.
- Credentials are readable by compromised same-origin browser JavaScript.
- Proxy URLs and upstream instance URLs are client configuration.
- Per-isolate `Map` rate limits are neither durable nor globally meaningful.
- No server-side credential rotation/version/audit model.
- Connector calls are not represented by named permissions or tenant audit events.
- No consistent timeout, response-size, redirect, retry or upstream error policy.

### Smallest safe implementation

Fold the permitted Jira/TestRail operations into the main authenticated Worker. The browser calls same-origin `/api/integrations/{provider}/...`; `index.ts` resolves the principal and tenant before dispatch. A connector service:

1. Loads that workspace's integration metadata and ciphertext from `WorkspaceRoom` through an internal RPC.
2. Decrypts only for the duration of the call.
3. Builds the upstream authorization header inside the Worker.
4. Executes an operation from an explicit operation catalog, not an arbitrary path proxy.
5. Streams a bounded/sanitized response or maps it to a stable application DTO.

Initial operation catalog should match current product use only: Jira connection test/search/issue reads needed by current screens; TestRail connection test, plans/runs/suites/cases/results reads used by existing import/sync. No generic relay and no write/create-defect expansion in Phase 0.

### Files/domains affected

- `worker/src/index.ts`, `worker/src/routes/tenant.ts`, `worker/src/permissions.ts`, `worker/src/http.ts`, `worker/src/log.ts`
- New `worker/src/integrations/{crypto,store,jira,testrail,policy}.ts`
- `worker/src/workspaceRoom.ts`, `worker/src/store.ts` or a dedicated workspace secret store module
- `shared/jira.ts`, `shared/testrail.ts`, new shared redacted DTO definitions
- `src/lib/jira/client.ts`, `src/lib/testrail/client.ts`
- `src/features/settings/JiraIntegration.tsx`, `TestRailIntegration.tsx` and forms
- Backup/storage/security tests that currently assert device-local credential behavior
- Proxy directories remain temporarily for rollback but are marked deprecated and must not be reachable for external pilots.

### Schema changes

Add non-record tables to each Workspace DO, inaccessible to record sync/export/history:

```text
integration_connections
  provider PK              -- jira | testrail
  base_url
  flavor                   -- provider-specific non-secret metadata
  account_label            -- non-secret, optional
  credential_version
  key_version
  ciphertext
  nonce
  created_at / updated_at / rotated_at
  updated_by_user_id
  status                   -- active | disabled | invalid
```

Ciphertext uses AES-256-GCM with a random 96-bit nonce. Additional authenticated data binds schema version, tenant ID, provider and credential version. A Worker secret supplies the key-encryption key for the initial slice. Ciphertext, nonce and key version may be stored; plaintext never is. The final key provider is an owner decision. Use constant-time/cryptographic APIs and generated bindings.

Add migration table `app_schema_migrations(version, name, applied_at)` to Registry and Workspace SQLite stores before applying the integration table migration. Existing schema is recorded as baseline version 1 after structural verification; do not blindly mark an unknown schema.

### API changes

- `GET /api/tenant/integrations` returns redacted status only (`configured`, provider, base host/label, credential version, last test status/time). Never credential material.
- `PUT /api/tenant/integrations/{provider}` accepts base URL plus a new credential over same-origin TLS; Workspace Admin only; request body excluded from logs.
- `POST /api/tenant/integrations/{provider}/rotate` requires a new credential and atomically replaces ciphertext/version.
- `DELETE /api/tenant/integrations/{provider}` disables/deletes credential and records an audit event.
- `POST /api/tenant/integrations/{provider}/test` performs a low-impact operation.
- Operation endpoints are explicit, e.g. `/api/integrations/jira/search`; they accept business inputs, not upstream URLs or authorization headers.

### Security model

- New actions: `integrations.view`, `integrations.manage`, `integrations.use`.
- Workspace Admin manages; authorized workspace users may use only operations required by their existing feature permissions. The server selects the tenant.
- Base URLs: HTTPS only; normalized origin; no credentials/userinfo/fragments; validate allowed ports; resolve/deny loopback, link-local, private and metadata destinations unless an owner-approved Jira Data Center private-connectivity design exists. Revalidate redirects or disable them.
- Only operation-catalog methods/paths; strip inbound cookies/auth/forwarding headers; set provider auth internally.
- Abort timeout, request/response byte ceilings and content-type validation.
- Log provider, operation, tenant pseudonymous/stable ID, duration, status class, reason and request ID—never URL query content, issue text, email, token or response body.
- Rotation is atomic: retain old ciphertext only until a connection test succeeds within the request/transaction; if test fails, preserve old active version. Later background rotation is deferred.

### Migration

There is no safe automatic migration of browser-local credentials because the server cannot retrieve them without deliberately sending them. Existing users see “Reconnect integration securely.” They re-enter credentials once through the new endpoint. Client code deletes legacy local credentials only after the server confirms storage and a test succeeds. If no secure connection exists, integration features fail closed; they never fall back silently to the public proxy.

### Automated tests

- Crypto round-trip; random nonce; AAD tenant/provider mismatch fails; wrong/retired key fails; malformed envelope rejected.
- Plaintext absent from SQLite dumps, sync snapshots, revisions, backup/export, logs, errors and API responses.
- Horizontal tenant access, forged tenant ID and cross-provider credential access denied.
- Role/action matrix for view/manage/use.
- SSRF corpus: localhost, private/link-local/metadata IPs, IPv6 forms, encoded hosts, DNS rebinding policy, userinfo, mixed schemes, redirects and suspicious paths.
- Header allowlist and authorization replacement tests.
- Timeout, size, invalid content type, upstream 401/403/429/5xx and network failure mapping.
- Rotation success, failed-test rollback, delete/revoke and concurrent update tests.
- Frontend reconnect flow, write-only field, redacted status and no legacy fallback.
- Existing Jira/TestRail functional contract tests run against mocked connector responses.

### Acceptance criteria

- No external-pilot browser sends Jira/TestRail credentials to a separate public proxy.
- Direct unauthenticated access cannot invoke any connector operation.
- Credential plaintext exists only in the incoming management request and ephemeral Worker memory.
- Stored credentials are tenant-bound encrypted envelopes with rotation metadata.
- All existing read-only Jira/TestRail workflows operate through same-origin authenticated endpoints.
- Legacy credentials are removed only after confirmed migration; no credential is logged/exported/synced.
- Proxy deployments are disabled or access-blocked before an external pilot through a separate approved infrastructure task.

### Rollback/recovery

Code rollback may restore the old UI only for the internal pilot; external pilots must instead disable integrations. Preserve encrypted rows across rollback. Never re-export credentials to the browser. Rotation failure retains the previous verified envelope. Document emergency provider-token revocation at Jira/TestRail as the authoritative containment action.

### Dependencies

Existing auth/principal/permission pipeline; schema migration runner; owner selection of encryption-key custody and private Jira connectivity policy.

### Owner decisions

1. Worker-secret key ring versus a supported managed key/secrets service for envelope keys.
2. Whether Jira Data Center private network instances are in initial scope; if yes, define approved connectivity rather than weakening SSRF controls.
3. Whether TestRail is allowed for external pilots or temporarily disabled until import-first product direction is finalized.

### Deliberately deferred

Jira write/create-defect, OAuth installation flows, bidirectional TestRail synchronization, arbitrary connector framework, customer-managed keys and automatic secret rotation schedules.

## Phase 0B — Edge Protection and Abuse Controls

### Goal

Add layered, measurable limits around authentication, APIs, WebSockets, integrations, imports/exports and administrative operations.

### Current state and audit comparison

The Worker enforces body/message/record/batch limits, origin/intent checks and per-account password lockout. Proxy Workers use an in-memory best-effort IP map. No application rate-limit binding or repository-defined WAF policy exists. Current production uses a `workers.dev` hostname, which constrains zone-level WAF strategy. Cloudflare's Worker rate-limit binding is approximate and per location; therefore it is a useful abuse layer, not a strict authorization or accounting mechanism.

### Exact gaps

- No coarse pre-Worker edge rules for login/API floods.
- No route/principal/tenant budgets after authentication.
- No WebSocket upgrade and message-rate policy.
- No stable 429 contract, `Retry-After`, metrics or exemption process.
- No documented plan/feature availability check for WAF on the chosen hostname/account.

### Smallest safe implementation

Use three layers:

1. **Edge WAF/rate rules** on a production custom domain for obvious volumetric/path abuse and managed protections. Start in log/simulate mode in staging, then challenge/block where appropriate.
2. **Workers Rate Limiting binding** for route-specific approximate limits keyed by normalized IP before auth and by tenant/user/action after auth.
3. **Strict Durable Object state** only where exactness matters: existing account lockout, credential rotation, backup job idempotency and destructive admin actions. Do not route all traffic through a global limiter DO.

Threshold values are configuration, not hard-coded business logic. Establish them from staging/load observations. Initial categories: sign-in; session/whoami; normal reads; record commits; WebSocket upgrade; integration calls; imports/exports/restores; password/admin changes.

### Files/domains affected

`worker/wrangler.jsonc` (future bindings only), generated Env types, `worker/src/index.ts`, `http.ts`, new `rateLimit.ts`, routes, WebSocket message handling, structured logging, production guard/tests, infrastructure-as-code or an operator-reviewed WAF policy document.

### Schema/API changes

No business schema. Optional Registry table `security_operation_locks` only for idempotent destructive operations if existing audit/session tables cannot express it. API adds a uniform JSON problem response: `rate_limited`, request ID, safe category and `Retry-After`; no disclosure of thresholds that assists credential attacks.

### Security model

Limits supplement authentication/authorization. Keys use hashed/truncated identifiers where telemetry must not expose emails/session IDs. Trusted support/admin users are not globally exempt; higher limits are explicit and audited. Failures of the approximate limiter should be fail-soft for normal reads but fail-closed for high-cost integration/import actions according to a tested policy.

### Migration

None for tenant data. Roll out staging → production log-only → enforce. Record false positives and tune before external users.

### Automated tests

Route-category mapping; key isolation by tenant/user/IP; correct 429 and `Retry-After`; limits before expensive body/upstream work; WebSocket upgrade/message handling; account lockout unaffected; no bypass via query/case/encoded paths; fail-open/closed policy; generated config/guard validation. Add load tests that demonstrate behavior without claiming global exactness.

### Acceptance criteria

- Every public dynamic route belongs to a reviewed limit category.
- Login, connector, import/export/restore and WebSocket abuse produce observable bounded behavior.
- WAF/rate policies are tested in staging and documented as external configuration.
- No legitimate production smoke workflow is rate-limited under expected concurrency.
- Security events distinguish edge/app/account enforcement without sensitive identifiers.

### Rollback/recovery

WAF rules have documented IDs, previous expressions and log-only fallback. Application thresholds are configuration with safe defaults. Emergency rollback disables the faulty rule/limit category, not authorization or body limits.

### Dependencies

0A route catalog; custom-domain/WAF decision; 0C event names should be designed concurrently.

### Owner decisions

Production custom domain and Cloudflare plan/features; challenge versus block policy; acceptable integration/import quotas; whether Turnstile is justified for password login after measuring abuse.

### Deliberately deferred

Usage billing, per-plan commercial quotas, advanced bot management, API Shield/mTLS and global strict request accounting.

## Phase 0C — Monitoring and Operational Readiness

### Goal

Make failure, abuse, tenant impact and recovery needs visible before customers report them.

### Current state and audit comparison

Observability is enabled with full sampling. `logEvent` emits JSON events and request IDs while attempting to exclude content. Release/support screens expose build identity. There are no repository-owned metric definitions, dashboards, alert thresholds, uptime probes, escalation records or demonstrated incident process.

### Exact gaps

- Logs are events, not a documented operational telemetry contract.
- `safeError` can include arbitrary exception messages and needs a sensitive-data review.
- No RED metrics (rate/errors/duration) by route class, integration health, queue age, backup status, auth anomalies, DO storage size or WebSocket lifecycle.
- No alert ownership, severity, runbook links, deduplication or test procedure.
- No external synthetic check of public/login/authenticated paths.

### Smallest safe implementation

Define a low-cardinality event/metric catalog. Keep detailed request correlation in Workers Logs; write aggregated counters/distributions to Analytics Engine (or current supported equivalent) with provider/route class/status class/environment, not customer content. Use Cloudflare platform/DO metrics for CPU, errors, duration and storage. Add external uptime checks for public landing, auth boundary and a staging synthetic tenant. Export logs/traces to an external destination only if retention/query/alert needs cannot be met natively.

Minimum alerts:

- Sustained 5xx/error-rate and latency breach.
- Authentication failure/lockout spike.
- Permission/tenant-mismatch spike.
- Connector failure/429/timeout burst by provider.
- Queue backlog/oldest message age and dead-letter events.
- Backup missed/failed/restore-verification failed.
- Workspace/Registry storage-size threshold.
- WebSocket upgrade or abnormal-close spike.
- Deployment/smoke failure and uptime failure.

### Files/domains affected

`worker/src/log.ts`, request context in `http.ts/index.ts`, auth/routes/connectors/workspace/registry events, new `metrics.ts`, Wrangler observability/Analytics binding configuration, docs runbooks and synthetic test scripts/workflows.

### Schema/API changes

No product schema. Optional small Registry `operational_job_status` table for last successful backup/maintenance job where correctness cannot depend on log retention. No customer-facing metrics API in Phase 0.

### Security model

Pseudonymous stable tenant ID is allowed only in restricted operations telemetry; never include email, token, URL query/JQL, test content, attachment names, request bodies or decrypted upstream responses. Security logs and product audit are separate. Redact at source; do not rely solely on downstream filters. Define retention and operator access.

### Migration

Introduce new event names alongside current logs; provide a mapping/deprecation window. Dashboard and alerts start in staging. No historical backfill.

### Automated tests

Event schema/allowed-field snapshots; forbidden-key and secret canary tests; safe exception mapping; metric cardinality bounds; request ID propagation; connector/limit/backup event tests; synthetic probe tests; alert-rule evaluation using fixture metrics; test alert routing without production paging.

### Acceptance criteria

- An operator can determine environment, route class, status, request ID and affected tenant ID without seeing customer content.
- Every minimum alert is demonstrated in staging and links to a runbook.
- A named owner/backup owner and severity/escalation policy exist.
- Uptime checks run independently of the Worker and detect a simulated outage.
- Retention/access/redaction are documented and reviewed.

### Rollback/recovery

Telemetry failures must not fail normal product requests; use `waitUntil` for non-critical post-response writes. Disable a noisy metric/export binding without removing structured error logs. Alert rules are versioned/exported before changes.

### Dependencies

Stable route/event catalog from 0A/0B; owner selection of monitoring destination/on-call mechanism.

### Owner decisions

Native Cloudflare-only versus external observability provider; retention; paging channel/on-call owner; initial internal SLO targets.

### Deliberately deferred

Customer-facing status analytics, full distributed tracing across arbitrary providers, SIEM product integrations and contractual SLA.

## Phase 0D — Scheduled SaaS Backups and Recovery

### Goal

Provide encrypted, scheduled, tenant-isolated backups with verified restoration, while preserving customer JSON export as portability rather than treating it as disaster recovery.

### Current state and audit comparison

Workspace revisions support point restore; browser backup files are versioned and round-trip tested. `WorkspaceRoom.exportAll` can produce a tenant snapshot. DO alarms perform retention housekeeping, not fleet backup. Registry/control-plane state lacks a scheduled export. Backups depend on a user/device and do not establish an operator RPO/RTO.

### Exact gaps

- No scheduled fleet inventory/fan-out, immutable object manifest, encryption separation or retention.
- No control-plane backup of organizations/accounts/memberships/audit/secret ciphertext metadata.
- No isolated restore drill or restoration approval workflow.
- Revision history shares the same failure domain as current workspace data.
- No missed-job/backlog alert or recovery runbook.

### Smallest safe implementation

Use a scheduled Worker trigger to ask Registry for active workspace IDs and enqueue one job per workspace plus one control-plane job. A Queue consumer obtains a consistent snapshot through DO RPC, produces a versioned backup envelope, encrypts it with a backup key distinct from integration/session keys, writes to a private R2 bucket using an immutable key, and writes a manifest/checksum. Jobs are idempotent by `{environment, tenant, scheduledDate, schemaVersion}`. A dead-letter queue captures terminal failures.

Restoration is a separate explicit command/API available only in staging initially. It decrypts into a new scratch workspace, validates envelope/schema/hash/counts/references, and never overwrites production by default. Production restore requires owner SV approval plus platform operator action, a pre-restore backup and append-only audit event. Super Admin does not gain routine content browsing.

### Files/domains affected

Worker scheduled/queue entry points, Registry/Workspace export RPCs, new `worker/src/backup/*`, R2/Queue bindings, schema/envelope shared types, production guard, recovery docs and tests.

### Schema changes

Registry tables:

```text
backup_jobs(id, scope_type, scope_id, scheduled_for, status, attempt,
            object_key, checksum, schema_version, started_at, completed_at, error_code)
restore_requests(id, tenant_id, requested_by, approved_by, backup_key,
                 status, created_at, expires_at, completed_at)
```

Keep backup job metadata content-free. Backup envelope versions are independent of product and SQL schema versions.

### API changes

No general customer restore API in the first slice. Workspace Admin may view last backup status and request recovery. Operator tooling lists manifests and initiates validation/restore using stable IDs. All operations are idempotent and audited.

### Security model

Private R2 binding only; no public bucket. AES-GCM envelope encryption with a backup key/key version distinct from integration keys. Object keys use non-secret IDs and dates, not workspace names/emails. Restore authorization is two-party for production; tenant and destination are checked server-side. Define retention/lifecycle and deletion on tenant termination with legal hold exception. Logs contain checksums/counts/status, not payload.

### Migration

No current files are uploaded automatically. First scheduled backup establishes baseline after schema validation. Historical browser backups remain customer files. Registry and workspace snapshot readers must support the current schema before enabling scheduling.

### Automated tests

Snapshot consistency under concurrent commits; encryption/AAD/wrong-key/tamper checks; idempotent queue retry; duplicate schedule; dead-letter; tenant/object-key isolation; manifest/hash/count validation; old/new envelope compatibility; scratch restore round trip; production-overwrite refusal; approval expiry; backup-before-restore; retention and tenant-deletion behavior; secrets absent from backup.

### Acceptance criteria

- Every active pilot workspace and the Registry have scheduled encrypted backups in private R2.
- Missed/failed jobs alert and retry; terminal failures reach a monitored dead-letter queue.
- A randomly selected backup restores into an isolated workspace and matches recorded hash/counts.
- Documented measured RPO/RTO are based on a drill, not aspiration.
- Production restore cannot occur through a single unreviewed action.

### Rollback/recovery

Disable scheduler/consumer while preserving immutable objects/manifests. Queue messages are idempotent. A bad backup release does not delete previous objects. Backup format readers remain backward-compatible; restore code fails closed on unknown versions.

### Dependencies

0C metrics/alerts; schema migration runner; owner-approved R2/Queue/key configuration in a later infrastructure task.

### Owner decisions

Backup frequency/retention and target RPO/RTO; key custody; legal hold/deletion policy; approval actors; data region.

### Deliberately deferred

Customer self-service production overwrite, continuous PITR claims, cross-region disaster failover and enterprise custom retention.

## Phase 0E — Organization and Tenant Foundation

### Goal

Introduce explicit `Organization → Workspace → Project` boundaries without moving workspace QA records or changing current workflows.

### Current state and audit comparison

Current `Tenant` is effectively a workspace. A user row belongs to exactly one tenant and email is globally unique. Projects are records inside a workspace. Super Admin creates workspaces and accounts. There is no organization entity, multi-workspace membership or organization-scoped ownership/settings.

### Exact gaps

- Customer/legal/billing boundary is conflated with workspace.
- User/account identity is conflated with one workspace membership.
- No organization owner/admin lifecycle or multi-workspace future path.
- APIs and DTOs use tenant terminology inconsistently with product workspace language.

### Smallest safe implementation

Add Organization and global Account identities to Registry while preserving existing tenant IDs as Workspace IDs. External pilot supports one organization with one or more workspaces, but no cross-workspace analytics. Projects remain inside Workspace DO records. The migration creates one organization per existing tenant, one account per current unique email and one workspace membership per current user. Existing IDs remain stable; do not rewrite QA records.

### Files/domains affected

`shared/tenancy.ts` (new organization/account/workspace DTOs while retaining compatibility aliases), Registry schema/store/room, principal resolution, sessions, super/tenant routes, frontend tenant context and Super Admin/workspace screens, audit/tests/docs.

### Schema changes

```text
organizations(id, name, status, created_at, updated_at)
accounts(id, normalized_email UNIQUE, display_name, status, created_at, updated_at)
workspaces(id, organization_id FK, name, status, storage_mode, owner_membership_id, ...)
organization_memberships(id, organization_id, account_id, role, status, ...,
                         UNIQUE(organization_id, account_id))
workspace_memberships(id, workspace_id, account_id, role, access, status, ...,
                      UNIQUE(workspace_id, account_id))
```

Keep existing `tenants`/`users` tables during a compatibility window. Add mapping columns/tables and dual-read verification before switching principal resolution. Do not destructively rename SQLite tables in the first migration. Sessions migrate from `user_id` to `account_id` plus selected workspace membership; old sessions may be deliberately revoked at cutover rather than ambiguously mapped.

### API changes

Introduce organization/workspace resource vocabulary under versioned internal endpoints while keeping current endpoints during migration. `whoami` returns account, organization, current workspace and scoped roles. Workspace selection is server-validated against membership. No arbitrary organization/workspace header establishes access.

### Security model

Organization IDs and workspace IDs are server-generated. Principal resolution joins active account → active organization membership → active workspace membership → active workspace. Every reference must agree. Super Admin remains outside customer organizations and sees metadata only. Cross-workspace operations do not exist in Phase 0.

### Migration

1. Preflight invariants: normalized unique emails, valid tenant owner, no orphan users/sessions.
2. Backup Registry.
3. Create new tables transactionally.
4. Backfill one organization per tenant; accounts/memberships with deterministic mapping record.
5. Compare old and new principal/permission decisions in tests and optional shadow logs.
6. Revoke old sessions at controlled cutover if session dual-read cannot be proven.
7. Switch reads, retain old tables read-only for one release, then remove only in a later migration.

### Automated tests

Migration fixtures for every existing lifecycle/status/owner/session combination; idempotent rerun; mapping counts; duplicate email; cross-org/workspace membership denial; disabled account/org/workspace; workspace selection; Super Admin content denial; session cutover/revocation; API compatibility; backup/restore of new control plane.

### Acceptance criteria

- Every current workspace maps to exactly one organization with the same functional access after migration.
- Account identity is independent of workspace membership.
- No client value can select a workspace without an active stored membership.
- Existing QA records, revisions, Gantt/readiness/report behavior and EN/JA output are unchanged.
- Migration is tested from a production-shaped sanitized Registry snapshot and has count/invariant verification.

### Rollback/recovery

Before read cutover, roll back code and ignore additive tables. After cutover, restore Registry backup or deploy compatibility reader; never partially reverse rows. Session revocation is acceptable and documented. QA Workspace DO data is untouched.

### Dependencies

0D control-plane backup and tested restore; schema runner; product terminology decision.

### Owner decisions

Whether one account may belong to multiple customer organizations in initial scope; organization naming/ownership rules; whether existing Tenant IDs remain externally visible as Workspace IDs; invitation domain restrictions for external pilots.

### Deliberately deferred

Cross-workspace reporting, organization billing, organization-wide custom settings, data residency routing and mergers/transfers between organizations.

## Phase 0F — RBAC and Account Lifecycle

### Goal

Extend the existing centralized default-deny authorization into organization/workspace/project scopes and define safe onboarding, disablement, recovery and support access.

### Current state and audit comparison

`worker/src/permissions.ts` is a strong central action map: Super Admin, admin/SV and user/Tester with editor/viewer access. Record-level shared rules enforce assignments and role restrictions. Super Admin is control-plane only. Account creation is operator/SV managed; native password reset and Access/password auth exist. There is no organization role, project role binding, customer invitation/verification flow, session/device UI or time-limited support access.

### Exact gaps

- Roles are coupled to legacy internal names and one workspace.
- No scoped policy input or organization-level administration.
- No explicit invitation acceptance/expiry or customer-owned onboarding.
- Recovery relies on platform/SV actions; support access consent is not modeled.
- Custom role pressure could lead to scattered checks if the capability vocabulary is not stabilized first.

### Smallest safe implementation

Keep named actions and default deny. Change policy input to authenticated account plus active organization/workspace memberships and optional project context. Phase 0 built-ins:

- Organization Owner: organization lifecycle and admins; no automatic workspace content.
- Organization Admin: members/workspaces/security settings; content access only through workspace membership.
- Workspace Admin (current SV): current SV capabilities.
- Workspace Member Editor/Viewer (current Tester access levels).

Reserve QA Manager/Lead/Tester/Viewer product roles for the professional execution phase; do not invent incomplete distinctions now. Maintain display aliases so current SV/Tester UX does not change.

Add invitation records with single-use hashed tokens, expiry, intended email/organization/workspace/role, issuer and status. Acceptance requires authenticated matching email and creates memberships transactionally. Disablement revokes all sessions and WebSockets. Add a user-visible session list/revoke-all-later only if achievable without expanding scope; at minimum record session metadata safely and allow admin/account revoke-all.

Support access is not a hidden Super Admin role. Model a customer-approved grant with scope, purpose, operator identity, start/expiry and revocation; default is no content access. Phase 0 may implement metadata-only diagnostics and documented screen-share/export support while deferring content grants.

### Files/domains affected

Permissions/principal/registry/session/auth/tenant/super routes, tenancy types, frontend onboarding/account/admin screens, WebSocket disconnect logic, audit actions, email delivery adapter or manual invitation-link handoff for pilot, tests/docs.

### Schema changes

```text
invitations(id, organization_id, workspace_id, normalized_email,
            role, token_hash, status, expires_at, created_by, accepted_at)
support_grants(id, organization_id, workspace_id, requested_by, approved_by,
               operator_account_id, scope, purpose, starts_at, expires_at,
               revoked_at, status)
```

Extend session metadata with created/last-seen/expiry and safe device label only if privacy-reviewed. Audit invitations, membership/role changes, disablement, recovery and support-grant transitions.

### API changes

Organization/workspace membership and invitation endpoints with named permissions; accept/revoke invitation; revoke account sessions; request/approve/revoke support grant. Responses never expose token hashes or password/session secrets. Email delivery can be deferred for a controlled pilot, but invitation tokens must still be transported out-of-band securely and never logged.

### Security model

Policy checks action + scope + resource relationship, not UI navigation. Owner cannot grant content support access silently. Invitation tokens have high entropy, stored only as hashes, single-use and short expiry. Email normalization is consistent. Role changes and disablement close live sockets and invalidate sessions. Recovery never reveals account existence publicly. Every sensitive lifecycle event is audited.

### Migration

Map current admin to Workspace Admin and current user editor/viewer to Workspace Member. Existing owner becomes workspace owner; organization owner is an explicit backfill decision, normally the current owner SV account. Preserve stable user attribution through account mapping.

### Automated tests

Exhaustive action × built-in role × scope matrix; unknown action deny; horizontal/vertical escalation; membership mismatch; project reference mismatch; invite expiry/replay/email mismatch/role tampering; owner protection/transfer; session and WebSocket revocation; support grant consent/expiry/revocation; Super Admin content denial; audit completeness/redaction.

### Acceptance criteria

- All routes and RPCs map to a named action and scope.
- Existing SV/Tester behavior remains equivalent after role migration.
- Invitation, disablement, recovery and ownership transitions are transactional, audited and revoke active access promptly.
- Platform operators cannot browse workspace content without an explicit unexpired customer-approved grant; if content grants are deferred, there is no operator content path at all.
- Automated authorization matrix is a release blocker.

### Rollback/recovery

Additive role/membership tables and compatibility mapping permit code rollback before legacy table removal. If a policy regression occurs, disable new onboarding and restore prior code; never grant broad fallback access. Owner recovery uses audited transfer, not direct database edits.

### Dependencies

0E identity/membership model; 0C security events; email/provider decision only if automated invites are in slice.

### Owner decisions

Initial identity strategy (continue Access/password for pilot versus OIDC now); who becomes organization owner; invitation delivery; whether any content support grant is allowed in external pilot; recovery proof requirements.

### Deliberately deferred

Custom roles, SAML, SCIM, group sync, project-specific roles, native MFA and enterprise delegated administration.

## Phase 0G — Staging, Release Engineering and Schema Discipline

### Goal

Create operationally separate local/CI/staging/production environments and ensure one immutable release identity connects source, artifact, migrations and deployment.

### Current state and audit comparison

CI is strong: typecheck, strict TypeScript, ESLint, frontend tests, Chromium smoke, Worker core/runtime/prod-sim, dependency audits, CodeQL and SBOM workflow. Production deployment is manual with a robust configuration guard and dry-run. `wrangler.jsonc` has `dev` but no staging. Frontend assets are rebuilt immediately before deploy; version/tag/Cloudflare Version ID are manually correlated. Internal SQLite schema setup is mostly implicit/idempotent rather than a numbered migration ledger.

### Exact gaps

- Production doubles as the only real remote environment.
- Staging needs separate Worker name/hostname, DO namespaces/classes, R2, Queues, secrets, Access/OIDC application and test accounts.
- CI produces verification but not a single promoted deploy artifact/manifest.
- No automated migration compatibility test from all supported schema versions.
- Infrastructure settings are not represented as a reviewable environment matrix/IaC plan.

### Smallest safe implementation

Define four environments:

- Local: Miniflare/Wrangler dev with synthetic identities/resources only.
- CI: ephemeral runtime tests/prod simulation; no customer services.
- Staging: persistent isolated Cloudflare resources and synthetic data; closest safe production parity.
- Production: customer data; manual approval and exact release artifact only.

Create explicit Wrangler environment configuration with no shared stateful binding IDs/resources. Store only non-secret configuration in source; environment secrets are provisioned independently. Generate a release manifest containing product version, commit, tag/release, build time, schema compatibility range and artifact hashes. CI builds/tests once and retains immutable assets/bundle/SBOM/manifest. Deployment consumes the approved artifact or deterministically verifies its hash before upload. Record Cloudflare Version ID against the manifest.

Adopt numbered Registry and Workspace SQL migrations with `from/to`, transaction, invariant check and compatibility tests. A deployment must be backward compatible with the current schema during rollout; destructive cleanup occurs only in a later release after rollback window. Preflight reports pending migrations without exposing data.

### Files/domains affected

Wrangler environment config/templates, production guard, package scripts, GitHub workflows, build-info generation, migration modules/tables, release docs, staging smoke and recovery docs. Actual Cloudflare resources/settings are created only in a separate approved task.

### Schema/API changes

Migration ledger already introduced in 0A. Add `schemaCompatibility` to internal diagnostics/support response, not public unauthenticated output. Release manifest format is versioned. No business API behavior changes.

### Security model

No production secrets/data in staging or CI. GitHub environments use least-privilege credentials and production approval. Pin third-party actions to commit SHAs. Enable secret scanning/push protection where available. Artifact provenance/checksum is verified. Production deploy identity has only required Worker/resource permissions. Migrations fail closed before partial data writes.

### Migration

Bootstrap staging from synthetic/sample data, never a raw production copy. Baseline current schemas only after structural verification. Test every migration from sanitized production-shaped fixtures. Production order: backup → compatibility preflight → deploy backward-compatible code → apply/observe additive migration → smoke → later cleanup release.

### Automated tests

Config isolation and binding-name tests; no production IDs/secrets in staging; release manifest version/tag/commit/hash consistency; build reproducibility/digest verification; migration forward/idempotency/interruption/unknown-version tests; old-code compatibility during rollback window; staging smoke; production dry-run; action pin checks and secret-pattern canaries.

### Acceptance criteria

- Staging and production share no DO/R2/Queue/secrets/identity resources.
- The exact tested artifact/manifest is the one approved and deployed.
- Settings show version, tag and commit matching the manifest; deployment records Cloudflare Version ID.
- Every SQL change is a numbered tested migration; unknown/future schemas fail safely.
- Production deployment requires successful staging smoke, backup status and explicit approval.
- Rollback procedure is rehearsed without crossing an irreversible migration.

### Rollback/recovery

Use the previous immutable Worker version/artifact. Additive schema remains readable by old code during the defined rollback window. Never attempt destructive reverse migrations in an incident. Restore from 0D only for data corruption, not routine code rollback.

### Dependencies

All prior bindings/schemas/routes sufficiently stable; repository/security settings owner access; staging Cloudflare resources and credentials in a separate task.

### Owner decisions

Custom domains for staging/production; deployment authority/approver; artifact storage/retention; GitHub Actions versus manual promotion; rollback window; supported schema compatibility window.

### Deliberately deferred

Per-PR stateful preview environments, multi-region production, blue/green data migrations, automated production deployment without approval and enterprise change-management tooling.

## 5. Schema and Migration Strategy Summary

Three versions must remain distinct:

1. **Product version** (`package.json`/Git tag): buyer-visible release.
2. **Durable Object class migration tag** (`wrangler.jsonc`): Cloudflare class/storage-class evolution.
3. **Application SQL schema version** (migration ledger per Registry/Workspace DO): tables/indexes/data transitions.

Backup envelope version is a fourth compatibility contract. A product release declares supported Registry schema range, Workspace schema range and backup envelope range. Migrations are forward-only, transactional and idempotent; rollback means running compatible prior code or restoring a pre-migration backup, not automatically reversing destructive SQL.

## 6. External Pilot Definition of Done

Every item is binary. An unchecked item blocks inviting a real external organization.

### Product and tenancy

- [ ] Product position, pilot ICP, data handled and excluded features are documented in the pilot agreement.
- [ ] Organization, workspace and account/membership boundaries are explicit and migrated without changing current QA semantics.
- [ ] Tenant IDs are always derived/validated from authenticated membership across HTTP, WebSocket, export, backup, audit and integration paths.
- [ ] Super Admin remains metadata-only; support content access is absent or customer-approved/time-limited/audited.

### Authentication and authorization

- [ ] Every dynamic route/RPC has a named default-deny permission and scoped policy test.
- [ ] Horizontal, vertical, IDOR, disabled-account, revoked-session and WebSocket isolation suites pass.
- [ ] Invitation/onboarding, owner transfer, disablement and recovery revoke sessions/sockets and produce redacted audit events.
- [ ] Authentication method and recovery process for the pilot are owner-approved and documented.

### Integrations and secrets

- [ ] Jira/TestRail credentials are encrypted server-side, tenant-bound, rotatable and absent from browser storage, logs, sync, exports and backups.
- [ ] No unauthenticated public proxy can relay requests for the pilot.
- [ ] Connector operation/path/header/redirect/timeout/size and SSRF policies pass automated tests.
- [ ] Provider token revoke/rotation incident runbook is tested.

### Abuse and application security

- [ ] Edge and application rate limits cover login, APIs, WebSockets, connectors, imports/exports/restores and admin actions.
- [ ] Limits were observed/tuned in staging and return a stable 429 contract.
- [ ] WAF/managed-rule/custom-domain plan is implemented and recorded, or an owner-approved compensating control exists.
- [ ] CSRF/origin/session/XSS/SSRF/injection/secret-redaction security regressions pass.
- [ ] No known Critical/High dependency or code-scanning issue is open without a time-bounded accepted exception.

### Operations and recovery

- [ ] Local, CI, staging and production are isolated; production is not used for testing.
- [ ] Structured logs/metrics and all minimum alerts are demonstrated in staging with named responders/runbooks.
- [ ] Independent uptime checks and incident severity/communication paths exist.
- [ ] Scheduled encrypted Registry and workspace backups run to private R2 and failures alert.
- [ ] A sampled backup restored successfully into isolation with verified hash/counts; measured RPO/RTO are recorded.
- [ ] Tenant export/deletion and pilot termination procedures are documented.

### Release and governance

- [ ] CI, security, migration, browser and staging-smoke gates pass for the exact immutable release artifact.
- [ ] Product version, tag, commit, artifact hash and Cloudflare Version ID are traceable and agree.
- [ ] SQL migration compatibility and rollback window are tested; pre-deploy backup is current.
- [ ] Privacy notice/pilot terms, subprocessors/data location, support/security contact and IP permission are owner-approved.
- [ ] Supported browsers, EN/JA parity, accessibility baseline and current differentiated workflows pass smoke testing.

## 7. First Paid Customer Definition of Done

External Pilot Definition of Done plus:

- [ ] Billing provider, plan/seat entitlement, trial, cancellation, invoice/tax responsibility and failed-payment behavior are implemented and reconciled.
- [ ] Customer self-service export/deletion/termination and documented retention complete within committed timeframes.
- [ ] Secure evidence/attachment storage exists if included in the paid offer; otherwise it is contractually excluded.
- [ ] Professional repository/run/version model prevents case edits from altering historical executions.
- [ ] Migration tooling provides dry run, mapping, idempotency, validation report and recovery for the promised source formats.
- [ ] Public support hours, severity targets, status communication and vulnerability remediation SLAs are documented and operational.
- [ ] Backup/restore drills and incident exercises have been repeated; RPO/RTO/support claims match evidence.
- [ ] Legal terms, privacy policy, DPA, subprocessors, APPI/GDPR obligations and security questionnaire baseline are reviewed by qualified owners/advisers.
- [ ] Independent penetration test covers auth, tenancy, integrations, APIs, uploads if present, billing and platform admin; Critical/High findings are closed or formally risk-accepted with deadlines.
- [ ] Onboarding reaches first value with documented guidance and does not require database/operator edits.
- [ ] Production monitoring, capacity/quota alerts, customer support ownership and on-call coverage match the paid promise.

## 8. Architecture Decisions Required Before Coding

Only these decisions block the first slices:

1. **Integration key custody:** versioned Worker-secret key ring or a selected managed key/secrets service. This determines the encrypted envelope interface.
2. **External integration scope:** Jira Cloud only, Jira Cloud + Data Center, and whether TestRail is enabled for external pilots. Private Data Center support changes SSRF/connectivity design.
3. **External hostname/edge plan:** custom domain and Cloudflare plan/features available for WAF/rate rules. `workers.dev` alone is not an adequate unexamined assumption.
4. **Initial identity path:** preserve Access/password through the pilot or introduce customer OIDC in Phase 0F. Organization/account migration must not encode a discarded identity model.
5. **Organization membership:** whether one account may belong to multiple organizations initially. Schema should support it unless explicitly prohibited.
6. **Backup policy:** region, frequency, retention, key owner and initial RPO/RTO target. These determine R2 lifecycle and job design.
7. **Support access policy:** metadata-only for external pilot, or explicit time-limited content grants. Default recommendation is metadata-only.
8. **Environment/deployment authority:** who can provision staging, approve production and hold operational credentials.

PostgreSQL, billing provider, AI provider, SCIM, data residency productization and professional run-model details do not block Phase 0A and should not delay it.

## 9. Recommended First Implementation Prompt

The first slice should build the server-side encrypted credential foundation and authenticated connector skeleton, but migrate **Jira connection test and search only**. TestRail and the remaining Jira operations follow after this pattern is reviewed. This keeps the security-critical change small.

```text
Implement Commercial Foundation Phase 0A.1: encrypted tenant-scoped Jira credentials and authenticated same-origin Jira connection-test/search routes.

Primary specification:
- docs/COMMERCIAL_FOUNDATION_PHASE0_PLAN.md, Phase 0A
- docs/COMMERCIAL_PRODUCT_AUDIT_2026.md

Scope constraints:
- Do not implement TestRail in this slice.
- Do not remove or deploy the existing jira-proxy; mark no external infrastructure state.
- Do not change business-domain semantics, QA screens, readiness, staffing, reports, Gantt, execution history or reconciliation.
- Do not add PostgreSQL, D1, billing, attachments, AI, OAuth or organization hierarchy.
- Do not push, deploy, tag or change Cloudflare account configuration.

Required implementation:

1. Add a numbered, transactional Workspace DO SQL migration mechanism.
   - Introduce an application schema migration ledger distinct from Wrangler Durable Object migration tags.
   - Baseline the current Workspace schema only after verifying expected tables/indexes.
   - Add a dedicated integration_connections SQL table outside the ordinary record/revision/sync model.
   - Unknown/future schema versions must fail safely.

2. Add an integration credential crypto module.
   - AES-256-GCM using WebCrypto.
   - Fresh 96-bit random nonce for every write.
   - AAD must bind envelope version, tenant ID, provider `jira`, and credential version.
   - Store ciphertext, nonce, key version and credential version; never plaintext.
   - Read the active key from a generated Worker Env secret binding selected by an explicit key version configuration.
   - Do not hardcode or print key material.
   - Malformed envelope, wrong tenant/provider/key and authentication failure must fail closed with stable non-sensitive errors.

3. Add WorkspaceRoom RPCs for Jira connection management.
   - Admin-only access remains enforced at the Worker route layer; RPC also asserts tenant ID matches its object.
   - Upsert is atomic and increments credential version.
   - Read returns only redacted connection metadata and encrypted material only to the internal connector call path; no browser DTO may contain ciphertext/nonce.
   - Delete removes/disables the connection and must be idempotent.
   - Integration data must not appear in exportAll, record snapshots, revisions, WebSockets, Shared History or tenant backup payloads.

4. Add named permissions and authenticated same-origin APIs:
   - `integrations.view`, `integrations.manage`, `integrations.use`.
   - `GET /api/tenant/integrations/jira` returns redacted state.
   - `PUT /api/tenant/integrations/jira` accepts normalized Jira base URL, flavor/email as applicable and a new token over same-origin TLS; Workspace Admin only.
   - `DELETE /api/tenant/integrations/jira` is Workspace Admin only.
   - `POST /api/tenant/integrations/jira/test` uses the stored credential.
   - `POST /api/integrations/jira/search` accepts the existing bounded JQL/search inputs, not a URL/path/header.
   - Tenant is derived from the verified principal. Reject any conflicting tenant identifier.
   - Maintain existing origin/intent/CSRF behavior and size limits.

5. Add a Jira connector service inside the main Worker.
   - Permit only HTTPS Jira origins.
   - Reject URL credentials, fragments, invalid ports, loopback, link-local, private-network and metadata destinations for this first Jira Cloud slice.
   - Restrict host to the approved Jira Cloud pattern decided by the owner; do not create an arbitrary HTTP proxy.
   - Explicit operation catalog: connection test and search only.
   - Build Authorization internally from decrypted credentials.
   - Forward only required headers; never cookies or caller Authorization.
   - Do not follow redirects unless the redirect target is revalidated and remains the same approved origin; safest initial behavior is redirect error.
   - Add request timeout, bounded upstream response handling and content-type validation.
   - Map provider failures to stable redacted error codes. No JQL, token, email, response body or upstream query string in logs.

6. Update the Jira frontend/client only enough to use the same-origin APIs.
   - Token remains write-only and is sent only on save/rotate.
   - Saved state shows configured/redacted status; never prefill or return token/ciphertext.
   - Connection test and existing Jira search use the main Worker routes.
   - Do not silently fall back to the legacy proxy or local token.
   - On first use with legacy settings, show a clear EN/JA “Reconnect securely” state. Do not automatically transmit or delete the local token.
   - After a successful secure save/test, explicitly remove the legacy local Jira token and proxy URL while preserving non-secret preferences needed by the UI.

7. Add content-free audit/log events.
   - Audit configured, rotated, removed and test outcome; metadata contains provider, credential version and safe status only.
   - Operational logs contain event, request ID, tenant ID, operation, duration/status class/reason only.
   - Add tests with token/email/JQL canaries proving none appear in logs, errors, audit, API output, export, sync or backup.

Required automated tests:
- Migration from current Workspace schema, idempotent rerun, unknown version and interrupted/failed migration rollback.
- Crypto round-trip, nonce uniqueness, AAD mismatch, wrong key/version, tamper and malformed envelope.
- Permission matrix and cross-tenant/forged-tenant denial.
- Plaintext/ciphertext absence from all client-visible and export/history paths.
- SSRF URL corpus, redirects, header allowlist, method/path catalog, timeout, response size/content type and upstream error mapping.
- Save/rotate/delete concurrency and failed connection-test behavior; a failed test must not destroy the previously working credential.
- Frontend EN/JA reconnect, write-only credential, redacted status and no legacy fallback.
- Existing Jira behavior tests adapted to the authenticated connector; all unrelated suites remain green.

Acceptance criteria:
- A Workspace Admin can securely configure/rotate/remove Jira and test it without the browser retaining the credential after confirmed migration.
- An authorized existing Jira workflow can search through the same-origin Worker endpoint.
- No unauthenticated route or generic relay exists in the new code.
- Credentials are encrypted and tenant-bound at rest and absent from logs, audit, records, revisions, exports and API responses.
- Current product behavior outside Jira configuration/transport is unchanged.
- TypeScript, strict TypeScript, ESLint, focused security/Jira tests, full frontend Vitest, Worker core/runtime/prod-sim, EN/JA parity, production build, Chromium smoke and Worker dry-run all pass.

Before coding, stop and report if the owner has not supplied these decisions:
- key-custody/key-version configuration design;
- exact approved Jira Cloud hostname policy;
- whether a failed credential test may save a disabled candidate or must leave the old active credential untouched (recommended: leave old active untouched).

Final report must list schema/API/files changed, threat controls, migration/rollback behavior, tests, known deferred work and git status. Do not commit unless separately requested.
```

## 10. Phase 0 Completion Outcome

After 0A–0G, the product is not yet a full commercial test-management platform. It is the existing differentiated QA operations pilot with a defensible customer boundary: authenticated integrations, encrypted tenant secrets, layered abuse controls, observable operations, rehearsed backups, explicit organization/workspace membership, centralized scoped RBAC, safe onboarding/recovery, staging and disciplined releases. That is the correct base on which to implement the professional repository and run model from later roadmap phases.

## 11. Cloudflare Design References

Implementation must recheck current documentation and account-plan availability at coding/provisioning time. Relevant current references include:

- [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) — approximate, per-location application limits.
- [WAF rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/) — edge rules and plan-dependent characteristics.
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/) and [OpenTelemetry export](https://developers.cloudflare.com/observability/export/opentelemetry/).
- [Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/) for low-cardinality operational metrics.
- [R2](https://developers.cloudflare.com/r2/), [Queues](https://developers.cloudflare.com/queues/) and [Workflows](https://developers.cloudflare.com/workflows/) for private objects and asynchronous recovery jobs.
- [Durable Objects](https://developers.cloudflare.com/durable-objects/) for current tenant coordination and SQLite state.

These services are proposed as architecture components, not changed or provisioned by this planning task.
