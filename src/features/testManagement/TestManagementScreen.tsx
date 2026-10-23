import { useMemo, useState } from 'react';
import { useAppStateCtx } from '../../app/state-contexts';
import { useTenant } from '../../app/tenant-context';
import { useConfirm } from '../../components/ConfirmDialog';
import { resolveBilingualName, t, type TranslationKey } from '../../i18n';
import { ApiError } from '../../lib/tenancy/api';
import { dictionaries } from '../../i18n/dictionaries';
import { assigneeLabel } from '../../domain/people';
import { personOptionText, personOptions, selectableMembers } from '../../domain/teamMembers';
import {
  CASE_PRIORITIES,
  buildBulkCases,
  editScope,
  editTestCase,
  filterCases,
  moveInOrder,
  newScope,
  newTestCase,
  parseBulkCases,
  projectTotals,
  setCaseStatus,
  setScopeStatus,
  sortCases,
  sortScopes,
  usedKeys,
  type BulkParse,
  type CasePriority,
  type CaseInput,
  type TestCase,
  type TestScope,
} from '../../domain/testManagement';
import { RegisteredWarning, ScopeTotalInput } from './SummaryParts';
import { useBusinessToday, useTestManagement } from './useTestManagement';
import { JiraImportDialog } from './JiraImportDialog';
import { TestRailCaseImportDialog } from './TestRailCaseImportDialog';
import { TestRailScopeImportDialog } from './TestRailScopeImportDialog';
import { TestRailScopeProgress } from './TestRailScopeProgress';
import { OverviewTab, useDirectory } from './OverviewTab';
import { ExecutionTab } from './ExecutionTab';
import { AnalysisTab } from './AnalysisTab';
import type { Language, ProjectRecord } from '../../types';

type Tab = 'overview' | 'scopes' | 'cases' | 'execution' | 'analysis';
const TABS: readonly Tab[] = ['overview', 'scopes', 'cases', 'execution', 'analysis'];

type Note = { kind: 'ok' | 'error'; text: string } | null;

function Notice({ note }: { note: Note }) {
  if (note === null) return null;
  return (
    <p className={`data-controls-message ${note.kind}`} role={note.kind === 'error' ? 'alert' : 'status'}>
      {note.text}
    </p>
  );
}

const errorText = (lang: Language, code: string): string => {
  const key = `tm.error.${code}` as TranslationKey;
  return key in dictionaries.en ? t(lang, key) : t(lang, 'tm.error.generic');
};

/**
 * Test Management (SV): Overview, Scopes, Test Cases and Execution for ONE project / test execution. Hierarchy: project > scope > case >
 * result. Everything an SV changes here is an ordinary shared record (one revision per action, however many cases it touches).
 */
export function TestManagementScreen() {
  const app = useAppStateCtx();
  const lang = app.state.language;
  const tm = useTestManagement();
  const projects = useMemo(() => [...tm.reports.state.projects].sort((a, b) => a.projectId.localeCompare(b.projectId)), [tm.reports.state.projects]);
  const [projectId, setProjectId] = useState<string>(() => tm.reports.state.activeProjectId ?? '');
  const [tab, setTab] = useState<Tab>('overview');
  const project: ProjectRecord | undefined = projects.find((p) => p.id === projectId) ?? projects[0];
  const projectName = (p: ProjectRecord): string => resolveBilingualName(lang, { nameEn: p.nameEn, nameJa: p.nameJa }) || p.projectId;

  if (project === undefined) {
    return (
      <div className="app tm-screen">
        <header className="dr-section">
          <h1>{t(lang, 'tm.title')}</h1>
        </header>
        <p className="tenancy-empty" role="note">
          {t(lang, 'tm.noProjects')}
        </p>
      </div>
    );
  }

  return (
    <div className="app tm-screen">
      <header className="dr-section">
        <h1>{t(lang, 'tm.title')}</h1>
        <label className="dr-toolbar-field">
          {t(lang, 'tm.project')}
          <select className="input" value={project.id} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {projectName(p)}
              </option>
            ))}
          </select>
        </label>
        <div className="view-toggle" role="tablist" aria-label={t(lang, 'tm.title')}>
          {TABS.map((id) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : undefined} onClick={() => setTab(id)}>
              {t(lang, `tm.tab.${id}` as TranslationKey)}
            </button>
          ))}
        </div>
      </header>
      {tab === 'overview' ? <OverviewTab lang={lang} project={project} onOpen={() => setTab('scopes')} /> : null}
      {tab === 'scopes' ? <ScopesTab lang={lang} project={project} /> : null}
      {tab === 'cases' ? <CasesTab lang={lang} project={project} /> : null}
      {tab === 'execution' ? <ExecutionTab lang={lang} project={project} /> : null}
      {tab === 'analysis' ? <AnalysisTab lang={lang} project={project} /> : null}
    </div>
  );
}

