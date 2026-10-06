import { useCallback, useEffect, useMemo, useState } from 'react';
import { t, LANGUAGES, type TranslationKey } from '../../i18n';
import { useConfirm } from '../../components/ConfirmDialog';
import type { DeletionAudit, TenancyApi } from '../../lib/tenancy/api';
import type { PrincipalDto, TenantListQuery, TenantSummaryDto } from '../../../shared/tenancy';
import type { Language } from '../../types';
import { errorKey, isSessionEnded, whenText } from './format';
import { LogoutButton } from './LogoutButton';
import { AuditLog } from './AuditLog';
import { StatusBadge } from './UsersManager';
import { useSession } from '../../app/session-context';

type Message = { kind: 'ok' | 'error'; text: string } | null;
export type ConsoleTab = 'overview' | 'workspaces' | 'deletions' | 'audit';
export const CONSOLE_TABS: readonly ConsoleTab[] = ['overview', 'workspaces', 'deletions', 'audit'];

/** The two typed confirmations match THIS workspace (the server checks them again). */
export function deletionConfirmed(tenant: Pick<TenantSummaryDto, 'id' | 'adminEmail'>, typedId: string, typedEmail: string): boolean {
  return typedId === tenant.id && typedEmail.trim().toLowerCase() === tenant.adminEmail.toLowerCase();
}

const PAGE = 25;

/** Counts for the overview, from the (capped) unfiltered list. */
export function overviewCounts(tenants: readonly TenantSummaryDto[]): {
  workspaces: number;
  active: number;
  disabled: number;
  deletionRequested: number;
  web: number;
  local: number;
  accounts: number;
  outsideDomain: number;
} {
  const c = { workspaces: tenants.length, active: 0, disabled: 0, deletionRequested: 0, web: 0, local: 0, accounts: 0, outsideDomain: 0 };
  for (const x of tenants) {
    if (x.status === 'active') c.active += 1;
    if (x.status === 'deactivated') c.disabled += 1;
    if (x.status === 'deletion_requested') c.deletionRequested += 1;
    if (x.storageMode === 'web') c.web += 1;
    else c.local += 1;
    c.accounts += x.userCount;
    if (x.adminOutsideManagedDomains) c.outsideDomain += 1;
  }
  return c;
}

/**
 * Platform administration: workspace METADATA only (name, id, admin, mode, status, number of accounts,
 * last activity). There is no way from here to open or export a workspace's QA data, and the server
 * offers none either.
 */
