import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, BugTicket, QaInputs, ReportsState, TesterDailyPerformance } from '../types';
import {
  isAppState,
  isBugTicket,
  isTesterDailyPerformance,
  loadState,
  normalizeQaInputs,
  saveState,
} from '../lib/storage/storage';
import {
  defaultReportsState,
  isReportsState,
  loadReportsState,
  saveReportsState,
} from '../lib/storage/reports';
import { createBackupPayload, parseBackupPayload } from '../lib/backup/backup';
import {
  createProjectBackupPayload,
  importProjectIntoRegistry,
  parseProjectBackupPayload,
} from '../lib/backup/projectBackup';
import {
  addBugTicket,
  createBugTicket,
  removeBugTicket,
  ticketSummary,
  updateBugTicket,
} from '../domain/tickets';
import {
  findTesterDailyPerformance,
  removeTesterDailyPerformance,
  upsertTesterDailyPerformance,
} from '../domain/performance';
import { findDuplicateTicket, isValidUrl, validateBugTicket } from '../lib/validation/validateTicket';
import { bugTicketsSheet } from '../lib/export/exportData';
import { applyActiveProjectSync, qaInputsFromAppState } from '../domain/projects';
import { newProjectRecord } from '../domain/projects/lifecycle';

/**
 * V6.6 — Bug Ticket data model, CRUD, persistence, isolation and
 * normalization. Bug counts are always derived from the records; legacy
 * projects without bugTickets normalize to [] and keep loading.
 */

