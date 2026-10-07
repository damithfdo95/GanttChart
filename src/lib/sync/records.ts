/**
 * Shared-workspace record mapping.
 *
 * The shared server stores opaque records keyed by (kind, id). This module is
 * the ONLY place that maps the app's `ReportsState` to those records and back,
 * and it decides what is SHARED and what stays on the device:
 *
 *   shared   projects, reports, attendance, topics, tester assignments,
 *            reviews, RCS members, identity audit log, external identities,
 *            and the shared report settings
 *   local    ReportsState.activeProjectId, ReportsState.schemaVersion,
 *            settings.autoBackup (a per-device folder handle), and everything
 *            in AppState that is a UI preference (language, dashboardView)
 *
 * Pure functions, no I/O, no React — fully unit-testable and importable from
 * the Worker test project.
 */

import type {
  AttendanceRecord,
  CaseResult,
  Cycle,
  TestCase,
  TestScope,
  DailyReport,
  DailyTopic,
  ExternalIdentity,
  IdentityAuditEntry,
  ProjectRecord,
  RcsMember,
  ReportSettings,
  ReportsState,
  TesterProjectAssignment,
  TesterReview,
} from '../../types';
import type { RecordDelete, RecordKind, RecordPut } from '../../../shared/protocol';

/** Key of a record in maps: kind and id can never collide because of the NUL separator. */
export type RecordKey = string;

export function recordKey(kind: RecordKind, id: string): RecordKey {
  return `${kind}\u0000${id}`;
}

export function splitRecordKey(key: RecordKey): { kind: RecordKind; id: string } {
  const i = key.indexOf('\u0000');
  return { kind: key.slice(0, i) as RecordKind, id: key.slice(i + 1) };
}

/** The single shared settings record. */
export const SETTINGS_RECORD_ID = 'settings';

type Identified = { id: string };

/**
 * Deterministic order per kind, so every client rebuilds the same array order
 * from the same records (snapshots arrive sorted by kind/id, not by creation).
 */
const ORDER: Record<Exclude<RecordKind, 'settings'>, (record: never) => string> = {
  project: (r: ProjectRecord) => r.createdAt ?? '',
  report: (r: DailyReport) => r.createdAt ?? '',
  attendance: (r: AttendanceRecord) => r.date ?? '',
  topic: (r: DailyTopic) => r.createdAt ?? '',
  assignment: (r: TesterProjectAssignment) => r.startDate ?? '',
  review: (r: TesterReview) => r.createdAt ?? '',
  member: (r: RcsMember) => r.name ?? '',
  identityAudit: (r: IdentityAuditEntry) => r.timestamp ?? '',
  externalIdentity: (r: ExternalIdentity) => r.id,
  cycle: (r: Cycle) => r.plannedStart ?? r.createdAt ?? '',
  scope: (r: TestScope) => String(r.order).padStart(9, '0'),
  testCase: (r: TestCase) => String(r.order).padStart(9, '0'),
  caseResult: (r: CaseResult) => r.updatedAt ?? '',
};

