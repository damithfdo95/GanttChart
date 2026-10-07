import { useMemo, useState } from 'react';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { useConfirm } from '../../components/ConfirmDialog';
import { t, type TranslationKey } from '../../i18n';
import { CYCLE_TRANSITIONS, createCycle, editCycle, projectsWithMissingCycle, projectsWithoutCycle, setCycleStatus, sortCycles, withProjectCycle, type CycleInput } from '../../domain/cycles';
import { assignedPeople, cycleSummary, projectMetrics, projectRiskSignals, recentActivity, type RiskContext } from '../../domain/qaMetrics';
import { toCsv } from '../../lib/export/csv';
import { downloadTextFile } from '../../lib/export/download';
import { formatDate, todayEpochDays } from '../../lib/dates/dates';
import type { Cycle, CycleStatus, Language, ProjectRecord } from '../../types';
import { MetricsGrid, RiskBadge, RiskList, percent, useIsQaAdmin, useTesters } from './parts';

const PROJECT_STATUS_KEY: Record<ProjectRecord['status'], TranslationKey> = {
  todo: 'overall.todo',
  ongoing: 'overall.ongoing',
  extended: 'overall.extended',
  onHold: 'overall.onHold',
  done: 'overall.done',
};

const GENERIC_ERRORS = new Set(['cycle_invalid_name', 'cycle_invalid_date', 'cycle_end_before_start', 'cycle_invalid_version', 'cycle_invalid_description', 'cycle_not_found', 'cycle_archived', 'cycle_transition_not_allowed']);
export const cycleErrorKey = (code: string): TranslationKey => (GENERIC_ERRORS.has(code) ? `cycles.error.${code}` : 'cycles.error.generic') as TranslationKey;

export function CycleStatusBadge({ lang, status }: { lang: Language; status: CycleStatus }) {
  const symbol = status === 'active' ? '●' : status === 'planned' ? '○' : status === 'completed' ? '✓' : '▣';
  return (
    <span className={`status-badge status-cycle-${status}`}>
      <span aria-hidden="true">{symbol} </span>
      {t(lang, `cycles.status.${status}` as TranslationKey)}
    </span>
  );
}

