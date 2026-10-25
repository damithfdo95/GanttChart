/**
 * Browser fetch client for the JIRA import (Stage: JIRA import, Lane A).
 *
 * Environment-aware but DOM-free beyond fetch/AbortController: the same
 * client runs against JIRA Cloud (v3 `/rest/api/3/search/jql`, ADF rich
 * text, cursor paging, Basic auth) and JIRA Data Center (v2
 * `/rest/api/2/search`, plain text, offset paging, Bearer auth). A legacy
 * `POST /rest/api/2|3/search` is deliberately NOT used — Cloud removed it
 * (HTTP 410) and only the new `/search/jql` endpoint works.
 *
 * Every failure is reported as a `JiraClientError` (kind + stable technical
 * message, UI hints live in i18n). No credential is ever included in an
 * error message or log.
 */

import type {
  JiraClientError,
  JiraClientErrorKind,
  JiraConnection,
  JiraFlavor,
  JiraIssue,
  JiraSearchRequest,
} from '../../../shared/jira';
import type { FetchLike } from '../tenancy/api';
import { adfToPlainText, cleanPlainText } from './adf';
import { isSecureIntegrationUrl } from '../../../shared/integrationUrl';

const PAGE_SIZE = 100;
const DEFAULT_MAX_TOTAL = 500;
const HARD_CAP_TOTAL = 1000;
const DEFAULT_TIMEOUT_MS = 60_000;
/** Safety bound on the single 429 wait so the UI never stalls for hours. */
const RETRY_AFTER_CAP_SECONDS = 300;

/** The issue fields every import consumer works with (both flavors). */
const ISSUE_FIELDS = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'reporter', 'labels', 'created', 'updated', 'versions', 'description'] as const;

export interface JiraClient {
  search(request: JiraSearchRequest): Promise<JiraIssue[]>;
  /** Smoke test: fetch up to one issue. Throws the same JiraClientError taxonomy. */
  testConnection(): Promise<JiraIssue[]>;
}

function clientError(kind: JiraClientErrorKind, message: string, status?: number): JiraClientError {
  return { kind, message, ...(status === undefined ? {} : { status }) };
}

function isClientError(e: unknown): e is JiraClientError {
  return typeof e === 'object' && e !== null && 'kind' in e;
}

/**
 * Resolve the effective flavor: 'auto' reads the base-URL host
 * (`.atlassian.net` ⇒ cloud, anything else ⇒ Data Center).
 */
export function resolveJiraFlavor(conn: JiraConnection, baseUrl: string): JiraFlavor {
  if (conn.flavor === 'cloud' || conn.flavor === 'dc') return conn.flavor;
  let host = '';
  try {
    host = new URL(baseUrl).host;
  } catch {
    host = baseUrl;
  }
  return /\.atlassian\.net$/i.test(host) ? 'cloud' : 'dc';
}

/** RFC 4648 base64 (email:token is ASCII, so UTF-8 == bytes). No DOM dependency. */
export function encodeBasicAuth(email: string, token: string): string {
  const bytes = new TextEncoder().encode(`${email}:${token}`);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = i + 1 < bytes.length ? bytes[i + 1] ?? 0 : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] ?? 0 : 0;
    out += chars[b0 >> 2];
    out += chars[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? chars[b2 & 63] : '=';
  }
  return out;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(res: Response): number {
  const value = res.headers.get('retry-after');
  if (value === null) return 1;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, RETRY_AFTER_CAP_SECONDS);
  // HTTP-date Retry-After (rare): fall back to a short fixed wait.
  return 1;
}

interface RawIssueFields {
  summary?: unknown;
  status?: { name?: unknown; statusCategory?: { name?: unknown } };
  issuetype?: { name?: unknown };
  priority?: { name?: unknown } | null;
  assignee?: { displayName?: unknown } | null;
  reporter?: { displayName?: unknown } | null;
  labels?: unknown;
  created?: unknown;
  updated?: unknown;
  /** Fix-version objects ({ name, ... }) — release labels for routing. */
  versions?: unknown;
  description?: unknown;
}

interface RawIssue {
  id?: unknown;
  key?: unknown;
  fields?: RawIssueFields | null;
}

function nameOf(v: unknown): string | undefined {
  return typeof v === 'object' && v !== null && typeof (v as { name?: unknown }).name === 'string'
    ? ((v as { name: string }).name)
    : undefined;
}

function displayNameOf(v: unknown): string | undefined {
  return typeof v === 'object' && v !== null && typeof (v as { displayName?: unknown }).displayName === 'string'
    ? ((v as { displayName: string }).displayName)
    : undefined;
}

