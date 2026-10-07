import { describe, expect, it } from 'vitest';
import type { UserDto } from '../../../shared/tenancy';
import { caseResultId } from '../../../shared/testManagement';
import { SUPER, activateWeb, call, createTenant, get, openSocket, patch, post, rec, type Tenant } from './tenancy-harness';
import type { TestSocket } from './helpers';

/**
 * Stage 8C through the real Worker and Durable Objects: scopes, test cases, scope assignments, case results, conflicts, tenant
 * isolation. Nothing is mocked.
 */

const NOW = '2026-10-07T09:00:00.000Z';
let seq = 0;
const rk = (label: string): string => `${label}-${++seq}-${crypto.randomUUID().slice(0, 6)}@rakuten.com`;
const J = JSON.stringify;

const project = (stable = 'PRJ-001', id = 'proj-1') => rec('project', id, { id, projectId: stable, nameEn: `Project ${stable}`, nameJa: '', team: 'RCS', status: 'ongoing', inputs: { totalCases: 100, dailyExecuted: [], bugTickets: [], testerDailyPerformance: [] } });
const scope = (over: Record<string, unknown> = {}) => ({ id: 'scp_eco', projectId: 'PRJ-001', name: 'Ecosystem', code: 'ECO', status: 'active', order: 10, createdAt: NOW, updatedAt: NOW, ...over });
const tcase = (n: number, over: Record<string, unknown> = {}) => ({ id: `tc_eco${n}`, projectId: 'PRJ-001', scopeId: 'scp_eco', key: `ECO-${String(n).padStart(3, '0')}`, title: `Case ${n}`, priority: 'medium', status: 'active', order: n * 10, createdAt: NOW, updatedAt: NOW, ...over });
const result = (caseId: string, userId: string, over: Record<string, unknown> = {}) => ({ id: caseResultId(caseId), projectId: 'PRJ-001', scopeId: 'scp_eco', testCaseId: caseId, status: 'pass', retest: false, question: false, executedByUserId: userId, executedAt: NOW, updatedByUserId: userId, updatedAt: NOW, ...over });
const put = (kind: string, id: string, value: unknown) => ({ kind, id, json: J(value) });

interface Person {
  email: string;
  user: UserDto;
}

async function addTester(t: Tenant, label: string): Promise<Person> {
  const email = rk(label);
  const r = await post<{ user: UserDto }>(t.adminEmail, '/api/tenant/users', { email, role: 'tester', displayName: label });
  if (r.status !== 201) throw new Error(`addTester ${r.status} ${r.text}`);
  return { email, user: r.json.user };
}

async function head(as: string): Promise<number> {
  return (await get<{ revision: number }>(as, '/api/export')).json.revision;
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
  c.sock.send({ t: 'commit', id: `s8c-${commitSeq}-${crypto.randomUUID()}`, baseRevision: c.revision, puts, deletes } as never);
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
  // Two scopes with a few cases each, created the way the SV screen does (one commit).
  const setup = await commit(sv, [
    put('scope', 'scp_eco', scope()),
    put('scope', 'scp_htma', scope({ id: 'scp_htma', name: 'HTMA', code: 'HTMA', order: 20 })),
    put('testCase', 'tc_eco1', tcase(1)),
    put('testCase', 'tc_eco2', tcase(2)),
    put('testCase', 'tc_htma1', tcase(1, { id: 'tc_htma1', scopeId: 'scp_htma', key: 'HTMA-001', title: 'HTMA case' })),
  ]);
  if (!setup.ok) throw new Error(`setup refused: ${JSON.stringify(setup.reject)}`);
  const hana = await addTester(t, 'hana');
  const ken = await addTester(t, 'ken');
  expect((await post(t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: hana.user.id, scopeId: 'scp_eco' })).status).toBe(201);
  expect((await post(t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: ken.user.id, scopeId: 'scp_htma' })).status).toBe(201);
  return { t, sv, hana, ken };
}

const sync = async (c: { revision: number }, as: string): Promise<void> => {
  c.revision = await head(as);
};

