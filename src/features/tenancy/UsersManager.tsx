import { useCallback, useEffect, useState } from 'react';
import { t, type TranslationKey } from '../../i18n';
import type { TenancyApi } from '../../lib/tenancy/api';
import type { UserAccess, UserDto } from '../../../shared/tenancy';
import type { Language } from '../../types';
import { errorKey, isSessionEnded, whenText } from './format';
import { useSession } from '../../app/session-context';

type Message = { kind: 'ok' | 'error'; text: string } | null;

/** Admin only, web mode only. Adding a user registers an email address; nothing is sent. */
export function UsersManager({ lang, api }: { lang: Language; api: TenancyApi }) {
  const [users, setUsers] = useState<UserDto[] | null>(null);
  const [email, setEmail] = useState('');
  const [access, setAccess] = useState<UserAccess>('editor');
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const session = useSession();

  const load = useCallback(async (): Promise<void> => {
    try {
      setUsers(await api.listUsers());
    } catch (e) {
      if (isSessionEnded(e)) session.endSession('expired');
      else setMessage({ kind: 'error', text: t(lang, errorKey(e)) });
    }
  }, [api, lang, session]);

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
      if (isSessionEnded(e)) session.endSession('expired');
      else setMessage({ kind: 'error', text: t(lang, errorKey(e)) });
    } finally {
      setBusy(false);
      await load();
    }
  };

  const add = (): Promise<void> =>
    run(async () => {
      await api.createUser(email, access);
      setEmail('');
      return t(lang, 'tenancy.users.added');
    });

  const toggle = (user: UserDto): Promise<void> => {
    if (user.status !== 'disabled' && !window.confirm(t(lang, 'tenancy.users.disableConfirm', { email: user.email }))) return Promise.resolve();
    return run(async () => {
      const result = await api.updateUser(user.id, { status: user.status === 'disabled' ? 'enabled' : 'disabled' });
      return user.status !== 'disabled' && !result.disconnected ? t(lang, 'tenancy.users.notDisconnected') : null;
    });
  };

  const changeAccess = (user: UserDto, next: UserAccess): Promise<void> => run(async () => (await api.updateUser(user.id, { access: next }), null));

  return (
    <section className="dr-section" aria-labelledby="tenancy-users-title">
      <h2 id="tenancy-users-title">{t(lang, 'tenancy.users.title')}</h2>
      <p className="dr-summary">{t(lang, 'tenancy.users.help')}</p>
      {message === null ? null : (
        <p className={`data-controls-message ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
      <div className="dr-button-row">
        <label className="link-confirm">
          {t(lang, 'tenancy.users.emailLabel')}
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        </label>
        <label className="link-confirm">
          {t(lang, 'tenancy.users.colAccess')}
          <select className="input" value={access} onChange={(e) => setAccess(e.target.value as UserAccess)}>
            <option value="editor">{t(lang, 'tenancy.access.editor')}</option>
            <option value="viewer">{t(lang, 'tenancy.access.viewer')}</option>
          </select>
        </label>
        <button type="button" className="btn btn-primary" disabled={busy || email.trim() === ''} onClick={() => void add()}>
          {t(lang, 'tenancy.users.add')}
        </button>
      </div>
      {users === null ? (
        <p role="status">{t(lang, 'tenancy.working')}</p>
      ) : (
        <div className="tenancy-table-wrap">
          <table className="tenancy-table">
            <thead>
              <tr>
                <th>{t(lang, 'tenancy.users.colEmail')}</th>
                <th>{t(lang, 'tenancy.users.colAccess')}</th>
                <th>{t(lang, 'tenancy.users.colStatus')}</th>
                <th>{t(lang, 'tenancy.users.colLastLogin')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users
                .filter((u) => u.role === 'user')
                .map((user) => (
                  <tr key={user.id}>
                    <td>{user.email}</td>
                    <td>
                      <select className="input" value={user.access} disabled={busy} aria-label={t(lang, 'tenancy.users.colAccess')} onChange={(e) => void changeAccess(user, e.target.value as UserAccess)}>
                        <option value="editor">{t(lang, 'tenancy.access.editor')}</option>
                        <option value="viewer">{t(lang, 'tenancy.access.viewer')}</option>
                      </select>
                    </td>
                    <td>{t(lang, `tenancy.userStatus.${user.status}` as TranslationKey)}</td>
                    <td>{user.lastLoginAt === null ? t(lang, 'tenancy.never') : whenText(user.lastLoginAt, lang)}</td>
                    <td>
                      <button type="button" className="btn" disabled={busy} onClick={() => void toggle(user)}>
                        {t(lang, user.status === 'disabled' ? 'tenancy.users.enable' : 'tenancy.users.disable')}
                      </button>
                    </td>
                  </tr>
                ))}
              {users.every((u) => u.role !== 'user') ? (
                <tr>
                  <td colSpan={5}>{t(lang, 'tenancy.users.empty')}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
