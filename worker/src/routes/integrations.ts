import type { JiraIssue } from '../../../shared/jira';
import type { MemberPrincipal } from '../permissions';
import { actorOf, json, need, problem, readJson, roomFor, type Ctx } from '../http';
import { decryptCredential, encryptCredential, validateJiraBaseUrl } from '../integrationCredentials';
import { logEvent } from '../log';
import type { IntegrationConnectionRow } from '../store';

const MAX_JQL = 5_000;
const MAX_TOTAL = 500;
const PAGE_SIZE = 100;
const UPSTREAM_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const ISSUE_FIELDS = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'reporter', 'labels', 'created', 'updated', 'versions', 'description'];

type IntegrationEnv = Env & { INTEGRATION_CREDENTIAL_KEY?: string };

function keyOf(ctx: Ctx): string | null {
  const key = (ctx.env as IntegrationEnv).INTEGRATION_CREDENTIAL_KEY;
  return typeof key === 'string' && key.trim() !== '' ? key : null;
}

function redacted(row: IntegrationConnectionRow | null): Record<string, unknown> {
  return row === null ? { configured: false } : {
    configured: true,
    jiraType: row.jira_type,
    baseUrl: row.base_url,
    lastVerifiedAt: row.last_verified_at,
    credentialStatus: row.credential_status,
    credentialVersion: row.credential_version,
  };
}

function nameOf(v: unknown): string | undefined {
  return typeof v === 'object' && v !== null && typeof (v as { name?: unknown }).name === 'string' ? (v as { name: string }).name : undefined;
}
function displayNameOf(v: unknown): string | undefined {
  return typeof v === 'object' && v !== null && typeof (v as { displayName?: unknown }).displayName === 'string' ? (v as { displayName: string }).displayName : undefined;
}
function plainDescription(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 20_000);
  return '';
}
function mapIssue(raw: unknown): JiraIssue {
  const r = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  const f = typeof r.fields === 'object' && r.fields !== null ? r.fields as Record<string, unknown> : {};
  const status = typeof f.status === 'object' && f.status !== null ? f.status as Record<string, unknown> : {};
  const category = typeof status.statusCategory === 'object' && status.statusCategory !== null ? status.statusCategory as Record<string, unknown> : {};
  const versions = Array.isArray(f.versions) ? f.versions.map(nameOf).filter((v): v is string => v !== undefined) : [];
  return {
    id: typeof r.id === 'string' ? r.id : '', key: typeof r.key === 'string' ? r.key : '',
    summary: typeof f.summary === 'string' ? f.summary : '', statusName: nameOf(f.status) ?? '',
    statusCategoryName: typeof category.name === 'string' ? category.name : undefined,
    typeName: nameOf(f.issuetype) ?? '', priorityName: nameOf(f.priority), assigneeName: displayNameOf(f.assignee), reporterName: displayNameOf(f.reporter),
    labels: Array.isArray(f.labels) ? f.labels.filter((v): v is string => typeof v === 'string') : [],
    created: typeof f.created === 'string' ? f.created : undefined, updated: typeof f.updated === 'string' ? f.updated : undefined,
    affectedVersions: versions, descriptionPlain: plainDescription(f.description),
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error('jira_response_too_large');
  if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) throw new Error('jira_invalid_response');
  const reader = response.body?.getReader();
  if (reader === undefined) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('jira_response_too_large'); }
    chunks.push(part.value);
  }
  const all = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(all)); } catch { throw new Error('jira_invalid_response'); }
}

function upstreamProblem(status: number): { status: number; error: string } {
  if (status === 401 || status === 403) return { status: 401, error: 'invalid_credentials' };
  if (status === 429) return { status: 429, error: 'rate_limited' };
  return { status: 502, error: status >= 500 ? 'jira_error' : 'invalid_configuration' };
}

