import type { BugTicket, Language, RcsMember } from '../../types';
import { t } from '../../i18n';
import { bugSeverityLabel, bugStatusLabel } from './TicketForm';
import { findMemberById, resolveMemberIdentity } from '../../domain/members';
import { TablePager } from '../../components/TablePager';
import { usePagedRows } from '../../lib/pagination/usePagedRows';

interface TicketTableProps {
  lang: Language;
  tickets: BugTicket[];
  /** RCS member master (V6.9-A) — shows the stable reporter identity. */
  members?: RcsMember[];
  onEdit: (ticket: BugTicket) => void;
  onDelete: (ticket: BugTicket) => void;
  /** Which tickets this person may change or remove (a Tester: only their own). Default: all. */
  canChange?: (ticket: BugTicket) => boolean;
}

/**
 * Ticket list (V6.6 §10). The JIRA URL opens in a new browser tab; the
 * app itself never makes a network request. Sorted newest-first.
 *
 * V6.9-A: the reporter cell shows the recorded name plus the stable
 * identity when one is established (reporterMemberId or a unique
 * name/history resolution). The recorded name is never rewritten.
 */
export function TicketTable({ lang, tickets, members = [], onEdit, onDelete, canChange }: TicketTableProps) {
  const sorted = [...tickets].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || (b.ticketKey ?? '').localeCompare(a.ticketKey ?? '') || a.id.localeCompare(b.id),
  );
  // Tickets accumulate over the project's life (newest-first) — paginated.
  const pager = usePagedRows(sorted, 10);
  if (tickets.length === 0) {
    return <p className="dr-empty">{t(lang, 'tickets.noTickets')}</p>;
  }
  return (
    <>
      <div className="table-wrap">
        <table className="dr-table">
        <thead>
          <tr>
            <th scope="col">{t(lang, 'tickets.ticketKey')}</th>
            <th scope="col">{t(lang, 'tickets.titleField')}</th>
            <th scope="col">{t(lang, 'tickets.url')}</th>
            <th scope="col">{t(lang, 'tickets.createdDate')}</th>
            <th scope="col">{t(lang, 'tickets.reporter')}</th>
            <th scope="col">{t(lang, 'tickets.severity')}</th>
            <th scope="col">{t(lang, 'tickets.statusField')}</th>
            <th scope="col">{t(lang, 'columns.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {pager.pagedRows.map((ticket) => {
            const linkedMember =
              ticket.reporterMemberId !== undefined ? findMemberById(members, ticket.reporterMemberId) : undefined;
            const nameResolution =
              ticket.reporterMemberId === undefined ? resolveMemberIdentity(ticket.reportedBy, members) : null;
            return (
              <tr key={ticket.id}>
                <td>{ticket.ticketKey === undefined || ticket.ticketKey === '' ? '—' : ticket.ticketKey}</td>
                <td>{ticket.title}</td>
                <td>
                  {ticket.url === '' ? (
                    '—'
                  ) : (
                    <a href={ticket.url} target="_blank" rel="noopener noreferrer">
                      {t(lang, 'tickets.openJira')}
                    </a>
                  )}
                </td>
                <td>{ticket.createdAt}</td>
                <td>
                  {ticket.reportedBy}
                  {linkedMember !== undefined ? (
                    <div className="attendance-identity-hint">
                      {linkedMember.id} — {linkedMember.name}
                    </div>
                  ) : nameResolution !== null && nameResolution.status === 'resolved' ? (
                    <div className="attendance-identity-hint">
                      {t(lang, 'attendance.resolvedAs', {
                        id: nameResolution.memberId,
                        name: findMemberById(members, nameResolution.memberId)?.name ?? nameResolution.memberId,
                      })}
                    </div>
                  ) : null}
                </td>
                <td>{ticket.severity === undefined ? '—' : bugSeverityLabel(lang, ticket.severity)}</td>
                <td>{ticket.status === undefined ? '—' : bugStatusLabel(lang, ticket.status)}</td>
                <td className="dr-row-actions">
                  {canChange !== undefined && !canChange(ticket) ? null : (
                    <>
                      <button type="button" className="btn" onClick={() => onEdit(ticket)}>
                        {t(lang, 'tickets.editTicket')}
                      </button>
                      <button type="button" className="btn btn-danger" onClick={() => onDelete(ticket)}>
                        {t(lang, 'tickets.deleteTicket')}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        </table>
      </div>
      <TablePager lang={lang} pager={pager} />
    </>
  );
}
