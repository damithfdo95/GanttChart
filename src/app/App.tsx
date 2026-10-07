import { useEffect, useState } from 'react';
import { AppProviders, useAppStateCtx, useAutoBackupCtx, usePersistenceCtx, useReportsStateCtx } from './state-contexts';
import { toolNameOf } from '../domain/branding';
import type { SharedBoot } from './shared-sync';
import { TenantProvider, useTenant, type TenantApi } from './tenant-context';
import { useSession } from './session-context';
import { LogoutButton } from '../features/tenancy/LogoutButton';
import { useSharedSync } from './shared-sync';
import { SyncBanners, SyncStatusIndicator } from '../components/SyncStatus';
import { Dashboard } from '../features/dashboard/Dashboard';
import { Overall } from '../features/overall/Overall';
import { Gantt } from '../features/gantt/Gantt';
import { DailyReport } from '../features/daily-report/DailyReport';
import { ReportsExport } from '../features/reports/ReportsExport';
import { Settings } from '../features/settings/Settings';
import { TicketTab } from '../features/tickets/TicketTab';
import { PerformanceTab } from '../features/performance/PerformanceTab';
import { ReviewTab } from '../features/review/ReviewTab';
import { MIGRATION_FAILURE_LABEL_KEY } from '../lib/storage/db/recovery';
import { t, type TranslationKey } from '../i18n';
import type { OverallFocus } from '../domain/projects';
import type { PersistenceBoot } from '../lib/storage/db/bootstrap';
import { pad2 } from '../lib/formatting/format';

import { NAV_ITEMS, navItems, type Screen } from './navigation';
import { AccountBadge } from '../features/tenancy/AccountBadge';
import { TeamScreen } from '../features/tenancy/TeamScreen';
import { CyclesScreen } from '../features/cycles/CyclesScreen';
import { TestManagementScreen } from '../features/testManagement/TestManagementScreen';
import { MyTestingScreen } from '../features/testManagement/MyTestingScreen';
import { RevisionHistory } from '../features/settings/RevisionHistory';
import { SharedHistory } from '../features/settings/SharedHistory';

