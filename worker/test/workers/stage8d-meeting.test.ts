import { describe, expect, it } from 'vitest';
import type { UserDto } from '../../../shared/tenancy';
import { dailyPlanId, meetingNoteId } from '../../../shared/meeting';
import { activateWeb, createTenant, get, openSocket, post, rec, type Tenant } from './tenancy-harness';
import type { TestSocket } from './helpers';

/**
 * Stage 8D through the real Worker and Durable Objects: the authoritative Total Test Cases of a scope and the team meeting's plans and
 * notes - who may write them, what they must refer to, that they are history, and that nobody but an SV ever receives them.
 */

const NOW = '2026-10-08T09:00:00.000Z';
const TODAY = '2026-10-08';
const TOMORROW = '2026-10-09';
let seq = 0;
const rk = (label: string): string => `${label}-${++seq}-${crypto.randomUUID().slice(0, 6)}@rakuten.com`;
const J = JSON.stringify;
const put = (kind: string, id: string, value: unknown) => ({ kind, id, json: J(value) });

const project = (stable = 'PRJ-001', id = 'proj-1') => rec('project', id, { id, projectId: stable, nameEn: `Project ${stable}`, nameJa: '', team: 'RCS', status: 'ongoing', inputs: { totalCases: 100, dailyExecuted: [], bugTickets: [], testerDailyPerformance: [] } });
const scope = (over: Record<string, unknown> = {}) => ({ id: 'scp_eco', projectId: 'PRJ-001', name: 'Ecosystem', code: 'ECO', status: 'active', order: 10, createdAt: NOW, updatedAt: NOW, ...over });
const plan = (date: string, projectId: string, plannedCases: number, scopeId?: string, over: Record<string, unknown> = {}) => ({ id: dailyPlanId(date, projectId, scopeId), date, projectId, ...(scopeId === undefined ? {} : { scopeId }), plannedCases, createdAt: NOW, updatedAt: NOW, ...over });
const note = (date: string, over: Record<string, unknown> = {}) => ({ id: meetingNoteId(date), date, createdAt: NOW, updatedAt: NOW, ...over });

type Rec = { kind: string; id: string; json: string };

async function joined(as: string): Promise<{ sock: TestSocket; revision: number; records: Rec[] }> {
  const o = await openSocket(as);
  if (!o.ok) throw new Error(`socket refused: ${o.status}`);
  const snap = await o.sock.next('snapshot');
  return { sock: o.sock, revision: snap.revision, records: snap.records };
}

let commitSeq = 0;
async function commit(c: { sock: TestSocket; revision: number }, puts: Rec[], deletes: Array<{ kind: string; id: string }> = []) {
  commitSeq += 1;
  c.sock.send({ t: 'commit', id: `s8dm-${commitSeq}-${crypto.randomUUID()}`, baseRevision: c.revision, puts, deletes } as never);
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const ack = await c.sock.next('ack', 60).catch(() => null);
    if (ack !== null) {
      c.revision = ack.revision;
      return { ok: true as const, revision: ack.revision };
    }
    const reject = await c.sock.next('reject', 60).catch(() => null);
    if (reject !== null) return { ok: false as const, reject: reject as { reason: string; message?: string } };
  }
  throw new Error('no answer to the commit');
}
const why = (r: { ok: boolean; reject?: { reason: string; message?: string } }): string => (r.ok ? 'ok' : (r.reject?.message ?? r.reject?.reason ?? '?'));

async function workspace(name: string) {
  const t = await createTenant(name, rk('owner'));
  await activateWeb(t, [project()]);
  const sv = await joined(t.adminEmail);
  expect((await commit(sv, [put('scope', 'scp_eco', scope())])).ok).toBe(true);
  return { t, sv };
}

async function tester(t: Tenant, label: string) {
  const email = rk(label);
  const r = await post<{ user: UserDto }>(t.adminEmail, '/api/tenant/users', { email, role: 'tester', displayName: label });
  expect(r.status).toBe(201);
  expect((await post(t.adminEmail, '/api/tenant/assignments', { projectId: 'PRJ-001', userId: r.json.user.id, scopeId: 'scp_eco' })).status).toBe(201);
  return { email, user: r.json.user };
}

const exportOf = async (as: string) => (await get<{ revision: number; records: Rec[] }>(as, '/api/export')).json;

