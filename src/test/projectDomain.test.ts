import { describe, expect, it } from 'vitest';
import {
  applyActiveProjectSync,
  compareByStartDateTime,
  ensureProjectIds,
  filterProjects,
  findProjectByProjectId,
  getActiveProjects,
  getCompletedProjects,
  getProjectsByLifecycleStatus,
  getProjectsByPlanningStatus,
  getProjectsNeedingAttention,
  newProjectRecord,
  nextProjectId,
  reopenProject,
  seedInitialProjectRecord,
  setProjectLifecycleStatus,
  sortProjects,
  DEFAULT_PORTFOLIO_FILTERS,
  isProjectOverdue,
  portfolioSummary,
  projectDailyCapacity,
  projectPlanningStatus,
  projectProgress,
} from '../domain/projects';
import type { AppState, DailyReport, ProjectRecord, QaInputs, ReportsState } from '../types';
import { DEMO_STATE } from '../lib/storage/storage';
import { defaultReportsState, isReportsState, normalizeReportsState } from '../lib/storage/reports';
import { createBackupPayload, parseBackupPayload } from '../lib/backup/backup';
import { newDraft, finalizeReport } from '../lib/reporting/drafts';
import { projectsSheet, reportsSheet } from '../lib/export/exportData';
import { en, ja } from '../i18n/dictionaries';

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
    casesPassed: 36,
    targetPassRate: 0.9,
    dailyTargetOverrides: [{ id: 'ov1', date: '2026-09-15', plannedExecute: 30, plannedPass: 27 }],
    dailyActuals: [{ id: 'ac1', date: '2026-09-14', executed: 20, passed: 18 }],
    blockingEvents: [{ id: 'bl1', date: '2026-09-14', category: 'BUILD', minutes: 45, note: 'build broken' }],
    milestones: [
      { id: 'ms1', name: 'Half executed', type: 'EXECUTE', targetPct: 50, plannedDate: '2026-09-16', plannedTime: '12:00', actualAt: null },
    ],
    startDate: '2026-09-14',
    targetCompletionDate: '2026-09-30',
    targetCompletionTime: '17:30',
    planningRows: [
      { id: 'p1', date: '2026-09-14', plannedTesters: 2, absentTesters: 0, nonWorkingDay: false, note: '' },
      { id: 'p2', date: '2026-09-15', plannedTesters: 2, absentTesters: 0, nonWorkingDay: false, note: '' },
    ],
    ...overrides,
  };
}

function project(overrides: Partial<ProjectRecord> = {}, existing: ProjectRecord[] = []): ProjectRecord {
  const base = newProjectRecord(
    overrides.inputs ?? inputs(),
    {
      nameEn: overrides.nameEn ?? 'Project',
      nameJa: overrides.nameJa ?? 'プロジェクト',
      team: overrides.team ?? 'PrV',
      status: overrides.status ?? 'ongoing',
    },
    NOW,
    existing,
  );
  return { ...base, ...overrides };
}

function appState(overrides: Partial<AppState> = {}): AppState {
  return { ...DEMO_STATE, ...overrides };
}

describe('project creation and stable IDs', () => {
  it('assigns sequential stable Project IDs (PRJ-001, PRJ-002, …)', () => {
    const a = project();
    const b = project({}, [a]);
    const c = project({}, [a, b]);
    expect(a.projectId).toBe('PRJ-001');
    expect(b.projectId).toBe('PRJ-002');
    expect(c.projectId).toBe('PRJ-003');
  });

  it('IDs never collide, even with gaps or duplicates in existing data', () => {
    const existing = [
      project({ projectId: 'PRJ-001' }),
      project({ projectId: 'PRJ-003' }),
    ];
    expect(nextProjectId(existing)).toBe('PRJ-004');
    expect(nextProjectId([project({ projectId: 'PRJ-005' })])).toBe('PRJ-006');
    expect(nextProjectId([project({ projectId: 'PRJ-999' }), project({ projectId: 'PRJ-001' })])).toBe('PRJ-1000');
  });

  it('new records have default status, timestamps and history', () => {
    const record = newProjectRecord(inputs(), { status: 'todo' }, NOW);
    expect(record.status).toBe('todo');
    expect(record.createdAt).toBe(NOW);
    expect(record.updatedAt).toBe(NOW);
    expect(record.statusHistory).toEqual([{ status: 'todo', changedAt: NOW }]);
    expect(record.completedAt).toBeNull();
  });

  it('renaming a project never changes its Project ID', () => {
    const record = project({ nameEn: 'Old Name' });
    const renamed = applyActiveProjectSync([record], record.id, 'New Name', record.nameJa, record.inputs, NOW);
    expect(renamed[0].projectId).toBe(record.projectId);
    expect(renamed[0].nameEn).toBe('New Name');
  });
});

