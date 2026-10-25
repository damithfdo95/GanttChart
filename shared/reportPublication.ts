/**
 * Publication of a finalized Daily Report: the smallest model that records that the supervisor delivered it. It is metadata only -
 * a report is never regenerated, edited or sent anywhere by it. There is no destination (no URL, channel or address), no unpublish,
 * and a draft can never be published. Pure and dependency-free so the app and the Worker apply the very same rules.
 */

export const PUBLICATION_STATUSES = ['notPublished', 'published'] as const;
export type ReportPublicationStatus = (typeof PUBLICATION_STATUSES)[number];

export const PUBLICATION_METHODS = ['manualCopy', 'print', 'export', 'other'] as const;
export type ReportPublicationMethod = (typeof PUBLICATION_METHODS)[number];

/** The optional fields a DailyReport carries once published. An older report has none of them and reads as Not Published. */
export interface ReportPublication {
  publicationStatus?: ReportPublicationStatus;
  publishedAt?: string;
  publishedByUserId?: string;
  publishedByMemberId?: string;
  publicationMethod?: ReportPublicationMethod;
}

export const PUBLICATION_KEYS = ['publicationStatus', 'publishedAt', 'publishedByUserId', 'publishedByMemberId', 'publicationMethod'] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A stable account / member id: plain identifier characters only (so no URL, address or free text can ride along). */
const ACTOR_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function publicationStatusOf(report: { publicationStatus?: unknown }): ReportPublicationStatus {
  return report.publicationStatus === 'published' ? 'published' : 'notPublished';
}

/** Is this FINALIZED report published? (A draft is never published.) */
export function isPublished(report: { status?: unknown; publicationStatus?: unknown }): boolean {
  return report.status === 'FINALIZED' && publicationStatusOf(report) === 'published';
}

/** Short machine-readable reason, or null when the report's publication metadata is valid. */
export function reportPublicationError(report: unknown): string | null {
  if (!isObj(report)) return 'report_not_an_object';
  const status = report.publicationStatus;
  if (status !== undefined && !(PUBLICATION_STATUSES as readonly unknown[]).includes(status)) return 'report_publication_invalid_status';
  if (status === undefined || status === 'notPublished') {
    return report.publishedAt === undefined && report.publishedByUserId === undefined && report.publishedByMemberId === undefined && report.publicationMethod === undefined
      ? null
      : 'report_publication_inconsistent';
  }
  if (report.status !== 'FINALIZED') return 'report_publication_draft';
  if (typeof report.publishedAt !== 'string' || !ISO_INSTANT.test(report.publishedAt) || Number.isNaN(Date.parse(report.publishedAt))) return 'report_publication_invalid_time';
  for (const key of ['publishedByUserId', 'publishedByMemberId'] as const) {
    const id = report[key];
    if (id !== undefined && !(typeof id === 'string' && ACTOR_ID.test(id))) return 'report_publication_invalid_actor';
  }
  if (!(PUBLICATION_METHODS as readonly unknown[]).includes(report.publicationMethod)) return 'report_publication_invalid_method';
  return null;
}

function parse(json: string | null | undefined): Obj | null {
  if (json === null || json === undefined) return null;
  try {
    const v: unknown = JSON.parse(json);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** Key-order independent text of everything in a report except its publication metadata and its touch time. */
function contentOf(report: Obj): string {
  const rest: Obj = {};
  for (const key of Object.keys(report).sort()) {
    if (key === 'updatedAt' || (PUBLICATION_KEYS as readonly string[]).includes(key)) continue;
    rest[key] = report[key];
  }
  return JSON.stringify(rest);
}

function publicationOf(report: Obj): string {
  return JSON.stringify(PUBLICATION_KEYS.map((key) => report[key] ?? null));
}

export interface ReportPublicationCommitInput {
  puts: ReadonlyArray<{ kind: string; id: string; json: string }>;
  view: { get(kind: string, id: string): string | null };
  isSv: boolean;
}

/**
 * What a commit may do to report publication: valid metadata only; only an SV publishes; only a FINALIZED report is published, and
 * publishing changes nothing but the publication metadata; a published report stays published with the same first timestamp.
 */
export function reportPublicationCommitError(input: ReportPublicationCommitInput): string | null {
  for (const p of input.puts) {
    if (p.kind !== 'report') continue;
    const next = parse(p.json);
    if (next === null) continue; // not this rule's concern: the record itself is validated elsewhere
    const invalid = reportPublicationError(next);
    if (invalid !== null) return invalid;
    const prev = parse(input.view.get('report', p.id));
    const wasPublished = prev !== null && publicationStatusOf(prev) === 'published';
    const nowPublished = publicationStatusOf(next) === 'published';
    if (nowPublished && !input.isSv) return 'report_publication_sv_only';
    if (wasPublished) {
      // No unpublish, no re-stamping: the first publication is final.
      if (publicationOf(prev) !== publicationOf(next)) return 'report_publication_immutable';
    } else if (nowPublished) {
      if (prev === null || prev.status !== 'FINALIZED') return 'report_publication_draft';
      if (contentOf(prev) !== contentOf(next)) return 'report_publication_changes_content';
    }
  }
  return null;
}