describe('scope assignments through the API', () => {
  it('assigns a Tester to a scope of the project; repeating it changes nothing; the same Tester can also be assigned to another scope', async () => {
    const w = await workspace('Alpha');
    const again = await post<{ created: boolean }>(w.t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: w.hana.user.id, scopeId: 'scp_eco' });
    expect([again.status, again.json.created]).toEqual([200, false]);
    const second = await post<{ created: boolean; assignment: { scopeId?: string } }>(w.t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: w.hana.user.id, scopeId: 'scp_htma' });
    expect([second.status, second.json.created, second.json.assignment.scopeId]).toEqual([201, true, 'scp_htma']);
    const projectLevel = await post<{ created: boolean }>(w.t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: w.hana.user.id });
    expect([projectLevel.status, projectLevel.json.created]).toEqual([201, true]); // a different assignment: the whole project
  });

  it('refuses an unknown scope, a scope of another project, an archived scope and a malformed scope id', async () => {
    const w = await workspace('Alpha');
    for (const [scopeId, status, error] of [['scp_nope', 404, 'scope_not_found'], ['bad id!', 400, 'invalid_scope_id']] as const) {
      const r = await post(w.t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: w.hana.user.id, scopeId });
      expect([r.status, r.json.error], scopeId).toEqual([status, error]);
    }
    // a scope that belongs to ANOTHER project of the same workspace
    expect((await commit(w.sv, [project('PRJ-002', 'proj-2'), put('scope', 'scp_other', scope({ id: 'scp_other', projectId: 'PRJ-002', code: 'OTH' }))])).ok).toBe(true);
    const wrongProject = await post(w.t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: w.hana.user.id, scopeId: 'scp_other' });
    expect([wrongProject.status, wrongProject.json.error]).toEqual([404, 'scope_not_found']);
    await sync(w.sv, w.t.adminEmail);
    expect((await commit(w.sv, [put('scope', 'scp_htma', scope({ id: 'scp_htma', name: 'HTMA', code: 'HTMA', order: 20, status: 'archived' }))])).ok).toBe(true);
    const archived = await post(w.t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: w.hana.user.id, scopeId: 'scp_htma' });
    expect([archived.status, archived.json.error]).toEqual([409, 'scope_archived']);
  });

  it('keeps every Stage 8A rule: a disabled Tester, a foreign Tester, an SV and a Tester caller are all refused', async () => {
    const w = await workspace('Alpha');
    const other = await workspace('Beta');
    const gone = await addTester(w.t, 'gone');
    await patch(w.t.adminEmail, `/api/tenant/users/${gone.user.id}`, { status: 'disabled' });
    const body = (userId: string) => ({ projectId: 'PRJ-001', userId, scopeId: 'scp_eco' });
    expect((await post(w.t.adminEmail, '/api/tenant/assignments', body(gone.user.id))).json.error).toBe('tester_disabled');
    expect((await post(w.t.adminEmail, '/api/tenant/assignments', body(other.hana.user.id))).json.error).toBe('tester_not_found');
    expect((await post(w.hana.email, '/api/tenant/assignments', body(w.ken.user.id))).status).toBe(403);
    // the tenant is the caller's, never the body's
    expect((await post(w.t.adminEmail, '/api/tenant/assignments', { ...body(w.ken.user.id), tenantId: other.t.id })).status).toBe(403);
    // a scope that exists only in ANOTHER workspace is not a scope here
    expect((await commit(other.sv, [put('scope', 'scp_beta_only', scope({ id: 'scp_beta_only', code: 'BETA' }))])).ok).toBe(true);
    expect((await post(w.t.adminEmail, '/api/tenant/assignments', body(w.ken.user.id))).status).toBe(201);
    expect((await post(w.t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: w.ken.user.id, scopeId: 'scp_beta_only' })).json.error).toBe('scope_not_found');
  });
});

