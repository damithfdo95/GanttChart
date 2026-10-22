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
  type TicketAnalysis,
} from '../../domain/jira';
import { JiraImportTickets } from './JiraImportTickets';
import { jiraIssuesFromCsv } from '../../domain/jira/csvImport';
import { CsvFileButton } from '../../components/CsvFileButton';
import { ticketAnalysisSheet } from '../../lib/export/exportData';
import { buildXlsx } from '../../lib/export/xlsx';
import { toCsv, csvValueFromCell } from '../../lib/export/csv';
import { downloadBinaryFile, downloadTextFile, fileStamp } from '../../lib/export/download';
import { formatDate, todayEpochDays } from '../../lib/dates/dates';
import { formatInteger } from '../../lib/formatting/format';
import { personOptions, selectableMembers } from '../../domain/teamMembers';
import { XLSX_MIME } from '../../lib/statusKeys';
import type { SortState } from '../../lib/sortState';
import { MemberStatsTable, TicketListTable, UnmatchedReportersTable, type MemberSortKey, type TicketSortKey } from './JiraTables';

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

type MemberSortState = SortState<MemberSortKey>;
type TicketSortState = SortState<TicketSortKey>;
/**
 * JIRA tab 窶・"which tester reported how many bug tickets, and where do those
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
  // "Import to Tickets" confirmation step (SV only) 窶・open while the routing preview is shown.
  const [importOpen, setImportOpen] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Transient action feedback (links, exports) auto-clears (Overall precedent).
  useEffect(() => {
    if (message === null) return;
    const timer = window.setTimeout(() => setMessage(null), 6000);
    return () => window.clearTimeout(timer);
  }, [message]);

  // ---- data derivations (memoized 窶・no recalculation on row interactions) ----

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

  /** The exact query the Fetch button will run 窶・also shown for transparency. */
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

  const analysis = useMemo<TicketAnalysis | null>(
    () => (issues === null ? null : analyzeTickets(issues, members, externalIdentities)),
    [issues, members, externalIdentities],
  );

  // Reuse the analysis matching: issue key 竊・the canonical reporter member
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

  /**
   * CSV import: a JIRA CSV export (or this tab's own CSV export) becomes
   * the SAME `JiraIssue[]` a live fetch produces, so every downstream view
   * (analysis, linking, Import to Tickets, exports) works unchanged. The
   * filters above are NOT applied — the file's rows are the data.
   */
  const handleImportCsv = (text: string, fileName: string): void => {
    const imported = jiraIssuesFromCsv(text);
    if (imported.issues.length === 0 && imported.errors.length > 0) {
      setMessage({ kind: 'error', text: t(lang, 'jira.tab.csvFailed', { file: fileName }) });
      return;
    }
    setIssues(imported.issues);
    setFetchedJql(null); // the shown rows are from a file, not the current JQL
    const parts = [t(lang, 'jira.tab.csvLoaded', { file: fileName, count: imported.issues.length })];
    if (imported.errors.length > 0) parts.push(t(lang, 'jira.tab.csvRowErrors', { count: imported.errors.length }));
    setMessage({ kind: imported.errors.length > 0 ? 'error' : 'ok', text: parts.join(' ') });
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

  const projectName = (project: (typeof projects)[number]): string => {
    const name = resolveBilingualName(lang, { nameEn: project.nameEn, nameJa: project.nameJa });
    return name === '' ? project.projectId : `${name} (${project.jiraProjectKey ?? project.projectId})`;
  };

  // ---- the not-configured guard (normally unreachable 窶・the tab is hidden) ----

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
          <CsvFileButton label={t(lang, 'jira.tab.importCsv')} onText={handleImportCsv} />
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
          <MemberStatsTable
            lang={lang}
            sortedMembers={sortedMembers}
            memberSort={memberSort}
            setMemberSort={(next) => {
              if (next !== null) setMemberSort(next);
            }}
          />

          {/* ---- JIRA reporters not on the team (SV-only linking) ---- */}
          <UnmatchedReportersTable
            lang={lang}
            unmatchedReporters={analysis.unmatchedReporters}
            isSv={isSv}
            memberOptions={memberOptions}
            onLinkReporter={handleLinkReporter}
          />

          {/* ---- ticket list + export ---- */}
          <TicketListTable
            lang={lang}
            sortedTickets={sortedTickets}
            ticketSort={ticketSort}
            setTicketSort={setTicketSort}
            canExport={canExport}
            isSv={isSv}
            importDisabled={importDisabled}
            importOpen={importOpen}
            onExportCsv={handleExportCsv}
            onExportXlsx={handleExportXlsx}
            onToggleImport={() => setImportOpen((prev) => !prev)}
            fetchCapped={analysis.totals.fetched >= SEARCH_MAX_TOTAL}
          />
        </>
      ) : null}

      {!firstRun && analysis === null && !loading ? (
        <p className="dr-summary">{t(lang, 'jira.tab.fetchHint')}</p>
      ) : null}

      {/* ---- Import to Tickets (SV only): routing preview 竊・confirm 竊・per-project feedback ---- */}
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
                  label={`${t(lang, 'jira.tab.projectKey')} 窶・${resolveBilingualName(lang, { nameEn: project.nameEn, nameJa: project.nameJa }) || project.projectId}`}
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
