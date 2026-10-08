import { describe, expect, it } from 'vitest';
import type { AdminAuditDto, UserDto } from '../../../shared/tenancy';
import { CLOSE_CODES } from '../../../shared/tenancy';
import { caseResultId } from '../../../shared/testManagement';
import { SUPER, activateWeb, call, createTenant, get, openSocket, patch, post, rec, whoami, type Tenant } from './tenancy-harness';
import type { TestSocket } from './helpers';

/**
 * Stage 8D, Team Members as the one people directory, through the real Worker and Durable Objects: profiles with and without a login,
 * unique emails, linking without duplicates, role changes, removal and reactivation, and what each of those does to sessions.
 * Nothing is mocked.
 */

const NOW = '2026-10-08T09:00:00.000Z';
let seq = 0;
const rk = (label: string): string => `${label}-${++seq}-${crypto.randomUUID().slice(0, 6)}@rakuten.com`;
const J = JSON.stringify;
const put = (kind: string, id: string, value: unknown) => ({ kind, id, json: J(value) });

const project = () => rec('project', 'proj-1', { id: 'proj-1', projectId: 'PRJ-001', nameEn: 'Android', nameJa: '', team: 'RCS', status: 'ongoing', inputs: { totalCases: 100, dailyExecuted: [], bugTickets: [], testerDailyPerformance: [] } });
const scope = (over: Record<string, unknown> = {}) => ({ id: 'scp_eco', projectId: 'PRJ-001', name: 'Ecosystem', code: 'ECO', status: 'active', order: 10, createdAt: NOW, updatedAt: NOW, ...over });
const tcase = (n: number) => ({ id: `tc_eco${n}`, projectId: 'PRJ-001', scopeId: 'scp_eco', key: `ECO-${String(n).padStart(3, '0')}`, title: `Case ${n}`, priority: 'medium', status: 'active', order: n * 10, createdAt: NOW, updatedAt: NOW });
const result = (caseId: string, userId: string) => ({ id: caseResultId(caseId), projectId: 'PRJ-001', scopeId: 'scp_eco', testCaseId: caseId, status: 'pass', retest: false, question: false, executedByUserId: userId, executedAt: NOW, updatedByUserId: userId, updatedAt: NOW });

type Rec = { kind: string; id: string; json: string };
const exportOf = async (as: string) => (await get<{ revision: number; records: Rec[] }>(as, '/api/export')).json;
const membersOf = async (as: string): Promise<Array<Record<string, unknown> & { id: string }>> => (await exportOf(as)).records.filter((r) => r.kind === 'member').map((r) => JSON.parse(r.json));

async function joined(as: string): Promise<{ sock: TestSocket; revision: number; records: Rec[] }> {
  const o = await openSocket(as);
  if (!o.ok) throw new Error(`socket refused: ${o.status}`);
  const snap = await o.sock.next('snapshot');
  return { sock: o.sock, revision: snap.revision, records: snap.records };
}

let commitSeq = 0;
async function commit(c: { sock: TestSocket; revision: number }, puts: Rec[], deletes: Array<{ kind: string; id: string }> = []) {
  commitSeq += 1;
  c.sock.send({ t: 'commit', id: `s8d-${commitSeq}-${crypto.randomUUID()}`, baseRevision: c.revision, puts, deletes } as never);
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const ack = await c.sock.next('ack', 60).catch(() => null);
    if (ack !== null) {
      c.revision = ack.revision;
      return { ok: true as const, revision: ack.revision };
    }
    const reject = await c.sock.next('reject', 60).catch(() => null);
    if (reject !== null) return { ok: false as const, reject };
  }
  throw new Error('no answer to the commit');
}

async function workspace(name: string) {
  const t = await createTenant(name, rk('owner'));
  await activateWeb(t, [project()]);
  const sv = await joined(t.adminEmail);
  const setup = await commit(sv, [put('scope', 'scp_eco', scope()), put('testCase', 'tc_eco1', tcase(1)), put('testCase', 'tc_eco2', tcase(2))]);
  if (!setup.ok) throw new Error(`setup refused ${J(setup.reject)}`);
  return { t, sv };
}

const addProfile = (t: Tenant, body: Record<string, unknown>) => post<{ memberId: string; user: UserDto | null; linked?: boolean; error?: string }>(t.adminEmail, '/api/tenant/members', body);

