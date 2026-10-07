import { useMemo, useState } from 'react';
import { useAppStateCtx } from '../../app/state-contexts';
import { useAccess } from '../../app/access';
import { resolveBilingualName, t } from '../../i18n';
import { userLabel } from '../../domain/people';
import { assignedScopes, filterCases, sortCases, summarize, type TestScope } from '../../domain/testManagement';
import { ExecutionTable } from './ExecutionTable';
import { SummaryBlock, pct } from './SummaryParts';
import { useBusinessToday, usePeopleDirectory, useTestManagement } from './useTestManagement';

/**
 * My Testing (Tester): only the scopes this person is assigned to, with progress and a way to continue. No scope or test case
 * administration, no other people's data beyond the names shown next to a result. The server enforces the same limits.
 */
export function MyTestingScreen() {
  const lang = useAppStateCtx().state.language;
  const access = useAccess();
  const tm = useTestManagement();
  const today = useBusinessToday();
  const directory = usePeopleDirectory(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const mine = useMemo(
    () => (access.userId === null ? [] : assignedScopes(access.userId, tm.reports.state.testerAssignments ?? [], tm.scopes, today)),
    [access.userId, tm.reports.state.testerAssignments, tm.scopes, today],
  );
  const projects = tm.reports.state.projects;
  const projectName = (stable: string): string => {
    const p = projects.find((x) => x.projectId === stable);
    return p === undefined ? '' : resolveBilingualName(lang, { nameEn: p.nameEn, nameJa: p.nameJa }) || p.projectId;
  };
  const casesOf = (scope: TestScope) => sortCases(filterCases(tm.testCases, tm.byCase, { scopeId: scope.id }));
  const open = mine.find((s) => s.id === openId);

  if (open !== undefined) {
    const cases = casesOf(open);
    return (
      <div className="app tm-screen">
        <header className="dr-section">
          <button type="button" className="btn btn-ghost" onClick={() => setOpenId(null)}>
            ← {t(lang, 'tm.my.back')}
          </button>
          <h1>{open.name}</h1>
          <p className="dr-summary">{projectName(open.projectId)}</p>
        </header>
        <SummaryBlock lang={lang} summary={summarize(cases, tm.byCase)} />
        <ExecutionTable
          lang={lang}
          cases={cases}
          scopes={mine}
          byCase={tm.byCase}
          canEdit={(tc) => tc.status === 'active' && open.status === 'active'}
          onPatch={(tc, patch) => tm.patchResult(tc, patch)}
          nameOf={(id) => userLabel(lang, id, directory)}
        />
      </div>
    );
  }

  return (
    <div className="app tm-screen">
      <header className="dr-section">
        <h1>{t(lang, 'tm.my.title')}</h1>
      </header>
      {mine.length === 0 ? (
        <p className="tenancy-empty" role="note">
          {t(lang, 'tm.my.none')}
        </p>
      ) : (
        <div className="tm-cards">
          {mine.map((scope) => {
            const s = summarize(casesOf(scope), tm.byCase);
            return (
              <article key={scope.id} className="summary-card tm-card">
                <p className="link-help">{projectName(scope.projectId)}</p>
                <h2>{scope.name}</h2>
                <p>
                  {t(lang, 'tm.my.completed', { done: s.completed, total: s.total })} · {pct(s.progress)}
                </p>
                <button type="button" className="btn btn-primary" onClick={() => setOpenId(scope.id)}>
                  {t(lang, 'tm.my.continue')}
                </button>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
