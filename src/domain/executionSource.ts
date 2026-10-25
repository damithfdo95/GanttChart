import { EXECUTION_SOURCES, EXECUTION_SOURCE_REF_KEYS, executionProvenanceError } from '../../shared/qaRules';
import type { CaseResult, DailyExecutionEntry, ProjectRecord, TestCase, TestScope } from '../types';
import { projectTotals, resultsByCase, summarize } from './testManagement';

/**
 * Execution provenance: where a day's aggregate figures came from. There is no single source for every project - a day is
 * typed by hand, imported from TestRail, or (later) derived from detailed case results - so each entry says which, and a source
 * is never replaced silently. Per-tester Performance records are attribution only and never write an aggregate.
 */
export type ExecutionSource = (typeof EXECUTION_SOURCES)[number];
export type ExecutionSourceRef = NonNullable<DailyExecutionEntry['sourceRef']>;

export { EXECUTION_SOURCES, executionProvenanceError };

/** The source of an entry; entries saved before provenance existed read as a manual entry. */
export function executionSourceOf(entry: Pick<DailyExecutionEntry, 'source'> | null | undefined): ExecutionSource {
  return entry?.source ?? 'manual';
}

export function executionSourceLabelKey(source: ExecutionSource): 'exec.source.manual' | 'exec.source.testrail' | 'exec.source.caseExecution' {
  return source === 'testrail' ? 'exec.source.testrail' : source === 'caseExecution' ? 'exec.source.caseExecution' : 'exec.source.manual';
}

/** Replacing one source with another needs the user's confirmation; refreshing the same source does not. */
export function requiresExecutionSourceConfirmation(from: ExecutionSource, to: ExecutionSource): boolean {
  return from !== to;
}

/** Stamp an entry with its source and the time it was written (the counts are left as they are). */
export function withExecutionProvenance(entry: DailyExecutionEntry, source: ExecutionSource, nowIso: string, ref?: ExecutionSourceRef): DailyExecutionEntry {
  const { sourceRef: _drop, ...rest } = entry;
  void _drop;
  return { ...rest, source, sourceUpdatedAt: nowIso, ...(source === 'testrail' && ref !== undefined ? { sourceRef: cleanSourceRef(ref) } : {}) };
}

/** Only the known, non-secret reference fields survive. */
export function cleanSourceRef(ref: ExecutionSourceRef): ExecutionSourceRef {
  return {
    provider: 'testrail',
    ...(ref.runId !== undefined ? { runId: ref.runId } : {}),
    ...(ref.planId !== undefined ? { planId: ref.planId } : {}),
  };
}

/** Drop provenance that is not valid (an unknown source, a bad stamp, a reference with foreign keys) instead of losing the day. */
export function normalizeEntryProvenance(entry: DailyExecutionEntry): DailyExecutionEntry {
  const probe = entry as unknown as Record<string, unknown>;
  if (executionProvenanceError(probe) === null) return entry;
  const { source: _s, sourceUpdatedAt: _u, sourceRef: _r, ...rest } = entry;
  void _s;
  void _u;
  void _r;
  const kept: DailyExecutionEntry = { ...rest };
  if (executionProvenanceError({ source: entry.source }) === null && entry.source !== undefined) kept.source = entry.source;
  if (executionProvenanceError({ sourceUpdatedAt: entry.sourceUpdatedAt }) === null && entry.sourceUpdatedAt !== undefined) kept.sourceUpdatedAt = entry.sourceUpdatedAt;
  if (entry.sourceRef !== undefined && executionProvenanceError({ sourceRef: entry.sourceRef }) === null) kept.sourceRef = cleanSourceRef(entry.sourceRef);
  return kept;
}

const FIGURE_KEYS = ['pass', 'fail', 'notApplicable', 'spo', 'blocked', 'retest', 'questioned'] as const;

/** Did the status counts change? (Time window, note and tester count are the team's own facts and do not make a day "manual".) */
export function executionFiguresChanged(before: DailyExecutionEntry, after: DailyExecutionEntry): boolean {
  return FIGURE_KEYS.some((k) => before[k] !== after[k]) || (before.uncategorizedCompleted ?? 0) !== (after.uncategorizedCompleted ?? 0);
}

export interface ExecutionSaveDecision {
  /** The entry to store (provenance applied) when the save goes ahead. */
  entry: DailyExecutionEntry;
  /** The user must confirm before this entry replaces the existing source. */
  needsConfirmation: boolean;
  /** The source being replaced, when confirmation is needed. */
  replaces: ExecutionSource | null;
}

/**
 * A manual Save of the day's form. A manual (or new) day becomes manual and stamped. A day imported from TestRail or derived
 * from cases keeps its provenance while only the window/note/testers change, and needs confirmation as soon as the counts do.
 */
export function decideManualSave(existing: DailyExecutionEntry | null, next: DailyExecutionEntry, nowIso: string): ExecutionSaveDecision {
  const from = existing === null ? 'manual' : executionSourceOf(existing);
  if (existing !== null && from !== 'manual' && !executionFiguresChanged(existing, next)) {
    const kept: DailyExecutionEntry = { ...next, source: from, ...(existing.sourceUpdatedAt !== undefined ? { sourceUpdatedAt: existing.sourceUpdatedAt } : {}), ...(existing.sourceRef !== undefined ? { sourceRef: existing.sourceRef } : {}) };
    return { entry: kept, needsConfirmation: false, replaces: null };
  }
  const needs = existing !== null && requiresExecutionSourceConfirmation(from, 'manual');
  return { entry: withExecutionProvenance(next, 'manual', nowIso), needsConfirmation: needs, replaces: needs ? from : null };
}

/** An import (TestRail) replacing the day: confirmation is needed when a different source currently owns it. */
export function decideImport(existing: DailyExecutionEntry | null, source: ExecutionSource): { needsConfirmation: boolean; replaces: ExecutionSource | null } {
  if (existing === null) return { needsConfirmation: false, replaces: null };
  const from = executionSourceOf(existing);
  const needs = requiresExecutionSourceConfirmation(from, source);
  return { needsConfirmation: needs, replaces: needs ? from : null };
}

export { EXECUTION_SOURCE_REF_KEYS };

export interface DetailedExecutionSummary {
  /** Registered (detailed) cases over the project's active scopes - optional detail, not the project Total. */
  registered: number;
  /** Registered cases with a completed result (pass / fail / N/A / SPO). */
  executed: number;
  /** The authoritative Total Test Cases the project carries. */
  scopeTotal: number;
}

/**
 * The detailed case-level picture, shown BESIDE the daily aggregate and never turned into it: a case result keeps only its latest
 * execution time (a re-run moves it), so past days cannot be rebuilt from it, and registered cases may be fewer than the scope total.
 */
export function detailedExecutionSummary(project: Pick<ProjectRecord, 'projectId' | 'inputs'>, scopes: readonly TestScope[], cases: readonly TestCase[], results: readonly CaseResult[]): DetailedExecutionSummary {
  const totals = projectTotals(project, scopes, cases);
  const activeScopeIds = new Set(scopes.filter((s) => s.projectId === project.projectId && s.status === 'active').map((s) => s.id));
  const mine = cases.filter((c) => c.projectId === project.projectId && activeScopeIds.has(c.scopeId));
  const summary = summarize(mine, resultsByCase(results));
  return { registered: totals.registered, executed: summary.completed, scopeTotal: totals.total };
}
