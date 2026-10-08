import { describe, expect, it } from 'vitest';
import { businessClock, businessMomentMs } from '../../shared/businessTime';
import {
  ackId,
  ackIsPrunable,
  audienceIncludes,
  checkNotification,
  clampDay,
  dueFor,
  isAckableOccurrence,
  latestDue,
  nextOccurrence,
  notificationCommitError,
  occursOn,
  parseNotificationInput,
  soonestNext,
  type NotificationAck,
  type NotificationAudience,
  type NotificationDef,
  type Recipient,
} from '../../shared/notifications';
import { brandingCommitError, checkLogo, usableBranding, base64Bytes, LOGO_LIMITS } from '../../shared/branding';
import { retentionCutoff } from '../../shared/meeting';

const STAMP = '2026-10-01T00:00:00.000Z';
const def = (over: Partial<NotificationDef> = {}): NotificationDef => ({
  id: 'ntf_a1', title: 'Stand-up', message: 'Main room', recurrence: 'daily', time: '09:00', audience: { kind: 'all' }, enabled: true,
  createdAt: STAMP, updatedAt: STAMP, createdByUserId: 'usr_sv', updatedByUserId: 'usr_sv', ...over,
});
const at = (date: string, hhmm: string) => ({ date, minutes: Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) });
const tester: Recipient = { role: 'user', memberId: 'USER0002', memberActive: true };
const sv: Recipient = { role: 'admin', memberId: 'USER0001', memberActive: true };
const ack = (d: NotificationDef, occurrence: string, userId: string): NotificationAck => ({ id: ackId(d.id, occurrence, userId), notificationId: d.id, occurrence, userId, at: STAMP });

describe('the business clock decides, in Asia/Tokyo', () => {
  it('converts an instant to the business date and minute, across the UTC date line', () => {
    expect(businessClock(Date.parse('2026-10-08T14:59:00Z'))).toEqual({ date: '2026-10-08', minutes: 23 * 60 + 59 });
    expect(businessClock(Date.parse('2026-10-08T15:00:00Z'))).toEqual({ date: '2026-10-09', minutes: 0 }); // 00:00 in Tokyo is 15:00 UTC the day before
    expect(businessMomentMs('2026-10-09', '00:00')).toBe(Date.parse('2026-10-08T15:00:00Z'));
  });

  it('a 08:55 reminder is due at 23:55 UTC the evening before, not at the UTC date change', () => {
    const d = def({ time: '08:55' });
    expect(latestDue(d, businessClock(Date.parse('2026-10-07T23:54:00Z')))?.key).toBe('2026-10-07T08:55'); // 08:54 Tokyo: today's has not come
    expect(latestDue(d, businessClock(Date.parse('2026-10-07T23:55:00Z')))?.key).toBe('2026-10-08T08:55'); // 08:55 Tokyo
  });
});

