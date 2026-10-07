import { useMemo, useState } from 'react';
import { useReportsStateCtx } from '../../app/state-contexts';
import { useTenant } from '../../app/tenant-context';
import { t, type TranslationKey } from '../../i18n';
import { ApiError } from '../../lib/tenancy/api';
import { formatDate, todayEpochDays } from '../../lib/dates/dates';
import { withProjectCycle } from '../../domain/cycles';
import { assignedPeople, isAssignmentCurrent, projectMetrics, projectRiskSignals, type RiskContext } from '../../domain/qaMetrics';
import { MetricsGrid, RiskBadge, RiskList, useIsQaAdmin, useTesters } from '../cycles/parts';
import type { Language } from '../../types';

const ASSIGN_ERRORS = new Set(['tester_disabled', 'tester_not_found', 'project_not_found', 'forbidden']);

/**
 * The active project as a QA execution control center: its cycle, schedule, results, risk, who is on it and the tickets
 * recorded for it. The Admin can move it between cycles and assign Testers; everyone else reads.
 */
export function ProjectControlCenter({ lang }: { lang: Language }) {
  const reports = useReportsStateCtx();
  const { principal, api } = useTenant();
  const isAdmin = useIsQaAdmin();
  const { testers } = useTesters();
  const [pick, setPick] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const today = formatDate(todayEpochDays());
  const state = reports.state;
  const project = state.projects.find((p) => p.id === state.activeProjectId) ?? null;
  const cycles = state.cycles ?? [];
  const assignments = state.testerAssignments ?? [];
  const members = state.rcsMembers ?? [];
  const ctx: RiskContext = useMemo(() => ({ today, nowIso: new Date().toISOString(), assignments }), [today, assignments]);
  if (project === null) return null;

  const metrics = projectMetrics(project);
  const signals = projectRiskSignals(project, ctx);
  const cycle = project.cycleId === undefined || project.cycleId === null ? null : (cycles.find((c) => c.id === project.cycleId) ?? null);
  const people = assignedPeople(assignments, project.projectId, today, members);
  const entries = project.inputs.dailyExecuted ?? [];
  const lastActivity = entries.reduce((max, e) => (e.date > max ? e.date : max), '');
  const tickets = project.inputs.bugTickets?.length ?? 0;
  const canAssign = isAdmin && principal !== null && principal.sharedWorkspace && api !== null && testers !== null;
  const assignedUserIds = new Set(assignments.filter((a) => a.projectId === project.projectId && isAssignmentCurrent(a, today)).map((a) => a.userId));
  const available = (testers ?? []).filter((x) => x.status === 'active' && !assignedUserIds.has(x.id));

  const moveCycle = (target: string): void => {
    const result = withProjectCycle(project, target === '' ? null : target, cycles, new Date().toISOString());
    if (!result.ok) setMessage({ kind: 'error', text: t(lang, `cycles.error.${result.error}` as TranslationKey) });
    else reports.updateProject(project.id, { cycleId: result.value.cycleId ?? null, updatedAt: result.value.updatedAt });
  };

  const assign = async (): Promise<void> => {
    if (api === null || pick === '') return;
    setBusy(true);
    setMessage(null);
    try {
      await api.assignTester(project.projectId, pick);
      setPick('');
      setMessage({ kind: 'ok', text: t(lang, 'cc.assigned') });
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      setMessage({ kind: 'error', text: t(lang, (ASSIGN_ERRORS.has(code) ? `cc.assignError.${code}` : 'cc.assignError.generic') as TranslationKey) });
    } finally {
      setBusy(false);
    }
  };

  const endAssignment = (id: string): void => {
    const a = assignments.find((x) => x.id === id);
    if (a !== undefined) reports.upsertTesterAssignment({ ...a, active: false, endDate: today });
  };

  return (
    <section className="dr-section control-center" aria-labelledby="cc-title">
      <div className="dr-button-row">
        <h2 id="cc-title">{t(lang, 'cc.title')}</h2>
        <RiskBadge lang={lang} signals={signals} />
      </div>
      <dl className="cc-facts">
        <dt>{t(lang, 'cc.cycle')}</dt>
        <dd>
          {isAdmin && cycles.length > 0 ? (
            <select className="input" aria-label={t(lang, 'cc.cycle')} value={project.cycleId ?? ''} onChange={(e) => moveCycle(e.target.value)}>
              <option value="">{t(lang, 'cc.noCycle')}</option>
              {cycles
                .filter((c) => c.status !== 'archived' || c.id === project.cycleId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.version === undefined ? '' : ` (${c.version})`}
                  </option>
                ))}
            </select>
          ) : cycle !== null ? (
            `${cycle.name}${cycle.version === undefined ? '' : ` (${cycle.version})`}`
          ) : (
            t(lang, 'cc.noCycle')
          )}
        </dd>
        <dt>{t(lang, 'cc.schedule')}</dt>
        <dd>
          {project.inputs.startDate} → {project.inputs.targetCompletionDate ?? '—'}
        </dd>
        <dt>{t(lang, 'cc.latestActivity')}</dt>
        <dd>{lastActivity === '' ? t(lang, 'cc.noActivity') : lastActivity}</dd>
        <dt>{t(lang, 'cc.tickets')}</dt>
        <dd>{tickets}</dd>
      </dl>

      <MetricsGrid lang={lang} m={metrics} />

      <h3>{t(lang, 'cc.risk')}</h3>
      <RiskList lang={lang} signals={signals} />

      <h3>{t(lang, 'cc.testers')}</h3>
      {people.length === 0 ? (
        <p>{t(lang, 'cc.nobody')}</p>
      ) : (
        <ul className="cc-people">
          {people.map((person) => {
            const account = person.userId === undefined ? undefined : testers?.find((x) => x.id === person.userId);
            const disabled = account?.status === 'disabled';
            return (
              <li key={person.assignmentId}>
                {account?.displayName ?? person.name}
                {account === undefined ? '' : ` (${account.email})`}
                {disabled ? ` — ⏸ ${t(lang, 'tenancy.userStatus.disabled')}` : ''}
                {isAdmin ? (
                  <button type="button" className="btn btn-ghost" onClick={() => endAssignment(person.assignmentId)}>
                    {t(lang, 'cc.endAssignment')}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {canAssign ? (
        <div className="tenancy-controls">
          <label>
            {t(lang, 'cc.assignTester')}
            <select className="input" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">{t(lang, 'cc.assignPlaceholder')}</option>
              {available.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.displayName ?? x.email}
                  {x.displayName === null ? '' : ` (${x.email})`}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-primary" disabled={busy || pick === ''} onClick={() => void assign()}>
            {t(lang, 'cc.assign')}
          </button>
        </div>
      ) : isAdmin ? (
        <p className="link-help">{t(lang, 'cc.accountsNeedWeb')}</p>
      ) : null}
      <div aria-live="polite">
        {message === null ? null : (
          <p role={message.kind === 'error' ? 'alert' : 'status'} className={`data-controls-message ${message.kind}`}>
            {message.text}
          </p>
        )}
      </div>
    </section>
  );
}
