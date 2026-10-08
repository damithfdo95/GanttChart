import type { AppState, ReportsState } from '../../types';
import type { Language } from '../../types';
import { seedInitialProjectRecord } from '../../domain/projects/migrations';
import { DEMO_STATE, normalizeAppState } from '../storage/storage';
import { defaultReportsState } from '../storage/reports';

/**
 * The starter project of a brand-new shared workspace uses FIXED ids. If two
 * people create the workspace at the same moment, both write the same record;
 * the server accepts one and rejects the other as a conflict, so the portfolio
 * can never end up with two starter projects.
 */
export const STARTER_PROJECT_ID = 'starter-project';
export const STARTER_PROJECT_CODE = 'PRJ-001';

export function starterWorkspace(language: Language, local: ReportsState, nowIso: string): { app: AppState; reports: ReportsState } {
  const app = normalizeAppState({ ...DEMO_STATE, language });
  const base = defaultReportsState();
  const seeded = seedInitialProjectRecord(app, base.settings.teams[0] ?? '', nowIso);
  const project = { ...seeded, id: STARTER_PROJECT_ID, projectId: STARTER_PROJECT_CODE };
  return {
    app,
    reports: {
      ...base,
      projects: [project],
      activeProjectId: project.id,
      // Per-device settings survive.
      settings: { ...base.settings, ...(local.settings.autoBackup !== undefined ? { autoBackup: local.settings.autoBackup } : {}) },
    },
  };
}

/**
 * A reports state with every SHARED collection emptied and the per-device
 * fields kept — the starting point for "use the shared workspace", so nothing
 * from this device can reach the shared workspace.
 */
export function emptySharedState(local: ReportsState): ReportsState {
  return {
    ...local,
    projects: [],
    reports: [],
    attendance: [],
    topics: [],
    testerAssignments: [],
    reviews: [],
    rcsMembers: [],
    identityAuditLog: [],
    externalIdentities: [],
    cycles: [],
    scopes: [],
    testCases: [],
    caseResults: [],
    dailyPlans: [],
    meetingNotes: [],
    activeProjectId: null,
  };
}
