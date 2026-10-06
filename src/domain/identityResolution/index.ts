import type {
  AttendanceRecord,
  BugTicket,
  IdentityAuditEntry,
  ProjectRecord,
  RcsMember,
  TesterDailyPerformance,
  TesterProjectAssignment,
  TesterReview,
} from '../../types';
import { generateId } from '../../lib/id';
import {
  resolveMemberIdentityDetailed,
  resolveMemberIdentity,
  type IdentityDateMatch,
  type MemberIdentityCandidate,
} from '../members';

/**
 * V6.9-A/V6.9-B — Identity resolution domain: conservative migrations for
 * legacy name-based Attendance and BugTicket records, issue collection for
 * the Identity Resolution Center, and member reference detection.
 *
 * Principles (§12/§19/§26, V6.9-B §7/§36):
 * - Never guess: a record is auto-migrated only when its recorded name
 *   matches exactly one member (current name or a date-valid name-history
 *   entry) WITHOUT date narrowing changing the outcome. A match that is
 *   unique only after date narrowing is a SUGGESTION the supervisor must
 *   explicitly confirm.
 * - Never rewrite history: the original recorded name (memberName /
 *   reportedBy) is always preserved verbatim.
 * - Idempotent: records that already carry a member id, or that carry a
 *   manual resolution decision, are never touched again.
 *
 * All functions are pure — callers apply results through the existing
 * reports-state actions so persistence stays centralized.
 */

/** How the record's name evidence relates to the member master (V6.9-B §8). */
export interface IdentityIssueCandidate {
  memberId: string;
  /** The member's current display name. */
  name: string;
  /** The name that matched. */
  matchedName: string;
  matchType: 'current' | 'historical';
  dateMatch: IdentityDateMatch;
  team: string;
  role: string;
  active: boolean;
}

/** A unique member suggestion backed by evidence (V6.9-B §7/§26). */
export interface IdentitySuggestion {
  memberId: string;
  /** The member's current display name. */
  name: string;
  /** The name that matched. */
  matchedName: string;
  matchType: 'current' | 'historical';
  dateMatch: IdentityDateMatch;
}

// ---- Attendance identity migration (§12, V6.9-B date-aware) -----------------------

export interface AttendanceIdentityMigrationResult {
  attendance: AttendanceRecord[];
  /** Records confidently matched to exactly one member (memberId added). */
  resolved: AttendanceRecord[];
  /** Records whose name matches no member — preserved verbatim. */
  unmatched: AttendanceRecord[];
  /** Records whose name matches multiple members — flagged, never guessed. */
  ambiguous: AttendanceRecord[];
  /** Records with a unique DATE-NARROWED suggestion — kept for explicit confirmation (V6.9-B §7). */
  suggested: AttendanceRecord[];
}

/**
 * Migrate legacy name-based attendance records to memberId identity
 * (date-aware, V6.9-B):
 *
 * 1. memberId already set → untouched (idempotent).
 * 2. manual resolution recorded → untouched (a human decision is final).
 * 3. memberName resolves to exactly one member WITHOUT date narrowing
 *    (current name or a date-valid history entry) → memberId is added; the
 *    original memberName and every other field are preserved verbatim.
 * 4. unique only after date narrowing → preserved and flagged as a
 *    suggestion for explicit confirmation — never auto-applied.
 * 5. no in-range match → preserved unchanged (no member is invented).
 * 6. multiple in-range matches → preserved unchanged and flagged.
 */
export function migrateAttendanceIdentity(
  attendance: readonly AttendanceRecord[],
  members: readonly RcsMember[],
): AttendanceIdentityMigrationResult {
  const resolved: AttendanceRecord[] = [];
  const unmatched: AttendanceRecord[] = [];
  const ambiguous: AttendanceRecord[] = [];
  const suggested: AttendanceRecord[] = [];
  const next = attendance.map((record) => {
    if (record.memberId !== undefined && record.memberId !== '') return record;
    if (record.identityResolution !== undefined) return record;
    const legacyName = record.memberName.trim();
    if (legacyName === '') return record;
    const detailed = resolveMemberIdentityDetailed(legacyName, members, record.date);
    if (detailed.status === 'resolved') {
      const migrated: AttendanceRecord = { ...record, memberId: detailed.memberId };
      resolved.push(migrated);
      return migrated;
    }
    if (detailed.status === 'suggested') suggested.push(record);
    else if (detailed.status === 'unmatched') unmatched.push(record);
    else ambiguous.push(record);
    return record;
  });
  return { attendance: next, resolved, unmatched, ambiguous, suggested };
}