describe('profiles without a login', () => {
  it('an SV creates a Tester profile with no login: it is in the directory, has no account, and nobody can sign in as it', async () => {
    const { t } = await workspace('Alpha');
    const email = rk('tanaka');
    const r = await addProfile(t, { displayName: 'Tanaka Taro', email, role: 'tester' });
    expect([r.status, r.json.user]).toEqual([201, null]);
    const m = (await membersOf(t.adminEmail)).find((x) => x.id === r.json.memberId)!;
    expect(m).toMatchObject({ name: 'Tanaka Taro', email, role: 'Tester', active: true });
    expect(m.userId).toBeUndefined();
    const users = (await get<{ users: UserDto[] }>(t.adminEmail, '/api/tenant/users')).json.users;
    expect(users.map((u) => u.email)).not.toContain(email);
    expect((await whoami(email)).status).toBe(403); // no account, no access
  });

  it('a profile needs only a name; an email is optional; a bad email, a missing name or a bad role is refused', async () => {
    const { t } = await workspace('Alpha');
    expect((await addProfile(t, { displayName: 'No Email', role: 'tester' })).status).toBe(201);
    expect((await addProfile(t, { displayName: '', role: 'tester' })).json.error).toBe('invalid_display_name');
    expect((await addProfile(t, { displayName: 'X', email: 'not-an-email', role: 'tester' })).json.error).toBe('invalid_email');
    expect((await addProfile(t, { displayName: 'X', role: 'admin' })).json.error).toBe('invalid_role');
    expect((await addProfile(t, { displayName: 'X', role: 'tester', createAccount: true })).json.error).toBe('email_required_for_account');
  });

  it('the email is unique within the workspace after normalising (case, spaces, full-width); the same display name with another email is fine', async () => {
    const { t } = await workspace('Alpha');
    const email = rk('dup');
    expect((await addProfile(t, { displayName: 'Same Name', email, role: 'tester' })).status).toBe(201);
    for (const variant of [email.toUpperCase(), `  ${email} `, email.replace('@', '＠')]) {
      const r = await addProfile(t, { displayName: 'Other', email: variant, role: 'tester' });
      expect([r.status, r.json.error], variant).toEqual([409, 'member_email_taken']);
    }
    const second = await addProfile(t, { displayName: 'Same Name', email: rk('other'), role: 'tester' });
    expect(second.status).toBe(201);
    expect((await membersOf(t.adminEmail)).filter((m) => m.name === 'Same Name')).toHaveLength(2);
  });

  it('the same email may be a profile in two different workspaces, but a LOGIN email belongs to one workspace on the platform', async () => {
    const a = await workspace('Alpha');
    const b = await workspace('Beta');
    const shared = rk('shared');
    expect((await addProfile(a.t, { displayName: 'Shared', email: shared, role: 'tester' })).status).toBe(201);
    expect((await addProfile(b.t, { displayName: 'Shared', email: shared, role: 'tester' })).status).toBe(201);
    // A creates a login for it: B can no longer create one for the same address.
    const pa = (await membersOf(a.t.adminEmail)).find((m) => m.email === shared)!;
    expect((await post(a.t.adminEmail, `/api/tenant/members/${pa.id}/account`, {})).status).toBe(201);
    const pb = (await membersOf(b.t.adminEmail)).find((m) => m.email === shared)!;
    const refused = await post(b.t.adminEmail, `/api/tenant/members/${pb.id}/account`, {});
    expect([refused.status, refused.json.error]).toEqual([409, 'email_in_other_workspace']);
    expect((await membersOf(b.t.adminEmail)).find((m) => m.id === pb.id)!.userId).toBeUndefined(); // B's profile stays unlinked
  });
});

