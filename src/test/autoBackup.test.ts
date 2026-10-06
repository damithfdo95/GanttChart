import { describe, expect, it } from 'vitest';
import {
  backupFileName,
  isBackupDue,
  isPrunableBackupFile,
  runDailyBackup,
  type AutoBackupDeps,
} from '../lib/backup/autoBackup';
import { DEFAULT_AUTO_BACKUP_SETTINGS, defaultReportsState, normalizeReportsState } from '../lib/storage/reports';
import { DEMO_STATE, normalizeAppState } from '../lib/storage/storage';
import type { AutoBackupSettings } from '../types';

/** Automatic daily backup — pure core (the browser layer wraps File System Access API calls). */

const TODAY = '2026-10-06';
const NOW_ISO = '2026-10-06T09:15:00.000Z';

function settings(overrides: Partial<AutoBackupSettings> = {}): AutoBackupSettings {
  return { ...DEFAULT_AUTO_BACKUP_SETTINGS, enabled: true, ...overrides };
}

/** Recording fake dependencies — every write/prune/record call is captured. */
function makeDeps(overrides: Partial<AutoBackupDeps> = {}): AutoBackupDeps & {
  writes: Array<{ fileName: string; text: string }>;
  downloads: Array<{ fileName: string; text: string }>;
  pruned: Array<{ today: string; retentionDays: number }>;
  recorded: string[];
} {
  const writes: Array<{ fileName: string; text: string }> = [];
  const downloads: Array<{ fileName: string; text: string }> = [];
  const pruned: Array<{ today: string; retentionDays: number }> = [];
  const recorded: string[] = [];
  return {
    writes,
    downloads,
    pruned,
    recorded,
    writeToFolder: async (fileName, text) => {
      writes.push({ fileName, text });
      return 'written';
    },
    download: (fileName, text) => {
      downloads.push({ fileName, text });
    },
    pruneOldBackups: async (today, retentionDays) => {
      pruned.push({ today, retentionDays });
    },
    recordLastBackup: (nowIso) => {
      recorded.push(nowIso);
    },
    ...overrides,
  };
}

const app = normalizeAppState({ ...DEMO_STATE });
const reports = defaultReportsState();

describe('backupFileName', () => {
  it('formats the dated backup filename', () => {
    expect(backupFileName('2026-10-06')).toBe('ganttchart-backup-2026-10-06.json');
  });
});

describe('isBackupDue', () => {
  it('is due when never backed up', () => {
    expect(isBackupDue(null, TODAY)).toBe(true);
  });

  it('is due on a new calendar day', () => {
    expect(isBackupDue('2026-10-05T23:59:00.000Z', TODAY)).toBe(true);
  });

  it('is not due again on the same calendar day (only the date part matters)', () => {
    expect(isBackupDue('2026-10-06T01:23:45.000Z', TODAY)).toBe(false);
  });
});

describe('isPrunableBackupFile', () => {
  it('matches only the app’s own dated backup pattern', () => {
    expect(isPrunableBackupFile('ganttchart-backup-2026-09-01.json', TODAY, 30)).toBe(true);
    expect(isPrunableBackupFile('notes.txt', TODAY, 30)).toBe(false);
    expect(isPrunableBackupFile('ganttchart-backup-not-a-date.json', TODAY, 30)).toBe(false);
    expect(isPrunableBackupFile('other-backup-2026-09-01.json', TODAY, 30)).toBe(false);
  });

  it('keeps files within the retention window and prunes older ones (strictly older)', () => {
    expect(isPrunableBackupFile('ganttchart-backup-2026-09-06.json', TODAY, 30)).toBe(false); // exactly 30 days
    expect(isPrunableBackupFile('ganttchart-backup-2026-09-05.json', TODAY, 30)).toBe(true); // 31 days
  });
});

