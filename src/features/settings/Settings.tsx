import { useEffect, useState } from 'react';
import { useAppStateCtx, useAutoBackupCtx, useReportsStateCtx } from '../../app/state-contexts';
import { t, LANGUAGES } from '../../i18n';
import { DEFAULT_REPORT_TEMPLATES } from '../../lib/reporting/template';
import { DEMO_STATE } from '../../lib/storage/storage';
import { DEFAULT_AUTO_BACKUP_SETTINGS, defaultReportsState } from '../../lib/storage/reports';
import { isFolderAccessSupported, pickBackupDirectory, readAutoBackupRecord } from '../../lib/backup/autoBackup';
import { clearAllLocalDataAsync, getStorageDiagnostics, type StorageDiagnostics } from '../../lib/storage/db/persistenceBackend';
import { MIGRATION_FAILURE_LABEL_KEY, readMigrationFailureRecord } from '../../lib/storage/db/recovery';
import { RevisionHistory } from './RevisionHistory';
import { SharedHistory } from './SharedHistory';
import { useSharedSync } from '../../app/shared-sync';
import { unlinkDevice } from '../../lib/sync/device';
import { createBackupPayload } from '../../lib/backup/backup';
import { downloadTextFile } from '../../lib/export/download';
import { pad2 } from '../../lib/formatting/format';
import type { Language, ProgressDenominator } from '../../types';

