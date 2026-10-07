import { describe, expect, it } from 'vitest';
import { businessDate } from '../../../shared/businessTime';
import type { TesterDto, UserDto } from '../../../shared/tenancy';
import type { CycleRecord } from '../../../shared/qaRules';
import { SECRET_A, SUPER, activateWeb, call, createTenant, email, get, openSocket, patch, post, rec, whoami, type Tenant } from './tenancy-harness';
import type { TestSocket } from './helpers';

/**
 * Stage 8A through the real Worker and Durable Objects: test cycles, Tester assignment, execution results
 * rules, conflicts and tenant isolation. Nothing is mocked.
 */

const NOW = '2026-10-07T00:00:00.000Z';
let seq = 0;
const rk = (label: string): string => `${label}-${++seq}-${crypto.randomUUID().slice(0, 6)}@rakuten.com`;
const cid = (): string => `cyc_${crypto.randomUUID()}`;
const today = (): string => businessDate();

const cycle = (over: Partial<CycleRecord> = {}): CycleRecord => ({ id: cid(), name: 'Android 4.2.0 Release', status: 'planned', plannedStart: '2026-10-01', plannedEnd: '2026-10-31', completedAt: null, createdAt: NOW, updatedAt: NOW, ...over });
const entry = (over: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), date: '2026-10-05', testers: 2, pass: 10, fail: 2, notApplicable: 0, spo: 0, blocked: 1, retest: 0, questioned: 0, overtimeMinutes: 0, ...over });
const projectRec = (id: string, stable: string, extra: Record<string, unknown> = {}, entries: unknown[] = [], total = 100) =>
  rec('project', id, { id, projectId: stable, nameEn: `Project ${stable}`, inputs: { totalCases: total, dailyExecuted: entries }, ...extra });

async function addTester(t: Tenant, label = 'tester', displayName?: string): Promise<{ email: string; user: UserDto }> {
  const mail = rk(label);
  const r = await post<{ user: UserDto }>(t.adminEmail, '/api/tenant/users', { email: mail, ...(displayName === undefined ? {} : { displayName }) });
  if (r.status !== 201) throw new Error(`addTester failed ${r.status} ${r.text}`);
  return { email: mail, user: r.json.user };
}

async function addSv(t: Tenant, label = 'sv'): Promise<{ email: string; user: UserDto }> {
  const mail = rk(label);
  const r = await post<{ user: UserDto }>(t.adminEmail, '/api/tenant/users', { email: mail, role: 'sv' });
  if (r.status !== 201) throw new Error(`addSv failed ${r.status} ${r.text}`);
  return { email: mail, user: r.json.user };
}

async function joined(as: string): Promise<{ sock: TestSocket; revision: number }> {
  const o = await openSocket(as);
  if (!o.ok) throw new Error(`socket refused: ${o.status}`);
  const snap = await o.sock.next('snapshot');
  return { sock: o.sock, revision: snap.revision };
}

