/**
 * Workspace database I/O (V6.6 database migration, §16/§23/§25/§37).
 *
 * Shared engine behind the persistence backend and the localStorage
 * migration: reads all stores back and rebuilds the workspace parts, and
 * writes changed records only (diffed, targeted writes —never the whole
 * database on every small change) inside ONE readwrite transaction so a
 * workspace save is atomic.
 */

import type { ReportsState } from '../../../types';
import {
  META_KEY_APP_STATE,
  META_KEY_COLLECTION,
  META_KEY_REPORTS_CORE,
  STORE_ATTENDANCE,
  STORE_DAILY_ACTUALS,
  STORE_METADATA,
  STORE_PROJECTS,
  STORE_REPORTS,
  STORE_REVISION_HISTORY,
  STORE_TOPICS,
  getAllFromStore,
  getFromStore,
  withReadWriteTx,
} from './repository';
import { splitWorkspace, dailyActualRowKey, type WorkspaceParts } from './workspace';
import type { WorkspaceRevision } from './journal';

/** Everything persisted for the workspace, read back from the database. */
export interface WorkspaceDbRead {
  appState: unknown;
  parts: WorkspaceParts;
}

/** Read every store and rebuild the workspace parts (core null when never written). */
export async function readWorkspaceFromDb(): Promise<WorkspaceDbRead> {
  const [projects, dailyActuals, reports, attendance, topics, appState, core, testerAssignments, reviews, rcsMembers, identityAuditLog, externalIdentities, cycles, scopes, testCases, caseResults, dailyPlans, meetingNotes, notifications, notificationAcks, brandings] =
    await Promise.all([
      getAllFromStore<WorkspaceParts['projects'][number]>(STORE_PROJECTS),
      getAllFromStore<WorkspaceParts['dailyActuals'][number]>(STORE_DAILY_ACTUALS),
      getAllFromStore<WorkspaceParts['reports'][number]>(STORE_REPORTS),
      getAllFromStore<WorkspaceParts['attendance'][number]>(STORE_ATTENDANCE),
      getAllFromStore<WorkspaceParts['topics'][number]>(STORE_TOPICS),
      getFromStore<unknown>(STORE_METADATA, META_KEY_APP_STATE),
      getFromStore<WorkspaceParts['core']>(STORE_METADATA, META_KEY_REPORTS_CORE),
      getFromStore<WorkspaceParts['collections']['testerAssignments']>(STORE_METADATA, META_KEY_COLLECTION.testerAssignments),
      getFromStore<WorkspaceParts['collections']['reviews']>(STORE_METADATA, META_KEY_COLLECTION.reviews),
      getFromStore<WorkspaceParts['collections']['rcsMembers']>(STORE_METADATA, META_KEY_COLLECTION.rcsMembers),
      getFromStore<WorkspaceParts['collections']['identityAuditLog']>(STORE_METADATA, META_KEY_COLLECTION.identityAuditLog),
      getFromStore<WorkspaceParts['collections']['externalIdentities']>(STORE_METADATA, META_KEY_COLLECTION.externalIdentities),
      getFromStore<WorkspaceParts['collections']['cycles']>(STORE_METADATA, META_KEY_COLLECTION.cycles),
      getFromStore<WorkspaceParts['collections']['scopes']>(STORE_METADATA, META_KEY_COLLECTION.scopes),
      getFromStore<WorkspaceParts['collections']['testCases']>(STORE_METADATA, META_KEY_COLLECTION.testCases),
      getFromStore<WorkspaceParts['collections']['caseResults']>(STORE_METADATA, META_KEY_COLLECTION.caseResults),
      getFromStore<WorkspaceParts['collections']['dailyPlans']>(STORE_METADATA, META_KEY_COLLECTION.dailyPlans),
      getFromStore<WorkspaceParts['collections']['meetingNotes']>(STORE_METADATA, META_KEY_COLLECTION.meetingNotes),
      getFromStore<WorkspaceParts['collections']['notifications']>(STORE_METADATA, META_KEY_COLLECTION.notifications),
      getFromStore<WorkspaceParts['collections']['notificationAcks']>(STORE_METADATA, META_KEY_COLLECTION.notificationAcks),
      getFromStore<WorkspaceParts['collections']['brandings']>(STORE_METADATA, META_KEY_COLLECTION.brandings),
    ]);
  return {
    appState,
    parts: {
      projects,
      dailyActuals,
      reports,
      attendance,
      topics,
      core: core ?? { schemaVersion: 0, settings: undefined as never, activeProjectId: null },
      collections: {
        testerAssignments: testerAssignments ?? [],
        reviews: reviews ?? [],
        rcsMembers: rcsMembers ?? [],
        identityAuditLog: identityAuditLog ?? [],
        externalIdentities: externalIdentities ?? [],
        cycles: cycles ?? [],
        scopes: scopes ?? [],
        testCases: testCases ?? [],
        caseResults: caseResults ?? [],
        dailyPlans: dailyPlans ?? [],
        meetingNotes: meetingNotes ?? [],
        notifications: notifications ?? [],
        notificationAcks: notificationAcks ?? [],
        brandings: brandings ?? [],
      },
    },
  };
}

