import type { JiraIssue } from '../../../shared/jira';
import type { CycleRecord } from '../../../shared/qaRules';
import type { BugSeverity, BugStatus, BugTicket, ProjectRecord } from '../../types';
import { DEFAULT_TIME_ZONE, parseDate } from '../../lib/dates/dates';

/**
 * JIRA ticket routing + conversion (pure domain — no UI, no i18n, no clock,
 * no storage, no network).
 *
 * Fetched JIRA issues get routed into the project whose `jiraProjectKey`
 * equals the issue key's prefix AND whose test cycle's `version` (the
 * release/build label, e.g. "4.2.0") is one of the issue's affected fix
 * versions — then converted into `BugTicket` drafts and merged into the
 * project's existing tickets by ticket key.
 */

// ---- Routing ----------------------------------------------------------------

/** "ABC-123" → "ABC"; null when the key has no "PREFIX-…" shape. */
export function deriveJiraProjectKey(issueKey: string): string | null {
  const dash = issueKey.indexOf('-');
  // index -1 (no dash) or 0 (empty prefix, e.g. "-123") → null.
  if (dash <= 0) return null;
  return issueKey.slice(0, dash);
}

export type UnroutableReason = 'noProjectKey' | 'noVersionMatch' | 'ambiguous';

export interface RoutedTickets {
  projectId: string;
  issues: JiraIssue[];
}

export interface UnroutableTicket {
  issue: JiraIssue;
  reason: UnroutableReason;
  /** Project names that matched the key (for noVersionMatch/ambiguous). */
  candidates: string[];
}

export interface RoutingResult {
  routed: RoutedTickets[];
  unroutable: UnroutableTicket[];
}

/**
 * Routes each issue to the project whose `jiraProjectKey` equals the issue
 * key's prefix AND whose cycle's `version` is one of the issue's
 * `affectedVersions`.
 *
 * Decisions, precisely:
 * - Projects whose (`jiraProjectKey` is missing or whitespace-only) are NEVER
 *   candidates — `jiraProjectKey` is the only routing handle.
 * - `noProjectKey`: no project carries the derived key prefix (or the key has
 *   no derivable prefix). Candidates: [].
 * - Issues WITH affectedVersions are routed by key+version intersection.
 *   A project's cycle version "matches nothing" when the cycle is missing,
 *   has no `version`, or the version is whitespace — such a project can never
 *   survive the version filter (an archived release with no label satisfies no
 *   version filter), but it still counts as a KEY candidate: it is included in
 *   the `noVersionMatch` candidate list, and it participates in key-count
 *   decisions for issues without affectedVersions.
 * - Issues WITHOUT affectedVersions route by key alone ONLY when exactly ONE
 *   key candidate exists (the union of key+version candidates above). More
 *   than one key candidate → `noVersionMatch`.
 * - `noVersionMatch`: at least one key candidate, but the version intersection
 *   is empty (or the key is ambiguous for a version-less issue). Candidates:
 *   the key-matched project names.
 * - `ambiguous`: more than one project survives key+version. Candidates: the
 *   surviving project names.
 *
 * Output order: `routed` groups by project in `projects` order (each group's
 * issues keep their input order); `unroutable` keeps input order. Pure:
 * inputs are never mutated.
 */
export function routeIssuesToProjects(
  issues: readonly JiraIssue[],
  projects: readonly ProjectRecord[],
  cycles: readonly CycleRecord[],
): RoutingResult {
  const cycleById = new Map<string, CycleRecord>();
  for (const cycle of cycles) cycleById.set(cycle.id, cycle);

  /** Cycle version of a project; '' when the cycle is missing or versionless. */
  function cycleVersionOf(project: ProjectRecord): string {
    const cycleId = project.cycleId;
    const cycle = cycleId === undefined || cycleId === null ? undefined : cycleById.get(cycleId);
    return (cycle?.version ?? '').trim();
  }

  const projectKeyOf = (project: ProjectRecord): string => (project.jiraProjectKey ?? '').trim();

  const routedByProjectId = new Map<string, JiraIssue[]>();
  const unroutable: UnroutableTicket[] = [];

  const pushRouted = (project: ProjectRecord, issue: JiraIssue): void => {
    const group = routedByProjectId.get(project.projectId) ?? [];
    group.push(issue);
    routedByProjectId.set(project.projectId, group);
  };

  for (const issue of issues) {
    const prefix = deriveJiraProjectKey(issue.key);
    if (prefix === null) {
      unroutable.push({ issue, reason: 'noProjectKey', candidates: [] });
      continue;
    }

    const keyMatched = projects.filter((project) => projectKeyOf(project) === prefix);
    if (keyMatched.length === 0) {
      unroutable.push({ issue, reason: 'noProjectKey', candidates: [] });
      continue;
    }

    const affected = issue.affectedVersions.map((v) => v.trim()).filter((v) => v !== '');

    if (affected.length === 0) {
      // No version to intersect with: the key decides, but only when unique.
      // A versionless cycle still counts as a key candidate here — it matches
      // by key even though its (missing) version matches nothing.
      if (keyMatched.length === 1) {
        pushRouted(keyMatched[0]!, issue);
      } else {
        unroutable.push({ issue, reason: 'noVersionMatch', candidates: keyMatched.map((p) => p.nameEn) });
      }
      continue;
    }

    const versionMatched = keyMatched.filter((project) => {
      const version = cycleVersionOf(project);
      return version !== '' && affected.includes(version);
    });

    if (versionMatched.length === 1) {
      pushRouted(versionMatched[0]!, issue);
    } else if (versionMatched.length === 0) {
      unroutable.push({ issue, reason: 'noVersionMatch', candidates: keyMatched.map((p) => p.nameEn) });
    } else {
      unroutable.push({ issue, reason: 'ambiguous', candidates: versionMatched.map((p) => p.nameEn) });
    }
  }

  const routed: RoutedTickets[] = [];
  for (const project of projects) {
    const group = routedByProjectId.get(project.projectId);
    if (group !== undefined && group.length > 0) {
      routed.push({ projectId: project.projectId, issues: group });
    }
  }

  return { routed, unroutable };
}

