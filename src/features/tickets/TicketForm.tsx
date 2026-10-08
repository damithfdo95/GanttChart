import { selectableMembers } from '../../domain/teamMembers';
import { businessDate } from '../../../shared/businessTime';
import type { BugSeverity, BugStatus, BugTicket, Language, RcsMember } from '../../types';
import { BUG_SEVERITIES, BUG_STATUSES } from '../../types';
import { t, type TranslationKey } from '../../i18n';
import { Field } from '../../components/Field';

/** Form values — plain strings so the user can type freely before validation. */
export interface TicketFormValues {
  ticketKey: string;
  title: string;
  url: string;
  createdAt: string;
  /** Stable RCS reporter identity (V6.9-A); '' = External / Unknown reporter. */
  reporterMemberId: string;
  reportedBy: string;
  severity: '' | BugSeverity;
  status: '' | BugStatus;
  memo: string;
}

export const EMPTY_TICKET_FORM: TicketFormValues = {
  ticketKey: '',
  title: '',
  url: '',
  createdAt: '',
  reporterMemberId: '',
  reportedBy: '',
  severity: '',
  status: '',
  memo: '',
};

export function ticketFormFromTicket(ticket: BugTicket): TicketFormValues {
  return {
    ticketKey: ticket.ticketKey ?? '',
    title: ticket.title,
    url: ticket.url,
    createdAt: ticket.createdAt,
    reporterMemberId: ticket.reporterMemberId ?? '',
    reportedBy: ticket.reportedBy,
    severity: ticket.severity ?? '',
    status: ticket.status ?? '',
    memo: ticket.memo ?? '',
  };
}

const SEVERITY_KEY: Record<BugSeverity, TranslationKey> = {
  Critical: 'severity.critical',
  Major: 'severity.major',
  Minor: 'severity.minor',
  Trivial: 'severity.trivial',
};

const STATUS_KEY: Record<BugStatus, TranslationKey> = {
  Open: 'bugStatus.open',
  'In Progress': 'bugStatus.inProgress',
  Resolved: 'bugStatus.resolved',
  Closed: 'bugStatus.closed',
  Rejected: 'bugStatus.rejected',
  Duplicate: 'bugStatus.duplicate',
};

export function bugSeverityLabel(lang: Language, severity: BugSeverity): string {
  return t(lang, SEVERITY_KEY[severity]);
}

export function bugStatusLabel(lang: Language, status: BugStatus): string {
  return t(lang, STATUS_KEY[status]);
}

interface TicketFormProps {
  lang: Language;
  values: TicketFormValues;
  errors: Partial<Record<keyof TicketFormValues, string>>;
  /** Known tester/member names for the external-reporter datalist (free text allowed). */
  memberNames: string[];
  /** A Tester raises tickets as themselves: the reporter cannot be chosen. */
  reporterLocked?: boolean;
  /** RCS member master (V6.9-A) — powers the reporter selector. */
  members?: RcsMember[];
  submitLabel: string;
  /** True when no active project exists — tickets cannot be filed anywhere. */
  disabled?: boolean;
  onChange: (patch: Partial<TicketFormValues>) => void;
  onSubmit: () => void;
  onCancel?: () => void;
}

/**
 * Add/Edit ticket form (V6.6 §9). Title, URL, created date and reporter are
 * required; severity/status/memo are optional.
 *
 * V6.9-A: the reporter is selected from the RCS Member Master (stable
 * reporterMemberId + display-name snapshot in reportedBy). "External /
 * Unknown" keeps the legacy free-text reporter — external reporters are
 * never forced into the member master and never falsely attributed.
 */