/**
 * JSON snapshot of the parts a save wrote —kept as the diff baseline so
 * unchanged records are never re-serialized/re-written (§37).
 */
export interface WorkspaceMirror {
  appState: string | null;
  projects: Map<string, string>;
  dailyActuals: Map<string, string>;
  reports: Map<string, string>;
  attendance: Map<string, string>;
  topics: Map<string, string>;
  core: string | null;
  collections: Record<keyof WorkspaceParts['collections'], string | null>;
}

/** Build the diff baseline from a database read. */
export function mirrorFromRead(read: WorkspaceDbRead): WorkspaceMirror {
  const jsonMap = <T extends { id: string }>(rows: T[], keyOf: (row: T) => string = (row) => row.id): Map<string, string> =>
    new Map(rows.map((row) => [keyOf(row), JSON.stringify(row)]));
  return {
    appState: read.appState === undefined ? null : JSON.stringify(read.appState),
    projects: jsonMap(read.parts.projects),
    dailyActuals: jsonMap(read.parts.dailyActuals, dailyActualRowKey),
    reports: jsonMap(read.parts.reports),
    attendance: jsonMap(read.parts.attendance),
    topics: jsonMap(read.parts.topics),
    core: JSON.stringify(read.parts.core),
    collections: {
      testerAssignments: JSON.stringify(read.parts.collections.testerAssignments),
      reviews: JSON.stringify(read.parts.collections.reviews),
      rcsMembers: JSON.stringify(read.parts.collections.rcsMembers),
      identityAuditLog: JSON.stringify(read.parts.collections.identityAuditLog),
      externalIdentities: JSON.stringify(read.parts.collections.externalIdentities),
      cycles: JSON.stringify(read.parts.collections.cycles),
      scopes: JSON.stringify(read.parts.collections.scopes),
      testCases: JSON.stringify(read.parts.collections.testCases),
      caseResults: JSON.stringify(read.parts.collections.caseResults),
      dailyPlans: JSON.stringify(read.parts.collections.dailyPlans),
      meetingNotes: JSON.stringify(read.parts.collections.meetingNotes),
      notifications: JSON.stringify(read.parts.collections.notifications),
      notificationAcks: JSON.stringify(read.parts.collections.notificationAcks),
      brandings: JSON.stringify(read.parts.collections.brandings),
    },
  };
}

/** Build the diff baseline directly from a workspace (after a write). */
export function mirrorFromWorkspace(appState: unknown, reports: ReportsState): WorkspaceMirror {
  return mirrorFromRead({ appState, parts: splitWorkspace(appState, reports).parts });
}

export interface WorkspaceWritePlan {
  /** Record puts keyed by store. */
  puts: Map<string, Array<{ value: unknown; key?: string }>>;
  /** Record deletions keyed by store. */
  deletes: Map<string, Array<{ id: IDBValidKey }>>;
  /** True when at least one record differs from the mirror. */
  changed: boolean;
  /** Stores cleared at the START of the transaction, before any put/delete (history import). */
  clears?: string[];
}

