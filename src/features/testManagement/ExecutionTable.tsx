import { useMemo, useState } from 'react';
import { t, type TranslationKey } from '../../i18n';
import { CASE_PRIORITIES, CASE_STATUSES, filterCases, sortCases, type CasePriority, type CaseResult, type CaseSort, type CaseStatus, type ResultPatch, type TestCase, type TestScope } from '../../domain/testManagement';
import type { Language } from '../../types';

const PAGE = 200;

/** A text box that saves when you leave it (or press Enter), never per keystroke: one revision per edit, not per character. */
function CommitInput({ value, label, maxLength, disabled, onCommit, wide }: { value: string; label: string; maxLength: number; disabled: boolean; onCommit: (v: string) => void; wide?: boolean }) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    // The stored value changed under us (someone else, or our own save): follow it.
    setSeen(value);
    setDraft(value);
  }
  const commit = (): void => {
    if (draft.trim() !== value.trim()) onCommit(draft);
  };
  return (
    <input
      className={`input tm-input${wide === true ? ' tm-wide' : ''}`}
      type="text"
      value={draft}
      maxLength={maxLength}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

export interface ExecutionTableProps {
  lang: Language;
  /** Cases to work on (already limited to the scopes this person may see). */
  cases: readonly TestCase[];
  scopes: readonly TestScope[];
  byCase: ReadonlyMap<string, CaseResult>;
  /** May this person change the result of this case? (assigned, active scope and case, ...). The server decides again. */
  canEdit: (tc: TestCase) => boolean;
  onPatch: (tc: TestCase, patch: ResultPatch) => void;
  /** Who last changed a result, as a name (never an id). */
  nameOf: (userId: string | null | undefined) => string;
  showScope?: boolean;
  /** Names of the people who may be filtered on ("last updated by"), SV screens only. */
  updaters?: ReadonlyArray<{ id: string; label: string }>;
}

/**
 * The execution grid: compact, one row per case, status/flags/memo/device edited in place, no dialog per click. Filters and sorting are
 * client-side and the table renders in pages of 200 rows ("Show more"), so a scope with thousands of cases stays responsive.
 */
export function ExecutionTable({ lang, cases, scopes, byCase, canEdit, onPatch, nameOf, showScope = false, updaters }: ExecutionTableProps) {
  const [status, setStatus] = useState<CaseStatus | 'all'>('all');
  const [priority, setPriority] = useState<CasePriority | 'all'>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<CaseSort>('order');
  const [retest, setRetest] = useState(false);
  const [question, setQuestion] = useState(false);
  const [by, setBy] = useState('');
  const [limit, setLimit] = useState(PAGE);

  const rows = useMemo(() => {
    const filtered = filterCases(sortCases(cases), byCase, { status, priority, q, retest, question }, sort);
    return by === '' ? filtered : filtered.filter((c) => byCase.get(c.id)?.updatedByUserId === by);
  }, [cases, byCase, status, priority, q, retest, question, sort, by]);
  const scopeName = (id: string): string => scopes.find((s) => s.id === id)?.name ?? '';
  const shown = rows.slice(0, limit);

  return (
    <div className="tm-execution">
      <div className="tenancy-controls" role="search">
        <label>
          {t(lang, 'tm.filter.search')}
          <input className="input" type="search" value={q} placeholder={t(lang, 'tm.filter.searchPlaceholder')} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label>
          {t(lang, 'tm.col.status')}
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as CaseStatus | 'all')}>
            <option value="all">{t(lang, 'tenancy.list.all')}</option>
            {CASE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(lang, `tm.status.${s}` as TranslationKey)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t(lang, 'tm.col.priority')}
          <select className="input" value={priority} onChange={(e) => setPriority(e.target.value as CasePriority | 'all')}>
            <option value="all">{t(lang, 'tenancy.list.all')}</option>
            {CASE_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {t(lang, `tm.priority.${p}` as TranslationKey)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t(lang, 'tenancy.list.sortBy')}
          <select className="input" value={sort} onChange={(e) => setSort(e.target.value as CaseSort)}>
            {(['order', 'key', 'priority', 'status', 'updated'] as const).map((s) => (
              <option key={s} value={s}>
                {t(lang, `tm.sort.${s}` as TranslationKey)}
              </option>
            ))}
          </select>
        </label>
        {updaters !== undefined && updaters.length > 0 ? (
          <label>
            {t(lang, 'tm.filter.updatedBy')}
            <select className="input" value={by} onChange={(e) => setBy(e.target.value)}>
              <option value="">{t(lang, 'tenancy.list.all')}</option>
              {updaters.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="tm-check">
          <input type="checkbox" checked={retest} onChange={(e) => setRetest(e.target.checked)} /> {t(lang, 'tm.col.retest')}
        </label>
        <label className="tm-check">
          <input type="checkbox" checked={question} onChange={(e) => setQuestion(e.target.checked)} /> {t(lang, 'tm.col.question')}
        </label>
      </div>
      <p className="link-help" role="status">
        {t(lang, 'tenancy.list.showing', { shown: Math.min(shown.length, rows.length), total: rows.length })}
      </p>
      {cases.length === 0 ? (
        <p className="tenancy-empty" role="note">
          {t(lang, 'tm.exec.noCases')}
        </p>
      ) : rows.length === 0 ? (
        <p>{t(lang, 'tm.exec.noMatch')}</p>
      ) : (
        <div className="tenancy-table-wrap tm-grid-wrap">
          <table className="tenancy-table tm-grid">
            <caption className="sr-only">{t(lang, 'tm.exec.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t(lang, 'tm.col.case')}</th>
                {showScope ? <th scope="col">{t(lang, 'tm.col.scope')}</th> : null}
                <th scope="col">{t(lang, 'tm.col.title')}</th>
                <th scope="col">{t(lang, 'tm.col.priority')}</th>
                <th scope="col">{t(lang, 'tm.col.status')}</th>
                <th scope="col">{t(lang, 'tm.col.retest')}</th>
                <th scope="col">{t(lang, 'tm.col.question')}</th>
                <th scope="col">{t(lang, 'tm.col.memo')}</th>
                <th scope="col">{t(lang, 'tm.col.device')}</th>
                <th scope="col">{t(lang, 'tm.col.os')}</th>
                <th scope="col">{t(lang, 'tm.col.updatedBy')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((tc) => {
                const r = byCase.get(tc.id);
                const editable = canEdit(tc);
                const label = `${tc.key} ${tc.title}`;
                return (
                  <tr key={tc.id} className={`tm-row tm-status-${r?.status ?? 'notStarted'}`}>
                    <th scope="row" className="tm-key">
                      {tc.key}
                    </th>
                    {showScope ? <td>{scopeName(tc.scopeId)}</td> : null}
                    <td className="tm-title" title={tc.expected === undefined ? undefined : `${t(lang, 'tm.field.expected')}: ${tc.expected}`}>
                      {tc.title}
                    </td>
                    <td>{t(lang, `tm.priority.${tc.priority}` as TranslationKey)}</td>
                    <td>
                      <select
                        className="input tm-status-select"
                        value={r?.status ?? 'notStarted'}
                        disabled={!editable}
                        aria-label={`${t(lang, 'tm.col.status')}: ${label}`}
                        onChange={(e) => onPatch(tc, { status: e.target.value as CaseStatus })}
                      >
                        {CASE_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {t(lang, `tm.status.${s}` as TranslationKey)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input type="checkbox" checked={r?.retest === true} disabled={!editable} aria-label={`${t(lang, 'tm.col.retest')}: ${label}`} onChange={(e) => onPatch(tc, { retest: e.target.checked })} />
                    </td>
                    <td>
                      <input type="checkbox" checked={r?.question === true} disabled={!editable} aria-label={`${t(lang, 'tm.col.question')}: ${label}`} onChange={(e) => onPatch(tc, { question: e.target.checked })} />
                    </td>
                    <td>
                      <CommitInput wide value={r?.memo ?? ''} maxLength={500} disabled={!editable} label={`${t(lang, 'tm.col.memo')}: ${label}`} onCommit={(v) => onPatch(tc, { memo: v })} />
                    </td>
                    <td>
                      <CommitInput value={r?.device ?? ''} maxLength={80} disabled={!editable} label={`${t(lang, 'tm.col.device')}: ${label}`} onCommit={(v) => onPatch(tc, { device: v })} />
                    </td>
                    <td>
                      <CommitInput value={r?.os ?? ''} maxLength={80} disabled={!editable} label={`${t(lang, 'tm.col.os')}: ${label}`} onCommit={(v) => onPatch(tc, { os: v })} />
                    </td>
                    <td className="tm-updated">
                      {r === undefined ? '—' : `${nameOf(r.updatedByUserId)} · ${new Date(r.updatedAt).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US', { dateStyle: 'short', timeStyle: 'short' })}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > limit ? (
        <button type="button" className="btn" onClick={() => setLimit((n) => n + PAGE)}>
          {t(lang, 'tm.exec.showMore', { count: rows.length - limit })}
        </button>
      ) : null}
    </div>
  );
}
