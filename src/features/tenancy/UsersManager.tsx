import { useCallback, useEffect, useState } from 'react';
import { t, type TranslationKey } from '../../i18n';
import { useConfirm } from '../../components/ConfirmDialog';
import type { TenancyApi } from '../../lib/tenancy/api';
import type { UserAccess, UserDto } from '../../../shared/tenancy';
import type { Language, RcsMember } from '../../types';
import { errorKey, isSessionEnded, whenText } from './format';
import { DEFAULT_USER_VIEW, viewUsers, type UserRoleFilter, type UserSort, type UserStatusFilter, type UserView } from './usersView';
import { useSession } from '../../app/session-context';
import { memberRows, nameSuggestions, ownershipCandidates, rosterOnly } from '../../domain/teamMembers';

type Message = { kind: 'ok' | 'error'; text: string } | null;
type NewRole = 'sv' | 'tester';

/** The words for a person's role. An SV is the internal role "admin"; a Tester is "user". */
export function roleLabelKey(user: Pick<UserDto, 'role'>): TranslationKey {
  return user.role === 'admin' ? 'tenancy.role.sv' : 'tenancy.role.tester';
}

/**
 * Team Members (SV only, Web mode only): the people who can sign in to this workspace. Adding a member registers an email
 * address in the managed domain; nothing is sent. The person later signs in through Cloudflare Access with the same address
 * and lands in this workspace; there is no invitation code, password or workspace chooser.
 */
