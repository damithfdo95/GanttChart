/**
 * The QA team's release-readiness policy and the QA work types - plain constants and pure validators shared by the browser and the
 * Worker, so the defaults and the rules live in exactly one place.
 *
 * One workspace is one QA team today (the organization / multi-team layer is future work): the policy belongs to the workspace and
 * rides in the ordinary shared `settings` record. It is deliberately a small, explicit set of choices - not a rules engine.
 */

/** Built-in kinds of QA work. A categorization aid, never a required workflow; the list can grow without changing stored data. */
export const QA_WORK_TYPES = ['regression', 'sanity', 'adhoc', 'verification'] as const;
export type QaWorkType = (typeof QA_WORK_TYPES)[number];
/** A scope without a work type (every scope created before this existed) is simply "unspecified". Nothing is guessed from names. */
export const isQaWorkType = (v: unknown): v is QaWorkType => typeof v === 'string' && (QA_WORK_TYPES as readonly string[]).includes(v);

export const QA_POLICY_VERSION = 1;

/** The ticket severities / statuses a policy may name (the same values the Bug Tickets screen records). */
export const QA_DEFECT_SEVERITIES = ['Critical', 'Major', 'Minor', 'Trivial'] as const;
export const QA_DEFECT_STATUSES = ['Open', 'In Progress', 'Resolved', 'Closed', 'Rejected', 'Duplicate'] as const;

export const QA_POLICY_LIMITS = { maxJsonChars: 1000 } as const;

export interface QaPolicy {
  /** Policy format version, for future migrations. */
  version: typeof QA_POLICY_VERSION;
  /** A defect of one of these severities counts as release-relevant... */
  blockingDefectSeverities: Array<(typeof QA_DEFECT_SEVERITIES)[number]>;
  /** ...while it is in one of these statuses. */
  unresolvedDefectStatuses: Array<(typeof QA_DEFECT_STATUSES)[number]>;
  /** What such an unresolved defect does to readiness. */
  defectsAction: 'blocked' | 'atRisk';
  /** Blocked test cases: ignore (info), At Risk, or Blocked. */
  blockedCases: 'info' | 'atRisk' | 'blocked';
  /** Failed test cases: At Risk or Blocked. */
  failedCases: 'atRisk' | 'blocked';
  /** A started project with nothing executed: informational or At Risk. */
  missingExecution: 'info' | 'atRisk';
  /** An unassigned planned-tester gap: At Risk only under schedule pressure, always, or never (informational). */
  staffingGap: 'whenScheduleAtRisk' | 'alwaysAtRisk' | 'informational';
}

/** The canonical default policy: exactly the behavior readiness had before the policy existed. The ONE place defaults live. */
export function defaultQaPolicy(): QaPolicy {
  return {
    version: QA_POLICY_VERSION,
    blockingDefectSeverities: ['Critical'],
    unresolvedDefectStatuses: ['Open', 'In Progress'],
    defectsAction: 'blocked',
    blockedCases: 'atRisk',
    failedCases: 'atRisk',
    missingExecution: 'atRisk',
    staffingGap: 'whenScheduleAtRisk',
  };
}

const KEYS = ['version', 'blockingDefectSeverities', 'unresolvedDefectStatuses', 'defectsAction', 'blockedCases', 'failedCases', 'missingExecution', 'staffingGap'] as const;
const ONE_OF = {
  defectsAction: ['blocked', 'atRisk'],
  blockedCases: ['info', 'atRisk', 'blocked'],
  failedCases: ['atRisk', 'blocked'],
  missingExecution: ['info', 'atRisk'],
  staffingGap: ['whenScheduleAtRisk', 'alwaysAtRisk', 'informational'],
} as const;

function listOk(v: unknown, allowed: readonly string[]): boolean {
  return Array.isArray(v) && v.length <= allowed.length && v.every((x) => typeof x === 'string' && allowed.includes(x)) && new Set(v).size === v.length;
}

/** Why a policy payload is invalid, or null. Strict: the exact keys, known values, the current version, a small size. */
export function qaPolicyError(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'settings_invalid_qa_policy';
  const p = raw as Record<string, unknown>;
  if (JSON.stringify(raw).length > QA_POLICY_LIMITS.maxJsonChars) return 'settings_invalid_qa_policy';
  if (Object.keys(p).some((k) => !(KEYS as readonly string[]).includes(k))) return 'settings_invalid_qa_policy';
  if (p.version !== QA_POLICY_VERSION) return 'settings_invalid_qa_policy';
  if (!listOk(p.blockingDefectSeverities, QA_DEFECT_SEVERITIES) || !listOk(p.unresolvedDefectStatuses, QA_DEFECT_STATUSES)) return 'settings_invalid_qa_policy';
  for (const [k, allowed] of Object.entries(ONE_OF)) if (typeof p[k] !== 'string' || !(allowed as readonly string[]).includes(p[k] as string)) return 'settings_invalid_qa_policy';
  return null;
}

/** A stored policy that is valid is kept; anything else (missing, damaged, an older shape) reads as the default - never a crash. */
export function resolveQaPolicy(stored: unknown): QaPolicy {
  return qaPolicyError(stored) === null ? (stored as QaPolicy) : defaultQaPolicy();
}

export function isDefaultQaPolicy(policy: QaPolicy): boolean {
  return JSON.stringify(normalizeForCompare(policy)) === JSON.stringify(normalizeForCompare(defaultQaPolicy()));
}

function normalizeForCompare(p: QaPolicy): QaPolicy {
  return { ...p, blockingDefectSeverities: [...p.blockingDefectSeverities].sort(), unresolvedDefectStatuses: [...p.unresolvedDefectStatuses].sort() };
}