describe('project data isolation (multi-project)', () => {
  it('modifying the active project leaves every other project untouched by reference', () => {
    const p1 = project({ nameEn: 'Android 4.1.0', inputs: inputs({ casesCompleted: 10 }) });
    const p2 = project({ nameEn: 'iOS 4.1.0', team: 'RCS' }, [p1]);
    const p3 = project({ nameEn: 'RLO Desktop' }, [p1, p2]);
    const p4 = project({ nameEn: 'Future' }, [p1, p2, p3]);
    const p5 = project({ nameEn: 'Completed', status: 'done' }, [p1, p2, p3, p4]);

    const next = applyActiveProjectSync(
      [p1, p2, p3, p4, p5],
      p1.id,
      'Android 4.1.0 R-can',
      p1.nameJa,
      inputs({ casesCompleted: 80 }),
      '2026-09-17T12:00:00.000Z',
    );

    expect(next[0]).not.toBe(p1); // active project replaced
    expect(next[0].inputs.casesCompleted).toBe(80);
    expect(next[0].nameEn).toBe('Android 4.1.0 R-can');
    expect(next[0].updatedAt).toBe('2026-09-17T12:00:00.000Z');
    // All other projects are the SAME objects — provably untouched.
    expect(next[1]).toBe(p2);
    expect(next[2]).toBe(p3);
    expect(next[3]).toBe(p4);
    expect(next[4]).toBe(p5);
  });

  it('opening a project without data changes does not bump updatedAt', () => {
    const p1 = project({ updatedAt: '2026-09-01T00:00:00.000Z' });
    const original = [p1];
    const next = applyActiveProjectSync(
      original,
      p1.id,
      p1.nameEn,
      p1.nameJa,
      p1.inputs,
      '2026-09-17T12:00:00.000Z',
    );
    expect(next).toBe(original); // same array — nothing changed at all
  });

  it('planning calculations always use the selected project own inputs', () => {
    const android = project({ inputs: inputs({ casesCompleted: 95, totalCases: 100 }) });
    const ios = project({ inputs: inputs({ casesCompleted: 10, totalCases: 500, targetCompletionDate: '2026-09-18' }) }, [android]);
    expect(projectProgress(android).ratio).toBeCloseTo(0.95, 10);
    expect(projectProgress(ios).ratio).toBeCloseTo(0.02, 10);
    expect(projectPlanningStatus(android)).toBe('onTrack');
    expect(projectPlanningStatus(ios)).toBe('capacityShortage');
  });
});

describe('lifecycle transitions and history (centralized domain)', () => {
  it('every allowed transition records a history event', () => {
    let record = project({ status: 'todo' });
    record = setProjectLifecycleStatus(record, 'ongoing', '2026-09-17T10:00:00.000Z');
    record = setProjectLifecycleStatus(record, 'done', '2026-09-17T18:00:00.000Z', 'Yamada');
    record = reopenProject(record, 'ongoing', '2026-09-18T09:00:00.000Z');
    record = setProjectLifecycleStatus(record, 'todo', '2026-09-18T10:00:00.000Z');
    expect(record.status).toBe('todo');
    expect(record.statusHistory.map((h) => h.status)).toEqual(['todo', 'ongoing', 'done', 'ongoing', 'todo']);
    expect(record.statusHistory).toHaveLength(5);
  });

  it('completion metadata is set on done, cleared on reopen, re-recorded when done again', () => {
    let record = project({ status: 'ongoing' });
    record = setProjectLifecycleStatus(record, 'done', '2026-09-17T18:00:00.000Z', 'Yamada');
    expect(record.completedAt).toBe('2026-09-17T18:00:00.000Z');
    expect(record.completedBy).toBe('Yamada');
    record = reopenProject(record, 'ongoing', '2026-09-18T09:00:00.000Z');
    expect(record.completedAt).toBeNull();
    expect(record.statusHistory.some((h) => h.status === 'done')).toBe(true);
    record = setProjectLifecycleStatus(record, 'done', '2026-09-20T18:00:00.000Z');
    expect(record.completedAt).toBe('2026-09-20T18:00:00.000Z');
    expect(record.statusHistory.filter((h) => h.status === 'done')).toHaveLength(2);
  });

  it('100% progress never auto-completes the lifecycle', () => {
    const record = project({ status: 'ongoing', inputs: inputs({ casesCompleted: 100, totalCases: 100 }) });
    expect(projectPlanningStatus(record)).toBe('completed');
    expect(record.status).toBe('ongoing');
  });
});

