import { useCallback, useEffect, useMemo, useState } from 'react';
import { t, resolveBilingualName } from '../../i18n';
import { useConfirm } from '../../components/ConfirmDialog';
import { useSession } from '../../app/session-context';
import { businessDate } from '../../../shared/businessTime';
import { memberRoleWord, type MemberRole } from '../../../shared/members';
import type { TenancyApi } from '../../lib/tenancy/api';
import type { UserAccess, UserDto } from '../../../shared/tenancy';
import type { Language, ProjectRecord, RcsMember, TesterProjectAssignment } from '../../types';
import { compactNames } from '../../domain/people';
import { directoryRows, emailTaken, intendedRoleOf, isLinked, memberState, normalizeMemberEmail, optionLabel, ownershipCandidates, type DirectoryRow } from '../../domain/teamMembers';
import { nextMemberId } from '../../domain/members';
import { errorKey, isSessionEnded } from './format';
import { StatusBadge } from './UsersManager';

type Message = { kind: 'ok' | 'error'; text: string } | null;
type StatusFilter = 'active' | 'all' | 'removed';

/**
 * Team Members (SV): the workspace's ONE people directory. Every person chosen anywhere in the app is a profile listed here. A profile
 * may have a login account (Web storage) or not; both are shown, with the login's state beside the member's, because "removed from the
 * team" and "login disabled" are different things that this screen changes together only when you say so.
 *
 * With `api === null` (Local storage) people are profiles only: nobody can sign in, so nothing about logins is offered.
 */
