import type { JiraIssue } from '../../../shared/jira';
import type { ExternalIdentity, RcsMember } from '../../types';
import { activeMembers } from '../members';

/**
 * JIRA ticket analysis (pure domain — no UI, no i18n, no clock, no storage,
 * no network).
 *
 * Analyzes bug tickets fetched from JIRA against the workspace's Team
 * Members and resolves every ticket's reporter to a canonical member using
 * the V6.9-B attribution rules. Matching order matters:
 *
 *   1. an ACTIVE 'jira' ExternalIdentity whose `externalId` or `displayName`
 *      equals the reporter name (case-insensitive, whitespace-collapsed) and
 *      resolves to exactly one memberId — the same dedupe/existing-member
 *      semantics as `uniqueExternalIdentityMembers`, but case-insensitive
 *      per this feature's contract; then
 *   2. a unique name match against the member pool (case-insensitive,
 *      whitespace-collapsed — `findUniqueMemberByName` semantics).
 *
 * Identity matches always win over the name fallback. Ambiguous matches
 * (several members share an identity or a name) are NEVER guessed — the
 * ticket stays unmatched and its reporter is surfaced in
 * `unmatchedReporters`. A missing `reporterName` never crashes: it is
 * treated as an unmatched reporter named ''.
 */

// ---- JQL builder ------------------------------------------------------------

/** Filters for the JIRA ticket-analysis JQL query. */
export interface TicketJqlFilters {
  /** JIRA project keys (e.g. ['ABC','DEF']). Empty/undefined = all projects. */
  projectKeys?: string[];
  /** Issue type names; default ['Bug']. Empty array = all issue types. */
  issueTypes?: string[];
  /** Days back from today (JQL relative date). Default 30. Ignored when `from` is set. */
  days?: number;
  /** Inclusive lower bound, 'YYYY-MM-DD' (overrides `days`). */
  from?: string;
  /** Inclusive upper bound, 'YYYY-MM-DD'. */
  to?: string;
}

