import type { AppState } from '../../types';
import type { BackupPayload } from './backup';
import { parseBackupPayload } from './backup';
import { parseProjectBackupPayload, type ProjectBackupData } from './projectBackup';
import { parseImportPayload } from '../jsonio/jsonio';

/**
 * Unified import dispatcher (V6.3 §10). One entry point accepts every
 * GanttChart JSON file kind:
 *   - full workspace backups  ({ kind: 'backup' })
 *   - single-project backups  ({ kind: 'project' })
 *   - legacy app-state exports ({ version: 1 | 2, data: AppState })
 *
 * Detection: parse → validate → migrate → normalize — exactly the pipeline
 * used by each format's own parser, so there is no second serialization or
 * validation path. Invalid files return { kind: 'invalid' } and the caller's
 * current state stays untouched.
 */
export type ImportFileResult =
  | { kind: 'backup'; data: BackupPayload['data'] }
  | { kind: 'project'; data: ProjectBackupData }
  | { kind: 'appstate'; data: AppState }
  | { kind: 'invalid' };

export function detectImportFile(text: string): ImportFileResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'invalid' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'invalid' };
  const p = parsed as Record<string, unknown>;

  if (p.kind === 'backup') {
    const backup = parseBackupPayload(text);
    return backup.ok ? { kind: 'backup', data: backup.data } : { kind: 'invalid' };
  }
  if (p.kind === 'project') {
    const project = parseProjectBackupPayload(text);
    return project.ok ? { kind: 'project', data: project.data } : { kind: 'invalid' };
  }
  // Legacy app-state export envelope (V6.2 Dashboard export): { app, version, data }.
  const appState = parseImportPayload(text);
  return appState.ok ? { kind: 'appstate', data: appState.data } : { kind: 'invalid' };
}
