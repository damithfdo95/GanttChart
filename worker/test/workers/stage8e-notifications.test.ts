import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { UserDto } from '../../../shared/tenancy';
import { businessMomentMs } from '../../../shared/businessTime';
import { dailyPlanId, meetingNoteId } from '../../../shared/meeting';
import { ackId } from '../../../shared/notifications';
import { activateWeb, call, createTenant, get, openSocket, post, rec, type Tenant } from './tenancy-harness';
import type { TestSocket } from './helpers';

/**
 * Stage 8E through the real Worker and Durable Objects: scheduled notifications (who administers, who is addressed, who may close what),
 * the workspace logo, the history filters and the plan retention. Time is always injected - nothing here depends on today's date.
 */

const NOW = '2026-10-08T09:00:00.000Z';
const DAY = '2026-10-08';
const AT = businessMomentMs(DAY, '10:00'); // 10:00 business time: a 09:00 reminder is due
const OCC = '2026-10-08T09:00';
let seq = 0;
const rk = (label: string): string => `${label}-${++seq}-${crypto.randomUUID().slice(0, 6)}@rakuten.com`;
const J = JSON.stringify;
const put = (kind: string, id: string, value: unknown) => ({ kind, id, json: J(value) });
const project = () => rec('project', 'proj-1', { projectId: 'PRJ-001', nameEn: 'Project', nameJa: '', team: 'RCS', status: 'ongoing', inputs: { totalCases: 100, dailyExecuted: [], bugTickets: [], testerDailyPerformance: [] } });
const plan = (date: string, plannedCases: number) => ({ id: dailyPlanId(date, 'PRJ-001'), date, projectId: 'PRJ-001', plannedCases, createdAt: NOW, updatedAt: NOW });
const note = (date: string) => ({ id: meetingNoteId(date), date, morning: 'n', createdAt: NOW, updatedAt: NOW });

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
  c.sock.send({ t: 'commit', id: `s8e-${commitSeq}-${crypto.randomUUID()}`, baseRevision: c.revision, puts, deletes } as never);
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const ack = await c.sock.next('ack', 60).catch(() => null);
    if (ack !== null) {
      c.revision = ack.revision;
      return { ok: true as const };
    }
    const reject = await c.sock.next('reject', 60).catch(() => null);
    if (reject !== null) return { ok: false as const, reason: ((reject as { message?: string; reason: string }).message ?? (reject as { reason: string }).reason) };
  }
  throw new Error('no answer to the commit');
}
const exportOf = async (as: string) => (await get<{ revision: number; records: Rec[] }>(as, '/api/export')).json.records;

async function workspace(name: string) {
  const t = await createTenant(name, rk('owner'));
  await activateWeb(t, [project()]);
  return t;
}
async function member(t: Tenant, label: string, role: 'tester' | 'sv' = 'tester') {
  const email = rk(label);
  const r = await post<{ user: UserDto; memberId: string }>(t.adminEmail, '/api/tenant/users', { email, role, displayName: label });
  expect(r.status).toBe(201);
  return { email, user: r.json.user, memberId: r.json.memberId };
}
const body = (over: Record<string, unknown> = {}) => ({ title: 'Stand-up', message: 'Main room', recurrence: 'daily', time: '09:00', audience: { kind: 'all' }, ...over });
const ackAt = (as: string, id: string, occurrence: string, nowMs = AT) => call<{ created?: boolean; error?: string }>(as, 'POST', `/api/tenant/notifications/${id}/ack`, { occurrence }, { 'x-dev-now': String(nowMs) });
async function create(t: Tenant, over: Record<string, unknown> = {}): Promise<string> {
  const r = await post<{ id: string }>(t.adminEmail, '/api/tenant/notifications', body(over));
  expect(r.status).toBe(201);
  return r.json.id;
}
const auditActions = async (t: Tenant): Promise<string[]> => (await get<{ audit: Array<{ action: string }> }>(t.adminEmail, '/api/tenant/audit?limit=100')).json.audit.map((e) => e.action);
/** Acknowledgments of the given people, read from the workspace itself (each person is only ever sent their own). */
const acksOf = async (t: Tenant, ...userIds: string[]): Promise<Rec[]> => {
  const out: Rec[] = [];
  for (const id of userIds) out.push(...ofKind((await env.WORKSPACE.getByName(t.id).exportAll(t.id, 'user', id)).records as Rec[], 'notificationAck'));
  return out;
};
const ofKind = (records: Rec[], kind: string) => records.filter((r) => r.kind === kind);

