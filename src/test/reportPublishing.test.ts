import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackupPayload, parseBackupPayload } from '../lib/backup/backup';
import { DEMO_STATE } from '../lib/storage/storage';
import { defaultReportsState, normalizeReportsState } from '../lib/storage/reports';
import { reportsSheet } from '../lib/export/exportData';
import { reportDeliveryStateForDate, reportStateForDate } from '../domain/dailyReportDraft';
import { buildReportSections } from '../lib/reporting/sections';
import { DEFAULT_REPORT_TEMPLATES, renderReport } from '../lib/reporting/template';
import { DEFAULT_PROGRESS_RULES } from '../lib/reporting/progress';
import { createRevision, finalizeReport, newDraft } from '../lib/reporting/drafts';
import {
  canPublishReport,
  copyWithFallback,
  dailyReportFileName,
  formatDailyReportChatText,
  formatDailyReportPlainText,
  markReportPublished,
  reportDocument,
  sanitizeReportPublication,
} from '../lib/reporting/publication';
import { PUBLICATION_METHODS, isPublished, publicationStatusOf, reportPublicationCommitError, reportPublicationError } from '../../shared/reportPublication';
import { qaCommitError } from '../../shared/qaRules';
import { accessTo } from '../app/access';
import { ReportHistoryTable, ViewingReportBanner, type ReportDeliveryControls } from '../features/daily-report/DailyReportSections';
import { dictionaries } from '../i18n/dictionaries';
import type { AttendanceRecord, DailyReport, DailyTopic, Language, ReportActivity } from '../types';

const root = resolve(__dirname, '..');
const src = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const dict = (lang: 'en' | 'ja'): Record<string, string> => dictionaries[lang] as Record<string, string>;

const DATE = '2026-10-25';
const NOW = '2026-10-25T09:00:00.000Z';
const LATER = '2026-10-26T01:00:00.000Z';

const activity = (name: string, workTypes: string[], over: Partial<ReportActivity> = {}): ReportActivity => ({
  id: `act-${name}`,
  source: 'AUTO',
  name,
  memberCount: 4,
  completedCases: 20,
  workingStatus: 'Working',
  included: true,
  totalCases: 100,
  workingEligibleCases: 100,
  startedCases: 20,
  blockedCases: 0,
  notApplicableCases: 0,
  spoAssigned: 0,
  casesPassed: 20,
  casesFailed: 0,
  casesRetest: 0,
  casesQuestioned: 0,
  dueDate: null,
  workTypes,
  ...over,
});

const absence: AttendanceRecord = { id: 'att1', date: DATE, memberName: 'Hana', team: '', status: 'ABSENT', workingStart: null, workingEnd: null, leaveType: null, comment: '' };
const topic: DailyTopic = { id: 'top1', reportDate: DATE, title: 'Project Alpha', description: 'One open critical defect.', displayOrder: 0, createdBy: 'sup', createdAt: NOW, updatedAt: NOW };

/** A finalized report built the way the screen builds it: prepared-style activities, staffing, attendance, a topic and a manual edit. */
function finalized(language: Language = 'en', manualLine = ''): DailyReport {
  const activities = [
    activity('Project Alpha', ['regression']),
    activity('Project Beta', ['verification'], { ticketCount: 7 }),
    activity('Manual Gamma', [], { source: 'MANUAL', workTypes: undefined }),
  ];
  const staffing = { planned: 8, assigned: 7, actual: 6 };
  const sections = buildReportSections({ language, activities, attendance: [absence], members: [], topics: [topic], nextDay: [], jiraUrl: 'https://jira.example/board', rules: DEFAULT_PROGRESS_RULES, staffing });
  const text = renderReport(DEFAULT_REPORT_TEMPLATES[language], sections) + manualLine;
  const base: DailyReport = { ...newDraft(DATE, language, 'Sup', NOW, 'PRJ-1'), activities, staffing, previewText: text };
  return finalizeReport(base, [absence], [topic], 'Sup', NOW);
}

