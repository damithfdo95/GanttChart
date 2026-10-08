import { useCallback, useEffect, useState } from 'react';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { actorLabel, changedLabel, kindLabelKey } from '../../domain/historyLabels';
import { useSharedSync } from '../../app/shared-sync';
import { countRecords } from '../../lib/sync/records';
import { SHARED_HISTORY_DAYS } from '../../lib/sync/guards';
import { RECORD_KINDS, type RecordPut } from '../../../shared/protocol';
import { t } from '../../i18n';
import { DEFAULT_HISTORY_PAGE_SIZE, HISTORY_PAGE_SIZES, pageUrl, toPage, type HistoryFilter, type HistoryPage, type HistoryPageSize } from '../../lib/history/pagination';

interface RevisionRow {
  revision: number;
  committedAt: string;
  actor: string;
  reason: string;
  puts: number;
  deletes: number;
  summary: Array<{ kind: string; puts: number; deletes: number }>;
  /** The first few records the revision changed (named on screen by what they are now, never by id). */
  changed?: Array<{ kind: string; id: string }>;
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
  const reports = useReportsStateCtx();
  const [filter, setFilter] = useState<HistoryFilter>({});
  const [page, setPage] = useState<HistoryPage<RevisionRow> | null>(null);
  const [pageSize, setPageSize] = useState<HistoryPageSize>(DEFAULT_HISTORY_PAGE_SIZE);
  /** One `before` cursor per page we are past; empty = the newest page. */
  const [cursors, setCursors] = useState<number[]>([]);
  const rows = page === null ? null : page.rows;
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<{ revision: number; text: string } | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const before = cursors.length === 0 ? undefined : cursors[cursors.length - 1];
  const load = useCallback(async (): Promise<void> => {
    setFailed(false);
    try {
      const res = await fetch(pageUrl(pageSize, before, filter), { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      setPage(toPage((await res.json()) as RevisionRow[], pageSize));
    } catch {
      setFailed(true);
    }
  }, [pageSize, before, filter]);

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

  const change = (patch: HistoryFilter): void => {
    setFilter((f) => ({ ...f, ...patch }));
    setCursors([]); // a different list: start from its newest page
  };
  const actors = [...new Set([...(reports.state.rcsMembers ?? []).map((m) => m.email).filter((e): e is string => e !== undefined), ...(rows ?? []).map((r) => r.actor)])].sort();
  const filtered = (filter.kind ?? '') !== '' || (filter.actor ?? '') !== '' || (filter.from ?? '') !== '' || (filter.to ?? '') !== '';

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
      {message === null ? null : (
        <p className={`data-controls-message ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
      <div className="tenancy-controls" role="search" aria-label={t(lang, 'hist.filter')}>
        <label>
          {t(lang, 'hist.recordType')}
          <select className="input" value={filter.kind ?? ''} onChange={(e) => change({ kind: e.target.value })}>
            <option value="">{t(lang, 'tenancy.list.all')}</option>
            {RECORD_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(lang, kindLabelKey(k))}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t(lang, 'hist.actor')}
          <select className="input" value={filter.actor ?? ''} onChange={(e) => change({ actor: e.target.value })}>
            <option value="">{t(lang, 'tenancy.list.all')}</option>
            {actors.map((a) => (
              <option key={a} value={a}>
                {actorLabel(a, reports.state, lang)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t(lang, 'hist.from')}
          <input className="input" type="date" value={filter.from ?? ''} onChange={(e) => change({ from: e.target.value })} />
        </label>
        <label>
          {t(lang, 'hist.to')}
          <input className="input" type="date" value={filter.to ?? ''} onChange={(e) => change({ to: e.target.value })} />
        </label>
        {filtered ? (
          <button type="button" className="btn btn-ghost" onClick={() => { setFilter({}); setCursors([]); }}>
            {t(lang, 'hist.clear')}
          </button>
        ) : null}
      </div>
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
                <td>{actorLabel(row.actor, reports.state, lang)}</td>
                <td>
                  {reasonText(row.reason)}
                  {(row.changed ?? []).length === 0 ? null : (
                    <ul className="hist-changed">
                      {(row.changed ?? []).map((c) => (
                        <li key={`${c.kind}:${c.id}`}>{changedLabel(c.kind, c.id, reports.state, lang)}</li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>{row.puts + row.deletes}</td>
                <td>
                  <button type="button" className="btn btn-ghost" onClick={() => void showPreview(row.revision)}>
                    {t(lang, 'shared.history.preview')}
                  </button>{' '}
                  <button type="button" className="btn" disabled={busy} onClick={() => void restore(row)}>
                    {t(lang, 'shared.history.restore')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {page === null || failed ? null : (
        <nav className="table-pager" aria-label={t(lang, 'shared.history.pager')}>
          <button type="button" className="btn btn-ghost" disabled={cursors.length === 0} onClick={() => setCursors((c) => c.slice(0, -1))}>
            {t(lang, 'shared.history.previous')}
          </button>
          <span role="status">
            {page.newest === null ? t(lang, 'shared.history.empty') : t(lang, 'shared.history.range', { newest: page.newest, oldest: page.oldest ?? page.newest, page: cursors.length + 1 })}
          </span>
          <button type="button" className="btn btn-ghost" disabled={!page.hasMore || page.oldest === null} onClick={() => page.oldest !== null && setCursors((c) => [...c, page.oldest as number])}>
            {t(lang, 'shared.history.next')}
          </button>
          <label>
            {t(lang, 'shared.history.pageSize')}
            <select
              className="input"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value) as HistoryPageSize);
                setCursors([]);
              }}
            >
              {HISTORY_PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </nav>
      )}
    </section>
  );
}