function recordPut(plan: WorkspaceWritePlan, store: string, value: unknown, key?: string): void {
  let list = plan.puts.get(store);
  if (list === undefined) {
    list = [];
    plan.puts.set(store, list);
  }
  list.push(key === undefined ? { value } : { value, key });
}

function recordDelete(plan: WorkspaceWritePlan, store: string, id: IDBValidKey): void {
  let list = plan.deletes.get(store);
  if (list === undefined) {
    list = [];
    plan.deletes.set(store, list);
  }
  list.push({ id });
}

/** Diff records of a keyPath store (key = record.id; put must NOT pass a key). */
function diffKeyPathRecords<T extends { id: string }>(
  plan: WorkspaceWritePlan,
  store: string,
  rows: T[],
  mirror: Map<string, string>,
): void {
  const next = new Set(rows.map((row) => row.id));
  for (const row of rows) {
    const json = JSON.stringify(row);
    if (mirror.get(row.id) !== json) {
      plan.changed = true;
      recordPut(plan, store, row);
    }
  }
  for (const id of mirror.keys()) {
    if (!next.has(id)) {
      plan.changed = true;
      recordDelete(plan, store, id);
    }
  }
}

/** Diff records of an out-of-line-key store (put/delete carry the explicit key). */
function diffOutOflLineRecords<T>(
  plan: WorkspaceWritePlan,
  store: string,
  rows: T[],
  mirror: Map<string, string>,
  keyOf: (row: T) => string,
): void {
  const next = new Set(rows.map(keyOf));
  for (const row of rows) {
    const key = keyOf(row);
    const json = JSON.stringify(row);
    if (mirror.get(key) !== json) {
      plan.changed = true;
      recordPut(plan, store, row, key);
    }
  }
  for (const key of mirror.keys()) {
    if (!next.has(key)) {
      plan.changed = true;
      recordDelete(plan, store, key);
    }
  }
}

function diffMetadata<T>(plan: WorkspaceWritePlan, key: string, value: T, mirrorJson: string | null): void {
  const json = JSON.stringify(value);
  if (mirrorJson !== json) {
    plan.changed = true;
    recordPut(plan, STORE_METADATA, value, key);
  }
}

/**
 * Diff a workspace against the last-written mirror and produce the targeted
 * put/delete plan (§37). The AppState, projects, reports, snapshots,
 * attendance, topics, collections and metadata are each compared
 * individually; unchanged records produce no write at all.
 */
