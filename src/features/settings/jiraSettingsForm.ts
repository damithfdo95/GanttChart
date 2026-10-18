import type { JiraConnection, JiraFlavor } from '../../../shared/jira';

/** What the Settings → JIRA Integration form holds while it is being edited. */
export interface JiraDraft {
  baseUrl: string;
  flavor: JiraFlavor;
  email: string;
  /** Write-only: starts empty and only ever holds what the user typed. */
  token: string;
  proxyUrl: string;
}

export const EMPTY_JIRA_DRAFT: JiraDraft = { baseUrl: '', flavor: 'auto', email: '', token: '', proxyUrl: '' };

const HTTP_URL = /^https?:\/\/[^\s/]+/i;

export function isHttpUrl(value: string): boolean {
  return HTTP_URL.test(value.trim());
}

/** True for a plain-http proxy that is not on this computer (the token would cross the network unencrypted). */
export function isInsecureProxy(value: string): boolean {
  const v = value.trim();
  if (!/^http:\/\//i.test(v)) return false;
  return !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(v);
}

export interface JiraDraftProblems {
  baseUrl: boolean;
  proxyUrl: boolean;
}

export function jiraDraftProblems(draft: JiraDraft): JiraDraftProblems {
  const base = draft.baseUrl.trim();
  const proxy = draft.proxyUrl.trim();
  return { baseUrl: base !== '' && !isHttpUrl(base), proxyUrl: proxy !== '' && !isHttpUrl(proxy) };
}

/**
 * The connection the draft describes. What the person typed wins for every field, so an emptied
 * email or proxy really is removed and "auto" really means auto. Only the token is write-only: an
 * empty token field keeps `keptToken` (the saved one). Returns undefined while there is no usable
 * base URL (the feature is off); an invalid proxy address is left out rather than saved.
 */
export function connectionFromDraft(draft: JiraDraft, keptToken: string | undefined): JiraConnection | undefined {
  const baseUrl = draft.baseUrl.trim();
  if (baseUrl === '' || !isHttpUrl(baseUrl)) return undefined;
  const conn: JiraConnection = { baseUrl };
  if (draft.flavor !== 'auto') conn.flavor = draft.flavor;
  const email = draft.email.trim();
  if (email !== '') conn.email = email;
  const token = draft.token.trim() !== '' ? draft.token.trim() : keptToken;
  if (token !== undefined && token !== '') conn.token = token;
  const proxyUrl = draft.proxyUrl.trim();
  if (proxyUrl !== '' && isHttpUrl(proxyUrl)) conn.proxyUrl = proxyUrl;
  return conn;
}
