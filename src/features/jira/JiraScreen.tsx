import { useEffect, useMemo, useState } from 'react';
import type { JiraIssue } from '../../../shared/jira';
import type { BugTicket, ExternalIdentity, RcsMember } from '../../types';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { useAccess } from '../../app/access';
import { useSharedGuard } from '../../app/useSharedGuard';
import { t, resolveBilingualName, type TranslationKey } from '../../i18n';
import { SEARCH_MAX_TOTAL, useJiraSearch } from '../../lib/jira/useJiraSearch';
import { JiraErrorHint } from '../../components/JiraErrorHint';
import { CollapsibleSection } from '../../components/CollapsibleSection';
import { Field } from '../../components/Field';
import { buildExternalIdentityLink } from '../../domain/attribution';
import {
  analyzeTickets,
  buildTicketJql,
  isValidJiraProjectKey,
  normalizeJiraProjectKey,
  type MemberTicketStats,
  type TicketAnalysis,
  type TicketRow,
} from '../../domain/jira';
import { JiraImportTickets } from './JiraImportTickets';
import { ticketAnalysisSheet } from '../../lib/export/exportData';
import { buildXlsx } from '../../lib/export/xlsx';
import { toCsv, csvValueFromCell } from '../../lib/export/csv';
import { downloadBinaryFile, downloadTextFile, fileStamp } from '../../lib/export/download';
import { formatDateDisplay, formatDate, parseDate, todayEpochDays } from '../../lib/dates/dates';
import { formatInteger, formatNumber } from '../../lib/formatting/format';
import { personOptions, personOptionText, selectableMembers } from '../../domain/teamMembers';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Select values for the project-scope filter (never a real JIRA key). */
const SCOPE_ALL_MAPPED = '__allMapped__';
const SCOPE_ALL = '__all__';

/** The JIRA issue types offered in the type filter (JIRA's own default types, shown verbatim). */
const JIRA_ISSUE_TYPES = ['Bug', 'Task', 'Story', 'Epic', 'Improvement', 'New Feature', 'Sub-task'];

type PeriodPreset = '7' | '30' | '90' | 'custom';

/** Stable empty arrays so useMemo inputs never churn between renders. */
const EMPTY_MEMBERS: RcsMember[] = [];
const EMPTY_IDENTITIES: ExternalIdentity[] = [];
const EMPTY_ISSUES: JiraIssue[] = [];

// ---- sorting (the Overall tri-state pattern: ascending → descending → default) ----

interface SortState<K extends string> {
  key: K;
  dir: 'asc' | 'desc';
}

type MemberSortKey = 'memberName' | 'team' | 'total' | 'open' | 'inProgress' | 'done' | 'resolvedRate' | 'lastActivity';
type MemberSortState = SortState<MemberSortKey>;
type TicketSortKey = 'issueKey' | 'summary' | 'statusName' | 'typeName' | 'reporterName' | 'updated';
type TicketSortState = SortState<TicketSortKey>;

function toggleSort<K extends string>(
  key: K,
  current: SortState<K> | null,
  commit: (next: SortState<K> | null) => void,
  reset: SortState<K> | null,
): void {
  if (current === null || current.key !== key) commit({ key, dir: 'asc' });
  else if (current.dir === 'asc') commit({ key, dir: 'desc' });
  else commit(reset);
}

/** Status-category → the app's existing chip tone (text always carries the status). */
const STATUS_TONE: Record<TicketRow['statusCategory'], 'good' | 'bad' | 'default'> = {
  todo: 'default',
  inProgress: 'default',
  done: 'good',
};

/**
 * JIRA tab — "which tester reported how many bug tickets, and where do those
 * tickets stand now?". Fetches tickets through the shared JIRA search client,
 * analyzes them against the Team Member master (domain/jira), and presents
 * per-tester stats, unmatched reporters with SV-only linking, the full ticket
 * list and CSV/XLSX export. Every visual idiom is copied from Overall; nothing
 * is newly styled.
 */
