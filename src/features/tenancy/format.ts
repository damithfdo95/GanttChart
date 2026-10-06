import { ApiError } from '../../lib/tenancy/api';
import type { TranslationKey } from '../../i18n';
import type { Language } from '../../types';

const KNOWN_ERRORS: ReadonlySet<string> = new Set([
  'invalid_email',
  'invalid_name',
  'invalid_display_name',
  'invalid_input',
  'email_taken',
  'email_reserved',
  'email_domain_not_allowed',
  'managed_domains_not_configured',
  'not_found',
  'wrong_mode',
  'tenant_inactive',
  'bad_state',
  'forbidden_target',
  'same_person',
  'forbidden',
]);

/** A server error code -> a translated message. Unknown codes get the generic message (and never the raw server text). */
export function errorKey(error: unknown): TranslationKey {
  const code = error instanceof ApiError ? error.code : '';
  return (KNOWN_ERRORS.has(code) ? `tenancy.error.${code}` : 'tenancy.error.generic') as TranslationKey;
}

/**
 * The server refused an API call because the sign-in itself is gone (no/invalid Access token, or Access redirected
 * the call to its login). It is the same situation as a closed WebSocket with code 4401: the session ended.
 * A refusal because of PERMISSIONS (forbidden, not found, ...) is not.
 */
export function isSessionEnded(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 401 || error.code === 'login_required') return true;
  return error.status === 403 && (error.code === 'Invalid Access token' || error.code === 'Missing Access token');
}

export function whenText(iso: string | null | undefined, lang: Language): string {
  if (iso === null || iso === undefined) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

export function countsText(counts: Record<string, number>): { projects: number; reports: number; attendance: number; topics: number; members: number } {
  return {
    projects: counts.project ?? 0,
    reports: counts.report ?? 0,
    attendance: counts.attendance ?? 0,
    topics: counts.topic ?? 0,
    members: counts.member ?? 0,
  };
}

export interface PanelCapabilities {
  showPanel: boolean;
  canChooseStorage: boolean;
  canManageUsers: boolean;
  canRequestDeletion: boolean;
}

/** What the workspace panel offers this person. The server enforces the same rules; this only decides what to show. */
export function panelCapabilities(principal: { role: 'super_admin' | 'admin' | 'user'; tenant: { storageMode: 'local' | 'web' } | null } | null): PanelCapabilities {
  if (principal === null || principal.tenant === null || principal.role === 'super_admin') {
    return { showPanel: false, canChooseStorage: false, canManageUsers: false, canRequestDeletion: false };
  }
  const admin = principal.role === 'admin';
  return { showPanel: true, canChooseStorage: admin, canManageUsers: admin && principal.tenant.storageMode === 'web', canRequestDeletion: admin };
}
