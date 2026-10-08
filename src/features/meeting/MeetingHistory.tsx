import { Fragment, useEffect, useMemo, useState } from 'react';
import { useReportsStateCtx } from '../../app/state-contexts';
import { useTenant } from '../../app/tenant-context';
import { resolveBilingualName, t } from '../../i18n';
import { DEFAULT_PLAN_RETENTION_DAYS } from '../../../shared/meeting';
import { addDays, formatDate, formatDateDisplay, parseDate } from '../../lib/dates/dates';
import { formatInteger } from '../../lib/formatting/format';
import { historyDay, historyRange, retainMeetingHistory, type HistoryInput } from '../../domain/meeting/history';
import { useBusinessToday } from '../testManagement/useTestManagement';
import type { Language, ProjectRecord } from '../../types';

const signed = (n: number | null, lang: Language): string => (n === null ? '—' : `${n > 0 ? '+' : ''}${formatInteger(n, lang)}`);
const num = (n: number | null, lang: Language): string => (n === null ? '—' : formatInteger(n, lang));

/**
 * Meeting History (SV): any past business day as it was stored, and plan against actual over the last two weeks. Difference is Actual - Plan over
 * the same rows (a project with a plan and no results counts 0 actual). It is the business view over dates; the revision engine behind
 * History is separate. Opening it runs the once-a-day housekeeping of old plans (the server skips it if it already ran today).
 */
