import type { TestRailConnection } from '../../../shared/testrail';
import { isHttpUrl, isInsecureRemoteUrl, isSecureIntegrationUrl } from '../../../shared/integrationUrl';

/** What the Settings → TestRail Integration form holds while it is being edited. */
export interface TestRailDraft {
  baseUrl: string;
  /** Write-only: starts empty and only ever holds what the user typed. */
  apiKey: string;
  email: string;
  proxyUrl: string;
}

export const EMPTY_TESTRAIL_DRAFT: TestRailDraft = { baseUrl: '', apiKey: '', email: '', proxyUrl: '' };

export interface TestRailDraftProblems {
  baseUrl: boolean;
  proxyUrl: boolean;
}

export function testrailDraftProblems(draft: TestRailDraft): TestRailDraftProblems {
  const base = draft.baseUrl.trim();
  const proxy = draft.proxyUrl.trim();
  return { baseUrl: base !== '' && (!isHttpUrl(base) || (proxy === '' && isInsecureRemoteUrl(base))), proxyUrl: proxy !== '' && !isSecureIntegrationUrl(proxy) };
}

/**
 * The connection the draft describes. What the person typed wins for every
 * field, so an emptied email or proxy really is removed. Only the API key is
 * write-only: an empty key field keeps `keptApiKey` (the saved one).
 * Returns undefined while there is no usable base URL (the feature is off);
 * an invalid proxy address is left out rather than saved.
 */
export function testrailConnectionFromDraft(draft: TestRailDraft, keptApiKey: string | undefined): TestRailConnection | undefined {
  const baseUrl = draft.baseUrl.trim();
  const proxyAddress = draft.proxyUrl.trim();
  if (baseUrl === '' || !isHttpUrl(baseUrl) || (proxyAddress === '' && isInsecureRemoteUrl(baseUrl))) return undefined;
  const conn: TestRailConnection = { baseUrl };
  const email = draft.email.trim();
  if (email !== '') conn.email = email;
  const apiKey = draft.apiKey.trim() !== '' ? draft.apiKey.trim() : keptApiKey;
  if (apiKey !== undefined && apiKey !== '') conn.apiKey = apiKey;
  const proxyUrl = draft.proxyUrl.trim();
  if (proxyUrl !== '' && isSecureIntegrationUrl(proxyUrl)) conn.proxyUrl = proxyUrl;
  return conn;
}
