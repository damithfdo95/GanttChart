import type {
  CaseResult,
  DailyReport,
  DailyTeamPlan,
  ProjectRecord,
  RcsMember,
  TestCase,
  TestScope,
} from '../../types';
import { generateId } from '../id';
import { nextProjectId } from '../../domain/projects/lifecycle';
import { isDailyReportGuard, isProjectRecordGuard } from '../storage/reports';
import { normalizeQaInputs } from '../storage/storage';
import { caseResultId, checkCaseExecution, checkCaseResult, checkScope, checkTestCase, type CaseExecutionEvent } from '../../../shared/testManagement';
import { checkDailyPlan, dailyPlanId } from '../../../shared/meeting';

/**
 * Single-project backup format (V6.3 §8; Stage 8C/8D extensions). Contains
 * everything needed to restore one project: the project record (Project ID,
 * names, lifecycle, QaInputs incl. SPO対応 and execution state, planning
 * rows, manual overrides, milestones, blocking events, metadata), the daily
 * reports belonging to that project and — since Stage 8C/8D — the project's
 * test management (scopes, cases, results) and daily meeting plans.
 * Transient UI state, meeting notes and the member roster are never
 * exported, and neither is any account assignment.
 *
 * Versioning/migration (V6.3 §6–§7): `version` is the payload schema
 * version; `migrateProjectBackupData` runs the versioned migration pipeline
 * before normalization. Stage 8C/8D files carry optional `testManagement`
 * and `dailyPlans` fields, omitted entirely when the project has none, so
 * every older file imports unchanged.
 */
export const PROJECT_BACKUP_VERSION = 1;

/** The project's test management as carried by a project backup file (Stage 8C). */
export interface ProjectTestManagementData {
  scopes: TestScope[];
  testCases: TestCase[];
  caseResults: CaseResult[];
  /** Append-only execution history of this project's cases (absent in files made before Phase 4). */
  caseExecutions?: CaseExecutionEvent[];
}

export interface ProjectBackupData {
  project: ProjectRecord;
  reports: DailyReport[];
  /** Stage 8C: this project's scopes, cases and results. Omitted when the project has none (old-format files). */
  testManagement?: ProjectTestManagementData;
  /** Stage 8D: this project's daily plans. Omitted when the project has none (old-format files). Never meeting notes. */
  dailyPlans?: DailyTeamPlan[];
}

export interface ProjectBackupPayload {
  app: 'ganttchart';
  kind: 'project';
  version: number;
  exportedAt: string;
  data: ProjectBackupData;
}

export type ProjectBackupParseResult =
  | { ok: true; data: ProjectBackupData }
  | { ok: false };

/** The registry's test management an import may collide with (Stage 8C). */
export interface ProjectImportExisting {
  scopes?: readonly TestScope[];
  testCases?: readonly TestCase[];
  caseResults?: readonly CaseResult[];
  caseExecutions?: readonly CaseExecutionEvent[];
}

export interface ProjectImportOptions {
  /** The registry's current records, for collision-safe id regeneration (Stage 8C). */
  existing?: ProjectImportExisting;
  /** The destination's member roster. When provided, member references in the file are kept only where the destination has that very person (id AND name). */
  members?: readonly RcsMember[];
  /** In a shared workspace, the restoring person's account: restored case results are attributed to them. In plain local use they stay as exported. */
  actor?: string;
}

export interface ProjectImportResult {
  /** New full registry (existing projects + the imported project appended). */
  projects: ProjectRecord[];
  /** New full reports list (existing + the imported project's reports). */
  reports: DailyReport[];
  /** Only the reports that were added (for incremental upserts). */
  newReports: DailyReport[];
  /** The project record as it exists in the new registry (possibly re-IDed). */
  importedProject: ProjectRecord;
  /** The project's test management as it exists in the new registry (possibly re-identified). */
  testManagement: ProjectTestManagementData;
  /** The project's daily plans, re-pointed at the imported project and its (re-identified) scopes. */
  dailyPlans: DailyTeamPlan[];
}

/**
 * Build the export payload for one project and its reports (deep copies).
 * Stage 8C/8D: the optional test-management snapshot and daily plans cover
 * THIS project only — another project's records never travel with the file.
 * The `testManagement`/`dailyPlans` fields are omitted entirely when the
 * project has none, so a project without either exports exactly the old
 * format.
 */