describe('who administers notifications', () => {
  it('an SV creates, edits, disables and removes; a Tester can do none of it; every change is audited', async () => {
    const t = await workspace('Alpha');
    const hana = await member(t, 'hana');
    const id = await create(t);
    expect((await post(hana.email, '/api/tenant/notifications', body())).status).toBe(403);
    expect((await call(hana.email, 'PATCH', `/api/tenant/notifications/${id}`, body({ title: 'Hijack' }))).status).toBe(403);
    expect((await call(hana.email, 'DELETE', `/api/tenant/notifications/${id}`)).status).toBe(403);
    expect((await call(t.adminEmail, 'PATCH', `/api/tenant/notifications/${id}`, body({ title: 'Renamed' }))).status).toBe(200);
    expect((await call(t.adminEmail, 'PATCH', `/api/tenant/notifications/${id}`, body({ title: 'Renamed', enabled: false }))).status).toBe(200);
    const stored = JSON.parse(ofKind(await exportOf(t.adminEmail), 'notification')[0].json);
    expect(stored).toMatchObject({ title: 'Renamed', enabled: false });
    expect((await call(t.adminEmail, 'DELETE', `/api/tenant/notifications/${id}`)).status).toBe(200);
    expect(ofKind(await exportOf(t.adminEmail), 'notification')).toHaveLength(0);

    const actions = await auditActions(t);
    for (const a of ['notification.created', 'notification.updated', 'notification.disabled', 'notification.deleted']) expect(actions, a).toContain(a);
  });

  it('refuses nonsense schedules and unknown audience members', async () => {
    const t = await workspace('Alpha');
    expect((await post(t.adminEmail, '/api/tenant/notifications', body({ time: '99:99' }))).status).toBe(400);
    expect((await post(t.adminEmail, '/api/tenant/notifications', body({ audience: { kind: 'members', memberIds: ['USER9999'] } }))).status).toBeGreaterThanOrEqual(400);
  });

  it('a Tester cannot write a definition through the sync socket either', async () => {
    const t = await workspace('Alpha');
    const hana = await member(t, 'hana');
    const c = await joined(hana.email);
    const forged = { id: 'ntf_forged', title: 'x', message: '', recurrence: 'daily', time: '09:00', audience: { kind: 'all' }, enabled: true, createdAt: NOW, updatedAt: NOW, createdByUserId: hana.user.id, updatedByUserId: hana.user.id };
    expect((await commit(c, [put('notification', 'ntf_forged', forged)])).ok).toBe(false);
  });
});

describe('the workspace refuses a request that names another workspace', () => {
  it('every Stage 8E entry point checks the tenant it was addressed for', async () => {
    const a = await workspace('Alpha');
    const b = await workspace('Beta');
    const hana = await member(a, 'hana');
    const id = await create(a);
    const roomA = env.WORKSPACE.getByName(a.id);
    const actor = { userId: hana.user.id, email: hana.email };
    await expect(roomA.acknowledgeNotification(b.id, { userId: hana.user.id, role: 'user', notificationId: id, occurrence: OCC, nowMs: AT, email: hana.email })).rejects.toThrow('tenant mismatch');
    await expect(roomA.saveNotification(b.id, { fields: { title: 'x', message: '', recurrence: 'daily', time: '09:00', audience: { kind: 'all' }, enabled: true }, actor })).rejects.toThrow('tenant mismatch');
    await expect(roomA.setBranding(b.id, { mime: 'image/png', data: B64_PNG, actor })).rejects.toThrow('tenant mismatch');
    await expect(roomA.runRetention(b.id, AT)).rejects.toThrow('tenant mismatch');
    await expect(roomA.listRevisions(b.id, 10, undefined, {})).rejects.toThrow('tenant mismatch');
    expect(await acksOf(a, hana.user.id)).toHaveLength(0);
  });
});