describe('named selectors', () => {
  const p1 = project({ nameEn: 'A', status: 'todo', inputs: inputs({ casesCompleted: 0 }) });
  const p2 = project({ nameEn: 'B', status: 'ongoing', inputs: inputs({ targetCompletionDate: '2026-09-16' }) }, [p1]); // overdue
  const p3 = project(
    { nameEn: 'C', inputs: inputs({ casesCompleted: 0, totalCases: 500, targetCompletionDate: '2026-09-18' }) }, // capacity shortage (future deadline)
    [p1, p2],
  );
  const p4 = project({ nameEn: 'D', status: 'done' }, [p1, p2, p3]);

  it('getActiveProjects / getCompletedProjects / byLifecycle', () => {
    expect(getActiveProjects([p1, p2, p3, p4]).map((p) => p.nameEn)).toEqual(['A', 'B', 'C']);
    expect(getCompletedProjects([p1, p2, p3, p4]).map((p) => p.nameEn)).toEqual(['D']);
    expect(getProjectsByLifecycleStatus([p1, p2, p3, p4], 'ongoing').map((p) => p.nameEn)).toEqual(['B', 'C']);
  });

  it('getProjectsByPlanningStatus / getProjectsNeedingAttention', () => {
    expect(getProjectsByPlanningStatus([p1, p2, p3, p4], 'overdue', TODAY, NOW).map((p) => p.nameEn)).toEqual(['B']);
    expect(getProjectsByPlanningStatus([p1, p2, p3, p4], 'capacityShortage', TODAY, NOW).map((p) => p.nameEn)).toEqual(['C']);
    const attention = getProjectsNeedingAttention([p1, p2, p3], TODAY, NOW).map((p) => p.nameEn);
    expect(attention).toContain('B');
    expect(attention).toContain('C');
    expect(attention).not.toContain('A');
  });

  it('findProjectByProjectId', () => {
    expect(findProjectByProjectId([p1, p2], p2.projectId)?.nameEn).toBe('B');
    expect(findProjectByProjectId([p1], 'PRJ-999')).toBeUndefined();
  });
});

describe('migration of pre-projectId data', () => {
  it('ensureProjectIds backfills unique stable IDs without touching existing ones', () => {
    const legacyA = { ...project(), projectId: undefined } as unknown as ProjectRecord;
    const legacyB = { ...project({}, [legacyA]), projectId: undefined } as unknown as ProjectRecord;
    const modern = project({ projectId: 'PRJ-001' });
    const migrated = ensureProjectIds([modern, legacyA, legacyB]);
    expect(migrated[0].projectId).toBe('PRJ-001'); // untouched
    expect(migrated[1].projectId).toBe('PRJ-002');
    expect(migrated[2].projectId).toBe('PRJ-003');
    expect(new Set(migrated.map((p) => p.projectId)).size).toBe(3);
  });

  it('old single-project data migrates into exactly one registry record', () => {
    const state = appState({ projectNameEn: 'Legacy Suite', projectNameJa: 'レガシー' });
    const record = seedInitialProjectRecord(state, 'PrV', NOW);
    expect(record.status).toBe('ongoing');
    expect(record.nameEn).toBe('Legacy Suite');
    expect(record.nameJa).toBe('レガシー');
    expect(record.projectId).toBe('PRJ-001');
    expect(record.inputs.totalCases).toBe(DEMO_STATE.totalCases);
    expect(record.inputs.planningRows).toEqual(DEMO_STATE.planningRows);
  });

  it('storage accepts pre-ID projects and normalizes them on load', () => {
    const state = defaultReportsState();
    const legacyProject = { ...project(), projectId: undefined } as unknown as ProjectRecord;
    const payload = { ...state, projects: [legacyProject], activeProjectId: legacyProject.id };
    expect(isReportsState(payload)).toBe(true);
    const normalized = normalizeReportsState(payload);
    expect(normalized.projects[0].projectId).toBe('PRJ-001');
  });
});

