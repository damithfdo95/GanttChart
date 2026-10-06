import type {
  AttendanceRecord,
  AttributionConfidence,
  ExternalIdentity,
  IdentityAuditEntry,
  ProjectRecord,
  RcsMember,
  TesterProjectAssignment,
  TesterReview,
} from '../../types';
import { generateId } from '../../lib/id';
import { findMemberById, resolveMemberIdentityDetailed, type IdentityDateMatch } from '../members';
import { collectIdentityIssues } from '../identityResolution';

/**
 * V6.9-B — centralized attribution resolution and integrity.
 *
 * Every attribution-sensitive record (attendance, execution, bug tickets,
 * reviews, assignments) must resolve to the canonical internal memberId.
 * Names — current or historical — are display/history information and
 * lookup evidence, never the authoritative identity.
 *
 * The resolution flow (§3):
 *
 *   raw attribution (memberId / external identity / name + context date)
 *     → canonical memberId lookup
 *     → external identity lookup (future-ready, e.g. JIRA accounts)
 *     → historical-name lookup (date-aware, V6.9-A resolver)
 *     → Resolved / Ambiguous / Unresolved
 *
 * Critical rule: an identity is NEVER silently guessed. Multiple possible
 * members → AMBIGUOUS. No reliable match → UNRESOLVED. This module reuses
 * the V6.9-A identity resolver (resolveMemberIdentityDetailed) for every
 * name-based step — it does not duplicate it.
 *
 * All functions are pure: no clock (timestamps are passed in), no React,
 * no storage.
 */

/** How a raw attribution was resolved (§4, adapted to the V6.9-A model). */
export type AttributionMethod =
  | 'memberId'
  | 'externalId'
  | 'currentName'
  | 'historicalName'
  | 'context'
  | 'manual'
  | 'unresolved';

/** The raw attribution received from a record or external system (§3). */
export type AttributionInput =
  | { kind: 'memberId'; memberId: string }
  | { kind: 'externalId'; provider: string; externalId: string }
  | { kind: 'name'; name: string; /** Record date for date-aware history matching. */ contextDate?: string };

/** One member an attribution could refer to, with the matching evidence. */
export interface AttributionCandidate {
  memberId: string;
  /** The member's current display name. */
  name: string;
  /** The name that matched (current name or a historical alias). */
  matchedName: string;
  /** How the matched name relates to the record date (§26). */
  dateMatch: IdentityDateMatch;
}

/** The outcome of resolving one raw attribution. */
export type AttributionResolution =
  | {
      status: 'resolved';
      memberId: string;
      method: AttributionMethod;
      confidence: AttributionConfidence;
      candidates: AttributionCandidate[];
    }
  | {
      /** Multiple members are possible — one is never picked arbitrarily. */
      status: 'ambiguous';
      candidateMemberIds: string[];
      candidates: AttributionCandidate[];
    }
  | {
      /** No reliable match exists. */
      status: 'unresolved';
      originalValue: string;
      candidates: AttributionCandidate[];
    };

function candidateOf(member: RcsMember, matchedName: string, dateMatch: IdentityDateMatch): AttributionCandidate {
  return { memberId: member.id, name: member.name, matchedName, dateMatch };
}

/**
 * Resolve one raw attribution to the canonical memberId (§3). The flow is
 * deterministic: a direct memberId wins, then a UNIQUE ACTIVE external
 * identity mapping, then the date-aware V6.9-A name resolver. A unique
 * match only after date narrowing resolves with MEDIUM confidence — the
 * caller can require explicit confirmation before persisting it; nothing
 * is ever guessed silently.
 */