export function SuperAdminConsole({ initialLang, principal, api }: { initialLang: Language; principal: PrincipalDto; api: TenancyApi }) {
  const [lang, setLang] = useState<Language>(initialLang);
  const [tab, setTab] = useState<ConsoleTab>('overview');
  const session = useSession();
  const [all, setAll] = useState<TenantSummaryDto[] | null>(null);
  const [allTotal, setAllTotal] = useState(0);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const confirm = useConfirm();

  const fail = useCallback(
    (e: unknown) => {
      if (isSessionEnded(e)) session.endSession('expired'); // the sign-in ended: same signed-out flow as everywhere
      else setMessage({ kind: 'error', text: t(lang, errorKey(e)) });
    },
    [lang, session],
  );

  /** The unfiltered list backs the overview and the deletion queue; the Workspaces tab runs its own queries. */
  const loadAll = useCallback(async (): Promise<void> => {
    try {
      const r = await api.listTenants({ limit: 200, sort: 'created', dir: 'desc' });
      setAll(r.tenants);
      setAllTotal(r.total);
    } catch (e) {
      fail(e);
    }
  }, [api, fail]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const run = async (action: () => Promise<string | null>): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await action();
      if (text !== null) setMessage({ kind: 'ok', text });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
      await loadAll();
      setRefreshKey((k) => k + 1);
    }
  };

  const deletions = useMemo(() => (all ?? []).filter((x) => x.status === 'deletion_requested'), [all]);

  const toggleStatus = async (tn: TenantSummaryDto): Promise<void> => {
    const disabling = tn.status === 'active';
    const ok = await confirm({
      title: t(lang, disabling ? 'tenancy.super.disableTitle' : 'tenancy.super.enableTitle', { name: tn.name }),
      body: <p>{t(lang, disabling ? 'tenancy.super.disableBody' : 'tenancy.super.enableBody', { name: tn.name })}</p>,
      confirmLabel: t(lang, disabling ? 'tenancy.super.deactivate' : 'tenancy.super.activate'),
      cancelLabel: t(lang, 'tenancy.cancel'),
      severity: disabling ? 'warning' : 'normal',
    });
    if (!ok) return;
    await run(async () => {
      await api.setTenantStatus(tn.id, disabling ? 'deactivated' : 'active');
      return t(lang, disabling ? 'tenancy.super.disabledDone' : 'tenancy.super.enabledDone', { name: tn.name });
    });
  };

  const approve = async (tn: TenantSummaryDto): Promise<void> => {
    const ok = await confirm({
      title: t(lang, 'tenancy.super.deleteTitle'),
      body: (
        <>
          <p>{t(lang, 'tenancy.super.deleteScope', { name: tn.name, id: tn.id, users: tn.userCount })}</p>
          <ul>
            {(['deleteItem1', 'deleteItem2', 'deleteItem3', 'deleteItem4', 'deleteItem5', 'deleteItem6'] as const).map((k) => (
              <li key={k}>{t(lang, `tenancy.super.${k}`)}</li>
            ))}
          </ul>
          <p>
            <strong>{t(lang, 'tenancy.super.deleteIrreversible')}</strong>
          </p>
          <p>{t(lang, 'tenancy.super.deleteRequestedBy', { email: tn.adminEmail, when: whenText(tn.deletionRequestedAt, lang) })}</p>
        </>
      ),
      confirmLabel: t(lang, 'tenancy.super.deleteButton'),
      cancelLabel: t(lang, 'tenancy.cancel'),
      severity: 'danger',
      typed: [
        { label: t(lang, 'tenancy.super.deleteConfirmId'), expected: tn.id },
        { label: t(lang, 'tenancy.super.deleteConfirmEmail'), expected: tn.adminEmail, loose: true },
      ],
    });
    if (!ok) return;
    await run(async () => {
      const done = await api.approveDeletion(tn.id, tn.id, tn.adminEmail);
      return t(lang, 'tenancy.super.deleteDone', { users: done.usersDeleted });
    });
  };

  const reject = async (tn: TenantSummaryDto): Promise<void> => {
    const ok = await confirm({
      title: t(lang, 'tenancy.super.rejectTitle', { name: tn.name }),
      body: <p>{t(lang, 'tenancy.super.rejectBody')}</p>,
      confirmLabel: t(lang, 'tenancy.super.rejectButton'),
      cancelLabel: t(lang, 'tenancy.cancel'),
      severity: 'normal',
    });
    if (!ok) return;
    await run(async () => {
      await api.rejectDeletion(tn.id);
      return t(lang, 'tenancy.super.rejectDone', { name: tn.name });
    });
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const loadAudit = useCallback(() => api.platformAudit(), [api, refreshKey]);
  const loadDeletionRecords = useCallback(() => api.audit(), [api]);

  return (
    <main className="link-screen console-screen">
      <div className="link-card tenancy-wide">
        <header className="console-header">
          <div>
            <h1>{t(lang, 'tenancy.super.title')}</h1>
            <p>{t(lang, 'tenancy.super.subtitle')}</p>
            <p className="account-line">
              <span className="role-chip role-super_admin">{t(lang, 'tenancy.role.super_admin')}</span> {principal.email}
            </p>
          </div>
          <div className="dr-button-row" role="group" aria-label={t(lang, 'landing.language')}>
            {LANGUAGES.map((option) => (
              <button key={option.code} type="button" className={`btn ${option.code === lang ? 'btn-primary' : ''}`} aria-pressed={option.code === lang} onClick={() => setLang(option.code)}>
                {option.short}
              </button>
            ))}
            <LogoutButton
              lang={lang}
              who={principal.email}
              deps={{
                unsentChanges: () => 0,
                saveLocal: () => Promise.resolve(),
                stopSync: () => undefined,
                endSession: () => session.endSession('logout'),
                navigate: (path) => window.location.assign(path),
              }}
            />
          </div>
        </header>

        <div role="tablist" aria-label={t(lang, 'tenancy.super.navLabel')} className="console-tabs">
          {CONSOLE_TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`console-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`console-panel-${id}`}
              className={`btn ${tab === id ? 'btn-primary' : ''}`}
              onClick={() => setTab(id)}
            >
              {t(lang, `tenancy.super.tab.${id}` as TranslationKey)}
              {id === 'deletions' && deletions.length > 0 ? <span className="count-chip"> {deletions.length}</span> : null}
            </button>
          ))}
        </div>

        <div aria-live="polite">
          {message === null ? null : (
            <p className={`data-controls-message ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
              {message.text}
            </p>
          )}
        </div>

        <div role="tabpanel" id={`console-panel-${tab}`} aria-labelledby={`console-tab-${tab}`}>
          {tab === 'overview' ? <Overview lang={lang} all={all} total={allTotal} onGo={setTab} /> : null}
          {tab === 'workspaces' ? (
            <Workspaces lang={lang} api={api} busy={busy} refreshKey={refreshKey} onToggle={toggleStatus} onReview={() => setTab('deletions')} onCreated={(text) => void run(async () => text)} onError={fail} />
          ) : null}
          {tab === 'deletions' ? <Deletions lang={lang} rows={all === null ? null : deletions} busy={busy} onApprove={approve} onReject={reject} /> : null}
          {tab === 'audit' ? (
            <>
              <AuditLog lang={lang} load={loadAudit} title={t(lang, 'tenancy.audit.platformTitle')} emptyKey="tenancy.audit.empty" />
              <DeletionRecords lang={lang} load={loadDeletionRecords} onError={fail} />
            </>
          ) : null}
        </div>
      </div>
    </main>
  );
}