// ---- Scopes ----------------------------------------------------------------------------------

function ScopesTab({ lang, project }: { lang: Language; project: ProjectRecord }) {
  const tm = useTestManagement();
  const confirm = useConfirm();
  const { api } = useTenant();
  const today = useBusinessToday();
  const { directory } = useDirectory();
  const scopes = useMemo(() => sortScopes(tm.scopes.filter((s) => s.projectId === project.projectId)), [tm.scopes, project.projectId]);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [note, setNote] = useState<Note>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [testRailImporting, setTestRailImporting] = useState(false);
  const assignments = tm.reports.state.testerAssignments ?? [];

  const open = (scope: TestScope | null): void => {
    setEditing(scope === null ? 'new' : scope.id);
    setName(scope?.name ?? '');
    setCode(scope?.code ?? '');
    setDescription(scope?.description ?? '');
    setNote(null);
  };

  const save = (): void => {
    const now = new Date().toISOString();
    let failed: string | null = null;
    tm.update((state) => {
      if (editing === 'new') {
        const made = newScope(state, { projectId: project.projectId, name, code, description }, now);
        if (!made.ok) {
          failed = made.error;
          return state;
        }
        return { ...state, scopes: [...state.scopes, made.value] };
      }
      const made = editScope(state, editing as string, { name, code, description }, now);
      if (!made.ok) {
        failed = made.error;
        return state;
      }
      return { ...state, scopes: state.scopes.map((s) => (s.id === made.value.id ? made.value : s)) };
    });
    if (failed !== null) setNote({ kind: 'error', text: errorText(lang, failed) });
    else {
      setEditing(null);
      setNote(null);
    }
  };

  /** An SV types the Total Test Cases of a scope: one record changes, one revision, nothing else is recalculated by hand. */
  const setTotal = (scope: TestScope, next: number | null): void => {
    let failed: string | null = null;
    tm.update((state) => {
      const made = editScope(state, scope.id, { totalTestCases: next }, new Date().toISOString());
      if (!made.ok) {
        failed = made.error;
        return state;
      }
      return { ...state, scopes: state.scopes.map((x) => (x.id === made.value.id ? made.value : x)) };
    });
    setNote(failed === null ? null : { kind: 'error', text: errorText(lang, failed) });
  };

  const testRailDone = (imported: number, duplicates: number): void => {
    setTestRailImporting(false);
    const text =
      duplicates > 0
        ? `${t(lang, 'tm.testrailImport.done', { count: imported })} ${t(lang, 'tm.testrailImport.doneSkipped', { duplicates })}`
        : t(lang, 'tm.testrailImport.done', { count: imported });
    setNote({ kind: 'ok', text });
  };

  const archive = async (scope: TestScope, archive: boolean): Promise<void> => {
    if (archive) {
      const ok = await confirm({ title: t(lang, 'tm.scope.archiveTitle', { name: scope.name }), body: <p>{t(lang, 'tm.scope.archiveBody')}</p>, confirmLabel: t(lang, 'tm.scope.archive'), cancelLabel: t(lang, 'tenancy.cancel'), severity: 'warning' });
      if (!ok) return;
    }
    tm.update((state) => ({ ...state, scopes: state.scopes.map((s) => (s.id === scope.id ? setScopeStatus(s, archive ? 'archived' : 'active', new Date().toISOString()) : s)) }));
  };

  const move = (scope: TestScope, direction: -1 | 1): void => {
    const changed = moveInOrder(scopes, scope.id, direction);
    if (changed.length === 0) return;
    const now = new Date().toISOString();
    tm.update((state) => ({ ...state, scopes: state.scopes.map((s) => { const c = changed.find((x) => x.id === s.id); return c === undefined ? s : { ...c, updatedAt: now }; }) }));
  };

  const assign = async (scope: TestScope): Promise<void> => {
    const memberId = pick[scope.id];
    if (memberId === undefined || memberId === '' || api === null) return;
    setBusy(true);
    setNote(null);
    try {
      // A Team Member, linked to a login or not: the server resolves which (nothing is duplicated when a login is linked later).
      await api.assignMember(project.projectId, memberId, scope.id);
      setPick((p) => ({ ...p, [scope.id]: '' }));
      setNote({ kind: 'ok', text: t(lang, 'tm.assign.done') });
    } catch (e) {
      setNote({ kind: 'error', text: errorText(lang, e instanceof ApiError ? e.code : 'generic') });
    } finally {
      setBusy(false);
    }
  };

  const endAssignment = (id: string): void => {
    const a = assignments.find((x) => x.id === id);
    if (a !== undefined) tm.reports.upsertTesterAssignment({ ...a, active: false, endDate: today });
  };

  const current = (a: (typeof assignments)[number]): boolean => a.active && (a.endDate === undefined || a.endDate === '' || a.endDate >= today);
  const scopeAssignments = (scope: TestScope) => assignments.filter((a) => (a.userId !== undefined || a.memberId !== undefined) && a.projectId === project.projectId && a.scopeId === scope.id && current(a));
  const wholeProject = assignments.filter((a) => (a.userId !== undefined || a.memberId !== undefined) && a.projectId === project.projectId && a.scopeId === undefined && current(a));
  const assignedKeys = (scope: TestScope): Set<string> => new Set([...scopeAssignments(scope), ...wholeProject].flatMap((a) => [a.userId, a.memberId].filter((x): x is string => x !== undefined)));
  const testerOptions = personOptions(lang, selectableMembers(tm.reports.state.rcsMembers ?? [], { role: ['tester', 'sv'], today }), today);

  return (
    <section className="dr-section">
      <div className="dr-button-row">
        <h2>{t(lang, 'tm.tab.scopes')}</h2>
        <button type="button" className="btn btn-primary" onClick={() => open(null)}>
          {t(lang, 'tm.scope.add')}
        </button>
        <button type="button" className="btn" onClick={() => { setTestRailImporting(true); setEditing(null); setNote(null); }}>
          {t(lang, 'tm.testrailImport.open')}
        </button>
      </div>
      <p className="dr-summary">{t(lang, 'tm.scope.help')}</p>
      <p className="link-help">{t(lang, 'tm.total.help')}</p>
      <RegisteredWarning lang={lang} totals={projectTotals(project, tm.scopes, tm.testCases)} />
      <Notice note={note} />
      {testRailImporting ? (
        <TestRailScopeImportDialog
          lang={lang}
          project={project}
          tm={tm}
          onClose={() => setTestRailImporting(false)}
          onDone={testRailDone}
        />
      ) : null}
      {editing === null ? null : (
        <form
          className="tenancy-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <h3>{t(lang, editing === 'new' ? 'tm.scope.add' : 'tm.scope.edit')}</h3>
          <label className="link-confirm">
            {t(lang, 'tm.field.scopeName')}
            <input className="input" required value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="link-confirm">
            {t(lang, 'tm.field.scopeCode')}
            <input className="input" value={code} maxLength={12} onChange={(e) => setCode(e.target.value)} placeholder="ECO" />
          </label>
          <p className="link-help">{t(lang, 'tm.field.scopeCodeHelp')}</p>
          <label className="link-confirm">
            {t(lang, 'tm.field.description')}
            <input className="input" value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className="dr-button-row">
            <button type="submit" className="btn btn-primary">
              {t(lang, 'tm.save')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>
              {t(lang, 'tenancy.cancel')}
            </button>
          </div>
        </form>
      )}
      {scopes.length === 0 ? (
        <p className="tenancy-empty" role="note">
          {t(lang, 'tm.empty.noScopes')}
        </p>
      ) : (
        <div className="tenancy-table-wrap">
          <table className="tenancy-table">
            <caption className="sr-only">{t(lang, 'tm.tab.scopes')}</caption>
            <thead>
              <tr>
                <th scope="col">{t(lang, 'tm.col.scope')}</th>
                <th scope="col">{t(lang, 'tm.col.totalCases')}</th>
                <th scope="col">{t(lang, 'tm.col.registered')}</th>
                <th scope="col">{t(lang, 'tm.col.testers')}</th>
                <th scope="col">{t(lang, 'tm.col.status')}</th>
                <th scope="col">
                  <span className="sr-only">{t(lang, 'tenancy.list.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {scopes.map((scope) => {
                const count = tm.testCases.filter((c) => c.scopeId === scope.id && c.status === 'active').length;
                const mine = scopeAssignments(scope);
                return (
                  <tr key={scope.id} className={scope.status === 'archived' ? 'tm-archived' : undefined}>
                    <th scope="row" className="tenancy-user-cell">
                      <strong>{scope.name}</strong>
                      {scope.code === undefined ? null : <span>{scope.code}</span>}
                      {/* Linked scopes show the LIVE TestRail run progress (device-local fetch; counts never persist). */}
                      {scope.testrail === undefined ? null : <TestRailScopeProgress lang={lang} scope={scope} />}
                    </th>
                    <td>
                      <ScopeTotalInput lang={lang} value={scope.totalTestCases} label={`${t(lang, 'tm.total.input')}: ${scope.name}`} onCommit={(next) => setTotal(scope, next)} />
                    </td>
                    <td>
                      {count}
                      {scope.totalTestCases !== undefined && count > scope.totalTestCases ? (
                        <div className="tm-warning" role="status">
                          <span aria-hidden="true">⚠ </span>
                          {t(lang, 'tm.total.warnOver', { registered: count, total: scope.totalTestCases })}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {mine.length === 0 && wholeProject.length === 0 ? <span>{t(lang, 'tm.empty.noTesters')}</span> : null}
                      <ul className="cc-people">
                        {mine.map((a) => (
                          <li key={a.id}>
                            {assigneeLabel(lang, a, directory)}{' '}
                            <button type="button" className="btn btn-ghost" onClick={() => endAssignment(a.id)}>
                              {t(lang, 'tm.assign.end')}
                            </button>
                          </li>
                        ))}
                        {wholeProject.map((a) => (
                          <li key={a.id}>
                            {assigneeLabel(lang, a, directory)} <small>({t(lang, 'tm.assign.wholeProject')})</small>
                          </li>
                        ))}
                      </ul>
                      {scope.status === 'active' && api !== null ? (
                        <span className="tenancy-link-row">
                          <select className="input" value={pick[scope.id] ?? ''} aria-label={`${t(lang, 'tm.assign.choose')}: ${scope.name}`} onChange={(e) => setPick((p) => ({ ...p, [scope.id]: e.target.value }))}>
                            <option value="">{t(lang, 'tm.assign.choose')}</option>
                            {testerOptions
                              .filter((x) => !assignedKeys(scope).has(x.memberId) && (x.userId === null || !assignedKeys(scope).has(x.userId)))
                              .map((x) => (
                                <option key={x.memberId} value={x.memberId}>
                                  {personOptionText(lang, x)}
                                </option>
                              ))}
                          </select>
                          <button type="button" className="btn" disabled={busy || (pick[scope.id] ?? '') === ''} onClick={() => void assign(scope)}>
                            {t(lang, 'tm.assign.add')}
                          </button>
                        </span>
                      ) : null}
                    </td>
                    <td>{t(lang, scope.status === 'active' ? 'tm.status.active' : 'tm.status.archived')}</td>
                    <td className="dr-row-actions">
                      <button type="button" className="btn btn-ghost" onClick={() => move(scope, -1)} aria-label={t(lang, 'tm.moveUp')}>
                        ↑
                      </button>
                      <button type="button" className="btn btn-ghost" onClick={() => move(scope, 1)} aria-label={t(lang, 'tm.moveDown')}>
                        ↓
                      </button>
                      <button type="button" className="btn" onClick={() => open(scope)}>
                        {t(lang, 'tm.edit')}
                      </button>
                      <button type="button" className="btn" onClick={() => void archive(scope, scope.status === 'active')}>
                        {t(lang, scope.status === 'active' ? 'tm.scope.archive' : 'tm.reactivate')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---- Test cases ---------------------------------------------------------------------------------

const EMPTY_FORM = { key: '', title: '', priority: 'medium' as CasePriority, type: '', expected: '', description: '', preconditions: '', steps: '', tags: '' };

function CasesTab({ lang, project }: { lang: Language; project: ProjectRecord }) {
  const tm = useTestManagement();
  const scopes = useMemo(() => sortScopes(tm.scopes.filter((s) => s.projectId === project.projectId)), [tm.scopes, project.projectId]);
  const [scopeId, setScopeId] = useState('');
  const scope = scopes.find((s) => s.id === scopeId) ?? scopes.find((s) => s.status === 'active') ?? scopes[0];
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [note, setNote] = useState<Note>(null);
  const [bulk, setBulk] = useState(false);
  const [jiraImporting, setJiraImporting] = useState(false);
  const [testrailImporting, setTestrailImporting] = useState(false);
  const [paste, setPaste] = useState('');
  const [parsed, setParsed] = useState<BulkParse | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const cases = useMemo(
    () => (scope === undefined ? [] : sortCases(filterCases(tm.testCases, tm.byCase, { scopeId: scope.id, includeArchived: showArchived }))),
    [tm.testCases, tm.byCase, scope, showArchived],
  );

  if (scope === undefined) {
    return (
      <section className="dr-section tenancy-empty" role="note">
        <p>{t(lang, 'tm.empty.noScopes')}</p>
      </section>
    );
  }
  const archivedScope = scope.status === 'archived';

  const open = (tc: TestCase | null): void => {
    setEditing(tc === null ? 'new' : tc.id);
    setForm(tc === null ? EMPTY_FORM : { key: tc.key, title: tc.title, priority: tc.priority, type: tc.type ?? '', expected: tc.expected ?? '', description: tc.description ?? '', preconditions: tc.preconditions ?? '', steps: tc.steps ?? '', tags: (tc.tags ?? []).join(', ') });
    setNote(null);
    setBulk(false);
  };

  const input = (): CaseInput => ({ key: form.key, title: form.title, priority: form.priority, type: form.type, expected: form.expected, description: form.description, preconditions: form.preconditions, steps: form.steps, tags: form.tags.split(',') });

  const save = (): void => {
    const now = new Date().toISOString();
    let failed: string | null = null;
    tm.update((state) => {
      if (editing === 'new') {
        const made = newTestCase(state, scope.id, input(), now);
        if (!made.ok) {
          failed = made.error;
          return state;
        }
        return { ...state, testCases: [...state.testCases, made.value] };
      }
      const prev = state.testCases.find((c) => c.id === editing);
      if (prev === undefined) return state;
      const { key: _k, ...rest } = input();
      const made = editTestCase(prev, rest, now);
      if (!made.ok) {
        failed = made.error;
        return state;
      }
      return { ...state, testCases: state.testCases.map((c) => (c.id === prev.id ? made.value : c)) };
    });
    if (failed !== null) setNote({ kind: 'error', text: errorText(lang, failed) });
    else {
      setEditing(null);
      setNote({ kind: 'ok', text: t(lang, 'tm.case.saved') });
    }
  };

  const toggleArchive = (tc: TestCase): void => {
    tm.update((state) => ({ ...state, testCases: state.testCases.map((c) => (c.id === tc.id ? setCaseStatus(c, c.status === 'active' ? 'archived' : 'active', new Date().toISOString()) : c)) }));
  };

  const move = (tc: TestCase, direction: -1 | 1): void => {
    const changed = moveInOrder(cases, tc.id, direction);
    if (changed.length === 0) return;
    const now = new Date().toISOString();
    tm.update((state) => ({ ...state, testCases: state.testCases.map((c) => { const x = changed.find((y) => y.id === c.id); return x === undefined ? c : { ...x, updatedAt: now }; }) }));
  };

  const preview = (): void => setParsed(parseBulkCases(paste, usedKeys(tm.testCases, project.projectId)));

  const confirmBulk = (): void => {
    if (parsed === null || !parsed.ok) return;
    const now = new Date().toISOString();
    let failed: string | null = null;
    let count = 0;
    tm.update((state) => {
      const built = buildBulkCases(state, scope.id, parsed.rows, now);
      if (!built.ok) {
        failed = built.error;
        return state;
      }
      count = built.value.length;
      return { ...state, testCases: [...state.testCases, ...built.value] };
    });
    if (failed !== null) setNote({ kind: 'error', text: errorText(lang, failed) });
    else {
      setNote({ kind: 'ok', text: t(lang, 'tm.bulk.done', { count: parsed.rows.length || count }) });
      setBulk(false);
      setPaste('');
      setParsed(null);
    }
  };

  const set = (k: keyof typeof EMPTY_FORM, v: string): void => setForm((f) => ({ ...f, [k]: v }));

  const jiraDone = (imported: number, duplicates: number, invalid: number): void => {
    setJiraImporting(false);
    const text =
      duplicates + invalid > 0
        ? `${t(lang, 'jira.import.done', { count: imported })} ${t(lang, 'jira.import.doneSkipped', { duplicates, invalid })}`
        : t(lang, 'jira.import.done', { count: imported });
    setNote({ kind: 'ok', text });
  };

  const testrailDone = (imported: number, duplicates: number, invalid: number): void => {
    setTestrailImporting(false);
    const text =
      duplicates + invalid > 0
        ? `${t(lang, 'tm.testrailCases.done', { count: imported })} ${t(lang, 'tm.testrailCases.doneSkipped', { duplicates, invalid })}`
        : t(lang, 'tm.testrailCases.done', { count: imported });
    setNote({ kind: 'ok', text });
  };

  return (
    <section className="dr-section">
      <div className="dr-button-row">
        <h2>{t(lang, 'tm.tab.cases')}</h2>
        <label className="dr-toolbar-field">
          {t(lang, 'tm.col.scope')}
          <select className="input" value={scope.id} onChange={(e) => setScopeId(e.target.value)}>
            {scopes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.status === 'archived' ? ` (${t(lang, 'tm.status.archived')})` : ''}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-primary" disabled={archivedScope} onClick={() => open(null)}>
          {t(lang, 'tm.case.add')}
        </button>
        <button type="button" className="btn" disabled={archivedScope} onClick={() => { setBulk(true); setEditing(null); setNote(null); }}>
          {t(lang, 'tm.bulk.open')}
        </button>
        <button type="button" className="btn" disabled={archivedScope} onClick={() => { setJiraImporting(true); setEditing(null); setBulk(false); setNote(null); }}>
          {t(lang, 'jira.import.open')}
        </button>
        {/* Only a scope linked to a TestRail run can import that run's suite cases. */}
        <button
          type="button"
          className="btn"
          disabled={archivedScope || scope.testrail === undefined}
          title={scope.testrail === undefined ? t(lang, 'tm.testrailCases.noLink') : undefined}
          onClick={() => { setTestrailImporting(true); setEditing(null); setBulk(false); setNote(null); }}
        >
          {t(lang, 'tm.testrailCases.open')}
        </button>
        <label className="tm-check">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> {t(lang, 'tm.showArchived')}
        </label>
      </div>
      <Notice note={note} />
      {editing === null ? null : (
        <form
          className="tenancy-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <h3>{t(lang, editing === 'new' ? 'tm.case.add' : 'tm.case.edit')}</h3>
          <label className="link-confirm">
            {t(lang, 'tm.field.key')}
            <input className="input" value={form.key} maxLength={40} disabled={editing !== 'new'} placeholder={t(lang, 'tm.field.keyAuto')} onChange={(e) => set('key', e.target.value)} />
          </label>
          <label className="link-confirm">
            {t(lang, 'tm.col.title')}
            <input className="input" required value={form.title} maxLength={200} onChange={(e) => set('title', e.target.value)} />
          </label>
          <label className="link-confirm">
            {t(lang, 'tm.col.priority')}
            <select className="input" value={form.priority} onChange={(e) => set('priority', e.target.value)}>
              {CASE_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t(lang, `tm.priority.${p}` as TranslationKey)}
                </option>
              ))}
            </select>
          </label>
          <label className="link-confirm">
            {t(lang, 'tm.field.type')}
            <input className="input" value={form.type} maxLength={40} onChange={(e) => set('type', e.target.value)} />
          </label>
          <label className="link-confirm">
            {t(lang, 'tm.field.expected')}
            <input className="input" value={form.expected} maxLength={2000} onChange={(e) => set('expected', e.target.value)} />
          </label>
          <label className="link-confirm">
            {t(lang, 'tm.field.preconditions')}
            <input className="input" value={form.preconditions} maxLength={2000} onChange={(e) => set('preconditions', e.target.value)} />
          </label>
          <label className="link-confirm">
            {t(lang, 'tm.field.steps')}
            <textarea className="input" rows={3} value={form.steps} maxLength={8000} onChange={(e) => set('steps', e.target.value)} />
          </label>
          <label className="link-confirm">
            {t(lang, 'tm.field.description')}
            <input className="input" value={form.description} maxLength={4000} onChange={(e) => set('description', e.target.value)} />
          </label>
          <label className="link-confirm">
            {t(lang, 'tm.field.tags')}
            <input className="input" value={form.tags} onChange={(e) => set('tags', e.target.value)} />
          </label>
          <div className="dr-button-row">
            <button type="submit" className="btn btn-primary">
              {t(lang, 'tm.save')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>
              {t(lang, 'tenancy.cancel')}
            </button>
          </div>
        </form>
      )}
      {!bulk ? null : (
        <div className="tenancy-form tm-bulk">
          <h3>{t(lang, 'tm.bulk.open')}</h3>
          <p className="link-help">{t(lang, 'tm.bulk.help')}</p>
          <textarea className="input tm-paste" rows={8} value={paste} aria-label={t(lang, 'tm.bulk.open')} placeholder={t(lang, 'tm.bulk.placeholder')} onChange={(e) => { setPaste(e.target.value); setParsed(null); }} />
          <div className="dr-button-row">
            <button type="button" className="btn" disabled={paste.trim() === ''} onClick={preview}>
              {t(lang, 'tm.bulk.preview')}
            </button>
            <button type="button" className="btn btn-primary" disabled={parsed === null || !parsed.ok} onClick={confirmBulk}>
              {t(lang, 'tm.bulk.confirm', { count: parsed?.rows.length ?? 0 })}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => { setBulk(false); setParsed(null); }}>
              {t(lang, 'tenancy.cancel')}
            </button>
          </div>
          {parsed === null ? null : parsed.errors.length > 0 ? (
            <div role="alert" className="qa-warning">
              <strong>{t(lang, 'tm.bulk.errors', { count: parsed.errors.length })}</strong>
              <ul>
                {parsed.errors.slice(0, 50).map((e, i) => (
                  <li key={`${e.line}-${i}`}>
                    {e.line > 0 ? `${t(lang, 'tm.bulk.line', { line: e.line })}: ` : ''}
                    {t(lang, `tm.bulk.err.${e.code}` as TranslationKey, { value: e.value ?? '' })}
                  </li>
                ))}
              </ul>
              <p>{t(lang, 'tm.bulk.nothingSaved')}</p>
            </div>
          ) : (
            <div className="tenancy-table-wrap">
              <p role="status">{t(lang, 'tm.bulk.valid', { count: parsed.rows.length })}</p>
              <table className="tenancy-table">
                <thead>
                  <tr>
                    <th scope="col">{t(lang, 'tm.field.key')}</th>
                    <th scope="col">{t(lang, 'tm.col.title')}</th>
                    <th scope="col">{t(lang, 'tm.col.priority')}</th>
                    <th scope="col">{t(lang, 'tm.field.type')}</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.slice(0, 20).map((r) => (
                    <tr key={r.line}>
                      <td>{r.key ?? t(lang, 'tm.field.keyAuto')}</td>
                      <td>{r.title}</td>
                      <td>{t(lang, `tm.priority.${r.priority}` as TranslationKey)}</td>
                      <td>{r.type ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsed.rows.length > 20 ? <p className="link-help">{t(lang, 'tm.bulk.more', { count: parsed.rows.length - 20 })}</p> : null}
            </div>
          )}
        </div>
      )}
      {jiraImporting ? (
        <JiraImportDialog
          lang={lang}
          scope={scope}
          tm={tm}
          onClose={() => setJiraImporting(false)}
          onDone={jiraDone}
        />
      ) : null}
      {testrailImporting ? (
        <TestRailCaseImportDialog
          lang={lang}
          scope={scope}
          tm={tm}
          onClose={() => setTestrailImporting(false)}
          onDone={testrailDone}
        />
      ) : null}
      {cases.length === 0 ? (
        <div className="tenancy-empty" role="note">
          <p>{t(lang, 'tm.empty.noCases')}</p>
        </div>
      ) : (
        <div className="tenancy-table-wrap tm-grid-wrap">
          <table className="tenancy-table tm-grid">
            <caption className="sr-only">{t(lang, 'tm.tab.cases')}</caption>
            <thead>
              <tr>
                <th scope="col">{t(lang, 'tm.col.case')}</th>
                <th scope="col">{t(lang, 'tm.col.title')}</th>
                <th scope="col">{t(lang, 'tm.col.priority')}</th>
                <th scope="col">{t(lang, 'tm.field.type')}</th>
                <th scope="col">{t(lang, 'tm.field.tags')}</th>
                <th scope="col">{t(lang, 'tm.col.status')}</th>
                <th scope="col">
                  <span className="sr-only">{t(lang, 'tenancy.list.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {cases.slice(0, 500).map((tc) => (
                <tr key={tc.id} className={tc.status === 'archived' ? 'tm-archived' : undefined}>
                  <th scope="row" className="tm-key">
                    {tc.key}
                  </th>
                  <td>{tc.title}</td>
                  <td>{t(lang, `tm.priority.${tc.priority}` as TranslationKey)}</td>
                  <td>{tc.type ?? '—'}</td>
                  <td>{(tc.tags ?? []).join(', ') || '—'}</td>
                  <td>{t(lang, tc.status === 'active' ? 'tm.status.active' : 'tm.status.archived')}</td>
                  <td className="dr-row-actions">
                    <button type="button" className="btn btn-ghost" onClick={() => move(tc, -1)} aria-label={t(lang, 'tm.moveUp')}>
                      ↑
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => move(tc, 1)} aria-label={t(lang, 'tm.moveDown')}>
                      ↓
                    </button>
                    <button type="button" className="btn" onClick={() => open(tc)}>
                      {t(lang, 'tm.edit')}
                    </button>
                    <button type="button" className="btn" onClick={() => toggleArchive(tc)}>
                      {t(lang, tc.status === 'active' ? 'tm.case.archive' : 'tm.reactivate')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {cases.length > 500 ? <p className="link-help">{t(lang, 'tm.case.truncated', { count: cases.length - 500 })}</p> : null}
        </div>
      )}
    </section>
  );
}


