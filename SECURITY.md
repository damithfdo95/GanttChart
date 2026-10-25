# Security

This document describes how GanttChart is secured today, what it does **not** yet protect against, and how to report a problem.
It is a description of the current system, not a certification. The honest gap list for a commercial service is in
[docs/SAAS_READINESS.md](docs/SAAS_READINESS.md).

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** to the repository owner (use GitHub's "Report a vulnerability" /
private security advisory on this repository once enabled, or contact the owner directly). Do not open a public issue
with exploit details, tokens or customer data. A dedicated security mailbox and response-time commitment do not exist yet;
they are a launch requirement (see the readiness document) and are intentionally not invented here.

## Authentication

- The shared workspace sits behind **Cloudflare Access**. The Worker does not trust that Access was in front: every `/api/*`, `/ws`
  and `/login` request verifies the Access JWT itself (signature against the team's keys, issuer, audience, expiry) before anything else.
- Verified identity is only an email. The application then looks the person up in its own **registry**; an identity the registry
  does not know (or no longer allows) is refused and logged without the mailbox name.
- Local mode has no accounts and no server.

## Authorization

- Roles: **Super Admin** (control plane only), **SV** (supervisor: manages one workspace) and **Tester** (limited writes).
- Permissions are one named action per route, default deny (`worker/src/permissions.ts`), plus record-level rules shared by browser and
  server (`shared/qaRules.ts`, `testerRules.ts`, `testManagement.ts`, `reportPublication.ts`). The UI hides what a role cannot do,
  but the server is what enforces it. A tested matrix covers every record kind against Tester writes (`worker/test/security-baseline.test.ts`).
- A Tester can change only projects' own execution inputs, results of cases assigned to them and case-execution events; they never
  receive SV-only records (reports, topics, reviews, meeting records, identity audit).
- A report can be published only by an SV, only from a finalized original, and only by changing its publication metadata.

## Tenant isolation

- One workspace = one Durable Object addressed by a tenant id taken from the **verified principal**, never from the request. A
  tenant id supplied by the browser (header, query or body) that disagrees is rejected (`tenant_mismatch`).
- A WebSocket is bound to its tenant at upgrade; a socket that does not match its object's tenant is closed, expired sessions are
  closed, and user/tenant changes disconnect live sockets.
- The Super Admin sees metadata (workspaces, accounts, audit) and **no QA data**.
- Backups and restores are scoped to the workspace that performs them.

## Input limits

Request bodies (10M chars), WebSocket messages (8M), single records (1M), batch size (500 records), ids, reasons, logo size and
text fields are bounded and tested (`shared/protocol.ts` `LIMITS`, `worker/src/http.ts`). Request-**rate** limiting is not
implemented in the application; see "Known limitations".

## Secrets

- Worker secrets: `ACCESS_AUD`, `SUPER_ADMIN_EMAILS` (set with `wrangler secret put`; **never** in the repository). Non-secret
  settings live in `worker/wrangler.jsonc`. Local `.dev.vars`, `.env*`, key files and backups are git-ignored.
- **Integration credentials (JIRA token, TestRail API key) are stored in the user's browser on that device only.** They are excluded
  from shared sync records, from full backups and from history backups (tests: `jiraDeviceLocal`, `testrailDeviceLocal`,
  `securityBaseline`). They are sent only to the configured address, which must be `https://` (plain `http://` only for localhost).
- A credential typed into Settings is write-only: it is never displayed again and never placed in an error message.

## Integration proxies

`jira-proxy` and `testrail-proxy` are small Cloudflare Workers with a **fixed upstream origin**, read-only methods, path allow-lists,
rejection of encoded traversal, a minimal forwarded-header set (no cookies) and a per-isolate best-effort rate limit.
**CORS is a browser policy, not authentication**: it stops other websites from using a visitor's browser as a relay, but anyone who
can reach the proxy URL directly (curl) can use it with *their own* upstream credentials. The proxies hold no secrets and relay the
caller's `Authorization` header only. For a multi-customer service the proxy must require an authenticated, signed request from
the application (see readiness document).

## Browser hardening

Static responses carry a Content-Security-Policy (`default-src 'self'`, no inline script, `frame-ancestors 'none'`), `nosniff`,
`X-Frame-Options: DENY`, a referrer policy and a permissions policy (`public/_headers`). `connect-src` allows `https:` because an SV
configures their own integration proxy address; it is the one deliberately broad directive. API responses are `no-store`.
HSTS is not sent by the Worker: `workers.dev` is HSTS-preloaded; add `Strict-Transport-Security` when a custom domain is chosen.

## Errors and logs

API errors return a stable code and a `requestId` (also the `X-Request-Id` header) and never a stack trace. Server logs are one JSON
line per event (reason codes, roles, counts, request id) and never contain tokens, Authorization headers, record bodies, report
text or memos.

## Known limitations

- No application-level request rate limiting (use Cloudflare Rate Limiting / WAF rules; not configured by this repository).
- Integration credentials live in browser storage (device-local), not in an encrypted backend vault.
- GitHub secret scanning, push protection, code scanning and Dependabot alerts are **repository settings** that must be enabled by the
  owner; this repository ships the workflows/config but cannot turn them on.
- Development-tool dependencies (vite/vitest/wrangler) have known advisories whose fixes are major upgrades; production dependencies
  have none (`npm run audit:prod`).
