import { t } from '../../i18n';
import type { PrincipalDto } from '../../../shared/tenancy';
import type { Language } from '../../types';

/** Which words fit an empty workspace, for this kind of person. null = nothing to say (not empty, or no backend). */
export function emptyWorkspaceKind(principal: PrincipalDto | null, projectCount: number): 'admin' | 'editor' | 'viewer' | null {
  if (principal === null || principal.role === 'super_admin' || projectCount > 0) return null;
  if (principal.role === 'admin') return 'admin';
  return principal.access === 'viewer' ? 'viewer' : 'editor';
}

/**
 * An empty workspace is a normal first state, not an error: say what it is and what to do next, depending on
 * who is looking (the Admin can create projects and add Users; an editor can create projects; a viewer waits).
 */
export function WorkspaceEmptyNotice({ lang, principal, projectCount }: { lang: Language; principal: PrincipalDto | null; projectCount: number }) {
  const kind = emptyWorkspaceKind(principal, projectCount);
  if (kind === null) return null;
  return (
    <div className="tenancy-empty" role="note">
      <strong>{t(lang, 'dashboard.empty.title')}</strong>
      <p>{t(lang, `dashboard.empty.${kind}`)}</p>
    </div>
  );
}