// ---- Bug ticket identity migration (§19, V6.9-B date-aware) --------------------------

export interface BugTicketIdentityMigrationResult {
  tickets: BugTicket[];
  /** Tickets confidently matched to exactly one reporter member. */
  resolved: BugTicket[];
  /** Tickets whose reporter matches no member — preserved verbatim. */
  unmatched: BugTicket[];
  /** Tickets whose reporter matches multiple members — flagged, never guessed. */
  ambiguous: BugTicket[];
  /** Tickets with a unique DATE-NARROWED suggestion — kept for explicit confirmation (V6.9-B §7). */
  suggested: BugTicket[];
}

/**
 * Migrate legacy reporter-name-based tickets to reporterMemberId identity
 * (date-aware: the ticket's createdAt narrows historical-name candidates).
 * Same conservative rules as migrateAttendanceIdentity; reportedBy keeps
 * the originally recorded reporter name (external reporters stay external).
 */
export function migrateBugTicketIdentity(
  tickets: readonly BugTicket[],
  members: readonly RcsMember[],
): BugTicketIdentityMigrationResult {
  const resolved: BugTicket[] = [];
  const unmatched: BugTicket[] = [];
  const ambiguous: BugTicket[] = [];
  const suggested: BugTicket[] = [];
  const next = tickets.map((ticket) => {
    if (ticket.reporterMemberId !== undefined && ticket.reporterMemberId !== '') return ticket;
    if (ticket.identityResolution !== undefined) return ticket;
    const legacyName = ticket.reportedBy.trim();
    if (legacyName === '') return ticket;
    const detailed = resolveMemberIdentityDetailed(legacyName, members, ticket.createdAt);
    if (detailed.status === 'resolved') {
      const migrated: BugTicket = { ...ticket, reporterMemberId: detailed.memberId };
      resolved.push(migrated);
      return migrated;
    }
    if (detailed.status === 'suggested') suggested.push(ticket);
    else if (detailed.status === 'unmatched') unmatched.push(ticket);
    else ambiguous.push(ticket);
    return ticket;
  });
  return { tickets: next, resolved, unmatched, ambiguous, suggested };
}

/** Apply the ticket identity migration across every project's inputs. */
export function migrateProjectBugTickets(
  projects: readonly ProjectRecord[],
  members: readonly RcsMember[],
): { projects: ProjectRecord[]; migration: BugTicketIdentityMigrationResult } {
  let migration: BugTicketIdentityMigrationResult = { tickets: [], resolved: [], unmatched: [], ambiguous: [], suggested: [] };
  const next = projects.map((project) => {
    const tickets = project.inputs.bugTickets ?? [];
    if (tickets.length === 0) return project;
    const result = migrateBugTicketIdentity(tickets, members);
    migration = {
      tickets: [...migration.tickets, ...result.tickets],
      resolved: [...migration.resolved, ...result.resolved],
      unmatched: [...migration.unmatched, ...result.unmatched],
      ambiguous: [...migration.ambiguous, ...result.ambiguous],
      suggested: [...migration.suggested, ...result.suggested],
    };
    return { ...project, inputs: { ...project.inputs, bugTickets: result.tickets } };
  });
  return { projects: next, migration };
}

// ---- Identity Resolution Center data (§23/§24, V6.9-B §26–§28) ---------------------

/** One actionable legacy record whose identity needs a human decision. */
// export type { IdentityIssueCandidate };

export type IdentityIssueKind = 'unmatched' | 'ambiguous';

export interface AttendanceIdentityIssue {
  kind: IdentityIssueKind;
  recordId: string;
  date: string;
  /** The original recorded name — historical truth. */
  recordedName: string;
  /** Candidate members (in-range first, out-of-range kept as evidence; never auto-chosen). */
  candidates: IdentityIssueCandidate[];
  /** Unique evidence-backed suggestion (unique by name, or unique after date narrowing). */
  suggestion?: IdentitySuggestion;
}