describe('the Total Test Cases of a scope', () => {
  it('an SV sets it, changes it, and it is kept as a shared record with history', async () => {
    const { t, sv } = await workspace('Alpha');
    expect(why(await commit(sv, [put('scope', 'scp_eco', scope({ totalTestCases: 134, updatedAt: '2026-10-08T10:00:00.000Z' }))]))).toBe('ok');
    expect(why(await commit(sv, [put('scope', 'scp_eco', scope({ totalTestCases: 150, updatedAt: '2026-10-08T11:00:00.000Z' }))]))).toBe('ok');
    const stored = JSON.parse((await exportOf(t.adminEmail)).records.find((r) => r.id === 'scp_eco')!.json);
    expect(stored.totalTestCases).toBe(150);
    const revisions = (await get<{ revisions: Array<{ revision: number; actor: string }> } | Array<{ revision: number; actor: string }>>(t.adminEmail, '/api/revisions?limit=20')).json;
    const list = Array.isArray(revisions) ? revisions : revisions.revisions;
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.some((r) => r.actor === t.adminEmail)).toBe(true);
  });

  it('a Tester cannot set or change it, and the server refuses invalid values from an SV', async () => {
    const { t, sv } = await workspace('Alpha');
    const hana = await tester(t, 'hana');
    const tt = await joined(hana.email);
    expect(why(await commit(tt, [put('scope', 'scp_eco', scope({ totalTestCases: 9999 }))]))).toMatch(/tester_cannot_change_kind/);
    for (const bad of [-1, 1.5, '12', null, 1_000_001]) {
      expect(why(await commit(sv, [put('scope', 'scp_eco', scope({ totalTestCases: bad, updatedAt: '2026-10-08T12:00:00.000Z' }))])), String(bad)).toBe('scope_invalid_total');
    }
    const stored = JSON.parse((await exportOf(t.adminEmail)).records.find((r) => r.id === 'scp_eco')!.json);
    expect(stored.totalTestCases).toBeUndefined();
  });

  it('two SVs changing the same scope Total conflict instead of silently overwriting each other', async () => {
    const { t, sv } = await workspace('Alpha');
    const sv2 = await post<{ user: UserDto }>(t.adminEmail, '/api/tenant/users', { email: rk('sv2'), role: 'sv' });
    const other = await joined(sv2.json.user.email);
    expect(why(await commit(sv, [put('scope', 'scp_eco', scope({ totalTestCases: 10, updatedAt: '2026-10-08T10:00:00.000Z' }))]))).toBe('ok');
    const second = await commit(other, [put('scope', 'scp_eco', scope({ totalTestCases: 20, updatedAt: '2026-10-08T10:00:01.000Z' }))]); // based on the older revision
    expect(second.ok).toBe(false);
    expect((second as { reject: { reason: string } }).reject.reason).toBe('conflict');
  });
});