describe('recurrence', () => {
  it('daily: every day, at the time', () => {
    const d = def();
    expect(occursOn(d, '2026-10-08')).toBe(true);
    expect(latestDue(d, at('2026-10-08', '09:00'))?.key).toBe('2026-10-08T09:00');
    expect(latestDue(d, at('2026-10-08', '08:59'))?.key).toBe('2026-10-07T09:00');
    expect(nextOccurrence(d, at('2026-10-08', '09:00'))?.key).toBe('2026-10-09T09:00');
  });

  it('weekly: the chosen weekdays only (ISO: Monday = 1)', () => {
    const d = def({ recurrence: 'weekly', weekdays: [1, 4] }); // Monday and Thursday
    expect(occursOn(d, '2026-10-08')).toBe(true); // Thursday
    expect(occursOn(d, '2026-10-12')).toBe(true); // Monday
    expect(occursOn(d, '2026-10-09')).toBe(false); // Friday
    expect(latestDue(d, at('2026-10-11', '12:00'))?.key).toBe('2026-10-08T09:00'); // Sunday: the Thursday before
    expect(nextOccurrence(d, at('2026-10-08', '09:00'))?.key).toBe('2026-10-12T09:00');
  });

  it('monthly: a day that a month does not have falls on the LAST day of that month', () => {
    const d = def({ recurrence: 'monthly', dayOfMonth: 31 });
    expect(occursOn(d, '2026-10-31')).toBe(true);
    expect(occursOn(d, '2026-11-30')).toBe(true); // November has 30 days
    expect(occursOn(d, '2026-11-29')).toBe(false);
    expect(occursOn(d, '2026-02-28')).toBe(true); // common year
    expect(occursOn(d, '2028-02-29')).toBe(true); // leap year
    expect(occursOn(d, '2028-02-28')).toBe(false);
    expect(clampDay(2026, 4, 31)).toBe(30);
    expect(occursOn(def({ recurrence: 'monthly', dayOfMonth: 25, time: '17:00' }), '2026-10-25')).toBe(true);
  });

  it('yearly: month and day; 29 February falls on 28 February in a common year', () => {
    const d = def({ recurrence: 'yearly', month: 4, day: 1 });
    expect(occursOn(d, '2027-04-01')).toBe(true);
    expect(occursOn(d, '2027-04-02')).toBe(false);
    const leap = def({ recurrence: 'yearly', month: 2, day: 29 });
    expect(occursOn(leap, '2028-02-29')).toBe(true);
    expect(occursOn(leap, '2028-02-28')).toBe(false);
    expect(occursOn(leap, '2027-02-28')).toBe(true);
    expect(latestDue(leap, at('2027-06-01', '12:00'))?.key).toBe('2027-02-28T09:00');
  });

  it('respects the first and last day, and never produces an occurrence outside them', () => {
    const d = def({ startDate: '2026-10-10', endDate: '2026-10-12' });
    expect(latestDue(d, at('2026-10-09', '12:00'))).toBeNull();
    expect(latestDue(d, at('2026-10-20', '12:00'))?.key).toBe('2026-10-12T09:00'); // the last real one stays the latest
    expect(nextOccurrence(d, at('2026-10-12', '12:00'))).toBeNull();
  });
});

describe('what a person must see', () => {
  const d = def();

  it('a due occurrence is shown; a future one is not; an hour before is not due', () => {
    expect(dueFor([d], [], 'usr_t', tester, at('2026-10-08', '09:00')).map((x) => x.occurrence.key)).toEqual(['2026-10-08T09:00']);
    expect(dueFor([d], [], 'usr_t', tester, at('2026-10-08', '08:00')).map((x) => x.occurrence.key)).toEqual(['2026-10-07T09:00']); // the previous one is the latest due
    expect(dueFor([def({ startDate: '2026-12-01' })], [], 'usr_t', tester, at('2026-10-08', '10:00'))).toEqual([]);
  });

  it('closing hides it for THAT person only', () => {
    const closed = [ack(d, '2026-10-08T09:00', 'usr_t')];
    expect(dueFor([d], closed, 'usr_t', tester, at('2026-10-08', '10:00'))).toEqual([]);
    expect(dueFor([d], closed, 'usr_other', tester, at('2026-10-08', '10:00'))).toHaveLength(1); // another person still sees it
  });

  it('the next occurrence appears again even though the last one was closed', () => {
    const closed = [ack(d, '2026-10-08T09:00', 'usr_t')];
    expect(dueFor([d], closed, 'usr_t', tester, at('2026-10-09', '09:00')).map((x) => x.occurrence.key)).toEqual(['2026-10-09T09:00']);
  });

  it('absent for days: ONLY the latest due occurrence, not one per missed day', () => {
    const items = dueFor([d], [], 'usr_t', tester, at('2026-10-13', '10:00'));
    expect(items).toHaveLength(1);
    expect(items[0].occurrence.key).toBe('2026-10-13T09:00');
    const weekly = def({ id: 'ntf_w', recurrence: 'weekly', weekdays: [1] });
    expect(dueFor([weekly], [], 'usr_t', tester, at('2026-11-20', '12:00')).map((x) => x.occurrence.key)).toEqual(['2026-11-16T09:00']);
    const monthly = def({ id: 'ntf_m', recurrence: 'monthly', dayOfMonth: 25 });
    expect(dueFor([monthly], [], 'usr_t', tester, at('2026-12-05', '12:00')).map((x) => x.occurrence.key)).toEqual(['2026-11-25T09:00']);
  });

  it('a disabled definition is absent', () => {
    expect(dueFor([def({ enabled: false })], [], 'usr_t', tester, at('2026-10-08', '10:00'))).toEqual([]);
  });

  it('several notifications are listed newest occurrence first', () => {
    const a = def({ id: 'ntf_a', title: 'A', time: '08:00' });
    const b = def({ id: 'ntf_b', title: 'B', time: '09:30' });
    expect(dueFor([a, b], [], 'usr_t', tester, at('2026-10-08', '10:00')).map((x) => x.def.title)).toEqual(['B', 'A']);
  });
});

