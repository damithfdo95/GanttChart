import { describe, expect, it } from 'vitest';
import {
  BLOCKING_CATEGORY_KEYWORDS,
  BLOCKING_CATEGORY_ORDER,
  JIRA_BLOCKING_NOTE_MAX,
  guessBlockingCategory,
  jiraIssuesToBlockingEvents,
  jiraKeyFromNote,
  mergeBlockingEvents,
} from '../domain/blocking/jiraBlockers';
import type { JiraIssue } from '../../shared/jira';
import type { BlockingEvent } from '../types';

const issue = (over: Partial<JiraIssue> = {}): JiraIssue => ({
  id: '10001',
  key: 'PROJ-42',
  summary: 'Login fails on Safari',
  statusName: 'Open',
  typeName: 'Bug',
  labels: [],
  affectedVersions: [],
  descriptionPlain: '',
  ...over,
});

describe('keyword lists', () => {
  it('exposes the category keywords and the evaluation order for tests and UI', () => {
    expect(BLOCKING_CATEGORY_KEYWORDS.ENVIRONMENT).toContain('env');
    expect(BLOCKING_CATEGORY_KEYWORDS.BUILD).toEqual(['build', 'deploy', 'release']);
    expect(BLOCKING_CATEGORY_KEYWORDS.TEST_DATA).toContain('data');
    expect(BLOCKING_CATEGORY_KEYWORDS.REQUIREMENT).toContain('spec');
    expect(BLOCKING_CATEGORY_KEYWORDS.SYSTEM_ISSUE).toContain('server');
    expect(BLOCKING_CATEGORY_ORDER).toEqual(['ENVIRONMENT', 'BUILD', 'TEST_DATA', 'REQUIREMENT', 'SYSTEM_ISSUE']);
  });
});

describe('guessBlockingCategory', () => {
  it('recognises every category from its keywords in the summary', () => {
    expect(guessBlockingCategory(issue({ summary: 'Dev environment is down' }))).toBe('ENVIRONMENT');
    expect(guessBlockingCategory(issue({ summary: 'Build is broken' }))).toBe('BUILD');
    expect(guessBlockingCategory(issue({ summary: 'Deploy failed' }))).toBe('BUILD');
    expect(guessBlockingCategory(issue({ summary: 'Release blocked' }))).toBe('BUILD');
    expect(guessBlockingCategory(issue({ summary: 'No test data for logins' }))).toBe('TEST_DATA');
    expect(guessBlockingCategory(issue({ summary: 'TestData missing' }))).toBe('TEST_DATA');
    expect(guessBlockingCategory(issue({ summary: 'Requirement unclear' }))).toBe('REQUIREMENT');
    expect(guessBlockingCategory(issue({ summary: 'Spec not final' }))).toBe('REQUIREMENT');
    expect(guessBlockingCategory(issue({ summary: 'System is slow' }))).toBe('SYSTEM_ISSUE');
    expect(guessBlockingCategory(issue({ summary: 'Network down' }))).toBe('SYSTEM_ISSUE');
    expect(guessBlockingCategory(issue({ summary: 'Server 500s' }))).toBe('SYSTEM_ISSUE');
  });

  it('also matches the type name and the labels', () => {
    expect(guessBlockingCategory(issue({ typeName: 'Infrastructure' }))).toBe('SYSTEM_ISSUE');
    expect(guessBlockingCategory(issue({ labels: ['deploy-blocker'] }))).toBe('BUILD');
    expect(guessBlockingCategory(issue({ labels: ['qa-env'] }))).toBe('ENVIRONMENT');
  });

  it('is case-insensitive and collapses whitespace across fields', () => {
    expect(guessBlockingCategory(issue({ summary: 'ENVIRONMENT' }))).toBe('ENVIRONMENT');
    expect(guessBlockingCategory(issue({ summary: 'waiting for\ntest data' }))).toBe('TEST_DATA');
  });

  it('applies the documented precedence: ENVIRONMENT beats BUILD beats SYSTEM_ISSUE, a later category never overrides an earlier one', () => {
    // summary "environment" wins over a label "build" — ENVIRONMENT is checked first.
    expect(guessBlockingCategory(issue({ summary: 'environment down', labels: ['build'] }))).toBe('ENVIRONMENT');
    // label "build" wins over a summary "server offline" — BUILD is checked before SYSTEM_ISSUE.
    expect(guessBlockingCategory(issue({ summary: 'server offline', labels: ['build'] }))).toBe('BUILD');
    // type "deploy" wins over a summary "test data" — BUILD is checked before TEST_DATA.
    expect(guessBlockingCategory(issue({ typeName: 'Deploy job', summary: 'test data missing' }))).toBe('BUILD');
  });

  it('returns OTHER when nothing matches', () => {
    expect(guessBlockingCategory(issue({ summary: 'Waiting for the client' }))).toBe('OTHER');
    expect(guessBlockingCategory(issue({ summary: '', labels: [] }))).toBe('OTHER');
  });
});