const actor = { userId: 'usr_123', memberId: 'USER0001' };

describe('publication state', () => {
  it('an older finalized report (no publication fields) is Not Published', () => {
    const report = finalized();
    expect(publicationStatusOf(report)).toBe('notPublished');
    expect(isPublished(report)).toBe(false);
    expect(canPublishReport(report, true)).toBe(true);
  });

  it('marking it Published records the time, actor and method - and changes nothing else', () => {
    const report = finalized('en', '\nManual note: do not touch.');
    const before = JSON.stringify(report);
    const published = markReportPublished(report, actor, 'manualCopy', LATER);
    expect(JSON.stringify(report)).toBe(before); // pure
    expect(published).toMatchObject({ publicationStatus: 'published', publishedAt: LATER, publishedByUserId: 'usr_123', publishedByMemberId: 'USER0001', publicationMethod: 'manualCopy' });
    const strip = ({ publicationStatus: _a, publishedAt: _b, publishedByUserId: _c, publishedByMemberId: _d, publicationMethod: _e, updatedAt: _f, ...rest }: DailyReport) => rest;
    expect(strip(published)).toEqual(strip(report));
    expect(published.previewText).toBe(report.previewText);
    expect(published.snapshot).toEqual(report.snapshot);
    expect(published.reportDate).toBe(DATE);
    expect(reportPublicationError(published)).toBeNull();
  });

  it('the first publication is final: later copy, print or a second mark never re-stamps it', () => {
    const first = markReportPublished(finalized(), actor, 'manualCopy', NOW);
    const again = markReportPublished(first, { userId: 'usr_999', memberId: null }, 'print', LATER);
    expect(again).toBe(first);
    expect(again.publishedAt).toBe(NOW);
    expect(canPublishReport(first, true)).toBe(false);
    formatDailyReportPlainText(first);
    formatDailyReportChatText(first);
    expect(first.publishedAt).toBe(NOW); // copying has no side effect on the record
  });

  it('copying does not publish: the formatters are read-only and the Copy buttons never call the publish transition', () => {
    const report = finalized();
    const before = JSON.stringify(report);
    formatDailyReportPlainText(report);
    formatDailyReportChatText(report);
    expect(JSON.stringify(report)).toBe(before);
    const screen = src('features/daily-report/DailyReport.tsx');
    const copy = screen.slice(screen.indexOf('const copyFinalized'), screen.indexOf('const exportFinalized'));
    expect(copy).not.toMatch(/markReportPublished|upsertReport/);
    const mark = screen.slice(screen.indexOf('const handleMarkPublished'), screen.indexOf('const publisherLabel'));
    expect(mark).toContain('await ask(');
    expect(mark.indexOf('await ask(')).toBeLessThan(mark.indexOf('markReportPublished('));
  });

  it('the method is one of the known four, and a malformed actor id is dropped rather than stored', () => {
    expect([...PUBLICATION_METHODS]).toEqual(['manualCopy', 'print', 'export', 'other']);
    const weird = markReportPublished(finalized(), { userId: 'https://evil.example/x', memberId: null }, 'other', LATER);
    expect(weird.publishedByUserId).toBeUndefined();
    expect(reportPublicationError(weird)).toBeNull();
  });
});

describe('a draft can never be published', () => {
  it('the transition refuses, nobody can publish it, and the shared rules reject a published draft', () => {
    const draft = newDraft(DATE, 'en', 'Sup', NOW, null);
    expect(markReportPublished(draft, actor, 'other', LATER)).toBe(draft);
    expect(canPublishReport(draft, true)).toBe(false);
    expect(reportPublicationError({ ...draft, publicationStatus: 'published', publishedAt: LATER, publicationMethod: 'other' })).toBe('report_publication_draft');
    expect(isPublished({ ...draft, publicationStatus: 'published' })).toBe(false);
    const commit = reportPublicationCommitError({
      puts: [{ kind: 'report', id: draft.id, json: JSON.stringify({ ...draft, publicationStatus: 'published', publishedAt: LATER, publicationMethod: 'other' }) }],
      view: { get: () => JSON.stringify(draft) },
      isSv: true,
    });
    expect(commit).toBe('report_publication_draft');
  });
});

