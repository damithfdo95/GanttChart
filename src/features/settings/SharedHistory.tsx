import { useCallback, useEffect, useState } from 'react';
import { useAppStateCtx } from '../../app/state-contexts';
import { useSharedSync } from '../../app/shared-sync';
import { countRecords } from '../../lib/sync/records';
import { SHARED_HISTORY_DAYS } from '../../lib/sync/guards';
import { RECORD_KINDS, type RecordPut } from '../../../shared/protocol';
import { t } from '../../i18n';

interface RevisionRow {
  revision: number;
  committedAt: string;
  actor: string;
  reason: string;
  puts: number;
  deletes: number;
  summary: Array<{ kind: string; puts: number; deletes: number }>;
}

const KINDS: ReadonlySet<string> = new Set(RECORD_KINDS);

function when(iso: string, lang: 'en' | 'ja'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * History of the SHARED workspace, kept on the server. Restoring creates a new
 * revision (append-only), is administrators-only, and is pushed live to everyone.
 */
export function SharedHistory() {
  const lang = useAppStateCtx().state.language;
  const shared = useSharedSync();
  const role = shared.sync?.you?.role ?? shared.identity?.role ?? null;
  const [rows, setRows] = useState<RevisionRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<{ revision: number; text: string } | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setFailed(false);
    try {
      const res = await fetch('/api/revisions?limit=50', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      setRows((await res.json()) as RevisionRow[]);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Reload when the revision moves (someone saved or restored).
  const revision = shared.sync?.revision ?? null;
  useEffect(() => {
    if (revision !== null) void load();
  }, [revision, load]);

  const reasonText = (reason: string): string => {
    const m = /^restore:(\d+)$/.exec(reason);
    return m === null ? t(lang, 'shared.history.reasonEdit') : t(lang, 'shared.history.reasonRestore', { n: m[1] });
  };

  const showPreview = async (n: number): Promise<void> => {
    setMessage(null);
    try {
      const res = await fetch(`/api/revisions/${n}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { records: RecordPut[] };
      const c = countRecords(body.records.filter((r) => KINDS.has(r.kind)));
      setPreview({ revision: n, text: t(lang, 'shared.history.previewResult', { n, projects: c.projects, reports: c.reports, attendance: c.attendance, topics: c.topics, members: c.members }) });
    } catch {
      setMessage({ kind: 'error', text: t(lang, 'shared.history.failed') });
    }
  };

  const restore = async (row: RevisionRow): Promise<void> => {
    if (!window.confirm(t(lang, 'shared.history.restoreConfirm', { n: row.revision, when: when(row.committedAt, lang) }))) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/revisions/${row.revision}/restore`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-GC-Intent': 'restore', Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { revision: number };
      setMessage({ kind: 'ok', text: t(lang, 'shared.history.restoreDone', { n: row.revision, rev: body.revision }) });
      await load();
    } catch {
      setMessage({ kind: 'error', text: t(lang, 'shared.history.restoreFailed') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="dr-section shared-history">
      <div className="dr-section-header">
        <h2>{t(lang, 'shared.history.title')}</h2>
        <button type="button" className="btn btn-ghost" onClick={() => void load()}>
          {t(lang, 'shared.history.refresh')}
        </button>
      </div>
      <p className="dr-summary">{t(lang, 'shared.history.help', { days: SHARED_HISTORY_DAYS })}</p>
      {role !== 'admin' ? <p className="dr-summary">{t(lang, 'shared.history.adminOnly')}</p> : null}
      {message === null ? null : (
        <p className={`data-controls-message ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
      {preview === null ? null : (
        <p className="dr-summary" role="status">
          {preview.text}
        </p>
      )}
      {failed ? (
        <p className="data-controls-message error" role="alert">
          {t(lang, 'shared.history.failed')}
        </p>
      ) : rows === null ? (
        <p>{t(lang, 'shared.history.loading')}</p>
      ) : rows.length === 0 ? (
        <p>{t(lang, 'shared.history.empty')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t(lang, 'shared.history.colRevision')}</th>
              <th>{t(lang, 'shared.history.colWhen')}</th>
              <th>{t(lang, 'shared.history.colWho')}</th>
              <th>{t(lang, 'shared.history.colWhat')}</th>
              <th>{t(lang, 'shared.history.colChanges')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.revision}>
                <td>{row.revision}</td>
                <td>{when(row.committedAt, lang)}</td>
                <td>{row.actor}</td>
                <td>{reasonText(row.reason)}</td>
                <td>{row.puts + row.deletes}</td>
                <td>
                  <button type="button" className="btn btn-ghost" onClick={() => void showPreview(row.revision)}>
                    {t(lang, 'shared.history.preview')}
                  </button>{' '}
                  <button type="button" className="btn" disabled={role !== 'admin' || busy} onClick={() => void restore(row)}>
                    {t(lang, 'shared.history.restore')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
