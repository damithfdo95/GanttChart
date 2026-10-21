/**
 * Shared HTTP plumbing for the Worker's API routes: response helpers, the
 * request context, body reading with the size ceiling, permission checks and
 * the error-code → HTTP-status maps. Extracted from index.ts so the route
 * modules stay about routing, not plumbing.
 */

import { isRecordKind, type RecordKind } from '../../shared/protocol';
import { isDateString } from '../../shared/notifications';
import { can, type Action, type MemberPrincipal, type Principal } from './permissions';
import type { RegistryError } from './registry';
import { TENANT_HEADER, WorkspaceRoom } from './workspaceRoom';
import { RegistryRoom } from './registryRoom';
import type { VerifiedIdentity } from './auth';
import type { AuditActor } from '../../shared/tenancy';

/**
 * HTTP body ceiling. The protocol's own largest legitimate payload is a sync
 * message (LIMITS.maxMessageChars = 8M chars) plus its JSON envelope, so 10M
 * chars covers everything real with no headroom for abuse.
 */
export const MAX_BODY_CHARS = 10_000_000;

export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra },
  });
}

export function problem(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return json({ error, ...extra }, status);
}

// ---- request context -----------------------------------------------------------

export interface Ctx {
  request: Request;
  env: Env;
  url: URL;
  path: string;
  method: string;
  identity: VerifiedIdentity;
  principal: Principal;
  superAdmins: string[];
  registry: DurableObjectStub<RegistryRoom>;
}

/** The tenant's workspace object. Only ever called with a tenant id taken from a verified principal. */
export function roomFor(ctx: Ctx, principal: MemberPrincipal): DurableObjectStub<WorkspaceRoom> {
  return ctx.env.WORKSPACE.getByName(principal.tenantId);
}

export function member(ctx: Ctx): MemberPrincipal | null {
  return ctx.principal.kind === 'member' ? ctx.principal : null;
}

/**
 * Who is acting, for the administrative audit trail. Taken ONLY from the verified principal: no request
 * field, header or body can name the actor.
 */
export function actorOf(principal: Principal): AuditActor {
  return principal.kind === 'super_admin' ? { userId: null, email: principal.email, role: 'super_admin' } : { userId: principal.userId, email: principal.email, role: principal.role };
}

const FORGED_KEYS = ['tenantid', 'tenant_id', 'tenant', 'workspaceid', 'workspace_id', 'workspace'];

/**
 * A browser has no business naming a tenant. The tenant is derived from who
 * you are. If a request names one anyway and it is not yours, it is rejected
 * (and, either way, never used).
 */
export function forgedTenant(ctx: Ctx, body: unknown): boolean {
  const own = ctx.principal.kind === 'member' ? ctx.principal.tenantId : null;
  const differs = (v: unknown): boolean => v !== undefined && v !== null && String(v) !== own;
  for (const [k, v] of ctx.url.searchParams) if (FORGED_KEYS.includes(k.toLowerCase()) && differs(v)) return true;
  for (const h of [TENANT_HEADER, 'x-tenant-id', 'x-workspace-id']) {
    const v = ctx.request.headers.get(h);
    if (v !== null && differs(v)) return true;
  }
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) if (FORGED_KEYS.includes(k.toLowerCase()) && differs(v)) return true;
  }
  return false;
}

export async function readJson(ctx: Ctx): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  const declared = Number(ctx.request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_CHARS) return { ok: false, response: problem(413, 'too_large') };
  let text: string;
  try {
    text = await ctx.request.text();
  } catch {
    return { ok: false, response: problem(400, 'unreadable_body') };
  }
  if (text.length > MAX_BODY_CHARS) return { ok: false, response: problem(413, 'too_large') };
  let parsed: unknown;
  try {
    parsed = text === '' ? {} : JSON.parse(text);
  } catch {
    return { ok: false, response: problem(400, 'invalid_json') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, response: problem(400, 'invalid_body') };
  if (ctx.principal.kind === 'member' && forgedTenant(ctx, parsed)) return { ok: false, response: problem(403, 'tenant_mismatch') };
  return { ok: true, body: parsed as Record<string, unknown> };
}

/** 403 unless the principal holds the action. */
export function need(ctx: Ctx, action: Action): Response | null {
  return can(ctx.principal, action) ? null : problem(403, 'forbidden', { reason: 'role', action });
}

export function revisionParam(segment: string): number | null {
  return /^\d{1,12}$/.test(segment) ? Number(segment) : null;
}

// ---- error-code → HTTP status maps ----------------------------------------------

const REGISTRY_STATUS: Record<RegistryError, number> = {
  invalid_email: 400,
  invalid_name: 400,
  invalid_input: 400,
  email_taken: 409,
  email_in_other_workspace: 409,
  email_reserved: 409,
  invalid_display_name: 400,
  email_domain_not_allowed: 400,
  managed_domains_not_configured: 503,
  not_found: 404,
  wrong_mode: 409,
  tenant_inactive: 409,
  bad_state: 409,
  forbidden_target: 403,
  same_person: 403,
  owner_protected: 409,
};

export function registryProblem(error: RegistryError): Response {
  return problem(REGISTRY_STATUS[error] ?? 400, error);
}

const MEMBER_STATUS: Record<string, number> = {
  member_not_found: 404,
  member_email_taken: 409,
  member_email_locked: 409,
  member_email_mismatch: 409,
  member_already_linked: 409,
  account_already_linked: 409,
  member_inactive: 409,
  member_removed: 409,
  member_not_tester: 409,
  member_linked: 409,
  project_not_found: 404,
  scope_not_found: 404,
  scope_archived: 409,
  archived: 409,
  failed: 500,
};

const NOTIFICATION_STATUS: Record<string, number> = {
  notification_not_found: 404,
  notification_member_not_found: 400,
  not_addressed: 403,
  invalid_occurrence: 409,
  archived: 409,
  failed: 500,
};

export function notificationProblem(error: string): Response {
  return problem(NOTIFICATION_STATUS[error] ?? 400, error);
}

export function memberProblem(error: string): Response {
  return problem(MEMBER_STATUS[error] ?? 409, error);
}

// ---- shared route helpers --------------------------------------------------------

/** Browsers always send Origin on WebSocket upgrades and cross-origin/unsafe requests. */
export function originAllowed(request: Request, env: Env, required: boolean): boolean {
  const origin = request.headers.get('Origin');
  if (origin === null) return !required;
  const own = new URL(request.url).origin;
  const extra = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return new Set([own, ...extra]).has(origin);
}

export { isRecordKind, isDateString };
export type { RecordKind };