export function resolveAttribution(
  input: AttributionInput,
  members: readonly RcsMember[],
  externalIdentities: readonly ExternalIdentity[] = [],
): AttributionResolution {
  if (input.kind === 'memberId') {
    const member = findMemberById(members, input.memberId);
    if (member === undefined) {
      // A nonexistent memberId is an integrity problem (orphaned reference),
      // reported by validateAttributionIntegrity — here it simply does not
      // resolve. Nothing is invented.
      return {
        status: 'unresolved',
        originalValue: input.memberId,
        candidates: [],
      };
    }
    return {
      status: 'resolved',
      memberId: member.id,
      method: 'memberId',
      confidence: 'high',
      candidates: [candidateOf(member, member.name, 'unrestricted')],
    };
  }

  if (input.kind === 'externalId') {
    const memberIds = uniqueExternalIdentityMembers(externalIdentities, input.provider, input.externalId, members);
    if (memberIds.length === 1) {
      const member = findMemberById(members, memberIds[0])!;
      return {
        status: 'resolved',
        memberId: member.id,
        method: 'externalId',
        confidence: 'high',
        candidates: [candidateOf(member, member.name, 'unrestricted')],
      };
    }
    if (memberIds.length > 1) {
      // The same external account maps to several members — a conflict
      // (also flagged by validateAttributionIntegrity). Never pick one.
      return {
        status: 'ambiguous',
        candidateMemberIds: memberIds,
        candidates: memberIds.map((memberId) => {
          const member = findMemberById(members, memberId)!;
          return candidateOf(member, member.name, 'unrestricted');
        }),
      };
    }
    return {
      status: 'unresolved',
      originalValue: `${input.provider}:${input.externalId}`,
      candidates: [],
    };
  }

  // Name-based attribution — the V6.9-A resolver does all the work
  // (current name, date-valid name history, whitespace normalization,
  // case-sensitivity rules, never guessing on ambiguity).
  const detailed = resolveMemberIdentityDetailed(input.name, members, input.contextDate);
  const candidates = detailed.candidates.flatMap((candidate) => {
    const member = findMemberById(members, candidate.memberId);
    return member === undefined ? [] : [candidateOf(member, candidate.matchedName, candidate.dateMatch)];
  });
  if (detailed.status === 'resolved' || detailed.status === 'suggested') {
    return {
      status: 'resolved',
      memberId: detailed.memberId,
      method: detailed.matchedBy === 'currentName' ? 'currentName' : 'historicalName',
      // 'suggested' = unique only after date narrowing (V6.9-B §7) — a
      // deterministic but weaker match that callers may confirm explicitly.
      confidence: detailed.status === 'resolved' ? 'high' : 'medium',
      candidates,
    };
  }
  if (detailed.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      candidateMemberIds: detailed.candidateMemberIds,
      candidates,
    };
  }
  return {
    status: 'unresolved',
    originalValue: input.name.trim(),
    // Out-of-range matches are kept as evidence for display (§8).
    candidates,
  };
}

// ---- External identity mapping (§7 — data-model readiness, no APIs) ----------

/**
 * Build one external-identity link (pure; the caller appends it through
 * the reports state). The internal memberId stays the source of truth —
 * the link is a lookup aid for future external systems such as JIRA.
 */
export function buildExternalIdentityLink(input: {
  provider: string;
  externalId: string;
  memberId: string;
  displayName?: string;
  linkedAt: string;
}): ExternalIdentity {
  return {
    id: generateId(),
    provider: input.provider,
    externalId: input.externalId,
    memberId: input.memberId,
    ...(input.displayName !== undefined && input.displayName !== '' ? { displayName: input.displayName } : {}),
    active: true,
    linkedAt: input.linkedAt,
  };
}

/**
 * The memberIds an ACTIVE (provider, externalId) mapping resolves to,
 * restricted to members that actually exist. More than one entry means a
 * duplicated/conflicting mapping.
 */
export function uniqueExternalIdentityMembers(
  externalIdentities: readonly ExternalIdentity[],
  provider: string,
  externalId: string,
  members: readonly RcsMember[],
): string[] {
  const ids = new Set(
    externalIdentities
      .filter((identity) => identity.active && identity.provider === provider && identity.externalId === externalId)
      .map((identity) => identity.memberId)
      .filter((memberId) => findMemberById(members, memberId) !== undefined),
  );
  return [...ids].sort();
}

// ---- Attribution audit (§4 — reuses the V6.9-A audit entry) -------------------

/**
 * Build an append-oriented audit entry for one attribution resolution
 * (V6.9-B §4). Reuses the existing IdentityAuditEntry structure so all
 * decisions — manual, bulk AND automated — share one append-only log.
 * Use appendIdentityAuditEntries (V6.9-B §29) to append the result.
 */
export function buildAttributionAuditEntry(input: {
  recordType: IdentityAuditEntry['recordType'];
  recordId: string;
  recordDate?: string;
  /** The raw attribution value as received (name, external id, …). */
  recordedName: string;
  previousState: 'unmatched' | 'ambiguous';
  resolution: AttributionResolution;
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
    ...(input.resolution.status === 'resolved' ? { resolvedMemberId: input.resolution.memberId } : {}),
    method: input.resolution.status === 'resolved' ? input.resolution.method : 'unresolved',
    source: 'attributionResolution',
    confidence:
      input.resolution.status === 'resolved'
        ? input.resolution.confidence
        : input.resolution.status === 'ambiguous'
          ? 'ambiguous'
          : 'low',
  };
}

// ---- Attribution integrity validation (§5/§6) --------------------------------

/** Issue classification (§6). */
export type AttributionIssueType = 'missing' | 'invalid' | 'ambiguous' | 'conflict' | 'orphaned';