export function createProjectBackupPayload(
  project: ProjectRecord,
  reports: readonly DailyReport[],
  nowIso: string = new Date().toISOString(),
  tm?: {
    scopes?: readonly TestScope[];
    testCases?: readonly TestCase[];
    caseResults?: readonly CaseResult[];
    caseExecutions?: readonly CaseExecutionEvent[];
  },
  dailyPlans?: readonly DailyTeamPlan[],
): ProjectBackupPayload {
  const projectId = project.projectId;
  const scopes = (tm?.scopes ?? []).filter((s) => s.projectId === projectId).map((s) => ({ ...s }));
  const testCases = (tm?.testCases ?? []).filter((c) => c.projectId === projectId).map((c) => ({ ...c }));
  const caseResults = (tm?.caseResults ?? []).filter((r) => r.projectId === projectId).map((r) => ({ ...r }));
  const caseExecutions = (tm?.caseExecutions ?? []).filter((e) => e.projectId === projectId).map((e) => ({ ...e }));
  const plans = (dailyPlans ?? []).filter((p) => p.projectId === projectId).map((p) => ({ ...p }));
  const data: ProjectBackupData = {
    project: JSON.parse(JSON.stringify(project)) as ProjectRecord,
    reports: reports
      .filter((report) => report.projectId === projectId)
      .map((report) => ({ ...report })),
  };
  if (scopes.length > 0 || testCases.length > 0 || caseResults.length > 0 || caseExecutions.length > 0) {
    data.testManagement = { scopes, testCases, caseResults, ...(caseExecutions.length > 0 ? { caseExecutions } : {}) };
  }
  if (plans.length > 0) data.dailyPlans = plans;
  return {
    app: 'ganttchart',
    kind: 'project',
    version: PROJECT_BACKUP_VERSION,
    exportedAt: nowIso,
    data,
  };
}

const SUPPORTED_PROJECT_BACKUP_VERSIONS: readonly number[] = [PROJECT_BACKUP_VERSION];

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

function asArray(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

/**
 * Versioned migration pipeline (V6.3 §7): raw parsed data → detect version →
 * migrations → normalization. Version 1 is the oldest schema, so no explicit
 * steps run yet; unsupported newer versions are rejected clearly.
 *
 * Stage 8C/8D: records in the file that belong to another project, or are
 * malformed, are ignored — never repaired, never half-imported. A test case
 * whose scope is not in the file is dropped with its scope; a case result
 * whose case is not in the file is dropped with its case.
 */
function migrateProjectBackupData(parsed: Record<string, unknown>): ProjectBackupData | null {
  if (typeof parsed.version !== 'number' || !SUPPORTED_PROJECT_BACKUP_VERSIONS.includes(parsed.version)) {
    return null;
  }
  const data = parsed.data;
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (!isProjectRecordGuard(d.project)) return null;
  if (!Array.isArray(d.reports) || !d.reports.every((r) => isDailyReportGuard(r))) return null;
  const project = d.project;
  const projectId = project.projectId;
  const out: ProjectBackupData = {
    project: { ...project, inputs: normalizeQaInputs(project.inputs) },
    reports: (d.reports as DailyReport[]).map((report) => ({ ...report })),
  };
  const tm = d.testManagement;
  if (isPlainObject(tm)) {
    const scopes = asArray(tm.scopes).flatMap((raw) => {
      const checked = checkScope(raw);
      return checked.ok && checked.value.projectId === projectId ? [checked.value] : [];
    });
    const scopeIds = new Set(scopes.map((s) => s.id));
    const testCases = asArray(tm.testCases).flatMap((raw) => {
      const checked = checkTestCase(raw);
      return checked.ok && checked.value.projectId === projectId && scopeIds.has(checked.value.scopeId)
        ? [checked.value]
        : [];
    });
    const caseIds = new Set(testCases.map((c) => c.id));
    const caseResults = asArray(tm.caseResults).flatMap((raw) => {
      const checked = checkCaseResult(raw);
      return checked.ok && checked.value.projectId === projectId && caseIds.has(checked.value.testCaseId)
        ? [checked.value]
        : [];
    });
    // History events must point at a case of the file (and its own project): anything else is dropped, never guessed.
    const caseExecutions = asArray(tm.caseExecutions).flatMap((raw) => {
      const checked = checkCaseExecution(raw);
      return checked.ok && checked.value.projectId === projectId && caseIds.has(checked.value.testCaseId) && scopeIds.has(checked.value.scopeId)
        ? [checked.value]
        : [];
    });
    if (scopes.length > 0 || testCases.length > 0 || caseResults.length > 0 || caseExecutions.length > 0) {
      out.testManagement = { scopes, testCases, caseResults, ...(caseExecutions.length > 0 ? { caseExecutions } : {}) };
    }
  }
  if (Array.isArray(d.dailyPlans)) {
    const plans = d.dailyPlans.flatMap((raw) => {
      const checked = checkDailyPlan(raw);
      return checked.ok && checked.value.projectId === projectId ? [checked.value] : [];
    });
    if (plans.length > 0) out.dailyPlans = plans;
  }
  return out;
}

/**
 * Strictly validate and migrate a project backup file. Never throws; an
 * invalid file returns ok:false and the caller keeps its current state
 * untouched (V6.3 §10–§11).
 */
export function parseProjectBackupPayload(text: string): ProjectBackupParseResult {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return { ok: false };
    const p = parsed as Record<string, unknown>;
    if (p.app !== 'ganttchart' || p.kind !== 'project') return { ok: false };
    const migrated = migrateProjectBackupData(p);
    if (migrated === null) return { ok: false };
    return { ok: true, data: migrated };
  } catch {
    return { ok: false };
  }
}