class MemoryStorage {
  map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('window', { localStorage: storage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function baseInputs(): QaInputs {
  return normalizeQaInputs({
    totalCases: 100,
    currentTesters: 8,
    startTime: 13 * 60,
    targetFinish: 17 * 60,
    lunchStart: 0,
    lunchEnd: 0,
    perHourPerTester: 4,
    casesCompleted: 0,
    casesPassed: 0,
    startDate: '2026-09-28',
    targetCompletionDate: '2026-09-30',
    targetCompletionTime: '17:00',
    planningRows: [
      { id: 'row-1', date: '2026-09-28', plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' },
    ],
  });
}

function ticket(overrides: Partial<BugTicket> = {}): BugTicket {
  return {
    id: 'ticket-1',
    projectId: 'PRJ-001',
    ticketKey: 'ABC-100',
    title: 'Login fails on Safari',
    url: 'https://jira.example.com/browse/ABC-100',
    createdAt: '2026-09-10',
    reportedBy: 'Sato',
    ...overrides,
  };
}

// ---- Data model & shape guards ---------------------------------------------

describe('V6.6 bug ticket model', () => {
  it('creates a ticket with a generated id bound to the project', () => {
    const created = createBugTicket('PRJ-001', {
      title: 'Crash on start',
      url: 'https://jira.example.com/browse/ABC-1',
      createdAt: '2026-09-01',
      reportedBy: 'Sato',
    });
    expect(created.id).not.toBe('');
    expect(created.projectId).toBe('PRJ-001');
    expect(created.title).toBe('Crash on start');
    expect(created.severity).toBeUndefined();
    expect(created.status).toBeUndefined();
    expect(created.memo).toBeUndefined();
  });

  it('accepts valid tickets and rejects invalid records in shape guards', () => {
    expect(isBugTicket(ticket())).toBe(true);
    expect(isBugTicket({ ...ticket(), severity: 'Critical' })).toBe(true);
    expect(isBugTicket({ ...ticket(), status: 'In Progress' })).toBe(true);
    expect(isBugTicket({ ...ticket(), severity: 'Huge' })).toBe(false);
    expect(isBugTicket({ ...ticket(), status: 'Whatever' })).toBe(false);
    expect(isBugTicket({ ...ticket(), title: 42 })).toBe(false);
    expect(isBugTicket({ ...ticket(), url: '' })).toBe(true); // shape-only; validation flags it
    expect(isBugTicket(null)).toBe(false);
  });

  it('validates tester daily performance records', () => {
    const record: TesterDailyPerformance = {
      id: 'rec-1',
      date: '2026-09-10',
      testerName: 'Sato',
      projectId: 'PRJ-001',
      casesTested: 30,
    };
    expect(isTesterDailyPerformance(record)).toBe(true);
    expect(isTesterDailyPerformance({ ...record, casesTested: -1 })).toBe(false);
    expect(isTesterDailyPerformance({ ...record, casesPassed: -5 })).toBe(false);
    expect(isTesterDailyPerformance({ ...record, date: 7 })).toBe(false);
    expect(isTesterDailyPerformance({ ...record, team: 'PrV' })).toBe(true);
  });
});

// ---- CRUD -------------------------------------------------------------------

describe('V6.6 ticket CRUD', () => {
  it('adds, updates and removes tickets immutably', () => {
    const a = ticket({ id: 't-a' });
    const b = ticket({ id: 't-b', ticketKey: 'ABC-101', title: 'Chart empty', url: 'https://jira.example.com/browse/ABC-101' });
    const added = addBugTicket([a], b);
    expect(added).toHaveLength(2);
    expect(added).not.toBe([a]);

    const updated = updateBugTicket(added, 't-a', { title: 'Login fails on Safari 15', severity: 'Major' });
    expect(updated[0].title).toBe('Login fails on Safari 15');
    expect(updated[0].severity).toBe('Major');
    expect(added[0].title).toBe('Login fails on Safari'); // original untouched

    const removed = removeBugTicket(updated, 't-a');
    expect(removed.map((tk) => tk.id)).toEqual(['t-b']);
    // Unknown id: no change.
    expect(updateBugTicket(added, 'nope', { title: 'x' })).toEqual(added);
  });

  it('derives the summary from records — never from a stored total', () => {
    const tickets = [
      ticket({ id: '1', createdAt: '2026-09-01', status: 'Open', severity: 'Critical', reportedBy: 'Sato' }),
      ticket({ id: '2', createdAt: '2026-09-02', status: 'Closed', severity: 'Major', reportedBy: 'Sato' }),
      ticket({ id: '3', createdAt: '2026-08-31', status: 'Open', reportedBy: 'Kim' }),
      ticket({ id: '4', createdAt: '2026-09-03', reportedBy: 'Lee' }),
    ];
    const summary = ticketSummary(tickets, '2026-09-15');
    expect(summary.total).toBe(4);
    expect(summary.thisMonth).toBe(3);
    expect(summary.open).toBe(2);
    expect(summary.closed).toBe(1);
    expect(summary.criticalOrMajor).toBe(2);
    expect(summary.uniqueReporters).toBe(3);
    expect(ticketSummary([], '2026-09-15')).toEqual({
      total: 0,
      thisMonth: 0,
      open: 0,
      criticalOrMajor: 0,
      closed: 0,
      uniqueReporters: 0,
    });
  });
});

// ---- Validation & duplicates (§11) ------------------------------------------

describe('V6.6 ticket validation', () => {
  it('requires title, url, valid date and reporter', () => {
    expect(validateBugTicket(ticket()).isValid).toBe(true);
    expect(validateBugTicket(ticket({ title: '   ' })).errors.title).toBe('errors.ticketTitleRequired');
    expect(validateBugTicket(ticket({ url: '' })).errors.url).toBe('errors.ticketUrlRequired');
    expect(validateBugTicket(ticket({ url: 'not-a-url' })).errors.url).toBe('errors.ticketUrlInvalid');
    expect(validateBugTicket(ticket({ createdAt: '2026-02-30' })).errors.createdAt).toBe('errors.ticketDateInvalid');
    expect(validateBugTicket(ticket({ reportedBy: '' })).errors.reportedBy).toBe('errors.ticketReporterRequired');
    expect(validateBugTicket(ticket({ projectId: '' })).errors.projectId).toBe('errors.ticketProjectRequired');
  });

  it('accepts http(s) URLs only', () => {
    expect(isValidUrl('https://jira.example.com/browse/ABC-1')).toBe(true);
    expect(isValidUrl('http://jira.example.com/browse/ABC-1')).toBe(true);
    expect(isValidUrl('ABC-123')).toBe(false);
    expect(isValidUrl('ftp://example.com')).toBe(false);
    expect(isValidUrl('')).toBe(false);
  });

  it('detects exact duplicates by key or URL but not by similar titles', () => {
    const existing = [ticket()];
    expect(findDuplicateTicket(existing, { ticketKey: 'ABC-100', url: 'https://x' })).toBeDefined();
    expect(findDuplicateTicket(existing, { ticketKey: 'ZZZ-999', url: ticket().url })).toBeDefined();
    // Same ticket being edited → not a duplicate of itself.
    expect(findDuplicateTicket(existing, { ticketKey: 'ABC-100', url: 'https://x' }, 'ticket-1')).toBeUndefined();
    // Similar title, different key/URL → legitimate, not blocked.
    expect(
      findDuplicateTicket(existing, {
        ticketKey: 'ABC-900',
        url: 'https://jira.example.com/browse/ABC-900',
      }),
    ).toBeUndefined();
  });
});

// ---- Tester daily record CRUD (§12) -----------------------------------------

describe('V6.6 tester daily records', () => {
  it('upserts by (project, date, tester) and never creates a second row per day', () => {
    let records = upsertTesterDailyPerformance([], 'PRJ-001', {
      date: '2026-09-10',
      testerName: 'Sato',
      casesTested: 30,
      casesPassed: 25,
    });
    records = upsertTesterDailyPerformance(records, 'PRJ-001', {
      date: '2026-09-10',
      testerName: 'Sato',
      casesTested: 40,
    });
    expect(records).toHaveLength(1);
    expect(records[0].casesTested).toBe(40);

    // Same tester, same day, different project → separate record.
    records = upsertTesterDailyPerformance(records, 'PRJ-002', {
      date: '2026-09-10',
      testerName: 'Sato',
      casesTested: 10,
    });
    expect(records).toHaveLength(2);

    // Another tester the same day → separate record.
    records = upsertTesterDailyPerformance(records, 'PRJ-001', {
      date: '2026-09-10',
      testerName: 'Kim',
      casesTested: 5,
    });
    expect(records).toHaveLength(3);
    expect(findTesterDailyPerformance(records, 'PRJ-001', '2026-09-10', 'Kim')?.casesTested).toBe(5);
  });

  it('removes records by id', () => {
    const records: TesterDailyPerformance[] = [
      { id: 'r1', date: '2026-09-10', testerName: 'Sato', projectId: 'PRJ-001', casesTested: 1 },
    ];
    expect(removeTesterDailyPerformance(records, 'r1')).toHaveLength(0);
    expect(removeTesterDailyPerformance(records, 'nope')).toHaveLength(1);
  });
});

// ---- Normalization & backward compatibility (§7) ---------------------------

describe('V6.6 normalization', () => {
  it('normalizes legacy projects to empty arrays', () => {
    const legacy = baseInputs();
    expect(legacy.bugTickets).toEqual([]);
    expect(legacy.testerDailyPerformance).toEqual([]);
  });

  it('keeps valid records and drops invalid ones on normalize', () => {
    const normalized = normalizeQaInputs({
      ...baseInputs(),
      bugTickets: [ticket(), { id: 'bad', projectId: 'PRJ-001', title: 5, url: 'x', createdAt: 'y', reportedBy: 'z' } as unknown as BugTicket],
      testerDailyPerformance: [
        { id: 'ok', date: '2026-09-10', testerName: 'Sato', projectId: 'PRJ-001', casesTested: 1 },
        { id: 'bad', date: '2026-09-10', testerName: 'Sato', projectId: 'PRJ-001', casesTested: -3 },
      ],
    });
    expect(normalized.bugTickets).toHaveLength(1);
    expect(normalized.bugTickets![0].id).toBe('ticket-1');
    expect(normalized.testerDailyPerformance).toHaveLength(1);
    expect(normalized.testerDailyPerformance![0].id).toBe('ok');
  });

  it('keeps existing V6.5 projects valid in the app-state shape check', () => {
    const state: AppState = {
      ...baseInputs(),
      language: 'ja',
      projectNameEn: 'A',
      projectNameJa: 'B',
    };
    expect(isAppState(state)).toBe(true);
    expect(isAppState({ ...state, bugTickets: [ticket()] })).toBe(true);
    expect(isAppState({ ...state, bugTickets: [{}] })).toBe(false);
    expect(isAppState({ ...state, testerDailyPerformance: [{ casesTested: 1 } as unknown as TesterDailyPerformance] })).toBe(false);
  });

  it('round-trips app state persistence with tickets', () => {
    const state: AppState = {
      ...baseInputs(),
      bugTickets: [ticket(), ticket({ id: 't2', ticketKey: 'ABC-102', url: 'https://jira.example.com/browse/ABC-102' })],
      testerDailyPerformance: [{ id: 'r1', date: '2026-09-10', testerName: 'Sato', projectId: 'PRJ-001', casesTested: 12 }],
      language: 'en',
      projectNameEn: 'Login',
      projectNameJa: 'ログイン',
    };
    expect(saveState(state)).toBe(true);
    const loaded = loadState();
    expect(loaded.bugTickets).toHaveLength(2);
    expect(loaded.bugTickets![0].ticketKey).toBe('ABC-100');
    expect(loaded.testerDailyPerformance).toHaveLength(1);
    expect(loaded.testerDailyPerformance![0].casesTested).toBe(12);
  });

  it('round-trips reports state (project records) with tickets', () => {
    const project = newProjectRecord(baseInputs(), { nameEn: 'A', nameJa: '', team: 'PrV', status: 'ongoing' }, '2026-09-01T00:00:00.000Z');
    project.inputs.bugTickets = [ticket({ projectId: project.projectId })];
    const reports: ReportsState = { ...defaultReportsState(), projects: [project], activeProjectId: project.id };
    expect(isReportsState(reports)).toBe(true);
    expect(saveReportsState(reports)).toBe(true);
    const loaded = loadReportsState();
    expect(loaded.projects[0].inputs.bugTickets).toHaveLength(1);
    expect(loaded.projects[0].inputs.bugTickets![0].projectId).toBe(project.projectId);
  });

  it('keeps legacy V6.5 reports state valid and normalized', () => {
    const project = newProjectRecord(baseInputs(), { nameEn: 'A', nameJa: '', team: '', status: 'todo' }, '2026-09-01T00:00:00.000Z');
    const legacy = { ...defaultReportsState(), projects: [project], activeProjectId: project.id } as ReportsState;
    expect(isReportsState(legacy)).toBe(true);
    expect(saveReportsState(legacy)).toBe(true);
    const loaded = loadReportsState();
    expect(loaded.projects[0].inputs.bugTickets).toEqual([]);
    expect(loaded.projects[0].inputs.testerDailyPerformance).toEqual([]);
  });
});

// ---- Active-project write-back & project isolation (§27) -------------------

describe('V6.6 project isolation', () => {
  it('syncs ticket edits of the active project only', () => {
    const inputsA = baseInputs();
    const inputsB = baseInputs();
    const a = newProjectRecord(inputsA, { nameEn: 'A', nameJa: '', team: '', status: 'ongoing' }, '2026-09-01T00:00:00.000Z');
    const b = newProjectRecord(inputsB, { nameEn: 'B', nameJa: '', team: '', status: 'ongoing' }, '2026-09-01T00:00:00.000Z');
    a.inputs.bugTickets = [ticket({ id: 'a1', projectId: a.projectId })];

    const appState: AppState = {
      ...baseInputs(),
      bugTickets: [ticket({ id: 'a1', projectId: a.projectId }), ticket({ id: 'a2', projectId: a.projectId, ticketKey: 'ABC-500', url: 'https://jira.example.com/browse/ABC-500' })],
      language: 'ja',
      projectNameEn: 'A',
      projectNameJa: '',
    };
    const next = applyActiveProjectSync([a, b], a.id, appState.projectNameEn, appState.projectNameJa, qaInputsFromAppState(appState), '2026-09-02T00:00:00.000Z');
    const syncedA = next.find((p) => p.id === a.id)!;
    const untouchedB = next.find((p) => p.id === b.id)!;
    expect(syncedA.inputs.bugTickets).toHaveLength(2);
    expect(untouchedB.inputs.bugTickets).toEqual([]);
    expect(untouchedB.updatedAt).toBe(b.updatedAt); // isolation: B untouched
  });

  it('re-keys tickets and daily records when a duplicate project import is re-IDed', () => {
    const original = newProjectRecord(baseInputs(), { nameEn: 'A', nameJa: '', team: '', status: 'ongoing' }, '2026-09-01T00:00:00.000Z');
    original.inputs.bugTickets = [ticket({ projectId: original.projectId })];
    original.inputs.testerDailyPerformance = [
      { id: 'r1', date: '2026-09-10', testerName: 'Sato', projectId: original.projectId, casesTested: 3 },
    ];
    const payload = createProjectBackupPayload(original, []);
    const parsed = parseProjectBackupPayload(JSON.stringify(payload));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Importing into a registry that already contains the same IDs → re-IDed.
    const result = importProjectIntoRegistry([original], [], parsed.data);
    expect(result.importedProject.projectId).not.toBe(original.projectId);
    expect(result.importedProject.inputs.bugTickets![0].projectId).toBe(result.importedProject.projectId);
    expect(result.importedProject.inputs.testerDailyPerformance![0].projectId).toBe(result.importedProject.projectId);
    // Original untouched.
    expect(original.inputs.bugTickets![0].projectId).toBe(original.projectId);
  });
});

// ---- Backup / restore (§26) -------------------------------------------------

describe('V6.6 backup round trips', () => {
  it('workspace backup exports and restores tickets and daily records', () => {
    const appState: AppState = {
      ...baseInputs(),
      bugTickets: [ticket()],
      testerDailyPerformance: [{ id: 'r1', date: '2026-09-10', testerName: 'Sato', projectId: 'PRJ-001', casesTested: 3 }],
      language: 'en',
      projectNameEn: 'A',
      projectNameJa: '',
    };
    const project = newProjectRecord(baseInputs(), { nameEn: 'A', nameJa: '', team: '', status: 'ongoing' }, '2026-09-01T00:00:00.000Z');
    project.inputs.bugTickets = [ticket({ projectId: project.projectId })];
    const reportsState: ReportsState = { ...defaultReportsState(), projects: [project], activeProjectId: project.id };

    const payload = createBackupPayload(appState, reportsState);
    const restored = parseBackupPayload(JSON.stringify(payload));
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.data.appState.bugTickets).toHaveLength(1);
    expect(restored.data.reportsState.projects[0].inputs.bugTickets).toHaveLength(1);
    expect(restored.data.appState.testerDailyPerformance).toHaveLength(1);
  });

  it('restores legacy V6.5 backups (no V6.6 fields) with [] defaults', () => {
    const appState: AppState = { ...baseInputs(), language: 'ja', projectNameEn: 'A', projectNameJa: 'B' };
    const legacyPayload = {
      app: 'ganttchart',
      kind: 'backup',
      version: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      data: { appState, reportsState: defaultReportsState() },
    };
    const restored = parseBackupPayload(JSON.stringify(legacyPayload));
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.data.appState.bugTickets).toEqual([]);
    expect(restored.data.appState.testerDailyPerformance).toEqual([]);
  });
});

// ---- Export sheet (§24) -------------------------------------------------------

describe('V6.6 bug tickets export sheet', () => {
  it('builds localized headers and one row per ticket', () => {
    const project = newProjectRecord(baseInputs(), { nameEn: 'Login Suite', nameJa: '', team: '', status: 'ongoing' }, '2026-09-01T00:00:00.000Z');
    const tickets = [
      ticket({ projectId: project.projectId, severity: 'Critical', status: 'Open', memo: 'found in sanity' }),
      ticket({ id: 't2', projectId: project.projectId, ticketKey: 'ABC-101', url: 'https://jira.example.com/browse/ABC-101', title: 'X', createdAt: '2026-09-11', reportedBy: 'Kim' }),
    ];
    // V6.9-A: Reporter Member ID / Reporter Name columns follow the reporter.
    // V6.9-B: the identity state column closes the row.
    const sheet = bugTicketsSheet('ja', tickets, [project]);
    expect(sheet.name).toBe('バグチケット');
    expect(sheet.headers).toEqual(['プロジェクト', 'JIRAチケットキー', 'タイトル', 'JIRA URL', '作成日', '報告者', '報告者メンバーID', '報告者氏名（現在）', '重要度', 'ステータス', 'メモ', 'ID状態']);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0][0]).toBe('Login Suite');
    expect(sheet.rows[0][5]).toBe('Sato');
    expect(sheet.rows[0][6]).toBe('');
    expect(sheet.rows[1][5]).toBe('Kim');
    const en = bugTicketsSheet('en', tickets, [project]);
    expect(en.headers[0]).toBe('Project');
    expect(en.headers[6]).toBe('Reporter Member ID');
    expect(en.rows[0][0]).toBe('Login Suite');
  });
});
