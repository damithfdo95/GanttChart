/**
 * Is there a shared backend behind this page, and who am I on it?
 *
 * The same build runs in two places: on a plain static host / `vite dev`
 * (no backend — the app is local-only exactly as before) and on the Worker
 * (shared). One probe tells them apart. The probe never throws.
 */

import { RECORD_KINDS, type Identity, type RecordPut, type Role } from '../../../shared/protocol';

export type ServerDetection =
  | { mode: 'server'; identity: Identity }
  /** No shared backend here (static hosting, vite dev without a proxy): keep working locally. */
  | { mode: 'local' }
  /** The sign-in session ended (Access answered with a login redirect / 401 / 403). */
  | { mode: 'login-required' }
  /** The backend answered but refused (e.g. Access not configured → fails closed with 500). */
  | { mode: 'error'; status: number }
  /** It looks like a shared deployment but the network failed. */
  | { mode: 'unreachable' };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function isRole(v: unknown): v is Role {
  return v === 'admin' || v === 'editor' || v === 'viewer';
}

export async function detectServer(fetchFn: FetchLike = (i, init) => fetch(i, init)): Promise<ServerDetection> {
  let res: Response;
  try {
    // 'manual': an Access login redirect must be detected, not silently followed to an HTML page.
    res = await fetchFn('/api/whoami', { credentials: 'same-origin', redirect: 'manual', cache: 'no-store', headers: { Accept: 'application/json' } });
  } catch {
    return { mode: 'unreachable' };
  }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) return { mode: 'login-required' };
  if (res.status === 401 || res.status === 403) return { mode: 'login-required' };
  if (res.status === 404) return { mode: 'local' };
  if (res.status >= 500) return { mode: 'error', status: res.status };
  if (!res.ok) return { mode: 'local' };
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) return { mode: 'local' }; // SPA fallback HTML: no API here
  try {
    const body = (await res.json()) as { email?: unknown; role?: unknown };
    if (typeof body.email === 'string' && body.email !== '' && isRole(body.role)) {
      return { mode: 'server', identity: { email: body.email, role: body.role } };
    }
  } catch {
    /* fall through */
  }
  return { mode: 'local' };
}

export interface ServerWorkspace {
  revision: number;
  records: RecordPut[];
}

const KIND_SET: ReadonlySet<string> = new Set(RECORD_KINDS);

/** Read the whole shared workspace over HTTP (used before linking, to show counts). Returns null on any failure. */
export async function fetchServerWorkspace(fetchFn: FetchLike = (i, init) => fetch(i, init)): Promise<ServerWorkspace | null> {
  try {
    const res = await fetchFn('/api/export', { credentials: 'same-origin', redirect: 'manual', cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { revision?: unknown; records?: unknown };
    if (typeof body.revision !== 'number' || !Array.isArray(body.records)) return null;
    const records: RecordPut[] = [];
    for (const r of body.records as Array<Record<string, unknown>>) {
      if (typeof r.kind !== 'string' || !KIND_SET.has(r.kind) || typeof r.id !== 'string' || typeof r.json !== 'string') return null;
      records.push({ kind: r.kind as RecordPut['kind'], id: r.id, json: r.json });
    }
    return { revision: body.revision, records };
  } catch {
    return null;
  }
}

/** ws(s)://<this host>/ws */
export function websocketUrl(loc: Pick<Location, 'protocol' | 'host'>): string {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ws`;
}

/** Plain-HTTP session check used by the sync client when WebSocket connects keep failing. */
export async function probeSession(fetchFn: FetchLike = (i, init) => fetch(i, init)): Promise<'ok' | 'expired' | 'unreachable'> {
  const d = await detectServer(fetchFn);
  if (d.mode === 'server') return 'ok';
  if (d.mode === 'login-required') return 'expired';
  return 'unreachable';
}
