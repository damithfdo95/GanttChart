import { describe, expect, it } from 'vitest';
import { businessDate } from '../../../shared/businessTime';
import type { PrincipalDto, UserDto } from '../../../shared/tenancy';
import { CLOSE_CODES } from '../../../shared/tenancy';
import { SUPER, activateWeb, call, createTenant, email, get, openSocket, patch, post, rec, whoami, type Tenant } from './tenancy-harness';
import type { TestSocket } from './helpers';

/**
 * Stage 8B through the real Worker and Durable Objects: SVs and Testers, the Owner SV, Team Members, and what a
 * Tester may and may not change or even receive. Nothing is mocked.
 */

let seq = 0;
const rk = (label: string): string => `${label}-${++seq}-${crypto.randomUUID().slice(0, 6)}@rakuten.com`;
const today = (): string => businessDate();

const entry = (over: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), date: today(), testers: 2, pass: 5, fail: 1, notApplicable: 0, spo: 0, blocked: 0, retest: 0, questioned: 0, overtimeMinutes: 0, ...over });
const ticket = (over: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), projectId: 'PRJ-001', title: 'Crash on launch', url: 'https://jira.example.com/browse/X-1', createdAt: today(), reportedBy: 'someone', ...over });
const perf = (over: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), date: today(), testerName: 'x', projectId: 'PRJ-001', casesTested: 10, ...over });

function project(inputs: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return rec('project', 'proj-1', { id: 'proj-1', projectId: 'PRJ-001', nameEn: 'Android Sanity', nameJa: '', team: 'RCS', status: 'ongoing', inputs: { totalCases: 100, dailyExecuted: [], bugTickets: [], testerDailyPerformance: [], ...inputs }, ...extra });
}

interface Person {
  email: string;
  user: UserDto;
  memberId: string;
}

async function exportOf(as: string) {
  return (await get<{ revision: number; records: Array<{ kind: string; id: string; json: string }> }>(as, '/api/export')).json;
}

async function addMember(t: Tenant, role: 'sv' | 'tester', label: string, extra: Record<string, unknown> = {}): Promise<Person> {
  const mail = rk(label);
  const r = await post<{ user: UserDto; profile: string }>(t.adminEmail, '/api/tenant/users', { email: mail, role, ...extra });
  if (r.status !== 201) throw new Error(`addMember ${role} failed ${r.status} ${r.text}`);
  const ex = await exportOf(t.adminEmail);
  const m = ex.records.find((x) => x.kind === 'member' && JSON.parse(x.json).userId === r.json.user.id);
  if (m === undefined) throw new Error('no profile was created for the new member');
  return { email: mail, user: r.json.user, memberId: m.id };
}

async function joined(as: string): Promise<{ sock: TestSocket; revision: number; records: Array<{ kind: string; id: string; json: string }> }> {
  const o = await openSocket(as);
  if (!o.ok) throw new Error(`socket refused: ${o.status}`);
  const snap = await o.sock.next('snapshot');
  return { sock: o.sock, revision: snap.revision, records: snap.records };
}