describe('jiraIssuesToBlockingEvents', () => {
  const DATE = '2026-10-07';

  it('builds one event per issue with a deterministic derived id, the passed date, a guessed category, 30 minutes and the note shape', () => {
    const [event] = jiraIssuesToBlockingEvents([issue({ key: 'PROJ-42', summary: 'Login fails on Safari' })], DATE);
    expect(event).toEqual({
      id: 'blk_PROJ-42',
      date: DATE,
      category: 'OTHER',
      minutes: 30,
      note: '[JIRA PROJ-42] Login fails on Safari',
    });
  });

  it('uses the guessed category and passes the date through untouched', () => {
    const [event] = jiraIssuesToBlockingEvents([issue({ summary: 'Build broken' })], '2026-01-02');
    expect(event.category).toBe('BUILD');
    expect(event.date).toBe('2026-01-02');
  });

  it('honours the minutes override and clamps to at least 1', () => {
    expect(jiraIssuesToBlockingEvents([issue()], DATE, { minutes: 60 })[0].minutes).toBe(60);
    expect(jiraIssuesToBlockingEvents([issue()], DATE, { minutes: 0 })[0].minutes).toBe(1);
    expect(jiraIssuesToBlockingEvents([issue()], DATE)[0].minutes).toBe(30);
  });

  it('collapses the summary to one line and caps the note at ~200 chars, prefix intact', () => {
    const long = 'N '.repeat(JIRA_BLOCKING_NOTE_MAX);
    const [event] = jiraIssuesToBlockingEvents([issue({ key: 'PROJ-42', summary: long })], DATE);
    expect(event.note.length).toBeLessThanOrEqual(JIRA_BLOCKING_NOTE_MAX);
    expect(event.note.startsWith('[JIRA PROJ-42] ')).toBe(true);
    expect(jiraIssuesToBlockingEvents([issue({ summary: 'multi\nline  summary' })], DATE)[0].note).toBe('[JIRA PROJ-42] multi line summary');
  });

  it('ids are deterministic and unique per key (no random, no clock)', () => {
    const a = jiraIssuesToBlockingEvents([issue({ key: 'PROJ-42' })], DATE);
    const b = jiraIssuesToBlockingEvents([issue({ key: 'PROJ-42' })], DATE);
    expect(a).toEqual(b);
    const ids = jiraIssuesToBlockingEvents([issue({ key: 'A-1' }), issue({ key: 'A-2' })], DATE).map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('leaves the input issues untouched', () => {
    const issues = [issue({ summary: 'Build broken' })];
    const snapshot = JSON.stringify(issues);
    jiraIssuesToBlockingEvents(issues, DATE);
    expect(JSON.stringify(issues)).toBe(snapshot);
  });
});

describe('jiraKeyFromNote and mergeBlockingEvents', () => {
  const ev = (over: Partial<BlockingEvent> = {}): BlockingEvent => ({ id: 'blk_PROJ-42', date: '2026-10-07', category: 'BUILD', minutes: 30, note: '[JIRA PROJ-42] Build broken', ...over });

  it('reads the JIRA key from the note prefix', () => {
    expect(jiraKeyFromNote('[JIRA PROJ-42] Build broken')).toBe('PROJ-42');
    expect(jiraKeyFromNote('Build broken')).toBeNull();
    expect(jiraKeyFromNote('[JIRA A-1] ')).toBe('A-1');
  });

  it('skips an incoming event already present as the same date + category + JIRA key; existing is untouched', () => {
    const existing = [ev({ id: 'blk_a' }), ev({ id: 'blk_b', date: '2026-10-06' })];
    const incoming = [ev({ id: 'blk_x' })];
    const { merged, skipped } = mergeBlockingEvents(existing, incoming);
    expect(merged).toEqual(existing);
    expect(skipped).toEqual(incoming);
    expect(existing).toHaveLength(2); // not mutated
  });

  it('keeps distinct events and appends incoming after existing in order', () => {
    const existing = [ev({ id: 'blk_1' })];
    const incoming = [ev({ id: 'blk_2', date: '2026-10-08' })];
    const { merged, skipped } = mergeBlockingEvents(existing, incoming);
    expect(merged.map((e) => e.id)).toEqual(['blk_1', 'blk_2']);
    expect(skipped).toEqual([]);
  });

  it('dedupes within one incoming batch (second occurrence of the same key/date/category is skipped)', () => {
    const incoming = [ev({ id: 'blk_1' }), ev({ id: 'blk_2' }), ev({ id: 'blk_3', date: '2026-10-08' })];
    const { merged, skipped } = mergeBlockingEvents([], incoming);
    expect(merged.map((e) => e.id)).toEqual(['blk_1', 'blk_3']);
    expect(skipped.map((e) => e.id)).toEqual(['blk_2']);
  });

  it('same key on a different date, or in a different category, is NOT a duplicate', () => {
    const existing = [ev()];
    const incoming = [ev({ id: 'blk_d1', date: '2026-10-08' }), ev({ id: 'blk_c1', category: 'SYSTEM_ISSUE' })];
    const { merged, skipped } = mergeBlockingEvents(existing, incoming);
    expect(merged.map((e) => e.id)).toEqual(['blk_PROJ-42', 'blk_d1', 'blk_c1']);
    expect(skipped).toEqual([]);
  });

  it('events without a JIRA-note prefix are never deduped and always append', () => {
    const existing = [ev({ note: 'manual note' })];
    const incoming = [ev({ id: 'blk_x', note: 'manual note' })];
    const { merged, skipped } = mergeBlockingEvents(existing, incoming);
    expect(merged.map((e) => e.id)).toEqual(['blk_PROJ-42', 'blk_x']);
    expect(skipped).toEqual([]);
  });
});
describe('editing an imported note', () => {
  it('shows only the text after the [JIRA KEY] handle and keeps the handle when edited', async () => {
    const { editableNoteText, withNoteText, JIRA_BLOCKING_NOTE_MAX, jiraKeyFromNote } = await import('../domain/blocking/jiraBlockers');
    expect(editableNoteText('[JIRA PROJ-42] Login fails')).toBe('Login fails');
    expect(editableNoteText('manual note')).toBe('manual note');
    const edited = withNoteText('[JIRA PROJ-42] Login fails', 'Env down since 9am');
    expect(edited).toBe('[JIRA PROJ-42] Env down since 9am');
    expect(jiraKeyFromNote(edited)).toBe('PROJ-42');
    expect(withNoteText('[JIRA PROJ-42] x', 'y'.repeat(500))).toHaveLength(JIRA_BLOCKING_NOTE_MAX);
    expect(withNoteText('[JIRA PROJ-42] x', '')).toBe('[JIRA PROJ-42] ');
  });
});
