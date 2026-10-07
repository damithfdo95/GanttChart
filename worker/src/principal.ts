/**
 * authenticated email  ->  application user  ->  role  ->  tenant  ->  permission
 *
 * Cloudflare Access proves WHO someone is. This module decides whether the
 * application knows them and what they are. Anything unknown fails closed.
 */

import { normalizeEmail, type DenyReason } from '../../shared/tenancy';
import type { AuthResult } from './registry';
import type { MemberPrincipal, Principal } from './permissions';

/** Parse a comma/space separated email list from configuration; invalid entries are ignored. */
export function parseEmailList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,;]+/)
    .map((s) => normalizeEmail(s))
    .filter((s): s is string => s !== null);
}

export function isSuperAdminEmail(email: string, superAdmins: readonly string[]): boolean {
  const e = normalizeEmail(email);
  return e !== null && superAdmins.includes(e);
}

export type PrincipalResult = { ok: true; principal: Principal } | { ok: false; reason: DenyReason };

/** The registry's decision, turned into a principal (or a refusal). */
export function principalFromAuth(auth: AuthResult): PrincipalResult {
  if (!auth.allowed) return { ok: false, reason: auth.reason };
  const { user, tenant } = auth;
  const principal: MemberPrincipal = {
    kind: 'member',
    email: user.email,
    userId: user.id,
    tenantId: tenant.id,
    tenantName: tenant.name,
    role: user.role,
    isOwner: tenant.owner_user_id === user.id,
    displayName: user.display_name ?? null,
    access: user.role === 'admin' ? 'editor' : user.access,
    storageMode: tenant.storage_mode,
    tenantStatus: tenant.status,
  };
  return { ok: true, principal };
}

/**
 * Resolve a VERIFIED email. Super Admins come from configuration (so the
 * platform cannot lock itself out and a tenant admin can never mint one);
 * everyone else must exist in the registry.
 */
export async function resolvePrincipal(
  verifiedEmail: string,
  superAdmins: readonly string[],
  authenticate: (email: string) => Promise<AuthResult>,
): Promise<PrincipalResult> {
  const email = normalizeEmail(verifiedEmail);
  if (email === null) return { ok: false, reason: 'unregistered' };
  if (superAdmins.includes(email)) return { ok: true, principal: { kind: 'super_admin', email } };
  return principalFromAuth(await authenticate(email));
}
