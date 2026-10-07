import { useState } from 'react';
import { useAppStateCtx } from '../../app/state-contexts';
import { useSharedGuard } from '../../app/useSharedGuard';
import { DataControls, type ImportMessage } from '../../components/DataControls';
import { resolveBilingualName } from '../../i18n';
import { downloadStateAsJson, parseImportPayload } from '../../lib/jsonio/jsonio';
import { t } from '../../i18n';

/**
 * Settings → Data & Backup (SV only; Settings itself is not offered to a Tester). Export, import and reset of the project on
 * screen. They used to sit in the Dashboard header; the Dashboard is operational information only. Every confirmation and
 * every shared-workspace guard is exactly the one the Dashboard had.
 */
export function DataBackup() {
  const app = useAppStateCtx();
  const { state, replaceState, resetToDemo } = app;
  const guard = useSharedGuard();
  const lang = state.language;
  const [message, setMessage] = useState<ImportMessage | null>(null);

  const handleExport = (): void => {
    downloadStateAsJson(state);
  };

  const handleImportFile = (file: File): void => {
    if (!guard.guardWrite()) return; // read-only people cannot replace the shared project's data
    const reader = new FileReader();
    reader.onload = () => {
      const result = parseImportPayload(String(reader.result ?? ''));
      if (result.ok) {
        replaceState(result.data);
        setMessage({ kind: 'ok', text: t(lang, 'messages.importOk') });
      } else {
        setMessage({ kind: 'error', text: t(lang, result.errorKey) });
      }
    };
    reader.onerror = () => setMessage({ kind: 'error', text: t(lang, 'messages.importErrRead') });
    reader.readAsText(file);
  };

  /** Reset the active project's inputs to demo data. Destructive for the active project, so it names the project and asks first. */
  const handleReset = (): void => {
    const name = resolveBilingualName(lang, { nameEn: state.projectNameEn, nameJa: state.projectNameJa }) || t(lang, 'app.title');
    if (!window.confirm(t(lang, 'dashboard.confirmReset', { name }))) return;
    // In shared mode the project is everyone's: say so, and never for read-only people.
    if (!guard.confirmEveryone('shared.confirm.resetProject')) return;
    resetToDemo();
    setMessage(null);
  };

  return (
    <section className="dr-section" aria-labelledby="data-backup-title">
      <h2 id="data-backup-title">{t(lang, 'settings.dataBackup.title')}</h2>
      <p className="dr-summary">{t(lang, 'settings.dataBackup.help')}</p>
      <DataControls
        labels={{ export: t(lang, 'buttons.export'), import: t(lang, 'buttons.import'), reset: t(lang, 'buttons.reset') }}
        message={message}
        onExport={handleExport}
        onImportFile={handleImportFile}
        onReset={handleReset}
      />
    </section>
  );
}