function mapIssue(raw: RawIssue): JiraIssue {
  const fields = raw.fields ?? {};
  const status = fields.status;
  const statusCategory = typeof status?.statusCategory === 'object' && status.statusCategory !== null ? status.statusCategory : undefined;
  const labels = Array.isArray(fields.labels) ? fields.labels.filter((l): l is string => typeof l === 'string') : [];
  const description = fields.description;
  // Fix-version release labels, tolerate missing/malformed entries.
  const affectedVersions = Array.isArray(fields.versions)
    ? fields.versions
        .map((v) => (typeof v === 'object' && v !== null && typeof (v as { name?: unknown }).name === 'string' ? (v as { name: string }).name : ''))
        .filter((name) => name !== '')
    : [];
  return {
    id: String(raw.id ?? ''),
    key: String(raw.key ?? ''),
    summary: typeof fields.summary === 'string' ? fields.summary : '',
    statusName: nameOf(status) ?? '',
    statusCategoryName: typeof statusCategory?.name === 'string' ? statusCategory.name : undefined,
    typeName: nameOf(fields.issuetype) ?? '',
    priorityName: nameOf(fields.priority),
    assigneeName: displayNameOf(fields.assignee),
    reporterName: displayNameOf(fields.reporter),
    labels,
    created: typeof fields.created === 'string' && fields.created !== '' ? fields.created : undefined,
    updated: typeof fields.updated === 'string' && fields.updated !== '' ? fields.updated : undefined,
    affectedVersions,
    // Cloud delivers ADF rich text; DC delivers a plain string.
    descriptionPlain: cleanPlainText(typeof description === 'string' ? description : adfToPlainText(description)),
  };
}