function basicAuth(email: string, token: string): string {
  const bytes = new TextEncoder().encode(`${email}:${token}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function jiraSearch(ctx: Ctx, p: MemberPrincipal, jql: string, maxTotal: number): Promise<{ ok: true; issues: JiraIssue[] } | { ok: false; response: Response }> {
  const room = roomFor(ctx, p);
  const row = await room.getIntegration(p.tenantId, 'jira');
  if (row === null) return { ok: false, response: problem(409, 'integration_not_configured') };
  if (row.jira_type !== 'cloud') return { ok: false, response: problem(409, 'unsupported_jira_type') };
  const key = keyOf(ctx);
  if (key === null) return { ok: false, response: problem(503, 'integration_encryption_unavailable') };
  let credential;
  try { credential = await decryptCredential(key, p.tenantId, row); }
  catch { return { ok: false, response: problem(503, 'integration_credential_unreadable') }; }
  const email = credential.email?.trim() ?? '';
  if (email === '') return { ok: false, response: problem(409, 'invalid_configuration') };
  const auth = basicAuth(email, credential.token);
  const issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  try {
    do {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(`${row.base_url}/rest/api/3/search/jql`, {
          method: 'POST', redirect: 'manual', signal: controller.signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
          body: JSON.stringify({ jql, fields: ISSUE_FIELDS, maxResults: PAGE_SIZE, ...(nextPageToken === undefined ? {} : { nextPageToken }) }),
        });
      } finally { clearTimeout(timer); }
      if (response.status >= 300 && response.status < 400) return { ok: false, response: problem(502, 'invalid_configuration') };
      if (!response.ok) { const mapped = upstreamProblem(response.status); return { ok: false, response: problem(mapped.status, mapped.error) }; }
      const payload = await boundedJson(response) as { issues?: unknown[]; nextPageToken?: unknown };
      const page = Array.isArray(payload?.issues) ? payload.issues : [];
      for (const issue of page) issues.push(mapIssue(issue));
      nextPageToken = typeof payload?.nextPageToken === 'string' && payload.nextPageToken !== '' ? payload.nextPageToken : undefined;
      if (issues.length >= maxTotal) issues.length = maxTotal;
      if (page.length === 0) nextPageToken = undefined;
    } while (nextPageToken !== undefined && issues.length < maxTotal);
    return { ok: true, issues };
  } catch (error) {
    return { ok: false, response: problem(502, error instanceof Error && error.name === 'AbortError' ? 'unreachable' : 'unreachable') };
  }
}

export async function integrationRoutes(ctx: Ctx, p: MemberPrincipal): Promise<Response | null> {
  const path = ctx.path;
  if (!path.startsWith('/api/integrations/jira') && path !== '/api/tenant/integrations/jira') return null;
  const room = roomFor(ctx, p);
  if (path === '/api/tenant/integrations/jira' && ctx.method === 'GET') {
    const denial = need(ctx, 'integrations.view'); if (denial !== null) return denial;
    return json(redacted(await room.getIntegration(p.tenantId, 'jira')));
  }
  if (path === '/api/tenant/integrations/jira' && ctx.method === 'PUT') {
    const denial = need(ctx, 'integrations.manage'); if (denial !== null) return denial;
    const body = await readJson(ctx); if (!body.ok) return body.response;
    const validated = validateJiraBaseUrl(body.body.baseUrl, body.body.jiraType ?? body.body.flavor ?? 'auto');
    if (!validated.ok) return problem(400, validated.error);
    const email = typeof body.body.email === 'string' ? body.body.email.trim() : '';
    const token = typeof body.body.token === 'string' ? body.body.token.trim() : '';
    if (email === '' || email.length > 254 || token === '' || token.length > 8_192) return problem(400, 'invalid_configuration');
    const key = keyOf(ctx); if (key === null) return problem(503, 'integration_encryption_unavailable');
    const previous = await room.getIntegration(p.tenantId, 'jira');
    const credentialVersion = (previous?.credential_version ?? 0) + 1;
    const envelope = await encryptCredential(key, p.tenantId, 'jira', credentialVersion, { email, token });
    const now = new Date().toISOString();
    const saved = await room.putIntegration(p.tenantId, {
      kind: 'jira', jira_type: validated.jiraType, base_url: validated.baseUrl,
      encryption_version: envelope.encryptionVersion, key_version: envelope.keyVersion, nonce: envelope.nonce, ciphertext: envelope.ciphertext,
      credential_version: credentialVersion, updated_at: now, updated_by: p.userId, last_verified_at: null, credential_status: 'configured',
    });
    await ctx.registry.appendAudit({ action: previous === null ? 'integration.jira_configured' : 'integration.jira_replaced', actor: actorOf(p), tenantId: p.tenantId, meta: { provider: 'jira', credentialVersion: saved.credential_version } });
    logEvent('info', 'jira_credential_saved', { tenantId: p.tenantId, credentialVersion: saved.credential_version });
    return json(redacted(saved));
  }
  if (path === '/api/tenant/integrations/jira' && ctx.method === 'DELETE') {
    const denial = need(ctx, 'integrations.manage'); if (denial !== null) return denial;
    const removed = await room.deleteIntegration(p.tenantId, 'jira');
    if (removed) await ctx.registry.appendAudit({ action: 'integration.jira_removed', actor: actorOf(p), tenantId: p.tenantId, meta: { provider: 'jira' } });
    return json({ configured: false, removed });
  }
  if (path === '/api/integrations/jira/test' && ctx.method === 'POST') {
    const denial = need(ctx, 'integrations.manage'); if (denial !== null) return denial;
    const result = await jiraSearch(ctx, p, 'ORDER BY created DESC', 1);
    const ok = result.ok;
    await room.setIntegrationVerified(p.tenantId, 'jira', ok ? 'verified' : 'invalid');
    await ctx.registry.appendAudit({ action: 'integration.jira_tested', actor: actorOf(p), tenantId: p.tenantId, meta: { provider: 'jira', success: ok } });
    return result.ok ? json({ ok: true, count: result.issues.length }) : result.response;
  }
  if (path === '/api/integrations/jira/search' && ctx.method === 'POST') {
    const denial = need(ctx, 'integrations.use'); if (denial !== null) return denial;
    const body = await readJson(ctx); if (!body.ok) return body.response;
    const jql = typeof body.body.jql === 'string' ? body.body.jql.trim() : '';
    const maxTotal = Math.min(MAX_TOTAL, Math.max(1, Number(body.body.maxTotal ?? MAX_TOTAL) || MAX_TOTAL));
    if (jql === '' || jql.length > MAX_JQL) return problem(400, 'invalid_configuration');
    const result = await jiraSearch(ctx, p, jql, maxTotal);
    return result.ok ? json({ issues: result.issues }) : result.response;
  }
  return problem(405, 'method_not_allowed');
}
