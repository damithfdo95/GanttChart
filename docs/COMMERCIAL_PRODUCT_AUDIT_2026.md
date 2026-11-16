# Commercial Product Audit and Evolution Plan (2026)

**Audit date:** 2026-11-16  
**Repository baseline:** `v0.10.0-pilot.10`, commit `4355946abf20563b5ff6bc7169bb546e242d2945`  
**Scope:** product, architecture, security, UX, operations, market and commercialization. No implementation or external-system changes were performed.  
**Evidence labels:** **[R]** repository/code/test evidence; **[V]** current vendor documentation; **[I]** inference from evidence; **[REC]** recommendation requiring validation; **[OWNER]** irreversible or commercial decision reserved for the owner.

## A. Executive Summary

The codebase is a viable foundation for a commercial product, but not yet a commercially safe SaaS. It is substantially more mature than its name suggests: it combines QA planning, team capacity, daily operations, manual execution, release/readiness signals, reporting, revision history, bilingual UI, and a tested multi-tenant Cloudflare backend. Its strongest value is not commodity test-case storage. It is the operational layer between a test repository and a release decision.

**RECOMMENDED PRODUCT POSITION:** **QA Operations and Release Readiness for Jira-centric manual/hybrid teams**, with professional test execution as the system of record. The initial product should help a 5–30-person QA organization answer: *what must be tested, who is doing it, what actually happened, what is blocked, and is the release safe?* This position uses the existing Command Center, staffing/capacity, daily reporting, provenance, reconciliation and cross-project readiness instead of entering the most saturated part of the market as another TestRail clone.

The product should still build a credible repository and run model; buyers will not adopt an operations layer whose execution records are not trustworthy. The smallest sellable path is therefore:

1. Make tenant isolation, integration credentials, rate limiting, monitoring, backups and support externally safe.
2. Introduce a versioned repository and a single `Release → Plan → Cycle → Run → Test Instance → Execution` vocabulary.
3. Turn My Testing into a fast, evidence-capable execution workspace.
4. Add generic automation ingestion and stable public APIs before many bespoke integrations.
5. Preserve Command Center, capacity and readiness as the differentiation layer.

Top blockers to external sales are: unauthenticated standalone integration proxies; browser-local customer integration secrets; no independent staging/monitoring/backup operation; incomplete repository/version/run/evidence model; and no customer organization/identity/onboarding/legal operating model. Top opportunities are: operational command center, planned/assigned/actual staffing, append-only provenance with reconciliation, daily release reporting, and EN/JA support for Japan-based QA teams.

## B. Current Product Inventory

Classification is based on code, tests and operational documents, not roadmap claims.

| Capability | Evidence and real behavior | Current quality | Commercial disposition |
|---|---|---|---|
| Dashboard | Portfolio/project execution, risk, capacity and readiness selectors in `src/features/dashboard` | Pilot-quality, commercially valuable | Improve into role-specific overview |
| Command Center | Situation, attention list, daily-report block | Pilot-quality; differentiated | Keep as lead/manager core |
| Overall | Cross-project status table | Useful but overlaps dashboards | Merge into portfolio views |
| Gantt | QA-specific project schedule and milestones | Mature internal workflow | Keep, simplify and connect to releases |
| Cycles | Planned/active/completed/archived cycles and assignment | Pilot-quality | Rename/reshape under release plans |
| Test Management | Project scopes, cases, current results, imports and history | Incomplete repository; useful execution seed | Rebuild repository semantics incrementally |
| My Testing | Assigned scope/case execution | Pilot-quality | Rebuild as primary execution workspace |
| Daily Execution | Per-project aggregate actuals and status counts | Production-useful but duplicates case results | Merge into execution-derived operations with controlled manual adjustments |
| Daily Report | Prepared/finalized/published report, EN/JA templates | Strong and differentiated | Keep; connect to release snapshots |
| Improvement Analytics | Trends, history-quality warnings | Commercially valuable, data-model constrained | Improve at team/release level; avoid employee ranking |
| Performance | Per-tester attendance/output and allocations | Internally specific and surveillance-sensitive | Redesign as capacity/flow; remove rankings |
| JIRA | Browser client, CSV/JQL analysis, blocker import; fixed-origin proxy | Functionally useful, not commercially secure | Rebuild connector/auth; retain Jira-first strategy |
| TestRail | Case/scope/result import and analysis | Useful migration/interoperability, costly as continuous sync | Reposition mainly as migration connector |
| Team / Team Management | Membership, structures, assignments, transfer, leave, calendar, capacity, analytics | Broad pilot implementation | Keep core roster/capacity; defer HR-like breadth |
| Settings | QA policy, branding, integrations, menu, retention, history, support | Broad but dense | Split organization/project/integration/security settings |
| Super Admin | Tenant/account lifecycle, password recovery, metadata-only control plane | Strong safety principle | Keep; add audited, customer-approved support model |
| Shared History | Paginated/filterable record revisions, JST business-date filtering | Strong pilot feature | Keep as data history; distinguish from audit log |
| Backups | Versioned JSON, restore/hash/limits, local auto-backup | Good user export, not SaaS DR | Keep export; add server backup/PITR process |
| Authentication | Cloudflare Access plus Worker password sessions | Secure internal dual-auth model | Replace Access-only commercial dependency with OIDC strategy |
| Authorization | Central named actions plus record rules, default deny | One of the strongest areas | Preserve and extend policy model |
| Multi-tenancy | Tenant derived from verified principal; DO per workspace; isolation tests | Strong pilot design | Add Organization level, quotas and formal threat model |
| WebSocket sync | Optimistic revisions, live commits, session recheck/cleanup | Strong for collaborative pilot | Keep for live execution; measure scale and conflicts |
| Worker / Durable Objects | Registry control plane; one workspace DO with SQLite/records/history | Sound at small/medium tenant scale | Keep initially; split domains when triggers are met |
| Localization | EN/JA dictionaries and parity tests | Valuable | Keep; separate locale from business timezone |
| Exports | CSV/XLSX/JSON/print and backup | Broad | Harden formula injection and tenant export lifecycle |
| Branding | Workspace name/logo/tool name | Useful Business feature | Keep with file-storage hardening |
| Notifications | In-app scheduled banners and acknowledgment | Partial | Add event preferences, email/Slack/Teams later |
| QA policy/readiness | Central rules, deterministic signals and explanations | Differentiated | Make release criteria configurable and snapshotted |
| Execution history | Append-only `caseExecution`, actor/source/time; reconciliation | Strong seed | Central commercial trust primitive |

## C. Current Architecture Assessment

**[R] Current architecture.** React/TypeScript/Vite runs in local or shared mode. The browser owns a normalized-ish set of opaque records and syncs batches against a base revision. A Cloudflare Worker authenticates, resolves a principal, applies a named permission and record-level rules, then routes to a Registry Durable Object or tenant Workspace Durable Object. Each workspace DO uses SQLite for current records and revision history; WebSockets distribute changes. Jira/TestRail clients currently execute in the browser through separate fixed-upstream proxy Workers. Static assets ship with the Worker.