let commitSeq = 0;
async function commit(c: { sock: TestSocket; revision: number }, puts: Array<{ kind: string; id: string; json: string }>, deletes: Array<{ kind: string; id: string }> = []) {
  commitSeq += 1;
  c.sock.send({ t: 'commit', id: `s8a-${commitSeq}-${crypto.randomUUID()}`, baseRevision: c.revision, puts, deletes } as never);
  // One waiter at a time: a second, still-polling waiter would swallow the next commit's answer.
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

/** A web workspace with a project, an Admin and an editor + a read-only Tester. */
async function workspace(name: string) {
  const t = await createTenant(name, rk('admin'));
  await activateWeb(t, [projectRec('proj-1', 'PRJ-001', {}, [], 100), rec('project', 'proj-secret', { id: 'proj-secret', projectId: 'PRJ-002', nameEn: SECRET_A, inputs: { totalCases: 10 } })]);
  const editor = await addTester(t, 'editor', 'Eri Editor');
  const viewer = await post<{ user: UserDto }>(t.adminEmail, '/api/tenant/users', { email: rk('viewer'), access: 'viewer' });
  return { t, editor, viewer: { email: viewer.json.user.email, user: viewer.json.user } };
}

describe('cycles: shared, Admin-administered, tenant-bound', () => {
  it('the Admin creates a cycle and puts a project in it; everyone in the workspace sees it live; other workspaces never do', async () => {
    const a = await workspace('Alpha');
    const b = await workspace('Beta');
    const admin = await joined(a.t.adminEmail);
    const editor = await joined(a.editor.email);
    const other = await joined(b.t.adminEmail);
    const c = cycle();

    const made = await commit(admin, [{ kind: 'cycle', id: c.id, json: JSON.stringify(c) }]);
    expect(made.ok).toBe(true);
    const seen = await editor.sock.next('changes');
    expect(seen.puts.map((p) => p.kind)).toContain('cycle');
    await other.sock.expectNone('changes', 300); // another workspace hears nothing

    const attach = await commit(admin, [projectRec('proj-1', 'PRJ-001', { cycleId: c.id }, [], 100)]);
    expect(attach.ok).toBe(true);

    const mine = await get(a.t.adminEmail, '/api/export');
    expect(mine.text).toContain(c.id);
    expect((await get(b.t.adminEmail, '/api/export')).text).not.toContain(c.id);
    expect((await get(b.editor.email, '/api/export')).text).not.toContain(c.name);
  });

  it('only the Admin administers cycles: an editing Tester and a read-only Tester are refused, and nothing changes', async () => {
    const a = await workspace('Alpha');
    const editor = await joined(a.editor.email);
    const viewer = await joined(a.viewer.email);
    const c = cycle();
    const refused = await commit(editor, [{ kind: 'cycle', id: c.id, json: JSON.stringify(c) }]);
    expect(refused).toMatchObject({ ok: false, reject: { reason: 'invalid', message: 'tester_cannot_change_kind' } });
    const readOnly = await commit(viewer, [{ kind: 'cycle', id: c.id, json: JSON.stringify(c) }]);
    expect(readOnly.ok).toBe(false);
    expect((await get(a.t.adminEmail, '/api/export')).text).not.toContain(c.id);
  });

  it('a project can only name a cycle of its OWN workspace; a foreign or unknown id is refused', async () => {
    const a = await workspace('Alpha');
    const b = await workspace('Beta');
    const adminA = await joined(a.t.adminEmail);
    const adminB = await joined(b.t.adminEmail);
    const foreign = cycle();
    expect((await commit(adminB, [{ kind: 'cycle', id: foreign.id, json: JSON.stringify(foreign) }])).ok).toBe(true);
    const r = await commit(adminA, [projectRec('proj-1', 'PRJ-001', { cycleId: foreign.id })]);
    expect(r).toMatchObject({ ok: false, reject: { reason: 'invalid', message: 'project_cycle_not_found' } });
    expect((await get(a.t.adminEmail, '/api/export')).text).not.toContain(foreign.id);
  });

  it('an editing Tester cannot move a project between cycles, but can still record today’s execution on a project they are assigned to', async () => {
    const a = await workspace('Alpha');
    const admin = await joined(a.t.adminEmail);
    const editor = await joined(a.editor.email);
    const c1 = cycle();
    const c2 = cycle({ name: 'iOS 11.3 Regression Cycle' });
    await commit(admin, [{ kind: 'cycle', id: c1.id, json: JSON.stringify(c1) }, { kind: 'cycle', id: c2.id, json: JSON.stringify(c2) }]);
    await commit(admin, [projectRec('proj-1', 'PRJ-001', { cycleId: c1.id })]);
    await editor.sock.next('changes');
    await editor.sock.next('changes');
    editor.revision = (await get<{ revision: number }>(a.t.adminEmail, '/api/export')).json.revision;

    expect(await commit(editor, [projectRec('proj-1', 'PRJ-001', { cycleId: c2.id })])).toMatchObject({ ok: false, reject: { message: 'tester_project_structure' } });
    expect(await commit(editor, [projectRec('proj-1', 'PRJ-001', { cycleId: null })])).toMatchObject({ ok: false, reject: { message: 'tester_project_structure' } });
    // Not assigned yet: even today's entry is refused.
    expect(await commit(editor, [projectRec('proj-1', 'PRJ-001', { cycleId: c1.id }, [entry({ date: today() })])])).toMatchObject({ ok: false, reject: { message: 'tester_execution_not_assigned' } });
    expect((await post(a.t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: a.editor.user.id })).status).toBe(201);
    editor.revision = (await get<{ revision: number }>(a.t.adminEmail, '/api/export')).json.revision;
    // Assigned: today's entry works, the cycle stays as it was.
    expect((await commit(editor, [projectRec('proj-1', 'PRJ-001', { cycleId: c1.id }, [entry({ date: today() })])])).ok).toBe(true);
  });

  it('a project without a cycle (everything created before cycles) stays valid and editable', async () => {
    const a = await workspace('Alpha');
    const editor = await joined(a.t.adminEmail);
    expect((await commit(editor, [projectRec('proj-1', 'PRJ-001', {}, [entry()])])).ok).toBe(true);
  });
});