function Overview({ lang, all, total, onGo }: { lang: Language; all: TenantSummaryDto[] | null; total: number; onGo: (tab: ConsoleTab) => void }) {
  if (all === null) return <p role="status">{t(lang, 'tenancy.working')}</p>;
  if (all.length === 0) {
    return (
      <div className="tenancy-empty" role="note">
        <strong>{t(lang, 'tenancy.super.emptyTitle')}</strong>
        <p>{t(lang, 'tenancy.super.emptyBody')}</p>
        <button type="button" className="btn btn-primary" onClick={() => onGo('workspaces')}>
          {t(lang, 'tenancy.super.createTitle')}
        </button>
      </div>
    );
  }
  const c = overviewCounts(all);
  const cards: Array<{ key: TranslationKey; value: number; warn?: boolean }> = [
    { key: 'tenancy.super.ov.workspaces', value: total },
    { key: 'tenancy.super.ov.active', value: c.active },
    { key: 'tenancy.super.ov.disabled', value: c.disabled },
    { key: 'tenancy.super.ov.deletionRequested', value: c.deletionRequested, warn: c.deletionRequested > 0 },
    { key: 'tenancy.super.ov.web', value: c.web },
    { key: 'tenancy.super.ov.local', value: c.local },
    { key: 'tenancy.super.ov.accounts', value: c.accounts },
  ];
  return (
    <section aria-label={t(lang, 'tenancy.super.tab.overview')}>
      <div className="overall-summary">
        {cards.map((card) => (
          <div key={card.key} className={`summary-card${card.warn ? ' summary-card-warn' : ''}`}>
            <span className="summary-card-label">{t(lang, card.key)}</span>
            <span className="summary-card-value">
              {card.warn ? <span aria-hidden="true">⚠ </span> : null}
              {card.value}
            </span>
          </div>
        ))}
      </div>
      {total > all.length ? <p className="link-help">{t(lang, 'tenancy.super.ov.capped', { shown: all.length, total })}</p> : null}
      {c.deletionRequested > 0 ? (
        <p role="status">
          <span aria-hidden="true">⚠ </span>
          {t(lang, 'tenancy.super.ov.deletionNote', { count: c.deletionRequested })}{' '}
          <button type="button" className="btn btn-ghost" onClick={() => onGo('deletions')}>
            {t(lang, 'tenancy.super.tab.deletions')}
          </button>
        </p>
      ) : null}
      {c.outsideDomain > 0 ? (
        <p role="status">
          <span aria-hidden="true">⚠ </span>
          {t(lang, 'tenancy.super.ov.outsideNote', { count: c.outsideDomain })}
        </p>
      ) : null}
      <p className="link-help">{t(lang, 'tenancy.super.metadataOnly')}</p>
    </section>
  );
}

const SORTS: ReadonlyArray<NonNullable<TenantListQuery['sort']>> = ['created', 'name', 'admin', 'activity', 'status', 'accounts'];