export function UsersManager({
  lang,
  api,
  members = [],
  currentUserId = null,
  onChanged,
}: {
  lang: Language;
  api: TenancyApi;
  /** The workspace's roster (Team Member profiles), to show which account has a profile. */
  members?: readonly RcsMember[];
  /** The signed-in SV's own account id (nobody can disable themselves). */
  currentUserId?: string | null;
  /** Called after any change, so the screen can refresh other parts (workload, audit). */
  onChanged?: () => void;
}) {
  const [users, setUsers] = useState<UserDto[] | null>(null);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<NewRole>('tester');
  const [access, setAccess] = useState<UserAccess>('editor');
  const [view, setView] = useState<UserView>(DEFAULT_USER_VIEW);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState<Record<string, string>>({});
  const session = useSession();
  const confirm = useConfirm();

  const handle = useCallback(
    (e: unknown): void => {
      if (isSessionEnded(e)) session.endSession('expired');
      else setMessage({ kind: 'error', text: t(lang, errorKey(e, 'tester')) });
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
      onChanged?.();
    }
  };

  const add = (): Promise<void> =>
    run(async () => {
      const created = await api.createUser(email, role === 'sv' ? 'editor' : access, displayName, role);
      setEmail('');
      setDisplayName('');
      return t(lang, created.role === 'admin' ? 'tenancy.users.addedSv' : 'tenancy.users.added', { email: created.email });
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

  const transfer = async (user: UserDto): Promise<void> => {
    const who = user.displayName ?? user.email;
    const ok = await confirm({
      title: t(lang, 'tenancy.owner.transferTitle', { name: who }),
      body: (
        <>
          <p>{t(lang, 'tenancy.owner.transferBody', { email: user.email })}</p>
          <p>{t(lang, 'tenancy.owner.transferKeeps')}</p>
        </>
      ),
      confirmLabel: t(lang, 'tenancy.owner.transferConfirm'),
      cancelLabel: t(lang, 'tenancy.cancel'),
      severity: 'warning',
    });
    if (!ok) return;
    await run(async () => {
      await api.transferOwnership(user.id);
      // The signed-in person is not the Owner any more: the screen and the buttons must follow.
      window.location.reload();
      return t(lang, 'tenancy.owner.transferred', { email: user.email });
    });
  };

  const createProfile = (user: UserDto): Promise<void> => run(async () => (await api.createProfile(user.id), t(lang, 'tenancy.members.profileCreated', { email: user.email })));

  const link = (user: UserDto, memberId: string): Promise<void> =>
    run(async () => {
      await api.linkMember(memberId, user.id);
      setLinking((prev) => ({ ...prev, [user.id]: '' }));
      return t(lang, 'tenancy.members.linked', { email: user.email, id: memberId });
    });

  const everyone = users ?? [];
  const shown = users === null ? [] : viewUsers(users, view);
  const rows = new Map(memberRows(everyone, members).map((r) => [r.user.id, r]));
  const roster = rosterOnly(members);
  const iAmOwner = everyone.some((u) => u.id === currentUserId && u.isOwner);
  const heirs = ownershipCandidates(everyone);

  return (
    <section className="dr-section" aria-labelledby="tenancy-users-title">
      <h2 id="tenancy-users-title">{t(lang, 'team.members.title')}</h2>
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
          {t(lang, 'tenancy.users.colRole')}
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as NewRole)}>
            <option value="tester">{t(lang, 'tenancy.role.tester')}</option>
            <option value="sv">{t(lang, 'tenancy.role.sv')}</option>
          </select>
        </label>
        <p className="link-help">{t(lang, role === 'sv' ? 'tenancy.users.roleHelpSv' : 'tenancy.users.roleHelpTester')}</p>
        {role === 'tester' ? (
          <label className="link-confirm">
            {t(lang, 'tenancy.users.colAccess')}
            <select className="input" value={access} onChange={(e) => setAccess(e.target.value as UserAccess)}>
              <option value="editor">{t(lang, 'tenancy.access.editor')}</option>
              <option value="viewer">{t(lang, 'tenancy.access.viewer')}</option>
            </select>
          </label>
        ) : null}
        <p className="link-help">{t(lang, 'tenancy.users.domainHint')}</p>
        <button type="submit" className="btn btn-primary" disabled={busy || email.trim() === ''}>
          {t(lang, 'tenancy.users.add')}
        </button>
      </form>

      {users === null ? (
        <p role="status">{t(lang, 'tenancy.working')}</p>
      ) : (
        <>
          <div className="tenancy-controls" role="search">
            <label>
              {t(lang, 'tenancy.list.search')}
              <input className="input" type="search" value={view.q} onChange={(e) => setView({ ...view, q: e.target.value })} placeholder={t(lang, 'tenancy.users.searchPlaceholder')} />
            </label>
            <label>
              {t(lang, 'tenancy.users.colRole')}
              <select className="input" value={view.role} onChange={(e) => setView({ ...view, role: e.target.value as UserRoleFilter })}>
                <option value="all">{t(lang, 'tenancy.list.all')}</option>
                <option value="sv">{t(lang, 'tenancy.role.sv')}</option>
                <option value="tester">{t(lang, 'tenancy.role.tester')}</option>
              </select>
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
            {t(lang, 'tenancy.list.showing', { shown: shown.length, total: everyone.length })}
          </p>
          {shown.length === 0 ? (
            <p>{t(lang, 'tenancy.users.noMatch')}</p>
          ) : (
            <div className="tenancy-table-wrap">
              <table className="tenancy-table">
                <caption className="sr-only">{t(lang, 'team.members.title')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t(lang, 'tenancy.users.colUser')}</th>
                    <th scope="col">{t(lang, 'tenancy.users.colRole')}</th>
                    <th scope="col">{t(lang, 'tenancy.users.colAccess')}</th>
                    <th scope="col">{t(lang, 'tenancy.users.colStatus')}</th>
                    <th scope="col">{t(lang, 'tenancy.members.colProfile')}</th>
                    <th scope="col">{t(lang, 'tenancy.users.colCreated')}</th>
                    <th scope="col">{t(lang, 'tenancy.users.colLastLogin')}</th>
                    <th scope="col">
                      <span className="sr-only">{t(lang, 'tenancy.list.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((user) => {
                    const profile = rows.get(user.id)?.profile ?? null;
                    const suggestions = profile === null ? nameSuggestions(user, roster) : [];
                    const self = user.id === currentUserId;
                    return (
                      <tr key={user.id}>
                        <th scope="row" className="tenancy-user-cell">
                          {user.displayName === null ? null : <strong>{user.displayName}</strong>}
                          <span>{user.email}</span>
                        </th>
                        <td>
                          {t(lang, roleLabelKey(user))}
                          {user.isOwner ? (
                            <>
                              {' '}
                              <span className="status-badge status-owner">
                                <span aria-hidden="true">★ </span>
                                {t(lang, 'tenancy.owner.badge')}
                              </span>
                            </>
                          ) : null}
                        </td>
                        <td>
                          {user.role === 'admin' ? (
                            '—'
                          ) : (
                            <select className="input" value={user.access} disabled={busy} aria-label={`${t(lang, 'tenancy.users.colAccess')}: ${user.email}`} onChange={(e) => void changeAccess(user, e.target.value as UserAccess)}>
                              <option value="editor">{t(lang, 'tenancy.access.editor')}</option>
                              <option value="viewer">{t(lang, 'tenancy.access.viewer')}</option>
                            </select>
                          )}
                        </td>
                        <td>
                          <StatusBadge lang={lang} status={user.status} />
                        </td>
                        <td>
                          {profile !== null ? (
                            <span title={profile.id}>
                              {profile.id}
                            </span>
                          ) : (
                            <div className="tenancy-profile-actions">
                              <span>{t(lang, 'tenancy.members.noProfile')}</span>
                              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void createProfile(user)}>
                                {t(lang, 'tenancy.members.createProfile')}
                              </button>
                              {roster.length > 0 ? (
                                <span className="tenancy-link-row">
                                  <select
                                    className="input"
                                    value={linking[user.id] ?? ''}
                                    aria-label={`${t(lang, 'tenancy.members.linkTo')}: ${user.email}`}
                                    onChange={(e) => setLinking((prev) => ({ ...prev, [user.id]: e.target.value }))}
                                  >
                                    <option value="">{t(lang, 'tenancy.members.linkTo')}</option>
                                    {roster.map((m) => (
                                      <option key={m.id} value={m.id}>
                                        {m.id} — {m.name}
                                        {suggestions.some((s) => s.id === m.id) ? ` (${t(lang, 'tenancy.members.sameName')})` : ''}
                                      </option>
                                    ))}
                                  </select>
                                  <button type="button" className="btn" disabled={busy || (linking[user.id] ?? '') === ''} onClick={() => void link(user, linking[user.id])}>
                                    {t(lang, 'tenancy.members.link')}
                                  </button>
                                </span>
                              ) : null}
                            </div>
                          )}
                        </td>
                        <td>{whenText(user.createdAt, lang)}</td>
                        <td>{user.lastLoginAt === null ? t(lang, 'tenancy.never') : whenText(user.lastLoginAt, lang)}</td>
                        <td className="dr-row-actions">
                          {user.isOwner || self ? (
                            <span className="link-help">{t(lang, user.isOwner ? 'tenancy.owner.cannotDisable' : 'tenancy.users.itsYou')}</span>
                          ) : (
                            <button type="button" className="btn" disabled={busy} onClick={() => void toggle(user)}>
                              {t(lang, user.status === 'disabled' ? 'tenancy.users.enable' : 'tenancy.users.disable')}
                            </button>
                          )}
                          {iAmOwner && heirs.some((h) => h.id === user.id) ? (
                            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void transfer(user)}>
                              {t(lang, 'tenancy.owner.transfer')}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
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