describe('who receives what', () => {
  it('each audience reaches exactly its people, and nobody else even receives the definition', async () => {
    const t = await workspace('Alpha');
    const hana = await member(t, 'hana');
    const ken = await member(t, 'ken');
    const sv2 = await member(t, 'sv2', 'sv');
    const all = await create(t, { title: 'All' });
    const svOnly = await create(t, { title: 'SV', audience: { kind: 'sv' } });
    const testers = await create(t, { title: 'Testers', audience: { kind: 'testers' } });
    const specific = await create(t, { title: 'Hana only', audience: { kind: 'members', memberIds: [hana.memberId] } });
    const seen = async (as: string) => ofKind((await joined(as)).records, 'notification').map((r) => r.id).sort();
    expect(await seen(t.adminEmail)).toEqual([all, svOnly, testers, specific].sort());
    expect(await seen(sv2.email)).toEqual([all, svOnly, testers, specific].sort());
    expect(await seen(hana.email)).toEqual([all, testers, specific].sort());
    expect(await seen(ken.email)).toEqual([all, testers].sort());
  });

  it('a person the audience stops addressing no longer receives it', async () => {
    const t = await workspace('Alpha');
    const hana = await member(t, 'hana');
    const id = await create(t, { audience: { kind: 'members', memberIds: [hana.memberId] } });
    const live = await joined(hana.email);
    expect(ofKind(live.records, 'notification').map((r) => r.id)).toEqual([id]);
    expect((await call(t.adminEmail, 'PATCH', `/api/tenant/notifications/${id}`, body({ audience: { kind: 'sv' } }))).status).toBe(200);
    expect(ofKind((await joined(hana.email)).records, 'notification')).toHaveLength(0);
  });

  it('a disabled notification is not sent to a Tester', async () => {
    const t = await workspace('Alpha');
    const hana = await member(t, 'hana');
    await create(t, { enabled: false });
    expect(ofKind((await joined(hana.email)).records, 'notification')).toHaveLength(0);
  });

  it('another workspace never sees these notifications', async () => {
    const a = await workspace('Alpha');
    const b = await workspace('Beta');
    await create(a, { title: 'ALPHA-SECRET' });
    const bsv = await joined(b.adminEmail);
    expect(bsv.records.some((r) => r.json.includes('ALPHA-SECRET'))).toBe(false);
    expect((await exportOf(b.adminEmail)).some((r) => r.json.includes('ALPHA-SECRET'))).toBe(false);
  });
});