export interface TicketIdentityIssue {
  kind: IdentityIssueKind;
  ticketId: string;
  projectId: string;
  title: string;
  createdAt: string;
  /** The original recorded reporter name — historical truth. */
  recordedName: string;
  /** Candidate members (in-range first, out-of-range kept as evidence; never auto-chosen). */
  candidates: IdentityIssueCandidate[];
  /** Unique evidence-backed suggestion (unique by name, or unique after date narrowing). */
  suggestion?: IdentitySuggestion;
}

export interface IdentityIssues {
  /** Legacy attendance rows needing a decision (excluding kept-unresolved). */
  attendance: AttendanceIdentityIssue[];
  /** Legacy tickets needing a decision (excluding kept-unresolved). */
  tickets: TicketIdentityIssue[];
  /** Attendance rows manually resolved (audit present), most recent first. */
  resolvedAttendance: { recordId: string; date: string; recordedName: string; audit: NonNullable<AttendanceRecord['identityResolution']> }[];
  /** Tickets manually resolved (audit present), most recent first. */
  resolvedTickets: { ticketId: string; title: string; recordedName: string; audit: NonNullable<BugTicket['identityResolution']> }[];
}

function candidateOf(member: RcsMember, candidate: MemberIdentityCandidate): IdentityIssueCandidate {
  return {
    memberId: member.id,
    name: member.name,
    matchedName: candidate.matchedName,
    matchType: candidate.matchType,
    dateMatch: candidate.dateMatch,
    team: member.team,
    role: member.role,
    active: member.active,
  };
}

interface IssueEvidence {
  kind: IdentityIssueKind;
  candidates: IdentityIssueCandidate[];
  suggestion?: IdentitySuggestion;
}

/**
 * Shared date-aware evidence for one recorded name (V6.9-B §8): the
 * candidate list keeps out-of-range matches as displayable evidence, and a
 * suggestion is attached when exactly one member is supported (unique by
 * name, or unique only after date narrowing — both require explicit
 * confirmation in the center).
 */
function evidenceFor(
  name: string,
  members: readonly RcsMember[],
  recordDate: string | undefined,
): IssueEvidence | null {
  const trimmed = name.trim();
  if (trimmed === '') return null;
  const detailed = resolveMemberIdentityDetailed(trimmed, members, recordDate);
  const memberById = new Map(members.map((member) => [member.id, member]));
  const candidates = detailed.candidates.map((candidate) => {
    const member = memberById.get(candidate.memberId);
    return member !== undefined ? candidateOf(member, candidate) : null;
  });
  const filtered = candidates.filter((candidate): candidate is IdentityIssueCandidate => candidate !== null);
  if (detailed.status === 'unmatched') {
    return { kind: 'unmatched', candidates: filtered };
  }
  if (detailed.status === 'ambiguous') {
    return { kind: 'ambiguous', candidates: filtered };
  }
  // resolved or suggested: exactly one member is supported by the evidence.
  const unique = filtered.find((candidate) => candidate.memberId === detailed.memberId);
  return {
    kind: detailed.status === 'suggested' ? 'ambiguous' : 'unmatched',
    candidates: filtered,
    suggestion: unique,
  };
}

/**
 * Collect every actionable legacy identity issue for the Identity Resolution
 * Center. Records carrying a manual resolution decision (including
 * deliberately kept-unresolved) never reappear — a human decision is final.
 */