let commitSeq = 0;
async function commit(c: { sock: TestSocket; revision: number }, puts: Array<{ kind: string; id: string; json: string }>, deletes: Array<{ kind: string; id: string }> = []) {
  commitSeq += 1;
  c.sock.send({ t: 'commit', id: `s8b-${commitSeq}-${crypto.randomUUID()}`, baseRevision: c.revision, puts, deletes } as never);
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

/** Refresh a socket's base revision to the server's head (after other people's writes). */
async function sync(c: { revision: number }, as: string): Promise<void> {
  c.revision = (await exportOf(as)).revision;
}

async function workspace(name: string, records = [project()]) {
  const t = await createTenant(name, rk('owner'));
  await activateWeb(t, records);
  return t;
}

describe('SVs and the Owner SV', () => {
  it('a workspace starts with an Owner SV; an SV can add more SVs and Testers; only one is the Owner', async () => {
    const t = await workspace('Alpha');
    expect((await whoami(t.adminEmail)).json).toMatchObject({ role: 'admin', isOwner: true });
    const sv2 = await addMember(t, 'sv', 'sv2');
    const sv3 = await addMember(t, 'sv', 'sv3');
    const tester = await addMember(t, 'tester', 'tester');
    expect((await whoami(sv2.email)).json).toMatchObject({ role: 'admin', isOwner: false });
    expect((await whoami(tester.email)).json).toMatchObject({ role: 'user', isOwner: false });
    // A second SV can add a third one.
    const r = await call(sv2.email, 'POST', '/api/tenant/users', { email: rk('sv4'), role: 'sv' });
    expect(r.status).toBe(201);
    const users = (await get<{ users: UserDto[] }>(t.adminEmail, '/api/tenant/users')).json.users;
    expect(users.filter((u) => u.role === 'admin')).toHaveLength(4);
    expect(users.filter((u) => u.isOwner).map((u) => u.email)).toEqual([t.adminEmail]);
    expect(sv3.user.role).toBe('admin');
  });

  it('a Tester cannot add anyone; a foreign SV cannot add to this workspace; a forged tenant id is refused', async () => {
    const a = await workspace('Alpha');
    const b = await workspace('Beta');
    const tester = await addMember(a, 'tester', 'tester');
    for (const role of ['sv', 'tester']) expect((await post(tester.email, '/api/tenant/users', { email: rk('x'), role })).status, role).toBe(403);
    const intruder = rk('into-a');
    expect((await post(b.adminEmail, '/api/tenant/users', { email: intruder, role: 'sv', tenantId: a.id })).status).toBe(403);
    expect((await call(b.adminEmail, 'POST', `/api/tenant/users?tenantId=${a.id}`, { email: intruder, role: 'sv' })).status).toBe(403);
    expect((await whoami(intruder)).status).toBe(403);
    const inA = (await get<{ users: UserDto[] }>(a.adminEmail, '/api/tenant/users')).json.users.map((u) => u.email);
    expect(inA).not.toContain(intruder);
  });

  it('refuses a duplicate in the same workspace and an address of another workspace, and says nothing about the other workspace', async () => {
    const a = await workspace('Alpha-Secret-Name');
    const b = await workspace('Beta');
    const taken = await addMember(a, 'tester', 'dup');
    const same = await post(a.adminEmail, '/api/tenant/users', { email: taken.email.toUpperCase(), role: 'tester' });
    expect([same.status, same.json.error]).toEqual([409, 'email_taken']);
    const cross = await post(b.adminEmail, '/api/tenant/users', { email: taken.email, role: 'sv' });
    expect([cross.status, cross.json.error]).toEqual([409, 'email_in_other_workspace']);
    for (const needle of [a.id, 'Alpha-Secret-Name', a.adminEmail]) expect(cross.text).not.toContain(needle);
    expect((await whoami(taken.email)).json.tenant?.id).toBe(a.id); // never moved
  });

  it('keeps the managed domain rule for SVs and Testers alike', async () => {
    const t = await workspace('Alpha');
    for (const mail of ['someone@gmail.com', 'x@fake-rakuten.com', 'x@rakuten.com.evil.io']) {
      for (const role of ['sv', 'tester']) expect((await post(t.adminEmail, '/api/tenant/users', { email: mail, role })).json.error, `${mail}/${role}`).toBe('email_domain_not_allowed');
    }
  });

  it('only the product role names are accepted', async () => {
    const t = await workspace('Alpha');
    for (const role of ['admin', 'user', 'super_admin', 'owner', 5, null]) {
      expect((await post(t.adminEmail, '/api/tenant/users', { email: rk('r'), role })).status, String(role)).toBe(400);
    }
  });

  it('the Owner cannot be disabled by anyone, including themselves and another SV', async () => {
    const t = await workspace('Alpha');
    const sv = await addMember(t, 'sv', 'sv');
    const users = (await get<{ users: UserDto[] }>(t.adminEmail, '/api/tenant/users')).json.users;
    const owner = users.find((u) => u.isOwner)!;
    expect((await patch(t.adminEmail, `/api/tenant/users/${owner.id}`, { status: 'disabled' })).json.error).toBe('owner_protected');
    expect((await patch(sv.email, `/api/tenant/users/${owner.id}`, { status: 'disabled' })).json.error).toBe('owner_protected');
    expect((await whoami(t.adminEmail)).status).toBe(200);
  });

  it('a non-owner SV can be disabled by another SV: API refused, live socket closed, reconnect blocked; reactivation restores the same account', async () => {
    const t = await workspace('Alpha');
    const sv = await addMember(t, 'sv', 'sv');
    const live = await openSocket(sv.email);
    if (!live.ok) throw new Error('connect');
    const off = await patch<{ user: UserDto; disconnected: boolean }>(t.adminEmail, `/api/tenant/users/${sv.user.id}`, { status: 'disabled' });
    expect(off.json).toMatchObject({ user: { status: 'disabled', id: sv.user.id, role: 'admin' }, disconnected: true });
    expect((await live.sock.closed).code).toBe(CLOSE_CODES.accessRevoked);
    expect((await whoami(sv.email)).status).toBe(403);
    expect((await get(sv.email, '/api/tenant/users')).status).toBe(403);
    expect((await openSocket(sv.email)).ok).toBe(false);
    const on = await patch<{ user: UserDto }>(t.adminEmail, `/api/tenant/users/${sv.user.id}`, { status: 'enabled' });
    expect(on.json.user).toMatchObject({ status: 'active', id: sv.user.id });
    expect((await whoami(sv.email)).status).toBe(200);
  });

  it('an SV cannot disable themselves; a Tester can never disable anyone', async () => {
    const t = await workspace('Alpha');
    const sv = await addMember(t, 'sv', 'sv');
    const tester = await addMember(t, 'tester', 'tester');
    expect((await patch(sv.email, `/api/tenant/users/${sv.user.id}`, { status: 'disabled' })).json.error).toBe('same_person');
    expect((await patch(tester.email, `/api/tenant/users/${sv.user.id}`, { status: 'disabled' })).status).toBe(403);
    expect((await patch(sv.email, `/api/tenant/users/${tester.user.id}`, { access: 'viewer' })).status).toBe(200);
  });

  it('the Super Admin cannot manage Team Members', async () => {
    const t = await workspace('Alpha');
    expect((await post(SUPER, '/api/tenant/users', { email: rk('x'), role: 'sv' })).status).toBe(403);
    expect((await get(SUPER, '/api/tenant/users')).status).toBe(403);
    expect((await post(SUPER, '/api/tenant/owner', { userId: 'usr_x', confirm: 'TRANSFER' })).status).toBe(403);
    expect(t.id).toBeTruthy();
  });
});

describe('ownership transfer', () => {
  it('moves the ownership to another enabled SV, requires the typed word, and the new Owner (only) can ask for deletion', async () => {
    const t = await workspace('Alpha');
    const sv = await addMember(t, 'sv', 'sv');
    expect((await post(t.adminEmail, '/api/tenant/owner', { userId: sv.user.id })).status).toBe(400); // no confirmation
    expect((await post(sv.email, '/api/tenant/owner', { userId: sv.user.id, confirm: 'TRANSFER' })).status).toBe(403); // not the Owner
    const done = await post<{ owner: UserDto; previous: UserDto }>(t.adminEmail, '/api/tenant/owner', { userId: sv.user.id, confirm: 'TRANSFER' });
    expect(done.status).toBe(200);
    expect(done.json.owner).toMatchObject({ id: sv.user.id, isOwner: true });
    expect((await whoami(sv.email)).json.isOwner).toBe(true);
    expect((await whoami(t.adminEmail)).json.isOwner).toBe(false);
    expect((await post(t.adminEmail, '/api/tenant/deletion-request', { confirm: 'DELETE' })).status).toBe(403);
    expect((await post(sv.email, '/api/tenant/deletion-request', { confirm: 'DELETE' })).status).toBe(200);
  });

  it('refuses a Tester, a disabled SV, a user of another workspace, an unknown id and the Owner themselves', async () => {
    const a = await workspace('Alpha');
    const b = await workspace('Beta');
    const tester = await addMember(a, 'tester', 'tester');
    const off = await addMember(a, 'sv', 'off');
    await patch(a.adminEmail, `/api/tenant/users/${off.user.id}`, { status: 'disabled' });
    const foreign = await addMember(b, 'sv', 'foreign');
    const owner = (await get<{ users: UserDto[] }>(a.adminEmail, '/api/tenant/users')).json.users.find((u) => u.isOwner)!;
    for (const [id, status] of [[tester.user.id, 403], [off.user.id, 403], [foreign.user.id, 404], [`usr_${crypto.randomUUID()}`, 404], [owner.id, 409]] as const) {
      expect((await post(a.adminEmail, '/api/tenant/owner', { userId: id, confirm: 'TRANSFER' })).status, id).toBe(status);
    }
    expect((await whoami(a.adminEmail)).json.isOwner).toBe(true);
  });

  it('is recorded in the workspace audit trail only', async () => {
    const t = await workspace('Alpha');
    const sv = await addMember(t, 'sv', 'sv');
    await post(t.adminEmail, '/api/tenant/owner', { userId: sv.user.id, confirm: 'TRANSFER' });
    const mine = (await get<{ audit: Array<{ action: string; actorEmail: string; targetEmail: string }> }>(sv.email, '/api/tenant/audit')).json.audit;
    expect(mine.find((e) => e.action === 'owner.transferred')).toMatchObject({ actorEmail: t.adminEmail, targetEmail: sv.email });
    const platform = await get(SUPER, '/api/super/admin-audit');
    expect(platform.text).not.toContain('owner.transferred');
  });
});

describe('Team Member profiles', () => {
  it('creating a member also creates its roster profile, linked by account id, visible to everyone in the workspace', async () => {
    const t = await workspace('Alpha');
    const tester = await addMember(t, 'tester', 'tester', { displayName: 'Hana Sato' });
    const sv = await addMember(t, 'sv', 'sv');
    const ex = await exportOf(tester.email);
    const mine = ex.records.find((r) => r.kind === 'member' && r.id === tester.memberId)!;
    expect(JSON.parse(mine.json)).toMatchObject({ name: 'Hana Sato', role: 'Tester', userId: tester.user.id, active: true });
    expect(JSON.parse(ex.records.find((r) => r.id === sv.memberId)!.json)).toMatchObject({ role: 'SV' });
    expect((await whoami(tester.email)).json.userId).toBe(tester.user.id);
  });

  it('member ids continue the existing USER0001 sequence', async () => {
    const t = await workspace('Alpha', [project(), rec('member', 'USER0007', { id: 'USER0007', name: 'Legacy', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true })]);
    const p = await addMember(t, 'tester', 'next');
    expect(p.memberId).toBe('USER0008');
  });

  it('a roster-only (older) member can be linked to an account by an SV, once; the link cannot be set through sync', async () => {
    const t = await workspace('Alpha', [project(), rec('member', 'USER0003', { id: 'USER0003', name: 'Yamauchi Kentaro', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true })]);
    const tester = await addMember(t, 'tester', 'yama');
    const other = await addMember(t, 'tester', 'other');
    const admin = await joined(t.adminEmail);
    // Through sync: refused for everyone.
    const forged = JSON.stringify({ id: 'USER0003', name: 'Yamauchi Kentaro', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true, userId: tester.user.id });
    expect(await commit(admin, [{ kind: 'member', id: 'USER0003', json: forged }])).toMatchObject({ ok: false, reject: { message: 'member_link_requires_api' } });
    // Through the API: an SV, an account of this workspace, once.
    expect((await post(tester.email, '/api/tenant/members/link', { memberId: 'USER0003', userId: tester.user.id })).status).toBe(403);
    const linked = await post(t.adminEmail, '/api/tenant/members/link', { memberId: 'USER0003', userId: other.user.id });
    expect(linked.status).toBe(409); // that account already has its own profile
    expect(linked.json.error).toBe('account_already_linked');
  });

  it('linking refuses an unknown member, an account of another workspace and an already linked member', async () => {
    const a = await workspace('Alpha', [project(), rec('member', 'USER0003', { id: 'USER0003', name: 'N', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true })]);
    const b = await workspace('Beta');
    const foreign = await addMember(b, 'tester', 'foreign');
    expect((await post(a.adminEmail, '/api/tenant/members/link', { memberId: 'USER0003', userId: foreign.user.id })).status).toBe(404);
    expect((await post(a.adminEmail, '/api/tenant/members/link', { memberId: 'USER9999', userId: foreign.user.id })).status).toBe(404);
    expect((await post(a.adminEmail, '/api/tenant/members/link', { memberId: 'USER0003', userId: 'nope' })).status).toBe(400);
    const own = await addMember(a, 'tester', 'own');
    const exA = await exportOf(a.adminEmail);
    expect(exA.records.filter((r) => r.kind === 'member').map((r) => r.id)).toContain(own.memberId);
  });

  it('editing a profile (name, role label, dates) keeps the account link; a client cannot change or drop it', async () => {
    const t = await workspace('Alpha');
    const tester = await addMember(t, 'tester', 'tester');
    const admin = await joined(t.adminEmail);
    const cur = JSON.parse((await exportOf(t.adminEmail)).records.find((r) => r.id === tester.memberId)!.json);
    expect((await commit(admin, [{ kind: 'member', id: tester.memberId, json: JSON.stringify({ ...cur, name: 'Renamed' }) }])).ok).toBe(true);
    const { userId: _drop, ...without } = cur;
    expect(await commit(admin, [{ kind: 'member', id: tester.memberId, json: JSON.stringify(without) }])).toMatchObject({ ok: false, reject: { message: 'member_link_requires_api' } });
  });
});

describe('profiles for accounts that predate Team Members', () => {
  it('an SV can give one account its profile, once; nobody else can, and a foreign account is unknown', async () => {
    const t = await workspace('Alpha');
    const other = await workspace('Beta');
    const users = (await get<{ users: UserDto[] }>(t.adminEmail, '/api/tenant/users')).json.users;
    const owner = users.find((u) => u.isOwner)!;
    expect((await exportOf(t.adminEmail)).records.filter((r) => r.kind === 'member')).toHaveLength(0); // nothing is created behind anyone's back
    const first = await post<{ memberId: string; created: boolean }>(t.adminEmail, '/api/tenant/members/profile', { userId: owner.id });
    expect([first.status, first.json.created]).toEqual([201, true]);
    const again = await post<{ memberId: string; created: boolean }>(t.adminEmail, '/api/tenant/members/profile', { userId: owner.id });
    expect([again.status, again.json.created, again.json.memberId]).toEqual([200, false, first.json.memberId]);
    const tester = await addMember(t, 'tester', 'tester');
    expect((await post(tester.email, '/api/tenant/members/profile', { userId: owner.id })).status).toBe(403);
    const foreign = (await get<{ users: UserDto[] }>(other.adminEmail, '/api/tenant/users')).json.users[0];
    expect((await post(t.adminEmail, '/api/tenant/members/profile', { userId: foreign.id })).status).toBe(404);
    expect((await post(t.adminEmail, '/api/tenant/members/profile', { userId: 'nope' })).status).toBe(400);
  });

  it('restoring an older revision does not undo the link between a profile and its account', async () => {
    const t = await workspace('Alpha');
    const tester = await addMember(t, 'tester', 'tester');
    const restored = await post<{ revision: number }>(t.adminEmail, '/api/revisions/1/restore');
    expect(restored.status).toBe(200);
    const members = (await exportOf(t.adminEmail)).records.filter((r) => r.kind === 'member');
    expect(members.map((m) => JSON.parse(m.json).userId)).toEqual([tester.user.id]);
    expect(members[0].id).toBe(tester.memberId);
  });
});

describe('what a Tester may read', () => {
  const secrets = [
    rec('review', 'rev-1', { id: 'rev-1', createdAt: '2026-10-01', note: 'BONUS-REVIEW-SECRET' }),
    rec('report', 'rep-1', { id: 'rep-1', createdAt: '2026-10-01', body: 'DAILY-REPORT-SECRET' }),
    rec('topic', 'top-1', { id: 'top-1', createdAt: '2026-10-01', text: 'TOPIC-SECRET' }),
    rec('identityAudit', 'ia-1', { id: 'ia-1', timestamp: '2026-10-01', note: 'IDENTITY-SECRET' }),
    rec('externalIdentity', 'ei-1', { id: 'ei-1', note: 'EXTERNAL-SECRET' }),
  ];

  it('a Tester never receives reviews, reports, topics or identity logs (snapshot, export, live changes, catch-up); an SV does', async () => {
    const t = await workspace('Alpha', [project(), ...secrets]);
    const tester = await addMember(t, 'tester', 'tester');
    const sv = await joined(t.adminEmail);
    const live = await joined(tester.email);
    const snapshotText = JSON.stringify(live.records);
    for (const s of ['BONUS-REVIEW-SECRET', 'DAILY-REPORT-SECRET', 'TOPIC-SECRET', 'IDENTITY-SECRET', 'EXTERNAL-SECRET']) {
      expect(snapshotText, s).not.toContain(s);
      expect(JSON.stringify(await exportOf(tester.email)), s).not.toContain(s);
      expect(JSON.stringify(sv.records), s).toContain(s);
    }
    expect(live.records.map((r) => r.kind)).toContain('project');
    // A new SV-only record is not pushed to the Tester; a project change is.
    const later = rec('review', 'rev-2', { id: 'rev-2', createdAt: '2026-10-02', note: 'LATER-SECRET' });
    await sync(sv, t.adminEmail);
    expect((await commit(sv, [later, project({ totalCases: 120 })])).ok).toBe(true);
    const pushed = await live.sock.next('changes');
    expect(JSON.stringify(pushed)).not.toContain('LATER-SECRET');
    expect(pushed.puts.map((p) => p.kind)).toEqual(['project']);
    // Catch-up after a reconnect is filtered the same way.
    const known = live.revision;
    const again = await openSocket(tester.email);
    if (!again.ok) throw new Error('reconnect');
    again.sock.send({ t: 'hello', v: 1, clientId: `c-${crypto.randomUUID()}`, lastRevision: known } as never);
    const missed = await again.sock.next('changes');
    expect(JSON.stringify(missed)).not.toContain('LATER-SECRET');
  });

  it('Shared History, the Tester roster, member management, stats, audit and restore are SV-only', async () => {
    const t = await workspace('Alpha');
    const tester = await addMember(t, 'tester', 'tester');
    const sv = await addMember(t, 'sv', 'sv');
    for (const [method, path] of [['GET', '/api/revisions'], ['GET', '/api/revisions/1'], ['POST', '/api/revisions/1/restore'], ['GET', '/api/tenant/team'], ['GET', '/api/tenant/users'], ['GET', '/api/stats'], ['GET', '/api/tenant/audit'], ['GET', '/api/tenant/storage/inspect']] as const) {
      const r = await call(tester.email, method, path, method === 'POST' ? {} : undefined);
      expect(r.status, `Tester ${method} ${path}`).toBe(403);
    }
    for (const path of ['/api/revisions', '/api/tenant/team', '/api/tenant/users', '/api/tenant/audit']) {
      expect((await get(sv.email, path)).status, `SV ${path}`).toBe(200);
    }
  });

  it('Shared History pages without gaps or repeats (cursor by revision)', async () => {
    const t = await workspace('Alpha');
    const sv = await joined(t.adminEmail);
    for (let i = 0; i < 7; i += 1) expect((await commit(sv, [project({ totalCases: 100 + i })])).ok).toBe(true);
    const all = (await get<Array<{ revision: number }>>(t.adminEmail, '/api/revisions?limit=100')).json.map((r) => r.revision);
    const pages: number[][] = [];
    let before: number | undefined;
    for (;;) {
      const page = (await get<Array<{ revision: number }>>(t.adminEmail, `/api/revisions?limit=3${before === undefined ? '' : `&before=${before}`}`)).json.map((r) => r.revision);
      if (page.length === 0) break;
      pages.push(page);
      before = page[page.length - 1];
    }
    expect(pages.flat()).toEqual(all);
    expect(new Set(pages.flat()).size).toBe(all.length);
    expect(pages.length).toBeGreaterThan(1);
  });

  it('another workspace’s history is unreachable, even for an SV, with a forged tenant', async () => {
    const a = await workspace('Alpha');
    const b = await workspace('Beta');
    expect((await call(b.adminEmail, 'GET', `/api/revisions?tenantId=${a.id}`)).status).toBe(403);
    const ownRows = (await get<Array<{ actor: string }>>(b.adminEmail, '/api/revisions')).json;
    expect(JSON.stringify(ownRows)).not.toContain(a.adminEmail);
  });
});

describe('what a Tester may change', () => {
  async function setup() {
    const t = await workspace('Alpha');
    const hana = await addMember(t, 'tester', 'hana', { displayName: 'Hana' });
    const ken = await addMember(t, 'tester', 'ken', { displayName: 'Ken' });
    await post(t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: hana.user.id });
    const h = await joined(hana.email);
    const k = await joined(ken.email);
    await sync(h, t.adminEmail);
    await sync(k, t.adminEmail);
    return { t, hana, ken, h, k };
  }

  it('Today’s Execution: an assigned Tester records today’s entry; an unassigned one, another day, and a rewrite of the plan are refused', async () => {
    const { hana, ken, h, k } = await setup();
    expect((await commit(h, [project({ dailyExecuted: [entry()] })])).ok).toBe(true);
    await sync(k, hana.email);
    expect(await commit(k, [project({ dailyExecuted: [entry()] })])).toMatchObject({ ok: false, reject: { message: 'tester_execution_not_assigned' } });
    expect(await commit(h, [project({ dailyExecuted: [entry({ date: '2026-01-05' })] })])).toMatchObject({ ok: false, reject: { message: 'tester_execution_not_today' } });
    expect(await commit(h, [project({ totalCases: 5 })])).toMatchObject({ ok: false, reject: { message: 'tester_project_plan' } });
    expect(await commit(h, [project({}, { nameEn: 'Renamed' })])).toMatchObject({ ok: false, reject: { message: 'tester_project_structure' } });
    expect(await commit(h, [project({}, { status: 'done' })])).toMatchObject({ ok: false, reject: { message: 'tester_project_structure' } });
    expect(hana.email).not.toBe(ken.email);
  });

  it('the cumulative totals follow the entry; they cannot be edited on their own', async () => {
    const { h } = await setup();
    expect(await commit(h, [project({ casesCompleted: 90, casesPassed: 90 })])).toMatchObject({ ok: false, reject: { message: 'tester_derived_without_entry' } });
  });

  it('Tickets: anyone raises one; only the reporter changes or removes it; ownership cannot be rewritten', async () => {
    const { hana, ken, h, k } = await setup();
    const mine = ticket({ id: 'tk-hana', reporterMemberId: hana.memberId, reportedBy: 'Hana' });
    expect((await commit(h, [project({ bugTickets: [mine] })])).ok).toBe(true);
    await sync(k, hana.email);
    // Ken sees it, may raise his own, but cannot edit, delete or re-own Hana's.
    const own = ticket({ id: 'tk-ken', reporterMemberId: ken.memberId, reportedBy: 'Ken' });
    expect((await commit(k, [project({ bugTickets: [mine, own] })])).ok).toBe(true);
    expect(await commit(k, [project({ bugTickets: [{ ...mine, title: 'Hijacked' }, own] })])).toMatchObject({ ok: false, reject: { message: 'tester_ticket_not_own' } });
    expect(await commit(k, [project({ bugTickets: [own] })])).toMatchObject({ ok: false, reject: { message: 'tester_ticket_not_own' } });
    expect(await commit(k, [project({ bugTickets: [mine, { ...own, reporterMemberId: hana.memberId }] })])).toMatchObject({ ok: false, reject: { message: 'tester_ticket_owner_immutable' } });
    expect(await commit(k, [project({ bugTickets: [mine, own, ticket({ id: 'tk-fake', reporterMemberId: hana.memberId })] })])).toMatchObject({ ok: false, reject: { message: 'tester_ticket_as_someone_else' } });
    // The reporter can edit their own.
    await sync(h, hana.email);
    expect((await commit(h, [project({ bugTickets: [{ ...mine, status: 'Resolved' }, own] })])).ok).toBe(true);
  });

  it('Performance: a Tester writes only their own rows', async () => {
    const { hana, ken, h } = await setup();
    const mine = perf({ id: 'pf-1', memberId: hana.memberId, testerName: 'Hana' });
    expect((await commit(h, [project({ testerDailyPerformance: [mine] })])).ok).toBe(true);
    expect(await commit(h, [project({ testerDailyPerformance: [mine, perf({ id: 'pf-2', memberId: ken.memberId, testerName: 'Ken' })] })])).toMatchObject({ ok: false, reject: { message: 'tester_performance_not_own' } });
    expect(await commit(h, [project({ testerDailyPerformance: [mine, perf({ id: 'pf-3', testerName: 'Legacy no member id' })] })])).toMatchObject({ ok: false, reject: { message: 'tester_performance_not_own' } });
    expect(await commit(h, [project({ testerDailyPerformance: [{ ...mine, memberId: ken.memberId }] })])).toMatchObject({ ok: false, reject: { message: 'tester_performance_not_own' } });
  });

  it('a Tester can change nothing else: no new or deleted project, no cycles, members, assignments, settings, reports, reviews', async () => {
    const { t, h } = await setup();
    expect(await commit(h, [rec('project', 'proj-new', { id: 'proj-new', projectId: 'PRJ-009', inputs: {} })])).toMatchObject({ ok: false, reject: { message: 'tester_cannot_create_project' } });
    expect(await commit(h, [], [{ kind: 'project', id: 'proj-1' }])).toMatchObject({ ok: false, reject: { message: 'tester_cannot_delete' } });
    for (const kind of ['cycle', 'member', 'assignment', 'settings', 'report', 'review', 'attendance', 'topic'] as const) {
      const r = await commit(h, [rec(kind, kind === 'settings' ? 'settings' : 'x-1', { id: 'x-1' })]);
      expect(r, kind).toMatchObject({ ok: false, reject: { reason: 'invalid', message: 'tester_cannot_change_kind' } });
    }
    const ex = await exportOf(t.adminEmail);
    expect(ex.records.find((r) => r.id === 'x-1')).toBeUndefined();
  });

  it('a read-only Tester can write nothing at all', async () => {
    const t = await workspace('Alpha');
    const mail = rk('viewer');
    expect((await post(t.adminEmail, '/api/tenant/users', { email: mail, role: 'tester', access: 'viewer' })).status).toBe(201);
    const v = await joined(mail);
    expect(await commit(v, [project({ dailyExecuted: [entry()] })])).toMatchObject({ ok: false, reject: { reason: 'forbidden' } });
  });

  it('an SV, including a non-owner SV, can change everything a Tester cannot', async () => {
    const t = await workspace('Alpha');
    const sv = await addMember(t, 'sv', 'sv');
    const c = await joined(sv.email);
    await sync(c, t.adminEmail);
    expect((await commit(c, [project({ totalCases: 50 }, { nameEn: 'Renamed by SV' })])).ok).toBe(true);
    expect((await commit(c, [rec('project', 'proj-2', { id: 'proj-2', projectId: 'PRJ-002', inputs: { totalCases: 1 } })])).ok).toBe(true);
    expect((await commit(c, [], [{ kind: 'project', id: 'proj-2' }])).ok).toBe(true);
  });

  it('one workspace’s Tester can never read or write another workspace', async () => {
    const a = await setup();
    const other = await workspace('Beta');
    expect((await get(a.hana.email, `/api/export?tenantId=${other.id}`)).status).toBe(403);
    const mine = await exportOf(a.hana.email);
    expect(JSON.stringify(mine)).not.toContain(other.adminEmail);
    expect(await commit(a.h, [rec('project', 'proj-1', { id: 'proj-1', projectId: 'PRJ-001', tenantId: other.id })])).toMatchObject({ ok: false });
  });
});

describe('principal DTO', () => {
  it('tells the browser who the person is in product terms and carries no other account ids', async () => {
    const t = await workspace('Alpha');
    const tester = await addMember(t, 'tester', 'tester');
    const dto = (await whoami(tester.email)).json as PrincipalDto;
    expect(dto).toMatchObject({ role: 'user', isOwner: false, userId: tester.user.id, tenant: { id: t.id } });
    expect(JSON.stringify(dto).match(/usr_[\w-]+/g)).toEqual([tester.user.id]);
  });
});

describe('older Testers keep working', () => {
  it('a Tester created the old way (no role field) is still a Tester and can sign in', async () => {
    const t = await workspace('Alpha');
    const mail = email('legacy');
    const r = await post<{ user: UserDto }>(t.adminEmail, '/api/tenant/users', { email: mail, access: 'editor' });
    expect(r.status).toBe(201);
    expect((await whoami(mail)).json).toMatchObject({ role: 'user', access: 'editor', workspaceRole: 'editor' });
  });
});
