/**
 * Scheduled in-system notifications (Stage 8E).
 *
 * Three different things, never mixed:
 *   - a DEFINITION   what an SV configured (title, message, recurrence, time, audience, enabled)            record kind `notification`
 *   - an OCCURRENCE  one moment the schedule produces ("daily 09:00 on 2026-10-08"); NEVER stored, always derived
 *   - an ACK         one person closing one occurrence                                                      record kind `notificationAck`
 *
 * Only definitions and acknowledgments are written, so a notification costs nothing until somebody closes it. Occurrences are derived from
 * the schedule and the BUSINESS clock (Asia/Tokyo, shared/businessTime.ts); the browser clock decides nothing that is stored: the server
 * accepts an acknowledgment only for an occurrence that really exists and is already due by the server's own clock.
 *
 * Missed occurrences do not stack: for each definition a person sees only the LATEST due occurrence they have not acknowledged. Plain TypeScript
 * with no dependencies: the browser and the Worker run the same code.
 */

export const RECURRENCES = ['daily', 'weekly', 'monthly', 'yearly'] as const;
export type Recurrence = (typeof RECURRENCES)[number];
export const AUDIENCE_KINDS = ['all', 'sv', 'testers', 'members'] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];

export const NOTIFICATION_LIMITS = {
  title: 80,
  message: 600,
  members: 50,
  /** Acknowledgments of occurrences older than this are no longer accepted (the latest due occurrence of any schedule is always newer). */
  lookbackDays: 370,
  /** An acknowledgment this old AND superseded by a newer occurrence is pruned. */
  ackRetentionDays: 90,
} as const;

export interface NotificationAudience {
  kind: AudienceKind;
  /** Stable Team Member ids; only for kind `members`. */
  memberIds?: string[];
}

export interface NotificationDef {
  /** `ntf_<uuid>` */
  id: string;
  title: string;
  message: string;
  recurrence: Recurrence;
  /** Business-time "HH:mm". */
  time: string;
  /** Weekly: ISO weekdays, 1 = Monday ... 7 = Sunday. */
  weekdays?: number[];
  /** Monthly: 1..31. A month without that day uses its LAST day. */
  dayOfMonth?: number;
  /** Yearly: month 1..12 and day 1..31. 29 February falls on 28 February in a common year; other missing days use the month's last day. */
  month?: number;
  day?: number;
  audience: NotificationAudience;
  enabled: boolean;
  /** First / last calendar day an occurrence may fall on (YYYY-MM-DD), both optional. */
  startDate?: string;
  endDate?: string;
  createdAt: string;
  updatedAt: string;
  /** Stamped by the server from the verified caller, never from the request. */
  createdByUserId: string;
  updatedByUserId: string;
}

export interface NotificationAck {
  /** `na_<notificationId>_<occurrenceKey>_<userId>` (derived: one acknowledgment per person and occurrence) */
  id: string;
  notificationId: string;
  /** `YYYY-MM-DDTHH:mm`, business time. */
  occurrence: string;
  userId: string;
  at: string;
}

export interface Occurrence {
  /** `YYYY-MM-DDTHH:mm` */
  key: string;
  date: string;
  time: string;
}

// ---- dates ----------------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const KEY = /^(\d{4}-\d{2}-\d{2})T(([01]\d|2[0-3]):[0-5]\d)$/;
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;

