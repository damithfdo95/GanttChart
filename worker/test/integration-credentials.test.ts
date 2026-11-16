import { describe, expect, it } from 'vitest';
import { decryptCredential, encryptCredential, validateJiraBaseUrl } from '../src/integrationCredentials';
import type { IntegrationConnectionRow } from '../src/store';

const KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));
const rowOf = (e: Awaited<ReturnType<typeof encryptCredential>>): IntegrationConnectionRow => ({
  kind: 'jira', jira_type: 'cloud', base_url: 'https://acme.atlassian.net', encryption_version: e.encryptionVersion,
  key_version: e.keyVersion, nonce: e.nonce, ciphertext: e.ciphertext, credential_version: 1,
  created_at: '2026-11-16T00:00:00Z', updated_at: '2026-11-16T00:00:00Z', updated_by: 'usr_1', last_verified_at: null, credential_status: 'configured',
});

describe('integration credential encryption', () => {
  it('round trips with tenant-bound authenticated encryption and random nonces', async () => {
    const a = await encryptCredential(KEY, 'ten_a', 'jira', 1, { email: 'sv@example.com', token: 'secret-token' });
    const b = await encryptCredential(KEY, 'ten_a', 'jira', 1, { email: 'sv@example.com', token: 'secret-token' });
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.nonce).not.toBe(b.nonce);
    expect(await decryptCredential(KEY, 'ten_a', rowOf(a))).toEqual({ email: 'sv@example.com', token: 'secret-token' });
    expect(JSON.stringify(a)).not.toContain('secret-token');
  });

  it('fails closed for wrong keys, tenants, tampering, malformed nonce and versions', async () => {
    const encrypted = await encryptCredential(KEY, 'ten_a', 'jira', 1, { token: 'secret-token' });
    const row = rowOf(encrypted);
    const otherKey = btoa('x'.repeat(32));
    await expect(decryptCredential(otherKey, 'ten_a', row)).rejects.toThrow('integration_credential_unreadable');
    await expect(decryptCredential(KEY, 'ten_b', row)).rejects.toThrow('integration_credential_unreadable');
    await expect(decryptCredential(KEY, 'ten_a', { ...row, ciphertext: row.ciphertext.slice(0, -2) + 'AA' })).rejects.toThrow();
    await expect(decryptCredential(KEY, 'ten_a', { ...row, nonce: 'bad' })).rejects.toThrow();
    await expect(decryptCredential(KEY, 'ten_a', { ...row, encryption_version: 99 })).rejects.toThrow('integration_envelope_unsupported');
  });
});

describe('Jira SaaS target policy', () => {
  it('accepts only normalized Atlassian Cloud origins', () => {
    expect(validateJiraBaseUrl('https://acme.atlassian.net/', 'cloud')).toEqual({ ok: true, baseUrl: 'https://acme.atlassian.net', jiraType: 'cloud' });
    for (const url of ['http://acme.atlassian.net', 'https://localhost', 'https://127.0.0.1', 'https://169.254.169.254', 'https://user:pass@acme.atlassian.net', 'https://acme.atlassian.net:444', 'https://evil.example.com', 'https://acme.atlassian.net/path']) {
      expect(validateJiraBaseUrl(url, 'cloud').ok, url).toBe(false);
    }
    expect(validateJiraBaseUrl('https://jira.internal.example', 'dc')).toEqual({ ok: false, error: 'unsupported_jira_type' });
  });
});
