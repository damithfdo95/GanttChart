import { Fragment, useEffect, useMemo, useState } from 'react';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { useAccess } from '../../app/access';
import { resolveBilingualName, t, type TranslationKey } from '../../i18n';
import { formatDateDisplay, parseDate } from '../../lib/dates/dates';
import { formatInteger } from '../../lib/formatting/format';
import { formatClock } from '../../lib/formatting/format';
import { assigneeLabel, compactNames } from '../../domain/people';
import { buildMeeting, confirmMorning, nextBusinessDate, setNote, setPlan, type MeetingProjectRow, type MeetingScopeRow, type NoteField } from '../../domain/meeting';
import { useBusinessToday, usePeopleDirectory } from '../testManagement/useTestManagement';
import { MeetingGantt } from './MeetingGantt';
import { MeetingRiskBadge, MeetingRiskList, NoteBox, PlanInput } from './MeetingParts';
import type { Language, ProjectRecord } from '../../types';

export type MeetingSession = 'morning' | 'evening';

const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);

/**
 * The SV's team meeting (Stage 8D): the WHOLE team's day on one screen, presented in the Morning (what is planned today) and the Evening
 * (what happened against it, and tomorrow's plan). It is tenant-wide and row-per-project (with scopes beneath), never per person.
 * "Present" hides every editing control; the same numbers stay on screen.
 */
export function MeetingView({ initialSession = 'morning' }: { initialSession?: MeetingSession }) {
  const access = useAccess();
  const lang = useLanguage();
  return access.isTester ? (
    <section className="dr-section" role="note">
      <p>{t(lang, 'mt.svOnly')}</p>
    </section>
  ) : (
    <MeetingBoard initialSession={initialSession} />
  );
}