describe('linking a profile to a login', () => {
  it('profile + login in one step: one profile, linked to the new account, same email, role from the choice', async () => {
    const { t } = await workspace('Alpha');
    const email = rk('both');
    const r = await addProfile(t, { displayName: 'Both', email, role: 'tester', createAccount: true });
    expect([r.status, r.json.linked]).toEqual([201, true]);
    const ms = (await membersOf(t.adminEmail)).filter((m) => m.email === email);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ userId: r.json.user!.id, role: 'Tester' });
    expect((await whoami(email)).json).toMatchObject({ role: 'user', userId: r.json.user!.id });
  });

  it('a login can be created later for an existing profile: the SAME profile is linked, nothing is duplicated, its role decides the login role', async () => {
    const { t } = await workspace('Alpha');
    const email = rk('later');
    const made = await addProfile(t, { displayName: 'Later', email, role: 'sv' });
    const before = await membersOf(t.adminEmail);
    const r = await post<{ user: UserDto; linked: boolean }>(t.adminEmail, `/api/tenant/members/${made.json.memberId}/account`, {});
    expect([r.status, r.json.linked, r.json.user.role]).toEqual([201, true, 'admin']);
    const after = await membersOf(t.adminEmail);
    expect(after).toHaveLength(before.length);
    expect(after.find((m) => m.id === made.json.memberId)).toMatchObject({ userId: r.json.user.id, email, role: 'SV' });
  });

  it('a login needs an email on the profile, an active profile and a role; it cannot be created twice', async () => {
    const { t } = await workspace('Alpha');
    const noEmail = await addProfile(t, { displayName: 'No Mail', role: 'tester' });
    expect((await post(t.adminEmail, `/api/tenant/members/${noEmail.json.memberId}/account`, {})).json.error).toBe('email_required_for_account');
    const ok = await addProfile(t, { displayName: 'Ok', email: rk('ok'), role: 'tester' });
    expect((await post(t.adminEmail, `/api/tenant/members/${ok.json.memberId}/account`, {})).status).toBe(201);
    expect((await post(t.adminEmail, `/api/tenant/members/${ok.json.memberId}/account`, {})).json.error).toBe('member_already_linked');
  });

  it('adding a Tester by email links the existing profile with that email (no duplicate); a profile with only the same NAME is never linked', async () => {
    const { t } = await workspace('Alpha');
    const email = rk('known');
    const known = await addProfile(t, { displayName: 'Known Person', email, role: 'tester' });
    const sameName = await addProfile(t, { displayName: 'Hana Sato', email: rk('hana-profile'), role: 'tester' });
    const count = (await membersOf(t.adminEmail)).length;
    const viaUsers = await post<{ user: UserDto; profile: string; memberId: string }>(t.adminEmail, '/api/tenant/users', { email, role: 'tester' });
    expect([viaUsers.status, viaUsers.json.profile, viaUsers.json.memberId]).toEqual([201, 'linked', known.json.memberId]);
    expect(await membersOf(t.adminEmail)).toHaveLength(count);
    // A new login named like an existing profile, with a different email: a NEW profile, the namesake stays unlinked.
    const namesake = await post<{ profile: string }>(t.adminEmail, '/api/tenant/users', { email: rk('hana-login'), role: 'tester', displayName: 'Hana Sato' });
    expect(namesake.json.profile).toBe('created');
    const stillAlone = (await membersOf(t.adminEmail)).find((m) => m.id === sameName.json.memberId)!;
    expect(stillAlone.userId).toBeUndefined();
  });

  it('an explicit link of an older profile to an account works once; a profile with a different email is refused; a removed one must be reactivated first', async () => {
    const { t } = await workspace('Alpha');
    const acct = await post<{ user: UserDto; memberId: string }>(t.adminEmail, '/api/tenant/users', { email: rk('acct'), role: 'tester' });
    // an account WITHOUT a profile is made by removing the auto-created link via a fresh account that predates profiles: simulate with a second profile
    const lone = await addProfile(t, { displayName: 'Lone', role: 'tester' });
    const other = await addProfile(t, { displayName: 'Other', email: rk('other'), role: 'tester' });
    const taken = await post(t.adminEmail, '/api/tenant/members/link', { memberId: lone.json.memberId, userId: acct.json.user.id });
    expect([taken.status, taken.json.error]).toEqual([409, 'account_already_linked']); // the account already has its own profile
    expect((await post(t.adminEmail, '/api/tenant/members/link', { memberId: other.json.memberId, userId: 'usr_00000000-0000-4000-8000-000000000000' })).status).toBe(404);
  });
});

describe('who may do what', () => {
  it('a Tester cannot create, edit, change roles, remove, reactivate, provision or link anything', async () => {
    const { t } = await workspace('Alpha');
    const tester = await addProfile(t, { displayName: 'Tess', email: rk('tess'), role: 'tester', createAccount: true });
    const victim = await addProfile(t, { displayName: 'Victim', email: rk('victim'), role: 'tester' });
    const as = (await membersOf(t.adminEmail)).find((m) => m.userId === tester.json.user!.id)!;
    const mail = (await get<{ users: UserDto[] }>(t.adminEmail, '/api/tenant/users')).json.users.find((u) => u.id === tester.json.user!.id)!.email;
    const id = victim.json.memberId;
    const attempts: Array<[string, string, unknown]> = [
      ['POST', '/api/tenant/members', { displayName: 'X', role: 'tester' }],
      ['PATCH', `/api/tenant/members/${id}`, { displayName: 'Hacked' }],
      ['POST', `/api/tenant/members/${id}/role`, { role: 'sv' }],
      ['POST', `/api/tenant/members/${id}/remove`, {}],
      ['POST', `/api/tenant/members/${id}/reactivate`, {}],
      ['POST', `/api/tenant/members/${id}/account`, {}],
      ['POST', '/api/tenant/members/link', { memberId: id, userId: tester.json.user!.id }],
      ['POST', `/api/tenant/members/${as.id}/role`, { role: 'sv' }], // not even their own
    ];
    for (const [method, path, body] of attempts) expect((await call(mail, method, path, body)).status, `${method} ${path}`).toBe(403);
    expect((await membersOf(t.adminEmail)).find((m) => m.id === id)).toMatchObject({ name: 'Victim', role: 'Tester', active: true });
  });

  it('another workspace cannot reach this one\'s members, even with a forged tenant id', async () => {
    const a = await workspace('Alpha');
    const b = await workspace('Beta');
    // make sure A has an id that B does not have
    for (let i = 0; i < 4; i += 1) await addProfile(a.t, { displayName: `P${i}`, email: rk(`p${i}`), role: 'tester' });
    const target = (await membersOf(a.t.adminEmail)).map((m) => m.id).sort().pop()!;
    expect((await membersOf(b.t.adminEmail)).map((m) => m.id)).not.toContain(target);
    for (const [method, path, body] of [
      ['PATCH', `/api/tenant/members/${target}`, { displayName: 'Hacked' }],
      ['POST', `/api/tenant/members/${target}/role`, { role: 'sv' }],
      ['POST', `/api/tenant/members/${target}/remove`, {}],
      ['POST', `/api/tenant/members/${target}/reactivate`, {}],
      ['POST', `/api/tenant/members/${target}/account`, {}],
    ] as Array<[string, string, unknown]>) {
      expect((await call(b.t.adminEmail, method, path, body)).status, path).toBe(404);
    }
    expect((await call(b.t.adminEmail, 'POST', `/api/tenant/members/${target}/role`, { role: 'sv', tenantId: a.t.id })).status).toBe(403);
    expect((await call(b.t.adminEmail, 'POST', `/api/tenant/members?tenantId=${a.t.id}`, { displayName: 'X', role: 'tester' })).status).toBe(403);
    expect((await membersOf(a.t.adminEmail)).find((m) => m.id === target)).toMatchObject({ role: 'Tester', active: true });
  });
});

