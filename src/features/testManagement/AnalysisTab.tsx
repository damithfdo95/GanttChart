/**
 * Test Management → Analysis tab: the TestRail result analysis (a port of the
 * "TestRail 分析ツール"). One CSV export (or a live fetch of the project's
 * linked runs) becomes the five views — needs review, Retest/N/A, Build
 * check, consistency and achievements — with the tool's filters (period,
 * tester exclusion, Build list, TestRun list) and a copy-for-Teams button.
 *
 * Data-flow rules (fixed by design, like TestRailScopeProgress):
 *  - The loaded rows and every derived number are COMPONENT-LOCAL state.
 *    Nothing is persisted or synced — another device must not receive stale
 *    numbers that look authoritative.
 *  - The live lane uses the device-local TestRail connection and the runs
 *    linked by this project's scopes; without a connection a hint points at
 *    Settings instead of numbers.
 *  - The API cannot provide step-level statuses, so the Untested rule runs
 *    only on CSV data (a hint says so when the data came from the API).
 */

import { useCallback, useMemo, useState } from 'react';
import { useReportsStateCtx } from '../../app/state-contexts';
import { t, type TranslationKey } from '../../i18n';
import { createTestRailClient } from '../../lib/testrail/client';
import { CsvFileButton } from '../../components/CsvFileButton';
import {
  analyzeResults,
  extractBuilds,
  extractRuns,
  parseResultExport,
  rowsFromApi,
  type AnalysisFinding,
  type AnalysisIssueKind,
  type AnalysisOptions,
  type AnalysisResult,
  type AnalysisStatus,
  type TestRailAnalysisRow,
} from '../../domain/testrail/resultAnalysis';
import { useBusinessToday, useTestManagement } from './useTestManagement';
import type { Language, ProjectRecord } from '../../types';
import type { TestRailClientError, TestRailUser } from '../../../shared/testrail';

type View = 'needsReview' | 'other' | 'build' | 'consistency' | 'achievements';
const VIEWS: readonly View[] = ['needsReview', 'other', 'build', 'consistency', 'achievements'];

type PeriodMode = 'today' | 'all' | 'custom';

interface Loaded {
  rows: TestRailAnalysisRow[];
  /** Where the rows came from — the Untested hint depends on it. */
  source: 'csv' | 'api';
  fileName: string;
  /** Distinct unrecognized Status values in the data (kept as Custom Status). */
  unknownStatuses: string[];
}

/** A status word exactly as TestRail names it (localized label, canonical meaning). */
const statusLabel = (lang: Language, s: AnalysisStatus): string => t(lang, `tm.analysis.status.${s}` as TranslationKey);

/** One issue kind, localized (確認項目). */
const issueLabel = (lang: Language, k: AnalysisIssueKind): string => t(lang, `tm.analysis.issue.${k}` as TranslationKey);