// ---- Severity / status mapping ----------------------------------------------

/**
 * JIRA priority name → BugTicket severity. Keys are lower-case: lookup
 * trims + lower-cases the priority name, so case differences never matter.
 * - Highest / Blocker / Critical → Critical
 * - High / Major → Major
 * - Medium (and medium-ish aliases: Normal, "Medium High") → Minor
 * - Low / Lowest / Minor / Trivial → Trivial
 */
export const JIRA_PRIORITY_TO_SEVERITY: Readonly<Record<string, BugSeverity>> = {
  // JIRA default priority scheme (Cloud/DC stock).
  highest: 'Critical',
  high: 'Major',
  medium: 'Minor',
  low: 'Trivial',
  lowest: 'Trivial',
  // Classic JIRA priority scheme.
  blocker: 'Critical',
  critical: 'Critical',
  major: 'Major',
  // JIRA priority "Minor" maps to the Trivial severity (per contract).
  minor: 'Trivial',
  trivial: 'Trivial',
  // Common instance-specific medium-ish aliases.
  normal: 'Minor',
  'medium high': 'Minor',
};

/** `undefined` when the priority name is missing or unknown. */
export function mapJiraSeverity(priorityName: string | undefined): BugSeverity | undefined {
  const key = (priorityName ?? '').trim().toLowerCase();
  return key === '' ? undefined : JIRA_PRIORITY_TO_SEVERITY[key];
}

const JIRA_STATUS_BY_NAME: Readonly<Record<string, BugStatus>> = {
  open: 'Open',
  'in progress': 'In Progress',
  resolved: 'Resolved',
  closed: 'Closed',
  rejected: 'Rejected',
  duplicate: 'Duplicate',
};

/**
 * JIRA status name + status category → BugTicket status.
 * Exact name match (case-insensitive) wins; otherwise the category decides:
 * 'To Do' → 'Open', 'In Progress' → 'In Progress', 'Done' → 'Closed'.
 * Unknown name AND unknown category → undefined.
 */
export function mapJiraStatus(statusName: string | undefined, statusCategoryName: string | undefined): BugStatus | undefined {
  const name = (statusName ?? '').trim().toLowerCase();
  if (name !== '') {
    const byName = JIRA_STATUS_BY_NAME[name];
    if (byName !== undefined) return byName;
  }
  switch ((statusCategoryName ?? '').trim().toLowerCase()) {
    case 'to do':
      return 'Open';
    case 'in progress':
      return 'In Progress';
    case 'done':
      return 'Closed';
    default:
      return undefined;
  }
}

// ---- Issue → ticket draft ---------------------------------------------------

export interface TicketImportDraft {
  projectId: string;
  ticket: Omit<BugTicket, 'id'>;
}

const TOKYO_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: DEFAULT_TIME_ZONE, // Asia/Tokyo — the app's business timezone
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * ISO timestamp → 'YYYY-MM-DD' in the app's business timezone (Asia/Tokyo),
 * following the `todayEpochDays()` convention in `src/lib/dates/dates.ts`.
 * '' when the timestamp is missing, empty or unparseable (never guessed —
 * '1970-01-01' would be a lie). Callers must handle ''; `mergeImportedTickets`
 * treats it as "absent" and substitutes the provided `now`.
 */
function isoToTokyoDate(iso: string | undefined): string {
  if (iso === undefined || iso === '') return '';
  try {
    const ymd = TOKYO_DATE_FORMAT.format(new Date(iso));
    return parseDate(ymd) === null ? '' : ymd;
  } catch {
    return ''; // invalid timestamp (e.g. RangeError from NaN)
  }
}

