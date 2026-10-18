import { useEffect, useMemo, useState } from 'react';
import type { JiraIssue } from '../../../shared/jira';
import { issueToBugTicket, mergeImportedTickets, routeIssuesToProjects } from '../../domain/jira';
import type { BugTicket, Cycle, Language, ProjectRecord } from '../../types';
import { resolveBilingualName, t, type TranslationKey } from '../../i18n';

/**
 * "Import to Tickets" (JIRA tab, SV only): a confirmation step that routes
 * the fetched tickets into the matching projects' Tickets lists. Nothing is
 * written before the person confirms — the routing preview shows every
 * would-be row, the unroutable tickets (with the reason) and the totals.
 * Committing mirrors the linking flow: `guardWrite` when the workspace is
 * shared, then one `updateProject` per target project carrying the merged
 * bugTickets (mergeImportedTickets — re-importing is idempotent and
 * refreshes statuses in place). All visual idioms are copied from
 * JiraScreen / JiraImportDialog; nothing is newly styled.
 */

/** Why one fetched issue cannot be routed (domain/jira ticketRouting reasons). */
type UnroutableReason = 'noProjectKey' | 'noVersionMatch' | 'ambiguous';

const UNROUTABLE_REASON_KEY: Record<UnroutableReason, TranslationKey> = {
  noProjectKey: 'jira.importTickets.reasonNoProjectKey',
  noVersionMatch: 'jira.importTickets.reasonNoVersionMatch',
  ambiguous: 'jira.importTickets.reasonAmbiguous',
};

/** One unroutable row of the routing preview. */
interface UnroutableRow {
  issue: JiraIssue;
  reason: UnroutableReason;
  candidates: string[];
}

/** What one import commit did to one project's ticket list. */
export interface ImportTicketResult {
  projectId: string;
  created: number;
  updated: number;
  unchanged: number;
}

interface JiraImportTicketsProps {
  lang: Language;
  /** The tickets currently fetched in the tab (empty = nothing to import yet). */
  issues: JiraIssue[];
  projects: ProjectRecord[];
  cycles: Cycle[] | undefined;
  /** issue key → resolved RCS member id (reused from the tab's ticket analysis). */
  reporterMemberByIssueKey: ReadonlyMap<string, string>;
  /** JIRA base URL from Settings ('' only when the feature is off, which hides the tab). */
  baseUrl: string;
  /** 'YYYY-MM-DD' — the merge anchor (today; re-import refreshes statuses). */
  today: string;
  /** Close the confirmation step (the tab's button in the export row toggles it). */
  onClose: () => void;
  /** Shared-mode write gate (guardWrite) — checked once before committing. */
  canWrite: () => boolean;
  /** Persist one project's merged bugTickets (updateProject — one commit per project). */
  onCommit: (projectId: string, bugTickets: BugTicket[]) => void;
  /** Transient tab-level feedback after a successful commit. */
  onImported: (summary: string) => void;
}

/**
 * The confirmation step of the JIRA tab's "Import to Tickets" flow: routing
 * preview (routed per project, unroutable with reasons, totals) → confirm →
 * per-project created/updated/unchanged feedback + guidance to the Tickets
 * tab. The commit itself is synchronous state updates (no network), so the
 * only failure modes are the read-only shared guard and a vanished project.
 */
