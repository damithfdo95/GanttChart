import { useMemo, useState } from 'react';
import type {
  AttendanceRecord,
  ExternalIdentity,
  IdentityAuditEntry,
  Language,
  ProjectRecord,
  RcsMember,
  TesterProjectAssignment,
  TesterReview,
} from '../../types';
import { t, type TranslationKey } from '../../i18n';
import {
  buildIdentityAuditEntry,
  collectIdentityIssues,
  resolveAttendanceRecord,
  resolveBugTicket,
  type AttendanceIdentityIssue,
  type IdentityIssueCandidate,
  type IdentitySuggestion,
  type TicketIdentityIssue,
} from '../../domain/identityResolution';
import {
  validateAttributionIntegrity,
  type AttributionEntityType,
  type AttributionIssueType,
} from '../../domain/attribution';

interface IdentityResolutionCenterProps {
  lang: Language;
  attendance: readonly AttendanceRecord[];
  projects: readonly ProjectRecord[];
  members: readonly RcsMember[];
  /** V6.9-B: workspace-wide attribution scope for integrity validation. */
  testerAssignments?: readonly TesterProjectAssignment[];
  reviews?: readonly TesterReview[];
  externalIdentities?: readonly ExternalIdentity[];
  /** Patch one attendance record (existing reports-state action). */
  onUpdateAttendance: (id: string, patch: Partial<AttendanceRecord>) => void;
  /** Replace one project's bug-ticket array (routes the active project through the app state). */
  onSetProjectTickets: (projectRecordId: string, tickets: import('../../types').BugTicket[]) => void;
  /** Append identity-resolution audit entries (V6.9-B §29). */
  onAppendAudit: (entries: IdentityAuditEntry[]) => void;
}

function candidateLabel(candidate: IdentityIssueCandidate, lang: Language): string {
  return `${candidate.memberId} — ${candidate.name} — ${candidate.role}${
    candidate.active ? '' : ` (${t(lang, 'members.inactive')})`
  }`;
}

/** Why a candidate/suggestion matches: current name, or history valid on the record date (§26). */
function suggestionReasonKey(suggestion: IdentitySuggestion): TranslationKey {
  if (suggestion.matchType === 'current') return 'identityResolution.reasonCurrentName';
  return suggestion.dateMatch === 'valid'
    ? 'identityResolution.reasonHistoryValid'
    : 'identityResolution.reasonHistoryUnrestricted';
}

/** Date-aware match information for a candidate row (§8/§26). */
function candidateMatchInfo(candidate: IdentityIssueCandidate, lang: Language): string {
  if (candidate.matchType === 'current') return t(lang, 'identityResolution.matchCurrentName');
  return candidate.dateMatch === 'valid'
    ? t(lang, 'identityResolution.matchHistoryValid')
    : candidate.dateMatch === 'outsideRange'
      ? t(lang, 'identityResolution.matchOutsideRange')
      : t(lang, 'identityResolution.matchHistoryUnrestricted');
}

const ISSUE_TYPE_KEY: Record<AttributionIssueType, TranslationKey> = {
  missing: 'attribution.issue.missing',
  invalid: 'attribution.issue.invalid',
  ambiguous: 'attribution.issue.ambiguous',
  conflict: 'attribution.issue.conflict',
  orphaned: 'attribution.issue.orphaned',
};

const ENTITY_KEY: Record<AttributionEntityType, TranslationKey> = {
  attendance: 'identityResolution.attendance',
  execution: 'attribution.entity.execution',
  bug: 'identityResolution.ticket',
  report: 'attribution.entity.report',
  member: 'attribution.entity.member',
  externalIdentity: 'attribution.entity.externalIdentity',
};

/**
 * Concise attribution data-quality indicator (V6.9-B §9): counts per issue
 * type and an expandable list. Technical audit details (messages, internal
 * ids) stay out of the normal view — only the entity, its record id and the
 * issue classification are shown.
 */