export function TeamDirectory({
  lang,
  api,
  members = [],
  assignments = [],
  projects = [],
  onUpsertMember = () => undefined,
  currentUserId = null,
  onEditDetails,
  onChanged,
}: {
  lang: Language;
  /** The workspace's profiles, assignments and projects (from the shared state). */
  members?: readonly RcsMember[];
  assignments?: readonly TesterProjectAssignment[];
  projects?: readonly ProjectRecord[];
  /** Local storage only: change a profile directly (Web storage goes through the server). */
  onUpsertMember?: (member: RcsMember) => void;
  /** null in Local storage: profiles only. */
  api: TenancyApi | null;
  /** The signed-in SV's own account id (nobody removes or re-roles themselves). */
  currentUserId?: string | null;
  /** Open the full profile form (dates, name history) for one profile. */
  onEditDetails?: (memberId: string) => void;
  onChanged?: () => void;
}) {
  const today = businessDate();
  const confirm = useConfirm();
  const session = useSession();
  const web = api !== null;

  const [users, setUsers] = useState<UserDto[] | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('tester');
  const [withLogin, setWithLogin] = useState(false);
  const [access, setAccess] = useState<UserAccess>('editor');
  const [filter, setFilter] = useState<StatusFilter>('active');
  const [q, setQ] = useState('');
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState<Record<string, string>>({});

  const handle = useCallback(
    (e: unknown): void => {
      if (isSessionEnded(e)) session.endSession('expired');
      else setMessage({ kind: 'error', text: t(lang, errorKey(e)) });
    },
    [lang, session],
  );

  const loadUsers = useCallback(async (): Promise<void> => {
    if (api === null) return;
    try {
      setUsers(await api.listUsers());
    } catch (e) {
      handle(e);
    }
  }, [api, handle]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

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
      await loadUsers();
      onChanged?.();
    }
  };

  const roleText = (r: MemberRole): string => t(lang, r === 'sv' ? 'tenancy.role.sv' : 'tenancy.role.tester');

  // ---- add ------------------------------------------------------------------------

  const add = (): Promise<void> =>
    run(async () => {
      const displayName = name.normalize('NFKC').replace(/\s+/g, ' ').trim();
      if (displayName === '') {
        setMessage({ kind: 'error', text: t(lang, 'dir.nameRequired') });
        return null;
      }
      const typed = email.trim() === '' ? null : normalizeMemberEmail(email);
      if (email.trim() !== '' && typed === null) {
        setMessage({ kind: 'error', text: t(lang, 'tenancy.error.invalid_email') });
        return null;
      }
      if (web) {
        const created = await api.createMember({ displayName, ...(typed === null ? {} : { email: typed }), role, createAccount: withLogin, ...(role === 'tester' ? { access } : {}) });
        setName('');
        setEmail('');
        setWithLogin(false);
        return created.user === null ? t(lang, 'dir.addedProfile', { name: displayName }) : t(lang, 'dir.addedLogin', { name: displayName, email: created.user.email });
      }
      if (typed !== null && emailTaken(members, typed)) {
        setMessage({ kind: 'error', text: t(lang, 'tenancy.error.member_email_taken') });
        return null;
      }
      onUpsertMember({ id: nextMemberId(members), name: displayName, team: 'RCS', role: memberRoleWord(role), startDate: today, active: true, ...(typed === null ? {} : { email: typed }) });
      setName('');
      setEmail('');
      return t(lang, 'dir.addedProfile', { name: displayName });
    });

  // ---- actions on one profile -------------------------------------------------------

  const label = (m: RcsMember): string => optionLabel(lang, m);

  const changeRole = async (m: RcsMember, to: MemberRole): Promise<void> => {
    const linked = isLinked(m);
    const ok = await confirm({
      title: t(lang, 'dir.role.title', { name: label(m) }),
      body: (
        <>
          <p>{t(lang, to === 'sv' ? 'dir.role.bodySv' : 'dir.role.bodyTester', { name: label(m) })}</p>
          <p>{t(lang, linked ? 'dir.role.bodyLinked' : 'dir.role.bodyUnlinked')}</p>
        </>
      ),
      confirmLabel: t(lang, to === 'sv' ? 'dir.role.toSv' : 'dir.role.toTester'),
      cancelLabel: t(lang, 'tenancy.cancel'),
      severity: 'warning',
    });
    if (!ok) return;
    await run(async () => {
      if (web) {
        const done = await api.setMemberRole(m.id, to);
        return done.disconnected ? t(lang, 'dir.role.done', { name: label(m), role: roleText(to) }) : t(lang, 'dir.role.notClosed');
      }
      onUpsertMember({ ...m, role: memberRoleWord(to) });
      return t(lang, 'dir.role.done', { name: label(m), role: roleText(to) });
    });
  };

  const remove = async (m: RcsMember, user: UserDto | null): Promise<void> => {
    const ok = await confirm({
      title: t(lang, 'dir.remove.title', { name: label(m) }),
      body: <p>{user === null ? t(lang, 'dir.remove.bodyUnlinked') : t(lang, 'dir.remove.bodyLinked', { email: user.email })}</p>,
      confirmLabel: t(lang, 'dir.remove.confirm'),
      cancelLabel: t(lang, 'tenancy.cancel'),
      severity: 'warning',
    });
    if (!ok) return;
    await run(async () => {
      if (web) await api.removeMember(m.id);
      else onUpsertMember({ ...m, active: false, endDate: today < m.startDate ? m.startDate : today, removedAt: new Date().toISOString() });
      return t(lang, 'dir.remove.done', { name: label(m) });
    });
  };

  const reactivate = async (m: RcsMember, user: UserDto | null): Promise<void> => {
    const ok = await confirm({
      title: t(lang, 'dir.reactivate.title', { name: label(m) }),
      body: <p>{t(lang, 'dir.reactivate.body', { name: label(m) })}</p>,
      confirmLabel: t(lang, 'dir.reactivate.confirm'),
      cancelLabel: t(lang, 'tenancy.cancel'),
    });
    if (!ok) return;
    // A disabled login comes back only if the SV says so, separately.
    let also = false;
    if (web && user !== null && user.status === 'disabled') {
      also = await confirm({
        title: t(lang, 'dir.reactivate.loginTitle', { name: label(m) }),
        body: <p>{t(lang, 'dir.reactivate.loginBody', { email: user.email })}</p>,
        confirmLabel: t(lang, 'dir.reactivate.loginYes'),
        cancelLabel: t(lang, 'dir.reactivate.loginNo'),
      });
    }
    await run(async () => {
      if (web) {
        const done = await api.reactivateMember(m.id, also);
        return done.accountStillDisabled ? t(lang, 'dir.reactivate.loginKept', { name: label(m) }) : t(lang, 'dir.reactivate.done', { name: label(m) });
      }
      const { endDate: _end, removedAt: _removed, ...rest } = m;
      onUpsertMember({ ...rest, active: true });
      return t(lang, 'dir.reactivate.done', { name: label(m) });
    });
  };

  const createLogin = (m: RcsMember): Promise<void> =>
    run(async () => {
      if (api === null) return null;
      const done = await api.provisionAccount(m.id, intendedRoleOf(m) === 'tester' ? access : undefined);
      return t(lang, 'dir.login.created', { name: label(m), email: done.user.email }) + (done.assignments > 0 ? t(lang, 'dir.login.createdAssignments', { count: done.assignments }) : '');
    });

  const linkTo = (m: RcsMember, userId: string): Promise<void> =>
    run(async () => {
      if (api === null) return null;
      await api.linkMember(m.id, userId);
      setLinking((prev) => ({ ...prev, [m.id]: '' }));
      return t(lang, 'dir.login.linked', { name: label(m), email: (users ?? []).find((u) => u.id === userId)?.email ?? '' });
    });

  const changeAccess = (user: UserDto, next: UserAccess): Promise<void> => run(async () => (api === null ? null : (await api.updateUser(user.id, { access: next }), null)));

  const toggleLogin = async (user: UserDto): Promise<void> => {
    const disabling = user.status !== 'disabled';
    const who = user.displayName ?? user.email;
    const ok = await confirm({
      title: t(lang, disabling ? 'tenancy.users.disableTitle' : 'tenancy.users.enableTitle', { name: who }),
      body: <p>{t(lang, disabling ? 'tenancy.users.disableBody' : 'tenancy.users.enableBody', { email: user.email })}</p>,
      confirmLabel: t(lang, disabling ? 'tenancy.users.disable' : 'tenancy.users.enable'),
      cancelLabel: t(lang, 'tenancy.cancel'),
      severity: disabling ? 'warning' : 'normal',
    });
    if (!ok || api === null) return;
    await run(async () => {
      const result = await api.updateUser(user.id, { status: disabling ? 'disabled' : 'enabled' });
      if (disabling) return result.disconnected ? t(lang, 'tenancy.users.disabledDone', { email: user.email }) : t(lang, 'tenancy.users.notDisconnected');
      return t(lang, 'tenancy.users.enabledDone', { email: user.email });
    });
  };

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
    if (!ok || api === null) return;
    await run(async () => {
      await api.transferOwnership(user.id);
      window.location.reload(); // the signed-in person is not the Owner any more
      return t(lang, 'tenancy.owner.transferred', { email: user.email });
    });
  };

  const giveProfile = (user: UserDto): Promise<void> => run(async () => (api === null ? null : (await api.createProfile(user.id), t(lang, 'tenancy.members.profileCreated', { email: user.email }))));

  // ---- the table ------------------------------------------------------------------

  const projectName = (stable: string): string => {
    const p = projects.find((x) => x.projectId === stable);
    return p === undefined ? t(lang, 'people.former') : resolveBilingualName(lang, { nameEn: p.nameEn, nameJa: p.nameJa }) || t(lang, 'people.former');
  };
  const assignedTo = (m: RcsMember): string[] =>
    [
      ...new Set(
        assignments
          .filter((a) => a.active && (a.endDate === undefined || a.endDate === '' || a.endDate >= today) && (a.memberId === m.id || (isLinked(m) && a.userId === m.userId)))
          .map((a) => projectName(a.projectId)),
      ),
    ];

  const all = useMemo(() => [...members].sort((a, b) => a.name.localeCompare(b.name)), [members]);
  const rows = useMemo(() => directoryRows(all, web ? users : null), [all, users, web]);
  const needle = q.normalize('NFKC').trim().toLowerCase();
  const shown = rows.filter((r) => {
    const m = r.member;
    if (m !== null) {
      const state = memberState(m, today);
      if (filter === 'active' && state !== 'active') return false;
      if (filter === 'removed' && state !== 'removed') return false;
    } else if (filter === 'removed') return false;
    if (needle === '') return true;
    const hay = `${m?.name ?? ''} ${m?.email ?? ''} ${r.user?.displayName ?? ''} ${r.user?.email ?? ''}`.toLowerCase();
    return hay.includes(needle);
  });
  const orphans = rows.filter((r) => r.orphanAccount).map((r) => r.user as UserDto);
  const unlinkedProfiles = members.filter((m) => !isLinked(m) && memberState(m, today) === 'active');
  const iAmOwner = (users ?? []).some((u) => u.id === currentUserId && u.isOwner);
  const heirs = ownershipCandidates(users ?? []);

  const roleCell = (r: DirectoryRow): string => {
    if (r.user !== null) return `${t(lang, r.user.role === 'admin' ? 'tenancy.role.sv' : 'tenancy.role.tester')}${r.user.role === 'user' && r.user.access === 'viewer' ? ` (${t(lang, 'tenancy.access.viewer')})` : ''}`;
    const intended = r.member === null ? null : intendedRoleOf(r.member);
    return intended !== null ? roleText(intended) : `${t(lang, 'dir.otherRole')}${r.member?.role ? `: ${r.member.role}` : ''}`;
  };

  return (
    <section className="dr-section" aria-labelledby="dir-title">
      <h2 id="dir-title">{t(lang, 'team.members.title')}</h2>
      <p className="dr-summary">{t(lang, 'dir.help')}</p>
      {web ? <p className="dr-summary">{t(lang, 'tenancy.users.help')}</p> : <p className="link-help">{t(lang, 'dir.localNote')}</p>}
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
        <h3>{t(lang, 'dir.addTitle')}</h3>
        <label className="link-confirm">
          {t(lang, 'dir.name')}
          <input className="input" required value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </label>
        <label className="link-confirm">
          {t(lang, 'dir.email')}
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required={withLogin} />
        </label>
        <p className="link-help">{t(lang, 'dir.emailHint')}</p>
        <label className="link-confirm">
          {t(lang, 'dir.role')}
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as MemberRole)}>
            <option value="tester">{t(lang, 'tenancy.role.tester')}</option>
            <option value="sv">{t(lang, 'tenancy.role.sv')}</option>
          </select>
        </label>
        <p className="link-help">{t(lang, role === 'sv' ? 'tenancy.users.roleHelpSv' : 'tenancy.users.roleHelpTester')}</p>
        {web ? (
          <fieldset className="plain-fieldset">
            <legend>{t(lang, 'dir.loginLabel')}</legend>
            <label>
              <input type="radio" name="dir-login" checked={!withLogin} onChange={() => setWithLogin(false)} /> {t(lang, 'dir.loginNone')}
            </label>
            <label>
              <input type="radio" name="dir-login" checked={withLogin} onChange={() => setWithLogin(true)} /> {t(lang, 'dir.loginCreate')}
            </label>
            {withLogin && role === 'tester' ? (
              <label className="link-confirm">
                {t(lang, 'tenancy.users.colAccess')}
                <select className="input" value={access} onChange={(e) => setAccess(e.target.value as UserAccess)}>
                  <option value="editor">{t(lang, 'tenancy.access.editor')}</option>
                  <option value="viewer">{t(lang, 'tenancy.access.viewer')}</option>
                </select>
              </label>
            ) : null}
            <p className="link-help">{t(lang, 'tenancy.users.domainHint')}</p>
          </fieldset>
        ) : null}
        <button type="submit" className="btn btn-primary" disabled={busy || name.trim() === '' || (withLogin && email.trim() === '')}>
          {t(lang, 'dir.add')}
        </button>
      </form>

      <div className="tenancy-controls" role="search">
        <label>
          {t(lang, 'tenancy.list.search')}
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t(lang, 'tenancy.users.searchPlaceholder')} />
        </label>
        <label>
          {t(lang, 'dir.filter.status')}
          <select className="input" value={filter} onChange={(e) => setFilter(e.target.value as StatusFilter)}>
            <option value="active">{t(lang, 'dir.filter.active')}</option>
            <option value="all">{t(lang, 'dir.filter.all')}</option>
            <option value="removed">{t(lang, 'dir.filter.removed')}</option>
          </select>
        </label>
      </div>
      <p className="link-help" role="status">
        {t(lang, 'dir.showing', { shown: shown.length, total: rows.length })}
      </p>
      <p className="link-help">{t(lang, 'dir.unlinkedExplain')}</p>

      {rows.length === 0 ? (
        <p className="tenancy-empty" role="note">
          {t(lang, 'dir.empty')}
        </p>
      ) : (
        <div className="tenancy-table-wrap">
          <table className="tenancy-table">
            <caption className="sr-only">{t(lang, 'team.members.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t(lang, 'dir.colName')}</th>
                <th scope="col">{t(lang, 'dir.colEmail')}</th>
                <th scope="col">{t(lang, 'dir.colRole')}</th>
                <th scope="col">{t(lang, 'dir.colOwner')}</th>
                <th scope="col">{t(lang, 'dir.colMember')}</th>
                <th scope="col">{t(lang, 'dir.colAccount')}</th>
                {web ? <th scope="col">{t(lang, 'dir.colAccountStatus')}</th> : null}
                <th scope="col">{t(lang, 'dir.colAssigned')}</th>
                <th scope="col">
                  <span className="sr-only">{t(lang, 'dir.colActions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const m = r.member;
                const user = r.user;
                const removed = m !== null && memberState(m, today) === 'removed';
                const self = user !== null && user.id === currentUserId;
                const owner = user?.isOwner === true;
                const intended = m === null ? null : intendedRoleOf(m);
                const currentRole: MemberRole | null = user !== null ? (user.role === 'admin' ? 'sv' : 'tester') : intended;
                const people = m === null ? [] : assignedTo(m);
                return (
                  <tr key={r.key} className={removed ? 'tm-archived' : undefined}>
                    <th scope="row" className="tenancy-user-cell">
                      <strong>{m !== null ? label(m) : (user?.displayName ?? user?.email ?? '')}</strong>
                    </th>
                    <td>{m?.email ?? user?.email ?? <span className="link-help">{t(lang, 'dir.noEmail')}</span>}</td>
                    <td>{roleCell(r)}</td>
                    <td>
                      {owner ? (
                        <span className="status-badge status-owner">
                          <span aria-hidden="true">★ </span>
                          {t(lang, 'dir.owner')}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {m === null ? (
                        '—'
                      ) : (
                        <span className={`status-badge status-${removed ? 'disabled' : 'active'}`}>
                          <span aria-hidden="true">{removed ? '⏸ ' : '● '}</span>
                          {t(lang, removed ? 'dir.status.removed' : 'dir.status.active')}
                        </span>
                      )}
                    </td>
                    <td>{r.orphanAccount ? t(lang, 'dir.account.none') : t(lang, m !== null && isLinked(m) ? 'dir.account.linked' : 'dir.account.notLinked')}</td>
                    {web ? <td>{user === null ? '—' : <StatusBadge lang={lang} status={user.status} />}</td> : null}
                    <td>{people.length === 0 ? <span className="link-help">{t(lang, 'dir.assignedNone')}</span> : compactNames(people, 2)}</td>
                    <td className="dr-row-actions">
                      {m === null ? (
                        user === null ? null : (
                          <div className="tenancy-profile-actions">
                            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void giveProfile(user)}>
                              {t(lang, 'dir.actions.giveProfile')}
                            </button>
                            {unlinkedProfiles.some((p) => p.email === undefined || p.email === user.email) ? (
                              <span className="tenancy-link-row">
                                <select
                                  className="input"
                                  value={linking[user.id] ?? ''}
                                  aria-label={`${t(lang, 'dir.actions.linkPick')}: ${user.email}`}
                                  onChange={(e) => setLinking((prev) => ({ ...prev, [user.id]: e.target.value }))}
                                >
                                  <option value="">{t(lang, 'dir.actions.linkPick')}</option>
                                  {unlinkedProfiles.filter((p) => p.email === undefined || p.email === user.email).map((p) => (
                                    <option key={p.id} value={p.id}>
                                      {label(p)}
                                    </option>
                                  ))}
                                </select>
                                <button type="button" className="btn" disabled={busy || (linking[user.id] ?? '') === ''} onClick={() => void linkTo(unlinkedProfiles.find((p) => p.id === linking[user.id]) as RcsMember, user.id)}>
                                  {t(lang, 'tenancy.members.link')}
                                </button>
                              </span>
                            ) : null}
                          </div>
                        )
                      ) : (
                        <>
                          {onEditDetails === undefined ? null : (
                            <button type="button" className="btn" disabled={busy} onClick={() => onEditDetails(m.id)}>
                              {t(lang, 'dir.actions.edit')}
                            </button>
                          )}
                          {removed ? (
                            <button type="button" className="btn" disabled={busy} onClick={() => void reactivate(m, user)}>
                              {t(lang, 'dir.actions.reactivate')}
                            </button>
                          ) : (
                            <details className="dir-more">
                              <summary>{t(lang, 'dir.actions.more')}</summary>
                              <div className="dir-more-list">
                                {owner || self ? (
                                  <span className="link-help">{t(lang, owner ? 'dir.ownerProtected' : 'dir.itsYou')}</span>
                                ) : (
                                  <>
                                    {currentRole === null ? null : (
                                      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void changeRole(m, currentRole === 'sv' ? 'tester' : 'sv')}>
                                        {t(lang, 'dir.actions.role')}: {t(lang, currentRole === 'sv' ? 'dir.role.toTester' : 'dir.role.toSv')}
                                      </button>
                                    )}
                                    {currentRole === null ? (
                                      <>
                                        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void changeRole(m, 'tester')}>
                                          {t(lang, 'dir.role.toTester')}
                                        </button>
                                        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void changeRole(m, 'sv')}>
                                          {t(lang, 'dir.role.toSv')}
                                        </button>
                                      </>
                                    ) : null}
                                    <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void remove(m, user)}>
                                      {t(lang, 'dir.actions.remove')}
                                    </button>
                                  </>
                                )}
                                {web && !isLinked(m) ? (
                                  <>
                                    <button type="button" className="btn btn-ghost" disabled={busy || m.email === undefined || currentRole === null} onClick={() => void createLogin(m)} title={m.email === undefined ? t(lang, 'dir.login.needsEmail') : undefined}>
                                      {t(lang, 'dir.actions.createLogin')}
                                    </button>
                                    {orphans.length > 0 ? (
                                      <span className="tenancy-link-row">
                                        <select className="input" value={linking[m.id] ?? ''} aria-label={`${t(lang, 'dir.actions.linkTo')}: ${label(m)}`} onChange={(e) => setLinking((prev) => ({ ...prev, [m.id]: e.target.value }))}>
                                          <option value="">{t(lang, 'dir.actions.linkTo')}</option>
                                          {orphans.map((u) => (
                                            <option key={u.id} value={u.id}>
                                              {u.displayName ?? u.email}
                                            </option>
                                          ))}
                                        </select>
                                        <button type="button" className="btn" disabled={busy || (linking[m.id] ?? '') === ''} onClick={() => void linkTo(m, linking[m.id])}>
                                          {t(lang, 'tenancy.members.link')}
                                        </button>
                                      </span>
                                    ) : null}
                                  </>
                                ) : null}
                                {web && user !== null && user.role === 'user' ? (
                                  <label className="link-confirm">
                                    {t(lang, 'tenancy.users.colAccess')}
                                    <select className="input" value={user.access} disabled={busy} aria-label={`${t(lang, 'tenancy.users.colAccess')}: ${label(m)}`} onChange={(e) => void changeAccess(user, e.target.value as UserAccess)}>
                                      <option value="editor">{t(lang, 'tenancy.access.editor')}</option>
                                      <option value="viewer">{t(lang, 'tenancy.access.viewer')}</option>
                                    </select>
                                  </label>
                                ) : null}
                                {web && user !== null && !owner && !self ? (
                                  <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void toggleLogin(user)}>
                                    {t(lang, user.status === 'disabled' ? 'tenancy.users.enable' : 'tenancy.users.disable')}
                                  </button>
                                ) : null}
                                {iAmOwner && user !== null && heirs.some((h) => h.id === user.id) ? (
                                  <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void transfer(user)}>
                                    {t(lang, 'tenancy.owner.transfer')}
                                  </button>
                                ) : null}
                              </div>
                            </details>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
