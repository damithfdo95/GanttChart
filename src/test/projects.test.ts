import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORTFOLIO_FILTERS,
  filterProjects,
  isProjectOverdue,
  newProjectRecord,
  portfolioSummary,
  projectDailyCapacity,
  projectNeedsAttention,
  projectPlanningStatus,
  projectProgress,
  qaInputsFromAppState,
  searchMatchesProject,
  setProjectLifecycleStatus,
  sortProjects,
} from '../domain/projects';
import type { AppState, ProjectRecord, QaInputs, ReportsState } from '../types';
import { DEMO_STATE } from '../lib/storage/storage';
import { isReportsState, normalizeReportsState, defaultReportsState } from '../lib/storage/reports';
import { parseBackupPayload } from '../lib/backup/backup';

const NOW = '2026-09-17T09:00:00.000Z';
const TODAY = '2026-09-17';

function inputs(overrides: Partial<QaInputs> = {}): QaInputs {
  return {
    totalCases: 100,
    currentTesters: 2,
    startTime: 540,
    targetFinish: 1050,
    lunchStart: 720,
    lunchEnd: 780,
    perHourPerTester: 4,
    casesCompleted: 40,
    startDate: '2026-09-14',
    targetCompletionDate: '2026-09-21',
    targetCompletionTime: '17:30',
    planningRows: [
      { id: 'p1', date: '2026-09-14', plannedTesters: 2, absentTesters: 0, nonWorkingDay: false, note: '' },
      { id: 'p2', date: '2026-09-15', plannedTesters: 2, absentTesters: 0, nonWorkingDay: false, note: '' },
      { id: 'p3', date: '2026-09-16', plannedTesters: 2, absentTesters: 0, nonWorkingDay: false, note: '' },
    ],
    ...overrides,
  };
}

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  const base = newProjectRecord(
    overrides.inputs ?? inputs(),
    {
      nameEn: overrides.nameEn ?? 'Project',
      nameJa: overrides.nameJa ?? 'プロジェクト',
      team: overrides.team ?? 'PrV',
      status: overrides.status ?? 'ongoing',
    },
    NOW,
  );
  return { ...base, ...overrides };
}

describe('lifecycle status', () => {
  it('new records start with an initial history entry', () => {
    const record = newProjectRecord(inputs(), { status: 'todo' }, NOW);
    expect(record.status).toBe('todo');
    expect(record.statusHistory).toEqual([{ status: 'todo', changedAt: NOW }]);
    expect(record.completedAt).toBeNull();
  });

  it('records the full todo → ongoing → done flow with completion metadata', () => {
    let record = project({ status: 'todo' });
    record = setProjectLifecycleStatus(record, 'ongoing', '2026-09-17T10:00:00.000Z');
    record = setProjectLifecycleStatus(record, 'done', '2026-09-17T18:00:00.000Z', 'Yamada');
    expect(record.status).toBe('done');
    expect(record.completedAt).toBe('2026-09-17T18:00:00.000Z');
    expect(record.completedBy).toBe('Yamada');
    expect(record.statusHistory.map((h) => h.status)).toEqual(['todo', 'ongoing', 'done']);
  });

  it('reopen clears completedAt but preserves the audit history', () => {
    let record = project({ status: 'done', completedAt: '2026-09-16T18:00:00.000Z' });
    record = setProjectLifecycleStatus(record, 'ongoing', '2026-09-17T09:00:00.000Z');
    expect(record.status).toBe('ongoing');
    expect(record.completedAt).toBeNull();
    expect(record.statusHistory.some((h) => h.status === 'done')).toBe(true);
  });

  it('every correction path is allowed (no forbidden transitions)', () => {
    const paths: [ProjectRecord['status'], ProjectRecord['status']][] = [
      ['todo', 'ongoing'],
      ['ongoing', 'todo'],
      ['ongoing', 'done'],
      ['done', 'todo'],
      ['done', 'ongoing'],
    ];
    for (const [from, to] of paths) {
      const record = setProjectLifecycleStatus(project({ status: from }), to, NOW);
      expect(record.status).toBe(to);
    }
  });

  it('progress never auto-changes the lifecycle status', () => {
    const record = project({ status: 'ongoing', inputs: inputs({ casesCompleted: 100, totalCases: 100 }) });
    expect(projectProgress(record).ratio).toBe(1);
    expect(record.status).toBe('ongoing');
  });
});