function formatSaveTime(timestamp: number): string {
  const d = new Date(timestamp);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Save-status indicator (V6.3 §3–§4): text + symbol (never color alone, §24)
 * and the last successful save time. role="status" makes changes announce
 * politely to assistive technology.
 */
function SaveStatusIndicator() {
  const app = useAppStateCtx();
  const persistence = usePersistenceCtx();
  const lang = app.state.language;
  const labelKey: TranslationKey =
    persistence.status === 'error' ? 'save.error' : persistence.status === 'saving' ? 'save.saving' : 'save.saved';
  const symbol = persistence.status === 'error' ? '⚠' : persistence.status === 'saving' ? '…' : '✓';
  const time = persistence.lastSavedAt === null ? null : formatSaveTime(persistence.lastSavedAt);
  return (
    <span
      className={`save-status save-${persistence.status}`}
      role="status"
      title={time === null ? undefined : t(lang, 'save.lastSaved', { time })}
    >
      <span aria-hidden="true">{symbol}</span> {t(lang, labelKey)}
      {time === null ? null : <span className="save-status-time"> · {time}</span>}
    </span>
  );
}

/** Startup corruption notice (V6.3 §22) — unreadable data was preserved under a recovery key. */
function CorruptionBanner() {
  const app = useAppStateCtx();
  const persistence = usePersistenceCtx();
  const lang = app.state.language;
  if (!persistence.corruptedAtStartup) return null;
  return (
    <div className="app-banner" role="alert">
      <div className="app-banner-body">
        <strong>{t(lang, 'persistence.corruptionTitle')}</strong>
        <span>{t(lang, 'persistence.corruptionBody')}</span>
      </div>
      <div className="app-banner-actions">
        <button type="button" className="btn btn-ghost" onClick={persistence.exportCorruptedData}>
          {t(lang, 'persistence.exportCorrupted')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={persistence.dismissCorruption}>
          {t(lang, 'persistence.dismiss')}
        </button>
      </div>
    </div>
  );
}

/**
 * Storage fallback / recovery notices (V6.6 §20/§22, V6.7 §6/§20):
 * - fallback-current: the browser database is unavailable, the app runs on
 *   the known-current local-storage copy
 * - recovery-required: the database is unavailable AND the local copy may
 *   not contain the latest changes — never silently treated as current
 * - recovered: a newer local copy was promoted back into the database
 * Plain user language only; technical detail lives in Settings diagnostics.
 */
function StorageFallbackBanner() {
  const app = useAppStateCtx();
  const persistence = usePersistenceCtx();
  const [dismissed, setDismissed] = useState(false);
  const lang = app.state.language;
  if (dismissed || (persistence.mode === 'indexeddb' && persistence.health !== 'recovered')) return null;
  if (persistence.health === 'recovery-stash') return null; // handled by the corruption banner
  let titleKey: TranslationKey;
  let bodyKey: TranslationKey;
  if (persistence.health === 'recovery-required') {
    titleKey = 'persistence.recoveryTitle';
    bodyKey = 'persistence.recoveryBody';
  } else if (persistence.health === 'recovered') {
    titleKey = 'persistence.recoveredTitle';
    bodyKey = 'persistence.recoveredBody';
  } else if (persistence.migrationStatus === 'failed') {
    titleKey = 'persistence.migrationFailedTitle';
    bodyKey = 'persistence.migrationFailedBody';
  } else {
    titleKey = 'persistence.fallbackTitle';
    bodyKey = 'persistence.fallbackBody';
  }
  return (
    <div className="app-banner" role="status">
      <div className="app-banner-body">
        <strong>{t(lang, titleKey)}</strong>
        <span>{t(lang, bodyKey)}</span>
        {/* The concrete failure reason — so recurring migration failures are diagnosable. */}
        {persistence.migrationStatus === 'failed' && persistence.migrationFailureReason !== undefined ? (
          <span>
            {t(lang, 'persistence.migrationReasonLabel')}: {t(lang, MIGRATION_FAILURE_LABEL_KEY[persistence.migrationFailureReason])}
          </span>
        ) : null}
      </div>
      <div className="app-banner-actions">
        <button type="button" className="btn btn-ghost" onClick={() => setDismissed(true)}>
          {t(lang, 'persistence.dismiss')}
        </button>
      </div>
    </div>
  );
}

/**
 * Automatic daily backup notice (needs folder re-authorization after a
 * browser restart, or a failed write). Dismissable; the re-authorize button
 * is a user gesture, which is exactly what the File System Access API
 * requires to re-grant folder permission.
 */
function AutoBackupBanner() {
  const app = useAppStateCtx();
  const autoBackup = useAutoBackupCtx();
  const [dismissed, setDismissed] = useState(false);
  const lang = app.state.language;
  if (dismissed || autoBackup.notice === null) return null;
  const isPermission = autoBackup.notice === 'needs-permission';
  return (
    <div className="app-banner" role="status">
      <div className="app-banner-body">
        <strong>{t(lang, isPermission ? 'autoBackup.needsPermissionTitle' : 'autoBackup.failedTitle')}</strong>
        <span>{t(lang, isPermission ? 'autoBackup.needsPermissionBody' : 'autoBackup.failedBody')}</span>
      </div>
      <div className="app-banner-actions">
        {isPermission ? (
          <button type="button" className="btn" onClick={() => void autoBackup.reauthorize()}>
            {t(lang, 'autoBackup.reauthorize')}
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost" onClick={() => setDismissed(true)}>
          {t(lang, 'persistence.dismiss')}
        </button>
      </div>
    </div>
  );
}

/**
 * App shell: Dashboard (high-level metrics for the active project) → Overall
 * (portfolio management) → Gantt (detailed scheduling) → Daily Report /
 * Reports & Export / Settings.
 */
/** Who is signed in, as what, in which workspace (nothing without a backend). */
function WorkspaceBadge() {
  const { principal } = useTenant();
  const { state } = useAppStateCtx();
  if (principal === null || principal.tenant === null || principal.role === 'super_admin') return null;
  return <AccountBadge lang={state.language} principal={principal} />;
}

/** The History screen: the shared workspace's revisions on the server, or this device's own revisions. */
function HistoryScreen() {
  const shared = useSharedSync();
  return shared.enabled ? <SharedHistory /> : <RevisionHistory />;
}

/** The sign-out control of the Admin and User shell (the Super Admin console has its own, same component). */
function ShellLogout() {
  const { principal } = useTenant();
  const { state } = useAppStateCtx();
  const sharedSync = useSharedSync();
  const persistence = usePersistenceCtx();
  const session = useSession();
  if (principal === null || principal.role === 'super_admin') return null;
  return (
    <LogoutButton
      lang={state.language}
      who={principal.email}
      deps={{
        unsentChanges: sharedSync.unsentChanges,
        saveLocal: persistence.saveNow,
        stopSync: sharedSync.stopForSignOut,
        endSession: () => session.endSession('logout'),
        navigate: (path) => window.location.assign(path),
      }}
    />
  );
}

function Shell() {
  const { state } = useAppStateCtx();
  const reports = useReportsStateCtx();
  const { principal } = useTenant();
  const [screen, setScreen] = useState<Screen>('dashboard');
  const [overallFocus, setOverallFocus] = useState<OverallFocus>({});
  const [ganttFocusProjectId, setGanttFocusProjectId] = useState<string | null>(null);

  // Document language/title follow the UI language on every screen (not
  // just the Dashboard) so screen readers and browser history stay correct.
  useEffect(() => {
    document.documentElement.lang = state.language;
    const screenKey = NAV_ITEMS.find((item) => item.id === screen)?.key ?? 'app.title';
    document.title = `${t(state.language, screenKey)} — ${toolNameOf(reports.state.settings, state.language)}`;
  }, [state.language, screen, reports.state.settings]);

  const openOverall = (focus: OverallFocus): void => {
    setOverallFocus(focus);
    setScreen('overall');
  };

  const openGantt = (projectId: string): void => {
    setOverallFocus({});
    setGanttFocusProjectId(projectId);
    setScreen('gantt');
  };

  return (
    <>
      <nav className="app-nav" aria-label={t(state.language, 'nav.mainNavigation')}>
        {navItems(principal?.role ?? null).map((item) => (
          <button
            key={item.id}
            type="button"
            className={screen === item.id ? 'active' : undefined}
            aria-current={screen === item.id ? 'page' : undefined}
            onClick={() => setScreen(item.id)}
          >
            {t(state.language, item.key)}
          </button>
        ))}
        <div className="account-area">
          <WorkspaceBadge />
          <SyncStatusIndicator />
          <SaveStatusIndicator />
          <ShellLogout />
        </div>
      </nav>
      <SyncBanners />
      <CorruptionBanner />
      <StorageFallbackBanner />
      <AutoBackupBanner />
      {screen === 'dashboard' ? (
        <Dashboard onOpenOverall={openOverall} />
      ) : screen === 'cycles' ? (
        <CyclesScreen />
      ) : screen === 'testManagement' ? (
        <TestManagementScreen />
      ) : screen === 'myTesting' ? (
        <MyTestingScreen />
      ) : screen === 'overall' ? (
        <Overall focus={overallFocus} onOpenGantt={openGantt} onProjectCreated={() => setScreen('dashboard')} />
      ) : screen === 'gantt' ? (
        <Gantt focusProjectId={ganttFocusProjectId} onFocusHandled={() => setGanttFocusProjectId(null)} />
      ) : screen === 'dailyReport' ? (
        <DailyReport />
      ) : screen === 'tickets' ? (
        <TicketTab />
      ) : screen === 'performance' ? (
        <PerformanceTab />
      ) : screen === 'review' ? (
        <ReviewTab />
      ) : screen === 'reports' ? (
        <ReportsExport />
      ) : screen === 'history' ? (
        <HistoryScreen />
      ) : screen === 'team' && (principal?.role === 'admin' || principal?.role === 'user') ? (
        <TeamScreen onOpenSettings={() => setScreen('settings')} />
      ) : (
        <Settings />
      )}
    </>
  );
}

const NO_TENANT: TenantApi = { principal: null, api: null };

export default function App({ boot, shared = null, tenant = NO_TENANT }: { boot: PersistenceBoot; shared?: SharedBoot | null; tenant?: TenantApi }) {
  return (
    <TenantProvider value={tenant}>
      <AppProviders boot={boot} shared={shared}>
        <Shell />
      </AppProviders>
    </TenantProvider>
  );
}