describe('execution results: impossible values are refused by the server', () => {
  it('refuses negative, fractional and impossible-date entries from any client, and stores nothing', async () => {
    const a = await workspace('Alpha');
    const editor = await joined(a.t.adminEmail);
    const before = (await get<{ revision: number }>(a.t.adminEmail, '/api/export')).json.revision;
    for (const [over, message] of [
      [{ pass: -1 }, 'execution_entry_invalid_pass'],
      [{ fail: 2.5 }, 'execution_entry_invalid_fail'],
      [{ blocked: -3 }, 'execution_entry_invalid_blocked'],
      [{ date: '2026-02-30' }, 'execution_entry_invalid_date'],
      [{ date: 'yesterday' }, 'execution_entry_invalid_date'],
    ] as const) {
      const r = await commit(editor, [projectRec('proj-1', 'PRJ-001', {}, [entry(over)])]);
      expect(r, JSON.stringify(over)).toMatchObject({ ok: false, reject: { reason: 'invalid', message } });
    }
    expect((await get<{ revision: number }>(a.t.adminEmail, '/api/export')).json.revision).toBe(before);
  });

  it('refuses pushing completed cases above the planned total, allows exactly the total, and allows lowering the total afterwards', async () => {
    const a = await workspace('Alpha');
    const editor = await joined(a.t.adminEmail);
    expect((await commit(editor, [projectRec('proj-1', 'PRJ-001', {}, [entry({ id: 'd1', pass: 60, fail: 20 })], 100)])).ok).toBe(true);
    expect(await commit(editor, [projectRec('proj-1', 'PRJ-001', {}, [entry({ id: 'd1', pass: 60, fail: 20 }), entry({ id: 'd2', date: '2026-10-06', pass: 21, fail: 0 })], 100)])).toMatchObject({ ok: false, reject: { message: 'executed_exceeds_planned' } });
    expect((await commit(editor, [projectRec('proj-1', 'PRJ-001', {}, [entry({ id: 'd1', pass: 60, fail: 20 }), entry({ id: 'd2', date: '2026-10-06', pass: 20, fail: 0 })], 100)])).ok).toBe(true);
    // The Admin lowers the plan below what was done: history is kept, nothing is rewritten.
    const admin = await joined(a.t.adminEmail);
    expect((await commit(admin, [projectRec('proj-1', 'PRJ-001', {}, [entry({ id: 'd1', pass: 60, fail: 20 }), entry({ id: 'd2', date: '2026-10-06', pass: 20, fail: 0 })], 50)])).ok).toBe(true);
  });

  it('refuses a second entry for the same day', async () => {
    const a = await workspace('Alpha');
    const editor = await joined(a.t.adminEmail);
    expect((await commit(editor, [projectRec('proj-1', 'PRJ-001', {}, [entry({ id: 'x1' })])])).ok).toBe(true);
    expect(await commit(editor, [projectRec('proj-1', 'PRJ-001', {}, [entry({ id: 'x1' }), entry({ id: 'x2' })])])).toMatchObject({ ok: false, reject: { message: 'execution_entry_duplicate_date' } });
  });

  it('a read-only Tester cannot record results at all', async () => {
    const a = await workspace('Alpha');
    const viewer = await joined(a.viewer.email);
    const r = await commit(viewer, [projectRec('proj-1', 'PRJ-001', {}, [entry()])]);
    expect(r).toMatchObject({ ok: false, reject: { reason: 'forbidden' } });
  });
});