export function MeetingHistory({ lang }: { lang: Language }) {
  const reports = useReportsStateCtx();
  const { api } = useTenant();
  const today = useBusinessToday();
  const yesterday = useMemo(() => {
    const e = parseDate(today);
    return e === null ? today : formatDate(addDays(e, -1));
  }, [today]);
  const [date, setDate] = useState(yesterday);
  const s = reports.state;
  const retentionDays = s.settings.planRetentionDays ?? DEFAULT_PLAN_RETENTION_DAYS;

  useEffect(() => {
    const guard = `gc-retention-${today}`;
    try {
      if (window.sessionStorage.getItem(guard) !== null) return;
      window.sessionStorage.setItem(guard, '1');
    } catch {
      /* the server's own once-a-day guard is the real one */
    }
    if (api !== null) void api.runRetention().catch(() => undefined);
    else reports.updateMeeting((m) => {
      const kept = retainMeetingHistory(m.dailyPlans, m.meetingNotes, today, retentionDays);
      return kept.removed === 0 ? m : { dailyPlans: kept.plans, meetingNotes: kept.notes };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, today]);

  const input: HistoryInput = useMemo(
    () => ({ projects: s.projects, scopes: s.scopes ?? [], plans: s.dailyPlans ?? [], notes: s.meetingNotes ?? [], today, retentionDays }),
    [s.projects, s.scopes, s.dailyPlans, s.meetingNotes, today, retentionDays],
  );
  const day = useMemo(() => historyDay(input, date), [input, date]);
  const range = useMemo(() => {
    const e = parseDate(date);
    return e === null ? [] : historyRange(input, formatDate(addDays(e, -13)), date);
  }, [input, date]);
  const name = (p: ProjectRecord): string => resolveBilingualName(lang, { nameEn: p.nameEn, nameJa: p.nameJa }) || p.projectId;
  const shift = (days: number): void => {
    const e = parseDate(date);
    if (e !== null) setDate(formatDate(addDays(e, days)));
  };
  const epoch = parseDate(date);

  return (
    <section className="dr-section mt-history" aria-labelledby="mth-title">
      <h2 id="mth-title">{t(lang, 'mth.title')}</h2>
      <p className="link-help">{t(lang, 'mth.help')}</p>
      <div className="dr-button-row">
        <button type="button" className="btn" onClick={() => shift(-1)}>
          {t(lang, 'mth.previous')}
        </button>
        <label className="dr-toolbar-field">
          {t(lang, 'mt.date')}
          <input className="input" type="date" value={date} max={today} onChange={(e) => e.target.value !== '' && setDate(e.target.value)} />
        </label>
        <button type="button" className="btn" disabled={date >= today} onClick={() => shift(1)}>
          {t(lang, 'mth.next')}
        </button>
        <strong>{epoch === null ? date : formatDateDisplay(epoch, lang)}</strong>
      </div>
      <p className="link-help">{t(lang, 'mth.retainedUntil', { date: day.retainedFrom, days: retentionDays })}</p>

      {day.outsideRetention ? (
        <p className="tenancy-empty" role="note">
          {t(lang, 'mth.outside', { date: day.retainedFrom })}
        </p>
      ) : day.empty ? (
        <p className="tenancy-empty" role="note">
          {t(lang, 'mth.empty')}
        </p>
      ) : (
        <>
          <dl className="tm-summary mt-summary">
            {(
              [
                ['mth.sum.plan', num(day.totals.plan, lang)],
                ['mth.sum.actual', num(day.totals.actual, lang)],
                ['mt.sum.difference', signed(day.totals.difference, lang)],
                ['mt.sum.pass', num(day.totals.pass, lang)],
                ['mt.sum.fail', num(day.totals.fail, lang)],
                ['mt.sum.blockedCases', num(day.totals.blocked, lang)],
                ['mt.sum.tomorrowPlanned', num(day.totals.tomorrow, lang)],
              ] as const
            ).map(([key, value]) => (
              <div key={key}>
                <dt>{t(lang, key)}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p className="link-help">{t(lang, 'mth.diffNote')}</p>
          <div className="tenancy-table-wrap">
            <table className="tenancy-table mt-table">
              <caption className="sr-only">{t(lang, 'mth.title')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t(lang, 'mt.col.project')}</th>
                  <th scope="col">{t(lang, 'mth.sum.plan')}</th>
                  <th scope="col">{t(lang, 'mth.sum.actual')}</th>
                  <th scope="col">{t(lang, 'mt.col.diff')}</th>
                  <th scope="col">{t(lang, 'mt.col.pass')}</th>
                  <th scope="col">{t(lang, 'mt.col.fail')}</th>
                  <th scope="col">{t(lang, 'mt.col.blocked')}</th>
                  <th scope="col">{t(lang, 'mth.remainingEnd')}</th>
                  <th scope="col">{t(lang, 'mt.col.tomorrow')}</th>
                </tr>
              </thead>
              <tbody>
                {day.rows.map((r) => (
                  <Fragment key={r.project.id}>
                    <tr>
                      <th scope="row" className="tenancy-user-cell">
                        <strong>{name(r.project)}</strong>
                      </th>
                      <td>
                        {num(r.plan, lang)}
                        {r.revisedTo !== null ? <small className="link-help"> {t(lang, 'mt.revised', { planned: r.revisedTo })}</small> : null}
                      </td>
                      <td>{r.actual === null ? <span className="link-help">{t(lang, 'mt.notRecorded')}</span> : num(r.actual, lang)}</td>
                      <td>{signed(r.difference, lang)}</td>
                      <td>{num(r.pass, lang)}</td>
                      <td>{num(r.fail, lang)}</td>
                      <td>{num(r.blocked, lang)}</td>
                      <td>{num(r.remainingAtEnd, lang)}</td>
                      <td>{num(r.tomorrow, lang)}</td>
                    </tr>
                    {r.scopes.map((sc) => (
                      <tr key={`${r.project.id}-${sc.scope.id}`} className="mt-scope-row">
                        <th scope="row" className="mt-scope-name">
                          <span aria-hidden="true">└ </span>
                          {sc.scope.name}
                        </th>
                        <td>{formatInteger(sc.plan, lang)}</td>
                        <td colSpan={7} className="link-help">
                          {t(lang, 'mth.scopeNoActual')}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="link-help">{t(lang, 'mth.storedNote')}</p>
          {day.note === undefined || (day.note.morning === undefined && day.note.evening === undefined && day.note.tomorrow === undefined) ? null : (
            <div className="mt-notes">
              {(['morning', 'evening', 'tomorrow'] as const).map((f) =>
                day.note?.[f] === undefined ? null : (
                  <div key={f} className="mt-note">
                    <h3>{t(lang, f === 'morning' ? 'mt.note.morning' : f === 'evening' ? 'mt.note.evening' : 'mt.note.tomorrow')}</h3>
                    <p className="mt-note-text">{day.note[f]}</p>
                  </div>
                ),
              )}
            </div>
          )}
        </>
      )}

      <h3>{t(lang, 'mth.planVsActual')}</h3>
      {range.length === 0 ? (
        <p className="link-help">{t(lang, 'mth.rangeEmpty')}</p>
      ) : (
        <div className="tenancy-table-wrap">
          <table className="tenancy-table mt-table">
            <caption className="sr-only">{t(lang, 'mth.planVsActual')}</caption>
            <thead>
              <tr>
                <th scope="col">{t(lang, 'mt.date')}</th>
                <th scope="col">{t(lang, 'mth.sum.plan')}</th>
                <th scope="col">{t(lang, 'mth.sum.actual')}</th>
                <th scope="col">{t(lang, 'mt.col.diff')}</th>
                <th scope="col">{t(lang, 'mt.col.pass')}</th>
                <th scope="col">{t(lang, 'mt.col.fail')}</th>
                <th scope="col">{t(lang, 'mt.col.blocked')}</th>
              </tr>
            </thead>
            <tbody>
              {range.map((r) => (
                <tr key={r.date} className={r.date === date ? 'row-selected' : undefined}>
                  <th scope="row">
                    <button type="button" className="btn-link" onClick={() => setDate(r.date)}>
                      {r.date}
                    </button>
                  </th>
                  <td>{num(r.totals.plan, lang)}</td>
                  <td>{num(r.totals.actual, lang)}</td>
                  <td>{signed(r.totals.difference, lang)}</td>
                  <td>{num(r.totals.pass, lang)}</td>
                  <td>{num(r.totals.fail, lang)}</td>
                  <td>{num(r.totals.blocked, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