/** Settings: holidays, supervisor, project JIRA URL, progress rules, report templates. */
export function Settings() {
  const app = useAppStateCtx();
  const reportsApi = useReportsStateCtx();
  const autoBackupApi = useAutoBackupCtx();
  const shared = useSharedSync();
  const lang = app.state.language;
  const settings = reportsApi.state.settings;
  const migrationFailure = readMigrationFailureRecord();
  const [clearOutcome, setClearOutcome] = useState<'done' | 'aborted' | null>(null);
  const [settingsMessage, setSettingsMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [diagnostics, setDiagnostics] = useState<StorageDiagnostics | null>(null);

  // Developer-oriented storage metadata (§31) — mode/version/migration only.
  useEffect(() => {
    void getStorageDiagnostics().then(setDiagnostics);
  }, []);

  // ---- automatic daily backup (first app start of a new day) ----------------
  const autoBackup = settings.autoBackup ?? DEFAULT_AUTO_BACKUP_SETTINGS;
  const folderSupported = isFolderAccessSupported();
  const [backupRecord, setBackupRecord] = useState(() => readAutoBackupRecord());
  const [backupMessage, setBackupMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const handleChooseFolder = async (): Promise<void> => {
    const name = await pickBackupDirectory();
    if (name === null) return; // cancelled (or unsupported / not storable)
    reportsApi.updateSettings({ autoBackup: { ...autoBackup, folderName: name } });
    setBackupMessage(null);
  };

  const handleRunBackupNow = async (): Promise<void> => {
    const result = await autoBackupApi.runNow();
    if (result.status === 'written-folder' || result.status === 'written-download') {
      setBackupRecord(readAutoBackupRecord());
      setBackupMessage({ kind: 'ok', text: t(lang, 'settings.autoBackupRunNowOk', { file: result.fileName }) });
    } else if (result.status === 'needs-permission' || result.status === 'failed') {
      setBackupMessage({ kind: 'error', text: t(lang, 'settings.autoBackupRunNowErr') });
    }
  };

  const lastBackupText =
    backupRecord.lastBackupAt === null
      ? t(lang, 'settings.autoBackupLastBackupNever')
      : backupRecord.lastBackupAt.slice(0, 16).replace('T', ' ');

  // Text fields that parse lists keep a local draft while typing and commit
  // on blur, with feedback when lines/entries had to be dropped.
  const [holidaysDraft, setHolidaysDraft] = useState<string | null>(null);
  const [templateDrafts, setTemplateDrafts] = useState<Partial<Record<Language, string>>>({});

  const downloadFullBackup = (): void => {
    const payload = createBackupPayload(app.state, reportsApi.state);
    const now = new Date();
    const stamp = `${now.toISOString().slice(0, 10)}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    downloadTextFile(`ganttchart-backup-${stamp}.json`, 'application/json', JSON.stringify(payload, null, 2));
  };

  /**
   * Clear All Local Data (V6.3 §13, V6.6 §30) — destructive and explicitly
   * separated from single-project deletion. A backup of the current data is
   * always downloaded first so the operation is recoverable. The IndexedDB
   * database (including migration metadata), every persisted localStorage
   * key and all recovery stashes are removed, and the canonical state
   * returns to the normal initial state (language kept).
   */
  const handleClearAll = (): void => {
    // In shared mode this clears only THIS browser and disconnects it; the
    // shared workspace (and everyone else's data) is never touched.
    if (!window.confirm(t(lang, shared.enabled ? 'shared.settings.clearDeviceConfirm' : 'settings.confirmClearAll'))) return;
    downloadFullBackup();
    void clearAllLocalDataAsync().then((result) => {
      if (result === 'aborted') {
        // The pre-clear recovery snapshot could not be written: nothing was
        // deleted, so the in-memory workspace must stay as it is.
        setClearOutcome('aborted');
        return;
      }
      if (shared.enabled) {
        // Forget the link and reload: the device starts over and is offered the
        // link screen again. Nothing is pushed to the shared workspace.
        unlinkDevice();
        window.location.reload();
        return;
      }
      const fresh: typeof DEMO_STATE = {
        ...DEMO_STATE,
        language: app.state.language,
        dashboardView: app.state.dashboardView,
      };
      app.replaceState(fresh);
      reportsApi.replaceReportsState(defaultReportsState());
      reportsApi.seedInitialProject(fresh);
      setClearOutcome('done');
      void getStorageDiagnostics().then(setDiagnostics);
    });
  };

  const holidayText = settings.holidays.join('\n');

  const commitHolidays = (value: string): void => {
    const lines = value.split(/\r?\n/).map((line) => line.trim());
    const holidays = lines.filter((line) => line !== '' && /^\d{4}-\d{2}-\d{2}$/.test(line));
    const dropped = lines.filter((line) => line !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(line)).length;
    reportsApi.updateSettings({ holidays });
    setSettingsMessage(
      dropped > 0
        ? { kind: 'error', text: t(lang, 'settings.holidaysLinesDropped', { count: dropped }) }
        : null,
    );
  };

  const commitTemplate = (language: Language, value: string): void => {
    reportsApi.updateSettings({ templates: { ...settings.templates, [language]: value } });
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title-group">
          <h1>{t(lang, 'settings.title')}</h1>
        </div>
      </header>

      <section className="dr-section">
        <label className="settings-field">
          {t(lang, 'settings.supervisorName')}
          <input
            className="input"
            type="text"
            value={settings.supervisorName}
            onChange={(e) => reportsApi.updateSettings({ supervisorName: e.target.value })}
          />
        </label>
        <label className="settings-field">
          {t(lang, 'settings.projectJiraUrl')}
          <input
            className="input"
            type="text"
            placeholder="https://jira.example.com/browse/PROJ"
            value={settings.projectJiraUrl}
            onChange={(e) => reportsApi.updateSettings({ projectJiraUrl: e.target.value })}
          />
        </label>
        <label className="settings-field settings-field-wide">
          {t(lang, 'settings.holidays')}
          <textarea
            className="dr-textarea"
            rows={4}
            value={holidaysDraft ?? holidayText}
            onChange={(e) => setHolidaysDraft(e.target.value)}
            onBlur={(e) => {
              commitHolidays(e.target.value);
              setHolidaysDraft(null);
            }}
          />
        </label>
        {settingsMessage !== null ? (
          <p className={`data-controls-message ${settingsMessage.kind}`} role="status">
            {settingsMessage.text}
          </p>
        ) : null}
      </section>

      <section className="dr-section">
        <h2>{t(lang, 'settings.progressRules')}</h2>
        <label className="settings-field">
          {t(lang, 'settings.workingDenominator')}
          <select
            className="input"
            value={settings.progressRules.working}
            onChange={(e) =>
              reportsApi.updateSettings({
                progressRules: { ...settings.progressRules, working: e.target.value as ProgressDenominator },
              })
            }
          >
            <option value="workingEligibleCases">{t(lang, 'rules.workingEligibleCases')}</option>
            <option value="totalCases">{t(lang, 'rules.totalCases')}</option>
          </select>
        </label>
        <label className="settings-field">
          {t(lang, 'settings.completeDenominator')}
          <select
            className="input"
            value={settings.progressRules.complete}
            onChange={(e) =>
              reportsApi.updateSettings({
                progressRules: { ...settings.progressRules, complete: e.target.value as ProgressDenominator },
              })
            }
          >
            <option value="totalCases">{t(lang, 'rules.totalCases')}</option>
            <option value="workingEligibleCases">{t(lang, 'rules.workingEligibleCases')}</option>
          </select>
        </label>
      </section>

      <section className="dr-section">
        <h2>{t(lang, 'settings.templates')}</h2>
        {(['en', 'ja'] as const).map((language) => (
          <div key={language} className="settings-template">
            <div className="settings-template-head">
              <h3>{LANGUAGES.find((option) => option.code === language)?.native ?? language}</h3>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setTemplateDrafts((prev) => ({ ...prev, [language]: DEFAULT_REPORT_TEMPLATES[language] }));
                  commitTemplate(language, DEFAULT_REPORT_TEMPLATES[language]);
                }}
              >
                {t(lang, 'settings.resetTemplate')}
              </button>
            </div>
            <textarea
              className="dr-textarea settings-template-editor"
              rows={16}
              value={templateDrafts[language] ?? settings.templates[language]}
              onChange={(e) => setTemplateDrafts((prev) => ({ ...prev, [language]: e.target.value }))}
              onBlur={(e) => commitTemplate(language, e.target.value)}
            />
            <p className="dr-summary">
              {'{active_test_names} {attendance} {activities} {topics} {progress} {jira_url} {next_business_day}'}
            </p>
          </div>
        ))}
      </section>

      <section className="dr-section">
        <h2>{t(lang, 'settings.autoBackupTitle')}</h2>
        <p className="dr-summary">{t(lang, 'settings.autoBackupHint')}</p>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={autoBackup.enabled}
            onChange={(e) => reportsApi.updateSettings({ autoBackup: { ...autoBackup, enabled: e.target.checked } })}
          />
          {t(lang, 'settings.autoBackupEnable')}
        </label>
        {autoBackup.enabled ? (
          <>
            {folderSupported ? (
              <div className="settings-field">
                <span className="settings-field-label">{t(lang, 'settings.autoBackupFolder')}</span>
                <div className="dr-button-row">
                  <button type="button" className="btn btn-ghost" onClick={() => void handleChooseFolder()}>
                    {t(lang, autoBackup.folderName === null ? 'settings.autoBackupChooseFolder' : 'settings.autoBackupChangeFolder')}
                  </button>
                  <span className="dr-summary">
                    {autoBackup.folderName === null ? t(lang, 'settings.autoBackupNoFolder') : autoBackup.folderName}
                  </span>
                </div>
              </div>
            ) : (
              <p className="dr-summary">{t(lang, 'settings.autoBackupDownloadsNote')}</p>
            )}
            <label className="settings-field">
              {t(lang, 'settings.autoBackupRetention')}
              <input
                className="input"
                type="number"
                min={1}
                max={365}
                step={1}
                value={autoBackup.retentionDays}
                onChange={(e) => {
                  const days = Math.min(365, Math.max(1, Math.floor(Number(e.target.value) || 0)));
                  reportsApi.updateSettings({ autoBackup: { ...autoBackup, retentionDays: days } });
                }}
              />
            </label>
            <p className="dr-summary">{t(lang, 'settings.autoBackupRetentionHint')}</p>
            <div className="dr-button-row">
              <button type="button" className="btn" onClick={() => void handleRunBackupNow()}>
                {t(lang, 'settings.autoBackupRunNow')}
              </button>
              <span className="dr-summary">
                {t(lang, 'settings.autoBackupLastBackup')}: {lastBackupText}
              </span>
              {backupMessage !== null ? (
                <span className={`data-controls-message ${backupMessage.kind}`} role="status">
                  {backupMessage.text}
                </span>
              ) : null}
            </div>
          </>
        ) : null}
      </section>

      {shared.enabled ? <SharedHistory /> : <RevisionHistory />}

      <section className="dr-section danger-zone">
        <h2>{t(lang, 'settings.dangerZone')}</h2>
        <p className="dr-summary">{t(lang, 'settings.dangerZoneHint')}</p>
        {/* Last localStorage → IndexedDB migration failure (cleared on success). */}
        {migrationFailure !== null ? (
          <p className="dr-summary" role="status">
            {t(lang, 'persistence.migrationReasonLabel')}: {t(lang, MIGRATION_FAILURE_LABEL_KEY[migrationFailure.reason])} ·{' '}
            {migrationFailure.at}
          </p>
        ) : null}
        {diagnostics !== null ? (
          <p className="dr-summary" role="status">
            {t(lang, 'settings.storageStatus')}:{' '}
            {diagnostics.mode === 'indexeddb'
              ? t(lang, 'settings.storageIndexedDb', { version: diagnostics.databaseVersion ?? '?' })
              : t(lang, 'settings.storageLocal')}
            {diagnostics.mode === 'indexeddb' && diagnostics.migrationStatus !== null
              ? ` · ${t(lang, 'settings.storageMigration', {
                  status:
                    diagnostics.migrationStatus === 'completed'
                      ? t(lang, 'settings.storageMigrationCompleted')
                      : diagnostics.migrationStatus === 'skipped-empty'
                        ? t(lang, 'settings.storageMigrationSkipped')
                        : t(lang, 'settings.storageMigrationFailed'),
                })}`
              : ''}
            {` · ${t(lang, 'settings.storageRevision', { revision: diagnostics.revision })}`}
            {diagnostics.integrityStatus !== null
              ? ` · ${t(lang, 'settings.storageIntegrity', {
                  status:
                    diagnostics.integrityStatus === 'verified'
                      ? t(lang, 'settings.storageIntegrityVerified')
                      : diagnostics.integrityStatus === 'warning'
                        ? t(lang, 'settings.storageIntegrityWarning')
                        : t(lang, 'settings.storageIntegrityFailed'),
                })}`
              : ''}
            {diagnostics.fallbackRevision !== null
              ? ` · ${t(lang, 'settings.storageFallbackRevision', { revision: diagnostics.fallbackRevision })}`
              : ''}
            {` · ${t(lang, 'settings.storageSnapshots', { count: diagnostics.recoverySnapshots })}`}
            {diagnostics.lastSavedAt !== null
              ? ` · ${t(lang, 'settings.storageLastSaved', {
                  time: `${pad2(new Date(diagnostics.lastSavedAt).getHours())}:${pad2(new Date(diagnostics.lastSavedAt).getMinutes())}`,
                })}`
              : ''}
          </p>
        ) : null}
        {diagnostics !== null && diagnostics.health === 'recovery-required' ? (
          <p className="dr-summary" role="alert">
            {t(lang, 'persistence.recoveryBody')}
          </p>
        ) : null}
        {shared.enabled ? <p className="dr-summary">{t(lang, 'shared.settings.clearDeviceHelp')}</p> : null}
        <div className="danger-zone-actions">
          <button type="button" className="btn" onClick={downloadFullBackup}>
            {t(lang, 'settings.downloadBackupFirst')}
          </button>
          <button type="button" className="btn btn-danger" onClick={handleClearAll}>
            {t(lang, shared.enabled ? 'shared.settings.clearDevice' : 'settings.clearAllData')}
          </button>
          {clearOutcome === 'done' ? (
            <span className="data-controls-message ok" role="status">
              {t(lang, 'settings.clearAllDone')}
            </span>
          ) : null}
          {clearOutcome === 'aborted' ? (
            <span className="data-controls-message error" role="alert">
              {t(lang, 'settings.clearAllAborted')}
            </span>
          ) : null}
        </div>
      </section>
    </div>
  );
}