export function JiraScreen() {
  const app = useAppStateCtx();
  const reportsApi = useReportsStateCtx();
  const guard = useSharedGuard();
  const access = useAccess();
  const lang = app.state.language;
  // An SV (or plain local use) links reporters and maps projects; a Tester reads.
  const isSv = !access.isTester;
  const { configured, loading, error, search } = useJiraSearch();

  const projects = reportsApi.state.projects;
  const members = reportsApi.state.rcsMembers ?? EMPTY_MEMBERS;
  const externalIdentities = reportsApi.state.externalIdentities ?? EMPTY_IDENTITIES;

  // ---- filter bar state ----
  const [scope, setScope] = useState<string>(SCOPE_ALL_MAPPED);
  const [period, setPeriod] = useState<PeriodPreset>('30');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [issueType, setIssueType] = useState('Bug');
  const [issues, setIssues] = useState<JiraIssue[] | null>(null);
  /** The query the shown results came from (to tell when the filters have moved on). */
  const [fetchedJql, setFetchedJql] = useState<string | null>(null);
  const [memberSort, setMemberSort] = useState<MemberSortState>({ key: 'total', dir: 'desc' });
  const [ticketSort, setTicketSort] = useState<TicketSortState | null>(null); // null = the domain's order (updated desc)
  // Project-mapping inputs while they are being edited (uncommitted drafts).
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // "Import to Tickets" confirmation step (SV only) — open while the routing preview is shown.
  const [importOpen, setImportOpen] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Transient action feedback (links, exports) auto-clears (Overall precedent).
  useEffect(() => {
    if (message === null) return;
    const timer = window.setTimeout(() => setMessage(null), 6000);
    return () => window.clearTimeout(timer);
  }, [message]);

  // ---- data derivations (memoized — no recalculation on row interactions) ----

  const mappedProjects = useMemo(
    () => projects.filter((p) => p.jiraProjectKey !== undefined && p.jiraProjectKey !== ''),
    [projects],
  );

  const projectKeys = useMemo(() => {
    if (scope === SCOPE_ALL) return undefined;
    if (scope === SCOPE_ALL_MAPPED) {
      const keys = mappedProjects.map((p) => p.jiraProjectKey as string);
      return keys.length > 0 ? keys : undefined;
    }
    const project = projects.find((p) => p.id === scope);
    return project?.jiraProjectKey !== undefined && project.jiraProjectKey !== '' ? [project.jiraProjectKey] : undefined;
  }, [scope, mappedProjects, projects]);

  // "All mapped projects" with nothing mapped would silently search EVERY JIRA project.
  const noMappedScope = scope === SCOPE_ALL_MAPPED && mappedProjects.length === 0;

  const dateRangeInvalid = period === 'custom' && from !== '' && to !== '' && from > to;

  /** The exact query the Fetch button will run — also shown for transparency. */
  const jql = useMemo(
    () =>
      buildTicketJql({
        ...(projectKeys !== undefined ? { projectKeys } : {}),
        // Empty issueTypes = all types (the builder's default is ['Bug']).
        ...(issueType === '' ? { issueTypes: [] as string[] } : { issueTypes: [issueType] }),
        ...(period === 'custom'
          ? { ...(from !== '' ? { from } : {}), ...(to !== '' ? { to } : {}) }
          : { days: Number(period) }),
      }),
    [projectKeys, issueType, period, from, to],
  );

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const today = formatDate(todayEpochDays());
  const memberOptions = useMemo(
    () => personOptions(lang, selectableMembers(members, { today }), today),
    [lang, members, today],
  );
  const memberOptionText = useMemo(
    () => new Map(memberOptions.map((o) => [o.memberId, personOptionText(lang, o)])),
    [memberOptions, lang],
  );

  const analysis = useMemo<TicketAnalysis | null>(
    () => (issues === null ? null : analyzeTickets(issues, members, externalIdentities)),
    [issues, members, externalIdentities],
  );

  // Reuse the analysis matching: issue key → the canonical reporter member
  // (stable id, not the display name) so imported tickets carry the same
  // reporter identity the tab already resolved for them.
  const reporterMemberByIssueKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const ticket of analysis?.tickets ?? []) {
      if (ticket.memberId !== undefined) map.set(ticket.issueKey, ticket.memberId);
    }
    return map;
  }, [analysis]);

  const sortedMembers = useMemo(() => {
    if (analysis === null) return [];
    if (memberSort === null) return analysis.memberStats;
    const sign = memberSort.dir === 'asc' ? 1 : -1;
    return [...analysis.memberStats].sort((a, b) => {
      if (memberSort.key === 'resolvedRate') {
        // Null resolved rates always sort last, whatever the direction.
        const an = a.resolvedRate === null;
        const bn = b.resolvedRate === null;
        if (an !== bn) return an ? 1 : -1;
        if (an) return a.memberName.localeCompare(b.memberName);
        return (a.resolvedRate! - b.resolvedRate!) * sign || a.memberName.localeCompare(b.memberName);
      }
      let cmp = 0;
      switch (memberSort.key) {
        case 'total':
          cmp = a.total - b.total;
          break;
        case 'open':
          cmp = a.open - b.open;
          break;
        case 'inProgress':
          cmp = a.inProgress - b.inProgress;
          break;
        case 'done':
          cmp = a.done - b.done;
          break;
        case 'lastActivity':
          cmp = (a.lastActivity ?? '').localeCompare(b.lastActivity ?? '');
          break;
        case 'team':
          cmp = a.team.localeCompare(b.team);
          break;
        default:
          cmp = a.memberName.localeCompare(b.memberName);
          break;
      }
      return cmp * sign || a.memberName.localeCompare(b.memberName);
    });
  }, [analysis, memberSort]);

  const sortedTickets = useMemo(() => {
    if (analysis === null) return [];
    if (ticketSort === null) return analysis.tickets;
    const sign = ticketSort.dir === 'asc' ? 1 : -1;
    return [...analysis.tickets].sort((a, b) => {
      if (ticketSort.key === 'updated') {
        // Untimestamped tickets always sort last, whatever the direction.
        const an = a.updated === undefined;
        const bn = b.updated === undefined;
        if (an !== bn) return an ? 1 : -1;
        if (an) return a.issueKey.localeCompare(b.issueKey);
        return a.updated!.localeCompare(b.updated!) * sign || a.issueKey.localeCompare(b.issueKey);
      }
      const va = String(a[ticketSort.key]);
      const vb = String(b[ticketSort.key]);
      return va.localeCompare(vb) * sign || a.issueKey.localeCompare(b.issueKey);
    });
  }, [analysis, ticketSort]);

  const summaryCards: { key: TranslationKey; value: number }[] =
    analysis === null
      ? []
      : [
          { key: 'jira.tab.fetched', value: analysis.totals.fetched },
          { key: 'jira.tab.matched', value: analysis.totals.matched },
          { key: 'jira.tab.open', value: analysis.totals.open },
          { key: 'jira.tab.inProgress', value: analysis.totals.inProgress },
          { key: 'jira.tab.done', value: analysis.totals.done },
        ];

  const canExport = analysis !== null && analysis.totals.fetched > 0;

  // ---- actions ----

  const handleFetch = async (): Promise<void> => {
    if (dateRangeInvalid || noMappedScope) return;
    try {
      const result = await search(jql);
      setIssues(result);
      setFetchedJql(jql);
    } catch {
      // The typed failure is surfaced through `error` for the localized hint below.
    }
  };

  const handleLinkReporter = (reporterName: string, memberId: string): void => {
    if (memberId === '') return;
    if (!guard.guardWrite()) return;
    const member = memberById.get(memberId);
    if (member === undefined) return;
    reportsApi.upsertExternalIdentity(
      buildExternalIdentityLink({
        provider: 'jira',
        externalId: reporterName,
        memberId,
        displayName: reporterName,
        linkedAt: new Date().toISOString(),
      }),
    );
    setMessage({ kind: 'ok', text: t(lang, 'jira.tab.linkSucceeded', { reporter: reporterName, member: member.name }) });
  };

  const draftOf = (projectId: string): string =>
    drafts[projectId] ?? projects.find((p) => p.id === projectId)?.jiraProjectKey ?? '';

  const draftInvalid = (projectId: string): boolean => {
    const raw = draftOf(projectId);
    return raw.trim() !== '' && !isValidJiraProjectKey(raw);
  };

  const handleKeyBlur = (projectId: string): void => {
    const raw = draftOf(projectId);
    if (raw.trim() !== '' && !isValidJiraProjectKey(raw)) return; // the live error text stays
    const normalized = normalizeJiraProjectKey(raw);
    reportsApi.updateProject(projectId, { jiraProjectKey: normalized === '' ? undefined : normalized });
    setDrafts((prev) => ({ ...prev, [projectId]: normalized }));
  };

  const handleExportCsv = (): void => {
    if (analysis === null) return;
    const stamp = fileStamp();
    const sheet = ticketAnalysisSheet(analysis);
    const csv = toCsv(sheet.headers, sheet.rows.map((row) => row.map(csvValueFromCell)));
    downloadTextFile(`ganttchart-jira-tickets-${stamp}.csv`, 'text/csv;charset=utf-8', csv);
    setMessage({ kind: 'ok', text: t(lang, 'reports.exportedRows', { dataset: sheet.name, count: sheet.rows.length }) });
  };

  const handleExportXlsx = (): void => {
    if (analysis === null) return;
    const stamp = fileStamp();
    const sheet = ticketAnalysisSheet(analysis);
    downloadBinaryFile(`ganttchart-jira-tickets-${stamp}.xlsx`, XLSX_MIME, buildXlsx([sheet]));
    setMessage({ kind: 'ok', text: t(lang, 'reports.exportedRows', { dataset: sheet.name, count: sheet.rows.length }) });
  };

  /** "Import to Tickets" commit: one project update carrying the merged bugTickets (same path as the mapping keys). */
  const handleCommitImportedTickets = (projectId: string, bugTickets: BugTicket[]): void => {
    const project = projects.find((p) => p.id === projectId);
    if (project === undefined) return;
    reportsApi.updateProject(projectId, { inputs: { ...project.inputs, bugTickets } });
  };

  /** "Import to Tickets" commit feedback (transient toast, the tab's message idiom). */
  const handleImportedTickets = (summary: string): void => {
    setMessage({ kind: 'ok', text: summary });
  };

  const importDisabled = loading || issues === null || issues.length === 0;

  /** Locale-aware date for an ISO timestamp (or a bare YYYY-MM-DD), '—' when absent. */
  const formatIsoDay = (iso: string | undefined): string => {
    if (iso === undefined || iso === '') return '—';
    const epoch = parseDate(iso.slice(0, 10));
    return epoch === null ? iso.slice(0, 10) : formatDateDisplay(epoch, lang);
  };

  const projectName = (project: (typeof projects)[number]): string => {
    const name = resolveBilingualName(lang, { nameEn: project.nameEn, nameJa: project.nameJa });
    return name === '' ? project.projectId : `${name} (${project.jiraProjectKey ?? project.projectId})`;
  };

  // ---- the not-configured guard (normally unreachable — the tab is hidden) ----

  if (!configured) {
    return (
      <div className="app">
        <header className="app-header">
          <div className="app-title-group">
            <h1>{t(lang, 'jira.tab.title')}</h1>
          </div>
        </header>
        <JiraErrorHint lang={lang} error={{ kind: 'notConfigured', message: '' }} notConfiguredMessage="jira.tab.notConfigured" />
      </div>
    );
  }

  const firstRun = mappedProjects.length === 0 && issues === null;

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title-group">
          <h1>{t(lang, 'jira.tab.title')}</h1>
        </div>
      </header>

      {message !== null ? <div className={`dr-message ${message.kind}`} role="status">{message.text}</div> : null}

      {/* ---- filter bar (Overall structure): scope, period, issue types, fetch ---- */}
      <section className="dr-section">
        <div className="dr-filter-bar">
          <label>
            {t(lang, 'jira.tab.project')}
            <select className="input" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value={SCOPE_ALL_MAPPED}>{t(lang, 'jira.tab.projectAllMapped')}</option>
              <option value={SCOPE_ALL}>{t(lang, 'jira.tab.projectAll')}</option>
              {mappedProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {projectName(p)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t(lang, 'jira.tab.period')}
            <select className="input" value={period} onChange={(e) => setPeriod(e.target.value as PeriodPreset)}>
              <option value="7">{t(lang, 'jira.tab.days7')}</option>
              <option value="30">{t(lang, 'jira.tab.days30')}</option>
              <option value="90">{t(lang, 'jira.tab.days90')}</option>
              <option value="custom">{t(lang, 'jira.tab.customRange')}</option>
            </select>
          </label>
          {period === 'custom' ? (
            <>
              <label>
                {t(lang, 'reports.dateFrom')}
                <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label>
                {t(lang, 'reports.dateTo')}
                <input
                  className={`input${dateRangeInvalid ? ' table-input-invalid' : ''}`}
                  type="date"
                  value={to}
                  aria-invalid={dateRangeInvalid}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
            </>
          ) : null}
          <label>
            {t(lang, 'jira.tab.issueTypes')}
            <select className="input" value={issueType} onChange={(e) => setIssueType(e.target.value)}>
              <option value="">{t(lang, 'jira.tab.issueTypesAll')}</option>
              {JIRA_ISSUE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
        </div>
        {dateRangeInvalid ? <p className="field-error" role="alert">{t(lang, 'reports.dateRangeInvalid')}</p> : null}
        <div className="dr-button-row">
          <button type="button" className="btn" disabled={loading || dateRangeInvalid || noMappedScope} onClick={() => void handleFetch()}>
            {loading ? t(lang, 'jira.import.fetching') : t(lang, 'jira.tab.fetch')}
          </button>
        </div>
        {issues !== null && fetchedJql !== null && fetchedJql !== jql ? (
          <p className="dr-summary" role="status">{t(lang, 'jira.tab.staleResults')}</p>
        ) : null}
        <details className="status-explanation">
          <summary>{t(lang, 'jira.tab.showJql')}</summary>
          <p className="dr-summary">{jql}</p>
        </details>
      </section>

      {error !== null ? (
        <JiraErrorHint lang={lang} error={error} notConfiguredMessage="jira.tab.notConfigured" />
      ) : null}

      {firstRun ? (
        <div className="dr-message" role="status">
          {t(lang, isSv ? 'jira.tab.noMappedProjects' : 'jira.tab.noMappedProjectsTester')}
        </div>
      ) : null}

      {!firstRun && analysis !== null ? (
        <>
          {/* ---- summary cards (Overall card style) ---- */}
          <div className="overall-summary">
            {summaryCards.map((card) => (
              <div key={card.key} className="summary-card">
                <span className="summary-card-label">{t(lang, card.key)}</span>
                <span className="summary-card-value">{formatInteger(card.value, lang)}</span>
              </div>
            ))}
          </div>

          {/* ---- per-tester table ---- */}
          <section className="dr-section">
            <h2>{t(lang, 'jira.tab.memberTableTitle')}</h2>
            <div className="table-wrap overall-scroll">
              <table className="overall-table">
                <thead>
                  <tr>
                    {(
                      [
                        ['memberName', 'columns.member'],
                        ['team', 'columns.team'],
                        ['total', 'jira.tab.total'],
                        ['open', 'jira.tab.open'],
                        ['inProgress', 'jira.tab.inProgress'],
                        ['done', 'jira.tab.done'],
                        ['resolvedRate', 'jira.tab.resolvedRate'],
                        ['lastActivity', 'jira.tab.lastActivity'],
                      ] as [MemberSortKey, TranslationKey][]
                    ).map(([key, labelKey]) => (
                      <th
                        key={key}
                        scope="col"
                        className={memberSort?.key === key ? 'sorted' : undefined}
                        aria-sort={memberSort?.key === key ? (memberSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                      >
                        <button
                          type="button"
                          className="th-sort"
                          onClick={() =>
                            toggleSort<MemberSortKey>(
                              key,
                              memberSort,
                              (next) => {
                                if (next !== null) setMemberSort(next);
                              },
                              { key: 'total', dir: 'desc' },
                            )
                          }
                        >
                          {t(lang, labelKey)}
                          {memberSort?.key === key ? (memberSort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedMembers.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="dr-empty">
                        {t(lang, 'jira.tab.noMembers')}
                      </td>
                    </tr>
                  ) : null}
                  {sortedMembers.map((stats: MemberTicketStats) => (
                    <tr key={stats.memberId}>
                      <td>{stats.memberName}</td>
                      <td>{stats.team}</td>
                      <td className="num">{formatInteger(stats.total, lang)}</td>
                      <td className="num">{formatInteger(stats.open, lang)}</td>
                      <td className="num">{formatInteger(stats.inProgress, lang)}</td>
                      <td className="num">{formatInteger(stats.done, lang)}</td>
                      <td className="num">
                        {stats.resolvedRate === null ? '—' : `${formatNumber(stats.resolvedRate * 100, 1, lang)}%`}
                      </td>
                      <td>{formatIsoDay(stats.lastActivity)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ---- JIRA reporters not on the team (SV-only linking) ---- */}
          <section className="dr-section">
            <h2>{t(lang, 'jira.tab.unmatchedTitle')}</h2>
            {analysis.unmatchedReporters.length === 0 ? (
              <p className="dr-empty">{t(lang, 'jira.tab.noUnmatched')}</p>
            ) : (
              <div className="table-wrap overall-scroll">
                <table className="overall-table">
                  <thead>
                    <tr>
                      <th scope="col">{t(lang, 'jira.tab.reporter')}</th>
                      <th scope="col" className="num">{t(lang, 'jira.tab.ticketCount')}</th>
                      {isSv ? <th scope="col">{t(lang, 'jira.tab.linkToMember')}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.unmatchedReporters.map((reporter) => (
                      <tr key={reporter.reporterName || '—'}>
                        <td>{reporter.reporterName === '' ? '—' : reporter.reporterName}</td>
                        <td className="num">{formatInteger(reporter.count, lang)}</td>
                        {isSv ? (
                          <td>
                            <select
                              className="table-input"
                              aria-label={t(lang, 'jira.tab.linkToMember')}
                              value=""
                              onChange={(e) => handleLinkReporter(reporter.reporterName, e.target.value)}
                            >
                              <option value="">{t(lang, 'jira.tab.linkMemberPlaceholder')}</option>
                              {memberOptions.map((option) => (
                                <option key={option.memberId} value={option.memberId}>
                                  {memberOptionText.get(option.memberId) ?? option.label}
                                </option>
                              ))}
                            </select>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ---- ticket list + export ---- */}
          <section className="dr-section">
            <h2>{t(lang, 'jira.tab.ticketListTitle')}</h2>
            <div className="dr-button-row">
              <button type="button" className="btn" disabled={!canExport} onClick={handleExportCsv}>
                {t(lang, 'buttons.exportCsv')}
              </button>
              <button type="button" className="btn" disabled={!canExport} onClick={handleExportXlsx}>
                {t(lang, 'buttons.exportXlsx')}
              </button>
              {!canExport ? <span className="dr-summary">{t(lang, 'jira.tab.noResultsExport')}</span> : null}
              {isSv ? (
                <>
                  <button
                    type="button"
                    className="btn"
                    disabled={importDisabled}
                    aria-expanded={importOpen}
                    onClick={() => setImportOpen((prev) => !prev)}
                  >
                    {t(lang, 'jira.importTickets.title')}
                  </button>
                  {importDisabled ? <span className="dr-summary">{t(lang, 'jira.importTickets.reasonFetch')}</span> : null}
                </>
              ) : null}
            </div>
            <div className="table-wrap overall-scroll">
              <table className="overall-table">
                <thead>
                  <tr>
                    {(
                      [
                        ['issueKey', 'jira.tab.key'],
                        ['summary', 'jira.tab.summary'],
                        ['statusName', 'columns.status'],
                        ['typeName', 'jira.tab.type'],
                        ['reporterName', 'jira.tab.reporter'],
                        ['updated', 'overall.updated'],
                      ] as [TicketSortKey, TranslationKey][]
                    ).map(([key, labelKey]) => (
                      <th
                        key={key}
                        scope="col"
                        className={ticketSort?.key === key ? 'sorted' : undefined}
                        aria-sort={ticketSort?.key === key ? (ticketSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                      >
                        <button type="button" className="th-sort" onClick={() => toggleSort<TicketSortKey>(key, ticketSort, setTicketSort, null)}>
                          {t(lang, labelKey)}
                          {ticketSort?.key === key ? (ticketSort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedTickets.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="dr-empty">
                        {t(lang, 'jira.tab.noTickets')}
                      </td>
                    </tr>
                  ) : null}
                  {sortedTickets.map((ticket: TicketRow) => (
                    <tr key={ticket.issueKey}>
                      <td>{ticket.issueKey}</td>
                      <td>{ticket.summary}</td>
                      <td>
                        <span className={`plan-status-tag tag-${STATUS_TONE[ticket.statusCategory]}`}>{ticket.statusName}</span>
                      </td>
                      <td>{ticket.typeName}</td>
                      <td>
                        {ticket.memberName ?? ticket.reporterName}
                        {ticket.memberName === undefined ? (
                          <>
                            {' '}
                            <span className="plan-status-tag tag-default">{t(lang, 'jira.tab.reporterUnmatched')}</span>
                          </>
                        ) : null}
                      </td>
                      <td>{formatIsoDay(ticket.updated)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {analysis.totals.fetched >= SEARCH_MAX_TOTAL ? <p className="dr-summary">{t(lang, 'jira.tab.fetchCapNote')}</p> : null}
          </section>
        </>
      ) : null}

      {!firstRun && analysis === null && !loading ? (
        <p className="dr-summary">{t(lang, 'jira.tab.fetchHint')}</p>
      ) : null}

      {/* ---- Import to Tickets (SV only): routing preview → confirm → per-project feedback ---- */}
      {isSv && importOpen ? (
        <JiraImportTickets
          lang={lang}
          issues={issues ?? EMPTY_ISSUES}
          projects={projects}
          cycles={reportsApi.state.cycles}
          reporterMemberByIssueKey={reporterMemberByIssueKey}
          baseUrl={reportsApi.state.settings.jira?.baseUrl ?? ''}
          today={today}
          onClose={() => setImportOpen(false)}
          canWrite={() => guard.guardWrite()}
          onCommit={handleCommitImportedTickets}
          onImported={handleImportedTickets}
        />
      ) : null}

      {/* ---- project mapping (SV only, collapsible) ---- */}
      {isSv ? (
        <CollapsibleSection title={t(lang, 'jira.tab.mappingTitle')} defaultOpen={mappedProjects.length === 0}>
          <p className="dr-summary">{t(lang, 'jira.tab.mappingHelp')}</p>
          {projects.length === 0 ? (
            <p className="dr-empty">{t(lang, 'jira.tab.mappingNoProjects')}</p>
          ) : (
            <div className="input-grid">
              {projects.map((project) => (
                <Field
                  key={project.id}
                  label={`${t(lang, 'jira.tab.projectKey')} — ${resolveBilingualName(lang, { nameEn: project.nameEn, nameJa: project.nameJa }) || project.projectId}`}
                  error={draftInvalid(project.id) ? t(lang, 'jira.tab.projectKeyInvalid') : undefined}
                >
                  <input
                    className={`input${draftInvalid(project.id) ? ' table-input-invalid' : ''}`}
                    type="text"
                    value={draftOf(project.id)}
                    placeholder={t(lang, 'jira.tab.projectKeyPlaceholder')}
                    aria-invalid={draftInvalid(project.id)}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [project.id]: e.target.value }))}
                    onBlur={() => handleKeyBlur(project.id)}
                  />
                </Field>
              ))}
            </div>
          )}
        </CollapsibleSection>
      ) : null}
    </div>
  );
}