describe('Tester assignment (accounts, server-checked)', () => {
  it('the Admin assigns a Tester of the workspace; connected people see it live; repeating it changes nothing', async () => {
    const a = await workspace('Alpha');
    const editor = await joined(a.editor.email);
    const r = await post<{ ok: true; assignment: { id: string; projectId: string; userId: string }; created: boolean }>(a.t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: a.editor.user.id });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ created: true, assignment: { projectId: 'PRJ-001', userId: a.editor.user.id } });
    const live = await editor.sock.next('changes');
    const put = live.puts.find((p) => p.kind === 'assignment')!;
    expect(JSON.parse(put.json)).toMatchObject({ projectId: 'PRJ-001', userId: a.editor.user.id, testerName: 'Eri Editor', active: true });

    const again = await post<{ created: boolean; assignment: { id: string } }>(a.t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: a.editor.user.id });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ created: false, assignment: { id: r.json.assignment.id } });
    const all = (await get<{ records: Array<{ kind: string }> }>(a.t.adminEmail, '/api/export')).json.records.filter((x) => x.kind === 'assignment');
    expect(all).toHaveLength(1);
  });

  it('several Testers can be on one project', async () => {
    const a = await workspace('Alpha');
    const second = await addTester(a.t, 'second', 'Sam Second');
    for (const u of [a.editor.user, second.user]) expect((await post(a.t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: u.id })).status).toBe(201);
    const records = (await get<{ records: Array<{ kind: string; json: string }> }>(a.t.adminEmail, '/api/export')).json.records.filter((x) => x.kind === 'assignment');
    expect(records.map((x) => JSON.parse(x.json).userId).sort()).toEqual([a.editor.user.id, second.user.id].sort());
  });

  it('refuses a Tester of ANOTHER workspace, a made-up id, the Admin, and a project that is not in this workspace', async () => {
    const a = await workspace('Alpha');
    const b = await workspace('Beta');
    const adminUser = (await get<{ users: UserDto[] }>(a.t.adminEmail, '/api/tenant/users')).json.users.find((u) => u.role === 'admin')!;
    const before = (await get<{ records: unknown[] }>(a.t.adminEmail, '/api/export')).json.records.length;
    for (const [body, status, error] of [
      [{ projectId: 'PRJ-001', userId: b.editor.user.id }, 404, 'tester_not_found'],
      [{ projectId: 'PRJ-001', userId: `usr_${crypto.randomUUID()}` }, 404, 'tester_not_found'],
      [{ projectId: 'PRJ-001', userId: adminUser.id }, 404, 'tester_not_found'],
      [{ projectId: 'PRJ-999', userId: a.editor.user.id }, 404, 'project_not_found'],
      [{ projectId: 'PRJ-001', userId: 'not-an-id' }, 400, 'invalid_user_id'],
      [{ userId: a.editor.user.id }, 400, 'invalid_project_id'],
    ] as const) {
      const r = await post(a.t.adminEmail, '/api/tenant/assignments', body);
      expect([r.status, r.json.error], JSON.stringify(body)).toEqual([status, error]);
    }
    expect((await get<{ records: unknown[] }>(a.t.adminEmail, '/api/export')).json.records.length).toBe(before);
  });

  it('a project that exists only in another workspace cannot be named, even with the right Tester', async () => {
    const a = await workspace('Alpha');
    const b = await workspace('Beta');
    const adminB = await joined(b.t.adminEmail);
    await commit(adminB, [projectRec('proj-b', 'PRJ-777')]);
    const r = await post(a.t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-777', userId: a.editor.user.id });
    expect([r.status, r.json.error]).toEqual([404, 'project_not_found']);
  });

  it('a forged tenant id cannot redirect the assignment', async () => {
    const a = await workspace('Alpha');
    const b = await workspace('Beta');
    const r = await post(a.t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: b.editor.user.id, tenantId: b.t.id });
    expect(r.status).toBe(403);
    expect((await call(a.t.adminEmail, 'POST', `/api/tenant/assignments?tenantId=${b.t.id}`, { projectId: 'PRJ-001', userId: a.editor.user.id })).status).toBe(403);
  });

  it('a disabled Tester cannot be newly assigned; the history of earlier assignments stays; reactivation allows it again', async () => {
    const a = await workspace('Alpha');
    const second = await addTester(a.t, 'leaver', 'Lee Leaver');
    expect((await post(a.t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: second.user.id })).status).toBe(201);
    await patch(a.t.adminEmail, `/api/tenant/users/${second.user.id}`, { status: 'disabled' });

    const refused = await post(a.t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-002', userId: second.user.id });
    expect([refused.status, refused.json.error]).toEqual([409, 'tester_disabled']);
    const kept = (await get<{ records: Array<{ kind: string; json: string }> }>(a.t.adminEmail, '/api/export')).json.records.filter((x) => x.kind === 'assignment');
    expect(kept.map((x) => JSON.parse(x.json))).toEqual([expect.objectContaining({ userId: second.user.id, testerName: 'Lee Leaver', active: true })]);

    await patch(a.t.adminEmail, `/api/tenant/users/${second.user.id}`, { status: 'enabled' });
    expect((await post(a.t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-002', userId: second.user.id })).status).toBe(201);
  });

  it('only a Web-mode Admin may assign; Testers, a Local-mode Admin and the Super Admin may not', async () => {
    const a = await workspace('Alpha');
    for (const who of [a.editor.email, a.viewer.email, SUPER]) expect((await post(who, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: a.editor.user.id })).status, who).toBe(403);
    const local = await createTenant('Local one', rk('localadmin'));
    expect((await post(local.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: `usr_${crypto.randomUUID()}` })).status).toBe(403);
  });

  it('cannot be created through the sync channel, by anyone', async () => {
    const a = await workspace('Alpha');
    const admin = await joined(a.t.adminEmail);
    const editor = await joined(a.editor.email);
    const forged = JSON.stringify({ id: crypto.randomUUID(), projectId: 'PRJ-001', userId: a.editor.user.id, testerName: 'x', startDate: '2026-10-01', active: true });
    const id = crypto.randomUUID();
    expect(await commit(admin, [{ kind: 'assignment', id, json: forged }])).toMatchObject({ ok: false, reject: { message: 'assignment_requires_api' } });
    expect(await commit(editor, [{ kind: 'assignment', id, json: forged }])).toMatchObject({ ok: false, reject: { message: 'tester_cannot_change_kind' } });
  });

  it('afterwards only the Admin can end or remove it, and it keeps its account and project', async () => {
    const a = await workspace('Alpha');
    const made = await post<{ assignment: { id: string } }>(a.t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: a.editor.user.id });
    const id = made.json.assignment.id;
    const admin = await joined(a.t.adminEmail);
    const editor = await joined(a.editor.email);
    const ended = JSON.stringify({ id, projectId: 'PRJ-001', userId: a.editor.user.id, testerName: 'Eri Editor', startDate: '2026-10-01', endDate: '2026-10-09', active: false });
    expect(await commit(editor, [{ kind: 'assignment', id, json: ended }])).toMatchObject({ ok: false, reject: { message: 'tester_cannot_change_kind' } });
    expect(await commit(admin, [{ kind: 'assignment', id, json: ended.replace(a.editor.user.id, `usr_${crypto.randomUUID()}`) }])).toMatchObject({ ok: false, reject: { message: 'assignment_immutable_fields' } });
    expect((await commit(admin, [{ kind: 'assignment', id, json: ended }])).ok).toBe(true);
  });
});