describe('planning status (existing engine)', () => {
  it('derives onTrack / capacityShortage / atRisk from the project inputs', () => {
    expect(projectPlanningStatus(project())).toBe('onTrack'); // capacity 60 by 9/16, remaining 60 → done by deadline

    const short = project({
      inputs: inputs({ casesCompleted: 0, totalCases: 500, targetCompletionDate: '2026-09-15' }),
    });
    expect(projectPlanningStatus(short)).toBe('capacityShortage');

    const late = project({
      inputs: inputs({
        casesCompleted: 0,
        totalCases: 60,
        targetCompletionDate: '2026-09-14',
        targetCompletionTime: '11:00',
      }),
    });
    expect(projectPlanningStatus(late)).toBe('atRisk');

    const finished = project({ inputs: inputs({ casesCompleted: 100 }) });
    expect(projectPlanningStatus(finished)).toBe('completed');

    const noTarget = project({ inputs: inputs({ targetCompletionDate: null }) });
    expect(projectPlanningStatus(noTarget)).toBe('noTarget');
  });
});

describe('overdue / needs attention', () => {
  it('overdue = deadline passed and not done', () => {
    expect(isProjectOverdue(project({ inputs: inputs({ targetCompletionDate: '2026-09-16' }) }), TODAY)).toBe(true);
    expect(isProjectOverdue(project(), TODAY)).toBe(false); // 9/21 in the future
    expect(isProjectOverdue(project({ status: 'done' }), TODAY)).toBe(false);
    expect(isProjectOverdue(project({ inputs: inputs({ targetCompletionDate: null }) }), TODAY)).toBe(false);
  });

  it('needs attention covers risk, overdue, near deadline and stale updates', () => {
    expect(projectNeedsAttention(project({ inputs: inputs({ targetCompletionDate: '2026-09-16' }) }), TODAY, NOW)).toBe(true);
    expect(projectNeedsAttention(project({ inputs: inputs({ targetCompletionDate: TODAY }) }), TODAY, NOW)).toBe(true); // 0 days left
    const stale = project({ updatedAt: '2026-08-01T00:00:00.000Z' });
    expect(projectNeedsAttention(stale, TODAY, NOW)).toBe(true);
    const healthy = project({ inputs: inputs({ targetCompletionDate: '2026-10-01' }), updatedAt: NOW });
    expect(projectNeedsAttention(healthy, TODAY, NOW)).toBe(false);
  });
});

describe('progress and capacity figures', () => {
  it('computes progress with explicit fields', () => {
    const p = projectProgress(project());
    expect(p.completed).toBe(40);
    expect(p.total).toBe(100);
    expect(p.remaining).toBe(60);
    expect(p.ratio).toBeCloseTo(0.4, 10);
    expect(projectProgress(project({ inputs: inputs({ totalCases: 0, casesCompleted: 0 }) })).ratio).toBeNull();
  });

  it('computes daily capacity from the existing engine math', () => {
    // 2 testers × 4 cases/h × 7.5 productive hours
    expect(projectDailyCapacity(project())).toBe(60);
  });
});