describe('the team meeting\'s plans and notes', () => {
  it('an SV saves a plan for today and tomorrow and a note; they persist and the next session reads them (tomorrow becomes the next Morning)', async () => {
    const { t, sv } = await workspace('Alpha');
    const puts = [
      put('dailyPlan', dailyPlanId(TODAY, 'PRJ-001', 'scp_eco'), plan(TODAY, 'PRJ-001', 80, 'scp_eco')),
      put('dailyPlan', dailyPlanId(TOMORROW, 'PRJ-001'), plan(TOMORROW, 'PRJ-001', 145)),
      put('meetingNote', meetingNoteId(TODAY), note(TODAY, { morning: 'Finish Ecosystem before 16:00' })),
    ];
    expect(why(await commit(sv, puts))).toBe('ok');
    const later = await joined(t.adminEmail); // a different session, later
    const kinds = later.records.filter((r) => r.kind === 'dailyPlan' || r.kind === 'meetingNote').map((r) => r.id).sort();
    expect(kinds).toEqual([dailyPlanId(TODAY, 'PRJ-001', 'scp_eco'), dailyPlanId(TOMORROW, 'PRJ-001'), meetingNoteId(TODAY)].sort());
    expect(JSON.parse(later.records.find((r) => r.id === dailyPlanId(TOMORROW, 'PRJ-001'))!.json).plannedCases).toBe(145);
  });

  it('refuses a plan for a project or scope this workspace does not have, a wrong id, and bad numbers', async () => {
    const { sv } = await workspace('Alpha');
    const tryPlan = async (v: Record<string, unknown>, id?: string) => why(await commit(sv, [put('dailyPlan', id ?? (v.id as string), v)]));
    expect(await tryPlan(plan(TODAY, 'PRJ-404', 5))).toBe('dailyplan_project_not_found');
    expect(await tryPlan(plan(TODAY, 'PRJ-001', 5, 'scp_missing'))).toBe('dailyplan_scope_not_found');
    expect(await tryPlan({ ...plan(TODAY, 'PRJ-001', 5), id: 'dp_forged' })).toBe('dailyplan_id_mismatch');
    expect(await tryPlan(plan(TODAY, 'PRJ-001', -3))).toBe('dailyplan_invalid_cases');
    expect(await tryPlan(plan('2026-99-99', 'PRJ-001', 3))).toBe('dailyplan_invalid_date');
    expect(await tryPlan(plan(TODAY, 'PRJ-001', 3), dailyPlanId(TOMORROW, 'PRJ-001'))).toBe('dailyplan_id_mismatch'); // the key must be the plan's own
    expect(why(await commit(sv, [put('meetingNote', 'mn_wrong', note(TODAY))]))).toBe('meetingnote_id_mismatch');
  });

  it('another workspace\'s project cannot be planned for: a project that exists only in Beta is unknown in Alpha', async () => {
    const a = await workspace('Alpha');
    const b = await createTenant('Beta', rk('owner-b'));
    await activateWeb(b, [project('PRJ-777', 'proj-b')]);
    expect(why(await commit(a.sv, [put('dailyPlan', dailyPlanId(TODAY, 'PRJ-777'), plan(TODAY, 'PRJ-777', 5))]))).toBe('dailyplan_project_not_found');
    const bsv = await joined(b.adminEmail);
    expect(bsv.records.some((r) => r.kind === 'dailyPlan')).toBe(false);
  });

  it('a Tester can neither write nor receive them: not on connect, not live, not in an export', async () => {
    const { t, sv } = await workspace('Alpha');
    const hana = await tester(t, 'hana');
    const live = await joined(hana.email);
    expect(why(await commit(live, [put('dailyPlan', dailyPlanId(TODAY, 'PRJ-001'), plan(TODAY, 'PRJ-001', 5))]))).toMatch(/tester_cannot_change_kind/);
    expect(why(await commit(live, [put('meetingNote', meetingNoteId(TODAY), note(TODAY))]))).toMatch(/tester_cannot_change_kind/);
    expect(why(await commit(sv, [put('dailyPlan', dailyPlanId(TODAY, 'PRJ-001'), plan(TODAY, 'PRJ-001', 90, undefined, { note: 'SECRET-PLAN-NOTE' })), put('meetingNote', meetingNoteId(TODAY), note(TODAY, { morning: 'SECRET-MEETING-NOTE' }))]))).toBe('ok');
    const pushed = await live.sock.next('changes', 1500).catch(() => null);
    if (pushed !== null) expect(J(pushed)).not.toMatch(/SECRET/);
    const reconnect = await joined(hana.email);
    expect(J(reconnect.records)).not.toMatch(/SECRET|dailyPlan|meetingNote/);
    const exported = await exportOf(hana.email);
    expect(J(exported.records)).not.toMatch(/SECRET/);
    expect(exported.records.some((r) => r.kind === 'dailyPlan' || r.kind === 'meetingNote')).toBe(false);
  });

  it('only an SV deletes them, and the change is in the shared (QA) history, not the administrative audit', async () => {
    const { t, sv } = await workspace('Alpha');
    const hana = await tester(t, 'hana');
    const id = dailyPlanId(TODAY, 'PRJ-001');
    expect(why(await commit(sv, [put('dailyPlan', id, plan(TODAY, 'PRJ-001', 5))]))).toBe('ok');
    const live = await joined(hana.email);
    expect(why(await commit(live, [], [{ kind: 'dailyPlan', id }]))).toMatch(/tester_cannot_delete/);
    expect(why(await commit(sv, [], [{ kind: 'dailyPlan', id }]))).toBe('ok');
    const audit = (await get<{ audit: Array<{ action: string }> }>(t.adminEmail, '/api/tenant/audit?limit=100')).json.audit;
    expect(audit.map((a) => a.action).join(' ')).not.toMatch(/plan|meeting/i);
  });
});
