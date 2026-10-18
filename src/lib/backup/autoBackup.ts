import type { AppState, AutoBackupSettings, ReportsState } from '../../types';
import { createBackupPayload } from './backup';
import { downloadTextFile } from '../export/download';
import { STORE_METADATA, getFromStore, putIntoStore } from '../storage/db/repository';

/**
 * Automatic daily backup (Settings → Automatic Daily Backup).
 *
 * The backup runs on the FIRST APP START of each new calendar day (plus an
 * hourly re-check for sessions left open across midnight — a web app cannot
 * run in the background while closed). Destination modes:
 *
 * - FOLDER MODE (Chrome/Edge, File System Access API): the user picks a
 *   folder once; the directory handle is stored in GanttChartDB and dated
 *   files `ganttchart-backup-YYYY-MM-DD.json` are written silently. After a
 *   browser restart the permission may need a one-click re-confirmation —
 *   surfaced through the 'needs-permission' result, never a silent failure.
 * - DOWNLOAD FALLBACK (Firefox/Safari, or no folder chosen): the same dated
 *   file is downloaded to the browser's Downloads folder.
 *
 * The last-run timestamp lives in localStorage (`ganttchart.autobackup.v1`)
 * — NOT in the workspace — so a daily backup never creates a revision or
 * journal noise. Retention pruning only ever touches files matching the
 * app's own backup filename pattern.
 */

const AUTO_BACKUP_RECORD_KEY = 'ganttchart.autobackup.v1';
const META_KEY_AUTO_BACKUP_DIR = 'autoBackupDirectory';
const BACKUP_FILE_PREFIX = 'ganttchart-backup-';
const BACKUP_FILE_SUFFIX = '.json';

// ---- pure core (node-testable) ------------------------------------------------

/** The dated backup filename for a day: ganttchart-backup-YYYY-MM-DD.json. */
export function backupFileName(today: string): string {
  return `${BACKUP_FILE_PREFIX}${today}${BACKUP_FILE_SUFFIX}`;
}

/** True when no backup has been recorded yet for the given calendar day. */
export function isBackupDue(lastBackupAt: string | null, today: string): boolean {
  if (lastBackupAt === null) return true;
  // The record stores a full ISO timestamp; only the calendar day matters.
  return lastBackupAt.slice(0, 10) !== today;
}

/** True when `name` is one of OUR dated backup files older than `retentionDays`. */
export function isPrunableBackupFile(name: string, today: string, retentionDays: number): boolean {
  if (!name.startsWith(BACKUP_FILE_PREFIX) || !name.endsWith(BACKUP_FILE_SUFFIX)) return false;
  const datePart = name.slice(BACKUP_FILE_PREFIX.length, name.length - BACKUP_FILE_SUFFIX.length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return false;
  const fileDay = Date.parse(`${datePart}T00:00:00Z`);
  const todayDay = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(fileDay) || Number.isNaN(todayDay)) return false;
  return (todayDay - fileDay) / 86_400_000 > retentionDays;
}

/** Dependencies of the backup run — injected so the orchestration is testable. */
export interface AutoBackupDeps {
  /** Write into the chosen folder; 'needs-permission' means a user gesture must re-authorize first. */
  writeToFolder: (fileName: string, text: string) => Promise<'written' | 'needs-permission' | 'failed'>;
  /** Fallback: trigger a browser download of the backup file. */
  download: (fileName: string, text: string) => void;
  /** Folder mode only: remove the app's own outdated backup files. */
  pruneOldBackups: (today: string, retentionDays: number) => Promise<void>;
  /** Persist the last-run timestamp after a successful write. */
  recordLastBackup: (nowIso: string) => void;
}

export type AutoBackupRunResult =
  | { status: 'not-due' }
  | { status: 'skipped-disabled' }
  | { status: 'written-folder' | 'written-download'; fileName: string }
  | { status: 'needs-permission' }
  | { status: 'failed' };

/**
 * Run the automatic backup once. The due-check is skipped when `force` is
 * set (the Settings "Back up now" button); a disabled configuration always
 * skips. `lastBackupAt` is only recorded after a successful write, so a
 * failed or unauthorized attempt is retried on the next app start.
 */
export async function runDailyBackup(input: {
  app: AppState;
  reports: ReportsState;
  settings: AutoBackupSettings;
  lastBackupAt: string | null;
  today: string;
  nowIso: string;
  /** A usable stored directory handle + browser support. */
  folderMode: boolean;
  force?: boolean;
  deps: AutoBackupDeps;
}): Promise<AutoBackupRunResult> {
  const { settings } = input;
  if (!settings.enabled) return { status: 'skipped-disabled' };
  if (input.force !== true && !isBackupDue(input.lastBackupAt, input.today)) return { status: 'not-due' };

  const fileName = backupFileName(input.today);
  const text = JSON.stringify(createBackupPayload(input.app, input.reports), null, 2);

  if (input.folderMode) {
    const write = await input.deps.writeToFolder(fileName, text);
    if (write === 'needs-permission') return { status: 'needs-permission' };
    if (write === 'failed') return { status: 'failed' };
    await input.deps.pruneOldBackups(input.today, settings.retentionDays).catch(() => undefined);
    input.deps.recordLastBackup(input.nowIso);
    return { status: 'written-folder', fileName };
  }
  input.deps.download(fileName, text);
  input.deps.recordLastBackup(input.nowIso);
  return { status: 'written-download', fileName };
}

// ---- last-run record (localStorage) -------------------------------------------

export interface AutoBackupRecord {
  lastBackupAt: string | null;
}

