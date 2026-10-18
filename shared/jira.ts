/**
 * Shared JIRA integration types (Stage: JIRA import).
 *
 * `JiraIssue` is the NORMALIZED issue shape every part of the app works with.
 * It deliberately hides the Cloud (v3, ADF rich text, cursor paging) vs
 * Data Center (v2, plain text, offset paging) differences: only the fetch
 * client in `src/lib/jira/` knows which flavor it is talking to, and every
 * consumer (import previews, blocking-event mapping, tests) sees one shape.
 *
 * No network code lives here — `shared/` is imported by both the browser app
 * and the Cloudflare Worker, so it must stay environment-free.
 */

/** Which JIRA flavor the client talks to. 'auto' detects from the base URL host. */
export type JiraFlavor = 'cloud' | 'dc' | 'auto';

/**
 * Connection settings, entered by an SV in Settings → JIRA Integration.
 * All fields optional so the persisted shape backfills cleanly (the feature
 * is off until a base URL exists).
 */
export interface JiraConnection {
  /** Instance root, e.g. `https://acme.atlassian.net` or `https://jira.acme.local`. No trailing slash. */
  baseUrl: string;
  /** Explicit flavor override; default 'auto' (`.atlassian.net` host ⇒ cloud). */
  flavor?: JiraFlavor;
  /** Cloud only: Atlassian account email (Basic auth user). */
  email?: string;
  /** Cloud: API token. DC: Personal Access Token (Bearer). Stored locally, never synced. */
  token?: string;
  /**
   * Optional CORS-friendly proxy root. When set, ALL requests go to
   * `${proxyUrl}` + JIRA path instead of `baseUrl` (the proxy forwards).
   * JIRA Cloud sends no CORS headers, so Cloud integrations need this.
   */
  proxyUrl?: string;
}

/** One normalized issue returned by a JQL search, common to Cloud and DC. */
export interface JiraIssue {
  /** Issue id (e.g. "10001"). */
  id: string;
  /** Issue key (e.g. "PROJ-42"). */
  key: string;
  summary: string;
  statusName: string;
  /** Status category: "To Do" | "In Progress" | "Done" (name from JIRA). */
  statusCategoryName?: string;
  typeName: string;
  priorityName?: string;
  assigneeName?: string;
  reporterName?: string;
  labels: string[];
  /** ISO-8601 creation timestamp. */
  created?: string;
  /** ISO-8601 last-updated timestamp. */
  updated?: string;
  /**
   * Fix-version release labels, e.g. ["4.2.0"]. Empty when the issue has
   * none. Used to route imported issues to the project whose cycle's
   * `version` (the release/build label) matches one of these labels.
   */
  affectedVersions: string[];
  /** Plain-text description (ADF flattened on Cloud; trimmed, may be empty). */
  descriptionPlain: string;
}

/** Typed client failures so UI can show the right recovery hint. */
export type JiraClientErrorKind =
  | 'notConfigured'
  | 'auth'
  | 'forbidden'
  | 'rateLimit'
  | 'timeout'
  | 'network'
  /** Browser blocked the request (CORS / mixed content / offline). Most likely on Cloud without a proxy. */
  | 'cors'
  | 'badRequest'
  | 'server'
  | 'unknown';

export interface JiraClientError {
  kind: JiraClientErrorKind;
  /** Stable, non-localized technical message for logs; UI strings come from i18n. */
  message: string;
  /** HTTP status when a response was received. */
  status?: number;
}

/** Search parameters shared by both flavors; the client handles paging internally. */
export interface JiraSearchRequest {
  jql: string;
  /** Total-result safety cap across all pages. Default 500. */
  maxTotal?: number;
  /** Per-request abort/timeout budget in ms. Default 60_000. */
  timeoutMs?: number;
}