describe('closing a notification', () => {
  it('records the acknowledgment for the CALLER, once; a second close changes nothing', async () => {
    const t = await workspace('Alpha');
    const hana = await member(t, 'hana');
    const id = await create(t);
    const first = await ackAt(hana.email, id, OCC);
    expect(first.status).toBe(200);
    expect(first.json.created).toBe(true);
    expect((await ackAt(hana.email, id, OCC)).json.created).toBe(false);
    const acks = await acksOf(t, hana.user.id);
    expect(acks).toHaveLength(1);
    expect(JSON.parse(acks[0].json)).toMatchObject({ notificationId: id, occurrence: OCC, userId: hana.user.id });
    expect(acks[0].id).toBe(ackId(id, OCC, hana.user.id));
  });

  it('is per person: Hana closing it does not close it for Ken, and Ken receives none of Hana\'s acknowledgments', async () => {
    const t = await workspace('Alpha');
    const hana = await member(t, 'hana');
    const ken = await member(t, 'ken');
    const id = await create(t);
    await ackAt(hana.email, id, OCC);
    expect(ofKind((await joined(hana.email)).records, 'notificationAck')).toHaveLength(1);
    expect(ofKind((await joined(ken.email)).records, 'notificationAck')).toHaveLength(0);
    expect((await ackAt(ken.email, id, OCC)).json.created).toBe(true);
    expect(ofKind((await joined(ken.email)).records, 'notificationAck').map((r) => JSON.parse(r.json).userId)).toEqual([ken.user.id]);
  });

  it('the person is the verified caller - a body naming somebody else is ignored, and nobody can close for another', async () => {
    const t = await workspace('Alpha');
    const hana = await member(t, 'hana');
    const ken = await member(t, 'ken');
    const id = await create(t);
    await call(hana.email, 'POST', `/api/tenant/notifications/${id}/ack`, { occurrence: OCC, userId: ken.user.id, at: '2000-01-01T00:00:00Z' }, { 'x-dev-now': String(AT) });
    expect(await acksOf(t, ken.user.id)).toHaveLength(0);
    const acks = (await acksOf(t, hana.user.id)).map((r) => JSON.parse(r.json));
    expect(acks).toHaveLength(1);
    expect(acks[0].userId).toBe(hana.user.id);
  });

  it('cannot be forged through the sync socket - not for oneself, not for another, not by an SV', async () => {
    const t = await workspace('Alpha');
    const hana = await member(t, 'hana');
    const id = await create(t);
    const forged = { id: ackId(id, OCC, hana.user.id), notificationId: id, occurrence: OCC, userId: hana.user.id, at: NOW };
    const c = await joined(hana.email);
    expect((await commit(c, [put('notificationAck', forged.id, forged)])).ok).toBe(false);
    const sv = await joined(t.adminEmail);
    expect((await commit(sv, [put('notificationAck', forged.id, forged)])).ok).toBe(false);
    expect(await acksOf(t, hana.user.id)).toHaveLength(0);
  });

  it('is refused for a notification that does not exist, one not addressed to the caller, a future occurrence, and an occurrence the schedule never had', async () => {
    const t = await workspace('Alpha');
    const hana = await member(t, 'hana');
    const svOnly = await create(t, { audience: { kind: 'sv' } });
    const all = await create(t);
    expect((await ackAt(hana.email, 'ntf_does_not_exist', OCC)).status).toBe(404);
    expect((await ackAt(hana.email, svOnly, OCC)).status).toBe(403);
    expect((await ackAt(hana.email, all, '2026-10-09T09:00')).json.error).toBe('invalid_occurrence'); // tomorrow
    expect((await ackAt(hana.email, all, '2026-10-08T09:30')).json.error).toBe('invalid_occurrence'); // not a time of the schedule
    expect((await ackAt(hana.email, all, 'garbage')).json.error).toBe('invalid_occurrence');
    expect((await post(hana.email, `/api/tenant/notifications/not-an-id/ack`, { occurrence: OCC })).status).toBe(400);
    expect(await acksOf(t, hana.user.id)).toHaveLength(0);
  });

  it('another workspace cannot close this workspace\'s notification', async () => {
    const a = await workspace('Alpha');
    const b = await workspace('Beta');
    const id = await create(a);
    expect((await ackAt(b.adminEmail, id, OCC)).status).toBe(404);
  });

  it('closing is not an administrative audit event', async () => {
    const t = await workspace('Alpha');
    const hana = await member(t, 'hana');
    const id = await create(t);
    await ackAt(hana.email, id, OCC);
    expect((await auditActions(t)).some((a) => /ack/i.test(a))).toBe(false);
  });
});

describe('plain text only', () => {
  it('a message with markup is stored as text and returned unchanged', async () => {
    const t = await workspace('Alpha');
    await create(t, { message: '<script>alert(1)</script>' });
    expect(JSON.parse(ofKind(await exportOf(t.adminEmail), 'notification')[0].json).message).toBe('<script>alert(1)</script>');
  });
});

// ---- the logo ---------------------------------------------------------------------------------------

