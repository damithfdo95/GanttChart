# SaaS readiness assessment

Status as of the Phase 13 hardening baseline (2026-10-25). This is an engineering assessment, **not legal advice**.
Priorities: **P0** = before any external pilot, **P1** = before a paid launch, **P2** = later / enterprise.
Nothing here claims a control exists unless it is in the repository and tested.

## Summary

| Priority | Item |
|---|---|
| **P0** | Remove organization-specific values from tracked files / templates (see "Repository exposure"). |
| **P0** | Employment / IP / permission-to-commercialize review (checklist below) - a human decision. |
| **P0** | Enable GitHub secret scanning + push protection, code scanning, Dependabot alerts (repository settings; cannot be done from code). |
| **P0** | Decide the repository's visibility with the exposure audit in hand (do not change it from this repository). |
| **P0** | Authenticated, per-tenant request signing for the integration proxies (today CORS only; see Integration secrets). |
| P1 | Move integration secrets to encrypted backend storage (per tenant). |
| P1 | Customer / organization identity model, self-service onboarding, billing. |
| P1 | Monitoring and alerting on the structured logs; Cloudflare rate-limiting / WAF rules; an on-call/support path. |
| P1 | Customer-visible backup/restore and data-export/deletion process; documented retention. |
| P1 | Security contact + vulnerability response commitment; privacy policy / terms; sub-processor list. |
| P1 | Custom domain + HSTS, tenant-configurable time zone, TestRail custom-status mapping, historical snapshots for readiness/forecast. |
| P2 | SSO/SAML for customers, SCIM, advanced audit export, per-tenant retention policy, SOC 2 / ISO 27001 programme. |

No known tenant-isolation defect or live secret exposure was found in this audit (so those P0 triggers are not raised).

## Findings by category

### Identity
- **Current:** Cloudflare Access (one-time PIN / policy) authenticates; the app's registry authorizes. Managed email domains restrict who
  can be added. Roles: Super Admin, SV, Tester.
- **Risk:** Identity depends on one Cloudflare Access team; no customer-owned IdP.
- **Before pilot:** document the Access policy per pilot customer. **Before paid:** customer organization model, invitation/onboarding flow.
  **Later:** SAML/OIDC per customer, SCIM.

### Tenant model
- **Current:** one Durable Object per workspace, tenant id from the verified principal, forged tenant ids rejected, sockets bound to tenant,
  Super Admin metadata-only; extensive isolation tests (`worker/test/workers/tenancy-*.test.ts`, `security-baseline.test.ts`).
- **Risk:** low for isolation logic; operational risk of a single registry object and no per-tenant resource quotas.
- **Before pilot:** keep the isolation suite mandatory in CI. **Before paid:** per-tenant quotas, size alerts. **Later:** regional placement.

### Integration secrets
- **Current:** JIRA token / TestRail key are device-local in browser storage, excluded from sync and backups, sent only to an `https://`
  address (localhost excepted). Proxies have fixed upstreams and are read-only, but are reachable by anyone who knows the URL (CORS is not auth).
- **Risk:** a browser holds the secret; a lost/shared device exposes it; the proxy is an open relay for its fixed upstream.
- **Before pilot (P0):** require a signed, tenant-scoped request to each proxy (the application signs; the proxy verifies) or run the
  proxy inside the main Worker behind Access. **Before paid (P1):** encrypted per-tenant secret storage on the backend; the browser never holds the secret.

### Billing
- **Current:** none. **Before paid:** plan/seat model, payment provider, entitlement checks, dunning. **Later:** invoicing, usage metering.

### Organization / workspace
- **Current:** Workspace = QA team; Owner SV; ownership transfer; deletion with Super Admin approval. No organization above workspaces.
- **Before paid:** organization entity, multiple workspaces per customer, cross-team analytics (explicitly deferred; never mix tenants).

### Security
- **Current:** see [SECURITY.md](../SECURITY.md). CSP with broad `connect-src https:` (needed because each SV chooses a proxy address),
  no application rate limiting, request ids and content-free structured logs.
- **Before pilot:** Cloudflare Rate Limiting rules on `/api/*`, `/ws` (writes, backup import, admin actions, WebSocket upgrade);
  enable repository security features. **Before paid:** pen test, narrower `connect-src` once the proxy moves behind the app,
  security headers on API, HSTS on the custom domain.
- **Dependencies:** production dependencies have no advisories; development tooling (vite/vitest/wrangler/miniflare chain) has
  Critical/High advisories that need **major** upgrades (e.g. vitest 5). They do not ship, but should be upgraded deliberately (P1).

### Compliance
- **Current:** nothing formal. Data = QA execution data and work emails. **Before paid:** privacy policy, DPA template, data-location
  statement, retention/deletion statement. **Later:** SOC 2 / ISO 27001.

### Observability
- **Current:** Cloudflare observability on; JSON log events with reason codes and a request id. **Before paid:** alerts (auth failures,
  commit denials, 5xx, storage-size guard), dashboards, uptime check. **Later:** tracing, audit export.

