import { afterEach, describe, expect, it, vi } from 'vitest';
import { activateWeb, addUser, call, createTenant, email, get } from './tenancy-harness';

const config = (baseUrl: string, token: string) => ({
  baseUrl,
  jiraType: 'cloud',
  email: 'jira-user@example.com',
  token,
});

afterEach(() => vi.restoreAllMocks());

async function configuredTenant(label: string) {
  const tenant = await createTenant(label, email('admin'));
  await activateWeb(tenant, []);
  expect((await call(tenant.adminEmail, 'PUT', '/api/tenant/integrations/jira', config('https://mock.atlassian.net', 'never-log-me'))).status).toBe(200);
  return tenant;
}

describe('tenant Jira integration routes', () => {
  it('requires an authenticated active tenant administrator', async () => {
    const tenant = await createTenant('Integration auth', email('admin'));
    await activateWeb(tenant, []);
    const editor = email('editor');
    await addUser(tenant, editor);

    expect((await call('', 'GET', '/api/tenant/integrations/jira')).status).toBe(403);
    expect((await get(editor, '/api/tenant/integrations/jira')).status).toBe(403);
    expect((await call(editor, 'PUT', '/api/tenant/integrations/jira', config('https://auth.atlassian.net', 'secret'))).status).toBe(403);
  });

  it('stores only redacted tenant-scoped status and prevents cross-tenant access', async () => {
    const a = await createTenant('Integration A', email('admin-a'));
    const b = await createTenant('Integration B', email('admin-b'));
    await activateWeb(a, []);
    await activateWeb(b, []);

    const saved = await call<Record<string, unknown>>(a.adminEmail, 'PUT', '/api/tenant/integrations/jira', config('https://alpha.atlassian.net', 'TOP-SECRET-TOKEN'));
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain('TOP-SECRET-TOKEN');
    expect(saved.json).toMatchObject({ configured: true, jiraType: 'cloud', baseUrl: 'https://alpha.atlassian.net', credentialVersion: 1 });

    const other = await get<Record<string, unknown>>(b.adminEmail, '/api/tenant/integrations/jira');
    expect(other.status).toBe(200);
    expect(other.json).toEqual({ configured: false });
    expect((await call(b.adminEmail, 'GET', `/api/tenant/integrations/jira?tenantId=${a.id}`)).status).toBe(403);

    const replaced = await call<Record<string, unknown>>(a.adminEmail, 'PUT', '/api/tenant/integrations/jira', config('https://alpha.atlassian.net', 'REPLACEMENT'));
    expect(replaced.status).toBe(200);
    expect(replaced.json.credentialVersion).toBe(2);
    expect((await call(a.adminEmail, 'DELETE', '/api/tenant/integrations/jira')).json).toMatchObject({ configured: false, removed: true });
  });

  it('rejects unapproved Jira targets and unsupported data-center credentials', async () => {
    const tenant = await createTenant('Integration validation', email('admin'));
    await activateWeb(tenant, []);
    for (const body of [
      config('http://tenant.atlassian.net', 'secret'),
      config('https://tenant.atlassian.net.evil.example', 'secret'),
      { ...config('https://jira.internal.example', 'secret'), jiraType: 'data-center' },
    ]) {
      expect((await call(tenant.adminEmail, 'PUT', '/api/tenant/integrations/jira', body)).status).toBe(400);
    }
  });

  it('fails closed when Jira is not configured and ignores caller-supplied upstream URLs', async () => {
    const tenant = await createTenant('Integration not configured', email('admin'));
    await activateWeb(tenant, []);
    const result = await call<{ error: string }>(tenant.adminEmail, 'POST', '/api/integrations/jira/search', { jql: 'project = QA', url: 'https://evil.example' });
    expect(result.status).toBe(409);
    expect(result.json.error).toBe('integration_not_configured');
  });

  it.each([
    [401, 'invalid_credentials', 401],
    [403, 'invalid_credentials', 401],
    [429, 'rate_limited', 429],
    [500, 'jira_error', 502],
  ])('sanitizes upstream status %i as %s', async (upstreamStatus, error, expectedStatus) => {
    const tenant = await configuredTenant(`Integration error ${upstreamStatus}`);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ sensitive: 'not returned' }), { status: upstreamStatus, headers: { 'content-type': 'application/json' } }));
    const result = await call<{ error: string }>(tenant.adminEmail, 'POST', '/api/integrations/jira/search', { jql: 'project = QA' });
    expect(result.status).toBe(expectedStatus);
    expect(result.json.error).toBe(error);
    expect(result.text).not.toContain('sensitive');
  });

});