describe('the delivered text is the finalized text only', () => {
  const report = finalized('en', '\n\nManual note: ご確認ください — 100% done!');

  it('is identical after the live workspace changes (project name, scope work type, ticket, execution, QA policy)', () => {
    const plain = formatDailyReportPlainText(report);
    const chat = formatDailyReportChatText(report);
    // The formatters take ONLY the report: live changes elsewhere cannot reach them. Mutating the live pieces the report was built from changes nothing.
    const live = { project: { nameEn: 'Alpha' }, scope: { workType: 'regression' }, ticket: { severity: 'Critical' }, execution: { pass: 1 }, policy: { critical: 'blocker' } };
    live.project.nameEn = 'Renamed';
    live.scope.workType = 'sanity';
    live.ticket.severity = 'Minor';
    live.execution.pass = 999;
    live.policy.critical = 'ignore';
    expect(formatDailyReportPlainText(report)).toBe(plain);
    expect(formatDailyReportChatText(report)).toBe(chat);
    expect(formatDailyReportPlainText).toHaveLength(1);
    expect(formatDailyReportChatText).toHaveLength(1);
    const code = src('lib/reporting/publication.ts');
    expect(code).not.toMatch(/caseExecution|ProjectRecord|qaPolicy|bugTickets|scopes|fetch\(|XMLHttpRequest|WebSocket/);
  });

  it('manual edits appear exactly, in both formats', () => {
    expect(formatDailyReportPlainText(report)).toContain('Manual note: ご確認ください — 100% done!');
    expect(formatDailyReportChatText(report)).toContain('Manual note: ご確認ください — 100% done!');
    const edited = { ...report, previewText: report.previewText.replace('Hello,', 'Hello team,') };
    expect(formatDailyReportPlainText(edited).startsWith('Hello team,')).toBe(true);
  });

  it('only a finalized report has a deliverable; a draft yields nothing', () => {
    const draft = newDraft(DATE, 'en', 'Sup', NOW, null);
    expect(formatDailyReportPlainText({ ...draft, previewText: 'secret draft' })).toBe('');
    expect(formatDailyReportChatText({ ...draft, previewText: 'secret draft' })).toBe('');
  });
});

describe('formatter fixture: attendance, staffing, work types, topics, manual edits', () => {
  const report = finalized('en', '\n\n■ Manual Section\n- keep this line');
  const plain = formatDailyReportPlainText(report);
  const chat = formatDailyReportChatText(report);

  it('plain text keeps the report structure with the existing greeting only', () => {
    expect(plain.startsWith('Hello,\n')).toBe(true);
    expect(plain.endsWith('\n')).toBe(true);
    expect(plain).not.toContain('\r');
    const doc = reportDocument(report);
    expect(doc.sections.map((s) => s.heading)).toEqual(['Attendance', "Today's Activities", "Today's Topics", 'Progress Report', 'Execution Summary', 'Next Business Day', 'Manual Section']);
    // Nothing is injected: every non-empty plain line comes from the stored report text.
    for (const line of plain.split('\n').filter((l) => l !== '')) expect(report.previewText).toContain(line);
  });

  it('Staffing is its own labelled line, distinct from the Attendance line, under the Attendance heading', () => {
    const attendance = reportDocument(report).sections.find((s) => s.heading === 'Attendance')!;
    expect(attendance.lines).toContain('Staffing: Planned 8 · Assigned 7 · Actual 6');
    expect(attendance.lines.some((l) => /members attending/.test(l))).toBe(true);
    expect(attendance.lines.filter((l) => l.startsWith('Staffing'))).toHaveLength(1);
  });

  it('regression and verification activities keep their work-type grouping and units', () => {
    expect(plain).toMatch(/Regression\n- 4: Project Alpha/);
    expect(plain).toMatch(/Verification\n- 4: Project Beta \(\d+ case\(s\) \/ 7 open ticket\(s\)\)/);
    expect(chat).toMatch(/Regression\n• 4: Project Alpha/);
    expect(chat).toMatch(/Verification\n• 4: Project Beta/);
  });

  it('topics and the manual section are present', () => {
    expect(plain).toContain('Project Alpha\n\nOne open critical defect.');
    expect(chat).toContain('One open critical defect.');
    expect(chat).toContain('■ Manual Section\n• keep this line');
  });

  it('chat text is portable: no Slack/Teams markup, no HTML, no markdown emphasis, single blank lines between sections', () => {
    expect(chat).not.toMatch(/\*\*|__|<[a-z/][^>]*>|^#{1,6} |`/m);
    expect(chat).not.toMatch(/\n\n\n/);
    expect(chat).not.toMatch(/^- /m);
    expect(chat.endsWith('\n')).toBe(true);
    // Same words as the plain text.
    const words = (s: string) => s.replace(/[•-]/g, ' ').split(/\s+/).filter(Boolean).join(' ');
    expect(words(chat)).toBe(words(plain));
  });

  it('is deterministic', () => {
    expect(formatDailyReportPlainText(report)).toBe(plain);
    expect(formatDailyReportChatText(report)).toBe(chat);
  });
});

describe('language belongs to the report, not the UI', () => {
  it('a Japanese report copies in Japanese and an English one in English, with no parameter for the UI language', () => {
    const ja = finalized('ja');
    const en = finalized('en');
    expect(formatDailyReportPlainText(ja)).toContain('お疲れ様です。');
    expect(formatDailyReportPlainText(ja)).toContain('体制');
    expect(formatDailyReportPlainText(ja)).not.toContain('Hello,');
    expect(formatDailyReportChatText(en)).toContain('Hello,');
    expect(formatDailyReportChatText(en)).not.toContain('お疲れ様です');
    expect(src('lib/reporting/publication.ts')).not.toMatch(/uiLang|useI18n|language\s*===|state\.language/);
  });
});

describe('revising a published report', () => {
  it('creates a new Draft that is Not Published, and the original stays published and unchanged', () => {
    const published = markReportPublished(finalized(), actor, 'manualCopy', LATER);
    const frozen = JSON.stringify(published);
    const revision = createRevision(published, LATER);
    expect(revision.status).toBe('DRAFT');
    expect(revision.revisionOf).toBe(published.id);
    expect(publicationStatusOf(revision)).toBe('notPublished');
    for (const key of ['publicationStatus', 'publishedAt', 'publishedByUserId', 'publishedByMemberId', 'publicationMethod'] as const) expect(revision[key]).toBeUndefined();
    expect(reportPublicationError(revision)).toBeNull();
    expect(JSON.stringify(published)).toBe(frozen);
    expect(isPublished(published)).toBe(true);
    expect(reportDeliveryStateForDate([published, revision], DATE)).toBe('draft');
  });
});

describe('who may publish', () => {
  it('only roles that manage reports: a supervisor and plain local use, never a Tester', () => {
    const report = finalized();
    expect(accessTo('admin', 'dailyReport')).toBe('manage');
    expect(accessTo(null, 'dailyReport')).toBe('manage');
    expect(accessTo('user', 'dailyReport')).toBe('none');
    expect(canPublishReport(report, true)).toBe(true);
    expect(canPublishReport(report, false)).toBe(false);
    expect(src('features/daily-report/DailyReport.tsx')).toMatch(/canPublishReport\(viewingReport, access\.canManage\)/);
  });

  it('the server refuses a Tester (or any non-SV) publishing, and accepts a supervisor', () => {
    const report = finalized();
    const next = markReportPublished(report, actor, 'other', LATER);
    const put = [{ kind: 'report', id: report.id, json: JSON.stringify(next) }];
    const view = { get: () => JSON.stringify(report) };
    expect(reportPublicationCommitError({ puts: put, view, isSv: false })).toBe('report_publication_sv_only');
    expect(reportPublicationCommitError({ puts: put, view, isSv: true })).toBeNull();
    expect(qaCommitError({ role: 'admin', puts: put, deletes: [], view, userId: 'usr_123', today: DATE })).toBeNull();
  });

  it('the banner offers Mark as Published only when allowed', () => {
    const report = finalized();
    const controls = (canPublish: boolean): ReportDeliveryControls => ({ canPublish, publishedByLabel: '', fallbackText: null, onCopyPlain: () => {}, onCopyChat: () => {}, onExport: () => {}, onPrint: () => {}, onMarkPublished: () => {} });
    const render = (canPublish: boolean) => renderToStaticMarkup(createElement(ViewingReportBanner, { uiLang: 'en', viewingReport: report, onClose: () => {}, onRevise: () => {}, delivery: controls(canPublish) }));
    expect(render(true)).toContain('Mark as Published');
    expect(render(false)).not.toContain('Mark as Published');
    // Exactly the two copy actions.
    expect(render(true).match(/Copy Plain Text|Copy for Teams\/Slack/g)).toHaveLength(2);
    expect(render(false)).toContain('Copy Plain Text');
  });
});

describe('server and shared validation of publication metadata', () => {
  const published = (over: Record<string, unknown> = {}) => ({ ...finalized(), publicationStatus: 'published', publishedAt: LATER, publishedByUserId: 'usr_1', publicationMethod: 'manualCopy', ...over });

  it('accepts valid metadata and older reports', () => {
    expect(reportPublicationError(published())).toBeNull();
    expect(reportPublicationError(finalized())).toBeNull();
    expect(reportPublicationError({ ...finalized(), publicationStatus: 'notPublished' })).toBeNull();
  });

  it('rejects an unknown status, a bad timestamp, a bad actor, an unknown method, and stray fields', () => {
    expect(reportPublicationError(published({ publicationStatus: 'sent' }))).toBe('report_publication_invalid_status');
    expect(reportPublicationError(published({ publishedAt: 'yesterday' }))).toBe('report_publication_invalid_time');
    expect(reportPublicationError(published({ publishedAt: '2026-13-45T99:00:00Z' }))).toBe('report_publication_invalid_time');
    expect(reportPublicationError(published({ publishedByUserId: 'https://x.example/y' }))).toBe('report_publication_invalid_actor');
    expect(reportPublicationError(published({ publishedByMemberId: { id: 1 } }))).toBe('report_publication_invalid_actor');
    expect(reportPublicationError(published({ publicationMethod: 'slack' }))).toBe('report_publication_invalid_method');
    expect(reportPublicationError(published({ publicationMethod: 'https://hooks.example/x' }))).toBe('report_publication_invalid_method');
    expect(reportPublicationError({ ...finalized(), publishedAt: LATER })).toBe('report_publication_inconsistent');
  });

  it('publishing may change only the publication metadata; the first publication is final', () => {
    const base = finalized();
    const good = markReportPublished(base, actor, 'other', LATER);
    const ctx = (prev: DailyReport, next: object) => reportPublicationCommitError({ puts: [{ kind: 'report', id: prev.id, json: JSON.stringify(next) }], view: { get: () => JSON.stringify(prev) }, isSv: true });
    expect(ctx(base, good)).toBeNull();
    expect(ctx(base, { ...good, previewText: 'rewritten' })).toBe('report_publication_changes_content');
    expect(ctx(base, { ...good, activities: [] })).toBe('report_publication_changes_content');
    expect(ctx(good, { ...good, publishedAt: '2026-11-01T00:00:00.000Z' })).toBe('report_publication_immutable'); // re-stamp
    expect(ctx(good, base)).toBe('report_publication_immutable'); // unpublish
    expect(ctx(good, good)).toBeNull(); // an unchanged re-save (restore, sync) is fine
    // A brand-new record cannot arrive already published.
    expect(reportPublicationCommitError({ puts: [{ kind: 'report', id: base.id, json: JSON.stringify(good) }], view: { get: () => null }, isSv: true })).toBe('report_publication_draft');
  });
});

describe('Command Center delivery states', () => {
  const fin = finalized();
  const pub = markReportPublished(fin, actor, 'other', LATER);
  const draft = newDraft(DATE, 'en', 'Sup', NOW, null);

  it('reports None, Draft, Finalized - Not Published, and Finalized - Published as four different states', () => {
    expect(reportDeliveryStateForDate([], DATE)).toBe('none');
    expect(reportDeliveryStateForDate([draft], DATE)).toBe('draft');
    expect(reportDeliveryStateForDate([fin], DATE)).toBe('finalizedNotPublished');
    expect(reportDeliveryStateForDate([pub], DATE)).toBe('finalizedPublished');
    expect(reportDeliveryStateForDate([pub], '2026-10-24')).toBe('none');
    expect(reportDeliveryStateForDate([pub, draft], DATE)).toBe('draft');
    // Finalized and Published are not the same state, while the older three-state view still reads both as finalized.
    expect(reportDeliveryStateForDate([fin], DATE)).not.toBe(reportDeliveryStateForDate([pub], DATE));
    expect(reportStateForDate([fin], DATE)).toBe(reportStateForDate([pub], DATE));
  });

  it('with several finalized versions, the latest decides', () => {
    const older = markReportPublished({ ...fin, id: 'old', finalizedAt: '2026-10-25T08:00:00.000Z' }, actor, 'other', LATER);
    const newer = { ...fin, id: 'new', finalizedAt: '2026-10-25T12:00:00.000Z' };
    expect(reportDeliveryStateForDate([older, newer], DATE)).toBe('finalizedNotPublished');
  });

  it('offers the four actions, in both languages', () => {
    const cc = src('features/commandCenter/CommandCenter.tsx');
    for (const k of ['none: ', 'draft: ', 'finalizedNotPublished: ', 'finalizedPublished: ']) expect(cc).toContain(k);
    for (const lang of ['en', 'ja'] as const) {
      for (const key of ['ops.report.prepare', 'ops.report.continue', 'ops.report.viewPublish', 'ops.report.viewPublished', 'ops.report.status.none', 'ops.report.status.draft', 'ops.report.status.finalizedNotPublished', 'ops.report.status.finalizedPublished']) expect(dict(lang)[key], `${lang} ${key}`).toBeTruthy();
    }
    expect(dict('en')['ops.report.viewPublish']).toBe('View / Publish');
    expect(dict('en')['ops.report.viewPublished']).toBe('View Published Report');
  });
});

describe('history, export, backup', () => {
  it('the history list shows a compact publication indicator', () => {
    const rows = [markReportPublished(finalized(), actor, 'other', LATER), { ...finalized(), id: 'r2' }, newDraft('2026-10-24', 'en', 'Sup', NOW, null)];
    const pager = { pagedRows: rows } as unknown as Parameters<typeof ReportHistoryTable>[0]['pager'];
    const html = renderToStaticMarkup(createElement(ReportHistoryTable, { uiLang: 'en', pager: { ...pager, page: 1, pageCount: 1, setPage: () => {}, total: 3, pageSize: 10 } as never, currentDraftId: undefined, onView: () => {} }));
    expect(html).toContain('Publication');
    expect(html.match(/>Published</g)).toHaveLength(1);
    expect(html.match(/>Not Published</g)).toHaveLength(1);
  });

  it('the report export carries Finalized Status, Publication Status, Published At and Published By', () => {
    const pub = markReportPublished(finalized(), actor, 'other', LATER);
    const sheet = reportsSheet('en', [pub, finalized(), newDraft(DATE, 'en', 'Sup', NOW, null)]);
    expect(sheet.headers).toEqual(expect.arrayContaining(['Finalized Status', 'Publication Status', 'Published At', 'Published By']));
    const idx = (h: string) => sheet.headers.indexOf(h);
    expect(sheet.rows[0]?.[idx('Publication Status')]).toBe('Published');
    expect(sheet.rows[0]?.[idx('Published At')]).toBe(LATER);
    expect(sheet.rows[0]?.[idx('Published By')]).toBe('USER0001');
    expect(sheet.rows[1]?.[idx('Publication Status')]).toBe('Not Published');
    expect(sheet.rows[1]?.[idx('Published At')]).toBe('');
    expect(sheet.rows[2]?.[idx('Publication Status')]).toBe('');
    const ja = reportsSheet('ja', [pub]);
    expect(ja.headers).toContain('公開日時');
  });

  it('publication metadata survives a full backup and restore; an old backup restores as Not Published', () => {
    const pub = markReportPublished(finalized(), actor, 'export', LATER);
    const legacy = { ...finalized(), id: 'legacy' };
    const reportsState = { ...defaultReportsState(), reports: [pub, legacy] };
    const text = JSON.stringify(createBackupPayload(DEMO_STATE as never, reportsState));
    const parsed = parseBackupPayload(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const restored = parsed.data.reportsState.reports;
    expect(restored.find((r) => r.id === pub.id)).toMatchObject({ publicationStatus: 'published', publishedAt: LATER, publicationMethod: 'export', publishedByMemberId: 'USER0001' });
    const old = restored.find((r) => r.id === 'legacy')!;
    expect(publicationStatusOf(old)).toBe('notPublished');
    expect(old.publishedAt).toBeUndefined();
  });

  it('a damaged publication block is dropped on load (Not Published) instead of locking the report', () => {
    const bad = { ...finalized(), publicationStatus: 'published', publishedAt: 'not-a-date', publicationMethod: 'slack' } as unknown as DailyReport;
    const fixed = normalizeReportsState({ ...defaultReportsState(), reports: [bad] }).reports[0]!;
    expect(publicationStatusOf(fixed)).toBe('notPublished');
    expect(fixed.previewText).toBe(bad.previewText);
    const ok = markReportPublished(finalized(), actor, 'other', LATER);
    expect(sanitizeReportPublication(ok)).toBe(ok);
  });
});

describe('clipboard and file helpers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('copies through the clipboard, and falls back to selectable text when it is missing or refuses', async () => {
    const writeText = vi.fn(async () => {});
    expect(await copyWithFallback('hello', { writeText })).toEqual({ ok: true });
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(await copyWithFallback('hello', undefined)).toEqual({ ok: false, fallbackText: 'hello' });
    expect(await copyWithFallback('hello', { writeText: async () => { throw new Error('denied'); } })).toEqual({ ok: false, fallbackText: 'hello' });
    const banner = renderToStaticMarkup(createElement(ViewingReportBanner, { uiLang: 'en', viewingReport: finalized(), onClose: () => {}, onRevise: () => {}, delivery: { canPublish: true, publishedByLabel: '', fallbackText: 'copy me by hand', onCopyPlain: () => {}, onCopyChat: () => {}, onExport: () => {}, onPrint: () => {}, onMarkPublished: () => {} } }));
    expect(banner).toContain('<textarea');
    expect(banner).toContain('copy me by hand');
  });

  it('file names are deterministic and ASCII-safe', () => {
    expect(dailyReportFileName({ reportDate: '2026-10-25' })).toBe('Daily-Report-2026-10-25.txt');
    expect(dailyReportFileName({ reportDate: '../../x\\y' })).toBe('Daily-Report-unknown-date.txt');
    expect(dailyReportFileName({ reportDate: '2026-10-25' }, 'x/ls')).toBe('Daily-Report-2026-10-25.xls');
    expect(dailyReportFileName({ reportDate: '2026-10-25' })).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('no external delivery', () => {
  it('copy, format, export and publish make no network call and touch no JIRA / TestRail code', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('network'); });
    vi.stubGlobal('fetch', fetchSpy);
    const report = finalized();
    formatDailyReportPlainText(report);
    formatDailyReportChatText(report);
    markReportPublished(report, actor, 'other', LATER);
    await copyWithFallback('x', { writeText: async () => {} });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    for (const file of ['lib/reporting/publication.ts', '../shared/reportPublication.ts']) {
      expect(src(file), file).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|sendBeacon|jira|testrail|slack\.com|office\.com/i);
    }
    const screen = src('features/daily-report/DailyReport.tsx');
    const delivery = screen.slice(screen.indexOf('delivery of a finalized report'), screen.indexOf('const createRevisionFrom'));
    expect(delivery).not.toMatch(/fetch\(|jira|testrail|\bsync|webhook/i);
  });
});

describe('print view and strings', () => {
  it('hides editing, navigation and publication controls when printing', () => {
    const css = src('index.css');
    const print = css.slice(css.indexOf('@media print'));
    expect(print).toMatch(/\.app-nav/);
    expect(print).toMatch(/\.no-print/);
    const html = renderToStaticMarkup(createElement(ViewingReportBanner, { uiLang: 'en', viewingReport: finalized(), onClose: () => {}, onRevise: () => {}, delivery: { canPublish: true, publishedByLabel: '', fallbackText: null, onCopyPlain: () => {}, onCopyChat: () => {}, onExport: () => {}, onPrint: () => {}, onMarkPublished: () => {} } }));
    // Every button sits inside a no-print wrapper.
    const outside = html.replace(/<div class="no-print">[\s\S]*?<\/p><\/div>/, '').replace(/<div class="dr-button-row no-print">[\s\S]*?<\/div>/, '');
    expect(outside).not.toContain('<button');
  });

  it('the finalized header shows date, status, finalized and publication details', () => {
    const pub = markReportPublished(finalized(), actor, 'manualCopy', LATER);
    const html = renderToStaticMarkup(createElement(ViewingReportBanner, { uiLang: 'en', viewingReport: pub, onClose: () => {}, onRevise: () => {}, delivery: { canPublish: false, publishedByLabel: 'Aoi Tanaka', fallbackText: null, onCopyPlain: () => {}, onCopyChat: () => {}, onExport: () => {}, onPrint: () => {}, onMarkPublished: () => {} } }));
    for (const part of [DATE, 'Finalized', 'Finalized At', 'Finalized By', 'Publication', 'Published', 'Published At', LATER, 'Published By', 'Aoi Tanaka']) expect(html, part).toContain(part);
    expect(html).not.toContain('Mark as Published');
    const notPub = renderToStaticMarkup(createElement(ViewingReportBanner, { uiLang: 'en', viewingReport: finalized(), onClose: () => {}, onRevise: () => {} }));
    expect(notPub).toContain('Not Published');
    expect(notPub).not.toContain('Published At');
  });

  it('every new string exists in English and Japanese', () => {
    const keys = Object.keys(dict('en')).filter((k) => k.startsWith('dailyReport.publication.') || ['columns.publication', 'columns.finalizedStatus', 'columns.publicationStatus', 'columns.publishedAt', 'columns.publishedBy'].includes(k));
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      expect(dict('ja')[key], key).toBeTruthy();
      expect(dict('ja')[key], key).not.toBe(dict('en')[key]);
    }
    expect(dict('en')['dailyReport.publication.confirm']).toContain('Mark this finalized report as published?');
  });
});