describe('visibility / filtering / search', () => {
  const todo = project({ nameEn: 'RLO Desktop', status: 'todo', inputs: inputs({ casesCompleted: 0 }) });
  const ongoing = project({ nameEn: 'Android 4.1.0', nameJa: 'アンドロイド', status: 'ongoing', team: 'RCS' });
  const done = project({ nameEn: 'Old Release', status: 'done' });

  it('Active hides Done by default; All shows everything; Done shows only done', () => {
    const all = [todo, ongoing, done];
    expect(filterProjects(all, { ...DEFAULT_PORTFOLIO_FILTERS }, TODAY, NOW).map((p) => p.nameEn)).toEqual(['RLO Desktop', 'Android 4.1.0']);
    expect(filterProjects(all, { ...DEFAULT_PORTFOLIO_FILTERS, lifecycle: 'all' }, TODAY, NOW)).toHaveLength(3);
    expect(filterProjects(all, { ...DEFAULT_PORTFOLIO_FILTERS, lifecycle: 'done' }, TODAY, NOW).map((p) => p.nameEn)).toEqual(['Old Release']);
    expect(filterProjects(all, { ...DEFAULT_PORTFOLIO_FILTERS, lifecycle: 'todo' }, TODAY, NOW).map((p) => p.nameEn)).toEqual(['RLO Desktop']);
    expect(filterProjects(all, { ...DEFAULT_PORTFOLIO_FILTERS, lifecycle: 'ongoing' }, TODAY, NOW).map((p) => p.nameEn)).toEqual(['Android 4.1.0']);
  });

  it('filters by team and by planning status', () => {
    const all = [todo, ongoing, done];
    expect(filterProjects(all, { ...DEFAULT_PORTFOLIO_FILTERS, team: 'RCS' }, TODAY, NOW).map((p) => p.nameEn)).toEqual(['Android 4.1.0']);
    const overdueOne = project({ inputs: inputs({ targetCompletionDate: '2026-09-10' }) });
    expect(filterProjects([ongoing, overdueOne], { ...DEFAULT_PORTFOLIO_FILTERS, planning: 'overdue' }, TODAY, NOW).map((p) => p.nameEn)).toEqual([overdueOne.nameEn]);
  });

  it('search matches EN name, JA name and id (case-insensitive)', () => {
    expect(searchMatchesProject(ongoing, 'android')).toBe(true);
    expect(searchMatchesProject(ongoing, 'アンドロイド')).toBe(true);
    expect(searchMatchesProject(ongoing, ongoing.id)).toBe(true);
    expect(searchMatchesProject(ongoing, 'ios')).toBe(false);
    expect(searchMatchesProject(ongoing, '')).toBe(true);
    expect(filterProjects([todo, ongoing], { ...DEFAULT_PORTFOLIO_FILTERS, search: 'desktop' }, TODAY, NOW).map((p) => p.nameEn)).toEqual(['RLO Desktop']);
  });
});

describe('sorting', () => {
  it('default order: To Do → Ongoing → Done, earliest deadline first within a status', () => {
    const a = project({ nameEn: 'A', status: 'ongoing', inputs: inputs({ targetCompletionDate: '2026-09-25' }) });
    const b = project({ nameEn: 'B', status: 'ongoing', inputs: inputs({ targetCompletionDate: '2026-09-22' }) });
    const c = project({ nameEn: 'C', status: 'todo' });
    const d = project({ nameEn: 'D', status: 'done' });
    expect(sortProjects([d, a, c, b], 'default').map((p) => p.nameEn)).toEqual(['C', 'B', 'A', 'D']);
  });

  it('sorts by name, deadline, progress, remaining and updated with direction', () => {
    const a = project({ nameEn: 'Alpha', inputs: inputs({ casesCompleted: 10, targetCompletionDate: '2026-09-25' }) });
    const b = project({ nameEn: 'Beta', inputs: inputs({ casesCompleted: 50, targetCompletionDate: '2026-09-20' }) });
    expect(sortProjects([b, a], 'name').map((p) => p.nameEn)).toEqual(['Alpha', 'Beta']);
    expect(sortProjects([a, b], 'name', 'desc').map((p) => p.nameEn)).toEqual(['Beta', 'Alpha']);
    expect(sortProjects([a, b], 'deadline').map((p) => p.nameEn)).toEqual(['Beta', 'Alpha']);
    expect(sortProjects([a, b], 'progress').map((p) => p.nameEn)).toEqual(['Alpha', 'Beta']);
    expect(sortProjects([a, b], 'progress', 'desc').map((p) => p.nameEn)).toEqual(['Beta', 'Alpha']);
    expect(sortProjects([a, b], 'remaining', 'desc').map((p) => p.nameEn)).toEqual(['Alpha', 'Beta']);
  });
});