/** Uppercase, trim, remove inner spaces; '' when empty. */
export function normalizeJiraProjectKey(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

/** Valid JIRA project key: /^[A-Z][A-Z0-9]*$/ after normalization. */
export function isValidJiraProjectKey(key: string): boolean {
  return /^[A-Z][A-Z0-9]*$/.test(normalizeJiraProjectKey(key));
}

// JIRA field values that need no quoting (alphanumerics, underscore, dash).
const JQL_SAFE_TOKEN = /^[A-Za-z0-9_\-]+$/;

/** Quote a JQL value only when it needs it; embedded quotes are doubled (JQL escaping). */
function jqlToken(value: string): string {
  return JQL_SAFE_TOKEN.test(value) ? value : `"${value.replace(/"/g, '""')}"`;
}

/**
 * Builds a valid JQL string, e.g.
 * `project IN (ABC, DEF) AND issuetype IN (Bug) AND created >= -30d ORDER BY created DESC`.
 * Empty/whitespace project keys and issue types are dropped; empty issueTypes
 * means "all issue types" (no issuetype clause).
 */
export function buildTicketJql(filters: TicketJqlFilters): string {
  const clauses: string[] = [];

  const projectKeys = (filters.projectKeys ?? [])
    .map((key) => normalizeJiraProjectKey(key))
    .filter((key) => key !== '');
  if (projectKeys.length > 0) {
    clauses.push(`project IN (${projectKeys.map(jqlToken).join(', ')})`);
  }

  const issueTypes = (filters.issueTypes ?? ['Bug'])
    .map((type) => type.trim())
    .filter((type) => type !== '');
  if (issueTypes.length > 0) {
    clauses.push(`issuetype IN (${issueTypes.map(jqlToken).join(', ')})`);
  }

  if (filters.from !== undefined && filters.from !== '') {
    clauses.push(`created >= ${filters.from}`);
  } else {
    clauses.push(`created >= -${filters.days ?? 30}d`);
  }

  if (filters.to !== undefined && filters.to !== '') {
    clauses.push(`created <= ${filters.to}`);
  }

  return clauses.length > 0 ? `${clauses.join(' AND ')} ORDER BY created DESC` : 'ORDER BY created DESC';
}

// ---- Analysis ---------------------------------------------------------------

/** Per-member ticket statistics. */
export interface MemberTicketStats {
  memberId: string;
  memberName: string;
  team: string;
  /** tickets by this member */
  total: number;
  open: number; // statusCategory 'To Do' (or anything not In Progress/Done)
  inProgress: number; // statusCategory 'In Progress'
  done: number; // statusCategory 'Done'
  /** done / total, null when total === 0 (never NaN/Infinity) */
  resolvedRate: number | null;
  /** ISO 'updated' of the member's most recently updated ticket, undefined when total === 0 */
  lastActivity?: string;
}

/** One analyzed ticket row. */
export interface TicketRow {
  issueKey: string;
  summary: string;
  statusName: string;
  statusCategory: 'todo' | 'inProgress' | 'done';
  typeName: string;
  reporterName: string;
  memberId?: string; // present when the reporter matched a member
  memberName?: string;
  updated?: string;
}

/** Reporters that matched no member, grouped by name. */
export interface UnmatchedReporterRow {
  reporterName: string;
  count: number;
}

/** Result of analyzing one batch of fetched JIRA tickets. */
export interface TicketAnalysis {
  memberStats: MemberTicketStats[]; // sorted by total desc, then memberName asc
  tickets: TicketRow[]; // newest first (updated desc, then issueKey asc)
  unmatchedReporters: UnmatchedReporterRow[]; // reporters that matched NO active member, count desc, name asc
  totals: { fetched: number; matched: number; open: number; inProgress: number; done: number };
}

/** Name normalization used for ALL reporter matching: trim, collapse whitespace, lower case. */
function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 'In Progress' → inProgress, 'Done' → done, everything else (incl. missing) → todo. */
function statusCategoryOf(categoryName: string | undefined): TicketRow['statusCategory'] {
  switch (categoryName) {
    case 'In Progress':
      return 'inProgress';
    case 'Done':
      return 'done';
    default:
      return 'todo';
  }
}

/** A matched reporter: the resolved member. */
interface ReporterResolution {
  memberId: string;
  memberName: string;
}

/**
 * Resolve one reporter name to a member. Rule 1 (external identity) is tried
 * first and always wins; rule 2 (unique name) applies only when no identity
 * resolved — including when the identity step came back ambiguous (a shared
 * account is a data-integrity conflict, never guessed).
 */
function resolveReporterMember(
  reporterName: string,
  identities: readonly ExternalIdentity[],
  poolById: Map<string, RcsMember>,
  nameIndex: Map<string, string[]>,
): ReporterResolution | undefined {
  const normalized = normalizeName(reporterName);

  // Rule 1: ACTIVE 'jira' external identity by externalId or displayName
  // (case-insensitive, whitespace-collapsed). Restricted to members that
  // exist in the pool — the uniqueExternalIdentityMembers semantics.
  const identityMemberIds = new Set<string>();
  for (const identity of identities) {
    if (!identity.active || identity.provider !== 'jira') continue;
    if (!poolById.has(identity.memberId)) continue;
    const externalMatches = normalizeName(identity.externalId) === normalized;
    const displayMatches =
      identity.displayName !== undefined && identity.displayName !== '' && normalizeName(identity.displayName) === normalized;
    if (!externalMatches && !displayMatches) continue;
    identityMemberIds.add(identity.memberId);
  }
  if (identityMemberIds.size === 1) {
    const member = poolById.get([...identityMemberIds][0])!;
    return { memberId: member.id, memberName: member.name };
  }

  // Rule 2: unique name match among the pool (findUniqueMemberByName-style).
  const nameIds = nameIndex.get(normalized);
  if (nameIds !== undefined && nameIds.length === 1) {
    const member = poolById.get(nameIds[0])!;
    return { memberId: member.id, memberName: member.name };
  }
  return undefined;
}

/**
 * Analyze fetched JIRA tickets against the member master. Pure and
 * deterministic: same inputs → same output, inputs never mutated.
 *
 * `activeMembersOnly` (default true) restricts the matchable pool — and the
 * reported member stats — to active members. When false, inactive members
 * can match too (an inactive ExternalIdentity is still always ignored).
 */
export function analyzeTickets(
  issues: readonly JiraIssue[],
  members: readonly RcsMember[],
  identities: readonly ExternalIdentity[],
  options?: { activeMembersOnly?: boolean }, // default true
): TicketAnalysis {
  const activeMembersOnly = options?.activeMembersOnly ?? true;
  const pool = activeMembersOnly ? activeMembers(members) : [...members];
  const poolById = new Map(pool.map((member) => [member.id, member]));

  // Rule-2 index: normalized name → matching pool member ids (ambiguous when
  // more than one member shares a name).
  const nameIndex = new Map<string, string[]>();
  for (const member of pool) {
    const key = normalizeName(member.name);
    const ids = nameIndex.get(key) ?? [];
    ids.push(member.id);
    nameIndex.set(key, ids);
  }

  const tickets: TicketRow[] = issues.map((issue) => {
    const reporterName = (issue.reporterName ?? '').trim();
    const matched = resolveReporterMember(reporterName, identities, poolById, nameIndex);
    return {
      issueKey: issue.key,
      summary: issue.summary,
      statusName: issue.statusName ?? '',
      statusCategory: statusCategoryOf(issue.statusCategoryName),
      typeName: issue.typeName ?? '',
      reporterName,
      ...(matched !== undefined ? { memberId: matched.memberId, memberName: matched.memberName } : {}),
      ...(issue.updated !== undefined ? { updated: issue.updated } : {}),
    };
  });

  // Aggregate per-member counts (from matched tickets only) and totals over
  // the FULL fetched set (the status totals always sum to `fetched`).
  const perMember = new Map<
    string,
    { total: number; open: number; inProgress: number; done: number; lastUpdated: string }
  >();
  const totals = { fetched: issues.length, matched: 0, open: 0, inProgress: 0, done: 0 };
  for (const ticket of tickets) {
    if (ticket.statusCategory === 'inProgress') totals.inProgress += 1;
    else if (ticket.statusCategory === 'done') totals.done += 1;
    else totals.open += 1;
    if (ticket.memberId === undefined) continue;
    totals.matched += 1;
    const entry = perMember.get(ticket.memberId) ?? { total: 0, open: 0, inProgress: 0, done: 0, lastUpdated: '' };
    entry.total += 1;
    if (ticket.statusCategory === 'inProgress') entry.inProgress += 1;
    else if (ticket.statusCategory === 'done') entry.done += 1;
    else entry.open += 1;
    if (ticket.updated !== undefined && (entry.lastUpdated === '' || ticket.updated > entry.lastUpdated)) {
      entry.lastUpdated = ticket.updated;
    }
    perMember.set(ticket.memberId, entry);
  }

  const memberStats: MemberTicketStats[] = pool.map((member) => {
    const counts = perMember.get(member.id);
    const total = counts?.total ?? 0;
    return {
      memberId: member.id,
      memberName: member.name,
      team: member.team,
      total,
      open: counts?.open ?? 0,
      inProgress: counts?.inProgress ?? 0,
      done: counts?.done ?? 0,
      resolvedRate: total > 0 ? (counts!.done / total) : null,
      ...(counts !== undefined && counts.lastUpdated !== '' ? { lastActivity: counts.lastUpdated } : {}),
    };
  });
  memberStats.sort(
    (a, b) => b.total - a.total || a.memberName.localeCompare(b.memberName) || a.memberId.localeCompare(b.memberId),
  );

  tickets.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '') || a.issueKey.localeCompare(b.issueKey));

  const unmatched = new Map<string, number>();
  for (const ticket of tickets) {
    if (ticket.memberId === undefined) {
      unmatched.set(ticket.reporterName, (unmatched.get(ticket.reporterName) ?? 0) + 1);
    }
  }
  const unmatchedReporters: UnmatchedReporterRow[] = [...unmatched.entries()]
    .map(([reporterName, count]) => ({ reporterName, count }))
    .sort((a, b) => b.count - a.count || a.reporterName.localeCompare(b.reporterName));

  return { memberStats, tickets, unmatchedReporters, totals };
}