export function JiraImportTickets({
  lang,
  issues,
  projects,
  cycles,
  reporterMemberByIssueKey,
  baseUrl,
  today,
  onClose,
  canWrite,
  onCommit,
  onImported,
}: JiraImportTicketsProps) {
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<ImportTicketResult[] | null>(null);

  // A refetch replaces the batch entirely — a stale result must never linger.
  useEffect(() => {
    setResult(null);
    setCommitting(false);
  }, [issues]);

  const routing = useMemo(
    () => (issues.length > 0 ? routeIssuesToProjects(issues, projects, cycles ?? []) : null),
    [issues, projects, cycles],
  );

  const cycleVersionOf = (project: ProjectRecord): string => {
    if (project.cycleId === undefined || project.cycleId === null) return '—';
    const cycle = (cycles ?? []).find((c) => c.id === project.cycleId);
    const version = cycle?.version?.trim() ?? '';
    return version === '' ? '—' : version;
  };

  const projectName = (project: ProjectRecord): string =>
    resolveBilingualName(lang, { nameEn: project.nameEn, nameJa: project.nameJa }) || project.projectId;

  /** The project's name for a result row (falls back to its code). */
  const projectLabel = (code: string): string => {
    const project = projects.find((p) => p.projectId === code);
    return project === undefined ? code : projectName(project);
  };

  const routedTicketCount = routing === null ? 0 : routing.routed.reduce((sum, entry) => sum + entry.issues.length, 0);

  const confirmImport = (): void => {
    if (routing === null || routing.routed.length === 0 || committing) return;
    if (!canWrite()) return;
    setCommitting(true);
    setResult(null);
    const outcomes: ImportTicketResult[] = [];
    let importedTickets = 0;
    let importedInto = 0;
    for (const entry of routing.routed) {
      const project = projects.find((p) => p.projectId === entry.projectId);
      if (project === undefined) continue; // the project vanished since the preview — nothing to import into
      const drafts = entry.issues.map((issue) =>
        issueToBugTicket(issue, entry.projectId, reporterMemberByIssueKey.get(issue.key), baseUrl),
      );
      const merged = mergeImportedTickets(project.inputs.bugTickets ?? [], drafts, today);
      onCommit(project.id, merged.next);
      outcomes.push({ projectId: entry.projectId, created: merged.created, updated: merged.updated, unchanged: merged.unchanged });
      importedTickets += merged.created;
      importedInto += 1;
    }
    setCommitting(false);
    setResult(outcomes);
    if (importedInto > 0) {
      onImported(t(lang, 'jira.importTickets.done', { tickets: importedTickets, projects: importedInto }));
    }
  };

  const reasonText = (row: UnroutableRow): string => {
    if (row.reason === 'noVersionMatch' || row.reason === 'ambiguous') {
      return t(lang, UNROUTABLE_REASON_KEY[row.reason], { candidates: row.candidates.join(', ') });
    }
    return t(lang, UNROUTABLE_REASON_KEY[row.reason]);
  };

  return (
    <section className="dr-section">
      <h2>{t(lang, 'jira.importTickets.previewTitle')}</h2>

      {routing === null ? (
        <p className="dr-empty" role="status">
          {t(lang, 'jira.importTickets.reasonFetch')}
        </p>
      ) : (
        <>
          <p className="dr-summary">{t(lang, 'jira.importTickets.hint')}</p>
          <p className="dr-summary">{t(lang, 'jira.importTickets.idempotent')}</p>

          <div className="table-wrap overall-scroll">
            <table className="overall-table">
              <thead>
                <tr>
                  <th scope="col">{t(lang, 'jira.importTickets.colProject')}</th>
                  <th scope="col">{t(lang, 'jira.importTickets.colKey')}</th>
                  <th scope="col">{t(lang, 'jira.importTickets.colCycle')}</th>
                  <th scope="col" className="num">{t(lang, 'jira.importTickets.colTickets')}</th>
                </tr>
              </thead>
              <tbody>
                {routing.routed.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="dr-empty">
                      {t(lang, 'jira.importTickets.noneRoutable')}
                    </td>
                  </tr>
                ) : null}
                {routing.routed.map((entry) => {
                  const project = projects.find((p) => p.projectId === entry.projectId);
                  return (
                    <tr key={entry.projectId}>
                      <td>{project !== undefined ? projectName(project) : entry.projectId}</td>
                      <td>{project?.jiraProjectKey ?? '—'}</td>
                      <td>{project !== undefined ? cycleVersionOf(project) : '—'}</td>
                      <td className="num">{entry.issues.length}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p role="status">
            {t(lang, 'jira.importTickets.totals', {
              tickets: routedTicketCount,
              projects: routing.routed.length,
              skipped: routing.unroutable.length,
            })}
          </p>

          {routing.unroutable.length > 0 ? (
            <>
              <h3>{t(lang, 'jira.importTickets.unroutableTitle')}</h3>
              <div className="table-wrap overall-scroll">
                <table className="overall-table">
                  <thead>
                    <tr>
                      <th scope="col">{t(lang, 'jira.tab.key')}</th>
                      <th scope="col">{t(lang, 'jira.tab.summary')}</th>
                      <th scope="col">{t(lang, 'jira.importTickets.colReason')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {routing.unroutable.map((row: UnroutableRow) => (
                      <tr key={row.issue.key}>
                        <td>{row.issue.key}</td>
                        <td>{row.issue.summary}</td>
                        <td>{reasonText(row)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="dr-summary">{t(lang, 'jira.importTickets.skippedNote')}</p>
            </>
          ) : null}

          <div className="dr-button-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={committing || routing.routed.length === 0}
              onClick={confirmImport}
            >
              {committing
                ? t(lang, 'jira.importTickets.committing')
                : t(lang, 'jira.importTickets.confirm', {
                    tickets: routedTicketCount,
                    projects: routing.routed.length,
                  })}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              {t(lang, 'tenancy.cancel')}
            </button>
          </div>

          {result !== null ? (
            <div role="status">
              <h3>{t(lang, 'jira.importTickets.resultTitle')}</h3>
              {result.map((r) => (
                <p key={r.projectId} className="dr-summary">
                  {t(lang, 'jira.importTickets.resultRow', {
                    project: projectLabel(r.projectId),
                    created: r.created,
                    updated: r.updated,
                    unchanged: r.unchanged,
                  })}
                </p>
              ))}
              <p className="dr-summary">{t(lang, 'jira.importTickets.openTickets')}</p>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}