export function createJiraClient(conn: JiraConnection, fetchLike: FetchLike = (input, init) => fetch(input, init)): JiraClient {
  // Effective base: the proxy (when configured) replaces the JIRA root; all
  // requests go there with the original JIRA path appended.
  const proxyUrl = (conn.proxyUrl ?? '').trim();
  const baseUrl = (conn.baseUrl ?? '').trim();
  const base = trimSlash(proxyUrl !== '' ? proxyUrl : baseUrl);
  if (base === '') throw clientError('notConfigured', 'No JIRA base URL configured.');
  if (!isSecureIntegrationUrl(base)) throw clientError('notConfigured', 'The JIRA address must use https:// (http:// is only allowed on this computer).');
  // Flavor comes from the JIRA host (the proxy host must not decide it).
  const flavorHost = baseUrl !== '' ? baseUrl : base;
  const flavor = resolveJiraFlavor(conn, flavorHost) === 'cloud' ? 'cloud' : 'dc';
  const useProxy = proxyUrl !== '';

  // Credentials per flavor. Missing credentials ⇒ notConfigured.
  if (flavor === 'cloud') {
    const email = conn.email?.trim() ?? '';
    const token = conn.token?.trim() ?? '';
    if (email === '' || token === '') {
      throw clientError('notConfigured', 'Cloud credentials (email + API token) are missing.');
    }
  } else if ((conn.token?.trim() ?? '') === '') {
    throw clientError('notConfigured', 'Data Center credentials (Personal Access Token) are missing.');
  }

  const authHeader =
    flavor === 'cloud'
      ? `Basic ${encodeBasicAuth(conn.email?.trim() ?? '', conn.token?.trim() ?? '')}`
      : `Bearer ${conn.token?.trim() ?? ''}`;

  async function doRequest<T>(method: 'GET' | 'POST', url: string, timeoutMs: number, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: authHeader,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    };

    let retriedRateLimit = false;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let gotResponse = false;
      try {
        const res = await fetchLike(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });
        gotResponse = true;

        if (res.status === 429) {
          if (retriedRateLimit) {
            throw clientError('rateLimit', 'JIRA rate limit reached; retry later.', 429);
          }
          retriedRateLimit = true;
          const waitSeconds = parseRetryAfter(res);
          await sleep(waitSeconds * 1000);
          continue; // one retry after the advertised wait
        }
        if (res.status === 401) {
          throw clientError('auth', 'Authentication failed: the email/API token or PAT was rejected.', 401);
        }
        if (res.status === 403) {
          throw clientError('forbidden', 'Access denied: the account cannot search this JIRA instance.', 403);
        }

        let payload: unknown = null;
        try {
          payload = await res.json();
        } catch {
          /* empty or non-JSON body */
        }

        if (!res.ok) {
          if (res.status >= 500) {
            throw clientError('server', `JIRA server error (HTTP ${res.status}).`, res.status);
          }
          if (res.status === 400) {
            throw clientError('badRequest', jiraErrorMessage(payload, res.status), res.status);
          }
          throw clientError('badRequest', `JIRA rejected the request (HTTP ${res.status}).`, res.status);
        }
        return payload as T;
      } catch (e) {
        if (isClientError(e)) throw e;
        if (controller.signal.aborted || (e instanceof Error && e.name === 'AbortError')) {
          throw clientError('timeout', `The JIRA request timed out after ${timeoutMs}ms.`);
        }
        if (gotResponse) {
          throw clientError('unknown', 'JIRA returned an unreadable response.');
        }
        // No HTTP response ever arrived: browsers raise TypeError on CORS
        // blocks / network failures. Without a proxy this is almost always a
        // CORS block on BOTH flavors (JIRA Cloud never sends CORS headers;
        // JIRA Data Center/Server does not enable them by default either).
        if (!useProxy) {
          throw clientError(
            'cors',
            'Possible CORS block — JIRA does not allow direct browser calls by default; configure a proxy URL.',
          );
        }
        // A configured proxy that never answers is a genuine network failure.
        throw clientError('network', 'The JIRA request failed at the network level; check the connection.');
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async function search(request: JiraSearchRequest): Promise<JiraIssue[]> {
    const maxTotal = Math.max(1, Math.min(request.maxTotal ?? DEFAULT_MAX_TOTAL, HARD_CAP_TOTAL));
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const issues: JiraIssue[] = [];

    if (flavor === 'cloud') {
      // Cursor paging: POST /rest/api/3/search/jql until the token disappears.
      let nextPageToken: string | undefined;
      for (;;) {
        const body: Record<string, unknown> = {
          jql: request.jql,
          fields: [...ISSUE_FIELDS],
          maxResults: PAGE_SIZE,
        };
        if (nextPageToken !== undefined) body.nextPageToken = nextPageToken;
        const data = await doRequest<{ issues?: RawIssue[]; nextPageToken?: unknown }>('POST', `${base}/rest/api/3/search/jql`, timeoutMs, body);
        const page = Array.isArray(data.issues) ? data.issues : [];
        for (const raw of page) issues.push(mapIssue(raw));
        if (issues.length >= maxTotal) {
          issues.length = maxTotal;
          break;
        }
        nextPageToken = typeof data.nextPageToken === 'string' && data.nextPageToken !== '' ? data.nextPageToken : undefined;
        if (nextPageToken === undefined || page.length === 0) break;
      }
    } else {
      // Offset paging: GET /rest/api/2/search?jql=&startAt=&maxResults=&fields=
      let startAt = 0;
      for (;;) {
        const qs = new URLSearchParams({
          jql: request.jql,
          startAt: String(startAt),
          maxResults: String(PAGE_SIZE),
          fields: ISSUE_FIELDS.join(','),
        });
        const data = await doRequest<{ issues?: RawIssue[]; total?: unknown }>('GET', `${base}/rest/api/2/search?${qs.toString()}`, timeoutMs);
        const page = Array.isArray(data.issues) ? data.issues : [];
        for (const raw of page) issues.push(mapIssue(raw));
        startAt += page.length;
        const total = typeof data.total === 'number' ? data.total : startAt;
        if (issues.length >= maxTotal) {
          issues.length = maxTotal;
          break;
        }
        if (page.length === 0 || startAt >= total) break;
      }
    }
    return issues;
  }

  return {
    search,
    testConnection: () => search({ jql: 'ORDER BY created DESC', maxTotal: 1 }),
  };
}

/** JIRA error body: `errorMessages: string[]` plus `errors: {field: message}`. */
function jiraErrorMessage(payload: unknown, status: number): string {
  const parts: string[] = [];
  if (typeof payload === 'object' && payload !== null) {
    const p = payload as Record<string, unknown>;
    if (Array.isArray(p.errorMessages)) {
      for (const m of p.errorMessages) if (typeof m === 'string' && m !== '') parts.push(m);
    }
    if (typeof p.errors === 'object' && p.errors !== null) {
      for (const value of Object.values(p.errors as Record<string, unknown>)) {
        if (typeof value === 'string' && value !== '') parts.push(value);
      }
    }
  }
  const message = parts.join(' ');
  return message === '' ? `JIRA rejected the request (HTTP ${status}).` : message;
}