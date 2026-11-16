import type { IntegrationConnectionRow } from './store';

export const INTEGRATION_ENCRYPTION_VERSION = 1;
export const INTEGRATION_KEY_VERSION = 'v1';

export interface JiraCredentialPayload { email?: string; token: string }
export interface EncryptedCredential { encryptionVersion: number; keyVersion: string; nonce: string; ciphertext: string }

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch { throw new Error('integration_key_invalid'); }
}

async function importKey(encoded: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(encoded.trim());
  if (bytes.byteLength !== 32) throw new Error('integration_key_invalid');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function aad(tenantId: string, provider: string, credentialVersion: number): Uint8Array {
  return new TextEncoder().encode(`gc-integration\0${INTEGRATION_ENCRYPTION_VERSION}\0${tenantId}\0${provider}\0${credentialVersion}`);
}

export async function encryptCredential(keyMaterial: string, tenantId: string, provider: 'jira', credentialVersion: number, payload: JiraCredentialPayload): Promise<EncryptedCredential> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(keyMaterial);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(tenantId, provider, credentialVersion), tagLength: 128 }, key, plaintext);
  return { encryptionVersion: INTEGRATION_ENCRYPTION_VERSION, keyVersion: INTEGRATION_KEY_VERSION, nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(new Uint8Array(encrypted)) };
}

export async function decryptCredential(keyMaterial: string, tenantId: string, row: IntegrationConnectionRow): Promise<JiraCredentialPayload> {
  if (row.encryption_version !== INTEGRATION_ENCRYPTION_VERSION || row.key_version !== INTEGRATION_KEY_VERSION) throw new Error('integration_envelope_unsupported');
  try {
    const nonce = base64ToBytes(row.nonce);
    if (nonce.byteLength !== 12) throw new Error('bad nonce');
    const key = await importKey(keyMaterial);
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(tenantId, row.kind, row.credential_version), tagLength: 128 }, key, base64ToBytes(row.ciphertext));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(clear));
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { token?: unknown }).token !== 'string' || (parsed as { token: string }).token === '') throw new Error('bad payload');
    return parsed as JiraCredentialPayload;
  } catch (error) {
    if (error instanceof Error && error.message === 'integration_key_invalid') throw error;
    throw new Error('integration_credential_unreadable');
  }
}

export function validateJiraBaseUrl(raw: unknown, flavor: unknown): { ok: true; baseUrl: string; jiraType: 'cloud' } | { ok: false; error: string } {
  if (flavor !== 'cloud' && flavor !== 'auto') return { ok: false, error: flavor === 'dc' ? 'unsupported_jira_type' : 'invalid_configuration' };
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_configuration' };
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.port !== '') return { ok: false, error: 'invalid_configuration' };
    const host = url.hostname.toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/.test(host)) return { ok: false, error: 'forbidden_jira_target' };
    if (url.pathname !== '' && url.pathname !== '/') return { ok: false, error: 'invalid_configuration' };
    return { ok: true, baseUrl: `https://${host}`, jiraType: 'cloud' };
  } catch { return { ok: false, error: 'invalid_configuration' }; }
}