describe('backup round-trip with the project registry', () => {
  function multiProjectReportsState(): ReportsState {
    const state = defaultReportsState();
    const p1 = project({ nameEn: 'Android 4.1.0', status: 'todo', inputs: inputs({ casesCompleted: 0 }) });
    const p2 = project({ nameEn: 'iOS 4.1.0', team: 'RCS', inputs: inputs({ casesCompleted: 50 }) }, [p1]);
    const p3 = project({ nameEn: 'RLO Desktop' }, [p1, p2]);
    const p4 = project({ nameEn: 'Completed', status: 'done', completedAt: '2026-09-10T18:00:00.000Z' }, [p1, p2, p3]);
    state.projects = [p1, p2, p3, p4];
    state.activeProjectId = p1.id;
    return state;
  }

  it('export → import → export preserves the full registry equivalence', () => {
    const appState = { ...DEMO_STATE };
    const reportsState = multiProjectReportsState();
    const backupText = JSON.stringify(createBackupPayload(appState, reportsState));
    const parsed = parseBackupPayload(backupText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const secondText = JSON.stringify(createBackupPayload(appState, parsed.data.reportsState));
    expect(JSON.parse(secondText).data.reportsState).toEqual(JSON.parse(backupText).data.reportsState);
    for (const project of parsed.data.reportsState.projects) {
      expect(project.projectId).toMatch(/^PRJ-\d+$/);
      expect(project.statusHistory.length).toBeGreaterThan(0);
    }
    expect(parsed.data.reportsState.projects.map((p) => p.projectId)).toEqual(['PRJ-001', 'PRJ-002', 'PRJ-003', 'PRJ-004']);
  });

  it('old backups without the registry import and migrate safely', () => {
    const legacyReports = defaultReportsState();
    const backup = JSON.stringify({
      app: 'ganttchart',
      kind: 'backup',
      version: 1,
      exportedAt: NOW,
      data: { appState: { ...DEMO_STATE }, reportsState: legacyReports },
    });
    const parsed = parseBackupPayload(backup);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.data.reportsState.projects).toEqual([]);
  });
});

describe('daily report project references and immutability', () => {
  it('drafts and finalized snapshots carry the stable Project ID', () => {
    const draft = newDraft('2026-09-17', 'en', 'sup', NOW, 'PRJ-002');
    expect(draft.projectId).toBe('PRJ-002');
    const finalized = finalizeReport(draft, [], [], 'sup', '2026-09-17T18:00:00.000Z');
    expect(finalized.snapshot?.projectId).toBe('PRJ-002');
  });

  it('finalized reports stay immutable when the project changes afterwards', () => {
    const project = newProjectRecord(
      inputs({ casesCompleted: 39, totalCases: 100 }),
      { nameEn: 'Android 4.1.0', status: 'ongoing' },
      NOW,
    );
    let draft = newDraft('2026-09-17', 'en', 'sup', NOW, project.projectId);
    draft = {
      ...draft,
      activities: [
        {
          id: 'a1',
          source: 'AUTO',
          name: 'Android 4.1.0',
          memberCount: 8,
          completedCases: 39,
          workingStatus: 'Working',
          included: true,
          totalCases: 100,
          workingEligibleCases: 100,
          startedCases: 39,
          blockedCases: 0,
          notApplicableCases: 0,
          dueDate: '2026-09-25',
        },
      ],
    };
    const finalized = finalizeReport(draft, [], [], 'sup', '2026-09-17T18:00:00.000Z');

    // After finalization the project is completed and renamed.
    const changedProject = setProjectLifecycleStatus(project, 'done', '2026-09-18T09:00:00.000Z');
    const renamedProject = { ...changedProject, nameEn: 'Android 4.1.1', inputs: inputs({ casesCompleted: 100 }) };

    // The finalized report keeps its original snapshot and project reference.
    expect(finalized.snapshot?.projectId).toBe('PRJ-001');
    expect(finalized.snapshot?.activities[0].name).toBe('Android 4.1.0');
    expect(finalized.snapshot?.activities[0].completedCases).toBe(39);
    expect(renamedProject.nameEn).toBe('Android 4.1.1');
    expect(findProjectByProjectId([renamedProject], 'PRJ-001')?.projectId).toBe('PRJ-001');
  });
});