export function isDateString(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export const isTimeString = (v: unknown): v is string => typeof v === 'string' && TIME.test(v);

const toEpoch = (date: string): number => Math.floor(Date.parse(`${date}T00:00:00.000Z`) / 86_400_000);
const fromEpoch = (epoch: number): string => new Date(epoch * 86_400_000).toISOString().slice(0, 10);
const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** ISO weekday of a date: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The ONE place that decides what a calendar day number means in a month that is too short: the last day of that month. */
export function clampDay(year: number, month: number, day: number): number {
  return Math.min(day, daysInMonth(year, month));
}

// ---- schedule --------------------------------------------------------------------------------

/** Does the definition's schedule fall on this calendar day (ignoring the time and whether it is enabled)? */
export function occursOn(def: NotificationDef, date: string): boolean {
  if (def.startDate !== undefined && date < def.startDate) return false;
  if (def.endDate !== undefined && date > def.endDate) return false;
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  switch (def.recurrence) {
    case 'daily':
      return true;
    case 'weekly':
      return (def.weekdays ?? []).includes(isoWeekday(date));
    case 'monthly':
      return def.dayOfMonth !== undefined && day === clampDay(year, month, def.dayOfMonth);
    case 'yearly':
      return def.month === month && def.day !== undefined && day === clampDay(year, month, def.day);
  }
}

export const occurrenceKey = (date: string, time: string): string => `${date}T${time}`;

export function parseOccurrenceKey(key: unknown): Occurrence | null {
  if (typeof key !== 'string') return null;
  const m = KEY.exec(key);
  if (m === null || !isDateString(m[1])) return null;
  return { key, date: m[1], time: m[2] };
}

export interface BusinessNow {
  /** YYYY-MM-DD in the business time zone. */
  date: string;
  /** Minutes since midnight in the business time zone. */
  minutes: number;
}

/** The latest occurrence at or before `now`, or null (never within the look-back window, or not yet started). */
export function latestDue(def: NotificationDef, now: BusinessNow): Occurrence | null {
  const today = toEpoch(now.date);
  for (let back = 0; back <= NOTIFICATION_LIMITS.lookbackDays; back += 1) {
    const date = fromEpoch(today - back);
    if (!occursOn(def, date)) continue;
    if (back === 0 && minutesOf(def.time) > now.minutes) continue; // today's moment has not come yet: the previous one is the latest
    return { key: occurrenceKey(date, def.time), date, time: def.time };
  }
  return null;
}

/** The next occurrence strictly after `now`, or null when there is none within the next 400 days. */
export function nextOccurrence(def: NotificationDef, now: BusinessNow): Occurrence | null {
  const today = toEpoch(now.date);
  for (let ahead = 0; ahead <= 400; ahead += 1) {
    const date = fromEpoch(today + ahead);
    if (!occursOn(def, date)) continue;
    if (ahead === 0 && minutesOf(def.time) <= now.minutes) continue;
    return { key: occurrenceKey(date, def.time), date, time: def.time };
  }
  return null;
}

/** Is this key a real, already-due occurrence of the schedule that is not older than the look-back window? */
export function isAckableOccurrence(def: NotificationDef, key: unknown, now: BusinessNow): boolean {
  const occ = parseOccurrenceKey(key);
  if (occ === null || occ.time !== def.time || !occursOn(def, occ.date)) return false;
  if (occ.date > now.date || (occ.date === now.date && minutesOf(occ.time) > now.minutes)) return false; // not due yet
  return toEpoch(now.date) - toEpoch(occ.date) <= NOTIFICATION_LIMITS.lookbackDays;
}

// ---- who ------------------------------------------------------------------------------------

export interface Recipient {
  /** `admin` (SV) or `user` (Tester). */
  role: 'admin' | 'user';
  /** The person's Team Member profile, if they have one, and whether it is active. */
  memberId: string | null;
  memberActive: boolean;
}

export function audienceIncludes(audience: NotificationAudience, who: Recipient): boolean {
  if (who.memberId !== null && !who.memberActive) return false; // a removed person receives nothing from now on
  switch (audience.kind) {
    case 'all':
      return true;
    case 'sv':
      return who.role === 'admin';
    case 'testers':
      return who.role === 'user';
    case 'members':
      return who.memberId !== null && (audience.memberIds ?? []).includes(who.memberId);
  }
}

export const ackId = (notificationId: string, occurrence: string, userId: string): string => `na_${notificationId}_${occurrence}_${userId}`;

export interface DueNotification {
  def: NotificationDef;
  occurrence: Occurrence;
}

/**
 * What one person must see now: for every enabled definition addressed to them, its latest due occurrence, unless they already closed THAT
 * occurrence. A newer occurrence is a new notification; nothing older is ever shown beside it.
 */
export function dueFor(defs: readonly NotificationDef[], acks: readonly NotificationAck[], userId: string, who: Recipient, now: BusinessNow): DueNotification[] {
  const closed = new Set(acks.filter((a) => a.userId === userId).map((a) => `${a.notificationId}\u0000${a.occurrence}`));
  const out: DueNotification[] = [];
  for (const def of defs) {
    if (!def.enabled || !audienceIncludes(def.audience, who)) continue;
    const occurrence = latestDue(def, now);
    if (occurrence === null || closed.has(`${def.id}\u0000${occurrence.key}`)) continue;
    out.push({ def, occurrence });
  }
  return out.sort((a, b) => (a.occurrence.key < b.occurrence.key ? 1 : a.occurrence.key > b.occurrence.key ? -1 : a.def.title.localeCompare(b.def.title)));
}

/** The soonest moment (as an occurrence) any of these definitions next becomes due, for the in-app timer. */
export function soonestNext(defs: readonly NotificationDef[], now: BusinessNow): Occurrence | null {
  let best: Occurrence | null = null;
  for (const def of defs) {
    if (!def.enabled) continue;
    const next = nextOccurrence(def, now);
    if (next !== null && (best === null || next.key < best.key)) best = next;
  }
  return best;
}

/**
 * Should this acknowledgment be deleted? Only when it can never matter again: it is older than the retention window AND a newer occurrence of
 * the same definition has superseded it (or the definition is gone). The ack of the CURRENT latest occurrence is always kept, however old
 * (a yearly notification's is almost a year old), so pruning can never make a closed notification come back.
 */
export function ackIsPrunable(ack: NotificationAck, def: NotificationDef | undefined, now: BusinessNow): boolean {
  const occ = parseOccurrenceKey(ack.occurrence);
  const age = occ === null ? Infinity : toEpoch(now.date) - toEpoch(occ.date);
  if (age <= NOTIFICATION_LIMITS.ackRetentionDays) return false;
  if (def === undefined) return true;
  const current = latestDue(def, now);
  return current === null || ack.occurrence < current.key;
}

// ---- shapes -----------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function text(value: unknown, max: number): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function stamp(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 10 && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

export type Check<T> = { ok: true; value: T } | { ok: false; error: string };

export function checkNotification(raw: unknown): Check<NotificationDef> {
  if (!isObj(raw)) return { ok: false, error: 'notification_not_an_object' };
  if (typeof raw.id !== 'string' || !ID.test(raw.id) || !raw.id.startsWith('ntf_')) return { ok: false, error: 'notification_invalid_id' };
  if (!text(raw.title, NOTIFICATION_LIMITS.title) || raw.title.trim() === '') return { ok: false, error: 'notification_invalid_title' };
  if (!text(raw.message, NOTIFICATION_LIMITS.message)) return { ok: false, error: 'notification_invalid_message' };
  if (typeof raw.recurrence !== 'string' || !(RECURRENCES as readonly string[]).includes(raw.recurrence)) return { ok: false, error: 'notification_invalid_recurrence' };
  if (!isTimeString(raw.time)) return { ok: false, error: 'notification_invalid_time' };
  const wd = raw.weekdays;
  if (raw.recurrence === 'weekly') {
    if (!Array.isArray(wd) || wd.length === 0 || wd.length > 7 || !wd.every((d) => Number.isInteger(d) && d >= 1 && d <= 7) || new Set(wd).size !== wd.length) return { ok: false, error: 'notification_invalid_weekdays' };
  } else if (wd !== undefined) return { ok: false, error: 'notification_invalid_weekdays' };
  const dom = raw.dayOfMonth;
  if (raw.recurrence === 'monthly') {
    if (!Number.isInteger(dom) || (dom as number) < 1 || (dom as number) > 31) return { ok: false, error: 'notification_invalid_day' };
  } else if (dom !== undefined) return { ok: false, error: 'notification_invalid_day' };
  if (raw.recurrence === 'yearly') {
    if (!Number.isInteger(raw.month) || (raw.month as number) < 1 || (raw.month as number) > 12) return { ok: false, error: 'notification_invalid_month' };
    if (!Number.isInteger(raw.day) || (raw.day as number) < 1 || (raw.day as number) > daysInMonth(2024, raw.month as number)) return { ok: false, error: 'notification_invalid_day' };
  } else if (raw.month !== undefined || raw.day !== undefined) return { ok: false, error: 'notification_invalid_day' };
  const a = raw.audience;
  if (!isObj(a) || typeof a.kind !== 'string' || !(AUDIENCE_KINDS as readonly string[]).includes(a.kind)) return { ok: false, error: 'notification_invalid_audience' };
  if (a.kind === 'members') {
    const ids = a.memberIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > NOTIFICATION_LIMITS.members || !ids.every((x) => typeof x === 'string' && ID.test(x)) || new Set(ids).size !== ids.length) return { ok: false, error: 'notification_invalid_audience' };
  } else if (a.memberIds !== undefined) return { ok: false, error: 'notification_invalid_audience' };
  if (typeof raw.enabled !== 'boolean') return { ok: false, error: 'notification_invalid_enabled' };
  if (raw.startDate !== undefined && !isDateString(raw.startDate)) return { ok: false, error: 'notification_invalid_date' };
  if (raw.endDate !== undefined && !isDateString(raw.endDate)) return { ok: false, error: 'notification_invalid_date' };
  if (typeof raw.startDate === 'string' && typeof raw.endDate === 'string' && raw.endDate < raw.startDate) return { ok: false, error: 'notification_invalid_date' };
  if (!stamp(raw.createdAt) || !stamp(raw.updatedAt)) return { ok: false, error: 'notification_invalid_timestamp' };
  for (const f of ['createdByUserId', 'updatedByUserId']) if (typeof raw[f] !== 'string' || !ID.test(raw[f] as string)) return { ok: false, error: 'notification_invalid_actor' };
  return { ok: true, value: raw as unknown as NotificationDef };
}