function AttributionQualityPanel({
  lang,
  issues,
  counts,
}: {
  lang: Language;
  issues: ReturnType<typeof validateAttributionIntegrity>['issues'];
  counts: ReturnType<typeof validateAttributionIntegrity>['counts'];
}) {
  const [expanded, setExpanded] = useState(false);
  const total = issues.length;
  if (total === 0) {
    return <p className="dr-empty">{t(lang, 'attribution.noIssues')}</p>;
  }
  return (
    <>
      <div className="identity-bulk-bar">
        <span className="dr-summary">
          {t(lang, 'attribution.issueCount', { count: total })}
          {(Object.keys(ISSUE_TYPE_KEY) as AttributionIssueType[])
            .filter((issueType) => counts[issueType] > 0)
            .map((issueType) => ` · ${t(lang, ISSUE_TYPE_KEY[issueType])}: ${counts[issueType]}`)
            .join('')}
        </span>
        <button type="button" className="btn" onClick={() => setExpanded((prev) => !prev)}>
          {expanded ? t(lang, 'buttons.close') : t(lang, 'attribution.showIssues', { count: total })}
        </button>
      </div>
      {expanded ? (
        <ul className="identity-resolved-list attribution-issue-list">
          {issues.map((issue) => (
            <li key={`${issue.entityType}-${issue.entityId}-${issue.issueType}`}>
              {t(lang, ENTITY_KEY[issue.entityType])} — {issue.entityId} · {t(lang, ISSUE_TYPE_KEY[issue.issueType])}
              {issue.originalValue !== undefined ? ` (${issue.originalValue})` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/**
 * Identity Resolution Center (V6.9-A §23/§24, V6.9-B §26–§29): the
 * administrative view for legacy attendance rows and bug tickets whose
 * recorded name could not be confidently matched to one member.
 *
 * Every issue shows its recorded name, the current identity state, the
 * suggested member WITH the reason (date-aware match information), and the
 * full candidate list. Bulk resolution applies ONLY explicitly selected
 * unique suggestions after an explicit confirmation (§27/§28); ambiguous
 * records always stay unresolved unless individually resolved. Every manual
 * or bulk decision appends an immutable audit entry (§29).
 *
 * V6.9-B: a concise attribution data-quality panel (§9) reports workspace
 * integrity issues (invalid/orphaned references, unresolvable records,
 * name conflicts, conflicting external identities) — reported, never
 * silently repaired.
 */
export function IdentityResolutionCenter({
  lang,
  attendance,
  projects,
  members,
  testerAssignments,
  reviews,
  externalIdentities,
  onUpdateAttendance,
  onSetProjectTickets,
  onAppendAudit,
}: IdentityResolutionCenterProps) {
  const [expanded, setExpanded] = useState(false);
  const issues = useMemo(() => collectIdentityIssues(attendance, projects, members), [attendance, projects, members]);
  const integrity = useMemo(
    () =>
      validateAttributionIntegrity({
        members,
        attendance,
        projects,
        assignments: testerAssignments,
        reviews,
        externalIdentities,
      }),
    [members, attendance, projects, testerAssignments, reviews, externalIdentities],
  );
  const openCount = issues.attendance.length + issues.tickets.length;
  // Explicit per-record bulk selection (only records with a unique suggestion).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Selection for records without a suggestion: one explicitly chosen member.
  const [manualSelection, setManualSelection] = useState<Record<string, string>>({});

  const toggleSelected = (key: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const resolveAttendance = (issue: AttendanceIdentityIssue, targetMemberId: string | undefined): void => {
    const record = attendance.find((row) => row.id === issue.recordId);
    if (record === undefined) return;
    const timestamp = new Date().toISOString();
    const resolved = resolveAttendanceRecord(record, targetMemberId, timestamp);
    onUpdateAttendance(record.id, resolved);
    onAppendAudit([
      buildIdentityAuditEntry({
        recordType: 'attendance',
        recordId: record.id,
        recordDate: record.date,
        recordedName: record.memberName,
        previousState: issue.kind,
        ...(targetMemberId !== undefined ? { resolvedMemberId: targetMemberId } : {}),
        method: 'manual',
        source: 'identityCenter',
        timestamp,
      }),
    ]);
  };

  const resolveTicket = (issue: TicketIdentityIssue, targetMemberId: string | undefined): void => {
    const project = projects.find((p) => p.projectId === issue.projectId);
    const ticket = project?.inputs.bugTickets?.find((row) => row.id === issue.ticketId);
    if (project === undefined || ticket === undefined) return;
    const timestamp = new Date().toISOString();
    const resolved = resolveBugTicket(ticket, targetMemberId, timestamp);
    onSetProjectTickets(
      project.id,
      (project.inputs.bugTickets ?? []).map((row) => (row.id === resolved.id ? resolved : row)),
    );
    onAppendAudit([
      buildIdentityAuditEntry({
        recordType: 'bugTicket',
        recordId: ticket.id,
        recordDate: ticket.createdAt,
        recordedName: ticket.reportedBy,
        previousState: issue.kind,
        ...(targetMemberId !== undefined ? { resolvedMemberId: targetMemberId } : {}),
        method: 'manual',
        source: 'identityCenter',
        timestamp,
      }),
    ]);
  };

  /** Bulk-confirm the explicitly SELECTED unique suggestions only (§27/§28). */
  const handleBulkResolve = (): void => {
    const selectedAttendance = issues.attendance.filter(
      (issue) => issue.suggestion !== undefined && selected.has(`att-${issue.recordId}`),
    );
    const selectedTickets = issues.tickets.filter(
      (issue) => issue.suggestion !== undefined && selected.has(`tick-${issue.ticketId}`),
    );
    const total = selectedAttendance.length + selectedTickets.length;
    if (total === 0) return;
    const ambiguousCount =
      issues.attendance.filter((issue) => issue.kind === 'ambiguous' && issue.suggestion === undefined).length +
      issues.tickets.filter((issue) => issue.kind === 'ambiguous' && issue.suggestion === undefined).length;
    if (
      !window.confirm(
        t(lang, 'identityResolution.confirmBulk', {
          selected: total,
          ambiguous: ambiguousCount,
        }),
      )
    ) {
      return;
    }
    const timestamp = new Date().toISOString();
    const auditEntries: IdentityAuditEntry[] = [];
    for (const issue of selectedAttendance) {
      const record = attendance.find((row) => row.id === issue.recordId);
      const memberId = issue.suggestion!.memberId;
      if (record === undefined) continue;
      onUpdateAttendance(record.id, resolveAttendanceRecord(record, memberId, timestamp));
      auditEntries.push(
        buildIdentityAuditEntry({
          recordType: 'attendance',
          recordId: record.id,
          recordDate: record.date,
          recordedName: record.memberName,
          previousState: issue.kind,
          resolvedMemberId: memberId,
          method: 'bulk',
          source: 'bulkResolution',
          timestamp,
        }),
      );
    }
    for (const issue of selectedTickets) {
      const project = projects.find((p) => p.projectId === issue.projectId);
      const ticket = project?.inputs.bugTickets?.find((row) => row.id === issue.ticketId);
      const memberId = issue.suggestion!.memberId;
      if (project === undefined || ticket === undefined) continue;
      const resolved = resolveBugTicket(ticket, memberId, timestamp);
      onSetProjectTickets(
        project.id,
        (project.inputs.bugTickets ?? []).map((row) => (row.id === resolved.id ? resolved : row)),
      );
      auditEntries.push(
        buildIdentityAuditEntry({
          recordType: 'bugTicket',
          recordId: ticket.id,
          recordDate: ticket.createdAt,
          recordedName: ticket.reportedBy,
          previousState: issue.kind,
          resolvedMemberId: memberId,
          method: 'bulk',
          source: 'bulkResolution',
          timestamp,
        }),
      );
    }
    onAppendAudit(auditEntries);
    setSelected(new Set());
  };

  if (openCount === 0 && issues.resolvedAttendance.length === 0 && issues.resolvedTickets.length === 0 && integrity.issues.length === 0) {
    return null; // nothing to resolve, no decisions recorded, no integrity issues — stay hidden
  }

  const kindKey: Record<'unmatched' | 'ambiguous', TranslationKey> = {
    unmatched: 'identityResolution.unmatched',
    ambiguous: 'identityResolution.ambiguous',
  };

  const withSuggestions =
    issues.attendance.filter((issue) => issue.suggestion !== undefined).length +
    issues.tickets.filter((issue) => issue.suggestion !== undefined).length;
  const ambiguousWithoutSuggestion =
    issues.attendance.filter((issue) => issue.suggestion === undefined && issue.kind === 'ambiguous').length +
    issues.tickets.filter((issue) => issue.suggestion === undefined && issue.kind === 'ambiguous').length;
  const selectedCount = issues.attendance.filter((i) => selected.has(`att-${i.recordId}`)).length +
    issues.tickets.filter((i) => selected.has(`tick-${i.ticketId}`)).length;

  return (
    <section className="dr-section">
      <h2>{t(lang, 'identityResolution.title')}</h2>
      <p className="dr-summary">{t(lang, 'identityResolution.description')}</p>
      <div className="dr-button-row">
        <button type="button" className="btn" onClick={() => setExpanded((prev) => !prev)}>
          {expanded ? t(lang, 'buttons.close') : t(lang, 'identityResolution.open', { count: openCount })}
        </button>
      </div>
      {expanded ? (
        <>
          {issues.attendance.length === 0 && issues.tickets.length === 0 ? (
            <p className="dr-empty">{t(lang, 'identityResolution.noIssues')}</p>
          ) : null}

          {/* Bulk bar (§27/§28): counts + explicit confirmation. */}
          {withSuggestions > 0 ? (
            <div className="identity-bulk-bar">
              <span className="dr-summary">
                {t(lang, 'identityResolution.bulkSummary', {
                  selected: selectedCount,
                  suggested: withSuggestions,
                  ambiguous: ambiguousWithoutSuggestion,
                })}
              </span>
              <button
                type="button"
                className="btn"
                disabled={selectedCount === 0}
                onClick={handleBulkResolve}
              >
                {t(lang, 'identityResolution.confirmBulkButton', { count: selectedCount })}
              </button>
            </div>
          ) : null}

          {issues.attendance.map((issue) => (
            <div key={`att-${issue.recordId}`} className={`identity-issue ${issue.kind}`}>
              <div className="identity-issue-head">
                <span className="identity-issue-kind">{t(lang, kindKey[issue.kind])}</span>
                <strong>
                  {t(lang, 'identityResolution.attendance')} — {issue.date}
                </strong>
                <span>
                  {t(lang, 'identityResolution.recordedName')}: {issue.recordedName}
                </span>
              </div>
              {issue.suggestion !== undefined ? (
                <div className="identity-suggestion">
                  <strong>
                    {t(lang, 'identityResolution.suggested')}:{' '}
                    {issue.suggestion.memberId} — {issue.suggestion.name}
                  </strong>
                  <div className="attendance-identity-hint">
                    {t(lang, suggestionReasonKey(issue.suggestion), {
                      name: issue.suggestion.matchedName,
                      date: issue.date,
                    })}
                  </div>
                </div>
              ) : null}
              {issue.candidates.length > (issue.suggestion !== undefined ? 1 : 0) ? (
                <ul className="identity-candidate-list">
                  {issue.candidates.map((candidate) => (
                    <li key={candidate.memberId}>
                      {candidateLabel(candidate, lang)}
                      <span className="attendance-identity-hint"> · {candidateMatchInfo(candidate, lang)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="identity-issue-actions">
                <label className="dr-toolbar-check identity-bulk-check">
                  <input
                    type="checkbox"
                    checked={selected.has(`att-${issue.recordId}`)}
                    disabled={issue.suggestion === undefined}
                    onChange={() => toggleSelected(`att-${issue.recordId}`)}
                  />
                  {t(lang, 'identityResolution.selectForBulk')}
                </label>
              </div>
              <div className="identity-issue-actions">
                {issue.suggestion !== undefined ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => resolveAttendance(issue, issue.suggestion!.memberId)}
                  >
                    {t(lang, 'identityResolution.resolveTo')} {issue.suggestion.memberId} — {issue.suggestion.name}
                  </button>
                ) : null}
                <select
                  className="input"
                  aria-label={t(lang, 'identityResolution.resolveTo')}
                  value={manualSelection[issue.recordId] ?? ''}
                  onChange={(e) => setManualSelection((prev) => ({ ...prev, [issue.recordId]: e.target.value }))}
                >
                  <option value="">{t(lang, 'identityResolution.selectMember')}</option>
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.id} — {member.name} ({member.role})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn"
                  disabled={(manualSelection[issue.recordId] ?? '') === ''}
                  onClick={() => resolveAttendance(issue, manualSelection[issue.recordId] ?? undefined)}
                >
                  {t(lang, 'identityResolution.resolveTo')}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => resolveAttendance(issue, undefined)}>
                  {t(lang, 'identityResolution.keepUnresolved')}
                </button>
              </div>
            </div>
          ))}

          {issues.tickets.map((issue) => (
            <div key={`tick-${issue.ticketId}`} className={`identity-issue ${issue.kind}`}>
              <div className="identity-issue-head">
                <span className="identity-issue-kind">{t(lang, kindKey[issue.kind])}</span>
                <strong>
                  {t(lang, 'identityResolution.ticket')} — {issue.title} ({issue.createdAt})
                </strong>
                <span>
                  {t(lang, 'identityResolution.recordedName')}: {issue.recordedName}
                </span>
              </div>
              {issue.suggestion !== undefined ? (
                <div className="identity-suggestion">
                  <strong>
                    {t(lang, 'identityResolution.suggested')}:{' '}
                    {issue.suggestion.memberId} — {issue.suggestion.name}
                  </strong>
                  <div className="attendance-identity-hint">
                    {t(lang, suggestionReasonKey(issue.suggestion), {
                      name: issue.suggestion.matchedName,
                      date: issue.createdAt,
                    })}
                  </div>
                </div>
              ) : null}
              {issue.candidates.length > (issue.suggestion !== undefined ? 1 : 0) ? (
                <ul className="identity-candidate-list">
                  {issue.candidates.map((candidate) => (
                    <li key={candidate.memberId}>
                      {candidateLabel(candidate, lang)}
                      <span className="attendance-identity-hint"> · {candidateMatchInfo(candidate, lang)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="identity-issue-actions">
                <label className="dr-toolbar-check identity-bulk-check">
                  <input
                    type="checkbox"
                    checked={selected.has(`tick-${issue.ticketId}`)}
                    disabled={issue.suggestion === undefined}
                    onChange={() => toggleSelected(`tick-${issue.ticketId}`)}
                  />
                  {t(lang, 'identityResolution.selectForBulk')}
                </label>
              </div>
              <div className="identity-issue-actions">
                {issue.suggestion !== undefined ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => resolveTicket(issue, issue.suggestion!.memberId)}
                  >
                    {t(lang, 'identityResolution.resolveTo')} {issue.suggestion.memberId} — {issue.suggestion.name}
                  </button>
                ) : null}
                <select
                  className="input"
                  aria-label={t(lang, 'identityResolution.resolveTo')}
                  value={manualSelection[issue.ticketId] ?? ''}
                  onChange={(e) => setManualSelection((prev) => ({ ...prev, [issue.ticketId]: e.target.value }))}
                >
                  <option value="">{t(lang, 'identityResolution.selectMember')}</option>
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.id} — {member.name} ({member.role})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn"
                  disabled={(manualSelection[issue.ticketId] ?? '') === ''}
                  onClick={() => resolveTicket(issue, manualSelection[issue.ticketId] ?? undefined)}
                >
                  {t(lang, 'identityResolution.resolveTo')}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => resolveTicket(issue, undefined)}>
                  {t(lang, 'identityResolution.keepUnresolved')}
                </button>
              </div>
            </div>
          ))}

          {issues.resolvedAttendance.length > 0 || issues.resolvedTickets.length > 0 ? (
            <div className="identity-resolved">
              <h3>{t(lang, 'identityResolution.resolved')}</h3>
              <ul className="identity-resolved-list">
                {issues.resolvedAttendance.map((entry) => (
                  <li key={`ra-${entry.recordId}`}>
                    {t(lang, 'identityResolution.attendance')} — {entry.date} — {entry.recordedName} →{' '}
                    {entry.audit.memberId !== undefined
                      ? `${entry.audit.memberId} (${t(lang, 'identityResolution.manuallyResolved')})`
                      : t(lang, 'identityResolution.keptUnresolved')}
                    <span className="gantt-project-meta"> · {entry.audit.resolvedAt}</span>
                  </li>
                ))}
                {issues.resolvedTickets.map((entry) => (
                  <li key={`rt-${entry.ticketId}`}>
                    {t(lang, 'identityResolution.ticket')} — {entry.title} — {entry.recordedName} →{' '}
                    {entry.audit.memberId !== undefined
                      ? `${entry.audit.memberId} (${t(lang, 'identityResolution.manuallyResolved')})`
                      : t(lang, 'identityResolution.keptUnresolved')}
                    <span className="gantt-project-meta"> · {entry.audit.resolvedAt}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}

      {/* V6.9-B §9: concise attribution data-quality indicator. */}
      <div className="identity-attribution-quality">
        <h3>{t(lang, 'attribution.qualityTitle')}</h3>
        <AttributionQualityPanel lang={lang} issues={integrity.issues} counts={integrity.counts} />
      </div>
    </section>
  );
}