function sortKind<T extends Identified>(kind: Exclude<RecordKind, 'settings'>, items: T[]): T[] {
  const orderOf = ORDER[kind] as (record: T) => string;
  return [...items].sort((a, b) => {
    const ka = orderOf(a);
    const kb = orderOf(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Settings without the per-device fields. */
export function sharedSettings(settings: ReportSettings): Omit<ReportSettings, 'autoBackup'> {
  const { autoBackup: _autoBackup, ...shared } = settings;
  return shared;
}

type ArrayField = {
  kind: Exclude<RecordKind, 'settings'>;
  read: (state: ReportsState) => Identified[];
  write: (state: ReportsState, items: Identified[]) => ReportsState;
};

const ARRAY_FIELDS: ArrayField[] = [
  { kind: 'project', read: (s) => s.projects, write: (s, v) => ({ ...s, projects: v as ProjectRecord[] }) },
  { kind: 'report', read: (s) => s.reports, write: (s, v) => ({ ...s, reports: v as DailyReport[] }) },
  { kind: 'attendance', read: (s) => s.attendance, write: (s, v) => ({ ...s, attendance: v as AttendanceRecord[] }) },
  { kind: 'topic', read: (s) => s.topics, write: (s, v) => ({ ...s, topics: v as DailyTopic[] }) },
  { kind: 'assignment', read: (s) => s.testerAssignments ?? [], write: (s, v) => ({ ...s, testerAssignments: v as TesterProjectAssignment[] }) },
  { kind: 'review', read: (s) => s.reviews ?? [], write: (s, v) => ({ ...s, reviews: v as TesterReview[] }) },
  { kind: 'member', read: (s) => s.rcsMembers ?? [], write: (s, v) => ({ ...s, rcsMembers: v as RcsMember[] }) },
  { kind: 'identityAudit', read: (s) => s.identityAuditLog ?? [], write: (s, v) => ({ ...s, identityAuditLog: v as IdentityAuditEntry[] }) },
  { kind: 'externalIdentity', read: (s) => s.externalIdentities ?? [], write: (s, v) => ({ ...s, externalIdentities: v as ExternalIdentity[] }) },
  { kind: 'cycle', read: (s) => s.cycles ?? [], write: (s, v) => ({ ...s, cycles: v as Cycle[] }) },
  { kind: 'scope', read: (s) => s.scopes ?? [], write: (s, v) => ({ ...s, scopes: v as TestScope[] }) },
  { kind: 'testCase', read: (s) => s.testCases ?? [], write: (s, v) => ({ ...s, testCases: v as TestCase[] }) },
  { kind: 'caseResult', read: (s) => s.caseResults ?? [], write: (s, v) => ({ ...s, caseResults: v as CaseResult[] }) },
];

const FIELD_BY_KIND = new Map(ARRAY_FIELDS.map((f) => [f.kind, f]));

/** Every SHARED record of a reports state, keyed. */
export function reportsToRecords(state: ReportsState): Map<RecordKey, RecordPut> {
  const out = new Map<RecordKey, RecordPut>();
  for (const field of ARRAY_FIELDS) {
    for (const item of field.read(state)) {
      out.set(recordKey(field.kind, item.id), { kind: field.kind, id: item.id, json: JSON.stringify(item) });
    }
  }
  out.set(recordKey('settings', SETTINGS_RECORD_ID), {
    kind: 'settings',
    id: SETTINGS_RECORD_ID,
    json: JSON.stringify(sharedSettings(state.settings)),
  });
  return out;
}

/** A record that cannot be parsed is skipped, never applied half-way. */
function parseRecord(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Patch a reports state with remote record changes. Only the touched records
 * change; everything else (including unsaved local edits to OTHER records and
 * all per-device fields) is preserved. Returns the same reference when nothing
 * changed.
 */
export function applyRecordChanges(state: ReportsState, puts: readonly RecordPut[], deletes: readonly RecordDelete[]): ReportsState {
  let next = state;
  const touchedKinds = new Set<Exclude<RecordKind, 'settings'>>();
  const byKind = new Map<Exclude<RecordKind, 'settings'>, { puts: Map<string, Identified>; deletes: Set<string> }>();
  const bucket = (kind: Exclude<RecordKind, 'settings'>) => {
    let b = byKind.get(kind);
    if (b === undefined) {
      b = { puts: new Map(), deletes: new Set() };
      byKind.set(kind, b);
    }
    return b;
  };

  for (const put of puts) {
    const parsed = parseRecord(put.json);
    if (!isObject(parsed)) continue; // never apply a record we cannot read
    if (put.kind === 'settings') {
      const local = next.settings.autoBackup;
      const merged = { ...(parsed as unknown as Omit<ReportSettings, 'autoBackup'>), ...(local !== undefined ? { autoBackup: local } : {}) } as ReportSettings;
      if (JSON.stringify(sharedSettings(merged)) !== JSON.stringify(sharedSettings(next.settings))) next = { ...next, settings: merged };
      continue;
    }
    bucket(put.kind).puts.set(put.id, { ...(parsed as object), id: put.id } as Identified);
    touchedKinds.add(put.kind);
  }
  for (const del of deletes) {
    if (del.kind === 'settings') continue; // the settings record is never deleted
    bucket(del.kind).deletes.add(del.id);
    touchedKinds.add(del.kind);
  }

  for (const kind of touchedKinds) {
    const field = FIELD_BY_KIND.get(kind)!;
    const b = byKind.get(kind)!;
    const current = field.read(next);
    const seen = new Set<string>();
    let changed = false;
    const merged: Identified[] = [];
    for (const item of current) {
      if (b.deletes.has(item.id)) {
        changed = true;
        continue;
      }
      const replacement = b.puts.get(item.id);
      if (replacement !== undefined) {
        seen.add(item.id);
        if (JSON.stringify(replacement) !== JSON.stringify(item)) changed = true;
        merged.push(replacement);
      } else {
        merged.push(item);
      }
    }
    for (const [id, item] of b.puts) {
      if (!seen.has(id) && !b.deletes.has(id)) {
        merged.push(item);
        changed = true;
      }
    }
    if (changed) next = field.write(next, sortKind(kind, merged));
  }

  // A remotely deleted active project must not leave a dangling pointer, and a
  // device that had no project selected (fresh link) must land on a real one:
  // the Dashboard edits the ACTIVE project, so "none" with projects present
  // would send edits nowhere.
  const activeMissing = next.activeProjectId !== null && !next.projects.some((p) => p.id === next.activeProjectId);
  if (activeMissing || (next.activeProjectId === null && next.projects.length > 0)) {
    next = { ...next, activeProjectId: next.projects[0]?.id ?? null };
  }
  return next;
}

/**
 * Build a reports state from a full set of shared records, keeping the
 * per-device fields of `local` (activeProjectId, schemaVersion, autoBackup).
 */
export function reportsFromRecords(records: readonly RecordPut[], local: ReportsState): ReportsState {
  const empty: ReportsState = {
    ...local,
    projects: [],
    reports: [],
    attendance: [],
    topics: [],
    testerAssignments: [],
    reviews: [],
    rcsMembers: [],
    identityAuditLog: [],
    externalIdentities: [],
    cycles: [],
    scopes: [],
    testCases: [],
    caseResults: [],
  };
  const built = applyRecordChanges(empty, records, []);
  // The device's own project selection survives if that project still exists.
  const active = local.activeProjectId !== null && built.projects.some((p) => p.id === local.activeProjectId) ? local.activeProjectId : (built.projects[0]?.id ?? null);
  return { ...built, activeProjectId: active };
}

/** Counts shown to the user before they choose how to link a device. */
export interface WorkspaceCounts {
  projects: number;
  reports: number;
  attendance: number;
  topics: number;
  members: number;
  other: number;
}

export function countRecords(records: Iterable<{ kind: RecordKind }>): WorkspaceCounts {
  const c: WorkspaceCounts = { projects: 0, reports: 0, attendance: 0, topics: 0, members: 0, other: 0 };
  for (const r of records) {
    if (r.kind === 'project') c.projects += 1;
    else if (r.kind === 'report') c.reports += 1;
    else if (r.kind === 'attendance') c.attendance += 1;
    else if (r.kind === 'topic') c.topics += 1;
    else if (r.kind === 'member') c.members += 1;
    else if (r.kind !== 'settings') c.other += 1;
  }
  return c;
}

/**
 * Does this reports state hold data a user would be upset to lose? A fresh
 * install (seeded demo project, default roster, untouched) does not — it is
 * safe to replace silently with the shared workspace. Anything entered by a
 * person does.
 */
export function hasMeaningfulLocalData(state: ReportsState): boolean {
  if (state.reports.length > 0 || state.attendance.length > 0 || state.topics.length > 0) return true;
  if ((state.testerAssignments ?? []).length > 0 || (state.reviews ?? []).length > 0) return true;
  if ((state.identityAuditLog ?? []).length > 0 || (state.externalIdentities ?? []).length > 0) return true;
  if ((state.cycles ?? []).length > 0) return true;
  if ((state.scopes ?? []).length > 0 || (state.testCases ?? []).length > 0) return true;
  if (state.projects.length >= 2) return true;
  // The seeded project is only bumped (updatedAt) by a real data change.
  return state.projects.some((p) => p.updatedAt !== p.createdAt);
}
