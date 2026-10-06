import { useCallback, useEffect, useState } from 'react';
import { t, type TranslationKey } from '../../i18n';
import { useConfirm } from '../../components/ConfirmDialog';
import type { TenancyApi } from '../../lib/tenancy/api';
import type { UserAccess, UserDto } from '../../../shared/tenancy';
import type { Language } from '../../types';
import { errorKey, isSessionEnded, whenText } from './format';
import { DEFAULT_USER_VIEW, viewUsers, type UserSort, type UserStatusFilter, type UserView } from './usersView';
import { useSession } from '../../app/session-context';

type Message = { kind: 'ok' | 'error'; text: string } | null;

/** Admin only, Web mode only. Adding a User registers an email address in the managed domain; nothing is sent. */
export function UsersManager({ lang, api }: { lang: Language; api: TenancyApi }) {
  const [users, setUsers] = useState<UserDto[] | null>(null);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [access, setAccess] = useState<UserAccess>('editor');
  const [view, setView] = useState<UserView>(DEFAULT_USER_VIEW);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const session = useSession();
  const confirm = useConfirm();

  const handle = useCallback(
    (e: unknown): void => {
      if (isSessionEnded(e)) session.endSession('expired');
      else setMessage({ kind: 'error', text: t(lang, errorKey(e)) });
    },
    [lang, session],
  );

  const load = useCallback(async (): Promise<void> => {
    try {
      setUsers(await api.listUsers());
    } catch (e) {
      handle(e);
    }
  }, [api, handle]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<string | null>): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await action();
      if (text !== null) setMessage({ kind: 'ok', text });
    } catch (e) {
      handle(e);
    } finally {
      setBusy(false);
      await load();
    }
  };

  const add = (): Promise<void> =>
    run(async () => {
      const created = await api.createUser(email, access, displayName);
      setEmail('');
      setDisplayName('');
      return t(lang, 'tenancy.users.added', { email: created.email });
    });

  const toggle = async (user: UserDto): Promise<void> => {
    const disabling = user.status !== 'disabled';
    const who = user.displayName ?? user.email;
    const ok = await confirm({
      title: t(lang, disabling ? 'tenancy.users.disableTitle' : 'tenancy.users.enableTitle', { name: who }),
      body: <p>{t(lang, disabling ? 'tenancy.users.disableBody' : 'tenancy.users.enableBody', { email: user.email })}</p>,
      confirmLabel: t(lang, disabling ? 'tenancy.users.disable' : 'tenancy.users.enable'),
      cancelLabel: t(lang, 'tenancy.cancel'),
      severity: disabling ? 'warning' : 'normal',
    });
    if (!ok) return;
    await run(async () => {
      const result = await api.updateUser(user.id, { status: disabling ? 'disabled' : 'enabled' });
      if (disabling) return result.disconnected ? t(lang, 'tenancy.users.disabledDone', { email: user.email }) : t(lang, 'tenancy.users.notDisconnected');
      return t(lang, 'tenancy.users.enabledDone', { email: user.email });
    });
  };

  const changeAccess = (user: UserDto, next: UserAccess): Promise<void> => run(async () => (await api.updateUser(user.id, { access: next }), null));

  const shown = users === null ? [] : viewUsers(users, view);
  const total = users === null ? 0 : users.filter((u) => u.role === 'user').length;

  return (
    <section className="dr-section" aria-labelledby="tenancy-users-title">
      <h2 id="tenancy-users-title">{t(lang, 'tenancy.users.title')}</h2>
      <p className="dr-summary">{t(lang, 'tenancy.users.help')}</p>
      <div aria-live="polite">
        {message === null ? null : (
          <p className={`data-controls-message ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
            {message.text}
          </p>
        )}
      </div>

      <form
        className="tenancy-form"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <h3>{t(lang, 'tenancy.users.addTitle')}</h3>
        <label className="link-confirm">
          {t(lang, 'tenancy.users.emailLabel')}
          <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        </label>
        <label className="link-confirm">
          {t(lang, 'tenancy.users.nameLabel')}
          <input className="input" value={displayName} maxLength={80} onChange={(e) => setDisplayName(e.target.value)} autoComplete="off" />
        </label>
        <label className="link-confirm">
          {t(lang, 'tenancy.users.colAccess')}
          <select className="input" value={access} onChange={(e) => setAccess(e.target.value as UserAccess)}>
            <option value="editor">{t(lang, 'tenancy.access.editor')}</option>
            <option value="viewer">{t(lang, 'tenancy.access.viewer')}</option>
          </select>
        </label>
        <p className="link-help">{t(lang, 'tenancy.users.domainHint')}</p>
        <button type="submit" className="btn btn-primary" disabled={busy || email.trim() === ''}>
          {t(lang, 'tenancy.users.add')}
        </button>
      </form>

      {users === null ? (
        <p role="status">{t(lang, 'tenancy.working')}</p>
      ) : total === 0 ? (
        <div className="tenancy-empty" role="note">
          <strong>{t(lang, 'tenancy.users.emptyTitle')}</strong>
          <p>{t(lang, 'tenancy.users.emptyBody')}</p>
        </div>
      ) : (
        <>
          <div className="tenancy-controls" role="search">
            <label>
              {t(lang, 'tenancy.list.search')}
              <input className="input" type="search" value={view.q} onChange={(e) => setView({ ...view, q: e.target.value })} placeholder={t(lang, 'tenancy.users.searchPlaceholder')} />
            </label>
            <label>
              {t(lang, 'tenancy.users.colStatus')}
              <select className="input" value={view.status} onChange={(e) => setView({ ...view, status: e.target.value as UserStatusFilter })}>
                <option value="all">{t(lang, 'tenancy.list.all')}</option>
                <option value="active">{t(lang, 'tenancy.userStatus.active')}</option>
                <option value="disabled">{t(lang, 'tenancy.userStatus.disabled')}</option>
              </select>
            </label>
            <label>
              {t(lang, 'tenancy.list.sortBy')}
              <select className="input" value={view.sort} onChange={(e) => setView({ ...view, sort: e.target.value as UserSort })}>
                {(['name', 'email', 'created', 'status', 'activity'] as const).map((s) => (
                  <option key={s} value={s}>
                    {t(lang, `tenancy.users.sort.${s}` as TranslationKey)}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn btn-ghost" aria-label={t(lang, view.dir === 'asc' ? 'tenancy.list.ascending' : 'tenancy.list.descending')} onClick={() => setView({ ...view, dir: view.dir === 'asc' ? 'desc' : 'asc' })}>
              {view.dir === 'asc' ? '↑' : '↓'} {t(lang, view.dir === 'asc' ? 'tenancy.list.ascending' : 'tenancy.list.descending')}
            </button>
          </div>
          <p className="link-help" role="status">
            {t(lang, 'tenancy.list.showing', { shown: shown.length, total })}
          </p>
          {shown.length === 0 ? (
            <p>{t(lang, 'tenancy.users.noMatch')}</p>
          ) : (
            <div className="tenancy-table-wrap">
              <table className="tenancy-table">
                <caption className="sr-only">{t(lang, 'tenancy.users.title')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t(lang, 'tenancy.users.colUser')}</th>
                    <th scope="col">{t(lang, 'tenancy.users.colRole')}</th>
                    <th scope="col">{t(lang, 'tenancy.users.colAccess')}</th>
                    <th scope="col">{t(lang, 'tenancy.users.colStatus')}</th>
                    <th scope="col">{t(lang, 'tenancy.users.colCreated')}</th>
                    <th scope="col">{t(lang, 'tenancy.users.colUpdated')}</th>
                    <th scope="col">{t(lang, 'tenancy.users.colLastLogin')}</th>
                    <th scope="col">
                      <span className="sr-only">{t(lang, 'tenancy.list.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((user) => (
                    <tr key={user.id}>
                      <th scope="row" className="tenancy-user-cell">
                        {user.displayName === null ? null : <strong>{user.displayName}</strong>}
                        <span>{user.email}</span>
                      </th>
                      <td>{t(lang, 'tenancy.role.user')}</td>
                      <td>
                        <select className="input" value={user.access} disabled={busy} aria-label={`${t(lang, 'tenancy.users.colAccess')}: ${user.email}`} onChange={(e) => void changeAccess(user, e.target.value as UserAccess)}>
                          <option value="editor">{t(lang, 'tenancy.access.editor')}</option>
                          <option value="viewer">{t(lang, 'tenancy.access.viewer')}</option>
                        </select>
                      </td>
                      <td>
                        <StatusBadge lang={lang} status={user.status} />
                      </td>
                      <td>{whenText(user.createdAt, lang)}</td>
                      <td>{whenText(user.updatedAt, lang)}</td>
                      <td>{user.lastLoginAt === null ? t(lang, 'tenancy.never') : whenText(user.lastLoginAt, lang)}</td>
                      <td>
                        <button type="button" className="btn" disabled={busy} onClick={() => void toggle(user)}>
                          {t(lang, user.status === 'disabled' ? 'tenancy.users.enable' : 'tenancy.users.disable')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="link-help">{t(lang, 'tenancy.lastActivityNote')}</p>
        </>
      )}
    </section>
  );
}

/** Status in words and a symbol — never colour alone. */
export function StatusBadge({ lang, status }: { lang: Language; status: 'active' | 'disabled' | 'deactivated' | 'deletion_requested' | 'deleting' }) {
  const key = status === 'deactivated' ? 'disabled' : status;
  const symbol = key === 'active' ? '●' : key === 'disabled' ? '⏸' : key === 'deletion_requested' ? '⚠' : '⛔';
  const label = key === 'active' || key === 'disabled' ? `tenancy.userStatus.${key}` : `tenancy.tenantStatus.${key}`;
  return (
    <span className={`status-badge status-${key}`}>
      <span aria-hidden="true">{symbol} </span>
      {t(lang, label as TranslationKey)}
    </span>
  );
}