export function collectIdentityIssues(
  attendance: readonly AttendanceRecord[],
  projects: readonly ProjectRecord[],
  members: readonly RcsMember[],
): IdentityIssues {
  const attendanceIssues: AttendanceIdentityIssue[] = [];
  const resolvedAttendance: IdentityIssues['resolvedAttendance'] = [];
  for (const record of attendance) {
    // Manual decisions are reported in the resolved list — even when the
    // decision set a memberId — so the audit stays visible.
    if (record.identityResolution !== undefined) {
      resolvedAttendance.push({
        recordId: record.id,
        date: record.date,
        recordedName: record.memberName,
        audit: record.identityResolution,
      });
      continue;
    }
    if (record.memberId !== undefined && record.memberId !== '') continue;
    const evidence = evidenceFor(record.memberName, members, record.date);
    if (evidence === null) continue;
    attendanceIssues.push({
      kind: evidence.kind,
      recordId: record.id,
      date: record.date,
      recordedName: record.memberName,
      candidates: evidence.candidates,
      ...(evidence.suggestion !== undefined ? { suggestion: evidence.suggestion } : {}),
    });
  }

  const ticketIssues: TicketIdentityIssue[] = [];
  const resolvedTickets: IdentityIssues['resolvedTickets'] = [];
  for (const project of projects) {
    for (const ticket of project.inputs.bugTickets ?? []) {
      // Manual decisions are reported in the resolved list — even when the
      // decision set a reporterMemberId — so the audit stays visible.
      if (ticket.identityResolution !== undefined) {
        resolvedTickets.push({ ticketId: ticket.id, title: ticket.title, recordedName: ticket.reportedBy, audit: ticket.identityResolution });
        continue;
      }
      if (ticket.reporterMemberId !== undefined && ticket.reporterMemberId !== '') continue;
      const evidence = evidenceFor(ticket.reportedBy, members, ticket.createdAt);
      if (evidence === null) continue;
      ticketIssues.push({
        kind: evidence.kind,
        ticketId: ticket.id,
        projectId: ticket.projectId,
        title: ticket.title,
        createdAt: ticket.createdAt,
        recordedName: ticket.reportedBy,
        candidates: evidence.candidates,
        ...(evidence.suggestion !== undefined ? { suggestion: evidence.suggestion } : {}),
      });
    }
  }

  return {
    attendance: attendanceIssues.sort((a, b) => a.date.localeCompare(b.date) || a.recordedName.localeCompare(b.recordedName)),
    tickets: ticketIssues.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.title.localeCompare(b.title)),
    resolvedAttendance: resolvedAttendance.sort((a, b) => b.audit.resolvedAt.localeCompare(a.audit.resolvedAt)),
    resolvedTickets: resolvedTickets.sort((a, b) => b.audit.resolvedAt.localeCompare(a.audit.resolvedAt)),
  };
}

// ---- Manual resolution application (§24–§26) ----------------------------------------

/** Build the audit for a manual resolution to a member (§25). */
export function manualResolutionTo(memberId: string, resolvedAt: string): { method: 'manual'; memberId: string; resolvedAt: string } {
  return { method: 'manual', memberId, resolvedAt };
}

/** Build the audit for a deliberate "keep unresolved" decision (§24). */
export function manualResolutionKeepUnresolved(resolvedAt: string): { method: 'manual'; resolvedAt: string } {
  return { method: 'manual', resolvedAt };
}

/**
 * Apply a manual resolution to one attendance record (pure). The original
 * memberName is preserved; memberId + audit are set. Already-resolved or
 * already-decided records are returned unchanged (idempotent).
 */
export function resolveAttendanceRecord(
  record: AttendanceRecord,
  targetMemberId: string | undefined,
  resolvedAt: string,
): AttendanceRecord {
  if (record.memberId !== undefined && record.memberId !== '') return record;
  if (record.identityResolution !== undefined) return record;
  return {
    ...record,
    ...(targetMemberId !== undefined ? { memberId: targetMemberId } : {}),
    identityResolution: targetMemberId !== undefined ? manualResolutionTo(targetMemberId, resolvedAt) : manualResolutionKeepUnresolved(resolvedAt),
  };
}

/**
 * Apply a manual resolution to one bug ticket (pure). The original
 * reportedBy is preserved; reporterMemberId + audit are set. Already
 * resolved/decided tickets are returned unchanged (idempotent).
 */
export function resolveBugTicket(
  ticket: BugTicket,
  targetMemberId: string | undefined,
  resolvedAt: string,
): BugTicket {
  if (ticket.reporterMemberId !== undefined && ticket.reporterMemberId !== '') return ticket;
  if (ticket.identityResolution !== undefined) return ticket;
  return {
    ...ticket,
    ...(targetMemberId !== undefined ? { reporterMemberId: targetMemberId } : {}),
    identityResolution: targetMemberId !== undefined ? manualResolutionTo(targetMemberId, resolvedAt) : manualResolutionKeepUnresolved(resolvedAt),
  };
}

