import { useCallback, useState } from 'react';
import { useReportsStateCtx } from '../../app/state-contexts';
import type { JiraClientError, JiraIssue } from '../../../shared/jira';
import { createJiraClient } from './client';

/**
 * Shared JIRA search used by every import entry point (Test Case import,
 * blocking-event import). Reads the connection from the reports settings
 * (absent = feature off) and talks to JIRA through `createJiraClient` with
 * the system `fetch`. Errors surface as the typed `JiraClientError` so the
 * UI renders the right localised recovery hint per kind.
 */
export const SEARCH_MAX_TOTAL = 500;

export interface JiraSearch {
  /** False when Settings → JIRA Integration has no base URL (feature off). */
  configured: boolean;
  /** True while a search is in flight (drives disabled buttons / spinner text). */
  loading: boolean;
  /** The last search failure, or null. Cleared at the start of every search. */
  error: JiraClientError | null;
  /**
   * Run one JQL search. Throws the typed `JiraClientError` on failure
   * (including `notConfigured` when the feature is off or incomplete), so
   * callers can render a kind-specific localized hint. The same error is
   * also reflected in `error` for reactive rendering.
   */
  search: (jql: string) => Promise<JiraIssue[]>;
}

function notConfiguredError(): JiraClientError {
  return { kind: 'notConfigured', message: 'JIRA is not configured (no connection in Settings).' };
}

/**
 * Shared JIRA search used by every import entry point (Test Case import,
 * blocking-event import). Reads the connection from the reports settings
 * (absent = feature off) and talks to JIRA through `createJiraClient` with
 * the system `fetch`. Errors surface as the typed `JiraClientError` so the
 * UI renders the right localised recovery hint per kind.
 */
export function useJiraSearch(): JiraSearch {
  const reports = useReportsStateCtx();
  const jira = reports.state.settings.jira;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<JiraClientError | null>(null);

  const search = useCallback(
    async (jql: string): Promise<JiraIssue[]> => {
      if (jira === undefined) {
        const err = notConfiguredError();
        setError(err);
        throw err;
      }
      setLoading(true);
      setError(null);
      try {
        return await createJiraClient(jira).search({ jql, maxTotal: SEARCH_MAX_TOTAL });
      } catch (e) {
        const err = e as JiraClientError;
        setError(err);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [jira],
  );

  return { configured: jira !== undefined, loading, error, search };
}