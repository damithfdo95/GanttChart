import { readStash } from '../lib/sync/device';
import { downloadTextFile } from '../lib/export/download';
import { useSharedSync } from '../app/shared-sync';
import { useAppStateCtx } from '../app/state-contexts';
import { t, type TranslationKey } from '../i18n';
import type { SyncStatus as Status } from '../lib/sync/client';

const STATUS: Record<Status, { key: TranslationKey; symbol: string; tone: string }> = {
  connecting: { key: 'shared.status.connecting', symbol: '…', tone: 'saving' },
  synced: { key: 'shared.status.synced', symbol: '✓', tone: 'saved' },
  syncing: { key: 'shared.status.syncing', symbol: '…', tone: 'saving' },
  offline: { key: 'shared.status.offline', symbol: '⚠', tone: 'saving' },
  readonly: { key: 'shared.status.readonly', symbol: '👁', tone: 'saved' },
  'session-expired': { key: 'shared.status.expired', symbol: '⚠', tone: 'error' },
  error: { key: 'shared.status.error', symbol: '⚠', tone: 'error' },
  stopped: { key: 'shared.status.stopped', symbol: '–', tone: 'saving' },
};

/** Header chip: text + symbol (never colour alone), announced politely to assistive technology. */
export function SyncStatusIndicator() {
  const shared = useSharedSync();
  const { state } = useAppStateCtx();
  const lang = state.language;
  if (!shared.enabled || shared.sync === null) return null;
  const { status, pending } = shared.sync;
  const entry = STATUS[status];
  const label =
    status === 'syncing' && pending > 0
      ? t(lang, 'shared.status.syncingPending', { count: pending })
      : status === 'offline' && pending > 0
        ? t(lang, 'shared.status.offlinePending', { count: pending })
        : t(lang, entry.key);
  const who = shared.sync.you ?? shared.identity;
  return (
    <span className={`save-status save-${entry.tone}`} role="status" title={who === null ? undefined : t(lang, 'shared.signedInAs', { email: who.email })}>
      <span aria-hidden="true">{entry.symbol}</span> {label}
    </span>
  );
}

/** Notices that need a person's attention: conflicts, read-only, ended sign-in, sync errors. */
export function SyncBanners() {
  const shared = useSharedSync();
  const { state } = useAppStateCtx();
  const lang = state.language;
  if (!shared.enabled) return null;
  const status = shared.sync?.status;

  const downloadStash = (): void => {
    downloadTextFile('ganttchart-my-versions.json', 'application/json', JSON.stringify({ app: 'ganttchart', kind: 'conflict-stash', exportedAt: new Date().toISOString(), edits: readStash() }, null, 2));
  };

  return (
    <>
      {status === 'session-expired' ? (
        <div className="app-banner" role="alert">
          <div className="app-banner-body">
            <strong>{t(lang, 'shared.banner.expiredTitle')}</strong>
            <span>{t(lang, 'shared.banner.expiredBody')}</span>
          </div>
          <div className="app-banner-actions">
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
              {t(lang, 'shared.banner.reload')}
            </button>
          </div>
        </div>
      ) : null}
      {status === 'readonly' ? (
        <div className="app-banner" role="status">
          <div className="app-banner-body">
            <strong>{t(lang, 'shared.banner.readonlyTitle')}</strong>
            <span>{t(lang, 'shared.banner.readonlyBody')}</span>
          </div>
        </div>
      ) : null}
      {status === 'error' ? (
        <div className="app-banner" role="alert">
          <div className="app-banner-body">
            <strong>{t(lang, 'shared.banner.errorTitle')}</strong>
          </div>
          <div className="app-banner-actions">
            <button type="button" className="btn" onClick={shared.retryNow}>
              {t(lang, 'shared.banner.retry')}
            </button>
          </div>
        </div>
      ) : null}
      {shared.notices.map((notice, index) =>
        notice.kind === 'conflict' ? (
          <div className="app-banner" role="alert" key={`c${index}`}>
            <div className="app-banner-body">
              <strong>{t(lang, 'shared.banner.conflictTitle')}</strong>
              <span>{t(lang, 'shared.banner.conflictBody', { count: notice.keys.length })}</span>
            </div>
            <div className="app-banner-actions">
              <button type="button" className="btn" onClick={downloadStash}>
                {t(lang, 'shared.banner.downloadMine')}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => shared.dismissNotice(index)}>
                {t(lang, 'persistence.dismiss')}
              </button>
            </div>
          </div>
        ) : null,
      )}
    </>
  );
}