export function planWorkspaceWrite(appState: unknown, reports: ReportsState, mirror: WorkspaceMirror): WorkspaceWritePlan {
  const plan: WorkspaceWritePlan = { puts: new Map(), deletes: new Map(), changed: false };
  const { parts } = splitWorkspace(appState, reports);

  const appJson = JSON.stringify(appState);
  if (mirror.appState !== appJson) {
    plan.changed = true;
    recordPut(plan, STORE_METADATA, appState, META_KEY_APP_STATE);
  }

  diffKeyPathRecords(plan, STORE_PROJECTS, parts.projects, mirror.projects);
  diffOutOflLineRecords(plan, STORE_DAILY_ACTUALS, parts.dailyActuals, mirror.dailyActuals, dailyActualRowKey);
  diffKeyPathRecords(plan, STORE_REPORTS, parts.reports, mirror.reports);
  diffKeyPathRecords(plan, STORE_ATTENDANCE, parts.attendance, mirror.attendance);
  diffKeyPathRecords(plan, STORE_TOPICS, parts.topics, mirror.topics);

  diffMetadata(plan, META_KEY_REPORTS_CORE, parts.core, mirror.core);
  diffMetadata(plan, META_KEY_COLLECTION.testerAssignments, parts.collections.testerAssignments, mirror.collections.testerAssignments);
  diffMetadata(plan, META_KEY_COLLECTION.reviews, parts.collections.reviews, mirror.collections.reviews);
  diffMetadata(plan, META_KEY_COLLECTION.rcsMembers, parts.collections.rcsMembers, mirror.collections.rcsMembers);
  diffMetadata(plan, META_KEY_COLLECTION.identityAuditLog, parts.collections.identityAuditLog, mirror.collections.identityAuditLog);
  diffMetadata(plan, META_KEY_COLLECTION.externalIdentities, parts.collections.externalIdentities, mirror.collections.externalIdentities);
  diffMetadata(plan, META_KEY_COLLECTION.cycles, parts.collections.cycles, mirror.collections.cycles);
  diffMetadata(plan, META_KEY_COLLECTION.scopes, parts.collections.scopes, mirror.collections.scopes);
  diffMetadata(plan, META_KEY_COLLECTION.testCases, parts.collections.testCases, mirror.collections.testCases);
  diffMetadata(plan, META_KEY_COLLECTION.caseResults, parts.collections.caseResults, mirror.collections.caseResults);
  diffMetadata(plan, META_KEY_COLLECTION.dailyPlans, parts.collections.dailyPlans, mirror.collections.dailyPlans);
  diffMetadata(plan, META_KEY_COLLECTION.meetingNotes, parts.collections.meetingNotes, mirror.collections.meetingNotes);
  diffMetadata(plan, META_KEY_COLLECTION.notifications, parts.collections.notifications, mirror.collections.notifications);
  diffMetadata(plan, META_KEY_COLLECTION.notificationAcks, parts.collections.notificationAcks, mirror.collections.notificationAcks);
  diffMetadata(plan, META_KEY_COLLECTION.brandings, parts.collections.brandings, mirror.collections.brandings);

  return plan;
}

/** Append a metadata put to the plan so it commits in the SAME transaction (V6.7 §4). */
export function appendMetadataPut(plan: WorkspaceWritePlan, key: string, value: unknown): void {
  recordPut(plan, STORE_METADATA, value, key);
}

/**
 * Append the revision journal entry to the plan so the workspace records, the
 * manifest AND the journal entry commit atomically in ONE transaction
 * (V6.8 §5/§21): after a successful commit the journal is never behind the
 * manifest, and a failed transaction leaves no journal entry at all.
 */
export function appendJournalPut(plan: WorkspaceWritePlan, entry: WorkspaceRevision & { schemaVersion?: number }): void {
  recordPut(plan, STORE_REVISION_HISTORY, entry);
}

/**
 * Replace the whole journal inside the plan's transaction: clear the store
 * first, then put `entries`. Any journal entry appended afterwards (the
 * import head) commits atomically with them.
 */
export function appendJournalReplace(plan: WorkspaceWritePlan, entries: Array<WorkspaceRevision & { schemaVersion?: number }>): void {
  plan.clears = [...(plan.clears ?? []), STORE_REVISION_HISTORY];
  for (const entry of entries) recordPut(plan, STORE_REVISION_HISTORY, entry);
}

/** Apply a write plan inside ONE readwrite transaction over all stores (atomic save). */
export async function applyWorkspaceWritePlan(plan: WorkspaceWritePlan): Promise<void> {
  const stores = [STORE_PROJECTS, STORE_REPORTS, STORE_DAILY_ACTUALS, STORE_ATTENDANCE, STORE_TOPICS, STORE_METADATA, STORE_REVISION_HISTORY];
  await withReadWriteTx(stores, (get) => {
    // Requests run in order within the transaction: clears precede the puts.
    for (const store of plan.clears ?? []) get(store).clear();
    for (const [store, puts] of plan.puts) {
      const objectStore = get(store);
      for (const put of puts) {
        if (put.key === undefined) objectStore.put(put.value as never);
        else objectStore.put(put.value as never, put.key);
      }
    }
    for (const [store, deletes] of plan.deletes) {
      const objectStore = get(store);
      for (const del of deletes) objectStore.delete(del.id);
    }
  });
}
