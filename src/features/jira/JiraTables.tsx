/**
 * JIRA tab tables: per-tester stats, unmatched reporters and the ticket list.
 * Extracted from JiraScreen.tsx so the screen file holds the data wiring only.
 */

import { t, type TranslationKey } from '../../i18n';
import { formatDateDisplay, parseDate } from '../../lib/dates/dates';
import { formatInteger, formatNumber } from '../../lib/formatting/format';
import { personOptionText, type PersonOption } from '../../domain/teamMembers';
import { toggleSort, type SortState } from '../../lib/sortState';
import type { MemberTicketStats, TicketRow } from '../../domain/jira';
import type { Language } from '../../types';

export type MemberSortKey = 'memberName' | 'team' | 'total' | 'open' | 'inProgress' | 'done' | 'resolvedRate' | 'lastActivity';
export type TicketSortKey = 'issueKey' | 'summary' | 'statusName' | 'typeName' | 'reporterName' | 'updated';

/** Status-category → the app's existing chip tone (text always carries the status). */
const STATUS_TONE: Record<TicketRow['statusCategory'], 'good' | 'bad' | 'default'> = {
  todo: 'default',
  inProgress: 'default',
  done: 'good',
};

/** Locale-aware date for an ISO timestamp (or a bare YYYY-MM-DD), '—' when absent. */
export function formatIsoDay(lang: Language, iso: string | null | undefined): string {
  if (iso === undefined || iso === null || iso === '') return '—';
  const epoch = parseDate(iso.slice(0, 10));
  return epoch === null ? iso.slice(0, 10) : formatDateDisplay(epoch, lang);
}

export function MemberStatsTable({
  lang,
  sortedMembers,
  memberSort,
  setMemberSort,
}: {
  lang: Language;
  sortedMembers: MemberTicketStats[];
  memberSort: SortState<MemberSortKey> | null;
  setMemberSort: (next: SortState<MemberSortKey> | null) => void;
}) {
  return (
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
                <td>{formatIsoDay(lang, stats.lastActivity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function UnmatchedReportersTable({
  lang,
  unmatchedReporters,
  isSv,
  memberOptions,
  onLinkReporter,
}: {
  lang: Language;
  unmatchedReporters: Array<{ reporterName: string; count: number }>;
  isSv: boolean;
  memberOptions: PersonOption[];
  onLinkReporter: (reporterName: string, memberId: string) => void;
}) {
  return (
    <section className="dr-section">
      <h2>{t(lang, 'jira.tab.unmatchedTitle')}</h2>
      {unmatchedReporters.length === 0 ? (
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
              {unmatchedReporters.map((reporter) => (
                <tr key={reporter.reporterName || '—'}>
                  <td>{reporter.reporterName === '' ? '—' : reporter.reporterName}</td>
                  <td className="num">{formatInteger(reporter.count, lang)}</td>
                  {isSv ? (
                    <td>
                      <select
                        className="table-input"
                        aria-label={t(lang, 'jira.tab.linkToMember')}
                        value=""
                        onChange={(e) => onLinkReporter(reporter.reporterName, e.target.value)}
                      >
                        <option value="">{t(lang, 'jira.tab.linkMemberPlaceholder')}</option>
                        {memberOptions.map((option) => (
                          <option key={option.memberId} value={option.memberId}>
                            {personOptionText(lang, option)}
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
  );
}

export function TicketListTable({
  lang,
  sortedTickets,
  ticketSort,
  setTicketSort,
  canExport,
  isSv,
  importDisabled,
  importOpen,
  onExportCsv,
  onExportXlsx,
  onToggleImport,
  fetchCapped,
}: {
  lang: Language;
  sortedTickets: TicketRow[];
  ticketSort: SortState<TicketSortKey> | null;
  setTicketSort: (next: SortState<TicketSortKey> | null) => void;
  canExport: boolean;
  isSv: boolean;
  importDisabled: boolean;
  importOpen: boolean;
  onExportCsv: () => void;
  onExportXlsx: () => void;
  onToggleImport: () => void;
  fetchCapped: boolean;
}) {
  return (
    <section className="dr-section">
      <h2>{t(lang, 'jira.tab.ticketListTitle')}</h2>
      <div className="dr-button-row">
        <button type="button" className="btn" disabled={!canExport} onClick={onExportCsv}>
          {t(lang, 'buttons.exportCsv')}
        </button>
        <button type="button" className="btn" disabled={!canExport} onClick={onExportXlsx}>
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
              onClick={onToggleImport}
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
                <td>{formatIsoDay(lang, ticket.updated)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {fetchCapped ? <p className="dr-summary">{t(lang, 'jira.tab.fetchCapNote')}</p> : null}
    </section>
  );
}