export function readAutoBackupRecord(): AutoBackupRecord {
  try {
    const raw = window.localStorage.getItem(AUTO_BACKUP_RECORD_KEY);
    if (raw === null) return { lastBackupAt: null };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.lastBackupAt !== 'string') return { lastBackupAt: null };
    return { lastBackupAt: parsed.lastBackupAt };
  } catch {
    return { lastBackupAt: null };
  }
}

function writeAutoBackupRecord(record: AutoBackupRecord): void {
  try {
    window.localStorage.setItem(AUTO_BACKUP_RECORD_KEY, JSON.stringify(record));
  } catch {
    // best effort — the backup itself already succeeded
  }
}

// ---- browser layer (File System Access API) -----------------------------------

/**
 * Minimal local declarations — lib.dom does not include the full File System
 * Access API surface (picker, permission methods, createWritable) on every
 * supported TypeScript version.
 */
interface BackupWritable {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}
interface BackupFileHandle {
  createWritable(): Promise<BackupWritable>;
}
export interface BackupDirectoryHandle {
  name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<BackupFileHandle>;
  removeEntry(name: string): Promise<void>;
  values(): AsyncIterableIterator<{ name: string; kind: 'file' | 'directory' }>;
  queryPermission?(descriptor: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'readwrite' }): Promise<PermissionState>;
}

/** True when the browser supports choosing a folder (Chrome/Edge). */
export function isFolderAccessSupported(): boolean {
  try {
    return typeof window !== 'undefined' && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
  } catch {
    return false;
  }
}

/**
 * Let the user choose the backup folder (read/write). The directory handle
 * is stored in GanttChartDB's metadata store; returns the folder's display
 * name, or null when the picker was cancelled or the handle could not be
 * stored (the caller then stays in download-fallback mode).
 */
export async function pickBackupDirectory(): Promise<string | null> {
  const picker = (window as unknown as { showDirectoryPicker?: (options?: { mode?: string }) => Promise<BackupDirectoryHandle> }).showDirectoryPicker;
  if (picker === undefined) return null;
  try {
    const handle = await picker({ mode: 'readwrite' });
    await putIntoStore(STORE_METADATA, handle, META_KEY_AUTO_BACKUP_DIR);
    return handle.name;
  } catch {
    return null; // cancelled by the user (AbortError) or the handle could not be stored
  }
}

/** The stored directory handle, or null when none exists / the database is unavailable. */
export async function readStoredBackupDirectory(): Promise<BackupDirectoryHandle | null> {
  try {
    const handle = await getFromStore<BackupDirectoryHandle>(STORE_METADATA, META_KEY_AUTO_BACKUP_DIR);
    return handle ?? null;
  } catch {
    return null;
  }
}

/** True when folder mode is usable: API support + a stored directory handle. */
export async function isFolderBackupMode(): Promise<boolean> {
  return isFolderAccessSupported() && (await readStoredBackupDirectory()) !== null;
}

async function hasPermission(directory: BackupDirectoryHandle): Promise<boolean> {
  const query = directory.queryPermission?.({ mode: 'readwrite' });
  if (query !== undefined && (await query) !== 'granted') return false;
  return true;
}

/**
 * Write the backup file into the stored folder. Returns
 * 'needs-permission' when the browser requires a user gesture to
 * re-authorize folder access (never silently fails).
 */
export async function writeBackupFileToFolder(fileName: string, text: string): Promise<'written' | 'needs-permission' | 'failed'> {
  const directory = await readStoredBackupDirectory();
  if (directory === null) return 'failed';
  try {
    if (!(await hasPermission(directory))) return 'needs-permission';
    const fileHandle = await directory.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(text);
    await writable.close();
    return 'written';
  } catch {
    return 'failed';
  }
}

/** Remove the app's own outdated backup files (folder mode). Never throws. */
export async function pruneOldBackupFiles(today: string, retentionDays: number): Promise<void> {
  const directory = await readStoredBackupDirectory();
  if (directory === null) return;
  try {
    for await (const entry of directory.values()) {
      if (entry.kind !== 'file') continue;
      if (isPrunableBackupFile(entry.name, today, retentionDays)) {
        await directory.removeEntry(entry.name).catch(() => undefined);
      }
    }
  } catch {
    // best effort — pruning must never break the backup itself
  }
}

/**
 * Re-authorize folder access from a user gesture (banner button): requests
 * the permission and retries the write for today's backup file.
 */
export async function reauthorizeAndWriteBackup(app: AppState, reports: ReportsState, today: string, nowIso: string): Promise<'written' | 'failed' | 'no-folder'> {
  const directory = await readStoredBackupDirectory();
  if (directory === null) return 'no-folder';
  try {
    const state = await directory.requestPermission?.({ mode: 'readwrite' });
    if (state !== 'granted') return 'failed';
    const result = await writeBackupFileToFolder(backupFileName(today), JSON.stringify(createBackupPayload(app, reports), null, 2));
    if (result !== 'written') return 'failed';
    writeAutoBackupRecord({ lastBackupAt: nowIso });
    return 'written';
  } catch {
    return 'failed';
  }
}

/** Browser wiring for runDailyBackup (folder mode when available). */
export async function runDailyBackupInBrowser(input: {
  app: AppState;
  reports: ReportsState;
  settings: AutoBackupSettings;
  today: string;
  nowIso: string;
  force?: boolean;
}): Promise<AutoBackupRunResult> {
  return runDailyBackup({
    ...input,
    lastBackupAt: readAutoBackupRecord().lastBackupAt,
    folderMode: await isFolderBackupMode(),
    deps: {
      writeToFolder: writeBackupFileToFolder,
      download: (fileName, text) => downloadTextFile(fileName, 'application/json', text),
      pruneOldBackups: pruneOldBackupFiles,
      recordLastBackup: (nowIso) => writeAutoBackupRecord({ lastBackupAt: nowIso }),
    },
  });
}