describe('the Tester roster belongs to the SVs', () => {
  it('lists only this workspace’s Testers, to an SV; a Tester gets no roster at all', async () => {
    const a = await workspace('Alpha');
    const b = await workspace('Beta');
    const sv = await addSv(a.t);
    for (const who of [a.t.adminEmail, sv.email]) {
      const r = await get<{ testers: TesterDto[] }>(who, '/api/tenant/team');
      expect(r.status, who).toBe(200);
      const emails = r.json.testers.map((x) => x.email);
      expect(emails).toEqual(expect.arrayContaining([a.editor.email, a.viewer.email]));
      expect(emails).not.toContain(b.editor.email);
      expect(emails).not.toContain(a.t.adminEmail); // never an SV
      expect(emails).not.toContain(sv.email);
      expect(r.json.testers.find((x) => x.email === a.editor.email)).toMatchObject({ displayName: 'Eri Editor', status: 'active' });
      expect(Object.keys(r.json.testers[0]).sort()).toEqual(['displayName', 'email', 'id', 'status']);
    }
    for (const who of [a.editor.email, a.viewer.email]) expect((await get(who, '/api/tenant/team')).status, who).toBe(403);
  });

  it('shows a disabled Tester as disabled (history stays attributable), and refuses the Super Admin, strangers and forged tenants', async () => {
    const a = await workspace('Alpha');
    const b = await workspace('Beta');
    await patch(a.t.adminEmail, `/api/tenant/users/${a.editor.user.id}`, { status: 'disabled' });
    expect((await get<{ testers: TesterDto[] }>(a.t.adminEmail, '/api/tenant/team')).json.testers.find((x) => x.id === a.editor.user.id)?.status).toBe('disabled');
    expect((await get(SUPER, '/api/tenant/team')).status).toBe(403);
    expect((await get(email('stranger'), '/api/tenant/team')).status).toBe(403);
    expect((await call(a.t.adminEmail, 'GET', `/api/tenant/team?tenantId=${b.t.id}`)).status).toBe(403);
    expect((await whoami(a.editor.email)).status).toBe(403); // a disabled Tester is out
  });
});

