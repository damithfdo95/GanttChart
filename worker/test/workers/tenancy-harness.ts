import { exports } from 'cloudflare:workers';
import { REPLACE_CONFIRMATION, canonicalRecordsHash, type PrincipalDto, type TenantDto, type TenantSummaryDto, type UserDto } from '../../../shared/tenancy';
import { PROTOCOL_VERSION, type RecordPut } from '../../../shared/protocol';
import { wrap, type TestSocket } from './helpers';

/**
 * End-to-end harness: every call goes through the REAL Worker entry (origin
 * checks, authentication, registry lookup, authorization, routing) with a
 * development identity chosen per call. Nothing is mocked.
 */

export const BASE = 'http://localhost:8787';
export const SUPER = 'super@dev.test'; // SUPER_ADMIN_EMAILS in wrangler.test.jsonc

let counter = 0;
/** A unique, valid email per test so tests never collide in the shared registry. */
export function email(label: string): string {
  counter += 1;
  return `${label}-${counter}-${crypto.randomUUID().slice(0, 8)}@tenant.test`;
}

export interface ApiResult<T = Record<string, unknown>> {
  status: number;
  json: T;
  text: string;
}

export async function call<T = Record<string, unknown>>(as: string, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<ApiResult<T>> {
  const res = await exports.default.fetch(
    new Request(BASE + path, {
      method,
      headers: {
        'x-dev-email': as,
        Origin: BASE,
        'x-gc-intent': 'test',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let json: unknown = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json: json as T, text };
}

export const get = <T = Record<string, unknown>>(as: string, path: string, headers?: Record<string, string>) => call<T>(as, 'GET', path, undefined, headers);
export const post = <T = Record<string, unknown>>(as: string, path: string, body?: unknown) => call<T>(as, 'POST', path, body ?? {});
export const patch = <T = Record<string, unknown>>(as: string, path: string, body: unknown) => call<T>(as, 'PATCH', path, body);

/** A record as the app stores it: its JSON carries its own id. */
export function rec(kind: RecordPut['kind'], id: string, extra: Record<string, unknown> = {}): RecordPut {
  return { kind, id, json: JSON.stringify({ id, ...extra }) };
}

export async function hashOf(records: RecordPut[]): Promise<string> {
  return canonicalRecordsHash(records);
}

// ---- scenario builders ----

export interface Tenant {
  id: string;
  name: string;
  adminEmail: string;
}

/** Super Admin creates a tenant (local mode) with its Admin. */
export async function createTenant(name: string, adminEmail: string): Promise<Tenant> {
  const r = await post<{ tenant: TenantDto; admin: UserDto }>(SUPER, '/api/super/tenants', { name, adminEmail });
  if (r.status !== 201) throw new Error(`createTenant failed: ${r.status} ${r.text}`);
  return { id: r.json.tenant.id, name, adminEmail };
}

/** The Admin moves the tenant to WEB storage the proper way: upload, verify, activate. */
export async function activateWeb(t: Tenant, records: RecordPut[]): Promise<{ revision: number; hash: string }> {
  const up = await post<{ revision: number; hash: string }>(t.adminEmail, '/api/tenant/storage/upload', { migrationId: `m-${crypto.randomUUID()}`, expectedRevision: 0, records });
  if (up.status !== 200) throw new Error(`upload failed: ${up.status} ${up.text}`);
  const act = await post(t.adminEmail, '/api/tenant/storage/activate-web', { revision: up.json.revision, hash: up.json.hash });
  if (act.status !== 200) throw new Error(`activate failed: ${act.status} ${act.text}`);
  return up.json;
}

export async function addUser(t: Tenant, userEmail: string, access: 'editor' | 'viewer' = 'editor'): Promise<UserDto> {
  const r = await post<{ user: UserDto }>(t.adminEmail, '/api/tenant/users', { email: userEmail, access });
  if (r.status !== 201) throw new Error(`addUser failed: ${r.status} ${r.text}`);
  return r.json.user;
}

export interface World {
  a: Tenant;
  b: Tenant;
  userA: string;
  userB: string;
  viewerA: string;
}

export const SECRET_A = 'ALPHA-CONFIDENTIAL-PROJECT';
export const SECRET_B = 'BETA-CONFIDENTIAL-PROJECT';

/** Two web tenants, each with a marker project, an editor user, and (for A) a viewer. */
export async function twoTenants(): Promise<World> {
  const a = await createTenant('Alpha QA', email('admin-a'));
  const b = await createTenant('Beta QA', email('admin-b'));
  await activateWeb(a, [rec('project', 'proj-a', { name: SECRET_A }), rec('project', 'shared-id', { name: `${SECRET_A}-shared` })]);
  await activateWeb(b, [rec('project', 'proj-b', { name: SECRET_B }), rec('project', 'shared-id', { name: `${SECRET_B}-shared` })]);
  const userA = email('user-a');
  const userB = email('user-b');
  const viewerA = email('viewer-a');
  await addUser(a, userA);
  await addUser(b, userB);
  await addUser(a, viewerA, 'viewer');
  return { a, b, userA, userB, viewerA };
}

export async function whoami(as: string): Promise<ApiResult<PrincipalDto & { reason?: string }>> {
  return get<PrincipalDto & { reason?: string }>(as, '/api/whoami');
}

export async function listTenants(): Promise<TenantSummaryDto[]> {
  return (await get<{ tenants: TenantSummaryDto[] }>(SUPER, '/api/super/tenants')).json.tenants;
}

// ---- WebSocket through the real Worker ----

export type OpenedSocket = { ok: true; sock: TestSocket; ready: Awaited<ReturnType<TestSocket['next']>> } | { ok: false; status: number; text: string };

/** Open /ws as a person and complete the hello. */
export async function openSocket(as: string, extra: { query?: string; headers?: Record<string, string> } = {}): Promise<OpenedSocket> {
  const res = await exports.default.fetch(
    new Request(`${BASE}/ws${extra.query ?? ''}`, { headers: { Upgrade: 'websocket', Origin: BASE, 'x-dev-email': as, ...(extra.headers ?? {}) } }),
  );
  if (res.status !== 101 || res.webSocket === null) return { ok: false, status: res.status, text: await res.text() };
  const sock = wrap(res.webSocket, as);
  sock.send({ t: 'hello', v: PROTOCOL_VERSION, clientId: `c-${crypto.randomUUID()}`, lastRevision: null });
  const ready = await sock.next('ready');
  return { ok: true, sock, ready };
}

export { REPLACE_CONFIRMATION };