export function TicketForm({ lang, values, errors, memberNames, members = [], reporterLocked = false, submitLabel, disabled = false, onChange, onSubmit, onCancel }: TicketFormProps) {
  // A removed person is not offered for a new ticket, but the one already on this ticket stays selectable.
  const selectable = selectableMembers(members, { today: businessDate(), keep: [values.reporterMemberId] });
  const externalReporter = values.reporterMemberId === '';
  return (
    <form
      className="input-grid"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <Field label={t(lang, 'tickets.ticketKey')}>
        <input
          className="input"
          type="text"
          value={values.ticketKey}
          placeholder="ABC-123"
          onChange={(e) => onChange({ ticketKey: e.target.value })}
        />
      </Field>
      <Field label={t(lang, 'tickets.titleField')} error={errors.title}>
        <input
          className="input"
          type="text"
          value={values.title}
          onChange={(e) => onChange({ title: e.target.value })}
        />
      </Field>
      <Field label={t(lang, 'tickets.url')} error={errors.url}>
        <input
          className="input"
          type="url"
          value={values.url}
          placeholder="https://jira.example.com/browse/ABC-123"
          onChange={(e) => onChange({ url: e.target.value })}
        />
      </Field>
      <Field label={t(lang, 'tickets.createdDate')} error={errors.createdAt}>
        <input
          className="input"
          type="date"
          value={values.createdAt}
          onChange={(e) => onChange({ createdAt: e.target.value })}
        />
      </Field>
      <Field label={t(lang, 'tickets.reporter')} error={errors.reportedBy}>
        <select
          className="input"
          value={values.reporterMemberId}
          disabled={reporterLocked}
          onChange={(e) => {
            const memberId = e.target.value;
            if (memberId === '') {
              // External / Unknown reporter — legacy free text (never forced
              // into the member master, never falsely attributed).
              onChange({ reporterMemberId: '', reportedBy: '' });
              return;
            }
            const member = members.find((m) => m.id === memberId);
            // reportedBy snapshots the display name for history/compatibility.
            onChange({ reporterMemberId: memberId, reportedBy: member?.name ?? values.reportedBy });
          }}
        >
          <option value="">{t(lang, 'tickets.reporterExternal')}</option>
          {selectable.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
              {member.active ? '' : ` (${t(lang, 'members.inactive')})`}
            </option>
          ))}
          {/* Keep an edited record selectable when its reporter is not in the master. */}
          {values.reporterMemberId !== '' && !members.some((m) => m.id === values.reporterMemberId) ? (
            <option value={values.reporterMemberId}>{t(lang, 'people.former')}</option>
          ) : null}
        </select>
        {externalReporter ? (
          <input
            className="input reporter-external-input"
            type="text"
            list="ticket-reporter-options"
            disabled={reporterLocked && values.reporterMemberId !== ''}
            placeholder={t(lang, 'tickets.reporterExternalPlaceholder')}
            value={values.reportedBy}
            onChange={(e) => onChange({ reportedBy: e.target.value })}
          />
        ) : null}
        <datalist id="ticket-reporter-options">
          {memberNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </Field>
      <Field label={t(lang, 'tickets.severity')}>
        <select
          className="input"
          value={values.severity}
          onChange={(e) => onChange({ severity: e.target.value as '' | BugSeverity })}
        >
          <option value="">{t(lang, 'tickets.notSet')}</option>
          {BUG_SEVERITIES.map((severity) => (
            <option key={severity} value={severity}>
              {bugSeverityLabel(lang, severity)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t(lang, 'tickets.statusField')}>
        <select
          className="input"
          value={values.status}
          onChange={(e) => onChange({ status: e.target.value as '' | BugStatus })}
        >
          <option value="">{t(lang, 'tickets.notSet')}</option>
          {BUG_STATUSES.map((status) => (
            <option key={status} value={status}>
              {bugStatusLabel(lang, status)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t(lang, 'tickets.memo')}>
        <input
          className="input"
          type="text"
          value={values.memo}
          onChange={(e) => onChange({ memo: e.target.value })}
        />
      </Field>
      <div className="dr-button-row">
        {disabled ? <p className="dr-empty">{t(lang, 'tickets.noActiveProject')}</p> : null}
        <button type="submit" className="btn" disabled={disabled}>
          {submitLabel}
        </button>
        {onCancel !== undefined ? (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            {t(lang, 'buttons.close')}
          </button>
        ) : null}
      </div>
    </form>
  );
}