describe('conflicts and live sync', () => {
  it('two people recording the same project at once: the second is told about the conflict, nothing is overwritten', async () => {
    const a = await workspace('Alpha');
    const second = await addSv(a.t, 'second');
    const one = await joined(a.t.adminEmail);
    const two = await joined(second.email);
    const sameBase = one.revision;
    expect((await commit(one, [projectRec('proj-1', 'PRJ-001', {}, [entry({ id: 'm1', pass: 10, fail: 0 })])])).ok).toBe(true);
    two.revision = sameBase; // two never saw the first commit
    const lost = await commit(two, [projectRec('proj-1', 'PRJ-001', {}, [entry({ id: 'm2', pass: 99, fail: 0 })])]);
    expect(lost).toMatchObject({ ok: false, reject: { reason: 'conflict' } });
    const stored = JSON.parse((await get<{ records: Array<{ kind: string; id: string; json: string }> }>(a.t.adminEmail, '/api/export')).json.records.find((r) => r.kind === 'project' && r.id === 'proj-1')!.json);
    expect(stored.inputs.dailyExecuted.map((e: { id: string }) => e.id)).toEqual(['m1']);
  });

  it('assigning a Tester while another person edits the project does not conflict (different records)', async () => {
    const a = await workspace('Alpha');
    const editor = await joined(a.t.adminEmail);
    const base = editor.revision;
    expect((await post(a.t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: a.editor.user.id })).status).toBe(201);
    editor.revision = base; // this SV has not seen the assignment yet
    const r = await commit(editor, [projectRec('proj-1', 'PRJ-001', {}, [entry()])]);
    expect(r.ok).toBe(true);
  });

  it('moving a project to a cycle while someone else updates it: the later writer is told, and the cycle assignment survives', async () => {
    const a = await workspace('Alpha');
    const admin = await joined(a.t.adminEmail);
    const editor = await joined(a.editor.email);
    const c = cycle();
    expect((await commit(admin, [{ kind: 'cycle', id: c.id, json: JSON.stringify(c) }])).ok).toBe(true);
    const base = admin.revision;
    expect((await commit(admin, [projectRec('proj-1', 'PRJ-001', { cycleId: c.id })])).ok).toBe(true);
    editor.revision = base;
    const late = await commit(editor, [projectRec('proj-1', 'PRJ-001', {}, [entry()])]);
    expect(late).toMatchObject({ ok: false, reject: { reason: 'conflict' } });
    const stored = JSON.parse((await get<{ records: Array<{ kind: string; id: string; json: string }> }>(a.t.adminEmail, '/api/export')).json.records.find((r) => r.kind === 'project' && r.id === 'proj-1')!.json);
    expect(stored.cycleId).toBe(c.id);
  });

  it('a client that reconnects behind receives the cycle and assignment changes it missed', async () => {
    const a = await workspace('Alpha');
    const admin = await joined(a.t.adminEmail);
    const behind = await joined(a.editor.email);
    const known = behind.revision;
    behind.sock.close();
    const c = cycle();
    await commit(admin, [{ kind: 'cycle', id: c.id, json: JSON.stringify(c) }]);
    await post(a.t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: a.editor.user.id });
    const again = await openSocket(a.editor.email);
    if (!again.ok) throw new Error('reconnect');
    again.sock.send({ t: 'hello', v: 1, clientId: `c-${crypto.randomUUID()}`, lastRevision: known } as never);
    const changes = await again.sock.next('changes');
    expect(changes.puts.map((p) => p.kind).sort()).toEqual(['assignment', 'cycle']);
  });
});

describe('the Super Admin never sees QA data', () => {
  it('has no route to cycles, results or assignments; the platform views carry none', async () => {
    const a = await workspace('Alpha');
    const admin = await joined(a.t.adminEmail);
    const c = cycle({ name: 'CONFIDENTIAL-CYCLE-NAME' });
    await commit(admin, [{ kind: 'cycle', id: c.id, json: JSON.stringify(c) }, projectRec('proj-1', 'PRJ-001', { cycleId: c.id }, [entry()])]);
    for (const path of ['/api/export', '/api/revisions', '/api/revisions/1', '/api/stats', '/api/tenant/team', '/api/tenant/assignments']) {
      expect((await get(SUPER, path)).status, path).toBe(403);
    }
    const list = await get(SUPER, '/api/super/tenants');
    const audit = await get(SUPER, '/api/super/admin-audit');
    for (const r of [list, audit]) {
      expect(r.text).not.toContain('CONFIDENTIAL-CYCLE-NAME');
      expect(r.text).not.toContain(c.id);
      expect(r.text).not.toContain(SECRET_A);
    }
    const sock = await openSocket(SUPER);
    expect(sock.ok).toBe(false);
  });
});