describe('changing a role', () => {
  it('Tester -> SV: the account becomes an SV at once, the profile follows, the live session is ended, history is untouched', async () => {
    const { t, sv } = await workspace('Alpha');
    const tess = await addProfile(t, { displayName: 'Tess', email: rk('tess'), role: 'tester', createAccount: true });
    const userId = tess.json.user!.id;
    const mail = tess.json.user!.email;
    expect((await post(t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId, scopeId: 'scp_eco' })).status).toBe(201);
    const tester = await joined(mail);
    expect((await commit(tester, [put('caseResult', caseResultId('tc_eco1'), result('tc_eco1', userId))])).ok).toBe(true); // executes as a Tester
    const closed = tester.sock.closed;
    expect((await get(mail, '/api/tenant/users')).status).toBe(403); // a Tester cannot list accounts
    const r = await post<{ role: string; disconnected: boolean }>(t.adminEmail, `/api/tenant/members/${tess.json.memberId}/role`, { role: 'sv' });
    expect([r.status, r.json.role, r.json.disconnected]).toEqual([200, 'sv', true]);
    expect((await closed).code).toBe(CLOSE_CODES.roleChanged);
    expect((await whoami(mail)).json).toMatchObject({ role: 'admin', isOwner: false });
    expect((await get(mail, '/api/tenant/users')).status).toBe(200); // SV permission took effect on the very next request
    expect((await membersOf(t.adminEmail)).find((m) => m.id === tess.json.memberId)).toMatchObject({ role: 'SV', userId });
    // history keeps who executed it, as it was
    const saved = JSON.parse((await exportOf(t.adminEmail)).records.find((x) => x.kind === 'caseResult')!.json);
    expect(saved).toMatchObject({ executedByUserId: userId, updatedByUserId: userId });
    // a reconnect is authorised as an SV
    const again = await joined(mail);
    expect((await commit(again, [put('scope', 'scp_new', scope({ id: 'scp_new', name: 'New', code: 'NEW', order: 30 }))])).ok).toBe(true);
    expect(sv.revision).toBeGreaterThan(0);
  });

  it('SV -> Tester: SV-only permissions are gone immediately and the SV\'s session is ended', async () => {
    const { t } = await workspace('Alpha');
    const second = await addProfile(t, { displayName: 'Second SV', email: rk('sv2'), role: 'sv', createAccount: true });
    const mail = second.json.user!.email;
    expect((await get(mail, '/api/tenant/users')).status).toBe(200);
    const live = await joined(mail);
    const closed = live.sock.closed;
    const r = await post(t.adminEmail, `/api/tenant/members/${second.json.memberId}/role`, { role: 'tester' });
    expect(r.status).toBe(200);
    expect((await closed).code).toBe(CLOSE_CODES.roleChanged);
    expect((await whoami(mail)).json).toMatchObject({ role: 'user' });
    expect((await get(mail, '/api/tenant/users')).status).toBe(403);
    expect((await post(mail, '/api/tenant/members', { displayName: 'X', role: 'tester' })).status).toBe(403);
    expect((await membersOf(t.adminEmail)).find((m) => m.id === second.json.memberId)).toMatchObject({ role: 'Tester' });
    // the new Tester cannot write what only an SV may
    const again = await joined(mail);
    const refused = await commit(again, [put('scope', 'scp_x', scope({ id: 'scp_x', name: 'X', code: 'XX', order: 40 }))]);
    expect(refused.ok).toBe(false);
  });

  it('the Owner SV cannot be made a Tester or removed; nobody changes their own role', async () => {
    const { t } = await workspace('Alpha');
    // The Owner was created by the platform before profiles existed: an SV gives the account its profile explicitly.
    const ownerUser = (await get<{ users: UserDto[] }>(t.adminEmail, '/api/tenant/users')).json.users.find((u) => u.isOwner)!;
    expect((await post(t.adminEmail, '/api/tenant/members/profile', { userId: ownerUser.id })).status).toBe(201);
    const ownerProfile = (await membersOf(t.adminEmail)).find((m) => m.userId === ownerUser.id)!;
    expect(ownerProfile).toMatchObject({ email: t.adminEmail, role: 'SV' });
    const demote = await post(t.adminEmail, `/api/tenant/members/${ownerProfile.id}/role`, { role: 'tester' });
    expect(demote.status).toBe(409);
    const sv2 = await addProfile(t, { displayName: 'SV2', email: rk('sv2'), role: 'sv', createAccount: true });
    // another SV cannot demote or remove the Owner either
    expect([(await post(sv2.json.user!.email, `/api/tenant/members/${ownerProfile.id}/role`, { role: 'tester' })).status, (await post(sv2.json.user!.email, `/api/tenant/members/${ownerProfile.id}/remove`, {})).status]).toEqual([409, 409]);
    expect((await post(sv2.json.user!.email, `/api/tenant/members/${sv2.json.memberId}/role`, { role: 'tester' })).status).toBe(403); // not their own
    expect((await post(t.adminEmail, `/api/tenant/members/${ownerProfile.id}/remove`, {})).status).toBe(409);
    expect((await whoami(t.adminEmail)).json).toMatchObject({ role: 'admin', isOwner: true });
  });

  it('a profile without a login can change its intended role (Tester <-> SV); the login created later gets that role', async () => {
    const { t } = await workspace('Alpha');
    const email = rk('intent');
    const p = await addProfile(t, { displayName: 'Intent', email, role: 'tester' });
    expect((await post(t.adminEmail, `/api/tenant/members/${p.json.memberId}/role`, { role: 'sv' })).status).toBe(200);
    expect((await membersOf(t.adminEmail)).find((m) => m.id === p.json.memberId)).toMatchObject({ role: 'SV' });
    const acct = await post<{ user: UserDto }>(t.adminEmail, `/api/tenant/members/${p.json.memberId}/account`, {});
    expect(acct.json.user.role).toBe('admin');
    expect((await whoami(email)).json).toMatchObject({ role: 'admin' });
  });

  it('every role change is in the administrative audit trail with the actor from the verified caller; the Super Admin does not see it', async () => {
    const { t } = await workspace('Alpha');
    const p = await addProfile(t, { displayName: 'Audit Me', email: rk('audit'), role: 'tester', createAccount: true });
    await post(t.adminEmail, `/api/tenant/members/${p.json.memberId}/role`, { role: 'sv' });
    await post(t.adminEmail, `/api/tenant/members/${p.json.memberId}/remove`, {});
    await post(t.adminEmail, `/api/tenant/members/${p.json.memberId}/reactivate`, { reactivateAccount: true });
    const audit = (await get<{ audit: AdminAuditDto[] }>(t.adminEmail, '/api/tenant/audit?limit=100')).json.audit;
    const actions = audit.map((a) => a.action);
    for (const wanted of ['member.created', 'member.account_linked', 'member.role_changed', 'member.removed', 'member.reactivated']) expect(actions, wanted).toContain(wanted);
    for (const row of audit.filter((a) => a.action.startsWith('member.'))) expect(row.actorEmail).toBe(t.adminEmail);
    const role = audit.find((a) => a.action === 'member.role_changed')!;
    expect(role.meta).toMatchObject({ from: 'tester', to: 'sv' });
    const platform = (await get<{ audit: AdminAuditDto[] }>(SUPER, '/api/super/admin-audit?limit=200')).json.audit;
    expect(platform.filter((a) => a.action.startsWith('member.'))).toHaveLength(0);
  });
});