describe('exports include project identity', () => {
  it('projectsSheet includes Project ID and capacity columns', () => {
    const record = project({ nameEn: 'Android' });
    const sheet = projectsSheet('en', [record]);
    expect(sheet.headers[0]).toBe('Project ID');
    expect(sheet.headers).toContain('Capacity');
    expect(sheet.rows[0][0]).toBe('PRJ-001');
  });

  it('reportsSheet includes the Project ID column', () => {
    const report: DailyReport = newDraft('2026-09-17', 'en', 'sup', NOW, 'PRJ-002');
    const sheet = reportsSheet('en', [report]);
    expect(sheet.headers).toContain('Project ID');
    expect(sheet.rows[0][1]).toBe('PRJ-002');
  });
});

describe('i18n completeness for hardening keys', () => {
  it('all new keys exist in both dictionaries', () => {
    for (const key of ['columns.projectId', 'overall.addProject']) {
      expect(en[key as keyof typeof en]).toBeTruthy();
      expect(ja[key as keyof typeof ja]).toBeTruthy();
    }
  });

  it('the Extended / On Hold lifecycle keys exist in both dictionaries', () => {
    for (const key of ['overall.extended', 'overall.onHold', 'overall.setExtended', 'overall.setOnHold', 'status.onHold']) {
      expect(en[key as keyof typeof en]).toBeTruthy();
      expect(ja[key as keyof typeof ja]).toBeTruthy();
    }
  });
});

