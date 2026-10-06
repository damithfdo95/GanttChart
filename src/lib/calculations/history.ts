import type { DailyActualSnapshot, QaInputs } from '../../types';

/**
 * V6.5 — Execution history layer (pure; no React, no storage, no clock).
 *
 * Reporting layer ONLY — never a second source of truth for current
 * execution. Snapshots are frozen copies of the canonical QaInputs at a
 * point in time; all aggregates (QA Tested / QA Completed / Remaining) are
 * derived with the SAME existing execution logic:
 *
 *   QA Tested     = executed − spoAssigned
 *   QA Completed  = executed
 *   Remaining     = totalCases − executed
 *
 * Historical honesty rules (§6): legacy snapshots keep their recorded
 * aggregates; missing granular values are surfaced as null (unknown) and are
 * NEVER reconstructed from old totals.
 */

/** Fields of the canonical inputs captured by a snapshot. */
export type SnapshotInputs = Pick<
  QaInputs,
  | 'casesCompleted'
  | 'casesPassed'
  | 'casesFailed'
  | 'casesNotApplicable'
  | 'spoAssigned'
  | 'casesBlocked'
  | 'casesRetest'
  | 'casesQuestioned'
>;

/**
 * Create a snapshot from the CURRENT canonical state (§5). The persisted
 * aggregates (executed/passed) are captured verbatim from the authoritative
 * fields — no recomposition — so a snapshot of a granular-consistent state
 * is consistent by construction, and a state with uncategorized completed
 * cases stays honestly flagged (see granularConsistent).
 */
export function createExecutionSnapshot(id: string, date: string, inputs: SnapshotInputs): DailyActualSnapshot {
  return {
    id,
    date,
    executed: inputs.casesCompleted,
    passed: inputs.casesPassed ?? 0,
    casesPassed: inputs.casesPassed ?? 0,
    casesFailed: inputs.casesFailed ?? 0,
    casesNotApplicable: inputs.casesNotApplicable ?? 0,
    spoAssigned: inputs.spoAssigned ?? 0,
    casesBlocked: inputs.casesBlocked ?? 0,
    casesRetest: inputs.casesRetest ?? 0,
    casesQuestioned: inputs.casesQuestioned ?? 0,
  };
}

/** Recorded Pass: V6.5 granular field with the legacy `passed` fallback. */
export function snapshotPass(snapshot: DailyActualSnapshot): number {
  return Math.max(0, snapshot.casesPassed ?? snapshot.passed);
}

/**
 * One chronological history row: the snapshot plus the values derived with
 * the existing execution logic. Granular fields are null when the snapshot
 * predates V6.5 (unknown — never displayed or exported as a false zero).
 */
export interface ExecutionHistoryRow {
  snapshot: DailyActualSnapshot;
  date: string;
  pass: number;
  fail: number | null;
  notApplicable: number | null;
  spo: number | null;
  blocked: number | null;
  retest: number | null;
  questioned: number | null;
  qaTested: number;
  qaCompleted: number;
  remaining: number;
  /** True when every V6.5 granular field was recorded. */
  granularKnown: boolean;
  /**
   * Pass + Fail + N/A + SPO === executed for fully granular snapshots
   * (false = the source state had uncategorized completed cases);
   * null for legacy snapshots without granular data.
   */
  granularConsistent: boolean | null;
  /** Change vs the previous chronological snapshot; null for the oldest. */
  deltaQaTested: number | null;
  deltaQaCompleted: number | null;
  deltaRemaining: number | null;
}

function deriveRow(snapshot: DailyActualSnapshot, totalCases: number): Omit<ExecutionHistoryRow, 'deltaQaTested' | 'deltaQaCompleted' | 'deltaRemaining'> {
  const granularKnown =
    snapshot.casesFailed !== undefined &&
    snapshot.casesNotApplicable !== undefined &&
    snapshot.spoAssigned !== undefined &&
    snapshot.casesBlocked !== undefined &&
    snapshot.casesRetest !== undefined &&
    snapshot.casesQuestioned !== undefined &&
    snapshot.casesPassed !== undefined;
  const spo = snapshot.spoAssigned ?? 0;
  const qaCompleted = Math.max(0, snapshot.executed);
  const qaTested = Math.max(0, qaCompleted - spo);
  const granularConsistent = granularKnown
    ? snapshotPass(snapshot) +
        (snapshot.casesFailed ?? 0) +
        (snapshot.casesNotApplicable ?? 0) +
        (snapshot.spoAssigned ?? 0) ===
      snapshot.executed
    : null;
  return {
    snapshot,
    date: snapshot.date,
    pass: snapshotPass(snapshot),
    fail: snapshot.casesFailed ?? null,
    notApplicable: snapshot.casesNotApplicable ?? null,
    spo: snapshot.spoAssigned ?? null,
    blocked: snapshot.casesBlocked ?? null,
    retest: snapshot.casesRetest ?? null,
    questioned: snapshot.casesQuestioned ?? null,
    qaTested,
    qaCompleted,
    remaining: Math.max(0, totalCases - qaCompleted),
    granularKnown,
    granularConsistent,
  };
}

/**
 * Build the chronological execution history. Rows are sorted by date
 * ascending; deltas compare each row with its chronological predecessor.
 * The input array is never mutated.
 */
export function buildExecutionHistory(
  snapshots: readonly DailyActualSnapshot[],
  totalCases: number,
): ExecutionHistoryRow[] {
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const rows: ExecutionHistoryRow[] = [];
  let previous: { qaTested: number; qaCompleted: number; remaining: number } | null = null;
  for (const snapshot of sorted) {
    const row = deriveRow(snapshot, totalCases);
    rows.push({
      ...row,
      deltaQaTested: previous === null ? null : row.qaTested - previous.qaTested,
      deltaQaCompleted: previous === null ? null : row.qaCompleted - previous.qaCompleted,
      deltaRemaining: previous === null ? null : row.remaining - previous.remaining,
    });
    previous = { qaTested: row.qaTested, qaCompleted: row.qaCompleted, remaining: row.remaining };
  }
  return rows;
}

/** The most recent snapshot by date (null when no snapshots exist). */
export function latestSnapshot(snapshots: readonly DailyActualSnapshot[]): DailyActualSnapshot | null {
  let best: DailyActualSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (best === null || snapshot.date >= best.date) best = snapshot;
  }
  return best;
}

/** Trend series from actual snapshots (never recalculated from live state). */
export interface ExecutionTrendPoint {
  date: string;
  qaTested: number;
  qaCompleted: number;
  remaining: number;
}

export function executionTrendPoints(history: readonly ExecutionHistoryRow[]): ExecutionTrendPoint[] {
  return history.map((row) => ({
    date: row.date,
    qaTested: row.qaTested,
    qaCompleted: row.qaCompleted,
    remaining: row.remaining,
  }));
}
