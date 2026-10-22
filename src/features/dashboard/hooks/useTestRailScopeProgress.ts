import { useCallback, useEffect, useState } from 'react';
import { useReportsStateCtx } from '../../../app/state-contexts';
import { createTestRailClient } from '../../../lib/testrail/client';
import type { TestRailClientError, TestRailRunProgress } from '../../../../shared/testrail';
import type { TestScope } from '../../../domain/testManagement';

/**
 * Live TestRail progress of a project's linked scopes, for the Dashboard's
 * Execution section (the links created in Test Management → Scopes).
 *
 * Data flow rules (the same ones TestRailScopeProgress follows):
 *  - The link lives on the SHARED scope record (`scope.testrail`); the run
 *    counts do NOT. They are fetched on demand, kept in component state
 *    only and NEVER persisted to storage or written into sync records.
 *  - The numbers stay current by themselves: the first fetch runs as soon
 *    as the section mounts (when a connection exists and the project has
 *    linked scopes), and a fixed interval re-fetches afterwards — the
 *    refresh button remains for an on-demand update.
 *  - The connection is the DEVICE-LOCAL TestRail connection; without one
 *    the refresh reports the typed `notConfigured` error so the UI can
 *    point at Settings → TestRail Integration instead of showing nothing.
 */

/** How often the live status re-fetches itself (ms). */
const AUTO_REFRESH_MS = 60_000;

/** One linked scope with its run's current status counts. */
export interface TestRailScopeProgressLine {
  scope: TestScope;
  progress: TestRailRunProgress;
}

/** Everything the Execution section renders for the TestRail refresh. */
export interface TestRailExecutionStatus {
  /** The linked active scopes a refresh fetches (already project-filtered). */
  scopes: readonly TestScope[];
  /** The last successful fetch's lines, or null before the first refresh. */
  lines: readonly TestRailScopeProgressLine[] | null;
  /** The last failure, or null. */
  error: TestRailClientError | null;
  /** True while a refresh is in flight (the button disables itself). */
  loading: boolean;
  /** ISO timestamp of the last successful fetch, or null. */
  fetchedAt: string | null;
  /** Start a refresh. */
  onRefresh: () => void;
}

export function useTestRailScopeProgress(scopes: readonly TestScope[]): TestRailExecutionStatus {
  const reports = useReportsStateCtx();
  const conn = reports.state.settings.testrail;
  const [lines, setLines] = useState<readonly TestRailScopeProgressLine[] | null>(null);
  const [error, setError] = useState<TestRailClientError | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const linked = scopes.flatMap((s) =>
      s.status === 'active' && s.testrail !== undefined ? [{ scope: s, runId: s.testrail.runId }] : [],
    );
    if (linked.length === 0) return;
    if (conn === undefined) {
      setError({ kind: 'notConfigured', message: '' });
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const client = createTestRailClient(conn);
      // One request per linked run, in parallel; a single failure fails the
      // whole refresh so the readout never mixes old and new numbers.
      const next = await Promise.all(
        linked.map(async ({ scope, runId }) => ({ scope, progress: await client.getRunProgress(runId) })),
      );
      setLines(next);
      setFetchedAt(new Date().toISOString());
    } catch (e) {
      setError(e as TestRailClientError);
    } finally {
      setLoading(false);
    }
  }, [conn, scopes]);

  // Keep the live status current by itself: fetch once when the section
  // mounts (a connection exists and the project has linked active scopes),
  // then re-fetch on a fixed interval. `refresh` is stable per (conn,
  // scopes), so this never loops; the interval is cleared on unmount and
  // re-armed when the linked-scope set changes.
  useEffect(() => {
    if (conn === undefined) return;
    if (!scopes.some((s) => s.status === 'active' && s.testrail !== undefined)) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [conn, scopes, refresh]);

  return { scopes, lines, error, loading, fetchedAt, onRefresh: () => void refresh() };
}
