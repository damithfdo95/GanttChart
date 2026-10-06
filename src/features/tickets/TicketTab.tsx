import { useMemo, useState } from 'react';
import type { BugTicket } from '../../types';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { t } from '../../i18n';
import { formatDate, todayEpochDays } from '../../lib/dates/dates';
import { resolveBilingualName } from '../../i18n';
import { projectDisplayName } from '../../domain/projects';
import {
  addBugTicket,
  createBugTicket,
  removeBugTicket,
  ticketSummary,
  updateBugTicket,
} from '../../domain/tickets';
import { findDuplicateTicket, validateBugTicket } from '../../lib/validation/validateTicket';
import { TicketSummaryCards } from './TicketSummary';
import { TicketForm, EMPTY_TICKET_FORM, ticketFormFromTicket, type TicketFormValues } from './TicketForm';
import { TicketTable } from './TicketTable';

/**
 * Tickets screen (V6.6): JIRA bug tickets for the ACTIVE project only.
 * Tickets live in the project's QaInputs (bugTickets) so persistence,
 * backup/restore and project isolation are all inherited from the existing
 * centralized architecture — there is no component-level storage here.
 */
export function TicketTab() {
  const app = useAppStateCtx();
  const reportsApi = useReportsStateCtx();
  const lang = app.state.language;

  const [form, setForm] = useState<TicketFormValues>(EMPTY_TICKET_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof TicketFormValues, string>>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const activeProject = reportsApi.state.projects.find((p) => p.id === reportsApi.state.activeProjectId);
  const activeProjectName =
    activeProject !== undefined
      ? projectDisplayName(activeProject, lang)
      : resolveBilingualName(lang, { nameEn: app.state.projectNameEn, nameJa: app.state.projectNameJa });

  const tickets: BugTicket[] = app.state.bugTickets ?? [];
  const today = formatDate(todayEpochDays());

  // Unique member names from the member master, attendance and existing
  // tickets — suggestions for the external-reporter free-text fallback.
  const memberNames = useMemo(() => {
    const names = new Set<string>();
    for (const member of reportsApi.state.rcsMembers ?? []) {
      const name = member.name.trim();
      if (name !== '') names.add(name);
    }
    for (const record of reportsApi.state.attendance) {
      const name = record.memberName.trim();
      if (name !== '') names.add(name);
    }
    for (const ticket of tickets) {
      const name = ticket.reportedBy.trim();
      if (name !== '') names.add(name);
    }
    return [...names].sort();
  }, [reportsApi.state.rcsMembers, reportsApi.state.attendance, tickets]);

  const summary = useMemo(() => ticketSummary(tickets, today), [tickets, today]);

  const setTickets = (next: BugTicket[]): void => {
    app.updateField('bugTickets', next);
  };

  const handleChange = (patch: Partial<TicketFormValues>): void => {
    setForm((prev) => ({ ...prev, ...patch }));
    setNotice(null);
  };

  const handleSubmit = (): void => {
    const candidate: BugTicket = {
      id: editingId ?? 'pending',
      projectId: activeProject?.projectId ?? '',
      ticketKey: form.ticketKey.trim() === '' ? undefined : form.ticketKey.trim(),
      title: form.title.trim(),
      url: form.url.trim(),
      createdAt: form.createdAt,
      // V6.9-A: stable reporter identity when an RCS member is selected;
      // reportedBy keeps the display-name snapshot (or the external text).
      reporterMemberId: form.reporterMemberId === '' ? undefined : form.reporterMemberId,
      reportedBy: form.reportedBy.trim(),
      severity: form.severity === '' ? undefined : form.severity,
      status: form.status === '' ? undefined : form.status,
      memo: form.memo.trim() === '' ? undefined : form.memo,
    };
    const validation = validateBugTicket(candidate);
    if (!validation.isValid) {
      const fieldErrors: Partial<Record<keyof TicketFormValues, string>> = {};
      for (const [field, key] of Object.entries(validation.errors)) {
        fieldErrors[field as keyof TicketFormValues] = t(lang, key!);
      }
      setErrors(fieldErrors);
      return;
    }
    setErrors({});
    const duplicate = findDuplicateTicket(tickets, candidate, editingId ?? undefined);
    if (duplicate !== undefined) {
      const label = duplicate.ticketKey ?? duplicate.title;
      setNotice(t(lang, 'tickets.duplicateWarning', { key: label }));
      return;
    }
    if (editingId === null) {
      setTickets(addBugTicket(tickets, createBugTicket(candidate.projectId, candidate)));
    } else {
      setTickets(updateBugTicket(tickets, editingId, candidate));
    }
    setForm(EMPTY_TICKET_FORM);
    setEditingId(null);
    setNotice(null);
  };

  const handleEdit = (ticket: BugTicket): void => {
    setEditingId(ticket.id);
    setForm(ticketFormFromTicket(ticket));
    setErrors({});
    setNotice(null);
  };

  const handleDelete = (ticket: BugTicket): void => {
    if (!window.confirm(t(lang, 'tickets.confirmDelete', { title: ticket.title }))) return;
    setTickets(removeBugTicket(tickets, ticket.id));
    if (editingId === ticket.id) {
      setEditingId(null);
      setForm(EMPTY_TICKET_FORM);
    }
  };

  const handleCancelEdit = (): void => {
    setEditingId(null);
    setForm(EMPTY_TICKET_FORM);
    setErrors({});
    setNotice(null);
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title-group">
          <h1>{t(lang, 'tickets.title')}</h1>
          {activeProjectName === '' ? null : <span className="app-project-name">{activeProjectName}</span>}
        </div>
      </header>

      <TicketSummaryCards lang={lang} summary={summary} />

      <section className="dr-section">
        <h2>{editingId === null ? t(lang, 'tickets.addTicket') : t(lang, 'tickets.editTicket')}</h2>
        {notice !== null ? <div className="dr-message" role="status">{notice}</div> : null}
        {activeProject === undefined ? (
          <div className="dr-message error" role="alert">
            {t(lang, 'tickets.noActiveProject')}
          </div>
        ) : null}
        <TicketForm
          lang={lang}
          values={form}
          errors={errors}
          memberNames={memberNames}
          members={reportsApi.state.rcsMembers ?? []}
          submitLabel={editingId === null ? t(lang, 'tickets.addTicket') : t(lang, 'tickets.editTicket')}
          disabled={activeProject === undefined}
          onChange={handleChange}
          onSubmit={handleSubmit}
          onCancel={editingId === null ? undefined : handleCancelEdit}
        />
      </section>

      <section className="dr-section">
        <h2>{t(lang, 'tickets.title')}</h2>
        <TicketTable
          lang={lang}
          tickets={tickets}
          members={reportsApi.state.rcsMembers ?? []}
          onEdit={handleEdit}
          onDelete={handleDelete}
        />
      </section>
    </div>
  );
}