const B64_PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4));
const B64_JPG = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1));
const B64_WEBP = btoa(String.fromCharCode(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50));
const B64_SVG = btoa('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const putLogo = (as: string, mime: string, data: string) => call<{ error?: string; bytes?: number }>(as, 'PUT', '/api/tenant/branding', { mime, data });

describe('the workspace logo', () => {
  it('an SV sets PNG, JPEG and WebP; it is one stored record, replaced each time, and removable', async () => {
    const t = await workspace('Alpha');
    for (const [mime, data] of [['image/png', B64_PNG], ['image/jpeg', B64_JPG], ['image/webp', B64_WEBP]] as const) {
      const r = await putLogo(t.adminEmail, mime, data);
      expect(r.status, mime).toBe(200);
    }
    const stored = ofKind(await exportOf(t.adminEmail), 'branding');
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0].json)).toMatchObject({ id: 'branding', mime: 'image/webp', updatedByUserId: expect.any(String) });
    expect((await call(t.adminEmail, 'DELETE', '/api/tenant/branding')).status).toBe(200);
    expect(ofKind(await exportOf(t.adminEmail), 'branding')).toHaveLength(0);
  });

  it('refuses SVG, other types, a type that does not match the bytes, bad base64 and anything over the limit', async () => {
    const t = await workspace('Alpha');
    expect((await putLogo(t.adminEmail, 'image/svg+xml', B64_SVG)).json.error).toBe('logo_invalid_type');
    expect((await putLogo(t.adminEmail, 'image/png', B64_SVG)).json.error).toBe('logo_type_mismatch');
    expect((await putLogo(t.adminEmail, 'image/png', B64_JPG)).json.error).toBe('logo_type_mismatch');
    expect((await putLogo(t.adminEmail, 'image/gif', B64_PNG)).json.error).toBe('logo_invalid_type');
    expect((await putLogo(t.adminEmail, 'image/png', '***')).status).toBe(400);
    const header = String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    const huge = btoa(header + 'A'.repeat(262_144)); // 8 bytes over the hard maximum
    const r = await putLogo(t.adminEmail, 'image/png', huge);
    expect(r.status).toBe(413);
    expect(r.json.error).toBe('logo_too_large');
    expect(ofKind(await exportOf(t.adminEmail), 'branding')).toHaveLength(0);
  });

  it('a Tester can see it but cannot set or remove it, by API or by socket', async () => {
    const t = await workspace('Alpha');
    const hana = await member(t, 'hana');
    expect((await putLogo(t.adminEmail, 'image/png', B64_PNG)).status).toBe(200);
    expect((await putLogo(hana.email, 'image/jpeg', B64_JPG)).status).toBe(403);
    expect((await call(hana.email, 'DELETE', '/api/tenant/branding')).status).toBe(403);
    const c = await joined(hana.email);
    expect(ofKind(c.records, 'branding')).toHaveLength(1); // visible
    const forged = { id: 'branding', mime: 'image/png', data: B64_PNG, bytes: 12, updatedAt: NOW, updatedByUserId: hana.user.id };
    expect((await commit(c, [put('branding', 'branding', forged)])).ok).toBe(false);
    expect(JSON.parse(ofKind(await exportOf(t.adminEmail), 'branding')[0].json).mime).toBe('image/png');
  });

  it('is per workspace', async () => {
    const a = await workspace('Alpha');
    const b = await workspace('Beta');
    await putLogo(a.adminEmail, 'image/png', B64_PNG);
    expect(ofKind(await exportOf(b.adminEmail), 'branding')).toHaveLength(0);
    expect(ofKind((await joined(b.adminEmail)).records, 'branding')).toHaveLength(0);
  });

  it('setting and removing the logo are audited', async () => {
    const t = await workspace('Alpha');
    await putLogo(t.adminEmail, 'image/png', B64_PNG);
    await call(t.adminEmail, 'DELETE', '/api/tenant/branding');
    const list = await auditActions(t);
    expect(list).toContain('branding.updated');
    expect(list).toContain('branding.removed');
  });
});

// ---- Shared History filters --------------------------------------------------------------------------

type Rev = { revision: number; actor: string; at?: string; summary: Array<{ kind: string }>; changed?: Array<{ kind: string; id: string }> };
const revs = async (as: string, query = '') => {
  const r = await get<Rev[]>(as, `/api/revisions?limit=500${query}`);
  return { status: r.status, list: Array.isArray(r.json) ? r.json : [] };
};