describe('audience', () => {
  it('All, SV only, Testers only, specific members', () => {
    expect(audienceIncludes({ kind: 'all' }, tester) && audienceIncludes({ kind: 'all' }, sv)).toBe(true);
    expect([audienceIncludes({ kind: 'sv' }, sv), audienceIncludes({ kind: 'sv' }, tester)]).toEqual([true, false]);
    expect([audienceIncludes({ kind: 'testers' }, tester), audienceIncludes({ kind: 'testers' }, sv)]).toEqual([true, false]);
    const only = { kind: 'members' as const, memberIds: ['USER0002'] };
    expect([audienceIncludes(only, tester), audienceIncludes(only, sv), audienceIncludes(only, { role: 'user', memberId: null, memberActive: true })]).toEqual([true, false, false]);
  });

  it('a removed person receives nothing from then on, whatever the audience', () => {
    const gone: Recipient = { ...tester, memberActive: false };
    for (const a of [{ kind: 'all' }, { kind: 'testers' }, { kind: 'members', memberIds: ['USER0002'] }] as NotificationAudience[]) expect(audienceIncludes(a, gone)).toBe(false);
  });

  it('an account with no profile still gets All / SV / Testers notifications', () => {
    const noProfile: Recipient = { role: 'user', memberId: null, memberActive: true };
    expect(audienceIncludes({ kind: 'all' }, noProfile) && audienceIncludes({ kind: 'testers' }, noProfile)).toBe(true);
  });
});

describe('the server accepts an acknowledgment only for a real, due occurrence', () => {
  const d = def({ recurrence: 'weekly', weekdays: [4] });
  const now = at('2026-10-08', '10:00');
  it('accepts the due occurrence; refuses a future one, a wrong time, a day the schedule skips, nonsense and a very old one', () => {
    expect(isAckableOccurrence(d, '2026-10-08T09:00', now)).toBe(true);
    expect(isAckableOccurrence(d, '2026-10-15T09:00', now)).toBe(false); // next Thursday
    expect(isAckableOccurrence(d, '2026-10-08T11:00', now)).toBe(false); // the schedule is 09:00
    expect(isAckableOccurrence(d, '2026-10-09T09:00', now)).toBe(false); // a Friday
    expect(isAckableOccurrence(d, '2026-10-08T23:00', now)).toBe(false);
    expect(isAckableOccurrence(d, 'x', now) || isAckableOccurrence(d, '2026-13-01T09:00', now) || isAckableOccurrence(d, 123, now)).toBe(false);
    expect(isAckableOccurrence(d, '2025-01-02T09:00', now)).toBe(false); // older than the look-back
    expect(isAckableOccurrence(d, '2026-10-08T10:00', { date: '2026-10-08', minutes: 9 * 60 })).toBe(false); // not yet today
  });
});

