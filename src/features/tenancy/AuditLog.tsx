import { useCallback, useEffect, useState } from 'react';
import { t, type TranslationKey } from '../../i18n';
import type { AdminAuditDto } from '../../../shared/tenancy';
import type { Language } from '../../types';
import { errorKey, isSessionEnded, whenText } from './format';
import { useSession } from '../../app/session-context';

/**
 * The administrative history: who created, disabled, reactivated, requested or deleted what, and when.
 * It is NOT the QA revision history. The server decides what this reader may see (a Super Admin: workspace-level
 * events; an Admin: their own workspace); this component only displays it. Read-only.
 */
export function AuditLog({ lang, load, title, emptyKey }: { lang: Language; load: () => Promise<AdminAuditDto[]>; title: string; emptyKey: TranslationKey }) {
  const [rows, setRows] = useState<AdminAuditDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const session = useSession();

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      setRows(await load());
    } catch (e) {
      if (isSessionEnded(e)) session.endSession('expired');
      else setError(t(lang, errorKey(e)));
    }
  }, [load, lang, session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="dr-section" aria-labelledby="audit-title">
      <div className="dr-button-row">
        <h2 id="audit-title">{title}</h2>
        <button type="button" className="btn btn-ghost" onClick={() => void refresh()}>
          {t(lang, 'tenancy.refresh')}
        </button>
      </div>
      <p className="dr-summary">{t(lang, 'tenancy.audit.help')}</p>
      {error === null ? null : <p role="alert">{error}</p>}
      {rows === null && error === null ? <p role="status">{t(lang, 'tenancy.working')}</p> : null}
      {rows !== null && rows.length === 0 ? <p>{t(lang, emptyKey)}</p> : null}
      {rows !== null && rows.length > 0 ? (
        <div className="tenancy-table-wrap">
          <table className="tenancy-table">
            <thead>
              <tr>
                <th scope="col">{t(lang, 'tenancy.audit.colWhen')}</th>
                <th scope="col">{t(lang, 'tenancy.audit.colAction')}</th>
                <th scope="col">{t(lang, 'tenancy.audit.colBy')}</th>
                <th scope="col">{t(lang, 'tenancy.audit.colTarget')}</th>
                <th scope="col">{t(lang, 'tenancy.audit.colDetails')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{whenText(row.at, lang)}</td>
                  <td>{t(lang, `tenancy.audit.action.${row.action}` as TranslationKey)}</td>
                  <td>
                    {row.actorEmail}
                    <br />
                    <span className="link-help">{t(lang, `tenancy.role.${row.actorRole}` as TranslationKey)}</span>
                  </td>
                  <td>{row.targetEmail ?? (row.targetType === 'tenant' ? String(row.meta.workspaceName ?? '') : '')}</td>
                  <td>{detailsText(row, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

/** A short, plain-language rendering of the safe metadata. */
export function detailsText(row: Pick<AdminAuditDto, 'action' | 'meta'>, lang: Language): string {
  const m = row.meta;
  switch (row.action) {
    case 'admin.created':
    case 'tenant.disabled':
    case 'tenant.reactivated':
    case 'tenant.deletion_requested':
    case 'tenant.deletion_cancelled':
    case 'tenant.deletion_rejected':
      return typeof m.workspaceName === 'string' ? m.workspaceName : '';
    case 'tenant.deletion_approved':
      return typeof m.workspaceName === 'string' ? m.workspaceName : '';
    case 'tenant.deleted':
      return t(lang, 'tenancy.audit.detail.deleted', { name: String(m.workspaceName ?? ''), users: Number(m.usersDeleted ?? 0) });
    case 'user.created':
      return t(lang, `tenancy.access.${m.access === 'viewer' ? 'viewer' : 'editor'}` as TranslationKey);
    case 'user.access_changed':
      return `${t(lang, `tenancy.access.${m.from === 'viewer' ? 'viewer' : 'editor'}` as TranslationKey)} → ${t(lang, `tenancy.access.${m.to === 'viewer' ? 'viewer' : 'editor'}` as TranslationKey)}`;
    case 'storage.migration_uploaded':
      return t(lang, 'tenancy.audit.detail.uploaded', { records: Number(m.records ?? 0) });
    case 'storage.web_activated':
    case 'storage.local_activated':
      return `${t(lang, `tenancy.modeShort.${m.from === 'web' ? 'web' : 'local'}` as TranslationKey)} → ${t(lang, `tenancy.modeShort.${m.to === 'web' ? 'web' : 'local'}` as TranslationKey)}`;
    default:
      return '';
  }
}