describe('Shared History filters (server side)', () => {
  async function seeded() {
    const t = await workspace('Alpha');
    const sv2 = await member(t, 'sv2', 'sv');
    const a = await joined(t.adminEmail);
    const b = await joined(sv2.email);
    expect((await commit(a, [put('dailyPlan', dailyPlanId(DAY, 'PRJ-001'), plan(DAY, 10))])).ok).toBe(true);
    expect((await commit(a, [put('meetingNote', meetingNoteId(DAY), note(DAY))])).ok).toBe(true);
    b.revision = a.revision;
    expect((await commit(b, [put('dailyPlan', dailyPlanId('2026-10-09', 'PRJ-001'), plan('2026-10-09', 20))])).ok).toBe(true);
    return { t, sv2 };
  }

  it('filters by record type, by actor, and by both; the unfiltered list is the union', async () => {
    const { t, sv2 } = await seeded();
    const everything = await revs(t.adminEmail);
    expect(everything.status).toBe(200);
    const plans = await revs(t.adminEmail, '&kind=dailyPlan');
    expect(plans.list.length).toBe(2);
    expect(plans.list.every((r) => r.summary.some((s) => s.kind === 'dailyPlan'))).toBe(true);
    const notes = await revs(t.adminEmail, '&kind=meetingNote');
    expect(notes.list).toHaveLength(1);
    const mine = await revs(t.adminEmail, `&actor=${encodeURIComponent(t.adminEmail)}`);
    expect(mine.list.length).toBeGreaterThan(0);
    expect(mine.list.every((r) => r.actor === t.adminEmail)).toBe(true);
    const theirs = await revs(t.adminEmail, `&actor=${encodeURIComponent(sv2.email)}`);
    expect(theirs.list).toHaveLength(1);
    const both = await revs(t.adminEmail, `&kind=dailyPlan&actor=${encodeURIComponent(sv2.email)}`);
    expect(both.list).toHaveLength(1);
    const none = await revs(t.adminEmail, `&kind=meetingNote&actor=${encodeURIComponent(sv2.email)}`);
    expect(none.list).toHaveLength(0);
    expect(everything.list.length).toBeGreaterThanOrEqual(plans.list.length + notes.list.length);
  });

  it('filters by business-day range; the bounds are inclusive days', async () => {
    const { t } = await seeded();
    const today = new Date().toISOString().slice(0, 10);
    const yday = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    expect((await revs(t.adminEmail, `&from=${yday}&to=${today}`)).list.length).toBeGreaterThan(0);
    expect((await revs(t.adminEmail, '&from=2001-01-01&to=2001-01-02')).list).toHaveLength(0);
    expect((await revs(t.adminEmail, '&from=2999-01-01')).list).toHaveLength(0);
  });

  it('pages with a stable cursor: no repeats, no gaps, same result as one big page, also when filtered', async () => {
    const { t } = await seeded();
    const all = (await revs(t.adminEmail)).list.map((r) => r.revision);
    const walked: number[] = [];
    let before: number | undefined;
    for (let i = 0; i < 20; i += 1) {
      const page = (await get<Rev[]>(t.adminEmail, `/api/revisions?limit=2${before === undefined ? '' : `&before=${before}`}`)).json;
      if (!Array.isArray(page) || page.length === 0) break;
      walked.push(...page.map((r) => r.revision));
      before = page[page.length - 1].revision;
    }
    expect(walked).toEqual(all);
    expect(new Set(walked).size).toBe(walked.length);
    const filtered = (await revs(t.adminEmail, '&kind=dailyPlan')).list.map((r) => r.revision);
    const page1 = (await get<Rev[]>(t.adminEmail, '/api/revisions?limit=1&kind=dailyPlan')).json;
    const page2 = (await get<Rev[]>(t.adminEmail, `/api/revisions?limit=1&kind=dailyPlan&before=${page1[0].revision}`)).json;
    expect([page1[0].revision, page2[0].revision]).toEqual(filtered);
  });

  it('says which records each revision changed, so the screen can name them', async () => {
    const { t } = await seeded();
    const plans = await revs(t.adminEmail, '&kind=dailyPlan');
    expect(plans.list[0].changed?.some((c) => c.kind === 'dailyPlan')).toBe(true);
  });

  it('bad filter values are refused, not ignored', async () => {
    const { t } = await seeded();
    expect((await get(t.adminEmail, '/api/revisions?kind=nonsense')).status).toBe(400);
    expect((await get(t.adminEmail, '/api/revisions?from=yesterday')).status).toBe(400);
    expect((await get(t.adminEmail, '/api/revisions?to=2026-99-99')).status).toBe(400);
    expect((await get(t.adminEmail, `/api/revisions?actor=${'x'.repeat(300)}`)).status).toBe(400);
  });

  it('a Tester is denied; another workspace\'s history never shows up under any filter', async () => {
    const { t } = await seeded();
    const hana = await member(t, 'hana');
    expect((await get(hana.email, '/api/revisions')).status).toBe(403);
    expect((await get(hana.email, '/api/revisions?kind=dailyPlan')).status).toBe(403);
    const other = await workspace('Beta');
    const theirs = await revs(other.adminEmail, '&kind=dailyPlan');
    expect(theirs.list).toHaveLength(0);
    expect((await revs(other.adminEmail, `&actor=${encodeURIComponent(t.adminEmail)}`)).list).toHaveLength(0);
  });
});