/** Cycles / Releases: the list, and one cycle's detail. Everyone in the workspace can read; only the Admin changes. */
export function CyclesScreen() {
  const app = useAppStateCtx();
  const reports = useReportsStateCtx();
  const lang = app.state.language;
  const isAdmin = useIsQaAdmin();
  const today = formatDate(todayEpochDays());
  const cycles = reports.state.cycles ?? [];
  const projects = reports.state.projects;
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<'new' | string | null>(null);
  const ctx: RiskContext = useMemo(() => ({ today, nowIso: new Date().toISOString(), assignments: reports.state.testerAssignments ?? [] }), [today, reports.state.testerAssignments]);

  const open = openId === null ? null : (cycles.find((c) => c.id === openId) ?? null);
  const sorted = useMemo(() => sortCycles(cycles), [cycles]);
  const missing = projectsWithMissingCycle(projects, cycles);

  if (editing !== null) {
    const existing = editing === 'new' ? null : (cycles.find((c) => c.id === editing) ?? null);
    return (
      <div className="app">
        <CycleForm
          lang={lang}
          cycle={existing}
          onCancel={() => setEditing(null)}
          onSave={(cycle) => {
            reports.upsertCycle(cycle);
            setEditing(null);
            setOpenId(cycle.id);
          }}
        />
      </div>
    );
  }

  if (open !== null) {
    return (
      <div className="app">
        <CycleDetail lang={lang} cycle={open} isAdmin={isAdmin} ctx={ctx} onBack={() => setOpenId(null)} onEdit={() => setEditing(open.id)} />
      </div>
    );
  }

  return (
    <div className="app cycles-screen">
      <header className="dr-section">
        <div className="dr-button-row">
          <h1>{t(lang, 'cycles.title')}</h1>
          {isAdmin ? (
            <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
              {t(lang, 'cycles.new')}
            </button>
          ) : null}
        </div>
        <p className="dr-summary">{t(lang, 'cycles.help')}</p>
        {isAdmin ? null : <p className="link-help">{t(lang, 'cycles.readonlyNote')}</p>}
        {projectsWithoutCycle(projects).length > 0 && cycles.length > 0 ? <p className="link-help">{t(lang, 'cycles.unassignedProjects', { count: projectsWithoutCycle(projects).length })}</p> : null}
        {missing.length > 0 ? (
          <p role="alert" className="qa-warning">
            <span aria-hidden="true">⚠ </span>
            {t(lang, 'cycles.missing', { count: missing.length })}
          </p>
        ) : null}
      </header>

      {sorted.length === 0 ? (
        <div className="tenancy-empty" role="note">
          <strong>{t(lang, 'cycles.empty.title')}</strong>
          <p>{t(lang, isAdmin ? 'cycles.empty.body' : 'cycles.empty.bodyReadonly')}</p>
        </div>
      ) : (
        <div className="tenancy-table-wrap">
          <table className="tenancy-table">
            <caption className="sr-only">{t(lang, 'cycles.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t(lang, 'cycles.col.name')}</th>
                <th scope="col">{t(lang, 'cycles.col.status')}</th>
                <th scope="col">{t(lang, 'cycles.col.dates')}</th>
                <th scope="col">{t(lang, 'cycles.col.projects')}</th>
                <th scope="col">{t(lang, 'cycles.col.progress')}</th>
                <th scope="col">{t(lang, 'cycles.col.passRate')}</th>
                <th scope="col">{t(lang, 'cycles.col.risk')}</th>
                <th scope="col">
                  <span className="sr-only">{t(lang, 'tenancy.list.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((cycle) => {
                const s = cycleSummary(cycle, projects, ctx);
                return (
                  <tr key={cycle.id}>
                    <th scope="row" className="tenancy-user-cell">
                      <strong>{cycle.name}</strong>
                      {cycle.version === undefined ? null : <span>{cycle.version}</span>}
                    </th>
                    <td>
                      <CycleStatusBadge lang={lang} status={cycle.status} />
                    </td>
                    <td>{datesText(lang, cycle)}</td>
                    <td>{s.projects.length}</td>
                    <td>{percent(s.metrics.completion)}</td>
                    <td>{percent(s.metrics.passRate)}</td>
                    <td>
                      <RiskBadge lang={lang} signals={s.riskSignals} />
                    </td>
                    <td>
                      <button type="button" className="btn" onClick={() => setOpenId(cycle.id)}>
                        {t(lang, 'cycles.open')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function datesText(lang: Language, c: Pick<Cycle, 'plannedStart' | 'plannedEnd'>): string {
  if (c.plannedStart === null && c.plannedEnd === null) return t(lang, 'cycles.noDates');
  return `${c.plannedStart ?? '…'} → ${c.plannedEnd ?? '…'}`;
}

function CycleForm({ lang, cycle, onSave, onCancel }: { lang: Language; cycle: Cycle | null; onSave: (c: Cycle) => void; onCancel: () => void }) {
  const [name, setName] = useState(cycle?.name ?? '');
  const [version, setVersion] = useState(cycle?.version ?? '');
  const [description, setDescription] = useState(cycle?.description ?? '');
  const [start, setStart] = useState(cycle?.plannedStart ?? '');
  const [end, setEnd] = useState(cycle?.plannedEnd ?? '');
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (): void => {
    const input: CycleInput = { name, version, description, plannedStart: start === '' ? null : start, plannedEnd: end === '' ? null : end };
    const now = new Date().toISOString();
    const result = cycle === null ? createCycle(input, now) : editCycle(cycle, input, now);
    if (result.ok) onSave(result.value);
    else setProblem(t(lang, cycleErrorKey(result.error)));
  };

  return (
    <form
      className="tenancy-form dr-section"
      aria-labelledby="cycle-form-title"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h1 id="cycle-form-title">{t(lang, cycle === null ? 'cycles.form.titleNew' : 'cycles.form.titleEdit')}</h1>
      <label className="link-confirm">
        {t(lang, 'cycles.form.name')}
        <input className="input" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="link-confirm">
        {t(lang, 'cycles.form.version')}
        <input className="input" maxLength={60} value={version} onChange={(e) => setVersion(e.target.value)} />
      </label>
      <label className="link-confirm">
        {t(lang, 'cycles.form.description')}
        <textarea className="input" rows={3} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="link-confirm">
        {t(lang, 'cycles.form.start')}
        <input className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
      </label>
      <label className="link-confirm">
        {t(lang, 'cycles.form.end')}
        <input className="input" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
      </label>
      <div aria-live="polite">
        {problem === null ? null : (
          <p role="alert" className="data-controls-message error">
            {problem}
          </p>
        )}
      </div>
      <div className="dr-button-row">
        <button type="submit" className="btn btn-primary" disabled={name.trim() === ''}>
          {t(lang, 'cycles.form.save')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          {t(lang, 'tenancy.cancel')}
        </button>
      </div>
    </form>
  );
}

function CycleDetail({ lang, cycle, isAdmin, ctx, onBack, onEdit }: { lang: Language; cycle: Cycle; isAdmin: boolean; ctx: RiskContext; onBack: () => void; onEdit: () => void }) {
  const reports = useReportsStateCtx();
  const confirm = useConfirm();
  const { testers } = useTesters();
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [addId, setAddId] = useState('');
  const projects = reports.state.projects;
  const cycles = reports.state.cycles ?? [];
  const summary = cycleSummary(cycle, projects, ctx);
  const members = reports.state.rcsMembers ?? [];
  const assignments = reports.state.testerAssignments ?? [];
  const activity = recentActivity(summary.projects, ctx.today, 7);

  const people = useMemo(() => {
    const seen = new Map<string, { name: string; disabled: boolean }>();
    for (const p of summary.projects) {
      for (const person of assignedPeople(assignments, p.projectId, ctx.today, members)) {
        const key = person.userId ?? person.memberId ?? person.name;
        const account = person.userId === undefined ? undefined : testers?.find((x) => x.id === person.userId);
        seen.set(key, { name: account?.displayName ?? person.name, disabled: account?.status === 'disabled' });
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [summary.projects, assignments, members, testers, ctx.today]);

  const move = (project: ProjectRecord, target: string | null): void => {
    const result = withProjectCycle(project, target, cycles, new Date().toISOString());
    if (!result.ok) {
      setMessage({ kind: 'error', text: t(lang, cycleErrorKey(result.error)) });
      return;
    }
    reports.updateProject(project.id, { cycleId: result.value.cycleId ?? null, updatedAt: result.value.updatedAt });
    setMessage({ kind: 'ok', text: t(lang, target === null ? 'cycles.detail.removed' : 'cycles.detail.added', { name: project.nameEn || project.nameJa || project.projectId }) });
  };

  const changeStatus = async (to: CycleStatus): Promise<void> => {
    if (to === 'completed' || to === 'archived') {
      const ok = await confirm({
        title: t(lang, `cycles.confirm.${to}.title` as TranslationKey, { name: cycle.name }),
        body: <p>{t(lang, `cycles.confirm.${to}.body` as TranslationKey)}</p>,
        confirmLabel: t(lang, `cycles.action.${cycle.status}_${to}` as TranslationKey),
        cancelLabel: t(lang, 'tenancy.cancel'),
        severity: 'warning',
      });
      if (!ok) return;
    }
    const result = setCycleStatus(cycle, to, new Date().toISOString());
    if (!result.ok) setMessage({ kind: 'error', text: t(lang, cycleErrorKey(result.error)) });
    else reports.upsertCycle(result.value);
  };

  const candidates = projects.filter((p) => p.cycleId !== cycle.id && p.status !== 'done');

  const exportCsv = (): void => {
    const rows = summary.projects.map((p) => {
      const m = projectMetrics(p);
      return [cycle.name, cycle.version ?? '', t(lang, `cycles.status.${cycle.status}` as TranslationKey), p.projectId, p.nameEn || p.nameJa, t(lang, PROJECT_STATUS_KEY[p.status]), m.planned, m.executed, m.passed, m.failed, m.blocked, m.remaining, percent(m.completion), percent(m.passRate), assignedPeople(assignments, p.projectId, ctx.today, members).map((x) => x.name).join('; ')];
    });
    const headers = ['Cycle', 'Release', 'Cycle status', 'Project ID', 'Project', 'Project status', 'Planned', 'Executed', 'Passed', 'Failed', 'Blocked', 'Remaining', 'Completion', 'Pass rate', 'Testers'];
    downloadTextFile(`cycle-${cycle.name.replace(/[^\p{L}\p{N}]+/gu, '-')}-${ctx.today}.csv`, 'text/csv;charset=utf-8', toCsv(headers, rows));
  };

  return (
    <div className="cycle-detail">
      <header className="dr-section">
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          ← {t(lang, 'cycles.back')}
        </button>
        <h1>
          {cycle.name} {cycle.version === undefined ? null : <small>({cycle.version})</small>}
        </h1>
        <p>
          <CycleStatusBadge lang={lang} status={cycle.status} /> · {datesText(lang, cycle)}
          {cycle.completedAt === null ? null : ` · ${t(lang, 'cycles.completedOn', { date: cycle.completedAt.slice(0, 10) })}`}
        </p>
        {cycle.description === undefined ? null : <p className="dr-summary">{cycle.description}</p>}
        {isAdmin ? (
          <div className="dr-button-row">
            <button type="button" className="btn" onClick={onEdit}>
              {t(lang, 'cycles.edit')}
            </button>
            {CYCLE_TRANSITIONS[cycle.status].map((to) => (
              <button key={to} type="button" className="btn" onClick={() => void changeStatus(to)}>
                {t(lang, `cycles.action.${cycle.status}_${to}` as TranslationKey)}
              </button>
            ))}
            <button type="button" className="btn btn-ghost" onClick={exportCsv} disabled={summary.projects.length === 0}>
              {t(lang, 'cycles.detail.export')}
            </button>
          </div>
        ) : (
          <>
            <p className="link-help">{t(lang, 'cycles.readonlyNote')}</p>
            <button type="button" className="btn btn-ghost" onClick={exportCsv} disabled={summary.projects.length === 0}>
              {t(lang, 'cycles.detail.export')}
            </button>
          </>
        )}
        <div aria-live="polite">
          {message === null ? null : (
            <p role={message.kind === 'error' ? 'alert' : 'status'} className={`data-controls-message ${message.kind}`}>
              {message.text}
            </p>
          )}
        </div>
      </header>

      <section className="dr-section" aria-labelledby="cycle-summary-title">
        <h2 id="cycle-summary-title">{t(lang, 'cycles.detail.summary')}</h2>
        <MetricsGrid lang={lang} m={summary.metrics} />
        <h3>{t(lang, 'cycles.detail.risk')}</h3>
        <RiskList lang={lang} signals={summary.riskSignals} />
      </section>

      <section className="dr-section" aria-labelledby="cycle-projects-title">
        <h2 id="cycle-projects-title">{t(lang, 'cycles.detail.projects')}</h2>
        {summary.projects.length === 0 ? (
          <div className="tenancy-empty" role="note">
            <p>{t(lang, 'cycles.detail.noProjects')}</p>
          </div>
        ) : (
          <div className="tenancy-table-wrap">
            <table className="tenancy-table">
              <caption className="sr-only">{t(lang, 'cycles.detail.projects')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t(lang, 'cycles.detail.col.project')}</th>
                  <th scope="col">{t(lang, 'cycles.detail.col.status')}</th>
                  <th scope="col">{t(lang, 'cycles.detail.col.progress')}</th>
                  <th scope="col">{t(lang, 'cycles.detail.col.results')}</th>
                  <th scope="col">{t(lang, 'cycles.detail.col.testers')}</th>
                  <th scope="col">{t(lang, 'cycles.detail.col.risk')}</th>
                  <th scope="col">
                    <span className="sr-only">{t(lang, 'tenancy.list.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {summary.projects.map((p) => {
                  const m = projectMetrics(p);
                  const signals = projectRiskSignals(p, ctx);
                  const names = assignedPeople(assignments, p.projectId, ctx.today, members).map((x) => x.name);
                  return (
                    <tr key={p.id}>
                      <th scope="row" className="tenancy-user-cell">
                        <strong>{p.nameEn || p.nameJa || p.projectId}</strong>
                        <code>{p.projectId}</code>
                      </th>
                      <td>{t(lang, PROJECT_STATUS_KEY[p.status])}</td>
                      <td>
                        {percent(m.completion)} ({m.completed}/{m.planned})
                      </td>
                      <td>
                        {t(lang, 'qa.passed')} {m.passed} · {t(lang, 'qa.failed')} {m.failed} · {t(lang, 'qa.blocked')} {m.blocked}
                      </td>
                      <td>{names.length === 0 ? t(lang, 'cycles.detail.nobody') : names.join(', ')}</td>
                      <td>
                        <RiskBadge lang={lang} signals={signals} />
                      </td>
                      <td>
                        {isAdmin ? (
                          <button type="button" className="btn" onClick={() => move(p, null)}>
                            {t(lang, 'cycles.detail.remove')}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {isAdmin && cycle.status !== 'archived' ? (
          <div className="tenancy-controls">
            <label>
              {t(lang, 'cycles.detail.addProject')}
              <select className="input" value={addId} onChange={(e) => setAddId(e.target.value)}>
                <option value="">{t(lang, 'cycles.detail.addPlaceholder')}</option>
                {candidates.map((p) => {
                  const from = p.cycleId === undefined || p.cycleId === null ? null : cycles.find((c) => c.id === p.cycleId);
                  return (
                    <option key={p.id} value={p.id}>
                      {p.projectId} · {p.nameEn || p.nameJa}
                      {from === null ? '' : ` — ${t(lang, 'cycles.detail.currentlyIn', { name: from?.name ?? '?' })}`}
                    </option>
                  );
                })}
              </select>
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={addId === ''}
              onClick={() => {
                const p = projects.find((x) => x.id === addId);
                if (p !== undefined) move(p, cycle.id);
                setAddId('');
              }}
            >
              {t(lang, 'cycles.detail.add')}
            </button>
          </div>
        ) : null}
      </section>

      <section className="dr-section" aria-labelledby="cycle-people-title">
        <h2 id="cycle-people-title">{t(lang, 'cycles.detail.testers')}</h2>
        {people.length === 0 ? (
          <p>{t(lang, 'cycles.detail.noTesters')}</p>
        ) : (
          <ul>
            {people.map((x) => (
              <li key={x.name}>
                {x.name}
                {x.disabled ? ` — ${t(lang, 'tenancy.userStatus.disabled')}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="dr-section" aria-labelledby="cycle-activity-title">
        <h2 id="cycle-activity-title">{t(lang, 'cycles.detail.recent')}</h2>
        {activity.length === 0 ? (
          <p>{t(lang, 'cycles.detail.noRecent')}</p>
        ) : (
          <div className="tenancy-table-wrap">
            <table className="tenancy-table">
              <thead>
                <tr>
                  <th scope="col">{t(lang, 'cycles.detail.col.date')}</th>
                  <th scope="col">{t(lang, 'qa.executed')}</th>
                  <th scope="col">{t(lang, 'qa.passed')}</th>
                  <th scope="col">{t(lang, 'qa.failed')}</th>
                  <th scope="col">{t(lang, 'qa.blocked')}</th>
                </tr>
              </thead>
              <tbody>
                {activity.map((row) => (
                  <tr key={row.date}>
                    <th scope="row">{row.date}</th>
                    <td>{row.executed}</td>
                    <td>{row.passed}</td>
                    <td>{row.failed}</td>
                    <td>{row.blocked}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
