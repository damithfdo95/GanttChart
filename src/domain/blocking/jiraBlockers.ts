import type { BlockingCategory, BlockingEvent } from '../../types';
import type { JiraIssue } from '../../../shared/jira';
import { truncateText } from '../testManagement/jiraImport';

/**
 * JIRA → blocking-event mapping (Level 2 §5). Pure: the caller supplies the business date, nothing
 * here reads the clock, generates random ids or touches storage. Events are deduplicated by JIRA
 * key, which is what makes a re-import safe.
 *
 * Mapping decisions (documented):
 *  - Id: deterministic `blk_<JIRA key>` (e.g. "blk_PROJ-42") derived from the issue key — the same
 *    derived-id pattern as `res_<caseId>` for results — so the same import always produces the same
 *    ids (no crypto, no Math.random). The key is unique per issue, so ids never collide.
 *  - Note: `[JIRA <key>] <summary>` — the `[JIRA key]` prefix is the merge/dedupe handle kept by
 *    `jiraIssuesToBlockingEvents`, the summary is whitespace-collapsed (single line) and the whole
 *    note is capped at `JIRA_BLOCKING_NOTE_MAX` chars.
 *  - Minutes default to 30 and are clamped to ≥ 1 (the `BlockingEvent` contract says minutes > 0).
 */

/** Cap for the event note (spec: "~200 chars"). */
export const JIRA_BLOCKING_NOTE_MAX = 200;

/** Keywords per category. Each is matched as a case-insensitive SUBSTRING of the issue's labels, type name or summary. */
export const BLOCKING_CATEGORY_KEYWORDS: Record<Exclude<BlockingCategory, 'OTHER'>, readonly string[]> = {
  ENVIRONMENT: ['environment', 'env'],
  BUILD: ['build', 'deploy', 'release'],
  TEST_DATA: ['test data', 'testdata', 'data'],
  REQUIREMENT: ['requirement', 'spec'],
  SYSTEM_ISSUE: ['system', 'infra', 'network', 'server'],
};

/**
 * Category evaluation order: the FIRST category in this list whose keyword matches wins — e.g. a
 * label "build" LOSES to a summary mentioning "environment", because ENVIRONMENT is checked first.
 * 'OTHER' is the fallback and is never matched by keywords.
 */
export const BLOCKING_CATEGORY_ORDER: readonly Exclude<BlockingCategory, 'OTHER'>[] = ['ENVIRONMENT', 'BUILD', 'TEST_DATA', 'REQUIREMENT', 'SYSTEM_ISSUE'];

/** The free-text fields of an issue that category keywords are matched against (labels, type name, summary). */
function issueSearchText(issue: JiraIssue): string {
  // Whitespace is collapsed so "test data" still matches across a line break. Substring semantics:
  // note that 'env' also matches inside words like "envelope" — the keyword lists are a heuristic
  // and are deliberately kept literal (see the exported consts).
  return [issue.summary, issue.typeName, ...issue.labels].join(' ').replace(/\s+/g, ' ').toLowerCase();
}

/** Infer the blocking category of an issue from its keywords, following BLOCKING_CATEGORY_ORDER. */
export function guessBlockingCategory(issue: JiraIssue): BlockingCategory {
  const text = issueSearchText(issue);
  for (const category of BLOCKING_CATEGORY_ORDER) {
    for (const keyword of BLOCKING_CATEGORY_KEYWORDS[category]) {
      if (text.includes(keyword)) return category;
    }
  }
  return 'OTHER';
}

/** Overrides for `jiraIssuesToBlockingEvents`. */
export interface JiraBlockingDefaults {
  /** Unavailable minutes per event. Default 30, clamped to ≥ 1. */
  minutes?: number;
}

/** The JIRA key from a note in the shape `[JIRA KEY] ...` written by this module; null when absent. */
export function jiraKeyFromNote(note: string): string | null {
  const m = note.trim().match(/^\[JIRA ([^\]]+)\]/);
  return m?.[1] ?? null;
}

const NOTE_PREFIX = /^\[JIRA [^\]]+\] ?/;

/** The editable part of an imported note: everything after the `[JIRA KEY] ` handle. */
export function editableNoteText(note: string): string {
  const m = note.match(NOTE_PREFIX);
  return m === null ? note : note.slice(m[0].length);
}

/** The note with its text replaced but the `[JIRA KEY]` dedupe handle kept, capped at the note limit. */
export function withNoteText(note: string, text: string): string {
  const m = note.match(NOTE_PREFIX);
  const prefix = m === null ? '' : `${m[0].trimEnd()} `;
  return (prefix + text).slice(0, JIRA_BLOCKING_NOTE_MAX);
}

/** One blocking event per issue, against the given business date (YYYY-MM-DD, never "today" internally). */
export function jiraIssuesToBlockingEvents(issues: readonly JiraIssue[], date: string, defaults: JiraBlockingDefaults = {}): BlockingEvent[] {
  const minutes = Math.max(1, defaults.minutes ?? 30);
  return issues.map((issue) => ({
    id: `blk_${issue.key}`,
    date,
    category: guessBlockingCategory(issue),
    minutes,
    note: truncateText(`[JIRA ${issue.key}] ${issue.summary}`, JIRA_BLOCKING_NOTE_MAX),
  }));
}

export interface MergeBlockingEventsResult {
  /** `existing` unchanged, in its original order, with the kept `incoming` events appended after. */
  merged: BlockingEvent[];
  /** The incoming events that were skipped as duplicates. */
  skipped: BlockingEvent[];
}

/**
 * Append `incoming` after `existing` (both orders preserved), skipping exact duplicates: an incoming
 * event is a duplicate when an event for the SAME JIRA key, SAME date and SAME category is already
 * present — either in `existing` or appended earlier from `incoming`. Deduping is keyed on the
 * `[JIRA KEY]` note prefix; an event without one (a hand-typed note) is never treated as a
 * duplicate and always appended. `existing` is never mutated.
 */
export function mergeBlockingEvents(existing: readonly BlockingEvent[], incoming: readonly BlockingEvent[]): MergeBlockingEventsResult {
  const merged: BlockingEvent[] = [...existing];
  const skipped: BlockingEvent[] = [];
  const seen = new Set<string>();
  const usedIds = new Set(existing.map((event) => event.id));
  // Ids are the edit/delete handle, so they must stay unique: the same JIRA key imported for another
  // date (or category) gets a numbered suffix instead of sharing `blk_<key>`.
  const uniqueId = (id: string): string => {
    let candidate = id;
    for (let n = 2; usedIds.has(candidate); n += 1) candidate = `${id}_${n}`;
    usedIds.add(candidate);
    return candidate;
  };
  for (const event of existing) {
    const key = jiraKeyFromNote(event.note);
    if (key !== null) seen.add(`${event.date}|${event.category}|${key}`);
  }
  for (const event of incoming) {
    const key = jiraKeyFromNote(event.note);
    if (key === null) {
      merged.push({ ...event, id: uniqueId(event.id) });
      continue;
    }
    const dedupeKey = `${event.date}|${event.category}|${key}`;
    if (seen.has(dedupeKey)) skipped.push(event);
    else {
      seen.add(dedupeKey);
      merged.push({ ...event, id: uniqueId(event.id) });
    }
  }
  return { merged, skipped };
}