### Reliability
- **Current:** Durable Object SQLite per workspace, revision journal, restore. No failover or PITR beyond what Cloudflare provides.
- **Before paid:** documented RPO/RTO, scheduled backup export per tenant, status page. **Later:** multi-region.

### Backups
- **Current:** manual/automatic file backups, revision restore, tested round trip, versioned format ([BACKUP_FORMAT.md](BACKUP_FORMAT.md)).
- **Before paid:** server-side scheduled exports and a customer restore request process.

### Support
- **Current:** Settings shows version, commit and build time; errors carry a code and request id. **Before paid:** support mailbox, runbook
  using [RECOVERY.md](RECOVERY.md), severity definitions.

### Deployment
- **Current:** manual deploy with a production safety guard; docs in DEPLOYMENT_PLAN.md. CI runs typecheck/lint/tests/build, CodeQL,
  dependency review and weekly audit definitions are in `.github/`. Actions are pinned to major versions (see below).
- **Before pilot:** pin third-party/security-sensitive actions to commit SHAs (Dependabot can then update them). Resolve the version
  authority (RELEASING.md). **Before paid:** staging environment, preview deploys, release tags per deploy.

### Legal / IP
- Employment-agreement and IP assignment review; company equipment/time/resource usage; removal of company-confidential information and
  company-specific configuration; written permission to commercialize; open-source licence review (below). **All human decisions.**

### Product onboarding
- **Current:** an SV is added by the Super Admin; manuals in EN/JA. **Before paid:** self-service workspace creation, guided setup
  (members, projects, integration), sample data, in-app help.

## Repository / IP exposure audit (tracked files)

| Item | Where | Class | Recommendation |
|---|---|---|---|
| Cloudflare Access team domain (`…cloudflareaccess.com`) | `worker/wrangler.jsonc`, docs | sensitive operational metadata (public in login URLs) | keep for the current internal deploy; template it for distribution |
| Managed email domain (company domain) | `worker/wrangler.jsonc`, DEPLOYMENT_PLAN, ADMINISTRATION | sensitive operational metadata / **IP-business exposure** | replace with `example.com` in docs; keep real value only in private config |
| JIRA origin (company JIRA host) | `jira-proxy/wrangler.toml`, `jira-proxy/README`, worker comment | sensitive operational metadata | move to a private config / placeholder in the repo |
| TestRail origin (company instance) | `testrail-proxy/wrangler.toml`, `shared/testrail.ts` comment | sensitive operational metadata | placeholder |
| Deployment hostname (`…workers.dev`) | proxies' `DEFAULT_APP_ORIGIN`, docs | benign configuration (but identifies the owner) | read from env only; no baked default |
| Backup/snapshot JSON of real data | `docs/ganttchart-before-*.json`, `backup/` | **would be real data** - currently git-ignored and **not tracked** (verified) | keep ignored; consider deleting local copies |
| Secrets / tokens / private keys | whole tracked tree | none found (pattern scan; no values printed) | enable GitHub secret scanning to keep it so |

**Sanitization checklist before commercial distribution:** replace the items above with placeholders; search docs and manuals for
screenshots, names, project names and employee identifiers; review test fixtures for real names/hosts; do not rewrite Git history without a
deliberate decision (old commits keep old values - treat anything ever committed as public if the repository was public).

## Open-source licences (production dependencies)

`npm run licenses` (read-only). Browser bundle: react, react-dom, scheduler, loose-envify, js-tokens - all **MIT**. Worker runtime: jose - **MIT**.
Nothing copyleft or unusual in what ships. Development tooling (not shipped) is not covered by this scan. For a commercial product, a
human/legal review should still confirm the list and add attribution notices where licences require them.

## Employment / IP / legal checklist (non-legal-advice)

- [ ] Employment agreement and invention/IP assignment clauses reviewed by someone qualified.
- [ ] Use of company equipment, time, accounts or confidential knowledge while building this assessed.
- [ ] Company-confidential information removed from code, docs, fixtures and history; company-specific hosts/configuration removed.
- [ ] Written permission (or a clear legal position) to commercialize.
- [ ] Open-source licences of all shipped dependencies reviewed; attribution notices prepared.
- [ ] Trademarks/names (including the product name) cleared.

## Integration findings (Phase 13)

- **TestRail `get_cases`** previously requested `get_cases/{suiteId}` (a project/suite mix-up that returns the wrong data or an error).
  Fixed to `get_cases/{project_id}&suite_id={suite_id}`; project from the run (`project_id`) or `get_suite`, mismatch refused, ids validated,
  paged, de-duplicated by case id.
- **TestRail custom statuses:** statuses with id >= 6 are treated as "in progress" (the closest open category) and counted separately as
  custom; they are never mapped to Passed/Failed. Faithful per-instance mapping needs a configurable status table - deferred (P1).
- **JIRA:** Cloud vs Data Center chosen from the instance host (not the proxy host), `Authorization` built per flavor, POST only for JQL search,
  paged search, credentials never in shared records or backups. No functional defect found.
- **Forecast / readiness history:** not stored, so not trended (needs periodic snapshots; P1/P2).
- **Performance:** Phase 12 analytics performance test retained in `qaImprovementAnalytics.test.ts`.