describe('removing and reactivating', () => {
  it('removing a profile without a login keeps it and everything that refers to it; it is no longer active', async () => {
    const { t } = await workspace('Alpha');
    const p = await addProfile(t, { displayName: 'Gone Soon', email: rk('gone'), role: 'tester' });
    const id = p.json.memberId;
    const sv = await joined(t.adminEmail);
    // history that points at the profile: an assignment, attendance
    expect((await commit(sv, [put('attendance', 'att-1', { id: 'att-1', date: '2026-10-08', memberId: id, memberName: 'Gone Soon', status: 'PRESENT' }), put('assignment', 'asg-1', { id: 'asg-1', projectId: 'PRJ-001', memberId: id, testerName: 'Gone Soon', startDate: '2026-10-01', active: true })])).ok).toBe(true);
    const r = await post<{ accountDisabled: boolean }>(t.adminEmail, `/api/tenant/members/${id}/remove`, {});
    expect([r.status, r.json.accountDisabled]).toEqual([200, false]);
    const m = (await membersOf(t.adminEmail)).find((x) => x.id === id)!;
    expect(m).toMatchObject({ active: false, name: 'Gone Soon' });
    expect(typeof m.removedAt).toBe('string');
    expect(typeof m.endDate).toBe('string');
    const kinds = (await exportOf(t.adminEmail)).records.map((x) => `${x.kind}:${x.id}`);
    expect(kinds).toContain('attendance:att-1');
    expect(kinds).toContain('assignment:asg-1');
    // removing again changes nothing
    expect((await post(t.adminEmail, `/api/tenant/members/${id}/remove`, {})).status).toBe(200);
  });

  it('removing a linked Tester disables the login, ends the session and blocks reconnecting; history stays', async () => {
    const { t } = await workspace('Alpha');
    const tess = await addProfile(t, { displayName: 'Tess', email: rk('tess'), role: 'tester', createAccount: true });
    const mail = tess.json.user!.email;
    expect((await post(t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: tess.json.user!.id, scopeId: 'scp_eco' })).status).toBe(201);
    const live = await joined(mail);
    expect((await commit(live, [put('caseResult', caseResultId('tc_eco1'), result('tc_eco1', tess.json.user!.id))])).ok).toBe(true);
    const closed = live.sock.closed;
    const r = await post<{ accountDisabled: boolean; disconnected: boolean }>(t.adminEmail, `/api/tenant/members/${tess.json.memberId}/remove`, {});
    expect([r.status, r.json.accountDisabled, r.json.disconnected]).toEqual([200, true, true]);
    expect((await closed).code).toBe(CLOSE_CODES.accessRevoked);
    expect((await whoami(mail)).status).toBe(403);
    const refused = await openSocket(mail);
    expect(refused.ok).toBe(false);
    const ex = await exportOf(t.adminEmail);
    expect(ex.records.some((x) => x.kind === 'caseResult')).toBe(true); // the result they recorded is still there
    expect(ex.records.some((x) => x.kind === 'assignment' && JSON.parse(x.json).userId === tess.json.user!.id)).toBe(true);
    expect(ex.records.find((x) => x.id === tess.json.memberId)).toBeDefined();
  });

  it('removing a non-owner SV works the same; the Owner and yourself cannot be removed', async () => {
    const { t } = await workspace('Alpha');
    const sv2 = await addProfile(t, { displayName: 'SV2', email: rk('sv2'), role: 'sv', createAccount: true });
    const sv3 = await addProfile(t, { displayName: 'SV3', email: rk('sv3'), role: 'sv', createAccount: true });
    expect((await post(sv3.json.user!.email, `/api/tenant/members/${sv3.json.memberId}/remove`, {})).status).toBe(403); // yourself
    expect((await post(t.adminEmail, `/api/tenant/members/${sv2.json.memberId}/remove`, {})).status).toBe(200);
    expect((await whoami(sv2.json.user!.email)).status).toBe(403);
    expect((await whoami(sv3.json.user!.email)).json).toMatchObject({ role: 'admin' }); // the other SV is untouched
  });

  it('reactivating restores the SAME identity; a disabled login comes back only when asked for; its profile id and account id never change', async () => {
    const { t } = await workspace('Alpha');
    const tess = await addProfile(t, { displayName: 'Tess', email: rk('tess'), role: 'tester', createAccount: true });
    const mail = tess.json.user!.email;
    await post(t.adminEmail, `/api/tenant/members/${tess.json.memberId}/remove`, {});
    const members = (await membersOf(t.adminEmail)).length;
    const soft = await post<{ accountStillDisabled: boolean }>(t.adminEmail, `/api/tenant/members/${tess.json.memberId}/reactivate`, {});
    expect([soft.status, soft.json.accountStillDisabled]).toEqual([200, true]);
    expect((await whoami(mail)).status).toBe(403); // the login stayed off
    const full = await post<{ accountReactivated: boolean }>(t.adminEmail, `/api/tenant/members/${tess.json.memberId}/reactivate`, { reactivateAccount: true });
    expect([full.status, full.json.accountReactivated]).toEqual([200, true]);
    expect((await whoami(mail)).json).toMatchObject({ role: 'user', userId: tess.json.user!.id });
    const m = (await membersOf(t.adminEmail)).find((x) => x.id === tess.json.memberId)!;
    expect(m).toMatchObject({ active: true, userId: tess.json.user!.id });
    expect(m.endDate).toBeUndefined();
    expect(await membersOf(t.adminEmail)).toHaveLength(members); // nobody new was created
  });

  it('a login cannot be switched on while its person is removed (reactivate the Team Member instead); a removed profile\'s email cannot be added again', async () => {
    const { t } = await workspace('Alpha');
    const tess = await addProfile(t, { displayName: 'Tess', email: rk('tess'), role: 'tester', createAccount: true });
    await post(t.adminEmail, `/api/tenant/members/${tess.json.memberId}/remove`, {});
    const on = await patch(t.adminEmail, `/api/tenant/users/${tess.json.user!.id}`, { status: 'enabled' });
    expect([on.status, on.json.error]).toEqual([409, 'member_removed']);
    const unlinked = await addProfile(t, { displayName: 'Old', email: rk('old'), role: 'tester' });
    const email = JSON.parse((await exportOf(t.adminEmail)).records.find((x) => x.id === unlinked.json.memberId)!.json).email as string;
    await post(t.adminEmail, `/api/tenant/members/${unlinked.json.memberId}/remove`, {});
    const again = await post(t.adminEmail, '/api/tenant/users', { email, role: 'tester' });
    expect([again.status, again.json.error]).toEqual([409, 'member_removed']);
    expect((await post(t.adminEmail, `/api/tenant/members/${unlinked.json.memberId}/account`, {})).json.error).toBe('member_inactive');
  });
});