function Workspaces(props: {
  lang: Language;
  api: TenancyApi;
  busy: boolean;
  refreshKey: number;
  onToggle: (tn: TenantSummaryDto) => Promise<void>;
  onReview: () => void;
  onCreated: (text: string) => void;
  onError: (e: unknown) => void;
}) {
  const { lang, api } = props;
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<NonNullable<TenantListQuery['status']>>('all');
  const [mode, setMode] = useState<NonNullable<TenantListQuery['mode']>>('all');
  const [sort, setSort] = useState<NonNullable<TenantListQuery['sort']>>('created');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ tenants: TenantSummaryDto[]; total: number } | null>(null);
  const [created, setCreated] = useState<{ name: string; email: string; displayName: string | null; id: string } | null>(null);

  // A new search starts from the first page.
  useEffect(() => setOffset(0), [q, status, mode, sort, dir]);

  useEffect(() => {
    let cancelled = false;
    // Light debounce so typing does not query on every key.
    const handle = window.setTimeout(() => {
      api
        .listTenants({ q, status, mode, sort, dir, limit: PAGE, offset })
        .then((r) => !cancelled && setData(r))
        .catch((e) => !cancelled && props.onError(e));
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, q, status, mode, sort, dir, offset, props.refreshKey]);

  const from = data === null || data.total === 0 ? 0 : offset + 1;
  const to = data === null ? 0 : offset + data.tenants.length;

  return (
    <section aria-label={t(lang, 'tenancy.super.tab.workspaces')}>
      <CreateAdmin
        lang={lang}
        api={api}
        onCreated={(result) => {
          setCreated(result);
          props.onCreated(t(lang, 'tenancy.super.created', { email: result.email }));
        }}
        onError={props.onError}
      />
      {created === null ? null : (
        <div className="tenancy-success" role="status">
          <strong>{t(lang, 'tenancy.super.createdTitle')}</strong>
          <dl>
            <dt>{t(lang, 'tenancy.super.colName')}</dt>
            <dd>{created.name}</dd>
            <dt>{t(lang, 'tenancy.super.colAdmin')}</dt>
            <dd>
              {created.displayName === null ? null : `${created.displayName} · `}
              {created.email}
            </dd>
            <dt>{t(lang, 'tenancy.panel.id')}</dt>
            <dd>
              <code>{created.id}</code>
            </dd>
            <dt>{t(lang, 'tenancy.super.colStorage')}</dt>
            <dd>{t(lang, 'tenancy.mode.local')}</dd>
          </dl>
          <p>{t(lang, 'tenancy.super.createdNext')}</p>
        </div>
      )}

      <h2>{t(lang, 'tenancy.super.listTitle')}</h2>
      <div className="tenancy-controls" role="search">
        <label>
          {t(lang, 'tenancy.list.search')}
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t(lang, 'tenancy.super.searchPlaceholder')} />
        </label>
        <label>
          {t(lang, 'tenancy.super.colStatus')}
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="all">{t(lang, 'tenancy.list.all')}</option>
            <option value="active">{t(lang, 'tenancy.tenantStatus.active')}</option>
            <option value="deactivated">{t(lang, 'tenancy.tenantStatus.deactivated')}</option>
            <option value="deletion_requested">{t(lang, 'tenancy.tenantStatus.deletion_requested')}</option>
          </select>
        </label>
        <label>
          {t(lang, 'tenancy.super.colStorage')}
          <select className="input" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="all">{t(lang, 'tenancy.list.all')}</option>
            <option value="web">{t(lang, 'tenancy.modeShort.web')}</option>
            <option value="local">{t(lang, 'tenancy.modeShort.local')}</option>
          </select>
        </label>
        <label>
          {t(lang, 'tenancy.list.sortBy')}
          <select className="input" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            {SORTS.map((s) => (
              <option key={s} value={s}>
                {t(lang, `tenancy.super.sort.${s}` as TranslationKey)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-ghost" onClick={() => setDir(dir === 'asc' ? 'desc' : 'asc')}>
          {dir === 'asc' ? '↑' : '↓'} {t(lang, dir === 'asc' ? 'tenancy.list.ascending' : 'tenancy.list.descending')}
        </button>
      </div>

      {data === null ? (
        <p role="status">{t(lang, 'tenancy.working')}</p>
      ) : data.total === 0 ? (
        q === '' && status === 'all' && mode === 'all' ? (
          <div className="tenancy-empty" role="note">
            <strong>{t(lang, 'tenancy.super.emptyTitle')}</strong>
            <p>{t(lang, 'tenancy.super.emptyBody')}</p>
          </div>
        ) : (
          <p>{t(lang, 'tenancy.super.noMatch')}</p>
        )
      ) : (
        <>
          <p className="link-help" role="status">
            {t(lang, 'tenancy.list.range', { from, to, total: data.total })}
          </p>
          <div className="tenancy-table-wrap">
            <table className="tenancy-table">
              <caption className="sr-only">{t(lang, 'tenancy.super.listTitle')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t(lang, 'tenancy.super.colName')}</th>
                  <th scope="col">{t(lang, 'tenancy.super.colAdmin')}</th>
                  <th scope="col">{t(lang, 'tenancy.super.colStorage')}</th>
                  <th scope="col">{t(lang, 'tenancy.super.colUsers')}</th>
                  <th scope="col">{t(lang, 'tenancy.super.colStatus')}</th>
                  <th scope="col">{t(lang, 'tenancy.super.colActivity')}</th>
                  <th scope="col">{t(lang, 'tenancy.super.colCreated')}</th>
                  <th scope="col">
                    <span className="sr-only">{t(lang, 'tenancy.list.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.tenants.map((tn) => (
                  <tr key={tn.id}>
                    <th scope="row" className="tenancy-user-cell">
                      <strong>{tn.name}</strong>
                      <code>{tn.id}</code>
                    </th>
                    <td className="tenancy-user-cell">
                      {tn.adminDisplayName === null ? null : <strong>{tn.adminDisplayName}</strong>}
                      <span>{tn.adminEmail}</span>
                      {tn.adminOutsideManagedDomains ? (
                        <span className="link-help" role="note">
                          <span aria-hidden="true">⚠ </span>
                          {t(lang, 'tenancy.super.outsideDomainWarning')}
                        </span>
                      ) : null}
                    </td>
                    <td>{t(lang, `tenancy.modeShort.${tn.storageMode}` as TranslationKey)}</td>
                    <td>{tn.userCount}</td>
                    <td>
                      <StatusBadge lang={lang} status={tn.status} />
                    </td>
                    <td>{tn.lastActivityAt === null ? t(lang, 'tenancy.never') : whenText(tn.lastActivityAt, lang)}</td>
                    <td>{whenText(tn.createdAt, lang)}</td>
                    <td>
                      {tn.status === 'deletion_requested' ? (
                        <button type="button" className="btn btn-danger" disabled={props.busy} onClick={props.onReview}>
                          {t(lang, 'tenancy.super.review')}
                        </button>
                      ) : tn.status === 'active' || tn.status === 'deactivated' ? (
                        <button type="button" className="btn" disabled={props.busy} onClick={() => void props.onToggle(tn)}>
                          {t(lang, tn.status === 'active' ? 'tenancy.super.deactivate' : 'tenancy.super.activate')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="dr-button-row">
            <button type="button" className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              {t(lang, 'tenancy.list.previous')}
            </button>
            <button type="button" className="btn" disabled={to >= data.total} onClick={() => setOffset(offset + PAGE)}>
              {t(lang, 'tenancy.list.next')}
            </button>
          </div>
          <p className="link-help">{t(lang, 'tenancy.lastActivityNote')}</p>
        </>
      )}
    </section>
  );
}

function CreateAdmin({
  lang,
  api,
  onCreated,
  onError,
}: {
  lang: Language;
  api: TenancyApi;
  onCreated: (r: { name: string; email: string; displayName: string | null; id: string }) => void;
  onError: (e: unknown) => void;
}) {
  const [name, setName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const r = await api.createTenant(name, adminEmail, displayName);
      onCreated({ name: r.tenant.name, email: r.admin.email, displayName: r.admin.displayName, id: r.tenant.id });
      setName('');
      setAdminEmail('');
      setDisplayName('');
    } catch (e) {
      if (isSessionEnded(e)) onError(e);
      else setProblem(t(lang, errorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="tenancy-form"
      aria-labelledby="create-admin-title"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2 id="create-admin-title">{t(lang, 'tenancy.super.createTitle')}</h2>
      <label className="link-confirm">
        {t(lang, 'tenancy.super.nameLabel')}
        <input className="input" required value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </label>
      <label className="link-confirm">
        {t(lang, 'tenancy.super.adminEmailLabel')}
        <input className="input" type="email" required value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} autoComplete="off" aria-describedby="create-admin-hint" />
      </label>
      <label className="link-confirm">
        {t(lang, 'tenancy.super.adminNameLabel')}
        <input className="input" value={displayName} maxLength={80} onChange={(e) => setDisplayName(e.target.value)} autoComplete="off" />
      </label>
      <p id="create-admin-hint" className="link-help">
        {t(lang, 'tenancy.super.createHint')}
      </p>
      {problem === null ? null : (
        <p role="alert" className="data-controls-message error">
          {problem}
        </p>
      )}
      <button type="submit" className="btn btn-primary" disabled={busy || name.trim() === '' || adminEmail.trim() === ''}>
        {t(lang, 'tenancy.super.create')}
      </button>
    </form>
  );
}

function Deletions({ lang, rows, busy, onApprove, onReject }: { lang: Language; rows: TenantSummaryDto[] | null; busy: boolean; onApprove: (tn: TenantSummaryDto) => Promise<void>; onReject: (tn: TenantSummaryDto) => Promise<void> }) {
  if (rows === null) return <p role="status">{t(lang, 'tenancy.working')}</p>;
  return (
    <section aria-label={t(lang, 'tenancy.super.tab.deletions')}>
      <h2>{t(lang, 'tenancy.super.tab.deletions')}</h2>
      <p className="dr-summary">{t(lang, 'tenancy.super.deletionsHelp')}</p>
      {rows.length === 0 ? (
        <div className="tenancy-empty" role="note">
          <strong>{t(lang, 'tenancy.super.noDeletions')}</strong>
        </div>
      ) : (
        <ul className="tenancy-cards">
          {rows.map((tn) => (
            <li key={tn.id} className="tenancy-card">
              <h3>{tn.name}</h3>
              <dl>
                <dt>{t(lang, 'tenancy.panel.id')}</dt>
                <dd>
                  <code>{tn.id}</code>
                </dd>
                <dt>{t(lang, 'tenancy.super.colAdmin')}</dt>
                <dd>{tn.adminEmail}</dd>
                <dt>{t(lang, 'tenancy.super.colStorage')}</dt>
                <dd>{t(lang, `tenancy.mode.${tn.storageMode}` as TranslationKey)}</dd>
                <dt>{t(lang, 'tenancy.super.colUsers')}</dt>
                <dd>{tn.userCount}</dd>
                <dt>{t(lang, 'tenancy.super.colActivity')}</dt>
                <dd>{tn.lastActivityAt === null ? t(lang, 'tenancy.never') : whenText(tn.lastActivityAt, lang)}</dd>
                <dt>{t(lang, 'tenancy.super.colRequested')}</dt>
                <dd>{whenText(tn.deletionRequestedAt, lang)}</dd>
              </dl>
              <p className="link-help">{t(lang, 'tenancy.super.metadataOnly')}</p>
              <div className="dr-button-row">
                <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void onApprove(tn)}>
                  {t(lang, 'tenancy.super.approve')}
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => void onReject(tn)}>
                  {t(lang, 'tenancy.super.reject')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DeletionRecords({ lang, load, onError }: { lang: Language; load: () => Promise<DeletionAudit[]>; onError: (e: unknown) => void }) {
  const [rows, setRows] = useState<DeletionAudit[] | null>(null);
  useEffect(() => {
    void load().then(setRows, onError);
  }, [load, onError]);
  return (
    <section className="dr-section" aria-labelledby="deletion-records-title">
      <h2 id="deletion-records-title">{t(lang, 'tenancy.super.auditTitle')}</h2>
      {rows === null ? (
        <p role="status">{t(lang, 'tenancy.working')}</p>
      ) : rows.length === 0 ? (
        <p>{t(lang, 'tenancy.super.auditEmpty')}</p>
      ) : (
        <div className="tenancy-table-wrap">
          <table className="tenancy-table">
            <thead>
              <tr>
                <th scope="col">{t(lang, 'tenancy.panel.id')}</th>
                <th scope="col">{t(lang, 'tenancy.super.auditRequested')}</th>
                <th scope="col">{t(lang, 'tenancy.super.auditApproved')}</th>
                <th scope="col">{t(lang, 'tenancy.super.auditWhen')}</th>
                <th scope="col">{t(lang, 'tenancy.super.auditUsers')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
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
  );
}