**Strengths:** small operational surface; tenant physical/logical partition by DO; deterministic shared validation used by browser and server; optimistic concurrency; append-only execution facts; revision restore; clean control-plane/content-plane separation; excellent automated test breadth.

**Constraints:** Workspace records remain a broad shared-record store; cross-tenant reporting is intentionally absent; analytics/search/imports compete with interactive DO work; large attachments do not belong in SQLite; registry concentration and workspace record/size limits constrain scale; schema semantics are distributed through TypeScript validators rather than an explicit versioned domain database.

**Database decision:** retain Durable Objects for tenant coordination, live execution and revision sequencing through initial commercialization. Add R2 for attachments/exports/backups and Queues/Workflows for asynchronous jobs. Introduce D1 only for a modest global control-plane/read model if needed. Move durable business data to PostgreSQL through Hyperdrive only when one of these measured triggers occurs: cross-workspace relational reporting becomes a paid requirement; a tenant approaches hundreds of thousands of cases/millions of events; query/search latency cannot meet budgets without duplicating most data; backup/restore or migration requirements cannot be met; or concurrency hot spots exceed a single workspace coordinator. Do not perform a speculative database rewrite.

Scale expectations (targets, not current claims):

| Tier | Expected shape | First likely pressure |
|---|---|---|
| Small | 10 users, 10k cases, <250k execution events | UX/search and import throughput, not DO coordination |
| Medium | 100 users, 250k cases, millions of events | list/search indexes, analytics jobs, WebSocket fan-out, backup size |
| Large | 1,000 users, multi-workspace, tens of millions of events | single-tenant partitioning, global reporting, retention and data residency |

## D. Security Assessment

**Verified controls [R]:** Access JWT validation; signed HttpOnly/Secure/SameSite=Lax application sessions; revocation and socket recheck; generic login errors; lockout after repeated failures; PBKDF2-SHA-256 hashes with per-password salt and encoded iteration count; same-origin checks plus intent header on unsafe routes; central default-deny permissions; tenant ID derived from principal; Tester record filtering; append-only execution rules; bounded bodies/messages/records/batches; CSP and security headers; content-free structured logs; secret/config guard; CodeQL, audits, dependency review and SBOM workflows; extensive tenant-isolation/runtime tests.

**Important qualification:** the source comment says 100,000 PBKDF2-SHA-256 iterations are a current OWASP recommendation. That assertion should be revalidated and the work factor benchmarked in Phase 0; password KDF guidance changes. Prefer managed OIDC and IdP MFA over expanding native password scope.

**Threat highlights:**

- Integration proxies are CORS-restricted but not authenticated; CORS is not authorization. High severity before an external pilot.
- Jira/TestRail tokens are browser-local; this is acceptable for the current controlled pilot but not commercial secret custody.
- There is no application-layer distributed rate limiter and no evidenced production WAF/rate policy.
- Cloudflare Access is one operator-owned identity boundary, not customer-owned federation.
- Audit coverage exists but is not a complete immutable commercial audit/security event system.
- No attachment pipeline exists, which avoids current file-upload risk but is a product blocker.
- Broad record APIs require continuous mass-assignment, IDOR and tenant-isolation regression coverage as domains grow.
- CI actions use version tags rather than immutable commit SHAs; pin security-sensitive actions.

## E. Commercial Readiness Scorecard

0 = absent, 5 = strong commercial capability. Scores assess the current product, not the roadmap.

| Area | Score | Rationale |
|---|---:|---|
| Execution | 3.0 | Case results, assignment, provenance and history exist; step execution/evidence/run UX do not |
| Repository | 2.0 | Scopes/cases/import exist; no hierarchy, immutable versions, shared steps or mature lifecycle |
| Planning | 3.5 | Cycles, schedules, Gantt, staffing and daily plans are unusually strong |
| Automation | 0.5 | External results mainly through TestRail; no generic ingestion contract |
| Integrations | 2.0 | Jira/TestRail useful but credential/proxy architecture blocks commercial use |
| Analytics | 3.0 | Operational/readiness analytics are strong; traceability/automation/trend model incomplete |
| UX | 2.5 | Broad and responsive, but dense IA and internal terminology create learning cost |
| API | 1.0 | Internal HTTP/sync APIs only; no commercial versioned API/key model |
| Security | 3.0 | Strong app controls; missing external-pilot operational controls and secret custody |
| Tenancy | 3.5 | Tested tenant derivation/isolation; no Organization layer, quotas or customer identity federation |
| Reliability | 2.5 | Revisions/recovery and strong tests; no commercial DR/SLO/staging/alert evidence |
| Scalability | 2.0 | Efficient small-tenant architecture; search/analytics/large-volume path not proven |
| Operations | 2.0 | Guarded deploy and runbooks; manual releases and no independent monitoring/on-call |
| Onboarding | 1.0 | Super Admin provisions workspaces; no guided/self-service flow |
| Migration | 2.0 | CSV/TestRail imports and backups exist; no auditable generalized migration pipeline |
| Billing | 0.0 | None, appropriately deferred |
| Compliance | 0.5 | Security documentation exists; no certification/control program claimed |
| Enterprise admin | 1.5 | Super Admin and audit seeds exist; SSO/SCIM/custom retention/support access absent |

## F. Market Landscape

The 2026 category is crowded and converging around four expectations: structured manual execution, unified automation results, requirements/defect traceability, and enterprise identity/audit. AI test generation is becoming a table-stakes marketing feature, not a durable position by itself.

Verified examples:

- **TestRail** offers cloud and self-hosted options, suites/runs/milestones, configurations, versioning/review, parameterization and AI. Public annual prices are $22/$38/$78 per user-month for Essentials/Professional/Enterprise. [TestRail pricing](https://www.testrail.com/pricing/)
- **Testmo** positions around unified manual, exploratory and automated testing. Public plans start at $59/month for 5 users, $249/month for 15 Business users and $599/month for 25 Enterprise users; API, CI, reporting and enterprise audit/SSO vary by tier. [Testmo pricing](https://www.testmo.com/pricing/) and [overview](https://www.testmo.com/)
- **Qase** combines repository/runs, requirements, query language, integrations and AI/cloud automation. Its Teams price is publicly $35/user/month annually; Enterprise adds SCIM, MFA/IP restriction, audit and private attachments. [Qase product](https://www.qase.io/product/)
- **PractiTest** emphasizes end-to-end traceability from requirements through tests, automation and defects, with advanced querying/analytics and enterprise security. Pricing shown in its current comparison is about $49/user/month but should be reconfirmed in a sales quote. [PractiTest product](https://www.practitest.com/product/) and [security](https://www.practitest.com/security/)
- **Xray** is Jira-native, with manual/Cucumber tests, traceability, Jira issue semantics, Cloud/Data Center and risk-based/AI features. Atlassian-wide licensing creates strong Jira fit but seat/licensing friction. [Xray product](https://www.getxray.app/test-management)
- **Zephyr** is Jira-native and supports manual/automation, plans/cycles, repository/versioning, REST APIs, CI formats and traceability; SmartBear documents SOC 2 Type 2 and Atlassian Cloud Fortified participation. [edition matrix](https://support.smartbear.com/zephyr/docs/en/zephyr-editions-feature-comparison.html), [security](https://support.smartbear.com/zephyr/docs/en/security-and-reliability/data-security.html)
- **Tricentis qTest** targets enterprise-scale test governance, manual/automation/exploratory work, Jira/Tosca integration, analytics, APIs and SCIM. Pricing is sales-led. [qTest documentation](https://docs.tricentis.com/qtest-saas/index.htm)
- **Azure Test Plans** is strongest for Azure DevOps customers: plans/suites/configurations, manual/exploratory execution, rich evidence, Boards/Pipelines traceability and analytics. [Microsoft overview](https://learn.microsoft.com/en-us/azure/devops/test/overview?view=azure-devops)
- **Katalon TestOps** emphasizes unified manual and automated evidence, Jira and external frameworks; current public material states $80/seat/month or $800 annually, with multi-tenant and private SaaS options. [Katalon TestOps](https://www.katalon.com/testops)
- **Kiwi TCMS** is a credible open-source alternative with plans, cases, runs, assignments, audit traceability, automation plugins and deployment control. [Kiwi TCMS](https://kiwitcms.org/) and [documentation](https://kiwitcms.readthedocs.io/en/stable/guide/introduction.html)

Credible user evidence is mixed and contextual: users repeatedly value workflow fit, exportability, unified automation and reporting, while citing cost, learning curve, clunky navigation and migration friction. These are signals, not statistically representative findings. The product should validate them through interviews and real-suite trials rather than relying on review-site averages.

### Competitor profiles by buying dimension

This table condenses verified public capability; a blank is not proof that a capability is absent. “Limits” combines documented packaging constraints with clearly labeled market inference.

| Product / target | Deployment and repository | Planning and execution | Automation, CI, integrations and API | Traceability, reporting, governance, AI and price | Apparent strength / limitation |
|---|---|---|---|---|---|
| TestRail — general QA teams from small to enterprise | Cloud and self-hosted; suites, cases, versions, templates, fields, labels, shared steps, parameters | Milestones, plans, runs, configurations; manual assignment and to-do workflow | Automation/API and Jira ecosystem; AI generation/prioritization by plan | Cross-project reporting, review/approval and enterprise controls; $22/$38/$78 user-month annually | Mature category reference; [I] breadth and per-seat price can create administration/cost friction |
| Testmo — modern cloud teams | Cloud SaaS; cases, templates, fields and workflows | Milestones/plans/runs plus first-class exploratory sessions and rich evidence | Unified generic automation/CI, Jira/GitHub/GitLab, REST; webhooks listed as coming soon in current pricing | Dashboards, forecasts, reporting center, RBAC/audit/SSO by tier, AI/MCP; bundled $59/$249/$599 bases | Clean unified manual/automation/exploratory story; [I] cloud-only and tier gates may limit regulated/self-hosted buyers |
| Qase — product/engineering teams seeking modern TMS + AI | SaaS; organized repository, test review, query language, requirements | Plans/runs, orchestration, manual execution and cloud automation | 35+ integrations, API result allowances, Playwright/Cypress/Selenium-oriented AI output | Traceability, RBAC/SSO; Enterprise SCIM/MFA/IP/audit/private attachments; $35/user-month Teams | Strong UX/AI/integration packaging; [I] retention/API/AI-credit tiers complicate volume economics |
| PractiTest — process-heavy QA organizations | SaaS end-to-end QA model with customizable fields/filters | Manual and exploratory execution with reusable test assets | Broad automation/defect integrations and APIs | Strong requirement-test-defect traceability, query/reporting and enterprise security; about $49/user-month publicly indicated | Strong customizable analytics/traceability; [I] depth implies learning/configuration cost |
| Xray — Jira-centric organizations | Jira Cloud/Data Center app; tests represented in Jira context, manual/Cucumber formats | Jira-native plans, executions and requirement coverage | CI/framework imports and Jira APIs/ecosystem | Jira permissions/audit/security model, traceability, AI generation/prioritization; Atlassian tier pricing | Lowest context switching for Jira buyers; Jira-wide licensing and Jira data model are adoption constraints |
| Zephyr — Jira-centric teams from basic to advanced automation | Jira/Forge product family; folders, versions, archive/history and reusable calls | Plans, cycles, manual/step results, time and defect links | REST, JUnit/Cucumber formats, Jenkins/Bamboo/other CI; optional no-code/cross-browser automation | Cross-space reporting/traceability; Jira roles; SOC 2 Type 2/Cloud Fortified; Marketplace pricing | Broad Jira-native ladder; Atlassian license tier and edition complexity are documented constraints |
| qTest — large enterprise / Tricentis customers | SaaS/on-premises family; governed requirements/cases and versions | Manager, Explorer and automation scheduling support enterprise processes | Jira/Tosca/Jenkins/Bamboo, REST resources, tokens/SDKs and SCIM | Enterprise dashboards, groups/security, exploratory capture and AI; sales-led pricing | Deep governance/ecosystem; [I] procurement, configuration and administration are heavier than SMB needs |
| Azure Test Plans — Azure DevOps organizations | Azure DevOps service; cases/suites linked to Boards work items | Plans, configurations, manual runner, exploratory/UAT and stakeholder feedback | Azure Pipelines result publication and framework-neutral pipeline results; Azure APIs | End-to-end Boards/build/defect traceability, progress and Analytics dashboards; Basic + Test Plans licensing | Excellent Microsoft lifecycle integration and diagnostic capture; less attractive outside Azure DevOps |
| Katalon TestOps — automation-heavy hybrid teams | Multi-tenant or private SaaS; unified record of manual/Katalon/external testing | Manual execution with captured evidence and AI-supported workflows | Playwright and external frameworks, Jira, REST/CLI/SDK/webhooks/MCP | Requirement/evidence linkage, optional AI and enterprise bundles; stated $80/month or $800/year per seat | Unified automation evidence and Katalon ecosystem; premium seat price and suite affinity narrow the ICP |
| Kiwi TCMS — self-hosters/open-source adopters | Open-source Docker/self-hosted; plans/cases/runs, review/change history | Assign, execute, status, bug reporting and release telemetry | Framework plugins and external API/integrations | Audit traceability, dashboards and reports; software free with optional services | Control, portability and low license cost; operator owns hosting, upgrades, backup and security maturity |

Exploratory and customization details vary by edition. Security claims above are vendor assertions unless linked to an independent program; they are not equivalent to this audit validating a vendor. Credible anecdotal complaints were not promoted into facts: the recurring themes of price, navigation/learning curve and export/migration lock-in should instead become structured interview questions.

## G. Competitor Comparison

`✓` verified major capability, `~` partial/edition-dependent, `—` not central or not verified. GanttChart target is a proposed state.

| Buyer capability | Target | TestRail | Testmo | Qase | PractiTest | Xray | Zephyr | qTest |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Mature case repository/versioning | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Fast manual execution/evidence | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Unified automation results | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Requirements/defect traceability | ✓ | ✓ | ~ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Jira-native experience | ~ | ~ | ~ | ~ | ~ | ✓ | ✓ | ~ |
| Exploratory sessions | Later | ~ | ✓ | ~ | ✓ | ~ | ~ | ✓ |
| QA staffing/capacity operations | **✓ core** | — | — | — | ~ | — | — | ~ |
| Daily operational report workflow | **✓ core** | — | — | — | ~ | — | — | ~ |
| Cross-project release command center | **✓ core** | ~ | ~ | ~ | ✓ | ~ | ✓ | ✓ |
| Append-only provenance/reconciliation | **✓ core** | ~ | ~ | ~ | ~ | ~ | ~ | ~ |
| Enterprise SSO/SCIM/audit | Enterprise | ✓ | ✓ | ✓ | ✓ | Jira/Atlassian | Jira/Atlassian | ✓ |
| Public transparent entry pricing | Planned | ✓ | ✓ | ✓ | ~ | ✓ calculator | Marketplace | — |

No superiority is claimed: the target differentiators are hypotheses until customer trials demonstrate better release decisions or lower coordination cost.

## H. Recommended Product Position

Choose **C + D: QA Operations / Command Center with release-quality management**, supported by credible unified manual and automated execution. Do not lead with “test-case management.” Repository parity is necessary but not the headline.

Why: the repository already contains operational workflows competitors often treat as reports after the fact—planned/assigned/actual capacity, daily report preparation/publication, attention signals, Gantt planning, provenance and explicit reconciliation. Engineering required to professionalize those is lower than building an enterprise ALM suite, while customer pain around fragmented spreadsheets, Jira, test tools and release status is plausible and payable. Migration friction is reduced by positioning as Jira-integrated and by providing TestRail/Qase/Xray/Zephyr imports.

## I. Ideal Customer Profile

**Primary initial ICP [REC]:** Japan-based or Japan-connected, Jira-heavy software organizations with 5–30 manual/hybrid testers, multiple concurrent releases/projects, a QA lead who currently assembles daily status and capacity in spreadsheets, and no need for regulated-enterprise procurement on day one.

Secondary later ICP: 30–200 tester organizations needing cross-team release governance. Avoid regulated large enterprise as the first market because SAML/SCIM, data residency, compliance evidence, contractual support and scale would dominate product learning.

Personas: economic buyer—Head of QA/Engineering; champion—QA manager/lead; daily user—manual tester/automation engineer; stakeholder—release/program/product manager; security reviewer—security/IT; procurement reviewer—legal/vendor management. Each needs respectively ROI/risk, operational control, speed, trustworthy readiness, isolation/security evidence and contractual clarity.

## J. Jobs To Be Done

1. When a release approaches, show what was actually tested and what risk remains so I can make a defensible release decision.
2. When priorities change, reassign QA capacity and see schedule impact without rebuilding a spreadsheet.
3. When I start work, show my next assigned tests and let me record evidence quickly.
4. When a test changes, preserve exactly which version each historical execution used.
5. When automated and manual results arrive, combine readiness without erasing their provenance.
6. When a blocker appears, connect the execution to its Jira defect and surface release impact.
7. When stakeholders ask for status, publish a consistent report without manual aggregation.
8. When adopting the product, import existing cases and verify what moved before committing.
9. When an audit/security review occurs, prove who changed configuration, cases, executions and approvals.

## K. Differentiators

Make central: Command Center; planned/assigned/actual capacity; release readiness with explainable criteria; daily operational reporting; append-only execution provenance; reconciliation; QA schedule/Gantt; and cross-project operational risk. Improve Work Types only as capacity categories. Keep Improvement Analytics at team/process level. Explicitly prohibit individual “productivity scores,” league tables or opaque AI employee assessment.

## L. Current Feature Disposition

| Feature | Action | Reason |
|---|---|---|
| Command Center | KEEP/IMPROVE | Primary differentiation |
| Dashboard + Overall | MERGE | Reduce overlapping status surfaces |
| Gantt | KEEP/RENAME | “QA Schedule” under Releases/Planning |
| Cycles | RENAME/REMODEL | Disambiguate plan/cycle/run hierarchy |
| Test Management | REBUILD incrementally | Needs folders, versions, steps, lifecycle and requirements |
| My Testing | REBUILD | Must be optimized execution workspace |
| Daily Execution | MERGE | Derive from executions; preserve explicit adjustment workflow |
| Daily Report | KEEP/IMPROVE | Distinct operational publishing value |
| Performance | REBUILD | Team capacity/flow, not individual surveillance |
| Improvement Analytics | IMPROVE | Useful trends once data semantics stabilize |
| Tickets | MERGE | Lightweight defect links/findings, not a Jira clone |
| Jira | REBUILD connector | Strategic integration, insecure current custody |
| TestRail | RENAME/DEFER sync | “Import from TestRail”; avoid permanent two-way complexity |
| Team + Team Management | MERGE | One clear administration/capacity area |
| Shared History | KEEP | Revision evidence; separate from security audit |
| Review | MERGE | Become approvals/sign-off where justified |
| Meeting | IMPROVE/DE-EMPHASIZE | Daily QA operations, not generic meeting software |
| Local-only mode | DEFER commercial support decision | Useful demo/privacy mode but doubles semantics/support |

## M. Missing Capability Matrix

| Capability | State | Priority horizon |
|---|---|---|
| Versioned case repository, folders, steps | Partial | MVP/P0 |
| Plan/run/test-instance model | Partial/confused | MVP/P0 |
| Evidence attachments in private object storage | Missing | MVP/P0 |
| Secure Jira connector and defect links | Partial | MVP/P0 |
| Generic CSV/JSON migration with dry run | Partial | MVP/P0 |
| External-pilot monitoring/rate limits/backups | Missing | External pilot/P0 |
| Public API/service accounts | Missing | V1/P1 |
| JUnit/Playwright/Cypress ingestion | Missing | V1/P1 |
| Requirements/traceability matrix | Missing | V1/P1 |
| Release/build/environment model | Partial | MVP/P1 |
| Webhooks | Missing | V1/P1 |
| Email/Slack/Teams | Missing | Growth/P2 |
| Exploratory sessions | Missing | Growth/P2 |
| Custom fields/statuses/templates | Partial | V1/P2, constrained |
| SAML/SCIM/custom roles | Missing | Enterprise/P2 |
| Data residency | Missing | Enterprise/P3, demand-led |
| AI assistance | Missing | Later/P3 |
| Billing | Missing | Paid-launch gate/P1 |

## N. Target Product Architecture

```text
Browser (CURRENT React; TARGET role-specific app)
  -> Cloudflare Edge: DNS/TLS, WAF, rate limits, bot controls
  -> Identity: TARGET OIDC/customer federation; CURRENT Access/password during migration
  -> Versioned Worker API / BFF
       -> authorization policy + tenant context (CURRENT pattern, expanded)
       -> Workspace Durable Object (CURRENT: coordination, revisions, WebSockets)
       -> Primary domain store (CURRENT DO SQLite; MIGRATION LATER PostgreSQL if triggers fire)
       -> R2 private objects (TARGET attachments, exports, backup artifacts)
       -> Queues/Workflows/Cron (TARGET imports, notifications, webhooks, analytics)
       -> Search index (LATER when measured need; not MVP)
       -> Integration adapters (TARGET server-side Jira/CI; encrypted credentials)
       -> Observability (TARGET structured logs, metrics, traces, alerts, uptime)
       -> Billing/email providers (LATER, isolated adapters)
```

Bounded domains: Identity & Organizations; Projects & Releases; Repository; Planning; Execution; Defects; Integrations; Analytics/Reporting; Audit; Billing. Keep one deployable Worker initially, but enforce module and API boundaries; microservices are not required.

## O. Target Data Model

Core hierarchy: `Organization → Workspace → Project`. A project has Releases, Requirements, Test Suites and Test Cases. `TestCase` is stable identity; `TestCaseVersion` is immutable content. `TestPlan` selects scope/strategy for a release; `TestCycle` groups a time/configuration slice; `TestRun` is an executable assignment for a build/environment; `TestInstance` pins a case version in a run; `Execution` is one attempt; `StepExecution` records step outcomes. `DefectLink`, `Attachment`, `Environment`, `Build`, `Membership`, `RoleBinding`, `Integration`, `Webhook`, `Approval` and `AuditEvent` are separate entities.

Do not force Workspace and Organization to be one entity. Do not place integration secrets or attachment blobs in ordinary workspace records. IDs are server-generated and every persisted/queryable object carries immutable organization/workspace ownership.

## P. Professional Test Execution Model

Exact semantics:

- **Release/Milestone:** product delivery target and readiness boundary.
- **Test Plan:** reusable declaration of scope, strategy, criteria and configurations for a release.
- **Cycle:** scheduling/coordination grouping within a plan (e.g., Regression 1).
- **Run:** immutable-enough executable assignment for one build/environment/configuration set.
- **Test Instance:** case version selected into a run, with assignee/configuration.
- **Execution:** an attempt with actor/source/timestamps/result/duration/comment/evidence/defects.

My Testing becomes the main workspace: queue/outstanding filters, next/previous, keyboard shortcuts, resume state, step list, per-step result, overall result, duration, build/environment, comments, evidence and defect link/create. Optimize for hundreds of cases with optimistic saves and clear conflict/retry behavior.

Tenant-defined result statuses map to semantic flags: `executed`, `terminal`, `successful`, `failure`, `blocking`, `countsTowardCompletion`. Ship defaults Untested, Passed, Failed, Blocked, Retest, Skipped and Not Applicable. Readiness consumes semantic flags, never display names.

## Q. Repository / Versioning Model

MVP case fields: stable human-readable ID, title, objective, preconditions, ordered steps/expected results, priority, type, automation status, owner, labels, lifecycle, created/updated metadata and Jira requirement links. Add attachments and revision history. Later: severity, arbitrary custom fields, parameter datasets, shared steps, templates and broad requirement connectors.

Editing creates a draft. Publishing creates an immutable `TestCaseVersion`; executions pin that version forever. Diff versions; restore by creating a new draft/version, never rewriting history. A run snapshot fixes selected versions. Approval is optional in Professional and configurable in Business/Enterprise. Archive hides a case from new planning but preserves all versions/executions; deletion is restricted, delayed and audited.

## R. Integrations & Automation Strategy

Jira: server-side OAuth 2.0 for Cloud where appropriate, PAT/OAuth support for Data Center, encrypted tenant credentials, project/JQL selection, requirement/defect links, defect creation, field mapping, webhooks, rate/backoff and audit. Never accept arbitrary proxy targets; use allowlisted validated instance origins and SSRF-safe egress.

TestRail: prioritize one-time/repeatable import with mapping, dry run and migration report. Offer result interoperability only where a validated customer demands it; avoid permanent bidirectional source-of-truth ambiguity.

Automation: a generic ingestion endpoint/CLI first, accepting JUnit XML and normalized JSON. Capture framework, external test identity, run/build/branch/commit/CI job/environment, attempt/retry, duration, attachments/log references and provenance. Add thin adapters/reporters for Playwright, Cypress, pytest, Jest/Vitest and Selenium. GitHub Actions first; then GitLab/Jenkins/Azure DevOps based on demand. Do not execute customer test code in MVP.

Migration pipeline: upload → parse in quarantine → dry-run validation → field/status/user mapping → duplicate/conflict report → owner approval → idempotent job → verification counts/hashes → downloadable report → rollback marker/recovery. Support CSV/Excel and generic JSON first, then TestRail, Qase, Xray and Zephyr adapters.

## S. API & Webhook Strategy

Expose `/api/v1` REST resources, not DO RPC. Use scoped service accounts/API keys initially and OAuth client credentials later. Require organization/workspace scope, least privilege, pagination, filtering, idempotency keys on ingestion/creation, stable error codes, version/deprecation policy, per-principal rate limits and audit events. Publish OpenAPI and generate small TypeScript/Python clients only after contracts stabilize.

Webhooks: tenant-selected allowlisted HTTPS destinations; events for run/execution completion, defect link, readiness change and report finalization. Sign `timestamp.body` using HMAC; include event/delivery IDs; reject replay at receivers through timestamp guidance; retry with bounded exponential backoff/jitter; retain delivery metadata/redacted response; disable after repeated terminal failures; rotate secrets; never log payload secrets.

## T. Security Architecture

Adopt a centralized policy request: `{principal, organization, workspace, project, action, resource}` with default deny and explicit scope. Keep UI visibility non-authoritative. Add property/matrix tests for every role/resource/action and deny unknown fields to mitigate mass assignment.

Identity: OIDC as the commercial default; Google/Microsoft convenience login can use OIDC. SAML and SCIM are Enterprise. IdP MFA is preferred. If native passwords remain, benchmark a modern KDF available in the runtime, add verified email reset, forced-change/recovery codes, breach screening with privacy-preserving lookup if justified, device/session listing and distributed login/reset rate limits.

Evidence: private R2 object keys namespaced by tenant and random object ID; short-lived signed upload/download authorization issued after policy checks; server-side metadata; size/type allowlist, magic-byte sniffing, sanitized names, quotas, lifecycle and deletion jobs. Use asynchronous malware scanning or quarantine before broad download; never render active HTML/SVG inline.

Secrets: encrypted envelope per tenant with key-version metadata, narrow adapter access, rotation/revocation, redacted UI/logging and audit. Investigate Cloudflare Secrets Store/KMS-compatible patterns, but document the final threat model before selecting technology.

Audit logs are append-only administrative/domain events with actor, tenant, action, target, timestamp, request/correlation ID and safe diff metadata. Security events are separate (auth failure, denial, rate limit, suspicious API/webhook/integration failure) with restricted operator access and retention.

## U. SaaS Multi-Tenant Architecture

Hierarchy: Organization owns workspaces, identity policies and billing; Workspace isolates teams/data; Project scopes QA work. Membership and role bindings are server-side. Built-ins: Organization Owner/Admin; Workspace Admin; QA Manager; QA Lead; Tester; Viewer. Permissions may be scoped organization/workspace/project. Custom roles are Enterprise after the policy vocabulary stabilizes.

Formal isolation invariant: a client-provided organization/workspace/project ID is only a lookup hint; authorization derives allowed scope from the authenticated principal and verifies every referenced object. Apply to HTTP, WebSockets, exports/imports, attachments, audit/search/analytics, API keys and webhooks. Add tenant quotas, resource accounting and noisy-neighbor limits.

Platform Super Admin remains control-plane only. Support access must be customer-approved, purpose-bound, time-limited, scoped, visible, revocable and audited. No implicit browsing of test content.

## V. Privacy / Compliance Roadmap

Classify data: account/contact; tenant QA content; execution/audit history; attachments; Jira/requirements; encrypted integration secrets; operational/security logs; billing. Define purpose, location, retention, export/deletion and access for each. Before payment: privacy notice, terms, DPA, subprocessors, data deletion/export, incident process and Japanese APPI/GDPR assessment. SOC 2 Type I becomes useful when enterprise pipeline requires evidence; Type II requires operating controls over time. ISO 27001 is a later business decision, not a feature. Do not claim certification.

Data residency is Enterprise/demand-led. Start with a documented region and subprocessors; design tenant region as immutable provisioning metadata, but do not build multi-region before validated demand.

## W. Reliability / Operations Architecture

Environments: local, CI, staging and production. Production must not be staging. Use preview deployments for UI/API changes where safe, isolated from production data. Release: PR → required CI/security → staging migration/acceptance → release candidate → approval → immutable version/tag → production → smoke → monitoring. Build and deploy the tagged artifact so product identity cannot lag production.

Early objectives (internal targets, not contractual SLA): monthly availability 99.5%; p95 interactive reads <500 ms and writes <750 ms excluding integrations; execution save durable acknowledgement <1 s; alert on sustained 5xx >1%, auth-failure spike, queue age >5 min, backup failure, storage/quota threshold and integration/webhook failure bursts. Define initial RPO 24 h and RTO 8 h only after backup/restore drills demonstrate them; tighten based on customer need.

Backups: scheduled encrypted tenant snapshots plus platform/control-plane backup, versioned schema, retention policy, restore into isolated validation target, routine restoration tests and documented disaster runbook. Manual export remains customer portability, not the sole backup.

Performance budgets: initial load LCP <2.5 s on supported office broadband; list/filter interaction <200 ms for paged views; API p95 targets above; search <1 s; 10k-case import asynchronous with progress; automation ingestion accepts batches idempotently. Validate with measured load tests before publishing claims.

Incident minimum: severity/owner, detection, containment, evidence preservation, customer communication criteria, security notification/legal review, recovery and blameless postmortem. Provide status page and support escalation before paid launch.

## X. Migration Strategy

Current `scope/testCase/caseResult/caseExecution/cycle/project` records remain readable during migration. Add versioned schemas and dual-read adapters. Back up before migration; create stable mapping tables from old IDs to new entities; map Cycle to an initial plan/cycle, create one run per coherent execution context, turn current TestCase content into version 1, pin historical executions where content is knowable and label uncertain legacy provenance explicitly. Never fabricate step results or build/environment.

Migration stages: inventory/dry run → backup/hash → create new entities idempotently → reconcile counts/references → shadow-read comparison → enable new writes → retain rollback window → retire old writes only after verification. Because execution history is append-only, rollback should switch readers/writers or restore backup, not delete selected history ad hoc.

## Y. UX / Navigation Recommendation

Current navigation exposes too many peer screens and internal concepts. Proposed role-aware IA:

- **Overview:** My Work (Tester) or Command Center (Lead/Manager)
- **Testing:** Runs, My Testing, Exploratory (later)
- **Planning:** Releases, Plans & Cycles, QA Schedule
- **Repository:** Test Cases, Requirements
- **Quality:** Defects, Readiness, Reports & Analytics
- **Team:** Capacity & Assignments
- **Integrations**
- **Administration:** workspace, security, audit, data

Terminology: Project remains; Scope becomes Suite/Run Scope depending meaning; Cycle is a scheduled plan grouping; Test is Test Case; result facts are Executions/Attempts; Daily Execution becomes Daily QA Summary; Work Type becomes Capacity Category; Readiness always names its release/build boundary.

Establish design tokens, accessible tables/forms/dialogs/badges/charts, density modes and standard empty/loading/error states. Prioritize keyboard flow and table virtualization/paging over cosmetic redesign. Target WCAG 2.2 AA through automated and manual audit; do not claim conformance prematurely. Support current Chrome/Edge first, add Firefox/Safari before broad commercial launch. Mobile is responsive review/evidence capture, not a native app. UI/report locale, user timezone and tenant/project business timezone must be separate; timestamps remain UTC.

## Z. Packaging / Pricing Direction

Recommended pricing hypothesis [OWNER validation required]: charge per active execution user, with free/viewer stakeholders, rather than every invited stakeholder. This aligns cost with value and avoids Jira-app “all Jira users” friction. Test through interviews; do not simply undercut incumbents.

- Trial: time-limited full Professional, guided sample and import.
- Professional: repository, manual/automation runs, Jira, Command Center, reports and API allowance.
- Business: capacity planning, advanced readiness/analytics, approvals, custom roles/fields, scheduled reports and longer retention.
- Enterprise: SAML/SCIM, audit export, custom retention/residency, security package, support controls and contracts.

Potential starting hypothesis: a 5-user base with transparent expansion and unlimited viewers; competitor anchors currently range from TestRail’s $22–$78/user-month and Qase’s $35/user-month to Testmo’s bundled $59/$249/$599 plans and Katalon’s stated $80/seat-month. Validate willingness to pay against saved lead/reporting time and reduced release risk. Avoid opaque execution-volume charges at first; use fair-use quotas for storage/automation ingestion.

Onboarding target: create organization → project → import/sample → create run → execute one case → see readiness in under 15 minutes. Sample data must be an optional isolated project removable in one action.

## AA. External Pilot Gate

All must pass before inviting an external organization:

- Formal tenant-isolation threat model and automated horizontal/vertical/IDOR suite.
- Authenticated integration path; no open proxy; server-side encrypted secrets or explicitly disabled integrations.
- Distributed login/API/import/export/upload rate limits and edge WAF baseline.
- Staging, structured production monitoring, uptime check and actionable alerts.
- Scheduled backup and successfully rehearsed restore; stable tenant export/import.
- Private security contact, severity/incident/support process and owner rotation.
- Privacy/terms/pilot agreement, data location/subprocessor statement and IP clearance.
- Versioned repository/run model sufficient to prevent historical execution mutation.
- Supported-browser/accessibility baseline and onboarding documentation.
- No known Critical/High vulnerability; dependency/code/secret scanning gates operational.

## AB. Paid Launch Gate

External pilot gate plus: billing/trial/entitlement and cancellation; customer recovery and verified email flows; documented RPO/RTO backed by drills; data export/deletion/termination; production SLO/support position and status communication; migration tooling/report; secure evidence storage; API lifecycle; customer onboarding; audit logs for key actions; vulnerability SLAs and patch process; legal terms/DPA/privacy; usage/plan administration; independent penetration test covering auth, isolation, integrations, uploads, API, billing and admin.

## AC. Enterprise Gate

SAML/OIDC enterprise federation; SCIM create/deactivate/group sync; custom role capability; audit export and retention policy; security questionnaire/evidence package; customer-approved support access; contractual support/incident terms; data residency only if demanded; compliance program evidence; large-scale/load and DR exercises; procurement/vendor-risk materials.

## AD. Technical Debt Register

| Severity | Debt (not normal future scope) | Customer impact | Timing |
|---|---|---|---|
| High | Open fixed-upstream integration proxies rely on CORS | Abuse/cost/reputation | Before external pilot |
| High | Browser-local integration credentials | Device compromise and weak revocation/audit | Before external integrations |
| High | Broad shared-record model couples domains | Migration/query/authorization cost grows nonlinearly | Start boundaries now |
| High | Production/staging/release identity process is manual | Version drift and unsafe validation | Phase 0 |
| Medium | PBKDF2 work-factor claim may be stale | Weakening password assurance | Phase 0 benchmark |
| Medium | CI actions not SHA-pinned | Supply-chain exposure | Phase 0 |
| Medium | Asia/Tokyo embedded as business default | Incorrect global reports | Before non-Japan pilot |
| Medium | Overlapping Dashboard/Overall/Cycles/Daily screens | Adoption and training cost | Execution-core UX phase |
| Medium | Current result and aggregate models can diverge | Readiness trust | Repository/run migration |
| Low | Worker/tooling package/version terminology | Operator confusion | Documentation cleanup |

## AE. Security Risk Register

| Severity | Threat | Likelihood/impact | Existing control | Missing control / mitigation | Phase |
|---|---|---|---|---|---|
| Critical trigger | Cross-tenant object access | Low/critical | Principal-derived tenant, DO isolation, tests | Continuous formal matrix/fuzz/load coverage | P0 ongoing |
| High | Proxy abuse/credential relay | Medium/high | Fixed upstream/path/method limits | Authenticate tenant-scoped requests; fold behind API | P0 |
| High | Stolen browser integration token | Medium/high | Device-local, excluded from backups | Encrypted server custody, rotation, audit | P0/P1 |
| High | Brute force/DoS across isolates | Medium/high | Per-account lockout, size limits | Distributed rate limits/WAF/bot policy | P0 |
| High | Missing detection/restore | Medium/high | logs, manual backup/revision | alerts, scheduled backups, restore drills | P0 |
| High | SSRF in future connectors/webhooks | Medium/high | current fixed upstream | egress validation, DNS/IP checks, allowlists | P1 |
| High | Attachment malware/active content | Medium/high once built | none because feature absent | quarantine, sniffing, private R2, scanning | P1 |
| Medium | XSS from imports/Jira/rich text | Medium/high | React escaping/CSP | sanitizer policy and regression corpus | P1 |
| Medium | CSV formula injection | Medium/medium | export helpers need explicit verification | prefix dangerous cells, tests | P0 |
| Medium | Session theft/replay | Low/high | secure cookie, revocation, recheck | device/session UI, anomaly/rate signals | P1 |
| Medium | Supply-chain compromise | Low/high | lockfiles, audit, CodeQL, Dependabot | SHA pinning, provenance/signing, secret scanning | P0/P1 |
| Medium | Audit tampering/insufficient events | Medium/medium | registry and revision history | immutable audit store/export/retention | P1 |

## AF. Prioritized Roadmap

### Phase 0 — Stabilize and validate the pilot

Objective: remove external-pilot safety blockers without changing product semantics. Work: formal threat model; authenticated proxy replacement/disablement; distributed rate limits/WAF; monitoring/alerts; scheduled backups/restore drill; staging; action pinning/secret scanning; KDF benchmark; timezone/config inventory; release artifact discipline; customer interviews. Acceptance: AA technical controls green, current suites remain green, restore and incident drills recorded. Defer billing, AI and repository rewrite.

### Phase 1 — Commercial foundation

Objective: establish Organization/Workspace/Project, customer OIDC, secure secret custody, audit/security events, quotas, support access, legal/data lifecycle and guided onboarding. Migration: wrap current tenants as organizations/workspaces without moving QA content. Acceptance: two external test organizations cannot cross boundaries in automated/manual tests; self/on-behalf onboarding is auditable; integrations never expose credentials to browsers.

### Phase 2 — Professional execution core

Objective: canonical Release/Plan/Cycle/Run/Instance/Execution model; My Testing workspace; semantic statuses; build/environment; private attachments; defect links. Migration: dual-read old cases/results/executions and pin legacy case version. Acceptance: execution remains historically identical after case edits; step/evidence/defect workflow works keyboard-first; readiness derives from pinned facts.

### Phase 3 — Repository and traceability

Objective: folders/suites, immutable versions, draft/publish/diff/restore, requirements/Jira links, traceability and coverage definitions, import pipeline. Acceptance: matrix connects requirement → version → run → execution → defect → release; migration dry runs are idempotent and reversible. Defer unconstrained workflow/custom-field engines.

### Phase 4 — Automation and platform integrations

Objective: `/api/v1`, service accounts, JUnit/normalized ingestion, CI adapters, webhooks and Jira production connector. Acceptance: retries/idempotency/provenance preserved; keys scoped/rotatable; webhook signatures/replay tests pass. Defer customer-code execution and dozens of connectors.

### Phase 5 — Reporting and release intelligence

Objective: role dashboards, readiness criteria/sign-off, manual+automation trends, scheduled reports and team capacity/flow. Acceptance: metrics have definitions and drill-through; no employee ranking; readiness snapshots are reproducible. Add exploratory sessions only if research validates demand.

### Phase 6 — SaaS commercial operations

Objective: plans/trials/seats, Stripe or selected provider, usage/entitlements, dunning/cancellation, product analytics, support/status processes. Acceptance: paid-launch gate, data deletion/export, billing reconciliation and privacy-conscious analytics. Billing provider is [OWNER].

### Phase 7 — Enterprise security and governance

Objective: SAML, SCIM, custom roles, audit export, retention, support controls, compliance evidence and demand-led residency. Acceptance: Enterprise gate and independent assessment. Do not claim certifications until obtained.

### Phase 8 — AI and advanced differentiation

Objective: opt-in draft generation, duplicate detection, regression suggestions, failure clustering and report summaries. Human review, provenance, tenant disable switch, provider retention terms and no authoritative silent edits are mandatory. MCP may expose scoped read/action tools after API/policy stability. Never score employee performance.

## AG. P0 / P1 / P2 / P3 Matrix

| Priority | Capabilities |
|---|---|
| P0 | Isolation proof, authenticated integrations, secure secrets, rate limits/WAF, staging/monitoring/backups, versioned execution foundation, migration dry run |
| P1 | Execution workspace/evidence, repository versions, Jira defects, release/build/environment, API + JUnit ingestion, onboarding, billing/legal paid gate |
| P2 | Traceability depth, configurable dashboards/reports, Slack/Teams/email, exploratory sessions, custom roles/fields, SAML/SCIM |
| P3 | Multi-region residency, advanced search infrastructure, broad connector catalog, AI/MCP, complex enterprise workflows |

Priority scoring rule: P0 requires security necessity or architectural dependency plus high customer/revenue value; P1 is sellability; P2 is growth/enterprise leverage; P3 is demand-led. Complexity and migration risk lower priority unless the item unlocks safety.

## AH. DO NOT BUILD YET

- A full Jira/ALM replacement or internal defect tracker beyond lightweight findings/links.
- A microservices rewrite or speculative PostgreSQL migration.
- A native mobile app; responsive evidence capture is enough initially.
- A generic no-code workflow engine or unlimited dynamic schema.
- Two-way synchronization with every test-management vendor.
- Customer test-code execution/no-code browser cloud.
- SCIM, multi-region residency or complex contract billing before demand.
- AI test generation as the headline, autonomous authoritative edits, or employee scoring.
- Dozens of CI/chat connectors before the generic API/webhook contracts work.
- Offline execution until interviews prove poor-network work is a decisive need.

## AI. Architecture Decisions Requiring Owner Approval

1. [OWNER] Position/name: QA Operations & Release Readiness versus broad test management; trademark/branding clearance.
2. [OWNER] Primary ICP and Japan-first go-to-market.
3. [OWNER] Organization/workspace packaging and active-tester pricing hypothesis.
4. [OWNER] Identity provider strategy and whether native passwords remain commercially supported.
5. [OWNER] Database migration triggers—not a migration now.
6. [OWNER] Secret-encryption/key-management provider and data region.
7. [OWNER] Billing/email/observability vendors and subprocessors.
8. [OWNER] Compliance targets based on actual pipeline (SOC 2/ISO/APPI/GDPR).
9. [OWNER] TestRail as import-first rather than permanent sync.
10. [OWNER] Whether local-only mode is a supported product tier or demo/migration tool.
11. [OWNER] AI provider/data policy; no AI work before approval.
12. [OWNER] IP/employment/repository visibility and company-specific configuration cleanup.

ADRs required: tenant hierarchy; identity; authorization policy; execution/version model; primary data store triggers; attachments/R2; integration secret custody; public API versioning; immutable audit; async jobs; release artifact process; billing boundary; AI data policy.

## AJ. Recommended Next Development Phase

**Next phase specification: Phase 0 — External-Pilot Safety and Architecture Baseline.** It should be implemented as a separate, reviewable program with no new buyer-facing feature breadth.

### Objectives

1. Prove and continuously test tenant isolation across every existing channel.
2. Eliminate unauthenticated integration proxy use and browser-held commercial credentials.
3. Establish staging, monitoring, rate limiting, backup/restore and a deterministic release artifact.
4. Produce accepted ADRs for product position, tenancy, identity, execution/versioning and data architecture.

### Work packages

**P0.1 Threat model and authorization coverage:** enumerate assets/actors/trust boundaries; map all HTTP/WS/import/export/history/admin operations to named permissions; add horizontal, vertical, IDOR, forged-tenant, disabled-user, revoked-session, backup and WebSocket isolation tests; verify Super Admin cannot read content. Deliver `TENANT_ISOLATION_THREAT_MODEL.md` and an executable matrix.

**P0.2 Integration containment:** choose either (a) temporarily disable external integrations for external pilots, or (b) route them through the authenticated main Worker. No browser-selectable arbitrary upstream. Design encrypted per-tenant credentials, rotation/deletion/redaction and audit; add SSRF, header stripping, rate/backoff and tenant-isolation tests. Do not migrate live credentials without owner-approved recovery and rollback.

**P0.3 Edge/application abuse controls:** define per-route limits for login, reset, WebSocket upgrade/messages, commits, imports/exports and admin actions; configure staging first; return stable 429 errors; test account enumeration resistance and rate-limit isolation. WAF supplements but never replaces authorization.

**P0.4 Operations:** create isolated staging bindings/data; structured dashboards and alerts; external uptime check; incident severity/runbook; scheduled encrypted snapshots; restore into a scratch tenant and verify hashes/counts; document measured RPO/RTO. No production configuration change until staging evidence and owner approval.

**P0.5 Release integrity and supply chain:** pin Actions to SHAs; enable supported repository scanning settings through an owner checklist; build once from an immutable release candidate and promote the same artifact; require version/tag/commit consistency; generate SBOM and record Cloudflare Version ID; prevent production/product identity drift.

**P0.6 Architecture/product validation:** interview at least five ICP teams using their real release workflow; test the Command Center/capacity/readiness positioning and active-tester pricing; inventory case/run terminology and data; approve ADRs. This research may change Phase 2 scope.

### Tests and release blockers

Release blockers: full existing TypeScript/lint/frontend/Worker/runtime/prod-sim/browser suites; authorization and tenant matrix; integration SSRF/secret-redaction tests; distributed rate tests; staging smoke; backup/restore drill; security-header/CSRF/session revocation tests; dependency/SAST/secret scans. Add load characterization, not unsupported scale claims.

### Acceptance criteria

- No unauthenticated integration proxy is available to an external pilot.
- Customer integration credentials never appear in client storage, ordinary records, logs, exports or backups.
- Cross-tenant access is denied and tested for HTTP, WS, history, backup, export and admin surfaces.
- Alerts are demonstrated with synthetic failures; an operator can identify request/tenant without sensitive content.
- A scheduled backup restores successfully in isolation with a recorded result.
- Staging is operationally separate from production.
- One immutable release identity connects source commit, tag, build artifact and Cloudflare Version ID.
- Owner approves or explicitly defers the Phase 0 ADRs.
- External Pilot Gate is reviewed; any remaining exception has an owner, expiry and compensating control.

### Deliberately deferred

No billing, attachments, AI, new database, generalized public API, SCIM, custom workflow engine, major navigation redesign or broad feature development. Phase 0 creates the safe base and validates the market thesis; Phase 2 execution work begins only after these gates and owner decisions.

---

## Evidence Appendix

Key repository evidence reviewed: `docs/ARCHITECTURE.md`, `docs/QA_EXECUTION.md`, `docs/SAAS_READINESS.md`, `docs/DEPLOYMENT_PLAN.md`, `docs/RELEASING.md`, `docs/PRODUCTION_SMOKE.md`, `SECURITY.md`, `shared/protocol.ts`, `shared/testManagement.ts`, `shared/tenancy.ts`, `worker/src/{auth,sessions,permissions,registry,workspaceRoom,http,index}.ts`, frontend navigation/features/domain modules, proxy Workers, Wrangler configuration and all GitHub workflows. The pilot.10 release verification recorded 2,731 frontend tests, 374 Worker core tests, 328 Worker runtime tests, 34 production-simulation tests and 7 Chromium smoke tests passing; those counts demonstrate breadth, not absence of undiscovered defects.

Market facts were checked against the primary vendor pages linked in sections F/G/Z on 2026-11-16. Vendor pages describe vendor claims and packaging, which can change; pricing must be reconfirmed before commercial decisions. Recommendations and competitive positioning remain hypotheses until customer discovery validates them.
