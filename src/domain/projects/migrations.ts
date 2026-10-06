import type { AppState, ProjectRecord, QaInputs } from '../../types';
import { newProjectRecord } from './lifecycle';

/**
 * Project registry migrations and the single write-back path between the
 * legacy single-project app state and the portfolio registry.
 */

/** Backfill stable Project IDs on records persisted before Project IDs existed. */
export function ensureProjectIds(projects: ProjectRecord[]): ProjectRecord[] {
  const existing = projects.filter((p) => p.projectId !== undefined);
  let nextNumber = 0;
  const seen = new Set<string>();
  for (const project of existing) {
    seen.add(project.projectId);
    const m = /^PRJ-(\d+)$/.exec(project.projectId);
    if (m !== null) nextNumber = Math.max(nextNumber, Number(m[1]));
  }
  let changed = false;
  const result = projects.map((project) => {
    if (project.projectId !== undefined) return project;
    changed = true;
    let candidate = nextNumber + 1;
    while (seen.has(`PRJ-${String(candidate).padStart(3, '0')}`)) candidate += 1;
    nextNumber = candidate;
    const projectId = `PRJ-${String(candidate).padStart(3, '0')}`;
    seen.add(projectId);
    return { ...project, projectId };
  });
  return changed ? result : projects;
}

/**
 * Extract the QaInputs part of the app state (drops UI-only fields:
 * language, bilingual project names and the Level 2 dashboard view mode).
 * The app state is the editing surface of the ACTIVE project only.
 */
export function qaInputsFromAppState(state: AppState): QaInputs {
  const {
    language: _language,
    projectNameEn: _en,
    projectNameJa: _ja,
    dashboardView: _view,
    ...inputs
  } = state;
  return inputs;
}

/** Stable signature used to detect meaningful data changes (updatedAt). */
export function projectDataSignature(nameEn: string, nameJa: string, inputs: QaInputs): string {
  return JSON.stringify([nameEn, nameJa, inputs]);
}

/**
 * One-time migration of the old single-project data: create exactly one
 * ProjectRecord preserving names, team and all planning inputs, with the
 * documented safe default lifecycle status "ongoing".
 */
export function seedInitialProjectRecord(
  appState: AppState,
  team: string,
  nowIso: string,
): ProjectRecord {
  return newProjectRecord(
    qaInputsFromAppState(appState),
    {
      nameEn: appState.projectNameEn,
      nameJa: appState.projectNameJa,
      team,
      status: 'ongoing',
    },
    nowIso,
  );
}

/**
 * Write-back: sync the app state into the active project record. Only the
 * active project is touched — every other project is returned unchanged by
 * reference (data isolation). updatedAt is bumped only when meaningful data
 * actually changed; merely opening a project does not modify it.
 */
export function applyActiveProjectSync(
  projects: readonly ProjectRecord[],
  activeProjectId: string | null,
  nameEn: string,
  nameJa: string,
  inputs: QaInputs,
  nowIso: string,
): ProjectRecord[] {
  let changed = false;
  const result = projects.map((project) => {
    if (project.id !== activeProjectId) return project;
    const isUnchanged =
      projectDataSignature(nameEn, nameJa, inputs) ===
      projectDataSignature(project.nameEn, project.nameJa, project.inputs);
    if (isUnchanged) return project;
    changed = true;
    return { ...project, nameEn, nameJa, inputs, updatedAt: nowIso };
  });
  // Preserve the array identity when nothing changed so callers (and React
  // effects) can skip downstream updates entirely.
  return changed ? result : (projects as ProjectRecord[]);
}
