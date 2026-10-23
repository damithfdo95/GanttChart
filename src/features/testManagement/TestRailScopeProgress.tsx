import { useCallback, useEffect, useMemo, useState } from 'react';
import { useReportsStateCtx } from '../../app/state-contexts';
import {
  testerProgressFromTests,
  type TestRailClientError,
  type TestRailRunProgress,
  type TestRailTestRow,
  type TestRailUser,
} from '../../../shared/testrail';
import { createTestRailClient } from '../../lib/testrail/client';
import { backfillTestRailUsers } from '../../lib/testrail/client';
import { testrailTesterDisplayName } from '../../domain/testrail';
import { TestRailErrorHint } from '../../components/TestRailErrorHint';
import { TestRailStatusLine } from '../../components/TestRailStatusLine';
import { t } from '../../i18n';
import type { TestScope } from '../../domain/testManagement';
import type { Language } from '../../types';

/**
 * The live TestRail progress of ONE linked scope ("X Passed, X Blocked, …
 * · Y% passed" + a refresh button), with a collapsed-by-default "By tester"
 * breakdown below the aggregate line: one row per assigned tester (plus one
 * for unassigned tests), each summing exactly to the aggregate.
 *
 * Data flow rules (fixed by design):
 *  - The link lives on the SHARED scope record (`scope.testrail`). The
 *    COUNTS do not: on every fetch the run counts, the run's tests and the
 *    user list are fetched together and kept in component state only (an
 *    in-memory cache with `fetchedAt`). They are NEVER persisted to storage,
 *    never written into sync records — another device must not receive stale
 *    numbers that look authoritative.
 *  - The connection is the DEVICE-LOCAL TestRail connection. When this
 *    device has none configured, a hint points at Settings instead of
 *    numbers (the numbers cannot be fetched anyway).
 *  - Tester display names are cosmetic: the TestRail user list is joined to
 *    the Team Member directory by email (same rule as `linkTestRailMembers`),
 *    preferring the Team Member name, then the TestRail user's own name, then
 *    a stable "Tester #<id>" fallback. If get_users is restricted (some
 *    self-hosted instances), names degrade to the fallback — counts never do.
 *  - The passed % follows TestRail's plan convention: passed / total, 0 for
 *    an empty run (see `passedPct`); the label always names it "passed %".
 */
export function TestRailScopeProgress({ lang, scope }: { lang: Language; scope: TestScope }) {
  const reports = useReportsStateCtx();
  const conn = reports.state.settings.testrail;
  const link = scope.testrail;
  const [cache, setCache] = useState<{ progress: TestRailRunProgress; fetchedAt: string } | null>(null);
  const [tests, setTests] = useState<TestRailTestRow[]>([]);
  const [users, setUsers] = useState<TestRailUser[]>([]);
  const [error, setError] = useState<TestRailClientError | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchProgress = useCallback(async (): Promise<void> => {
    if (conn === undefined || link === undefined) return;
    setLoading(true);
    setError(null);
    try {
      const client = createTestRailClient(conn);
      // The aggregate counts, the per-tester breakdown source and the display
      // names are fetched together so a refresh updates both views atomically.
      const [progress, testRows] = await Promise.all([client.getRunProgress(link.runId), client.getTestsForRun(link.runId)]);
      // Names are cosmetic: without user-list access the breakdown still
      // renders ("Tester #id") — same fallback rule as the import lane.
      let userRows: TestRailUser[] = [];
      try {
        userRows = await client.getUsers();
      } catch {
        /* self-hosted instances may restrict get_users to admins */
      }
      // A deactivated tester drops out of get_users while their tests stay
      // assigned: fetch each missing id with get_user so the row shows the
      // person's name (and their email can link a Team Member).
      userRows = await backfillTestRailUsers(client, userRows, testerProgressFromTests(testRows).map((r) => r.testerId).filter((id): id is number => id !== null));
      setCache({ progress, fetchedAt: new Date().toISOString() });
      setTests(testRows);
      setUsers(userRows);
    } catch (e) {
      setError(e as TestRailClientError);
    } finally {
      setLoading(false);
    }
  }, [conn, link]);

  // Fetch on mount (a scope remounted shows the current numbers); the refresh
  // button refetches on demand. `conn`/`link` are stable per mount, so this
  // effect runs once per mount — never in a loop.
  useEffect(() => {
    void fetchProgress();
  }, [fetchProgress]);

  // Display names: the SAME identity rule linkTestRailMembers applies —
  // an ACTIVE testrail link (the SV's explicit link) wins, then a unique
  // email match, then the TestRail user's own name, then a stable
  // "Tester #<id>" fallback. A linked tester therefore always shows the
  // Team Member's registered name, never the TestRail account's label.
  const nameOf = useMemo(
    () => (testerId: number): string =>
      testrailTesterDisplayName(testerId, users, reports.state.rcsMembers ?? [], reports.state.externalIdentities ?? []),
    [users, reports.state.rcsMembers, reports.state.externalIdentities],
  );

  // A scope without a link does not render (the caller filters).
  if (link === undefined) return null;
  if (conn === undefined) {
    return (
      <p className="link-help" role="note">
        {t(lang, 'tm.testrailProgress.notConfigured')}
      </p>
    );
  }
  if (error !== null) {
    return <TestRailErrorHint lang={lang} error={error} notConfiguredMessage="tm.testrailProgress.notConfigured" />;
  }
  if (cache === null) {
    return loading ? (
      <p className="link-help" role="status">
        {t(lang, 'tm.testrailProgress.fetching')}
      </p>
    ) : null;
  }
  const { progress, fetchedAt } = cache;
  const updatedTime = new Date(fetchedAt).toLocaleTimeString(lang === 'ja' ? 'ja-JP' : 'en-US');
  const testerRows = testerProgressFromTests(tests);
  return (
    <>
      <p className="link-help testrail-progress" role="status">
        <span>
          <TestRailStatusLine lang={lang} progress={progress} />
        </span>
        <small>{t(lang, 'tm.testrailProgress.updatedAt', { time: updatedTime })}</small>
        <button type="button" className="btn btn-ghost" disabled={loading} aria-label={t(lang, 'tm.testrailProgress.refresh')} onClick={() => void fetchProgress()}>
          {loading ? t(lang, 'tm.testrailProgress.fetching') : '⟳'}
        </button>
      </p>
      {testerRows.length === 0 ? null : (
        <details className="link-help testrail-by-tester">
          <summary>{t(lang, 'tm.testrailProgress.tester.toggle', { count: testerRows.length })}</summary>
          <ul className="testrail-tester-list">
            {testerRows.map((row) => (
              <li key={row.testerId === null ? 'unassigned' : `t${row.testerId}`}>
                <strong>{row.testerId === null ? t(lang, 'tm.testrailProgress.tester.unassigned') : nameOf(row.testerId)}</strong>
                <TestRailStatusLine lang={lang} progress={row} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}