describe('a Tester working on an assigned scope', () => {
  it('records Pass / Fail / Blocked with flags, memo and device, on cases of the scope they are assigned to', async () => {
    const w = await workspace('Alpha');
    const hana = await joined(w.hana.email);
    expect(hana.records.filter((r) => ['scope', 'testCase'].includes(r.kind))).toHaveLength(5); // definitions are readable (like Overall); WRITING is what is scoped
    const r1 = await commit(hana, [put('caseResult', caseResultId('tc_eco1'), result('tc_eco1', w.hana.user.id))]);
    expect(r1.ok).toBe(true);
    const r2 = await commit(hana, [put('caseResult', caseResultId('tc_eco2'), result('tc_eco2', w.hana.user.id, { status: 'fail', retest: true, question: true, memo: 'crash on rotate', device: 'Galaxy S23', os: 'Android 15' }))]);
    expect(r2.ok).toBe(true);
    const r3 = await commit(hana, [put('caseResult', caseResultId('tc_eco2'), result('tc_eco2', w.hana.user.id, { status: 'blocked', retest: true, question: true, memo: 'crash on rotate', device: 'Galaxy S23', os: 'Android 15', executedAt: '2026-10-07T10:00:00.000Z', updatedAt: '2026-10-07T10:00:00.000Z' }))]);
    expect(r3.ok).toBe(true);
    const stored = (await get<{ records: Array<{ kind: string; id: string; json: string }> }>(w.t.adminEmail, '/api/export')).json.records.filter((r) => r.kind === 'caseResult');
    expect(stored).toHaveLength(2);
    expect(JSON.parse(stored.find((r) => r.id === caseResultId('tc_eco2'))!.json)).toMatchObject({ status: 'blocked', memo: 'crash on rotate', device: 'Galaxy S23', os: 'Android 15' });
  });

  it('is refused on an unassigned scope, with nothing stored', async () => {
    const w = await workspace('Alpha');
    const hana = await joined(w.hana.email);
    const bad = await commit(hana, [put('caseResult', caseResultId('tc_htma1'), result('tc_htma1', w.hana.user.id, { scopeId: 'scp_htma' }))]);
    expect(bad).toMatchObject({ ok: false, reject: { reason: 'invalid', message: 'tester_result_not_assigned' } });
    expect((await get<{ records: Array<{ kind: string }> }>(w.t.adminEmail, '/api/export')).json.records.filter((r) => r.kind === 'caseResult')).toHaveLength(0);
  });

  it('cannot create, edit or archive scopes and cases, change assignments, or record as another person', async () => {
    const w = await workspace('Alpha');
    const hana = await joined(w.hana.email);
    for (const [label, puts] of [
      ['new scope', [put('scope', 'scp_x', scope({ id: 'scp_x', code: 'X' }))]],
      ['edit scope', [put('scope', 'scp_eco', scope({ name: 'Hijacked' }))]],
      ['new case', [put('testCase', 'tc_x', tcase(9, { id: 'tc_x' }))]],
      ['archive case', [put('testCase', 'tc_eco1', tcase(1, { status: 'archived' }))]],
      ['assignment', [put('assignment', 'a_x', { id: 'a_x', projectId: 'PRJ-001', userId: w.hana.user.id, startDate: '2026-10-01', active: true })]],
    ] as const) {
      expect(await commit(hana, [...puts]), label).toMatchObject({ ok: false, reject: { reason: 'invalid', message: 'tester_cannot_change_kind' } });
    }
    expect(await commit(hana, [], [{ kind: 'testCase', id: 'tc_eco1' }])).toMatchObject({ ok: false, reject: { message: 'tester_cannot_delete' } });
    const forged = await commit(hana, [put('caseResult', caseResultId('tc_eco1'), result('tc_eco1', w.ken.user.id))]);
    expect(forged).toMatchObject({ ok: false, reject: { message: 'result_actor_mismatch' } });
  });

  it('is stopped when the SV archives the scope, or ends the assignment, while the Tester still has unsent work', async () => {
    const w = await workspace('Alpha');
    const hana = await joined(w.hana.email);
    expect((await commit(hana, [put('caseResult', caseResultId('tc_eco1'), result('tc_eco1', w.hana.user.id))])).ok).toBe(true);

    // The SV archives the scope. Hana, who has not seen it yet, tries to record the next case.
    await sync(w.sv, w.t.adminEmail);
    expect((await commit(w.sv, [put('scope', 'scp_eco', scope({ status: 'archived' }))])).ok).toBe(true);
    const archivedWrite = await commit(hana, [put('caseResult', caseResultId('tc_eco2'), result('tc_eco2', w.hana.user.id))]);
    expect(archivedWrite).toMatchObject({ ok: false, reject: { message: 'result_scope_archived' } });

    // Reactivated, but the assignment ends: refused for that reason instead.
    await sync(w.sv, w.t.adminEmail);
    expect((await commit(w.sv, [put('scope', 'scp_eco', scope())])).ok).toBe(true);
    const stored = (await get<{ records: Array<{ kind: string; id: string; json: string }> }>(w.t.adminEmail, '/api/export')).json.records.find((r) => r.kind === 'assignment' && JSON.parse(r.json).userId === w.hana.user.id)!;
    await sync(w.sv, w.t.adminEmail);
    expect((await commit(w.sv, [put('assignment', stored.id, { ...JSON.parse(stored.json), active: false, endDate: '2026-10-07' })])).ok).toBe(true);
    const ended = await commit(hana, [put('caseResult', caseResultId('tc_eco2'), result('tc_eco2', w.hana.user.id))]);
    expect(ended).toMatchObject({ ok: false, reject: { message: 'tester_result_not_assigned' } });
  });

  it('a disabled Tester loses the connection and cannot come back; the result they recorded stays attributed', async () => {
    const w = await workspace('Alpha');
    const hana = await joined(w.hana.email);
    expect((await commit(hana, [put('caseResult', caseResultId('tc_eco1'), result('tc_eco1', w.hana.user.id))])).ok).toBe(true);
    await patch(w.t.adminEmail, `/api/tenant/users/${w.hana.user.id}`, { status: 'disabled' });
    expect((await openSocket(w.hana.email)).ok).toBe(false);
    const kept = (await get<{ records: Array<{ kind: string; json: string }> }>(w.t.adminEmail, '/api/export')).json.records.find((r) => r.kind === 'caseResult')!;
    expect(JSON.parse(kept.json)).toMatchObject({ updatedByUserId: w.hana.user.id });
    await patch(w.t.adminEmail, `/api/tenant/users/${w.hana.user.id}`, { status: 'enabled' });
    expect((await openSocket(w.hana.email)).ok).toBe(true); // reactivation restores the same account
  });
});