describe('runDailyBackup', () => {
  it('skips when the feature is disabled', async () => {
    const deps = makeDeps();
    const result = await runDailyBackup({
      app,
      reports,
      settings: settings({ enabled: false }),
      lastBackupAt: null,
      today: TODAY,
      nowIso: NOW_ISO,
      folderMode: true,
      deps,
    });
    expect(result).toEqual({ status: 'skipped-disabled' });
    expect(deps.writes).toHaveLength(0);
    expect(deps.recorded).toHaveLength(0);
  });

  it('skips when already backed up today', async () => {
    const deps = makeDeps();
    const result = await runDailyBackup({
      app,
      reports,
      settings: settings(),
      lastBackupAt: '2026-10-06T01:00:00.000Z',
      today: TODAY,
      nowIso: NOW_ISO,
      folderMode: true,
      deps,
    });
    expect(result).toEqual({ status: 'not-due' });
    expect(deps.writes).toHaveLength(0);
  });

  it('writes to the folder, prunes with the configured retention, and records the run', async () => {
    const deps = makeDeps();
    const result = await runDailyBackup({
      app,
      reports,
      settings: settings({ retentionDays: 14, folderName: 'Backups' }),
      lastBackupAt: '2026-10-05T23:00:00.000Z',
      today: TODAY,
      nowIso: NOW_ISO,
      folderMode: true,
      deps,
    });
    expect(result).toEqual({ status: 'written-folder', fileName: 'ganttchart-backup-2026-10-06.json' });
    expect(deps.writes).toHaveLength(1);
    expect(deps.writes[0].fileName).toBe('ganttchart-backup-2026-10-06.json');
    // The written payload is a full standard backup of both storages.
    expect(JSON.parse(deps.writes[0].text).kind).toBe('backup');
    expect(deps.pruned).toEqual([{ today: TODAY, retentionDays: 14 }]);
    expect(deps.recorded).toEqual([NOW_ISO]);
  });

  it('falls back to a download when no usable folder exists', async () => {
    const deps = makeDeps();
    const result = await runDailyBackup({
      app,
      reports,
      settings: settings({ folderName: null }),
      lastBackupAt: null,
      today: TODAY,
      nowIso: NOW_ISO,
      folderMode: false,
      deps,
    });
    expect(result).toEqual({ status: 'written-download', fileName: 'ganttchart-backup-2026-10-06.json' });
    expect(deps.downloads).toHaveLength(1);
    expect(deps.writes).toHaveLength(0);
    expect(deps.recorded).toEqual([NOW_ISO]);
  });

  it('reports needs-permission WITHOUT recording the run (retried next start)', async () => {
    const deps = makeDeps({
      writeToFolder: async () => 'needs-permission',
    });
    const result = await runDailyBackup({
      app,
      reports,
      settings: settings(),
      lastBackupAt: null,
      today: TODAY,
      nowIso: NOW_ISO,
      folderMode: true,
      deps,
    });
    expect(result).toEqual({ status: 'needs-permission' });
    expect(deps.recorded).toHaveLength(0);
    expect(deps.pruned).toHaveLength(0);
  });

  it('reports failure WITHOUT recording the run', async () => {
    const deps = makeDeps({
      writeToFolder: async () => 'failed',
    });
    const result = await runDailyBackup({
      app,
      reports,
      settings: settings(),
      lastBackupAt: null,
      today: TODAY,
      nowIso: NOW_ISO,
      folderMode: true,
      deps,
    });
    expect(result).toEqual({ status: 'failed' });
    expect(deps.recorded).toHaveLength(0);
  });

  it('force (Back up now) bypasses the due check but never the disabled check', async () => {
    const deps = makeDeps();
    const result = await runDailyBackup({
      app,
      reports,
      settings: settings(),
      lastBackupAt: '2026-10-06T01:00:00.000Z',
      today: TODAY,
      nowIso: NOW_ISO,
      folderMode: false,
      force: true,
      deps,
    });
    expect(result.status).toBe('written-download');
    const skipped = await runDailyBackup({
      app,
      reports,
      settings: settings({ enabled: false }),
      lastBackupAt: null,
      today: TODAY,
      nowIso: NOW_ISO,
      folderMode: false,
      force: true,
      deps,
    });
    expect(skipped).toEqual({ status: 'skipped-disabled' });
  });

  it('a pruning failure never fails the backup itself', async () => {
    const deps = makeDeps({
      pruneOldBackups: async () => {
        throw new Error('prune error');
      },
    });
    const result = await runDailyBackup({
      app,
      reports,
      settings: settings(),
      lastBackupAt: null,
      today: TODAY,
      nowIso: NOW_ISO,
      folderMode: true,
      deps,
    });
    expect(result.status).toBe('written-folder');
    expect(deps.recorded).toEqual([NOW_ISO]);
  });
});

describe('autoBackup settings normalization', () => {
  it('old settings without autoBackup gain the disabled default', () => {
    const normalized = normalizeReportsState({
      ...reports,
      settings: { teams: [], holidays: [], supervisorName: '', projectJiraUrl: '', templates: { en: '', ja: '' }, progressRules: { working: 'totalCases', complete: 'totalCases' } },
    });
    expect(normalized.settings.autoBackup).toEqual(DEFAULT_AUTO_BACKUP_SETTINGS);
  });

  it('malformed values self-heal instead of rejecting the settings', () => {
    const normalized = normalizeReportsState({
      ...reports,
      settings: {
        ...reports.settings,
        autoBackup: { enabled: 'yes', folderName: 123, retentionDays: -7 } as unknown as AutoBackupSettings,
      },
    });
    // enabled/folderName fall back to their defaults; a numeric retention is clamped into 1..365.
    expect(normalized.settings.autoBackup).toEqual({ enabled: false, folderName: null, retentionDays: 1 });
  });

  it('valid values pass through and retention is clamped to 1..365', () => {
    const normalized = normalizeReportsState({
      ...reports,
      settings: { ...reports.settings, autoBackup: { enabled: true, folderName: 'My Backups', retentionDays: 9999 } },
    });
    expect(normalized.settings.autoBackup).toEqual({ enabled: true, folderName: 'My Backups', retentionDays: 365 });
  });
});