export function checkNotificationAck(raw: unknown): Check<NotificationAck> {
  if (!isObj(raw)) return { ok: false, error: 'ack_not_an_object' };
  if (typeof raw.notificationId !== 'string' || !ID.test(raw.notificationId)) return { ok: false, error: 'ack_invalid_notification' };
  if (parseOccurrenceKey(raw.occurrence) === null) return { ok: false, error: 'ack_invalid_occurrence' };
  if (typeof raw.userId !== 'string' || !ID.test(raw.userId)) return { ok: false, error: 'ack_invalid_user' };
  if (raw.id !== ackId(raw.notificationId, raw.occurrence as string, raw.userId)) return { ok: false, error: 'ack_id_mismatch' };
  if (!stamp(raw.at)) return { ok: false, error: 'ack_invalid_timestamp' };
  return { ok: true, value: raw as unknown as NotificationAck };
}

export interface NotificationCommitInput {
  puts: ReadonlyArray<{ kind: string; id: string; json: string }>;
  deletes: ReadonlyArray<{ kind: string; id: string }>;
  view: { get(kind: string, id: string): string | null; list?(kind: string): Array<{ id: string; json: string }> };
  isSv: boolean;
  userId: string | undefined;
}

function parse(json: string | null): Obj | null {
  if (json === null) return null;
  try {
    const v: unknown = JSON.parse(json);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Rules for notification records that arrive as ordinary commits. Definitions: an SV only, well formed, the audience's members exist, and the
 * actor fields are the sender's (the UI goes through the server's own endpoints, which stamp them). Acknowledgments are never written by a
 * commit at all: only the server writes them, for the authenticated caller.
 */
export function notificationCommitError(input: NotificationCommitInput): string | null {
  const { puts, deletes, view, isSv, userId } = input;
  const touches = puts.some((p) => p.kind === 'notification' || p.kind === 'notificationAck') || deletes.some((d) => d.kind === 'notification' || d.kind === 'notificationAck');
  if (!touches) return null;
  if (puts.some((p) => p.kind === 'notificationAck') || deletes.some((d) => d.kind === 'notificationAck')) return 'ack_requires_api';
  if (!isSv) return 'notification_sv_only';
  for (const p of puts) {
    if (p.kind !== 'notification') continue;
    const check = checkNotification(parse(p.json));
    if (!check.ok) return check.error;
    const next = check.value;
    if (next.id !== p.id) return 'notification_id_mismatch';
    const prev = parse(view.get('notification', p.id));
    if (prev !== null && JSON.stringify(prev) === JSON.stringify(parse(p.json))) continue;
    if (userId === undefined || next.updatedByUserId !== userId) return 'notification_actor_mismatch';
    if (prev === null ? next.createdByUserId !== userId : prev.createdByUserId !== next.createdByUserId) return 'notification_actor_mismatch';
    if (next.audience.kind === 'members') {
      for (const m of next.audience.memberIds ?? []) {
        if (view.get('member', m) === null && !puts.some((q) => q.kind === 'member' && q.id === m)) return 'notification_member_not_found';
      }
    }
  }
  return null;
}

/** What an SV supplies for a definition (everything except the ids, stamps and actors, which the server sets). */
export type NotificationFields = Omit<NotificationDef, 'id' | 'createdAt' | 'updatedAt' | 'createdByUserId' | 'updatedByUserId'>;

/** Take an API request body and keep only the fields that belong to its recurrence; validate the result like a stored definition. */
export function parseNotificationInput(raw: unknown): Check<NotificationFields> {
  if (!isObj(raw)) return { ok: false, error: 'notification_not_an_object' };
  const title = typeof raw.title === 'string' ? raw.title.normalize('NFKC').replace(/\s+/g, ' ').trim() : raw.title;
  const message = typeof raw.message === 'string' ? raw.message.replace(/\r\n/g, '\n').trim() : raw.message;
  const base: Obj = {
    title,
    message: message ?? '',
    recurrence: raw.recurrence,
    time: raw.time,
    audience: isObj(raw.audience) ? (raw.audience.kind === 'members' ? { kind: 'members', memberIds: raw.audience.memberIds } : { kind: raw.audience.kind }) : raw.audience,
    enabled: raw.enabled === undefined ? true : raw.enabled,
  };
  if (raw.recurrence === 'weekly') base.weekdays = raw.weekdays;
  if (raw.recurrence === 'monthly') base.dayOfMonth = raw.dayOfMonth;
  if (raw.recurrence === 'yearly') {
    base.month = raw.month;
    base.day = raw.day;
  }
  if (typeof raw.startDate === 'string' && raw.startDate !== '') base.startDate = raw.startDate;
  if (typeof raw.endDate === 'string' && raw.endDate !== '') base.endDate = raw.endDate;
  const probe = { ...base, id: 'ntf_probe', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', createdByUserId: 'u', updatedByUserId: 'u' };
  const checked = checkNotification(probe);
  if (!checked.ok) return checked;
  const { id: _i, createdAt: _c, updatedAt: _u, createdByUserId: _cb, updatedByUserId: _ub, ...fields } = checked.value;
  return { ok: true, value: fields };
}
