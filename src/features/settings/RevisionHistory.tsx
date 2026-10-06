import { useCallback, useEffect, useState } from 'react';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { t, type TranslationKey } from '../../i18n';
import { SectionCard } from '../../components/SectionCard';
import { MetricCard } from '../../components/MetricCard';
import {
  createRestoreRevision,
  exportRevisionHistoryForBackup,
  getStorageDiagnostics,
  type StorageDiagnostics,
} from '../../lib/storage/db/persistenceBackend';
import { getRevisionHistory, reconstructRevision } from '../../lib/storage/db/revisionHistory';
import { diffWorkspaces } from '../../lib/storage/db/diff';
import type { RevisionChangeSummary, RevisionReason, WorkspaceRevisionMeta } from '../../lib/storage/db/journal';
import { REVISION_HISTORY_RETENTION } from '../../lib/storage/db/revisionHistory';
import { createHistoryBackupPayload } from '../../lib/backup/backup';
import { downloadTextFile } from '../../lib/export/download';
import { TablePager } from '../../components/TablePager';
import { usePagedRows } from '../../lib/pagination/usePagedRows';

const REASON_KEY: Record<RevisionReason, TranslationKey> = {
  initial: 'history.reason.initial',
  edit: 'history.reason.edit',
  'project-created': 'history.reason.project-created',
  'project-deleted': 'history.reason.project-deleted',
  'report-created': 'history.reason.report-created',
  'report-updated': 'history.reason.report-updated',
  'report-deleted': 'history.reason.report-deleted',
  'attendance-updated': 'history.reason.attendance-updated',
  'topic-updated': 'history.reason.topic-updated',
  'identity-updated': 'history.reason.identity-updated',
  import: 'history.reason.import',
  recovery: 'history.reason.recovery',
  migration: 'history.reason.migration',
  'clear-all': 'history.reason.clear-all',
  system: 'history.reason.system',
};

function countLabel(lang: 'en' | 'ja', created: number, updated: number, deleted: number): string | null {
  const parts: string[] = [];
  if (created > 0) parts.push(t(lang, 'history.createdCount', { n: created }));
  if (updated > 0) parts.push(t(lang, 'history.updatedCount', { n: updated }));
  if (deleted > 0) parts.push(t(lang, 'history.deletedCount', { n: deleted }));
  return parts.length > 0 ? parts.join(' / ') : null;
}

/** Compact localized change-summary lines for one revision (V6.8 §26). */
function summaryLines(lang: 'en' | 'ja', summary: RevisionChangeSummary | null): string[] {
  if (summary === null) return [];
  const lines: string[] = [];
  const projects = countLabel(lang, summary.projectsCreated.length, summary.projectsUpdated.length, summary.projectsDeleted.length);
  if (projects !== null) lines.push(`${t(lang, 'history.changeProjects')}: ${projects}`);
  const reports = countLabel(lang, summary.reportsCreated.length, summary.reportsUpdated.length, summary.reportsDeleted.length);
  if (reports !== null) lines.push(`${t(lang, 'history.changeReports')}: ${reports}`);
  if (summary.snapshotsChanged) lines.push(t(lang, 'history.snapshotsChanged'));
  if (summary.attendanceChanged) lines.push(t(lang, 'history.attendanceChanged'));
  if (summary.topicsChanged) lines.push(t(lang, 'history.topicsChanged'));
  if (summary.identityChanged) lines.push(t(lang, 'history.identityChanged'));
  if (summary.testerAssignmentsChanged) lines.push(t(lang, 'history.assignmentsChanged'));
  if (summary.reviewsChanged) lines.push(t(lang, 'history.reviewsChanged'));
  if (summary.executionChanged) lines.push(t(lang, 'history.executionChanged'));
  if (summary.planningChanged) lines.push(t(lang, 'history.planningChanged'));
  if (summary.settingsChanged) lines.push(t(lang, 'history.settingsChanged'));
  return lines;
}

/**
 * Revision History (V6.8 §26–§29): recent committed revisions with reason,
 * affected projects and a concise change summary; read-only preview derived
 * from the historical state; restore is an explicit, confirmed action that
 * creates a NEW revision and never deletes newer history.
 */
