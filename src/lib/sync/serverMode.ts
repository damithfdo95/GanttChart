/**
 * Is there a shared backend behind this page, and who am I on it?
 *
 * The same build runs in two places: on a plain static host / `vite dev`
 * (no backend — the app is local-only exactly as before) and on the Worker
 * (shared). One probe tells them apart. The probe never throws.
 */

import { RECORD_KINDS, type Identity, type RecordPut, type Role } from '../../../shared/protocol';
import type { AppRole, DenyReason, PrincipalDto } from '../../../shared/tenancy';

export type ServerDetection =
  /** A signed-in, REGISTERED person. `identity` is the live-workspace identity, or null when there is no shared workspace for them. */
  | { mode: 'server'; principal: PrincipalDto; identity: Identity | null }
  /** Signed in with Access, but the application does not (or no longer does) grant access. */
  | { mode: 'denied'; reason: DenyReason; email: string }
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

const APP_ROLES: ReadonlySet<string> = new Set<AppRole>(['super_admin', 'admin', 'user']);
const DENY_REASONS: ReadonlySet<string> = new Set<DenyReason>(['unregistered', 'disabled', 'tenant_inactive', 'workspace_not_shared']);

/** Shape check of /api/whoami. A response that does not look like a principal is treated as "no backend". */
export function isPrincipalDto(v: unknown): v is PrincipalDto {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  if (typeof p.email !== 'string' || p.email === '' || typeof p.role !== 'string' || !APP_ROLES.has(p.role)) return false;
  if (typeof p.sharedWorkspace !== 'boolean') return false;
  if (p.workspaceRole !== null && !isRole(p.workspaceRole as string)) return false;
  if (p.role === 'super_admin') return p.tenant === null;
  const t = p.tenant as Record<string, unknown> | null;
  return typeof t === 'object' && t !== null && typeof t.id === 'string' && typeof t.name === 'string' && (t.storageMode === 'local' || t.storageMode === 'web');
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
  if (res.status === 403) {
    // Our own refusal is JSON with a reason ("you are signed in but not registered / disabled / ...").
    // Access's own block page is HTML: that means the sign-in itself is the problem.
    if ((res.headers.get('content-type') ?? '').includes('application/json')) {
      try {
        const body = (await res.json()) as { reason?: unknown; email?: unknown };
        if (typeof body.reason === 'string' && DENY_REASONS.has(body.reason)) {
          return { mode: 'denied', reason: body.reason as DenyReason, email: typeof body.email === 'string' ? body.email : '' };
        }
      } catch {
        /* fall through */
      }
    }
    return { mode: 'login-required' };
  }
  if (res.status === 401) return { mode: 'login-required' };
  if (res.status === 404) return { mode: 'local' };
  if (res.status >= 500) return { mode: 'error', status: res.status };
  if (!res.ok) return { mode: 'local' };
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) return { mode: 'local' }; // SPA fallback HTML: no API here
  try {
    const body: unknown = await res.json();
    if (isPrincipalDto(body)) {
      const identity: Identity | null = body.workspaceRole === null ? null : { email: body.email, role: body.workspaceRole };
      return { mode: 'server', principal: body, identity };
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