describe('concurrency', () => {
  it('two Testers on different cases both succeed, even from the same base revision', async () => {
    const w = await workspace('Alpha');
    const a = await addTester(w.t, 'a2');
    expect((await post(w.t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: a.user.id, scopeId: 'scp_eco' })).status).toBe(201);
    const hana = await joined(w.hana.email);
    const other = await joined(a.email);
    expect((await commit(hana, [put('caseResult', caseResultId('tc_eco1'), result('tc_eco1', w.hana.user.id))])).ok).toBe(true);
    const second = await commit(other, [put('caseResult', caseResultId('tc_eco2'), result('tc_eco2', a.user.id))]); // never saw Hana's commit
    expect(second.ok).toBe(true);
  });

  it('two people changing the SAME case: the second is told, nothing is silently overwritten', async () => {
    const w = await workspace('Alpha');
    const hana = await joined(w.hana.email);
    const base = hana.revision;
    expect((await commit(hana, [put('caseResult', caseResultId('tc_eco1'), result('tc_eco1', w.hana.user.id, { status: 'pass' }))])).ok).toBe(true);
    const sv = await joined(w.t.adminEmail);
    sv.revision = base; // the SV is working from before Hana's result
    const lost = await commit(sv, [put('caseResult', caseResultId('tc_eco1'), result('tc_eco1', 'unused', { status: 'fail', updatedByUserId: 'x' }))]);
    expect(lost).toMatchObject({ ok: false, reject: { reason: 'conflict' } });
    const stored = JSON.parse((await get<{ records: Array<{ kind: string; json: string }> }>(w.t.adminEmail, '/api/export')).json.records.find((r) => r.kind === 'caseResult')!.json);
    expect(stored.status).toBe('pass');
  });

  it('a Tester who was offline receives the definitions and results they missed when they reconnect', async () => {
    const w = await workspace('Alpha');
    const behind = await joined(w.hana.email);
    const known = behind.revision;
    behind.sock.close();
    await sync(w.sv, w.t.adminEmail);
    expect((await commit(w.sv, [put('testCase', 'tc_eco3', tcase(3)), put('caseResult', caseResultId('tc_eco1'), result('tc_eco1', 'placeholder'))])).ok).toBe(false); // actor must be the SV's own account
    const svUser = (await get<{ users: UserDto[] }>(w.t.adminEmail, '/api/tenant/users')).json.users.find((u) => u.isOwner)!;
    expect((await commit(w.sv, [put('testCase', 'tc_eco3', tcase(3)), put('caseResult', caseResultId('tc_eco1'), result('tc_eco1', svUser.id))])).ok).toBe(true);
    const again = await openSocket(w.hana.email);
    if (!again.ok) throw new Error('reconnect');
    again.sock.send({ t: 'hello', v: 1, clientId: `c-${crypto.randomUUID()}`, lastRevision: known } as never);
    const changes = await again.sock.next('changes');
    expect(changes.puts.map((p) => p.kind).sort()).toEqual(['caseResult', 'testCase']);
  });
});