/** The entity an integrity issue belongs to (spec: attendance/execution/bug/report, extended). */
export type AttributionEntityType = 'attendance' | 'execution' | 'bug' | 'report' | 'member' | 'externalIdentity';

/** One attribution/data-integrity issue — structured, never auto-repaired (§6). */
export interface AttributionIssue {
  entityType: AttributionEntityType;
  entityId: string;
  issueType: AttributionIssueType;
  originalValue?: string;
  candidateMemberIds?: string[];
  /** Deterministic technical explanation for tooling — not user-facing copy. */
  message: string;
}

export interface AttributionIntegrityReport {
  /** Every detected issue, deterministically sorted (entity, id, type). */
  issues: AttributionIssue[];
  /** Issue counts per classification. */
  counts: Record<AttributionIssueType, number>;
}

/** The workspace-wide attribution scope to validate (§5). */
export interface AttributionIntegrityScope {
  members: readonly RcsMember[];
  attendance: readonly AttendanceRecord[];
  projects: readonly ProjectRecord[];
  assignments?: readonly TesterProjectAssignment[];
  reviews?: readonly TesterReview[];
  externalIdentities?: readonly ExternalIdentity[];
}

const EMPTY_COUNTS = (): Record<AttributionIssueType, number> => ({ missing: 0, invalid: 0, ambiguous: 0, conflict: 0, orphaned: 0 });

/**
 * Validate attribution integrity across the whole workspace (§5). Detects
 * invalid/orphaned member references, records with no resolvable identity,
 * ambiguous historical names, name collisions between members, and
 * conflicting/duplicated external-identity mappings. Issues are REPORTED —
 * records are never silently repaired or rewritten.
 *
 * Legacy name-based records are only flagged when their name cannot
 * resolve to exactly one member: a name that resolves deterministically
 * through the V6.9-A resolver is valid attribution data (the conservative
 * migration handles backfilling its memberId).
 */