describe('portfolio summary', () => {
  it('computes card numbers from project data', () => {
    const atRisk = project({
      inputs: inputs({
        casesCompleted: 0,
        totalCases: 60,
        targetCompletionDate: '2026-09-17',
        targetCompletionTime: '11:00',
        planningRows: [
          { id: 'q1', date: '2026-09-17', plannedTesters: 2, absentTesters: 0, nonWorkingDay: false, note: '' },
        ],
      }),
    });
    const capacityShort = project({
      inputs: inputs({ casesCompleted: 0, totalCases: 500, targetCompletionDate: '2026-09-17' }),
    });
    const overdueOnTrack = project({
      inputs: inputs({
        targetCompletionDate: '2026-09-10',
        planningRows: [
          { id: 'q2', date: '2026-09-07', plannedTesters: 2, absentTesters: 0, nonWorkingDay: false, note: '' },
        ],
      }),
    });
    const done = project({ status: 'done' });
    const todo = project({ status: 'todo' });
    const summary = portfolioSummary([atRisk, capacityShort, overdueOnTrack, done, todo], TODAY);
    expect(summary.total).toBe(5);
    expect(summary.todo).toBe(1);
    expect(summary.ongoing).toBe(3);
    expect(summary.done).toBe(1);
    expect(summary.atRisk).toBe(1);
    expect(summary.capacityShortage).toBe(1);
    expect(summary.overdue).toBe(1);
  });
});

describe('app state extraction', () => {
  it('qaInputsFromAppState drops UI-only fields', () => {
    const state: AppState = { ...DEMO_STATE };
    const extracted = qaInputsFromAppState(state);
    expect(extracted.totalCases).toBe(DEMO_STATE.totalCases);
    expect('language' in extracted).toBe(false);
    expect('projectNameEn' in extracted).toBe(false);
  });
});

describe('storage and backup backward compatibility', () => {
  it('isReportsState accepts pre-V4 payloads without projects', () => {
    const legacy = defaultReportsState();
    const { projects: _p, activeProjectId: _a, ...legacyShape } = legacy;
    const legacyPayload = legacyShape as unknown as ReportsState;
    expect(isReportsState(legacyPayload)).toBe(true);
    expect(normalizeReportsState(legacyPayload).projects).toEqual([]);
    expect(normalizeReportsState(legacyPayload).activeProjectId).toBeNull();
  });

  it('isReportsState rejects malformed project records', () => {
    const state = defaultReportsState();
    const bad = { ...state, projects: [{ id: 'x', status: 'bogus' }] };
    expect(isReportsState(bad)).toBe(false);
  });

  it('old backups without projects import successfully (migration on load)', () => {
    const appState: AppState = { ...DEMO_STATE };
    const reportsState = defaultReportsState();
    const { projects: _p, activeProjectId: _a, ...legacyReports } = reportsState;
    const backup = JSON.stringify({
      app: 'ganttchart',
      kind: 'backup',
      version: 1,
      exportedAt: NOW,
      data: { appState, reportsState: legacyReports },
    });
    const parsed = parseBackupPayload(backup);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const normalized = normalizeReportsState(parsed.data.reportsState as unknown as ReportsState);
      expect(normalized.projects).toEqual([]);
      expect(normalized.activeProjectId).toBeNull();
    }
  });
  it('project inputs snapshot is deep-copied on creation', () => {
    const base = inputs();
    const record = newProjectRecord(base, {}, NOW);
    base.planningRows[0].plannedTesters = 99;
    expect(record.inputs.planningRows[0].plannedTesters).toBe(2);
  });
});