describe('pruning acknowledgments never makes a closed notification come back', () => {
  const daily = def();
  const now = at('2026-10-08', '10:00');
  it('an old, superseded acknowledgment is pruned; a recent one is kept', () => {
    expect(ackIsPrunable(ack(daily, '2026-06-01T09:00', 'usr_t'), daily, now)).toBe(true);
    expect(ackIsPrunable(ack(daily, '2026-09-20T09:00', 'usr_t'), daily, now)).toBe(false); // inside the retention window
    expect(ackIsPrunable(ack(daily, '2026-10-08T09:00', 'usr_t'), daily, now)).toBe(false);
  });

  it('the acknowledgment of the CURRENT latest occurrence is kept however old: a yearly one is almost a year old', () => {
    const yearly = def({ id: 'ntf_y', recurrence: 'yearly', month: 1, day: 5 });
    const closed = ack(yearly, '2026-01-05T09:00', 'usr_t');
    expect(ackIsPrunable(closed, yearly, now)).toBe(false);
    // ... and pruning everything that may be pruned leaves it closed
    const kept = [closed].filter((a) => !ackIsPrunable(a, yearly, now));
    expect(dueFor([yearly], kept, 'usr_t', tester, now)).toEqual([]);
  });

  it('pruning old ones never changes what is due now', () => {
    const acks = [ack(daily, '2026-05-01T09:00', 'usr_t'), ack(daily, '2026-10-08T09:00', 'usr_t')];
    const kept = acks.filter((a) => !ackIsPrunable(a, daily, now));
    expect(kept).toHaveLength(1);
    expect(dueFor([daily], acks, 'usr_t', tester, now)).toEqual(dueFor([daily], kept, 'usr_t', tester, now));
  });

  it('an acknowledgment of a definition that no longer exists goes once it is old', () => {
    expect(ackIsPrunable(ack(daily, '2026-06-01T09:00', 'usr_t'), undefined, now)).toBe(true);
    expect(ackIsPrunable(ack(daily, '2026-10-01T09:00', 'usr_t'), undefined, now)).toBe(false);
  });
});

describe('the in-app timer', () => {
  it('waits for the nearest future occurrence of an enabled definition', () => {
    const a = def({ id: 'ntf_a', time: '12:00' });
    const b = def({ id: 'ntf_b', time: '10:30' });
    const off = def({ id: 'ntf_c', time: '10:05', enabled: false });
    expect(soonestNext([a, b, off], at('2026-10-08', '10:00'))?.key).toBe('2026-10-08T10:30');
    expect(soonestNext([off], at('2026-10-08', '10:00'))).toBeNull();
  });
});

describe('definitions: shape and input', () => {
  const body = { title: '  Weekly   review ', message: 'Bring issues', recurrence: 'weekly', time: '09:00', weekdays: [1], audience: { kind: 'testers' }, junk: 'ignored' };
  it('accepts a good request, cleaning the text and ignoring unknown fields; fields of other recurrences are dropped', () => {
    const r = parseNotificationInput({ ...body, dayOfMonth: 5, month: 3 });
    expect(r.ok && r.value).toMatchObject({ title: 'Weekly review', recurrence: 'weekly', weekdays: [1], enabled: true });
    expect(r.ok && 'dayOfMonth' in r.value).toBe(false);
    expect(r.ok && 'junk' in r.value).toBe(false);
  });

  it('refuses what cannot be scheduled', () => {
    const bad = (over: Record<string, unknown>) => {
      const r = parseNotificationInput({ ...body, ...over });
      return r.ok ? 'ok' : r.error;
    };
    expect(bad({ title: '   ' })).toBe('notification_invalid_title');
    expect(bad({ time: '25:00' })).toBe('notification_invalid_time');
    expect(bad({ weekdays: [] })).toBe('notification_invalid_weekdays');
    expect(bad({ weekdays: [8] })).toBe('notification_invalid_weekdays');
    expect(bad({ recurrence: 'monthly', dayOfMonth: 32 })).toBe('notification_invalid_day');
    expect(bad({ recurrence: 'monthly', dayOfMonth: 0 })).toBe('notification_invalid_day');
    expect(bad({ recurrence: 'yearly', month: 13, day: 1 })).toBe('notification_invalid_month');
    expect(bad({ recurrence: 'yearly', month: 4, day: 31 })).toBe('notification_invalid_day');
    expect(bad({ recurrence: 'yearly', month: 2, day: 29 })).toBe('ok');
    expect(bad({ audience: { kind: 'members', memberIds: [] } })).toBe('notification_invalid_audience');
    expect(bad({ audience: { kind: 'everyone' } })).toBe('notification_invalid_audience');
    expect(bad({ recurrence: 'hourly' })).toBe('notification_invalid_recurrence');
    expect(bad({ startDate: '2026-10-10', endDate: '2026-10-01' })).toBe('notification_invalid_date');
    expect(bad({ message: 'x'.repeat(601) })).toBe('notification_invalid_message');
  });

  it('a message is plain text: markup is kept as text, never interpreted, and control characters are refused', () => {
    const r = parseNotificationInput({ ...body, message: '<img src=x onerror=alert(1)>' });
    expect(r.ok && r.value.message).toBe('<img src=x onerror=alert(1)>');
    expect(parseNotificationInput({ ...body, message: 'a\u0000b' }).ok).toBe(false);
  });

  it('checkNotification rejects a stored definition with a missing actor or bad id', () => {
    expect(checkNotification(def()).ok).toBe(true);
    expect(checkNotification({ ...def(), id: 'x1' }).ok).toBe(false);
    expect(checkNotification({ ...def(), updatedByUserId: undefined }).ok).toBe(false);
  });
});