export function validateAttributionIntegrity(scope: AttributionIntegrityScope): AttributionIntegrityReport {
  const issues: AttributionIssue[] = [];
  const memberIds = new Set(scope.members.map((member) => member.id));

  const checkReference = (entityType: AttributionEntityType, entityId: string, memberId: string | undefined, message: string): void => {
    if (memberId === undefined) return; // no id → name-based checks below
    if (memberId === '') {
      issues.push({ entityType, entityId, issueType: 'invalid', originalValue: memberId, message });
      return;
    }
    if (!memberIds.has(memberId)) {
      issues.push({ entityType, entityId, issueType: 'orphaned', originalValue: memberId, message });
    }
  };

  // --- Invalid / orphaned member references ---------------------------------
  for (const record of scope.attendance) {
    checkReference('attendance', record.id, record.memberId, `Attendance record references unknown member "${record.memberId}".`);
  }
  for (const assignment of scope.assignments ?? []) {
    checkReference('execution', assignment.id, assignment.memberId, `Assignment references unknown member "${assignment.memberId}".`);
  }
  for (const review of scope.reviews ?? []) {
    checkReference('report', review.id, review.memberId, `Review references unknown member "${review.memberId}".`);
  }
  for (const project of scope.projects) {
    for (const record of project.inputs.testerDailyPerformance ?? []) {
      checkReference('execution', record.id, record.memberId, `Execution record references unknown member "${record.memberId}".`);
    }
    for (const ticket of project.inputs.bugTickets ?? []) {
      checkReference('bug', ticket.id, ticket.reporterMemberId, `Bug reporter references unknown member "${ticket.reporterMemberId}".`);
    }
  }

  // --- Records whose identity can no longer be resolved (attendance + bugs
  // reuse the V6.9-A issue collection — no duplicated logic) ----------------
  const identityIssues = collectIdentityIssues(scope.attendance, scope.projects, scope.members);
  for (const issue of identityIssues.attendance) {
    issues.push({
      entityType: 'attendance',
      entityId: issue.recordId,
      issueType: issue.kind === 'ambiguous' ? 'ambiguous' : 'missing',
      originalValue: issue.recordedName,
      ...(issue.candidates.length > 0 ? { candidateMemberIds: issue.candidates.map((candidate) => candidate.memberId) } : {}),
      message: `Attendance record name "${issue.recordedName}" does not resolve to exactly one member.`,
    });
  }
  for (const issue of identityIssues.tickets) {
    issues.push({
      entityType: 'bug',
      entityId: issue.ticketId,
      issueType: issue.kind === 'ambiguous' ? 'ambiguous' : 'missing',
      originalValue: issue.recordedName,
      ...(issue.candidates.length > 0 ? { candidateMemberIds: issue.candidates.map((candidate) => candidate.memberId) } : {}),
      message: `Bug reporter name "${issue.recordedName}" does not resolve to exactly one member.`,
    });
  }

  // --- Execution / review records without a memberId whose name does not
  // resolve uniquely (the "missing memberId" check, §5). Attendance and
  // bug tickets are already covered by collectIdentityIssues above.
  const missingMemberId = (entityType: AttributionEntityType, entityId: string, name: string, contextDate: string | undefined, message: string): void => {
    const detailed = resolveMemberIdentityDetailed(name, scope.members, contextDate);
    if (detailed.status === 'ambiguous') {
      issues.push({
        entityType,
        entityId,
        issueType: 'ambiguous',
        originalValue: name,
        candidateMemberIds: detailed.candidateMemberIds,
        message,
      });
    } else if (detailed.status !== 'resolved' && detailed.status !== 'suggested') {
      issues.push({ entityType, entityId, issueType: 'missing', originalValue: name, message });
    }
  };
  for (const assignment of scope.assignments ?? []) {
    if (assignment.memberId !== undefined && assignment.memberId !== '') continue;
    const name = assignment.testerName ?? '';
    if (name === '') continue;
    missingMemberId('execution', assignment.id, name, assignment.startDate, `Assignment has no memberId and its tester name does not resolve uniquely.`);
  }
  for (const review of scope.reviews ?? []) {
    if (review.memberId !== undefined && review.memberId !== '') continue;
    missingMemberId('report', review.id, review.testerName, review.periodStart, `Review has no memberId and its tester name does not resolve uniquely.`);
  }
  for (const project of scope.projects) {
    for (const record of project.inputs.testerDailyPerformance ?? []) {
      if (record.memberId !== undefined && record.memberId !== '') continue;
      missingMemberId('execution', record.id, record.testerName, record.date, `Execution record has no memberId and its tester name does not resolve uniquely.`);
    }
  }

  // --- Historical conflicts: a name (current or historical) shared by
  // more than one member can never resolve reliably (§5) ----------------------
  const namesByMember = new Map<string, Set<string>>();
  for (const member of scope.members) {
    const offer = (name: string): void => {
      const trimmed = name.trim();
      if (trimmed === '') return;
      const owners = namesByMember.get(trimmed) ?? new Set<string>();
      owners.add(member.id);
      namesByMember.set(trimmed, owners);
    };
    offer(member.name);
    for (const entry of member.nameHistory ?? []) offer(entry.name);
  }
  for (const [name, owners] of namesByMember) {
    if (owners.size > 1) {
      issues.push({
        entityType: 'member',
        entityId: name,
        issueType: 'conflict',
        originalValue: name,
        candidateMemberIds: [...owners].sort(),
        message: `The name "${name}" is used by ${owners.size} members — records recorded under it can never resolve reliably.`,
      });
    }
  }

  // --- External identity consistency (§5) -------------------------------------
  const externalIdentities = scope.externalIdentities ?? [];
  for (const identity of externalIdentities) {
    if (!memberIds.has(identity.memberId)) {
      issues.push({
        entityType: 'externalIdentity',
        entityId: identity.id,
        issueType: 'orphaned',
        originalValue: `${identity.provider}:${identity.externalId}`,
        message: `External identity references unknown member "${identity.memberId}".`,
      });
    }
  }
  // Duplicated/conflicting mappings: the same provider+externalId mapped
  // to more than one distinct member.
  const byExternalKey = new Map<string, Set<string>>();
  for (const identity of externalIdentities) {
    if (!identity.active) continue;
    const key = `${identity.provider}\u0000${identity.externalId}`;
    const owners = byExternalKey.get(key) ?? new Set<string>();
    owners.add(identity.memberId);
    byExternalKey.set(key, owners);
  }
  for (const [key, owners] of byExternalKey) {
    if (owners.size > 1) {
      const [provider, externalId] = key.split('\u0000');
      issues.push({
        entityType: 'externalIdentity',
        entityId: `${provider}:${externalId}`,
        issueType: 'conflict',
        originalValue: `${provider}:${externalId}`,
        candidateMemberIds: [...owners].sort(),
        message: `External identity "${provider}:${externalId}" is mapped to ${owners.size} members.`,
      });
    }
  }

  issues.sort(
    (a, b) =>
      a.entityType.localeCompare(b.entityType) ||
      a.entityId.localeCompare(b.entityId) ||
      a.issueType.localeCompare(b.issueType),
  );
  const counts = EMPTY_COUNTS();
  for (const issue of issues) counts[issue.issueType] += 1;
  return { issues, counts };
}
