import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { AppProviders, useAppStateCtx, useAutoBackupCtx, usePersistenceCtx, useReportsStateCtx } from './state-contexts';
import { toolNameOf } from '../domain/branding';
import type { SharedBoot } from './shared-sync';
import { TenantProvider, useTenant, type TenantApi } from './tenant-context';
import { useSession } from './session-context';
import { LogoutButton } from '../features/tenancy/LogoutButton';
import { useSharedSync } from './shared-sync';
import { SyncBanners, SyncStatusIndicator } from '../components/SyncStatus';
import { Dashboard } from '../features/dashboard/Dashboard';
import { MIGRATION_FAILURE_LABEL_KEY } from '../lib/storage/db/recovery';
import { t, type TranslationKey } from '../i18n';
import type { OverallFocus } from '../domain/projects';
import type { PersistenceBoot } from '../lib/storage/db/bootstrap';
import { pad2 } from '../lib/formatting/format';

import { NAV_ITEMS, navItems, type Screen } from './navigation';
import { AccountBadge } from '../features/tenancy/AccountBadge';
import { BrandMark } from '../features/branding/BrandMark';
import { NotificationBanner } from '../features/notifications/NotificationBanner';

// Screens other than the landing Dashboard load on first visit, keeping the first download small.
const CommandCenter = lazy(() => import('../features/commandCenter/CommandCenter').then((m) => ({ default: m.CommandCenter })));
const Overall = lazy(() => import('../features/overall/Overall').then((m) => ({ default: m.Overall })));
const Gantt = lazy(() => import('../features/gantt/Gantt').then((m) => ({ default: m.Gantt })));
const DailyReport = lazy(() => import('../features/daily-report/DailyReport').then((m) => ({ default: m.DailyReport })));
const ReportsExport = lazy(() => import('../features/reports/ReportsExport').then((m) => ({ default: m.ReportsExport })));
const JiraScreen = lazy(() => import('../features/jira/JiraScreen').then((m) => ({ default: m.JiraScreen })));
const Settings = lazy(() => import('../features/settings/Settings').then((m) => ({ default: m.Settings })));
const TicketTab = lazy(() => import('../features/tickets/TicketTab').then((m) => ({ default: m.TicketTab })));
const PerformanceTab = lazy(() => import('../features/performance/PerformanceTab').then((m) => ({ default: m.PerformanceTab })));
const ReviewTab = lazy(() => import('../features/review/ReviewTab').then((m) => ({ default: m.ReviewTab })));
const TeamScreen = lazy(() => import('../features/tenancy/TeamScreen').then((m) => ({ default: m.TeamScreen })));
const CyclesScreen = lazy(() => import('../features/cycles/CyclesScreen').then((m) => ({ default: m.CyclesScreen })));
const TestManagementScreen = lazy(() => import('../features/testManagement/TestManagementScreen').then((m) => ({ default: m.TestManagementScreen })));
const MyTestingScreen = lazy(() => import('../features/testManagement/MyTestingScreen').then((m) => ({ default: m.MyTestingScreen })));
const RevisionHistory = lazy(() => import('../features/settings/RevisionHistory').then((m) => ({ default: m.RevisionHistory })));
const SharedHistory = lazy(() => import('../features/settings/SharedHistory').then((m) => ({ default: m.SharedHistory })));

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
  const [meetingIntent, setMeetingIntent] = useState<'morning' | 'evening' | null>(null);

  // The JIRA tab exists only while Settings → JIRA Integration is configured:
  // the entry is filtered out of the navigation below, and an active tab falls
  // back to the dashboard the moment the connection is removed.
  const jiraConfigured = reports.state.settings.jira !== undefined;
  // A screen the role has no access to (e.g. a Tester asking for the Command Center) is never rendered: the Dashboard stands in.
  const visibleNav = navItems(principal?.role ?? null);
  const allowed = visibleNav.some((item) => item.id === screen);
  const activeScreen: Screen = (screen === 'jira' && !jiraConfigured) || !allowed ? 'dashboard' : screen;

  // Document language/title follow the UI language on every screen (not
  // just the Dashboard) so screen readers and browser history stay correct.
  useEffect(() => {
    document.documentElement.lang = state.language;
    const screenKey = NAV_ITEMS.find((item) => item.id === activeScreen)?.key ?? 'app.title';
    document.title = `${t(state.language, screenKey)} — ${toolNameOf(reports.state.settings, state.language)}`;
  }, [state.language, activeScreen, reports.state.settings]);

  // Keep the active tab visible when the strip is scrolled (e.g. after opening History from a link).
  const activeTabRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeScreen]);

  const openOverall = (focus: OverallFocus): void => {
    setOverallFocus(focus);
    setScreen('overall');
  };

  const openMeeting = (session: 'morning' | 'evening'): void => {
    setOverallFocus({});
    setMeetingIntent(session);
    setScreen('gantt');
  };

  const openGantt = (projectId: string): void => {
    setOverallFocus({});
    setGanttFocusProjectId(projectId);
    setScreen('gantt');
  };

  return (
    <>
      <div className="app-shell">
        {/* Navigation: ONE strip holding every screen (History and Settings included). It scrolls sideways
            when the window is too narrow; it never wraps, so no tab drops onto a second row. */}
        <nav className="app-nav" aria-label={t(state.language, 'nav.mainNavigation')}>
          <BrandMark lang={state.language} />
          <div className="app-nav-tabs">
            {visibleNav
              .filter((item) => item.id !== 'jira' || jiraConfigured)
              .map((item) => (
                <button
                  key={item.id}
                  type="button"
                  ref={activeScreen === item.id ? activeTabRef : undefined}
                  className={activeScreen === item.id ? 'active' : undefined}
                  aria-current={activeScreen === item.id ? 'page' : undefined}
                  onClick={() => setScreen(item.id)}
                >
                  {t(state.language, item.key)}
                </button>
              ))}
          </div>
        </nav>
        {/* Identity, workspace and save/sync status: their own region, independent of the navigation width. */}
        <div className="account-area" role="group" aria-label={t(state.language, 'nav.accountArea')}>
          <WorkspaceBadge />
          <SyncStatusIndicator />
          <SaveStatusIndicator />
          <ShellLogout />
        </div>
      </div>
      <NotificationBanner />
      <SyncBanners />
      <CorruptionBanner />
      <StorageFallbackBanner />
      <AutoBackupBanner />
      <Suspense fallback={<p className="dr-summary" role="status">{t(state.language, 'app.loadingScreen')}</p>}>
      {activeScreen === 'dashboard' ? (
        <Dashboard onOpenOverall={openOverall} onOpenMeeting={openMeeting} />
      ) : activeScreen === 'commandCenter' ? (
        <CommandCenter onNavigate={setScreen} onOpenGantt={openGantt} />
      ) : activeScreen === 'cycles' ? (
        <CyclesScreen />
      ) : activeScreen === 'testManagement' ? (
        <TestManagementScreen />
      ) : activeScreen === 'myTesting' ? (
        <MyTestingScreen />
      ) : activeScreen === 'overall' ? (
        <Overall focus={overallFocus} onOpenGantt={openGantt} onProjectCreated={() => setScreen('dashboard')} />
      ) : activeScreen === 'gantt' ? (
        <Gantt focusProjectId={ganttFocusProjectId} onFocusHandled={() => setGanttFocusProjectId(null)} meeting={meetingIntent} onMeetingHandled={() => setMeetingIntent(null)} />
      ) : activeScreen === 'dailyReport' ? (
        <DailyReport />
      ) : activeScreen === 'tickets' ? (
        <TicketTab />
      ) : activeScreen === 'performance' ? (
        <PerformanceTab />
      ) : activeScreen === 'review' ? (
        <ReviewTab />
      ) : activeScreen === 'reports' ? (
        <ReportsExport />
      ) : activeScreen === 'jira' ? (
        <JiraScreen />
      ) : activeScreen === 'history' ? (
        <HistoryScreen />
      ) : activeScreen === 'team' && (principal?.role === 'admin' || principal?.role === 'user') ? (
        <TeamScreen onOpenSettings={() => setScreen('settings')} />
      ) : (
        <Settings />
      )}
      </Suspense>
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
