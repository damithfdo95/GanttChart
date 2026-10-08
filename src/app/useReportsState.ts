import { useCallback, useState } from 'react';
import type {
  AppState,
  AttendanceRecord,
  Cycle,
  DailyReport,
  DailyTopic,
  IdentityAuditEntry,
  ProjectLifecycleStatus,
  ProjectRecord,
  RcsMember,
  ReportSettings,
  ReportsState,
  TesterProjectAssignment,
  TesterReview,
} from '../types';
import type { MeetingState } from '../domain/meeting/state';
import { loadReportsState } from '../lib/storage/reports';
import { removeProjectFromRegistry } from '../domain/projects/lifecycle';
import type { TestManagementState } from '../domain/testManagement';
import { setProjectLifecycleStatus as setProjectLifecycleStatusImpl } from '../domain/projects/lifecycle';
import { seedInitialProjectRecord } from '../domain/projects/migrations';
import { applyRecordChanges } from '../lib/sync/records';
import type { RecordDelete, RecordPut } from '../../shared/protocol';
import { upsertTesterAssignment as upsertTesterAssignmentImpl } from '../domain/assignments';
import { upsertTesterReview as upsertTesterReviewImpl } from '../domain/reviews';
import { upsertRcsMember as upsertRcsMemberImpl } from '../domain/members';

export interface ReportsStateApi {
  state: ReportsState;
  updateSettings: (patch: Partial<ReportSettings>) => void;
  addAttendance: (record: AttendanceRecord) => void;
  updateAttendance: (id: string, patch: Partial<AttendanceRecord>) => void;
  removeAttendance: (id: string) => void;
  addTopic: (topic: DailyTopic) => void;
  updateTopic: (id: string, patch: Partial<DailyTopic>) => void;
  removeTopic: (id: string) => void;
  setTopics: (topics: DailyTopic[]) => void;
  upsertReport: (report: DailyReport) => void;
  /** Remove a DRAFT report by id (empty-draft cleanup); finalized reports are immutable history. */
  removeReport: (id: string) => void;
  updateProject: (id: string, patch: Partial<ProjectRecord>) => void;
  setProjects: (projects: ProjectRecord[]) => void;
  setProjectStatus: (id: string, status: ProjectLifecycleStatus, by?: string) => void;
  addProject: (record: ProjectRecord) => void;
  /** Remove a project and its reports; fixes the active-project fallback (V6.3 §12). */
  removeProject: (id: string) => void;
  /** Full state replacement (backup restore / clear-all, V6.3 §10/§13). */
  replaceReportsState: (next: ReportsState) => void;
  /**
   * Shared workspace: apply records changed by someone else. A functional
   * update, so it merges with any local edit React is still processing
   * instead of overwriting it.
   */
  applyRemoteChanges: (puts: readonly RecordPut[], deletes: readonly RecordDelete[]) => void;
  setActiveProjectId: (id: string | null) => void;
  /** One-time migration: seed the portfolio from the existing single-project data. */
  seedInitialProject: (appState: AppState) => void;
  /** Tester→project assignments (V6.7): add or replace one by id. */
  upsertTesterAssignment: (assignment: TesterProjectAssignment) => void;
  /** Tester→project assignments (V6.7): remove one by id. */
  removeTesterAssignment: (id: string) => void;
  /** Test cycles (Stage 8A): add or replace one cycle by id. */
  upsertCycle: (cycle: Cycle) => void;
  /** Replace the whole roster (used by the legacy-placeholder clean-up only). */
  setRcsMembers: (members: RcsMember[]) => void;
  /** Test Management (Stage 8C): transform scopes, cases and results in ONE state update (one commit, however many records change). */
  updateTestManagement: (fn: (tm: TestManagementState) => TestManagementState) => void;
  /** Change the team meeting's plans and notes as ONE update (one commit to the shared workspace). */
  updateMeeting: (fn: (m: MeetingState) => MeetingState) => void;
  /** Review records (V6.7): save one review (same tester+period updates in place). */
  upsertReview: (review: TesterReview) => void;
  /** Review records (V6.7): remove one by id. */
  removeReview: (id: string) => void;
  /** RCS member master (V6.8): add or replace one member by stable id. */
  upsertMember: (member: RcsMember) => void;
  /** RCS member master (V6.8): remove one member by id. */
  removeMember: (id: string) => void;
  /** Identity-resolution audit (V6.9-B §29): append entries to the append-only log. */
  appendIdentityAudit: (entries: IdentityAuditEntry[]) => void;
}