function MeetingBoard({ initialSession }: { initialSession: MeetingSession }) {
  const reports = useReportsStateCtx();
  const lang = useLanguage();
  const today = useBusinessToday();
  const tomorrow = useMemo(() => nextBusinessDate(today), [today]);
  const [session, setSession] = useState<MeetingSession>(initialSession);
  const [presenting, setPresenting] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const directory = usePeopleDirectory(null);
  const s = reports.state;
  const evening = session === 'evening';

  useEffect(() => {
    // Presenting hides the app navigation so the whole screen is the meeting (restored on leaving).
    document.body.classList.toggle('mt-presenting', presenting);
    return () => document.body.classList.remove('mt-presenting');
  }, [presenting]);

  const view = useMemo(
    () =>
      buildMeeting(
        {
          today,
          tomorrow,
          nowIso: new Date().toISOString(),
          projects: s.projects,
          scopes: s.scopes ?? [],
          testCases: s.testCases ?? [],
          caseResults: s.caseResults ?? [],
          assignments: s.testerAssignments ?? [],
          members: s.rcsMembers ?? [],
          attendance: s.attendance,
          plans: s.dailyPlans ?? [],
        },
        s.meetingNotes ?? [],
        evening,
      ),
    [today, tomorrow, s.projects, s.scopes, s.testCases, s.caseResults, s.testerAssignments, s.rcsMembers, s.attendance, s.dailyPlans, s.meetingNotes, evening],
  );
  const { rows, summary } = view;
  const projectName = (p: ProjectRecord): string => resolveBilingualName(lang, { nameEn: p.nameEn, nameJa: p.nameJa }) || p.projectId;
  const peopleOf = (people: ReadonlyArray<{ userId?: string; memberId?: string }>): string => compactNames(people.map((p) => assigneeLabel(lang, p, directory)), 4);
  const todayEpoch = parseDate(today);
  const canEdit = !presenting;
  const detail = rows.find((r) => r.project.id === selected) ?? null;

  const savePlan = (date: string, projectId: string, scopeId: string | undefined, cases: number): void => {
    reports.updateMeeting((m) => ({ ...m, dailyPlans: setPlan(m.dailyPlans, { date, projectId, ...(scopeId === undefined ? {} : { scopeId }), plannedCases: cases, mode: session, today }, new Date().toISOString()) }));
    setMessage(null);
  };
  const saveNote = (field: NoteField, text: string): void => reports.updateMeeting((m) => ({ ...m, meetingNotes: setNote(m.meetingNotes, today, field, text, new Date().toISOString()) }));
  const confirm = (): void => {
    reports.updateMeeting((m) => ({ ...m, dailyPlans: confirmMorning(m.dailyPlans, today, new Date().toISOString()) }));
    setMessage(t(lang, 'mt.confirmed'));
  };

  /** The editable plan of a day for one place, or the figure when presenting. */
  const planCell = (date: string, project: ProjectRecord, scope: MeetingScopeRow | null, figure: number | null, hasScopes: boolean): JSX.Element => {
    const label = `${t(lang, 'mt.planFor')}: ${scope === null ? projectName(project) : scope.scope.name}`;
    if (!canEdit || (scope === null && hasScopes)) return <span>{figure === null ? t(lang, 'mt.notSet') : formatInteger(figure, lang)}</span>;
    return <PlanInput lang={lang} value={figure} label={label} onCommit={(n) => savePlan(date, project.projectId, scope?.scope.id, n)} />;
  };

  const sourceTag = (row: MeetingProjectRow): JSX.Element | null =>
    row.today.source === 'none' ? null : <small className="link-help"> ({t(lang, row.today.source === 'meeting' ? 'mt.source.meeting' : 'mt.source.project')})</small>;

  const summaryCards: Array<[TranslationKey, string]> = evening
    ? [
        ['mt.sum.todaysPlan', formatInteger(summary.targetToday, lang)],
        ['mt.sum.todaysActual', formatInteger(summary.actualToday, lang)],
        ['mt.sum.difference', `${summary.difference > 0 ? '+' : ''}${formatInteger(summary.difference, lang)}`],
        ['mt.sum.pass', formatInteger(summary.pass, lang)],
        ['mt.sum.fail', formatInteger(summary.fail, lang)],
        ['mt.sum.blockedCases', formatInteger(summary.blocked, lang)],
        ['mt.sum.remaining', formatInteger(summary.remaining, lang)],
        ['mt.sum.tomorrowPlanned', formatInteger(summary.tomorrowPlanned, lang)],
      ]
    : [
        ['mt.sum.activeProjects', formatInteger(summary.activeProjects, lang)],
        ['mt.sum.activeScopes', formatInteger(summary.activeScopes, lang)],
        ['mt.sum.teamMembers', formatInteger(summary.teamMembers, lang)],
        ['mt.sum.plannedToday', formatInteger(summary.plannedToday, lang)],
        ['mt.sum.remaining', formatInteger(summary.remaining, lang)],
        ['mt.sum.needsAttention', formatInteger(summary.needsAttention, lang)],
        ['mt.sum.blocked', formatInteger(summary.blockedProjects, lang)],
      ];

  return (
    <div className={`app mt-board${presenting ? ' mt-present' : ''}`}>
      <header className="mt-head">
        <div>
          <h1>{t(lang, evening ? 'mt.evening' : 'mt.morning')}</h1>
          <p className="mt-date">
            <span className="sr-only">{t(lang, 'mt.date')}: </span>
            {todayEpoch === null ? today : formatDateDisplay(todayEpoch, lang)}
          </p>
        </div>
        <div className="mt-controls">
          <div className="view-toggle" role="tablist" aria-label={t(lang, 'mt.title')}>
            {(['morning', 'evening'] as const).map((id) => (
              <button key={id} type="button" role="tab" aria-selected={session === id} className={session === id ? 'active' : undefined} onClick={() => setSession(id)}>
                {t(lang, id === 'morning' ? 'mt.morning' : 'mt.evening')}
              </button>
            ))}
          </div>
          <button type="button" className="btn" onClick={() => setPresenting((v) => !v)} aria-pressed={presenting}>
            {t(lang, presenting ? 'mt.exitPresent' : 'mt.present')}
          </button>
        </div>
      </header>

      {message === null ? null : (
        <p className="data-controls-message ok" role="status">
          {message}
        </p>
      )}

      <dl className="tm-summary mt-summary" aria-label={t(lang, evening ? 'mt.evening' : 'mt.morning')}>
        {summaryCards.map(([key, value]) => (
          <div key={key}>
            <dt>{t(lang, key)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        {evening ? null : (
          <div>
            <dt>{t(lang, 'mt.sum.attendance')}</dt>
            <dd>{summary.attendance.recorded ? t(lang, 'mt.sum.attendanceFigure', { attending: summary.attendance.attending, total: summary.attendance.total }) : t(lang, 'mt.sum.attendanceNone')}</dd>
          </div>
        )}
      </dl>
      {evening ? <p className="link-help">{t(lang, 'mt.diffNote')}</p> : null}
      {summary.unplannedProjects > 0 ? <p className="link-help">{t(lang, 'mt.unplanned', { count: summary.unplannedProjects })}</p> : null}

      {rows.length === 0 ? (
        <p className="tenancy-empty" role="note">
          {t(lang, 'mt.empty')}
        </p>
      ) : (
        <div className="tenancy-table-wrap">
          <table className="tenancy-table mt-table">
            <caption className="sr-only">{t(lang, evening ? 'mt.evening' : 'mt.morning')}</caption>
            <thead>
              {evening ? (
                <tr>
                  <th scope="col">{t(lang, 'mt.col.project')}</th>
                  <th scope="col">{t(lang, 'mt.col.todayPlan')}</th>
                  <th scope="col">{t(lang, 'mt.col.actual')}</th>
                  <th scope="col">{t(lang, 'mt.col.diff')}</th>
                  <th scope="col">{t(lang, 'mt.col.pass')}</th>
                  <th scope="col">{t(lang, 'mt.col.fail')}</th>
                  <th scope="col">{t(lang, 'mt.col.blocked')}</th>
                  <th scope="col">{t(lang, 'mt.col.remaining')}</th>
                  <th scope="col">{t(lang, 'mt.col.progress')}</th>
                  <th scope="col">{t(lang, 'mt.col.tomorrow')}</th>
                  <th scope="col">{t(lang, 'mt.col.risk')}</th>
                </tr>
              ) : (
                <tr>
                  <th scope="col">{t(lang, 'mt.col.project')}</th>
                  <th scope="col">{t(lang, 'mt.col.testers')}</th>
                  <th scope="col">{t(lang, 'mt.col.total')}</th>
                  <th scope="col">{t(lang, 'mt.col.todayPlan')}</th>
                  <th scope="col">{t(lang, 'mt.col.remaining')}</th>
                  <th scope="col">{t(lang, 'mt.col.schedule')}</th>
                  <th scope="col">{t(lang, 'mt.col.risk')}</th>
                </tr>
              )}
            </thead>
            <tbody>
              {rows.map((row) => {
                const hasScopes = row.scopes.length > 0;
                return (
                  <Fragment key={row.project.id}>
                    <tr className={`mt-row${selected === row.project.id ? ' row-selected' : ''}`}>
                      <th scope="row" className="tenancy-user-cell">
                        <button type="button" className="btn-link mt-project" onClick={() => setSelected(selected === row.project.id ? null : row.project.id)} aria-expanded={selected === row.project.id}>
                          <strong>{projectName(row.project)}</strong>
                        </button>
                      </th>
                      {evening ? (
                        <>
                          <td>
                            {canEdit && !hasScopes ? planCell(today, row.project, null, row.today.planned, false) : <span>{row.today.target === null ? t(lang, 'mt.notSet') : formatInteger(row.today.target, lang)}</span>}
                            {row.today.revised ? <small className="link-help"> {t(lang, 'mt.revised', { planned: row.today.planned ?? 0 })}</small> : null}
                            {sourceTag(row)}
                          </td>
                          <td>{row.actual.recorded ? formatInteger(row.actual.completed, lang) : <span className="link-help">{t(lang, 'mt.notRecorded')}</span>}</td>
                          <td>{row.difference === null ? '—' : `${row.difference > 0 ? '+' : ''}${formatInteger(row.difference, lang)}`}</td>
                          <td>{row.actual.recorded ? row.actual.pass : '—'}</td>
                          <td>{row.actual.recorded ? row.actual.fail : '—'}</td>
                          <td>{row.actual.recorded ? row.actual.blocked : '—'}</td>
                          <td>{formatInteger(row.metrics.remaining, lang)}</td>
                          <td>{pct(row.metrics.completion)}</td>
                          <td>{canEdit && !hasScopes ? planCell(tomorrow, row.project, null, row.tomorrow.planned, false) : <span>{row.tomorrow.planned === null ? t(lang, 'mt.notSet') : formatInteger(row.tomorrow.planned, lang)}</span>}</td>
                          <td>
                            <MeetingRiskBadge lang={lang} risks={row.risks} />
                          </td>
                        </>
                      ) : (
                        <>
                          <td>{peopleOf(row.people) || <span className="link-help">{t(lang, 'mt.noTesters')}</span>}</td>
                          <td>{formatInteger(row.total, lang)}</td>
                          <td>
                            {canEdit && !hasScopes ? planCell(today, row.project, null, row.today.planned, false) : <span>{row.today.planned === null ? t(lang, 'mt.notSet') : formatInteger(row.today.planned, lang)}</span>}
                            {sourceTag(row)}
                          </td>
                          <td>{formatInteger(row.metrics.remaining, lang)}</td>
                          <td>{row.window === null ? '—' : `${formatClock(row.window.start)}–${formatClock(row.window.end)}`}</td>
                          <td>
                            <MeetingRiskBadge lang={lang} risks={row.risks} />
                          </td>
                        </>
                      )}
                    </tr>
                    {row.scopes.map((sc) => (
                      <tr key={sc.scope.id} className="mt-scope-row">
                        <th scope="row" className="mt-scope-name">
                          <span aria-hidden="true">└ </span>
                          {sc.scope.name}
                          {sc.scope.code === undefined ? null : <small> {sc.scope.code}</small>}
                        </th>
                        {evening ? (
                          <>
                            <td>{planCell(today, row.project, sc, sc.plan?.morningCases ?? sc.plan?.plannedCases ?? null, true)}</td>
                            <td colSpan={7} className="link-help">
                              {peopleOf(sc.people) || t(lang, 'mt.noTesters')}
                            </td>
                            <td>{planCell(tomorrow, row.project, sc, sc.tomorrow?.plannedCases ?? null, true)}</td>
                            <td />
                          </>
                        ) : (
                          <>
                            <td>{peopleOf(sc.people) || <span className="link-help">{t(lang, 'mt.noTesters')}</span>}</td>
                            <td>{sc.total === null ? '—' : formatInteger(sc.total, lang)}</td>
                            <td>{planCell(today, row.project, sc, sc.plan?.plannedCases ?? null, true)}</td>
                            <td colSpan={3} />
                          </>
                        )}
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows.some((r) => r.scopes.length > 0) ? <p className="link-help">{t(lang, 'mt.scopeNote')}</p> : null}

      {detail === null ? null : <DetailPanel lang={lang} row={detail} evening={evening} projectName={projectName(detail.project)} people={peopleOf(detail.people)} onClose={() => setSelected(null)} />}

      <MeetingGantt lang={lang} today={today} rows={rows} evening={evening} names={(r) => peopleOf(r.people)} projectName={(r) => projectName(r.project)} onSelect={(id) => setSelected(id)} />

      {evening ? (
        <section className="dr-section" aria-labelledby="mt-tomorrow-title">
          <h2 id="mt-tomorrow-title">{t(lang, 'mt.tomorrow.title', { date: formatLong(tomorrow, lang) })}</h2>
          <p className="link-help">{t(lang, 'mt.tomorrow.help')}</p>
          <ul className="mt-tomorrow-list">
            {rows.map((row) => (
              <li key={row.project.id}>
                <strong>{projectName(row.project)}</strong>: {row.tomorrow.planned === null ? t(lang, 'mt.notSet') : t(lang, 'mt.tomorrow.cases', { count: formatInteger(row.tomorrow.planned, lang) })}
                {row.scopes.length > 0 ? (
                  <ul>
                    {row.scopes
                      .filter((sc) => sc.tomorrow !== undefined)
                      .map((sc) => (
                        <li key={sc.scope.id}>
                          {sc.scope.name}: {t(lang, 'mt.tomorrow.cases', { count: formatInteger(sc.tomorrow?.plannedCases ?? 0, lang) })}
                        </li>
                      ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
          <p>
            <strong>
              {t(lang, 'mt.sum.tomorrowPlanned')}: {formatInteger(summary.tomorrowPlanned, lang)}
            </strong>
          </p>
        </section>
      ) : null}

      <section className="dr-section mt-notes" aria-label={t(lang, 'mt.note.title')}>
        {evening ? (
          <>
            <NoteBox lang={lang} label={t(lang, 'mt.note.evening')} value={view.note?.evening ?? ''} readOnly={!canEdit} onCommit={(x) => saveNote('evening', x)} />
            <NoteBox lang={lang} label={t(lang, 'mt.note.tomorrow')} value={view.note?.tomorrow ?? ''} readOnly={!canEdit} onCommit={(x) => saveNote('tomorrow', x)} />
          </>
        ) : (
          <>
            <NoteBox lang={lang} label={t(lang, 'mt.note.morning')} value={view.note?.morning ?? ''} readOnly={!canEdit} onCommit={(x) => saveNote('morning', x)} />
            {canEdit ? (
              <div className="dr-button-row">
                <button type="button" className="btn" onClick={confirm}>
                  {t(lang, 'mt.confirm')}
                </button>
                <span className="link-help">{t(lang, 'mt.confirmHelp')}</span>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

function formatLong(date: string, lang: Language): string {
  const epoch = parseDate(date);
  return epoch === null ? date : formatDateDisplay(epoch, lang);
}

function useLanguage(): Language {
  return useAppStateCtx().state.language;
}

function DetailPanel({ lang, row, evening, projectName, people, onClose }: { lang: Language; row: MeetingProjectRow; evening: boolean; projectName: string; people: string; onClose: () => void }) {
  const issues = row.openIssues.slice(0, 5);
  const cells: Array<[TranslationKey, string]> = [
    ['mt.col.total', formatInteger(row.total, lang)],
    ['mt.col.todayPlan', row.today.target === null ? t(lang, 'mt.notSet') : formatInteger(row.today.target, lang)],
    ['mt.col.actual', row.actual.recorded ? formatInteger(row.actual.completed, lang) : t(lang, 'mt.notRecorded')],
    ['mt.col.pass', row.actual.recorded ? String(row.actual.pass) : '—'],
    ['mt.col.fail', row.actual.recorded ? String(row.actual.fail) : '—'],
    ['mt.col.blocked', row.actual.recorded ? String(row.actual.blocked) : '—'],
    ['mt.col.remaining', formatInteger(row.metrics.remaining, lang)],
    ['mt.col.tomorrow', row.tomorrow.planned === null ? t(lang, 'mt.notSet') : formatInteger(row.tomorrow.planned, lang)],
  ];
  return (
    <aside className="dr-section mt-detail" aria-label={projectName}>
      <div className="dr-button-row">
        <h2>{projectName}</h2>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t(lang, 'mt.detail.close')}
        </button>
      </div>
      <dl className="tm-summary">
        {cells.map(([key, value]) => (
          <div key={key}>
            <dt>{t(lang, key)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p>
        <strong>{t(lang, 'mt.detail.assigned')}:</strong> {people === '' ? t(lang, 'mt.noTesters') : people}
      </p>
      <p>
        <strong>{t(lang, 'mt.detail.issues')}:</strong> {issues.length === 0 ? t(lang, 'mt.detail.noIssues') : issues.join(', ')}
      </p>
      <p>
        <strong>{t(lang, 'mt.detail.status')}:</strong> <MeetingRiskBadge lang={lang} risks={row.risks} />
      </p>
      <MeetingRiskList lang={lang} risks={row.risks} />
      {evening || row.registered > 0 ? (
        <p className="link-help">
          {t(lang, 'mt.detail.registered')}: {formatInteger(row.registered, lang)} · {t(lang, 'mt.detail.coverageNote')}
        </p>
      ) : null}
    </aside>
  );
}