describe('tenant isolation', () => {
  it('another workspace never sees these records, and cannot point at them', async () => {
    const a = await workspace('Alpha');
    const b = await workspace('Beta');
    expect((await commit(a.sv, [put('testCase', 'tc_secret', tcase(55, { id: 'tc_secret', title: 'ALPHA-ONLY-SECRET-CASE' }))])).ok).toBe(true);
    expect((await get(b.t.adminEmail, '/api/export')).text).not.toContain('ALPHA-ONLY-SECRET-CASE');
    expect((await get(b.hana.email, '/api/export')).text).not.toContain('ALPHA-ONLY-SECRET-CASE');
    // B has its OWN scp_eco (same ids by construction); a case that only A has does not exist in B
    expect((await commit(a.sv, [put('testCase', 'tc_only_a', tcase(77, { id: 'tc_only_a' }))])).ok).toBe(true);
    const bHana = await joined(b.hana.email);
    const foreign = await commit(bHana, [put('caseResult', caseResultId('tc_only_a'), result('tc_only_a', b.hana.user.id))]);
    expect(foreign).toMatchObject({ ok: false, reject: { message: 'result_case_not_found' } });
    expect((await get(b.t.adminEmail, '/api/export')).text).not.toContain('tc_only_a');
    // a project of tenant A cannot get a scope from a commit of tenant B
    expect(await commit(b.sv, [put('scope', 'scp_x', scope({ id: 'scp_x', projectId: 'PRJ-001', code: 'FRG' })), put('scope', 'scp_y', scope({ id: 'scp_y', projectId: 'PRJ-777', code: 'FRG2' }))])).toMatchObject({ ok: false, reject: { message: 'scope_project_not_found' } });
  });

  it('an SV of one workspace cannot administer another workspace through forged ids, and the Super Admin has no route to any of it', async () => {
    const a = await workspace('Alpha');
    const b = await workspace('Beta');
    expect((await call(b.t.adminEmail, 'POST', `/api/tenant/assignments?tenantId=${a.t.id}`, { projectId: 'PRJ-001', userId: b.hana.user.id, scopeId: 'scp_eco' })).status).toBe(403);
    expect((await get(SUPER, '/api/export')).status).toBe(403);
    expect((await openSocket(SUPER)).ok).toBe(false);
  });
});

describe('an SV managing a project they own', () => {
  it('records any result themselves; cannot record as another person; cannot reuse a key or move a case', async () => {
    const w = await workspace('Alpha');
    const svUser = (await get<{ users: UserDto[] }>(w.t.adminEmail, '/api/tenant/users')).json.users.find((u) => u.isOwner)!;
    await sync(w.sv, w.t.adminEmail);
    expect((await commit(w.sv, [put('caseResult', caseResultId('tc_htma1'), result('tc_htma1', svUser.id, { scopeId: 'scp_htma' }))])).ok).toBe(true);
    expect(await commit(w.sv, [put('caseResult', caseResultId('tc_eco1'), result('tc_eco1', w.hana.user.id))])).toMatchObject({ ok: false, reject: { message: 'result_actor_mismatch' } });
    expect(await commit(w.sv, [put('testCase', 'tc_dup', tcase(1, { id: 'tc_dup' }))])).toMatchObject({ ok: false, reject: { message: 'testcase_key_taken' } });
    expect(await commit(w.sv, [put('testCase', 'tc_eco1', tcase(1, { scopeId: 'scp_htma' }))])).toMatchObject({ ok: false, reject: { message: 'testcase_scope_immutable' } });
  });

  it('a large bulk add is accepted as one revision', async () => {
    const w = await workspace('Alpha');
    await sync(w.sv, w.t.adminEmail);
    const before = await head(w.t.adminEmail);
    const many = Array.from({ length: 400 }, (_, i) => put('testCase', `tc_bulk${i}`, tcase(100 + i, { id: `tc_bulk${i}` })));
    expect((await commit(w.sv, many)).ok).toBe(true);
    expect(await head(w.t.adminEmail)).toBe(before + 1);
  });
});