export function RevisionHistory() {
  const app = useAppStateCtx();
  const reportsApi = useReportsStateCtx();
  const lang = app.state.language;

  const [metas, setMetas] = useState<WorkspaceRevisionMeta[] | null>(null);
  const [diagnostics, setDiagnostics] = useState<StorageDiagnostics | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [previewLines, setPreviewLines] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [entries, diag] = await Promise.all([getRevisionHistory(50), getStorageDiagnostics()]);
      setMetas(entries);
      setDiagnostics(diag);
    } catch {
      setMetas([]);
      setMessage({ kind: 'error', text: t(lang, 'history.loadFailed') });
    }
  }, [lang]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Preview (§28): derived from the historical state vs the current state —
  // nothing is mutated while previewing.
  const selectRevision = async (revision: number): Promise<void> => {
    setSelected(revision);
    setPreviewLines(null);
    const reconstructed = await reconstructRevision(revision).catch(() => null);
    if (reconstructed === null || !reconstructed.ok) {
      setPreviewLines([]);
      return;
    }
    const diff = diffWorkspaces(
      { app: app.state, reports: reportsApi.state },
      { app: reconstructed.app, reports: reconstructed.reports },
    );
    setPreviewLines(summaryLines(lang, diff.summary));
  };

  const restore = async (revision: number): Promise<void> => {
    const confirmed = window.confirm(t(lang, 'history.restoreConfirm', { revision }));
    if (!confirmed) return;
    setBusy(true);
    try {
      const result = await createRestoreRevision(revision);
      if (!result.ok) {
        setMessage({ kind: 'error', text: t(lang, 'history.restoreFailed') });
        return;
      }
      // Refresh the React state with the restored canonical state (the
      // database already holds it; the persistence effect sees no change).
      app.replaceState(result.app);
      reportsApi.replaceReportsState(result.reports);
      setMessage({
        kind: 'ok',
        text: t(lang, 'history.recoveryComplete', { revision: result.revision, restoredFrom: result.restoredFrom }),
      });
      setSelected(null);
      setPreviewLines(null);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const exportHistoryBackup = async (): Promise<void> => {
    const revisions = await exportRevisionHistoryForBackup().catch(() => null);
    if (revisions === null) {
      setMessage({ kind: 'error', text: t(lang, 'history.loadFailed') });
      return;
    }
    const payload = createHistoryBackupPayload(app.state, reportsApi.state, revisions);
    const now = new Date();
    const stamp = `${now.toISOString().slice(0, 10)}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    downloadTextFile(`ganttchart-history-${stamp}.json`, 'application/json', JSON.stringify(payload, null, 2));
  };

  const historyDiag = diagnostics?.history;
  const currentRevision = diagnostics?.revision ?? 0;
  // Journal entries are ascending (newest last) — paginated with the newest
  // revision visible on load.
  const pager = usePagedRows(metas ?? [], 10, { initialPage: 'last' });

  return (
    <SectionCard title={t(lang, 'history.title')} span={12}>
      <div className="metrics-grid">
        <MetricCard label={t(lang, 'history.current')} value={String(currentRevision)} />
        <MetricCard
          label={t(lang, 'history.integrity')}
          value={
            historyDiag === undefined
              ? '—'
              : historyDiag.integrity === 'verified'
                ? t(lang, 'history.integrityVerified')
                : historyDiag.integrity === 'warning'
                  ? t(lang, 'history.integrityWarning')
                  : t(lang, 'history.integrityUnavailable')
          }
          tone={historyDiag?.integrity === 'verified' ? 'good' : historyDiag?.integrity === 'warning' ? 'bad' : 'default'}
        />
        <MetricCard label={t(lang, 'history.retention', { count: REVISION_HISTORY_RETENTION })} value={`${historyDiag?.entryCount ?? 0}`} />
      </div>

      {message !== null ? (
        <p className={message.kind === 'ok' ? 'plan-hint' : 'plan-error-summary'}>{message.text}</p>
      ) : null}

      {metas === null ? (
        <p className="empty-note">…</p>
      ) : metas.length === 0 ? (
        <p className="empty-note">{t(lang, 'history.noHistory')}</p>
      ) : (
        <div className="table-wrap">
          <table className="dr-table">
            <thead>
              <tr>
                <th>{t(lang, 'history.revision')}</th>
                <th>{t(lang, 'columns.date')}</th>
                <th>{t(lang, 'history.reason')}</th>
                <th>{t(lang, 'history.change')}</th>
                <th>{t(lang, 'overall.projects')}</th>
              </tr>
            </thead>
            <tbody>
              {pager.pagedRows.map((meta) => {
                const isCurrent = meta.revision === currentRevision;
                return (
                  <tr
                    key={meta.revision}
                    className={selected === meta.revision ? 'completes' : undefined}
                    onClick={() => void selectRevision(meta.revision)}
                  >
                    <td>
                      {meta.revision}
                      {isCurrent ? ` — ${t(lang, 'history.current')}` : ''}
                    </td>
                    <td>{meta.committedAt.replace('T', ' ').slice(0, 16)}</td>
                    <td>{t(lang, REASON_KEY[meta.reason])}</td>
                    <td>
                      {meta.restoredFromRevision !== undefined
                        ? `${t(lang, 'history.restoredFrom')} ${meta.restoredFromRevision}`
                        : summaryLines(lang, meta.changeSummary).join(' / ') || '—'}
                    </td>
                    <td>{meta.affectedProjectIds.length > 0 ? meta.affectedProjectIds.join(', ') : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <TablePager lang={lang} pager={pager} />

      {selected !== null && previewLines !== null ? (
        <div className="plan-explanation">
          <p className="plan-hint">{t(lang, 'history.preview')}:</p>
          <ul className="history-preview-list">
            {previewLines.length === 0 ? <li>—</li> : previewLines.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <button
            type="button"
            className="btn"
            disabled={busy || selected === currentRevision}
            onClick={() => void restore(selected)}
          >
            {t(lang, 'history.restore')} #{selected}
          </button>
        </div>
      ) : null}

      <div className="plan-actions">
        <button type="button" className="btn btn-ghost" onClick={() => void exportHistoryBackup()}>
          {t(lang, 'history.exportHistory')}
        </button>
      </div>
    </SectionCard>
  );
}