function trimTrailingSlashes(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * One JIRA issue → one BugTicket draft (the id is assigned at commit time).
 *
 * - url = `${baseUrl}/browse/${issue.key}` with trailing slashes trimmed
 *   from baseUrl.
 * - createdAt: issue.created converted to 'YYYY-MM-DD' in the Tokyo business
 *   timezone, or '' when unknown — documented decision: '' means "absent";
 *   the caller (merge) substitutes `now` for new tickets and keeps the
 *   existing date on updates, so the empty string never persists.
 * - reportedBy = reporter name ('' when the reporter is unknown);
 *   reporterMemberId is passed in (matched member, may be undefined).
 * - severity/status via the documented mappers; memo and identityResolution
 *   are never touched (undefined).
 */
export function issueToBugTicket(
  issue: JiraIssue,
  projectId: string,
  reporterMemberId: string | undefined,
  baseUrl: string,
): TicketImportDraft {
  const severity = mapJiraSeverity(issue.priorityName);
  const status = mapJiraStatus(issue.statusName, issue.statusCategoryName);
  return {
    projectId,
    ticket: {
      projectId,
      ticketKey: issue.key,
      title: issue.summary,
      url: `${trimTrailingSlashes(baseUrl)}/browse/${issue.key}`,
      createdAt: isoToTokyoDate(issue.created),
      reportedBy: issue.reporterName ?? '',
      ...(reporterMemberId === undefined ? {} : { reporterMemberId }),
      ...(severity === undefined ? {} : { severity }),
      ...(status === undefined ? {} : { status }),
    },
  };
}

// ---- Merge into a project's tickets -----------------------------------------

export interface MergeImportedResult {
  next: BugTicket[];
  created: number;
  updated: number;
  unchanged: number;
}

/**
 * The seven merge-owned fields — everything imported over an existing ticket.
 * memo, identityResolution and the id are NEVER touched.
 */
function mergeOwnedAreEqual(ticket: BugTicket, draft: Omit<BugTicket, 'id'>, effectiveCreatedAt: string): boolean {
  return (
    ticket.title === draft.title &&
    ticket.url === draft.url &&
    ticket.status === draft.status &&
    ticket.severity === draft.severity &&
    ticket.reportedBy === draft.reportedBy &&
    ticket.reporterMemberId === draft.reporterMemberId &&
    ticket.createdAt === effectiveCreatedAt
  );
}

/**
 * Merges drafts into a project's existing tickets, matching by ticketKey.
 *
 * - New key → append a full BugTicket. Ids are DETERMINISTIC, derived from
 *   the draft — `tkt_${projectId}_${ticketKey}` — following the key-derived
 *   id precedent of the blocking-event merger (`blk_${issue.key}` in
 *   `src/domain/blocking/jiraBlockers.ts`). generateId() is NOT used: this
 *   function is pure (same inputs → same outputs; `now` is passed in, no
 *   Date.now, no random), so the UI can preview merges without committing.
 *   ticketKey is unique within a project, so ids never collide.
 *   createdAt: from the draft, or `now` when the draft has none ('').
 * - Existing key → update title, url, status, severity, reportedBy,
 *   reporterMemberId, createdAt from the draft. When the draft's createdAt is
 *   '' (unknown), the existing date is kept. memo, identityResolution and the
 *   id are never touched.
 * - No meaningful difference over the merge-owned fields → unchanged (the
 *   existing ticket object is kept as-is, reference and all).
 * - Drafts with duplicate keys collapse: the first creates/updates, later
 *   ones compare against the freshly merged ticket.
 *
 * Pure: `existing` and `drafts` are never mutated.
 */
export function mergeImportedTickets(
  existing: readonly BugTicket[],
  drafts: readonly TicketImportDraft[],
  now: string,
): MergeImportedResult {
  const next: BugTicket[] = [...existing];
  const byKey = new Map<string, BugTicket>();
  for (const ticket of next) {
    if (ticket.ticketKey !== undefined && ticket.ticketKey !== '') byKey.set(ticket.ticketKey, ticket);
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const draft of drafts) {
    const draftTicket = draft.ticket;
    const key = draftTicket.ticketKey ?? '';
    const current = key === '' ? undefined : byKey.get(key);

    if (current === undefined) {
      const ticket: BugTicket = {
        ...draftTicket,
        id: `tkt_${draft.projectId}_${key}`,
        projectId: draft.projectId,
        createdAt: draftTicket.createdAt === '' ? now : draftTicket.createdAt,
      };
      next.push(ticket);
      if (key !== '') byKey.set(key, ticket);
      created += 1;
      continue;
    }

    // '' (unknown) never overwrites a real date on an existing ticket.
    const effectiveCreatedAt = draftTicket.createdAt === '' ? current.createdAt : draftTicket.createdAt;
    if (mergeOwnedAreEqual(current, draftTicket, effectiveCreatedAt)) {
      unchanged += 1;
      continue;
    }

    const index = next.indexOf(current);
    const merged: BugTicket = {
      ...current,
      title: draftTicket.title,
      url: draftTicket.url,
      status: draftTicket.status,
      severity: draftTicket.severity,
      reportedBy: draftTicket.reportedBy,
      reporterMemberId: draftTicket.reporterMemberId,
      createdAt: effectiveCreatedAt,
    };
    next[index] = merged;
    byKey.set(key, merged);
    updated += 1;
  }

  return { next, created, updated, unchanged };
}