describe('who may write notification records by commit', () => {
  const view = (records: Record<string, object> = {}) => ({ get: (k: string, id: string) => (records[`${k}:${id}`] === undefined ? null : JSON.stringify(records[`${k}:${id}`])), list: () => [] });
  const put = (kind: string, value: object) => ({ kind, id: (value as { id: string }).id, json: JSON.stringify(value) });
  const run = (puts: ReturnType<typeof put>[], isSv: boolean, userId = 'usr_sv', v = view()) => notificationCommitError({ puts, deletes: [], view: v, isSv, userId });

  it('an SV may write a definition they stamped themselves; a Tester may not; a forged actor is refused', () => {
    expect(run([put('notification', def())], true)).toBeNull();
    expect(run([put('notification', def())], false, 'usr_t')).toBe('notification_sv_only');
    expect(run([put('notification', def({ updatedByUserId: 'usr_someone_else' }))], true)).toBe('notification_actor_mismatch');
    expect(run([put('notification', def({ createdByUserId: 'usr_someone_else' }))], true)).toBe('notification_actor_mismatch');
  });

  it('an unchanged definition is not re-checked; the creator of an existing one cannot be rewritten', () => {
    const existing = def({ createdByUserId: 'usr_old', updatedByUserId: 'usr_old' });
    expect(run([put('notification', existing)], true, 'usr_sv', view({ 'notification:ntf_a1': existing }))).toBeNull();
    expect(run([put('notification', { ...existing, title: 'Renamed', updatedByUserId: 'usr_sv', createdByUserId: 'usr_sv' })], true, 'usr_sv', view({ 'notification:ntf_a1': existing }))).toBe('notification_actor_mismatch');
  });

  it('a specific-members audience must name members of this workspace', () => {
    const d = def({ audience: { kind: 'members', memberIds: ['USER0009'] } });
    expect(run([put('notification', d)], true)).toBe('notification_member_not_found');
    expect(run([put('notification', d)], true, 'usr_sv', view({ 'member:USER0009': { id: 'USER0009' } }))).toBeNull();
  });

  it('acknowledgments are never written by a commit - not by a Tester, not by an SV, not deleted', () => {
    const a = ack(def(), '2026-10-08T09:00', 'usr_t');
    expect(run([put('notificationAck', a)], false, 'usr_t')).toBe('ack_requires_api');
    expect(run([put('notificationAck', a)], true)).toBe('ack_requires_api');
    expect(notificationCommitError({ puts: [], deletes: [{ kind: 'notificationAck', id: a.id }], view: view(), isSv: true, userId: 'usr_sv' })).toBe('ack_requires_api');
  });
});

// ---- the logo ---------------------------------------------------------------------------------------