// ---- Identity resolution audit (V6.9-B §29) -----------------------------------------

/** Build one append-oriented audit entry for a manual or bulk resolution. */
export function buildIdentityAuditEntry(input: {
  recordType: 'attendance' | 'bugTicket';
  recordId: string;
  recordDate?: string;
  recordedName: string;
  previousState: 'unmatched' | 'ambiguous';
  resolvedMemberId?: string;
  method: 'manual' | 'bulk';
  source: 'identityCenter' | 'bulkResolution';
  timestamp: string;
}): IdentityAuditEntry {
  return {
    id: generateId(),
    timestamp: input.timestamp,
    recordType: input.recordType,
    recordId: input.recordId,
    ...(input.recordDate !== undefined && input.recordDate !== '' ? { recordDate: input.recordDate } : {}),
    recordedName: input.recordedName,
    previousState: input.previousState,
    ...(input.resolvedMemberId !== undefined && input.resolvedMemberId !== '' ? { resolvedMemberId: input.resolvedMemberId } : {}),
    method: input.method,
    source: input.source,
  };
}

/** Append entries to the audit log (append-only — never rewrites history). */
export function appendIdentityAuditEntries(
  log: readonly IdentityAuditEntry[] | undefined,
  entries: readonly IdentityAuditEntry[],
): IdentityAuditEntry[] {
  return [...(log ?? []), ...entries];
}

// ---- Identity state for exports/display (V6.9-B §34) --------------------------------

/** The confirmed identity state of an identity-bearing record. */
export type IdentityState = 'linked' | 'resolved' | 'ambiguous' | 'unmatched';

/** The identity state of an attendance record (date-aware, display only). */
export function attendanceIdentityState(record: AttendanceRecord, members: readonly RcsMember[]): IdentityState {
  if (record.memberId !== undefined && record.memberId !== '') return 'linked';
  const resolution = resolveMemberIdentity(record.memberName, members, record.date);
  return resolution.status;
}

/** The identity state of a bug ticket's reporter (date-aware, display only). */
export function ticketIdentityState(ticket: BugTicket, members: readonly RcsMember[]): IdentityState {
  if (ticket.reporterMemberId !== undefined && ticket.reporterMemberId !== '') return 'linked';
  const resolution = resolveMemberIdentity(ticket.reportedBy, members, ticket.createdAt);
  return resolution.status;
}

// ---- Member reference detection (§29) ----------------------------------------------

/** Every identity-bearing record type that can reference an RCS member. */
export interface MemberReferenceScope {
  attendance: readonly AttendanceRecord[];
  assignments: readonly TesterProjectAssignment[];
  tickets: readonly BugTicket[];
  performance: readonly TesterDailyPerformance[];
  reviews: readonly TesterReview[];
}

/**
 * True when any record references the member by its stable id. Used to
 * block physical deletion — historical identity is more important than
 * deletion, so referenced members should be deactivated instead.
 */
export function hasMemberReferences(memberId: string, scope: MemberReferenceScope): boolean {
  return (
    scope.attendance.some((record) => record.memberId === memberId) ||
    scope.assignments.some((assignment) => assignment.memberId === memberId) ||
    scope.tickets.some((ticket) => ticket.reporterMemberId === memberId) ||
    scope.performance.some((record) => record.memberId === memberId) ||
    scope.reviews.some((review) => review.memberId === memberId)
  );
}

/** Collect the workspace-wide reference scope from a ReportsState-shaped view. */
export function memberReferenceScope(input: {
  attendance: readonly AttendanceRecord[];
  testerAssignments?: readonly TesterProjectAssignment[];
  projects: readonly ProjectRecord[];
  reviews?: readonly TesterReview[];
}): MemberReferenceScope {
  return {
    attendance: input.attendance,
    assignments: input.testerAssignments ?? [],
    tickets: input.projects.flatMap((project) => project.inputs.bugTickets ?? []),
    performance: input.projects.flatMap((project) => project.inputs.testerDailyPerformance ?? []),
    reviews: input.reviews ?? [],
  };
}
