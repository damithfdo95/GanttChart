import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import indexHtml from '../../index.html?raw';
import { describe, expect, it } from 'vitest';
import { dictionaries } from '../i18n/dictionaries';
import { defaultReportsState, isReportsState, normalizeReportsState } from '../lib/storage/reports';
import { emptySharedState } from '../lib/sync/starter';
import { createBackupPayload, parseBackupPayload } from '../lib/backup/backup';
import { DEMO_STATE } from '../lib/storage/storage';
import { assembleReportsState, splitWorkspace } from '../lib/storage/db/workspace';
import { applyRecordChanges, hasMeaningfulLocalData, reportsFromRecords, reportsToRecords } from '../lib/sync/records';
import { LEGACY_PLACEHOLDER_MEMBERS, applyPlaceholderCleanup, isLegacyPlaceholder, planPlaceholderCleanup } from '../domain/members/legacyPlaceholders';
import { compactNames, looksLikeTechnicalId, memberLabel, personLabel, personLabelOf, rosterLabel, userLabel } from '../domain/people';
import { ExecutionTable } from '../features/testManagement/ExecutionTable';
import { SummaryBlock } from '../features/testManagement/SummaryParts';
import { TicketTable } from '../features/tickets/TicketTable';
import { TicketForm, EMPTY_TICKET_FORM } from '../features/tickets/TicketForm';
import { summarize, caseResultId, type CaseResult, type TestCase, type TestScope } from '../domain/testManagement';
import type { AppState, BugTicket, ProjectRecord, RcsMember, ReportsState } from '../types';

