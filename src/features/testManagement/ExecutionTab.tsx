/**
 * Test Management → Execution tab (SV): scope filter + the execution results
 * table. Extracted from TestManagementScreen.tsx.
 */

import { useMemo, useState } from 'react';
import { t } from '../../i18n';
import { userLabel } from '../../domain/people';
import { sortScopes, summarize } from '../../domain/testManagement';
import { ExecutionTable } from './ExecutionTable';
import { SummaryBlock } from './SummaryParts';
import { useTestManagement } from './useTestManagement';
import { useDirectory } from './OverviewTab';
import type { Language, ProjectRecord } from '../../types';

export function ExecutionTab({ lang, project }: { lang: Language; project: ProjectRecord }) {
  const tm = useTestManagement();
  const { directory } = useDirectory();
  const scopes = useMemo(() => sortScopes(tm.scopes.filter((s) => s.projectId === project.projectId)), [tm.scopes, project.projectId]);
  const [scopeId, setScopeId] = useState('all');
  const active = scopes.filter((s) => s.status === 'active');
  const chosen = scopeId === 'all' ? active : scopes.filter((s) => s.id === scopeId);
  const ids = new Set(chosen.map((s) => s.id));
  const cases = tm.testCases.filter((c) => ids.has(c.scopeId) && c.status === 'active');
  const summary = useMemo(() => summarize(cases, tm.byCase), [cases, tm.byCase]);
  const updaterIds = [...new Set(tm.caseResults.filter((r) => r.projectId === project.projectId && r.updatedByUserId !== null).map((r) => r.updatedByUserId as string))];
  const scopeById = new Map(scopes.map((s) => [s.id, s]));

  if (scopes.length === 0) {
    return (
      <section className="dr-section tenancy-empty" role="note">
        <p>{t(lang, 'tm.empty.noScopes')}</p>
      </section>
    );
  }
  return (
    <section className="dr-section">
      <div className="dr-button-row">
        <h2>{t(lang, 'tm.exec.title')}</h2>
        <label className="dr-toolbar-field">
          {t(lang, 'tm.col.scope')}
          <select className="input" value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
            <option value="all">{t(lang, 'tm.exec.allScopes')}</option>
            {scopes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.status === 'archived' ? ` (${t(lang, 'tm.status.archived')})` : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      <SummaryBlock lang={lang} summary={summary} />
      <ExecutionTable
        lang={lang}
        cases={cases}
        scopes={scopes}
        byCase={tm.byCase}
        showScope={scopeId === 'all'}
        canEdit={(tc) => tc.status === 'active' && scopeById.get(tc.scopeId)?.status === 'active'}
        onPatch={(tc, patch) => tm.patchResult(tc, patch)}
        nameOf={(id) => userLabel(lang, id, directory)}
        updaters={updaterIds.map((id) => ({ id, label: userLabel(lang, id, directory) }))}
      />
    </section>
  );
}