describe('Extended / On Hold lifecycle statuses (whole-system calculation)', () => {
  const lateInputs = inputs({ targetCompletionDate: '2026-09-10' }); // deadline already passed

  it('transitions to extended/onHold append history and never stamp completion', () => {
    const base = project({ status: 'ongoing' });
    const held = setProjectLifecycleStatus(base, 'onHold', NOW);
    expect(held.status).toBe('onHold');
    expect(held.completedAt).toBeNull();
    expect(held.statusHistory.map((h) => h.status)).toEqual(['ongoing', 'onHold']);
    const extended = setProjectLifecycleStatus(held, 'extended', NOW);
    expect(extended.status).toBe('extended');
    expect(extended.statusHistory).toHaveLength(3);
    // Done keeps its special completion stamping; extended/onHold clear it.
    const done = setProjectLifecycleStatus(extended, 'done', NOW, 'Yamada');
    expect(done.completedAt).toBe(NOW);
    expect(done.completedBy).toBe('Yamada');
    const reopened = reopenProject(done, 'extended', NOW);
    expect(reopened.status).toBe('extended');
    expect(reopened.completedAt).toBeNull();
  });

  it('portfolioSummary counts extended and onHold separately (both stay active)', () => {
    const projects = [
      project({ status: 'todo', inputs: inputs({ casesCompleted: 0 }) }),
      project({ status: 'ongoing' }, []),
      project({ status: 'extended' }, []),
      project({ status: 'onHold' }, []),
      project({ status: 'done', completedAt: '2026-09-10T18:00:00.000Z' }, []),
    ];
    const summary = portfolioSummary(projects, TODAY);
    expect(summary.total).toBe(5);
    expect(summary.todo).toBe(1);
    expect(summary.ongoing).toBe(1);
    expect(summary.extended).toBe(1);
    expect(summary.onHold).toBe(1);
    expect(summary.done).toBe(1);
    // Extended and On Hold are active (not done).
    expect(getActiveProjects(projects).map((p) => p.status).sort()).toEqual(['extended', 'onHold', 'ongoing', 'todo']);
  });

  it('an on-hold project masks the planning status to "onHold"', () => {
    const held = project({ status: 'onHold', inputs: lateInputs }); // engine would say atRisk/shortage
    expect(projectPlanningStatus(held)).toBe('onHold');
    const extended = project({ status: 'extended', inputs: lateInputs }, [held]);
    expect(projectPlanningStatus(extended)).not.toBe('onHold'); // engine runs normally
  });

  it('on hold suspends overdue and needs-attention; extended is measured against its deadline', () => {
    const held = project({ status: 'onHold', inputs: lateInputs });
    expect(isProjectOverdue(held, TODAY)).toBe(false);
    expect(getProjectsNeedingAttention([held], TODAY, NOW)).toHaveLength(0);
    const extended = project({ status: 'extended', inputs: lateInputs }, [held]);
    expect(isProjectOverdue(extended, TODAY)).toBe(true); // extended ≠ paused
  });

  it('on hold contributes zero active capacity; extended keeps its team capacity', () => {
    const held = project({ status: 'onHold' });
    expect(projectDailyCapacity(held)).toBe(0);
    const extended = project({ status: 'extended' }, [held]);
    expect(projectDailyCapacity(extended)).toBe(60); // 2 testers × 4/h × 7.5h
  });

  it('the lifecycle and planning filters select extended / onHold projects', () => {
    const projects = [
      project({ status: 'ongoing' }),
      project({ status: 'extended' }, []),
      project({ status: 'onHold' }, []),
      project({ status: 'done', completedAt: '2026-09-10T18:00:00.000Z' }, []),
    ];
    expect(filterProjects(projects, { ...DEFAULT_PORTFOLIO_FILTERS, lifecycle: 'extended' }, TODAY, NOW).map((p) => p.status)).toEqual(['extended']);
    expect(filterProjects(projects, { ...DEFAULT_PORTFOLIO_FILTERS, lifecycle: 'onHold' }, TODAY, NOW).map((p) => p.status)).toEqual(['onHold']);
    // Active keeps extended/onHold visible alongside todo/ongoing.
    expect(filterProjects(projects, { ...DEFAULT_PORTFOLIO_FILTERS }, TODAY, NOW).map((p) => p.status).sort()).toEqual(['extended', 'onHold', 'ongoing']);
    // Planning-status filter "onHold" matches the masked planning state.
    expect(filterProjects(projects, { ...DEFAULT_PORTFOLIO_FILTERS, planning: 'onHold' }, TODAY, NOW).map((p) => p.status)).toEqual(['onHold']);
    // On-hold projects never match onTrack.
    expect(filterProjects(projects, { ...DEFAULT_PORTFOLIO_FILTERS, planning: 'onTrack' }, TODAY, NOW).map((p) => p.status)).not.toContain('onHold');
  });

  it('the default portfolio sort orders todo → ongoing → extended → onHold → done', () => {
    const projects = [
      project({ status: 'done', completedAt: '2026-09-10T18:00:00.000Z' }),
      project({ status: 'onHold' }, []),
      project({ status: 'extended' }, []),
      project({ status: 'ongoing' }, []),
      project({ status: 'todo', inputs: inputs({ casesCompleted: 0 }) }, []),
    ];
    expect(sortProjects(projects, 'default').map((p) => p.status)).toEqual(['todo', 'ongoing', 'extended', 'onHold', 'done']);
  });

  it('storage guards and backup round-trips accept the new statuses', () => {
    const held = project({ status: 'onHold', inputs: lateInputs });
    const extended = project({ status: 'extended', inputs: lateInputs }, [held]);
    const state = { ...defaultReportsState(), projects: [held, extended] };
    expect(isReportsState(state)).toBe(true);
    const normalized = normalizeReportsState(state);
    expect(normalized.projects.map((p) => p.status).sort()).toEqual(['extended', 'onHold']);
    const backup = createBackupPayload(appState(), state);
    const parsed = parseBackupPayload(JSON.stringify(backup));
    expect(parsed.ok && parsed.data.reportsState.projects.map((p) => p.status).sort()).toEqual(['extended', 'onHold']);
  });
});