/**
 * Import a project backup into the current registry (V6.3 §11; Stage 8C/8D).
 * Deterministic duplicate policy: when the imported project's stable Project
 * ID or internal id already exists, it is imported as a NEW project with a
 * freshly generated stable Project ID (never a silent overwrite) and its
 * test management and plans are re-identified with it; its reports are
 * re-keyed to the new ID and colliding report ids are regenerated. Without a
 * project-ID collision, only record ids that would collide with the
 * registry's existing test management are replaced — together, so
 * relationships survive and nothing is ever overwritten. Pure — inputs are
 * never mutated.
 */
export function importProjectIntoRegistry(
  existingProjects: readonly ProjectRecord[],
  existingReports: readonly DailyReport[],
  data: ProjectBackupData,
  options?: ProjectImportOptions,
): ProjectImportResult {
  const fileTm = data.testManagement;
  const filePlans = data.dailyPlans ?? [];
  let project = data.project;
  let reports = data.reports;

  const scopeIdMap = new Map<string, string>();
  const caseIdMap = new Map<string, string>();
  const regenerateScopeId = (oldId: string): string => {
    let next = scopeIdMap.get(oldId);
    if (next === undefined) {
      next = `scp_${generateId()}`;
      scopeIdMap.set(oldId, next);
    }
    return next;
  };
  const regenerateCaseId = (oldId: string): string => {
    let next = caseIdMap.get(oldId);
    if (next === undefined) {
      next = `tc_${generateId()}`;
      caseIdMap.set(oldId, next);
    }
    return next;
  };

  if (existingProjects.some((p) => p.projectId === project.projectId || p.id === project.id)) {
    // The imported project becomes a NEW project: fresh Project ID, and its
    // scoped records are re-identified with it.
    const newProjectId = nextProjectId(existingProjects);
    project = {
      ...project,
      id: generateId(),
      projectId: newProjectId,
      // V6.6: project-scoped records keep pointing at their (new) owner.
      inputs: {
        ...project.inputs,
        bugTickets: (project.inputs.bugTickets ?? []).map((ticket) => ({ ...ticket, projectId: newProjectId })),
        testerDailyPerformance: (project.inputs.testerDailyPerformance ?? []).map((record) => ({
          ...record,
          projectId: newProjectId,
        })),
      },
    };
    reports = reports.map((report) => ({
      ...report,
      id: generateId(),
      projectId: newProjectId,
      snapshot:
        report.snapshot === null
          ? null
          : { ...report.snapshot, projectId: newProjectId },
    }));
    if (fileTm !== undefined) {
      for (const s of fileTm.scopes) regenerateScopeId(s.id);
      for (const c of fileTm.testCases) regenerateCaseId(c.id);
    }
  } else {
    // Even without a project-ID collision, colliding report ids would
    // overwrite existing reports — regenerate deterministically instead.
    const existingReportIds = new Set(existingReports.map((r) => r.id));
    reports = reports.map((report) =>
      existingReportIds.has(report.id) ? { ...report, id: generateId() } : report,
    );
    // Test-management record ids that would collide with the registry are
    // replaced together (never an overwrite of the registry's own records).
    if (fileTm !== undefined && options?.existing !== undefined) {
      const existingScopeIds = new Set((options.existing.scopes ?? []).map((s) => s.id));
      const existingCaseIds = new Set((options.existing.testCases ?? []).map((c) => c.id));
      for (const s of fileTm.scopes) if (existingScopeIds.has(s.id)) regenerateScopeId(s.id);
      for (const c of fileTm.testCases) if (existingCaseIds.has(c.id)) regenerateCaseId(c.id);
    }
  }

  // ---- Test management: re-identified together, relationships preserved ----
  const targetProjectId = project.projectId;
  const actor = typeof options?.actor === 'string' && options.actor !== '' ? options.actor : null;
  // An event id that is already taken in the destination (the same file imported twice, a TestRail result seen in two projects) is replaced.
  const takenEventIds = new Set((options?.existing?.caseExecutions ?? []).map((e) => e.id));
  const testManagement: ProjectTestManagementData =
    fileTm === undefined
      ? { scopes: [], testCases: [], caseResults: [] }
      : {
          caseExecutions: (fileTm.caseExecutions ?? []).map((e) => {
            const id = takenEventIds.has(e.id) ? `evt_${generateId()}` : e.id;
            const rebuilt: CaseExecutionEvent = {
              ...e,
              id,
              testCaseId: caseIdMap.get(e.testCaseId) ?? e.testCaseId,
              scopeId: scopeIdMap.get(e.scopeId) ?? e.scopeId,
              projectId: targetProjectId,
            };
            if (actor !== null && e.source === 'manual') {
              // A shared workspace attributes restored manual events to the person restoring them (the server checks the actor).
              rebuilt.executedByUserId = actor;
              delete rebuilt.executedByMemberId;
            }
            return rebuilt;
          }),
          scopes: fileTm.scopes.map((s) => ({
            ...s,
            id: scopeIdMap.get(s.id) ?? s.id,
            projectId: targetProjectId,
          })),
          testCases: fileTm.testCases.map((c) => ({
            ...c,
            id: caseIdMap.get(c.id) ?? c.id,
            scopeId: scopeIdMap.get(c.scopeId) ?? c.scopeId,
            projectId: targetProjectId,
          })),
          caseResults: fileTm.caseResults.map((r) => {
            const testCaseId = caseIdMap.get(r.testCaseId) ?? r.testCaseId;
            const rebuilt: CaseResult = {
              ...r,
              id: caseResultId(testCaseId),
              testCaseId,
              scopeId: scopeIdMap.get(r.scopeId) ?? r.scopeId,
              projectId: targetProjectId,
            };
            if (actor !== null) {
              // A shared workspace attributes restored results to the person
              // restoring them; plain local use keeps them as exported.
              rebuilt.executedByUserId = actor;
              rebuilt.updatedByUserId = actor;
            }
            return rebuilt;
          }),
        };

  // ---- Daily plans: re-pointed at the imported project and its scopes ----
  // A scope plan whose scope is not in the file is dropped, not guessed.
  const fileScopeIds = new Set((fileTm?.scopes ?? []).map((s) => s.id));
  const dailyPlans: DailyTeamPlan[] = filePlans.flatMap((plan) => {
    if (plan.scopeId === undefined) {
      return plan.projectId === targetProjectId
        ? [{ ...plan }]
        : [repointPlan(plan, targetProjectId, undefined)];
    }
    if (scopeIdMap.has(plan.scopeId)) {
      return [repointPlan(plan, targetProjectId, scopeIdMap.get(plan.scopeId) as string)];
    }
    if (!fileScopeIds.has(plan.scopeId)) return [];
    return plan.projectId === targetProjectId
      ? [{ ...plan }]
      : [repointPlan(plan, targetProjectId, plan.scopeId)];
  });

  // ---- Member references: kept only where the destination has that very person ----
  if (Array.isArray(options?.members)) {
    const roster = options.members;
    const hasPerson = (memberId: string | undefined, name: string | undefined): boolean => {
      if (memberId === undefined || name === undefined) return false;
      const wanted = name.trim().toLowerCase();
      if (wanted === '') return false;
      return roster.some((m) => m.id === memberId && m.name.trim().toLowerCase() === wanted);
    };
    if (!hasPerson(project.ownerMemberId, project.owner)) {
      project = { ...project, ownerMemberId: undefined };
    }
    const bugTickets = (project.inputs.bugTickets ?? []).map((t) =>
      hasPerson(t.reporterMemberId, t.reportedBy) ? t : stripProp(t, 'reporterMemberId'),
    );
    const testerDailyPerformance = (project.inputs.testerDailyPerformance ?? []).map((r) =>
      hasPerson(r.memberId, r.testerName) ? r : stripProp(r, 'memberId'),
    );
    project = { ...project, inputs: { ...project.inputs, bugTickets, testerDailyPerformance } };
  }

  return {
    projects: [...existingProjects, project],
    reports: [...existingReports, ...reports],
    newReports: reports,
    importedProject: project,
    testManagement,
    dailyPlans,
  };
}

/** A plan copy pointed at `projectId`/`scopeId`, with its canonical id recomputed. */
function repointPlan(plan: DailyTeamPlan, projectId: string, scopeId: string | undefined): DailyTeamPlan {
  const out: Record<string, unknown> = { ...plan };
  delete out.scopeId;
  out.projectId = projectId;
  if (scopeId !== undefined) out.scopeId = scopeId;
  out.id = dailyPlanId(plan.date, projectId, scopeId);
  return out as unknown as DailyTeamPlan;
}

/** A copy of `obj` without `prop` (used to drop unverified member references). */
function stripProp<T extends object>(obj: T, prop: keyof T): T {
  const clone = { ...obj } as Record<string, unknown>;
  delete clone[prop as string];
  return clone as unknown as T;
}