const b64 = (bytes: number[]): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const WEBP = b64([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);

describe('workspace logo validation', () => {
  it('accepts PNG, JPEG and WebP whose bytes really are that type', () => {
    expect(checkLogo('image/png', PNG)).toMatchObject({ ok: true, bytes: 12 });
    expect(checkLogo('image/jpeg', JPEG).ok).toBe(true);
    expect(checkLogo('image/webp', WEBP).ok).toBe(true);
  });

  it('rejects SVG and any other type, however the file is named', () => {
    expect(checkLogo('image/svg+xml', b64([0x3c, 0x73, 0x76, 0x67, 0x20, 0x78, 0x6d, 0x6c, 0x6e, 0x73, 0x3d, 0x22]))).toEqual({ ok: false, error: 'logo_invalid_type' });
    for (const bad of ['image/gif', 'text/html', 'application/pdf', '', undefined, 7]) expect(checkLogo(bad, PNG)).toEqual({ ok: false, error: 'logo_invalid_type' });
  });

  it('rejects a declared type that does not match the real file signature', () => {
    expect(checkLogo('image/png', JPEG)).toEqual({ ok: false, error: 'logo_type_mismatch' });
    expect(checkLogo('image/jpeg', WEBP)).toEqual({ ok: false, error: 'logo_type_mismatch' });
    expect(checkLogo('image/webp', b64(Array.from('<html>hello!!'.split(''), (c) => c.charCodeAt(0))))).toEqual({ ok: false, error: 'logo_type_mismatch' });
  });

  it('rejects malformed base64, and enforces the size limit on the DECODED image', () => {
    for (const bad of ['', 'not base64!!', 'abc', 'iVBOR@@@', 7]) expect(checkLogo('image/png', bad).ok, String(bad)).toBe(false);
    const big = PNG.slice(0, -4) + 'A'.repeat(Math.ceil((LOGO_LIMITS.maxBytes + 3) / 3) * 4);
    expect(checkLogo('image/png', big)).toEqual({ ok: false, error: 'logo_too_large' });
    const exactly = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(LOGO_LIMITS.maxBytes - 8).fill(0)]);
    expect(base64Bytes(exactly)).toBe(LOGO_LIMITS.maxBytes);
    expect(checkLogo('image/png', exactly).ok).toBe(true);
  });

  it('a stored record that is damaged or unsupported is simply not used (no error, no broken image)', () => {
    const good = { id: 'branding', mime: 'image/png', data: PNG, bytes: 12, updatedAt: STAMP, updatedByUserId: 'usr_sv' };
    expect(usableBranding(good)).not.toBeNull();
    for (const bad of [null, 'x', { ...good, id: 'other' }, { ...good, mime: 'image/svg+xml' }, { ...good, data: 'AAAA' }, { ...good, data: '!!!!' }]) expect(usableBranding(bad)).toBeNull();
  });

  it('by commit (a restore): an SV only, the whole payload re-checked, the actor the sender\'s', () => {
    const rec = { id: 'branding', mime: 'image/png', data: PNG, bytes: 12, updatedAt: STAMP, updatedByUserId: 'usr_sv' };
    const put = (r: object) => ({ kind: 'branding', id: 'branding', json: JSON.stringify(r) });
    expect(brandingCommitError({ puts: [put(rec)], deletes: [], isSv: true, userId: 'usr_sv' })).toBeNull();
    expect(brandingCommitError({ puts: [put(rec)], deletes: [], isSv: false, userId: 'usr_t' })).toBe('branding_sv_only');
    expect(brandingCommitError({ puts: [put({ ...rec, updatedByUserId: 'usr_x' })], deletes: [], isSv: true, userId: 'usr_sv' })).toBe('branding_actor_mismatch');
    expect(brandingCommitError({ puts: [put({ ...rec, mime: 'image/svg+xml' })], deletes: [], isSv: true, userId: 'usr_sv' })).toBe('logo_invalid_type');
    expect(brandingCommitError({ puts: [put({ ...rec, bytes: 99 })], deletes: [], isSv: true, userId: 'usr_sv' })).toBe('logo_invalid_data');
  });
});

describe('the retention cutoff', () => {
  it('is today minus the days; a day exactly at the cutoff is kept', () => {
    expect(retentionCutoff('2026-10-08', 365)).toBe('2025-10-08');
    expect(retentionCutoff('2026-10-08', 90)).toBe('2026-07-10');
    expect(retentionCutoff('2026-03-01', 730)).toBe('2024-03-01');
  });
});