describe('Schedule Overview row order (start datetime)', () => {
  it('orders rows by start date, earliest first, regardless of input order', () => {
    const late = project({ nameEn: 'Late' });
    const early = project({ nameEn: 'Early', inputs: inputs({ startDate: '2026-09-01' }) }, [late]);
    const mid = project({ nameEn: 'Mid', inputs: inputs({ startDate: '2026-09-07' }) }, [late, early]);
    expect([late, mid, early].sort(compareByStartDateTime).map((p) => p.nameEn)).toEqual(['Early', 'Mid', 'Late']);
  });

  it('breaks same-day ties with the work start time', () => {
    const afternoon = project({ nameEn: 'Afternoon', inputs: inputs({ startTime: 780 }) });
    const morning = project({ nameEn: 'Morning', inputs: inputs({ startTime: 540 }) }, [afternoon]);
    expect([afternoon, morning].sort(compareByStartDateTime).map((p) => p.nameEn)).toEqual(['Morning', 'Afternoon']);
  });

  it('falls back to the Project ID for identical start datetimes (stable order)', () => {
    const first = project({ nameEn: 'B-name' });
    const second = project({ nameEn: 'A-name' }, [first]); // PRJ-002
    expect(compareByStartDateTime(first, second)).toBeLessThan(0);
    expect(compareByStartDateTime(second, first)).toBeGreaterThan(0);
    expect(compareByStartDateTime(first, first)).toBe(0);
  });
});

describe('acceptance scenario (data level)', () => {
  function scenario(): ProjectRecord[] {
    const p1 = project({ nameEn: 'Android 4.1.0', status: 'todo', inputs: inputs({ casesCompleted: 0 }) });
    const p2 = project({ nameEn: 'iOS 4.1.0', status: 'ongoing', team: 'RCS' }, [p1]);
    const p3 = project({ nameEn: 'RLO Desktop', status: 'ongoing' }, [p1, p2]);
    const p4 = project({ nameEn: 'Regression Project', status: 'done', completedAt: '2026-09-10T18:00:00.000Z' }, [p1, p2, p3]);
    return [p1, p2, p3, p4];
  }

  it('Test 1/2/3: Active hides done; All shows everything; Done shows only done', () => {
    const projects = scenario();
    expect(filterProjects(projects, { ...DEFAULT_PORTFOLIO_FILTERS }, TODAY, NOW).map((p) => p.projectId)).toEqual(['PRJ-001', 'PRJ-002', 'PRJ-003']);
    expect(filterProjects(projects, { ...DEFAULT_PORTFOLIO_FILTERS, lifecycle: 'all' }, TODAY, NOW)).toHaveLength(4);
    expect(filterProjects(projects, { ...DEFAULT_PORTFOLIO_FILTERS, lifecycle: 'done' }, TODAY, NOW).map((p) => p.projectId)).toEqual(['PRJ-004']);
  });

  it('Test 4: reopening PRJ-004 returns it to the Active view', () => {
    const projects = scenario();
    const reopened = projects.map((p) => (p.projectId === 'PRJ-004' ? reopenProject(p, 'ongoing', '2026-09-18T09:00:00.000Z') : p));
    expect(filterProjects(reopened, { ...DEFAULT_PORTFOLIO_FILTERS }, TODAY, NOW).map((p) => p.projectId)).toEqual(['PRJ-001', 'PRJ-002', 'PRJ-003', 'PRJ-004']);
  });

  it('Test 5: a lifecycle change is immediately visible in derived data', () => {
    const projects = scenario();
    const changed = projects.map((p) => (p.projectId === 'PRJ-001' ? setProjectLifecycleStatus(p, 'ongoing', NOW) : p));
    expect(getProjectsByLifecycleStatus(changed, 'ongoing').map((p) => p.projectId)).toContain('PRJ-001');
    expect(getProjectsByLifecycleStatus(changed, 'todo')).toHaveLength(0);
  });

  it('Test 6/7: planning edits sync to the active project only, and switching projects loads their own data', () => {
    const projects = scenario();
    const edited = applyActiveProjectSync(
      projects,
      projects[0].id,
      'Android 4.1.0',
      projects[0].nameJa,
      inputs({ casesCompleted: 70 }),
      '2026-09-17T12:00:00.000Z',
    );
    const overall = sortProjects(filterProjects(edited, { ...DEFAULT_PORTFOLIO_FILTERS }, TODAY, NOW), 'default');
    expect(overall[0].inputs.casesCompleted).toBe(70); // updated planning appears in Overall
    expect(overall[0].updatedAt).toBe('2026-09-17T12:00:00.000Z');
    // PRJ-002 still has its own untouched data — no stale PRJ-001 state leaks in.
    const ios = findProjectByProjectId(edited, 'PRJ-002');
    expect(ios?.inputs.casesCompleted).toBe(40);
    expect(ios?.team).toBe('RCS');
  });
});