/**
 * Daily-report module state. Persistence is centralized in AppProviders
 * (V6.3 §5): this hook owns the canonical state and its actions only. The
 * initial state comes from the V6.6 startup bootstrap (IndexedDB primary,
 * localStorage fallback) — both run the same existing normalization.
 */
export function useReportsState(initial?: ReportsState): ReportsStateApi {
  const [state, setState] = useState<ReportsState>(() => initial ?? loadReportsState());

  const updateSettings = useCallback((patch: Partial<ReportSettings>): void => {
    setState((prev) => ({ ...prev, settings: { ...prev.settings, ...patch } }));
  }, []);

  const addAttendance = useCallback((record: AttendanceRecord): void => {
    setState((prev) => ({ ...prev, attendance: [...prev.attendance, record] }));
  }, []);

  const updateAttendance = useCallback((id: string, patch: Partial<AttendanceRecord>): void => {
    setState((prev) => ({
      ...prev,
      attendance: prev.attendance.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }));
  }, []);

  const removeAttendance = useCallback((id: string): void => {
    setState((prev) => ({ ...prev, attendance: prev.attendance.filter((r) => r.id !== id) }));
  }, []);

  const addTopic = useCallback((topic: DailyTopic): void => {
    setState((prev) => ({ ...prev, topics: [...prev.topics, topic] }));
  }, []);

  const updateTopic = useCallback((id: string, patch: Partial<DailyTopic>): void => {
    setState((prev) => ({ ...prev, topics: prev.topics.map((tp) => (tp.id === id ? { ...tp, ...patch } : tp)) }));
  }, []);

  const removeTopic = useCallback((id: string): void => {
    setState((prev) => ({ ...prev, topics: prev.topics.filter((tp) => tp.id !== id) }));
  }, []);

  const setTopics = useCallback((topics: DailyTopic[]): void => {
    setState((prev) => ({ ...prev, topics }));
  }, []);

  const upsertReport = useCallback((report: DailyReport): void => {
    setState((prev) => {
      const exists = prev.reports.some((r) => r.id === report.id);
      const reports = exists
        ? prev.reports.map((r) => (r.id === report.id ? report : r))
        : [...prev.reports, report];
      return { ...prev, reports };
    });
  }, []);

  const removeReport = useCallback((id: string): void => {
    setState((prev) => ({
      ...prev,
      reports: prev.reports.filter((r) => r.id !== id || r.status === 'FINALIZED'),
    }));
  }, []);

  const updateProject = useCallback((id: string, patch: Partial<ProjectRecord>): void => {
    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));
  }, []);

  const setProjects = useCallback((projects: ProjectRecord[]): void => {
    setState((prev) => ({ ...prev, projects }));
  }, []);

  const setProjectStatusById = useCallback((id: string, status: ProjectLifecycleStatus, by?: string): void => {
    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((p) =>
        p.id === id ? setProjectLifecycleStatusImpl(p, status, new Date().toISOString(), by) : p,
      ),
    }));
  }, []);

  const addProject = useCallback((record: ProjectRecord): void => {
    setState((prev) => ({ ...prev, projects: [...prev.projects, record] }));
  }, []);

  const removeProject = useCallback((id: string): void => {
    setState((prev) => {
      const target = prev.projects.find((p) => p.id === id);
      if (target === undefined) return prev;
      const removal = removeProjectFromRegistry(prev.projects, prev.reports, prev.activeProjectId, id);
      // The project's scopes, test cases and results go with it (they have no meaning without it).
      const gone = (r: { projectId: string }): boolean => r.projectId !== target.projectId;
      return {
        ...prev,
        scopes: (prev.scopes ?? []).filter(gone),
        testCases: (prev.testCases ?? []).filter(gone),
        caseResults: (prev.caseResults ?? []).filter(gone),
        dailyPlans: (prev.dailyPlans ?? []).filter(gone),
        projects: removal.projects,
        reports: removal.reports,
        activeProjectId: removal.nextActiveProjectId,
      };
    });
  }, []);

  const replaceReportsState = useCallback((next: ReportsState): void => {
    setState(next);
  }, []);

  const applyRemoteChanges = useCallback((puts: readonly RecordPut[], deletes: readonly RecordDelete[]): void => {
    setState((prev) => applyRecordChanges(prev, puts, deletes));
  }, []);

  const setActiveProjectId = useCallback((id: string | null): void => {
    setState((prev) => ({ ...prev, activeProjectId: id }));
  }, []);

  const seedInitialProject = useCallback((appState: AppState): void => {
    setState((prev) => {
      if (prev.projects.length > 0) return prev;
      const nowIso = new Date().toISOString();
      const project = seedInitialProjectRecord(appState, prev.settings.teams[0] ?? '', nowIso);
      return { ...prev, projects: [project], activeProjectId: project.id };
    });
  }, []);

  const upsertTesterAssignmentAction = useCallback((assignment: TesterProjectAssignment): void => {
    setState((prev) => ({ ...prev, testerAssignments: upsertTesterAssignmentImpl(prev.testerAssignments ?? [], assignment) }));
  }, []);

  const removeTesterAssignmentAction = useCallback((id: string): void => {
    setState((prev) => ({ ...prev, testerAssignments: (prev.testerAssignments ?? []).filter((a) => a.id !== id) }));
  }, []);

  const updateTestManagementAction = useCallback((fn: (tm: TestManagementState) => TestManagementState): void => {
    setState((prev) => {
      const before: TestManagementState = { scopes: prev.scopes ?? [], testCases: prev.testCases ?? [], caseResults: prev.caseResults ?? [] };
      const after = fn(before);
      if (after.scopes === before.scopes && after.testCases === before.testCases && after.caseResults === before.caseResults) return prev;
      return { ...prev, scopes: after.scopes, testCases: after.testCases, caseResults: after.caseResults };
    });
  }, []);

  const updateMeetingAction = useCallback((fn: (m: MeetingState) => MeetingState): void => {
    setState((prev) => {
      const before: MeetingState = { dailyPlans: prev.dailyPlans ?? [], meetingNotes: prev.meetingNotes ?? [] };
      const after = fn(before);
      if (after.dailyPlans === before.dailyPlans && after.meetingNotes === before.meetingNotes) return prev;
      return { ...prev, dailyPlans: after.dailyPlans, meetingNotes: after.meetingNotes };
    });
  }, []);

  const setRcsMembersAction = useCallback((members: RcsMember[]): void => {
    setState((prev) => ({ ...prev, rcsMembers: members }));
  }, []);

  const upsertCycleAction = useCallback((cycle: Cycle): void => {
    setState((prev) => {
      const cycles = prev.cycles ?? [];
      return { ...prev, cycles: cycles.some((c) => c.id === cycle.id) ? cycles.map((c) => (c.id === cycle.id ? cycle : c)) : [...cycles, cycle] };
    });
  }, []);

  const upsertReviewAction = useCallback((review: TesterReview): void => {
    setState((prev) => ({ ...prev, reviews: upsertTesterReviewImpl(prev.reviews ?? [], review) }));
  }, []);

  const removeReviewAction = useCallback((id: string): void => {
    setState((prev) => ({ ...prev, reviews: (prev.reviews ?? []).filter((review) => review.id !== id) }));
  }, []);

  const upsertMemberAction = useCallback((member: RcsMember): void => {
    setState((prev) => ({ ...prev, rcsMembers: upsertRcsMemberImpl(prev.rcsMembers ?? [], member) }));
  }, []);

  const removeMemberAction = useCallback((id: string): void => {
    setState((prev) => ({ ...prev, rcsMembers: (prev.rcsMembers ?? []).filter((member) => member.id !== id) }));
  }, []);

  const appendIdentityAuditAction = useCallback((entries: IdentityAuditEntry[]): void => {
    if (entries.length === 0) return;
    // Append-only (V6.9-B §29): existing audit history is never rewritten.
    setState((prev) => ({ ...prev, identityAuditLog: [...(prev.identityAuditLog ?? []), ...entries] }));
  }, []);

  return {
    state,
    updateSettings,
    addAttendance,
    updateAttendance,
    removeAttendance,
    addTopic,
    updateTopic,
    removeTopic,
    setTopics,
    upsertReport,
    removeReport,
    updateProject,
    setProjects,
    setProjectStatus: setProjectStatusById,
    addProject,
    removeProject,
    replaceReportsState,
    applyRemoteChanges,
    setActiveProjectId,
    seedInitialProject,
    upsertTesterAssignment: upsertTesterAssignmentAction,
    removeTesterAssignment: removeTesterAssignmentAction,
    upsertCycle: upsertCycleAction,
    setRcsMembers: setRcsMembersAction,
    updateTestManagement: updateTestManagementAction,
    updateMeeting: updateMeetingAction,
    upsertReview: upsertReviewAction,
    removeReview: removeReviewAction,
    upsertMember: upsertMemberAction,
    removeMember: removeMemberAction,
    appendIdentityAudit: appendIdentityAuditAction,
  };
}
