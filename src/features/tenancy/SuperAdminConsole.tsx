import { useCallback, useEffect, useState } from 'react';
import { t, LANGUAGES, type TranslationKey } from '../../i18n';
import type { DeletionAudit, TenancyApi } from '../../lib/tenancy/api';
import type { PrincipalDto, TenantSummaryDto } from '../../../shared/tenancy';
import type { Language } from '../../types';
import { errorKey, whenText } from './format';

type Message = { kind: 'ok' | 'error'; text: string } | null;

/** The two typed confirmations match THIS workspace (the server checks them again). */
export function deletionConfirmed(tenant: Pick<TenantSummaryDto, 'id' | 'adminEmail'>, typedId: string, typedEmail: string): boolean {
  return typedId === tenant.id && typedEmail.trim().toLowerCase() === tenant.adminEmail.toLowerCase();
}

/**
 * Platform administration: workspace METADATA only (name, id, admin, mode,
 * status, counts of accounts). There is no way from here to open or export a
 * workspace's QA data, and the server offers none either.
 */
export function SuperAdminConsole({ initialLang, principal, api }: { initialLang: Language; principal: PrincipalDto; api: TenancyApi }) {
  const [lang, setLang] = useState<Language>(initialLang);
  const [tenants, setTenants] = useState<TenantSummaryDto[] | null>(null);
  const [audit, setAudit] = useState<DeletionAudit[]>([]);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [reviewing, setReviewing] = useState<TenantSummaryDto | null>(null);
  const [typedId, setTypedId] = useState('');
  const [typedEmail, setTypedEmail] = useState('');

  const fail = useCallback((e: unknown) => setMessage({ kind: 'error', text: t(lang, errorKey(e)) }), [lang]);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [list, log] = await Promise.all([api.listTenants(), api.audit()]);
      setTenants(list);
      setAudit(log);
    } catch (e) {
      fail(e);
    }
  }, [api, fail]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<string | null>): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await action();
      if (text !== null) setMessage({ kind: 'ok', text });
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const create = (): Promise<void> =>
    run(async () => {
      const created = await api.createTenant(name, adminEmail);
      setName('');
      setAdminEmail('');
      return t(lang, 'tenancy.super.created', { email: created.admin.email });
    });

  const confirmDelete = (): Promise<void> =>
    run(async () => {
      if (reviewing === null) return null;
      if (!deletionConfirmed(reviewing, typedId, typedEmail)) {
        setMessage({ kind: 'error', text: t(lang, 'tenancy.super.deleteMismatch') });
        return null;
      }
      const done = await api.approveDeletion(reviewing.id, typedId, typedEmail.trim());
      setReviewing(null);
      setTypedId('');
      setTypedEmail('');
      return t(lang, 'tenancy.super.deleteDone', { users: done.usersDeleted });
    });

  const startReview = (tenant: TenantSummaryDto): void => {
    setReviewing(tenant);
    setTypedId('');
    setTypedEmail('');
  };

  return (
    <main className="link-screen">
      <div className="link-card tenancy-wide">
        <h1>{t(lang, 'tenancy.super.title')}</h1>
        <p>{t(lang, 'tenancy.super.subtitle')}</p>
        <p>{t(lang, 'tenancy.super.signedIn', { email: principal.email, role: t(lang, 'tenancy.role.super_admin') })}</p>
        <div className="dr-button-row" role="group" aria-label="Language">
          {LANGUAGES.map((option) => (
            <button key={option.code} type="button" className={`btn ${option.code === lang ? 'btn-primary' : ''}`} aria-pressed={option.code === lang} onClick={() => setLang(option.code)}>
              {option.short}
            </button>
          ))}
        </div>
        {message === null ? null : (
          <p className={`data-controls-message ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
            {message.text}
          </p>
        )}

        <section>
          <h2>{t(lang, 'tenancy.super.createTitle')}</h2>
          <label className="link-confirm">
            {t(lang, 'tenancy.super.nameLabel')}
            <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </label>
          <label className="link-confirm">
            {t(lang, 'tenancy.super.adminEmailLabel')}
            <input className="input" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} autoComplete="off" />
          </label>
          <button type="button" className="btn btn-primary" disabled={busy || name.trim() === '' || adminEmail.trim() === ''} onClick={() => void create()}>
            {t(lang, 'tenancy.super.create')}
          </button>
        </section>

        <section>
          <h2>{t(lang, 'tenancy.super.listTitle')}</h2>
          {tenants === null ? (
            <p role="status">{t(lang, 'tenancy.working')}</p>
          ) : tenants.length === 0 ? (
            <p>{t(lang, 'tenancy.super.empty')}</p>
          ) : (
            <div className="tenancy-table-wrap">
              <table className="tenancy-table">
                <thead>
                  <tr>
                    <th>{t(lang, 'tenancy.super.colName')}</th>
                    <th>{t(lang, 'tenancy.super.colAdmin')}</th>
                    <th>{t(lang, 'tenancy.super.colStorage')}</th>
                    <th>{t(lang, 'tenancy.super.colUsers')}</th>
                    <th>{t(lang, 'tenancy.super.colStatus')}</th>
                    <th>{t(lang, 'tenancy.super.colCreated')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {tenants.map((tn) => (
                    <tr key={tn.id}>
                      <td>
                        {tn.name}
                        <br />
                        <code>{tn.id}</code>
                      </td>
                      <td>{tn.adminEmail}</td>
                      <td>{t(lang, `tenancy.mode.${tn.storageMode}` as TranslationKey)}</td>
                      <td>{tn.userCount}</td>
                      <td>{t(lang, `tenancy.tenantStatus.${tn.status}` as TranslationKey)}</td>
                      <td>{whenText(tn.createdAt, lang)}</td>
                      <td>
                        {tn.status === 'deletion_requested' ? (
                          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => startReview(tn)}>
                            {t(lang, 'tenancy.super.review')}
                          </button>
                        ) : tn.status === 'active' ? (
                          <button
                            type="button"
                            className="btn"
                            disabled={busy}
                            onClick={() => {
                              if (window.confirm(t(lang, 'tenancy.super.deactivateConfirm', { name: tn.name }))) {
                                void run(async () => {
                                  await api.setTenantStatus(tn.id, 'deactivated');
                                  return null;
                                });
                              }
                            }}
                          >
                            {t(lang, 'tenancy.super.deactivate')}
                          </button>
                        ) : tn.status === 'deactivated' ? (
                          <button
                            type="button"
                            className="btn"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await api.setTenantStatus(tn.id, 'active');
                                return null;
                              })
                            }
                          >
                            {t(lang, 'tenancy.super.activate')}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {reviewing === null ? null : (
          <section className="link-option link-danger" aria-labelledby="tenancy-del-title">
            <h2 id="tenancy-del-title">{t(lang, 'tenancy.super.deleteTitle')}</h2>
            <p>{t(lang, 'tenancy.super.deleteScope', { name: reviewing.name, id: reviewing.id, users: reviewing.userCount })}</p>
            <p>{t(lang, 'tenancy.super.deleteRequestedBy', { email: reviewing.adminEmail, when: whenText(reviewing.deletionRequestedAt, lang) })}</p>
            <label className="link-confirm">
              {t(lang, 'tenancy.super.deleteConfirmId')}
              <input className="input" value={typedId} onChange={(e) => setTypedId(e.target.value)} autoComplete="off" spellCheck={false} />
            </label>
            <label className="link-confirm">
              {t(lang, 'tenancy.super.deleteConfirmEmail')}
              <input className="input" value={typedEmail} onChange={(e) => setTypedEmail(e.target.value)} autoComplete="off" spellCheck={false} />
            </label>
            <div className="dr-button-row">
              <button type="button" className="btn btn-danger" disabled={busy || !deletionConfirmed(reviewing, typedId, typedEmail)} onClick={() => void confirmDelete()}>
                {t(lang, 'tenancy.super.deleteButton')}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setReviewing(null)}>
                {t(lang, 'tenancy.cancel')}
              </button>
            </div>
          </section>
        )}

        <section>
          <h2>{t(lang, 'tenancy.super.auditTitle')}</h2>
          {audit.length === 0 ? (
            <p>{t(lang, 'tenancy.super.auditEmpty')}</p>
          ) : (
            <div className="tenancy-table-wrap">
              <table className="tenancy-table">
                <thead>
                  <tr>
                    <th>{t(lang, 'tenancy.super.colName')}</th>
                    <th>{t(lang, 'tenancy.super.auditRequested')}</th>
                    <th>{t(lang, 'tenancy.super.auditApproved')}</th>
                    <th>{t(lang, 'tenancy.super.auditWhen')}</th>
                    <th>{t(lang, 'tenancy.super.auditUsers')}</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <code>{a.tenant_id}</code>
                      </td>
                      <td>
                        {a.requested_by_email}
                        <br />
                        {whenText(a.requested_at, lang)}
                      </td>
                      <td>
                        {a.approved_by_email}
                        <br />
                        {whenText(a.approved_at, lang)}
                      </td>
                      <td>{whenText(a.deleted_at, lang)}</td>
                      <td>{a.users_deleted}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