// ---- retention ----------------------------------------------------------------------------------------
//
// The injected clock lives in 2030 so that the opportunistic run a plan save triggers with the REAL clock can never prune the fixture:
// every date below is far newer than the real clock's cutoff, and only runRetention(tenantId, TODAY_MS) decides.

describe('plan retention', () => {
  const room = (t: Tenant) => env.WORKSPACE.getByName(t.id);
  const idsOf = async (t: Tenant, kind: string) => ofKind(await exportOf(t.adminEmail), kind).map((r) => r.id).sort();
  const TODAY = '2030-10-08';
  const TODAY_MS = businessMomentMs(TODAY, '10:00');
  const dates = ['2029-01-10', '2029-10-07', '2029-10-08', '2030-10-08', '2030-10-09', '2031-12-01']; // 365-day cutoff at TODAY is 2029-10-08

  async function withHistory() {
    const t = await workspace('Alpha');
    const sv = await joined(t.adminEmail);
    const puts = [...dates.map((d) => put('dailyPlan', dailyPlanId(d, 'PRJ-001'), plan(d, 5))), ...dates.map((d) => put('meetingNote', meetingNoteId(d), note(d)))];
    expect((await commit(sv, puts)).ok).toBe(true);
    return { t, sv };
  }
  const planIds = (list: string[]) => list.map((d) => dailyPlanId(d, 'PRJ-001')).sort();

  it('removes plans and notes older than the default 365 days; keeps the boundary day, today, and the future', async () => {
    const { t } = await withHistory();
    expect(await idsOf(t, 'dailyPlan')).toHaveLength(6); // nothing is pruned by saving them
    const result = await room(t).runRetention(t.id, TODAY_MS);
    expect(result).toMatchObject({ ran: true, plans: 2, notes: 2 });
    expect(await idsOf(t, 'dailyPlan')).toEqual(planIds(['2029-10-08', '2030-10-08', '2030-10-09', '2031-12-01']));
    expect(await idsOf(t, 'meetingNote')).toEqual(['2029-10-08', '2030-10-08', '2030-10-09', '2031-12-01'].map(meetingNoteId).sort());
  });

  it('runs at most once per business day, however often it is asked; the next day it runs again', async () => {
    const { t } = await withHistory();
    expect((await room(t).runRetention(t.id, TODAY_MS)).ran).toBe(true);
    for (let i = 1; i <= 5; i += 1) expect((await room(t).runRetention(t.id, TODAY_MS + i * 60_000)).ran).toBe(false);
    // the day after, the 2029-10-08 plan is a day older than the window: it goes, and only then
    const next = await room(t).runRetention(t.id, businessMomentMs('2030-10-09', '03:00'));
    expect(next).toMatchObject({ ran: true, plans: 1, notes: 1 });
    expect(await idsOf(t, 'dailyPlan')).toEqual(planIds(['2030-10-08', '2030-10-09', '2031-12-01']));
  });

  it('follows the workspace setting (90 and 730 days)', async () => {
    for (const [days, kept] of [
      [90, ['2030-10-08', '2030-10-09', '2031-12-01']],
      [730, ['2029-01-10', '2029-10-07', '2029-10-08', '2030-10-08', '2030-10-09', '2031-12-01']],
    ] as const) {
      const { t, sv } = await withHistory();
      expect((await commit(sv, [put('settings', 'settings', { id: 'settings', planRetentionDays: days })])).ok, String(days)).toBe(true);
      await room(t).runRetention(t.id, TODAY_MS);
      expect(await idsOf(t, 'dailyPlan'), String(days)).toEqual(planIds([...kept]));
    }
  });

  it('refuses a retention period that is not one of the choices', async () => {
    const t = await workspace('Alpha');
    const sv = await joined(t.adminEmail);
    for (const bad of [7, 0, -1, 364, '365', null]) expect((await commit(sv, [put('settings', 'settings', { id: 'settings', planRetentionDays: bad })])).ok, String(bad)).toBe(false);
    expect((await commit(sv, [put('settings', 'settings', { id: 'settings', planRetentionDays: 180 })])).ok).toBe(true);
  });

  it('never touches projects, people, test records or the administrative audit', async () => {
    const { t } = await withHistory();
    const keep = async () => (await exportOf(t.adminEmail)).filter((r) => r.kind !== 'dailyPlan' && r.kind !== 'meetingNote').map((r) => `${r.kind}:${r.id}:${r.json}`).sort();
    const before = await keep();
    const auditBefore = await auditActions(t);
    await room(t).runRetention(t.id, TODAY_MS);
    expect(await keep()).toEqual(before);
    expect(before.length).toBeGreaterThan(0);
    expect(await auditActions(t)).toEqual(auditBefore);
  });

  it('only prunes the workspace it is run for', async () => {
    const a = await withHistory();
    const b = await withHistory();
    await room(a.t).runRetention(a.t.id, TODAY_MS);
    expect(await idsOf(b.t, 'dailyPlan')).toHaveLength(6);
  });

  it('ordinary requests (reads, connecting) never prune', async () => {
    const { t } = await withHistory();
    for (let i = 0; i < 3; i += 1) {
      await get(t.adminEmail, '/api/export');
      await joined(t.adminEmail);
      await get(t.adminEmail, '/api/revisions');
    }
    expect(await idsOf(t, 'dailyPlan')).toHaveLength(6);
    expect(await idsOf(t, 'meetingNote')).toHaveLength(6);
  });

  it('removes old, superseded acknowledgments and keeps the one that keeps today\'s notification closed', async () => {
    const t = await workspace('Alpha');
    const hana = await member(t, 'hana');
    const id = await create(t);
    const old = businessMomentMs('2030-05-01', '10:00');
    expect((await ackAt(hana.email, id, '2030-05-01T09:00', old)).json.created).toBe(true);
    expect(await acksOf(t, hana.user.id)).toHaveLength(1);
    expect((await ackAt(hana.email, id, `${TODAY}T09:00`, TODAY_MS)).json.created).toBe(true);
    await room(t).runRetention(t.id, TODAY_MS); // a no-op if closing already did the day's housekeeping
    expect((await acksOf(t, hana.user.id)).map((x) => JSON.parse(x.json).occurrence)).toEqual([`${TODAY}T09:00`]);
    // closed stays closed: the same close again records nothing new
    expect((await ackAt(hana.email, id, `${TODAY}T09:00`, TODAY_MS)).json.created).toBe(false);
  });

  it('a yearly notification closed 11 months ago is not pruned, so it does not come back', async () => {
    const t = await workspace('Alpha');
    const hana = await member(t, 'hana');
    const id = await create(t, { recurrence: 'yearly', month: 11, day: 5 });
    const closedAt = businessMomentMs('2029-11-05', '10:00');
    expect((await ackAt(hana.email, id, '2029-11-05T09:00', closedAt)).json.created).toBe(true);
    await room(t).runRetention(t.id, businessMomentMs('2030-10-08', '10:00')); // 337 days later: older than 90 days, but still the CURRENT occurrence
    expect(await acksOf(t, hana.user.id)).toHaveLength(1);
  });
});