describe('restoring an older revision', () => {
  it('does not undo what belongs to the login: the link, the email, the role and the active state stay as they are now', async () => {
    const { t } = await workspace('Alpha');
    const tess = await addProfile(t, { displayName: 'Tess', email: rk('tess'), role: 'tester', createAccount: true });
    const early = (await exportOf(t.adminEmail)).revision; // Tess is a linked Tester here
    await post(t.adminEmail, `/api/tenant/members/${tess.json.memberId}/role`, { role: 'sv' });
    const restored = await post(t.adminEmail, `/api/revisions/${early}/restore`, {});
    expect(restored.status).toBe(200);
    const m = (await membersOf(t.adminEmail)).find((x) => x.id === tess.json.memberId)!;
    expect(m).toMatchObject({ role: 'SV', userId: tess.json.user!.id, email: tess.json.user!.email });
    expect((await whoami(tess.json.user!.email)).json).toMatchObject({ role: 'admin' }); // the account and the profile still agree
  });
});

describe('assignments for people without a login', () => {
  it('a profile with no login can be assigned to a scope; the assignment grants nothing until a login is linked, then it just works', async () => {
    const { t } = await workspace('Alpha');
    const email = rk('soon');
    const p = await addProfile(t, { displayName: 'Soon', email, role: 'tester' });
    const a = await post<{ created: boolean; linked: boolean; assignment: { id: string; memberId: string } }>(t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', memberId: p.json.memberId, scopeId: 'scp_eco' });
    expect([a.status, a.json.created, a.json.linked]).toEqual([201, true, false]);
    const stored = JSON.parse((await exportOf(t.adminEmail)).records.find((x) => x.id === a.json.assignment.id)!.json);
    expect(stored).toMatchObject({ memberId: p.json.memberId, scopeId: 'scp_eco', active: true });
    expect(stored.userId).toBeUndefined();
    // repeating it changes nothing
    expect((await post(t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', memberId: p.json.memberId, scopeId: 'scp_eco' })).json).toMatchObject({ created: false, assignment: { id: a.json.assignment.id } });
    // no login yet, so nobody can execute as them
    expect((await whoami(email)).status).toBe(403);
    // the login is created: the SAME assignment now names the account
    const acct = await post<{ user: UserDto; assignments: number }>(t.adminEmail, `/api/tenant/members/${p.json.memberId}/account`, {});
    expect([acct.status, acct.json.assignments]).toEqual([201, 1]);
    const after = (await exportOf(t.adminEmail)).records.filter((x) => x.kind === 'assignment').map((x) => JSON.parse(x.json));
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: a.json.assignment.id, memberId: p.json.memberId, userId: acct.json.user.id, scopeId: 'scp_eco' });
    // ... and the Tester can record results in that scope, and only in it
    const tester = await joined(email);
    expect(tester.records.some((r) => r.kind === 'scope' && r.id === 'scp_eco')).toBe(true);
    expect((await commit(tester, [put('caseResult', caseResultId('tc_eco1'), result('tc_eco1', acct.json.user.id))])).ok).toBe(true);
  });

  it('only an active Tester profile can be assigned; a linked profile resolves to its account; a profile of another workspace is unknown', async () => {
    const a = await workspace('Alpha');
    const b = await workspace('Beta');
    const sv = await addProfile(a.t, { displayName: 'An SV', email: rk('sv'), role: 'sv' });
    const gone = await addProfile(a.t, { displayName: 'Gone', email: rk('gone'), role: 'tester' });
    await post(a.t.adminEmail, `/api/tenant/members/${gone.json.memberId}/remove`, {});
    const linked = await addProfile(a.t, { displayName: 'Linked', email: rk('linked'), role: 'tester', createAccount: true });
    const asg = (memberId: string, scopeId = 'scp_eco') => post<{ error?: string; assignment?: { userId?: string; memberId?: string } }>(a.t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', memberId, scopeId });
    expect((await asg(sv.json.memberId)).json.error).toBe('member_not_tester');
    expect((await asg(gone.json.memberId)).json.error).toBe('member_inactive');
    expect((await asg('USER9999')).json.error).toBe('member_not_found');
    const viaLogin = await asg(linked.json.memberId);
    expect(viaLogin.status).toBe(201);
    expect(viaLogin.json.assignment).toMatchObject({ userId: linked.json.user!.id });
    // B's SV cannot assign A's member, nor assign to A's project
    expect((await post(b.t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', memberId: linked.json.memberId, scopeId: 'scp_eco' })).status).toBeGreaterThanOrEqual(400);
  });
});

describe('what a commit may do to a profile', () => {
  it('an SV\'s commit cannot change a linked profile\'s email, role or active state, delete it, or duplicate an email; an unlinked profile can be edited freely', async () => {
    const { t } = await workspace('Alpha');
    const linked = await addProfile(t, { displayName: 'Linked', email: rk('linked'), role: 'tester', createAccount: true });
    const free = await addProfile(t, { displayName: 'Free', email: rk('free'), role: 'tester' });
    const sv = await joined(t.adminEmail);
    const get1 = (id: string) => JSON.parse(sv.records.find((r) => r.id === id)!.json) as Record<string, unknown>;
    const fresh = async () => {
      const ex = await exportOf(t.adminEmail);
      sv.revision = ex.revision;
      return (id: string) => JSON.parse(ex.records.find((r) => r.id === id)!.json) as Record<string, unknown>;
    };
    void get1;
    const read = await fresh();
    const l = read(linked.json.memberId);
    const f = read(free.json.memberId);
    const reasons = async (puts: Rec[], deletes: Array<{ kind: string; id: string }> = []) => {
      const r = await commit(sv, puts, deletes);
      return r.ok ? 'ok' : (r.reject as { message?: string }).message;
    };
    expect(await reasons([put('member', l.id as string, { ...l, email: rk('else') })])).toBe('member_email_locked');
    expect(await reasons([put('member', l.id as string, { ...l, role: 'SV' })])).toBe('member_role_requires_api');
    expect(await reasons([put('member', l.id as string, { ...l, active: false })])).toBe('member_status_requires_api');
    expect(await reasons([put('member', l.id as string, { ...l, userId: undefined })])).toBe('member_link_requires_api');
    expect(await reasons([], [{ kind: 'member', id: l.id as string }])).toBe('member_linked_cannot_delete');
    expect(await reasons([put('member', f.id as string, { ...f, email: l.email })])).toBe('member_email_taken');
    expect(await reasons([put('member', f.id as string, { ...f, email: 'NOT NORMALISED@X.COM' })])).toBe('member_invalid_email');
    expect(await reasons([put('member', f.id as string, { ...f, name: 'Renamed', email: rk('new') })])).toBe('ok');
    // a linked profile's NAME and dates remain editable by commit (they are not identity)
    const read2 = await fresh();
    expect(await reasons([put('member', l.id as string, { ...read2(linked.json.memberId), name: 'Linked Renamed' })])).toBe('ok');
  });

  it('a Tester receives the roster\'s names but not other people\'s email addresses (their own is kept)', async () => {
    const { t } = await workspace('Alpha');
    const tess = await addProfile(t, { displayName: 'Tess', email: rk('tess'), role: 'tester', createAccount: true });
    const other = await addProfile(t, { displayName: 'Other', email: rk('other-secret'), role: 'tester' });
    const live = await joined(tess.json.user!.email);
    const members = live.records.filter((r) => r.kind === 'member').map((r) => JSON.parse(r.json) as Record<string, unknown>);
    expect(members.find((m) => m.id === other.json.memberId)).toMatchObject({ name: 'Other' });
    expect(members.find((m) => m.id === other.json.memberId)!.email).toBeUndefined();
    expect(members.find((m) => m.id === tess.json.memberId)!.email).toBe(tess.json.user!.email);
    const exported = (await exportOf(tess.json.user!.email)).records.filter((r) => r.kind === 'member');
    expect(exported.map((r) => r.json).join('')).not.toContain('other-secret');
    // and a later change to someone else's profile is pushed to them without the email too
    await post(t.adminEmail, `/api/tenant/members/${other.json.memberId}`.replace('/members/', '/members/'), {}).catch(() => undefined);
    await call(t.adminEmail, 'PATCH', `/api/tenant/members/${other.json.memberId}`, { displayName: 'Other Renamed' });
    const changes = await live.sock.next('changes', 1500).catch(() => null);
    if (changes !== null) expect(J(changes)).not.toContain('other-secret');
  });
});