/** One sortable table of findings, with a keyword filter and a copy button. */
function FindingsTable({
  lang,
  view,
  findings,
  baseUrl,
}: {
  lang: Language;
  view: View;
  findings: readonly AnalysisFinding[];
  baseUrl: string;
}) {
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const keywords = q.trim().toLowerCase().split(/\s+/).filter((k) => k !== '');
    if (keywords.length === 0) return findings;
    return findings.filter((f) => {
      const hay = `${f.testRun} ${f.row.testedBy} ${f.row.testedOn} ${f.row.testId} ${f.row.caseId} ${statusLabel(lang, f.row.status)} ${f.issues.map((k) => issueLabel(lang, k)).join(' ')} ${f.row.comment}`.toLowerCase();
      return keywords.every((k) => hay.includes(k));
    });
  }, [findings, q, lang]);

  const copyTable = (): void => {
    const headers = [
      t(lang, 'tm.analysis.col.testRun'),
      t(lang, 'tm.analysis.col.testedBy'),
      t(lang, 'tm.analysis.col.date'),
      t(lang, 'tm.analysis.col.test'),
      t(lang, 'tm.analysis.col.case'),
      t(lang, 'tm.analysis.col.status'),
      t(lang, 'tm.analysis.col.issues'),
      t(lang, 'tm.analysis.col.comment'),
    ];
    const head = `<tr>${headers.map((h) => `<th style="padding:5px 8px;border:1px solid #ccc;background:#e8eaf6;">${h}</th>`).join('')}</tr>`;
    const body = rows
      .map((f) => {
        const url = `${baseUrl}/index.php?/tests/view/${f.row.testId}`;
        const cells = [
          f.testRun,
          f.row.testedBy,
          f.row.testedOn,
          `<a href="${url}">${f.row.testId}</a>`,
          f.row.caseId === 0 ? '' : String(f.row.caseId),
          statusLabel(lang, f.row.status),
          f.issues.map((k) => issueLabel(lang, k)).join(', '),
          f.row.comment.slice(0, 120),
        ]
          .map((c) => `<td style="padding:5px 8px;border:1px solid #ccc;">${c}</td>`)
          .join('');
        return `<tr>${cells}</tr>`;
      })
      .join('');
    const html = `<table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;">${head}${body}</table>`;
    void navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }) })]);
  };

  return (
    <div className="tm-analysis-table">
      <div className="tenancy-controls" role="search">
        <label>
          {t(lang, 'tm.analysis.search')}
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <button type="button" className="btn" onClick={copyTable}>
          {t(lang, 'tm.analysis.copy')}
        </button>
      </div>
      <div className="tenancy-table-wrap">
        <table className="tenancy-table">
          <caption className="sr-only">{t(lang, `tm.analysis.view.${view}` as TranslationKey)}</caption>
          <thead>
            <tr>
              <th scope="col">{t(lang, 'tm.analysis.col.testRun')}</th>
              <th scope="col">{t(lang, 'tm.analysis.col.testedBy')}</th>
              <th scope="col">{t(lang, 'tm.analysis.col.date')}</th>
              <th scope="col">{t(lang, 'tm.analysis.col.test')}</th>
              <th scope="col">{t(lang, 'tm.analysis.col.case')}</th>
              <th scope="col">{t(lang, 'tm.analysis.col.status')}</th>
              <th scope="col">{t(lang, 'tm.analysis.col.issues')}</th>
              <th scope="col">{t(lang, 'tm.analysis.col.comment')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f, i) => (
              <tr key={`${f.row.testId}-${i}`} className={view === 'needsReview' ? 'tm-analysis-ng' : undefined}>
                <td>{f.testRun}</td>
                <td>{f.row.testedBy}</td>
                <td>{f.row.testedOn}</td>
                <td>
                  <a href={`${baseUrl}/index.php?/tests/view/${f.row.testId}`} target="_blank" rel="noreferrer">
                    {f.row.testId}
                  </a>
                </td>
                <td>
                  {f.row.caseId === 0 ? (
                    '—'
                  ) : (
                    <a href={`${baseUrl}/index.php?/cases/results/${f.row.caseId}`} target="_blank" rel="noreferrer">
                      {f.row.caseId}
                    </a>
                  )}
                </td>
                <td>{statusLabel(lang, f.row.status)}</td>
                <td>{f.issues.map((k) => issueLabel(lang, k)).join(', ')}</td>
                <td className="tm-analysis-comment">{f.row.comment.slice(0, 120)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="link-help">{t(lang, 'tm.analysis.rows', { count: rows.length })}</p>
    </div>
  );
}

/** The Analysis tab body. All state is local; nothing here is ever synced. */
export function AnalysisTab({ lang, project }: { lang: Language; project: ProjectRecord }) {
  const tm = useTestManagement();
  const reports = useReportsStateCtx();
  const today = useBusinessToday();
  const conn = reports.state.settings.testrail;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [view, setView] = useState<View>('needsReview');
  const [periodMode, setPeriodMode] = useState<PeriodMode>('today');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [excluded, setExcluded] = useState('');
  const [checkOs, setCheckOs] = useState(true);
  const [builds, setBuilds] = useState<string[]>([]);
  const [buildSel, setBuildSel] = useState<Set<string>>(new Set());
  const [runs, setRuns] = useState<string[]>([]);
  const [runSel, setRunSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const adoptRows = useCallback((next: Loaded): void => {
    setLoaded(next);
    const b = extractBuilds(next.rows);
    const r = extractRuns(next.rows);
    setBuilds(b);
    setBuildSel(new Set(b));
    setRuns(r);
    setRunSel(new Set(r));
    setNote(null);
  }, []);

  const onCsv = (text: string, fileName: string): void => {
    const parsed = parseResultExport(text);
    if (parsed.rows.length === 0) {
      setNote({ kind: 'error', text: t(lang, 'tm.analysis.csvFailed', { file: fileName }) });
      return;
    }
    adoptRows({ rows: parsed.rows, source: 'csv', fileName, unknownStatuses: parsed.unknownStatuses });
    if (parsed.errors.length > 0) {
      setNote({ kind: 'error', text: t(lang, 'tm.analysis.csvRowErrors', { count: parsed.errors.length }) });
    }
  };

  /** Live lane: fetch the results of every run linked by this project's scopes. */
  const fetchFromApi = async (): Promise<void> => {
    if (conn === undefined) return;
    const linked = tm.scopes.filter((s) => s.projectId === project.projectId && s.testrail !== undefined);
    if (linked.length === 0) {
      setNote({ kind: 'error', text: t(lang, 'tm.analysis.noLinkedRuns') });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const client = createTestRailClient(conn);
      const rows: TestRailAnalysisRow[] = [];
      for (const scope of linked) {
        const runId = scope.testrail?.runId;
        if (runId === undefined) continue;
        const [run, tests, results] = await Promise.all([
          client.getRun(runId),
          client.getTestsForRun(runId),
          client.getResultsForRun(runId),
        ]);
        let users: TestRailUser[] = [];
        try {
          users = await client.getUsers();
        } catch {
          /* names degrade to "User #id" — counts never do */
        }
        rows.push(...rowsFromApi(results, tests, [run], users));
      }
      if (rows.length === 0) {
        setNote({ kind: 'error', text: t(lang, 'tm.analysis.apiEmpty') });
        return;
      }
      adoptRows({ rows, source: 'api', fileName: 'TestRail API', unknownStatuses: [] });
    } catch (e) {
      setNote({ kind: 'error', text: (e as TestRailClientError).message });
    } finally {
      setBusy(false);
    }
  };

  const options: AnalysisOptions = useMemo(
    () => ({
      period:
        periodMode === 'all'
          ? { kind: 'all' }
          : periodMode === 'today'
            ? { kind: 'today' }
            : { kind: 'custom', from: from || today, to: to || today },
      excludedTesters: excluded.split(',').map((s) => s.trim()).filter((s) => s !== ''),
      checkOs,
      builds: [...buildSel],
      runs: runSel.size === runs.length ? [] : [...runSel], // all checked = no filter
      today,
    }),
    [periodMode, from, to, today, excluded, checkOs, buildSel, runSel, runs.length],
  );

  const result: AnalysisResult | null = useMemo(
    () => (loaded === null ? null : analyzeResults(loaded.rows, options)),
    [loaded, options],
  );

  const baseUrl = (conn?.baseUrl ?? 'https://rkong.testrail.com').replace(/\/+$/, '');

  if (loaded === null) {
    return (
      <section className="dr-section tenancy-empty" role="note">
        <h2>{t(lang, 'tm.analysis.title')}</h2>
        <p>{t(lang, 'tm.analysis.empty')}</p>
        <div className="dr-button-row">
          <CsvFileButton label={t(lang, 'tm.analysis.importCsv')} onText={onCsv} />
          {conn === undefined ? (
            <p className="link-help">{t(lang, 'tm.analysis.noConnection')}</p>
          ) : (
            <button type="button" className="btn" disabled={busy} onClick={() => void fetchFromApi()}>
              {busy ? t(lang, 'tm.analysis.fetching') : t(lang, 'tm.analysis.fetchApi')}
            </button>
          )}
        </div>
        {note !== null ? (
          <p className={`data-controls-message ${note.kind}`} role={note.kind === 'error' ? 'alert' : 'status'}>
            {note.text}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section className="dr-section">
      <div className="dr-button-row">
        <h2>{t(lang, 'tm.analysis.title')}</h2>
        <span className="link-help">{loaded.fileName}</span>
        <CsvFileButton label={t(lang, 'tm.analysis.importCsv')} onText={onCsv} className="btn btn-ghost" />
        {conn !== undefined ? (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void fetchFromApi()}>
            {busy ? t(lang, 'tm.analysis.fetching') : t(lang, 'tm.analysis.fetchApi')}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setLoaded(null);
            setNote(null);
          }}
        >
          {t(lang, 'tm.analysis.reset')}
        </button>
      </div>
      {note !== null ? (
        <p className={`data-controls-message ${note.kind}`} role={note.kind === 'error' ? 'alert' : 'status'}>
          {note.text}
        </p>
      ) : null}
      {loaded.unknownStatuses.length > 0 ? (
        <div className="tm-warning" role="status">
          <strong>
            <span aria-hidden="true">⚠ </span>
            {t(lang, 'tm.analysis.unknownStatuses', { list: loaded.unknownStatuses.join(', ') })}
          </strong>
          <span className="link-help"> {t(lang, 'tm.analysis.unknownStatusesHint')}</span>
        </div>
      ) : null}
      {loaded.source === 'api' ? <p className="link-help">{t(lang, 'tm.analysis.apiNoSteps')}</p> : null}

      {/* Options bar — the tool's left panel */}
      <div className="tenancy-controls tm-analysis-options">
        <label className="dr-toolbar-field">
          {t(lang, 'tm.analysis.period')}
          <select
            className="input"
            value={periodMode}
            onChange={(e) => setPeriodMode(e.target.value as PeriodMode)}
          >
            <option value="today">{t(lang, 'tm.analysis.period.today')}</option>
            <option value="all">{t(lang, 'tm.analysis.period.all')}</option>
            <option value="custom">{t(lang, 'tm.analysis.period.custom')}</option>
          </select>
        </label>
        {periodMode === 'custom' ? (
          <>
            <label className="dr-toolbar-field">
              {t(lang, 'tm.analysis.period.from')}
              <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="dr-toolbar-field">
              {t(lang, 'tm.analysis.period.to')}
              <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </>
        ) : null}
        <label className="dr-toolbar-field">
          {t(lang, 'tm.analysis.excluded')}
          <input
            className="input"
            type="text"
            value={excluded}
            placeholder="samad, kass"
            onChange={(e) => setExcluded(e.target.value)}
          />
        </label>
        <label>
          <input type="checkbox" checked={checkOs} onChange={(e) => setCheckOs(e.target.checked)} />{' '}
          {t(lang, 'tm.analysis.checkOs')}
        </label>
      </div>

      {/* Build + TestRun checkbox lists */}
      <div className="tm-analysis-filters">
        <fieldset className="tm-analysis-filter">
          <legend>{t(lang, 'tm.analysis.builds')}</legend>
          {builds.length === 0 ? (
            <p className="link-help">{t(lang, 'tm.analysis.noBuilds')}</p>
          ) : (
            builds.map((b) => (
              <label key={b}>
                <input
                  type="checkbox"
                  checked={buildSel.has(b)}
                  onChange={() => {
                    const next = new Set(buildSel);
                    if (next.has(b)) next.delete(b);
                    else next.add(b);
                    setBuildSel(next);
                  }}
                />{' '}
                {b}
              </label>
            ))
          )}
        </fieldset>
        <fieldset className="tm-analysis-filter">
          <legend>{t(lang, 'tm.analysis.runs')}</legend>
          {runs.map((r) => (
            <label key={r}>
              <input
                type="checkbox"
                checked={runSel.has(r)}
                onChange={() => {
                  const next = new Set(runSel);
                  if (next.has(r)) next.delete(r);
                  else next.add(r);
                  setRunSel(next);
                }}
              />{' '}
              {r}
            </label>
          ))}
        </fieldset>
      </div>

      {/* Summary cards */}
      {result !== null ? (
        <dl className="tm-summary tm-analysis-cards" aria-label={t(lang, 'tm.analysis.summary')}>
          <div>
            <dt>{t(lang, 'tm.analysis.card.executed')}</dt>
            <dd>{result.summary.executed}</dd>
          </div>
          <div>
            <dt>{t(lang, 'tm.analysis.card.needsReview')}</dt>
            <dd>{result.summary.needsReview}</dd>
          </div>
          <div>
            <dt>{t(lang, 'tm.analysis.card.other')}</dt>
            <dd>{result.summary.other}</dd>
          </div>
          <div>
            <dt>{t(lang, 'tm.analysis.card.consistency')}</dt>
            <dd>{result.summary.consistency}</dd>
          </div>
        </dl>
      ) : null}

      {/* Views */}
      <div className="view-toggle" role="tablist" aria-label={t(lang, 'tm.analysis.title')}>
        {VIEWS.map((id) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} className={view === id ? 'active' : undefined} onClick={() => setView(id)}>
            {t(lang, `tm.analysis.view.${id}` as TranslationKey)}
          </button>
        ))}
      </div>

      {result === null ? null : view === 'achievements' ? (
        <div className="tenancy-table-wrap">
          <table className="tenancy-table">
            <caption className="sr-only">{t(lang, 'tm.analysis.view.achievements')}</caption>
            <thead>
              <tr>
                <th scope="col">{t(lang, 'tm.analysis.col.testedBy')}</th>
                <th scope="col">{t(lang, 'tm.analysis.col.date')}</th>
                <th scope="col">{t(lang, 'tm.analysis.card.executed')}</th>
                <th scope="col">Retest</th>
              </tr>
            </thead>
            <tbody>
              {result.achievements.map((a) => (
                <tr key={`${a.testedBy}-${a.date}`}>
                  <td>{a.testedBy}</td>
                  <td>{a.date}</td>
                  <td>{a.executed}</td>
                  <td>{a.retest}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : view === 'consistency' ? (
        <div className="tenancy-table-wrap">
          <table className="tenancy-table">
            <caption className="sr-only">{t(lang, 'tm.analysis.view.consistency')}</caption>
            <thead>
              <tr>
                <th scope="col">{t(lang, 'tm.analysis.col.case')}</th>
                <th scope="col">{t(lang, 'tm.analysis.col.date')}</th>
                <th scope="col">{t(lang, 'tm.analysis.col.difference')}</th>
                <th scope="col">{t(lang, 'tm.analysis.col.testedBy')}</th>
              </tr>
            </thead>
            <tbody>
              {result.consistency.map((c) => (
                <tr key={c.caseId} className="tm-analysis-warn">
                  <td>
                    <a href={`${baseUrl}/index.php?/cases/results/${c.caseId}`} target="_blank" rel="noreferrer">
                      {c.caseId}
                    </a>
                  </td>
                  <td>{c.date}</td>
                  <td>{t(lang, 'tm.analysis.consistency.diff', { passed: c.passed, failed: c.failed })}</td>
                  <td>{c.testedBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <FindingsTable
          lang={lang}
          view={view}
          findings={view === 'needsReview' ? result.needsReview : view === 'other' ? result.retestNa : result.buildCheck}
          baseUrl={baseUrl}
        />
      )}
    </section>
  );
}