const en = dictionaries.en as Record<string, string>;
const ja = dictionaries.ja as Record<string, string>;
const render = (el: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(el);
const NOW = '2026-10-07T09:00:00.000Z';

/** Every application source file (tests excluded), as raw text, keyed by its path under src. */
const rawSources = import.meta.glob<string>('../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true });
const SOURCES: Record<string, string> = {};
for (const [path, body] of Object.entries(rawSources)) if (path.startsWith('../') && !path.startsWith('../test/')) SOURCES[`src/${path.slice(3)}`] = body;
const appSources = Object.keys(SOURCES);
const text = (p: string): string => SOURCES[p];
const join = (...parts: string[]): string => parts.join('/');

describe('the obsolete product label is gone', () => {
  const OLD_EN = 'QA Test Execution Schedule Tracker';
  const OLD_JA = 'QAテスト実行スケジュール管理';

  it('appears in no translation, in either language', () => {
    for (const dict of [en, ja]) for (const [key, value] of Object.entries(dict)) {
      expect(value, key).not.toContain(OLD_EN);
      expect(value, key).not.toContain(OLD_JA);
    }
    expect('app.subtitle' in en).toBe(false);
    expect('app.subtitle' in ja).toBe(false);
  });

  it('is not hard-coded anywhere in the application source', () => {
    for (const file of appSources) {
      const s = text(file);
      expect(s, file).not.toContain(OLD_EN);
      expect(s, file).not.toContain(OLD_JA);
    }
    expect(indexHtml).not.toContain(OLD_EN);
  });

  it('the neutral fallback is short and is not the old label (a workspace Tool Name replaces it)', () => {
    expect(en['app.title']).toBe('QA Management');
    expect(ja['app.title']).toBe('QA管理');
  });
});

describe('no default people', () => {
  it('a new reports state, a new shared state and a normalised empty state all have an EMPTY roster', () => {
    expect(defaultReportsState().rcsMembers).toEqual([]);
    expect(emptySharedState(defaultReportsState()).rcsMembers).toEqual([]);
    expect(normalizeReportsState({ ...defaultReportsState(), rcsMembers: undefined }).rcsMembers).toEqual([]);
  });

  it('none of USER0001..USER0008 or their names appears in any fresh state', () => {
    const json = JSON.stringify([defaultReportsState(), emptySharedState(defaultReportsState()), normalizeReportsState({ ...defaultReportsState(), rcsMembers: undefined })]);
    expect(json).not.toMatch(/USER000[1-8]/);
    for (const m of LEGACY_PLACEHOLDER_MEMBERS) expect(json).not.toContain(m.name);
  });

  it('a backup without a roster restores without inventing people, and a round trip does not add any', () => {
    const legacy: ReportsState = { ...defaultReportsState(), rcsMembers: undefined };
    const parsed = parseBackupPayload(JSON.stringify(createBackupPayload(DEMO_STATE as AppState, legacy)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.reportsState.rcsMembers ?? []).toEqual([]);
    const again = parseBackupPayload(JSON.stringify(createBackupPayload(parsed.data.appState, parsed.data.reportsState)));
    expect(again.ok && (again.data.reportsState.rcsMembers ?? [])).toEqual([]);
  });

  it('an intentionally empty roster stays empty, and a real roster is kept exactly', () => {
    const real: RcsMember = { id: 'USER0100', name: 'Real Person', team: 'RCS', role: 'Tester', startDate: '2026-10-01', active: true };
    expect(normalizeReportsState({ ...defaultReportsState(), rcsMembers: [] }).rcsMembers).toEqual([]);
    expect(normalizeReportsState({ ...defaultReportsState(), rcsMembers: [real] }).rcsMembers).toEqual([real]);
  });

  it('no application code creates the old roster: only the legacy-detection module and the test fixture helper mention it', () => {
    const allowed = new Set([join('src', 'domain', 'members', 'legacyPlaceholders.ts'), join('src', 'domain', 'members', 'index.ts')]);
    for (const file of appSources) {
      if (allowed.has(file)) continue;
      const s = text(file);
      expect(s, file).not.toMatch(/seedRcsMembers\(|SEED_RCS_MEMBERS|LEGACY_PLACEHOLDER_MEMBERS/);
    }
    // ... and the legacy list is only used to RECOGNISE, never to create: nothing but the clean-up screen imports it
    const users = appSources.filter((f) => /legacyPlaceholders/.test(text(f)) && f !== join('src', 'domain', 'members', 'legacyPlaceholders.ts'));
    expect(users.map((f) => f.replace(/\\/g, '/')).sort()).toEqual(['src/domain/members/index.ts', 'src/features/tenancy/LegacyPlaceholderNotice.tsx']);
  });
});

describe('cleaning up old placeholder members (explicit, safe, deterministic)', () => {
  const placeholders = LEGACY_PLACEHOLDER_MEMBERS.map((m) => ({ ...m }));
  const base = { attendance: [], testerAssignments: [], projects: [] as ProjectRecord[], reviews: [] };

  it('recognises exactly the original eight, by id AND content', () => {
    expect(placeholders.every(isLegacyPlaceholder)).toBe(true);
    expect(isLegacyPlaceholder({ ...placeholders[0], name: 'Renamed' })).toBe(false);
    expect(isLegacyPlaceholder({ ...placeholders[0], userId: 'usr_x' })).toBe(false); // linked to an account: a real person now
    expect(isLegacyPlaceholder({ ...placeholders[0], endDate: '2026-12-01' })).toBe(false);
    expect(isLegacyPlaceholder({ ...placeholders[0], nameHistory: [{ name: 'Old' }] })).toBe(false);
    expect(isLegacyPlaceholder({ ...placeholders[2], id: 'USER0099' })).toBe(false); // same name, different id: added later by a person
    expect(isLegacyPlaceholder({ id: 'USER0003', name: 'User0003', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true })).toBe(false); // a display string alone proves nothing
  });

  it('removes placeholders nothing refers to', () => {
    const plan = planPlaceholderCleanup(placeholders, base);
    expect(plan.remove).toHaveLength(8);
    expect(plan.retire).toEqual([]);
    expect(applyPlaceholderCleanup(placeholders, plan)).toEqual([]);
  });

  it('keeps (inactive) a placeholder that history refers to, and never deletes it', () => {
    const referenced = { ...base, attendance: [{ id: 'a1', date: '2026-10-01', memberName: 'Yamauchi Kentaro', memberId: 'USER0003', status: 'present' } as never] };
    const plan = planPlaceholderCleanup(placeholders, referenced);
    expect(plan.retire).toEqual(['USER0003']);
    expect(plan.remove).toHaveLength(7);
    const after = applyPlaceholderCleanup(placeholders, plan);
    expect(after.map((m) => [m.id, m.active])).toEqual([['USER0003', false]]);
  });

  it('references from tickets, performance, assignments and reviews all protect a placeholder', () => {
    const project = { inputs: { bugTickets: [{ reporterMemberId: 'USER0004' }], testerDailyPerformance: [{ memberId: 'USER0005' }] } } as unknown as ProjectRecord;
    const plan = planPlaceholderCleanup(placeholders, { attendance: [], testerAssignments: [{ memberId: 'USER0006' } as never], projects: [project], reviews: [{ memberId: 'USER0007' } as never] });
    expect(plan.retire.sort()).toEqual(['USER0004', 'USER0005', 'USER0006', 'USER0007']);
    expect(plan.remove.sort()).toEqual(['USER0001', 'USER0002', 'USER0003', 'USER0008']);
  });

  it('leaves real people and edited placeholders alone, and an already inactive referenced placeholder needs nothing', () => {
    const real: RcsMember = { id: 'USER0100', name: 'Real Person', team: 'RCS', role: 'Tester', startDate: '2026-10-01', active: true };
    const edited = { ...placeholders[1], name: 'Damith F.' };
    const inactive = { ...placeholders[2], active: false };
    const plan = planPlaceholderCleanup([real, edited, inactive], { ...base, attendance: [{ memberId: 'USER0003' } as never] });
    expect(plan).toEqual({ remove: [], retire: [] });
    expect(applyPlaceholderCleanup([real, edited, inactive], plan)).toEqual([real, edited, inactive]);
  });

  it('after the clean-up, a retired placeholder is not offered where only active members are offered', () => {
    const plan = planPlaceholderCleanup(placeholders, { ...base, attendance: [{ memberId: 'USER0001' } as never] });
    const after = applyPlaceholderCleanup(placeholders, plan);
    expect(after.filter((m) => m.active)).toEqual([]);
  });
});

describe('people are never shown as ids', () => {
  it('recognises generated identifiers', () => {
    for (const id of ['User0001', 'USER0008', 'usr_9a2c0c56-1111-2222-3333-444455556666', 'ten_abc123', 'res_tc_1234', '123e4567-e89b-12d3-a456-426614174000']) expect(looksLikeTechnicalId(id), id).toBe(true);
    for (const name of ['Hana Sato', '田中 美香', 'ken@dev.test', 'User Admin', 'Usr']) expect(looksLikeTechnicalId(name), name).toBe(false);
  });

  it('display name first; then the email; then a neutral word - never an id, even when the id is all there is', () => {
    expect(personLabelOf({ displayName: 'Hana Sato', email: 'hana@x.com' }, 'Former member')).toBe('Hana Sato');
    expect(personLabelOf({ displayName: null, email: 'hana@x.com' }, 'Former member')).toBe('hana@x.com');
    expect(personLabelOf({ displayName: 'User0001', email: 'hana@x.com' }, 'Former member')).toBe('hana@x.com'); // a name that is really an id is ignored
    expect(personLabelOf({ name: 'User0001' }, 'Former member')).toBe('Former member');
    expect(personLabelOf({ displayName: '  ', email: '' }, 'Former member')).toBe('Former member');
    expect(personLabelOf(null, 'Former member')).toBe('Former member');
    expect(personLabel('ja', null)).toBe('元メンバー');
    expect(personLabel('en', { email: 'a@b.co' })).toBe('a@b.co');
  });

  it('resolves stored account ids to names; an unknown or removed account is "Former member", not its id', () => {
    const directory = {
      members: [{ id: 'USER0009', name: 'Hana Sato', userId: 'usr_hana-0001' }],
      self: { userId: 'usr_me-0001', displayName: null, email: 'me@x.com' },
      accounts: [{ id: 'usr_ken-0001', displayName: 'Ken Mori', email: 'ken@x.com' }],
    };
    expect(userLabel('en', 'usr_ken-0001', directory)).toBe('Ken Mori');
    expect(userLabel('en', 'usr_hana-0001', directory)).toBe('Hana Sato');
    expect(userLabel('en', 'usr_me-0001', directory)).toBe('me@x.com');
    expect(userLabel('en', 'usr_gone-0001', directory)).toBe('Former member');
    expect(userLabel('ja', 'usr_gone-0001', directory)).toBe('元メンバー');
    expect(userLabel('en', null, directory)).toBe('Former member');
    for (const id of ['usr_ken-0001', 'usr_hana-0001', 'usr_me-0001', 'usr_gone-0001']) expect(userLabel('en', id, directory)).not.toContain(id);
  });

  it('display name missing, email present, internal id User0001: the email is shown, not the id', () => {
    const d = { members: [{ id: 'User0001', name: 'User0001', userId: 'usr_x-1234' }], accounts: [{ id: 'usr_x-1234', displayName: null, email: 'real@x.com' }] };
    expect(userLabel('en', 'usr_x-1234', d)).toBe('real@x.com');
    expect(memberLabel('en', { name: 'User0001' })).toBe('Former member');
    expect(memberLabel('en', { name: 'Hana' })).toBe('Hana');
    expect(rosterLabel('en', 'USER0001', [{ id: 'USER0001', name: 'User0001' }])).toBe('Former member');
    expect(rosterLabel('en', 'USER0404', [])).toBe('Former member');
  });

  it('a list of names is compact: "A, B +2"', () => {
    expect(compactNames(['A', 'B'])).toBe('A, B');
    expect(compactNames(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C +2');
    expect(compactNames(['A', 'A', 'B'])).toBe('A, B');
  });

  const member: RcsMember = { id: 'USER0001', name: 'Hana Sato', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true };
  const ticket: BugTicket = { id: 't1', projectId: 'PRJ-001', title: 'Crash', url: 'https://x.example', createdAt: '2026-10-07', reportedBy: 'Hana Sato', reporterMemberId: 'USER0001' };

  it('Tickets show the reporter by name: no roster id in the table or in the reporter selector', () => {
    const table = render(createElement(TicketTable, { lang: 'en', tickets: [ticket, { ...ticket, id: 't2', reporterMemberId: 'USER0404', reportedBy: 'Gone' }], members: [member], onEdit: () => undefined, onDelete: () => undefined }));
    const form = render(createElement(TicketForm, { lang: 'en', values: { ...EMPTY_TICKET_FORM, reporterMemberId: 'USER0404' }, errors: {}, memberNames: [], members: [member], submitLabel: 'Add', onChange: () => undefined, onSubmit: () => undefined }));
    const visible = (html: string): string => html.replace(/<[^>]*>/g, ' '); // attributes (option values) are plumbing; what a person reads is the text
    for (const html of [table, form]) {
      expect(visible(html)).toContain('Hana Sato');
      expect(visible(html)).not.toMatch(/USER0\d+/);
    }
  });

  it('the execution grid shows who updated a result by name, an unknown account as "Former member", and never an id', () => {
    const scope: TestScope = { id: 'scp_1', projectId: 'PRJ-001', name: 'Ecosystem', code: 'ECO', status: 'active', order: 10, createdAt: NOW, updatedAt: NOW };
    const tc: TestCase = { id: 'tc_1', projectId: 'PRJ-001', scopeId: 'scp_1', key: 'ECO-001', title: 'Login', priority: 'high', status: 'active', order: 10, createdAt: NOW, updatedAt: NOW };
    const r: CaseResult = { id: caseResultId('tc_1'), projectId: 'PRJ-001', scopeId: 'scp_1', testCaseId: 'tc_1', status: 'pass', retest: false, question: false, updatedByUserId: 'usr_gone-0001', updatedAt: NOW };
    const html = render(createElement(ExecutionTable, { lang: 'en', cases: [tc], scopes: [scope], byCase: new Map([['tc_1', r]]), canEdit: () => true, onPatch: () => undefined, nameOf: (id) => userLabel('en', id, { members: [] }) }));
    expect(html).toContain('ECO-001'); // the business key IS shown
    expect(html).toContain('Former member');
    expect(html).not.toMatch(/usr_|tc_1|scp_1|res_/);
  });

  it('no visible text in the application is built from a roster or account id (source check)', () => {
    const offenders: string[] = [];
    const pattern = /\.id\} —|\{member\.id\}|\$\{member\.id\}|\{m\.id\} —|\.memberId\} —|\{record\.memberId\}|\{row\.memberId|\{issue\.suggestion\.memberId\}|\{a\.userId\}|\{assignment\.userId\}|\{result\.updatedByUserId\}|\{r\.updatedByUserId\}|\{user\.id\}/;
    for (const file of appSources.filter((f) => f.endsWith('.tsx'))) {
      const lines = text(file).split('\n');
      lines.forEach((line, i) => {
        if (pattern.test(line) && !/key=|value=|id=/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('Test Management data survives storage, sync and backups', () => {
  const scope: TestScope = { id: 'scp_1', projectId: 'PRJ-001', name: 'Ecosystem', code: 'ECO', status: 'active', order: 10, createdAt: NOW, updatedAt: NOW };
  const tc: TestCase = { id: 'tc_1', projectId: 'PRJ-001', scopeId: 'scp_1', key: 'ECO-001', title: 'Login', priority: 'high', status: 'active', order: 10, createdAt: NOW, updatedAt: NOW };
  const result: CaseResult = { id: caseResultId('tc_1'), projectId: 'PRJ-001', scopeId: 'scp_1', testCaseId: 'tc_1', status: 'fail', retest: true, question: false, memo: 'crash', updatedByUserId: 'usr_a', updatedAt: NOW };
  const full = (): ReportsState => ({ ...defaultReportsState(), scopes: [scope], testCases: [tc], caseResults: [result] });

  it('is part of the shared records and comes back from them (and counts as real data on a device)', () => {
    const recs = reportsToRecords(full());
    expect([...recs.values()].map((r) => r.kind).filter((k) => ['scope', 'testCase', 'caseResult'].includes(k)).sort()).toEqual(['caseResult', 'scope', 'testCase']);
    const back = reportsFromRecords([...recs.values()], defaultReportsState());
    expect(back.scopes).toEqual([scope]);
    expect(back.testCases).toEqual([tc]);
    expect(back.caseResults).toEqual([result]);
    expect(hasMeaningfulLocalData(full())).toBe(true);
    expect(hasMeaningfulLocalData(defaultReportsState())).toBe(false);
  });

  it('a remote change to one result touches only that result', () => {
    const next = { ...result, status: 'pass' as const };
    const patched = applyRecordChanges(full(), [{ kind: 'caseResult', id: result.id, json: JSON.stringify(next) }], []);
    expect(patched.caseResults).toEqual([next]);
    expect(patched.testCases).toEqual([tc]);
    expect(applyRecordChanges(full(), [], [{ kind: 'caseResult', id: result.id }]).caseResults).toEqual([]);
  });

  it('survives the local database split and reassembly', () => {
    const { parts } = splitWorkspace(DEMO_STATE, full());
    expect(assembleReportsState(parts)).toMatchObject({ scopes: [scope], testCases: [tc], caseResults: [result] });
  });

  it('survives a full backup round trip; an older backup (none of these) still imports with empty lists', () => {
    const parsed = parseBackupPayload(JSON.stringify(createBackupPayload(DEMO_STATE as AppState, full())));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.reportsState).toMatchObject({ scopes: [scope], testCases: [tc], caseResults: [result] });
    const old = defaultReportsState() as Partial<ReportsState>;
    delete old.scopes;
    delete old.testCases;
    delete old.caseResults;
    const oldParsed = parseBackupPayload(JSON.stringify({ app: 'ganttchart', version: 3, exportedAt: NOW, data: { appState: DEMO_STATE, reportsState: old } }));
    expect(isReportsState(old)).toBe(true);
    if (oldParsed.ok) expect(oldParsed.data.reportsState.scopes ?? []).toEqual([]);
  });

  it('malformed scopes, cases or results are filtered on load, never repaired; a bad one makes the payload invalid', () => {
    const bad = { ...full(), testCases: [tc, { ...tc, id: 'tc_2', key: 'not a key' }] };
    expect(isReportsState(bad)).toBe(false);
    expect(normalizeReportsState(bad).testCases).toEqual([tc]);
    expect(normalizeReportsState({ ...full(), caseResults: [{ ...result, status: 'done' as never }] }).caseResults).toEqual([]);
  });

  it('summaries read from the stored shape', () => {
    expect(summarize([tc], new Map([[tc.id, result]]))).toMatchObject({ total: 1, fail: 1, retest: 1, completed: 1, remaining: 0, progress: 1, passRate: 0 });
  });
});

describe('summary labels', () => {
  it('render in both languages with the agreed words, and no raw ids or NaN', () => {
    const s = summarize([], new Map());
    for (const lang of ['en', 'ja'] as const) {
      const html = render(createElement(SummaryBlock, { lang, summary: s }));
      expect(html).not.toMatch(/NaN|Infinity|#DIV/);
      expect(html).toContain('—');
    }
    expect(render(createElement(SummaryBlock, { lang: 'en', summary: s }))).toContain('Pass Rate');
    expect(render(createElement(SummaryBlock, { lang: 'ja', summary: s }))).toContain('合格率');
    expect(en['tm.status.spo']).toBe('Not Executable (SPO)');
    expect(ja['tm.status.spo']).toContain('SPO');
  });

  it('every translation key the test management screens use exists in both languages with matching placeholders', () => {
    const holes = (x: string): string[] => [...x.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const keys = Object.keys(en).filter((k) => k.startsWith('tm.') || k.startsWith('tenancy.legacy.') || k === 'people.former');
    expect(keys.length).toBeGreaterThan(100);
    for (const k of keys) {
      expect(ja[k], k).toBeTruthy();
      expect(holes(ja[k]), k).toEqual(holes(en[k]));
    }
  });
});
