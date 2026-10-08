import { t } from '../../i18n';
import { parseDate } from '../../lib/dates/dates';
import { formatInteger } from '../../lib/formatting/format';
import type { MeetingProjectRow } from '../../domain/meeting';
import type { Language } from '../../types';
import { MeetingRiskBadge } from './MeetingParts';

interface Props {
  lang: Language;
  today: string;
  rows: readonly MeetingProjectRow[];
  evening: boolean;
  names: (row: MeetingProjectRow) => string;
  projectName: (row: MeetingProjectRow) => string;
  onSelect: (projectId: string) => void;
}

const clamp = (v: number): number => Math.min(100, Math.max(0, v));

/**
 * The presentation timeline: one bar per project from its start to its deadline, the filled part being the share completed of the
 * authoritative Total (aggregate execution), a mark for today, and the day's numbers beside it. Read-only: nothing here edits a plan.
 * Every status is also written in words, never colour alone.
 */
export function MeetingGantt({ lang, today, rows, evening, names, projectName, onSelect }: Props) {
  const todayEpoch = parseDate(today);
  const starts = rows.map((r) => parseDate(r.project.inputs.startDate)).filter((x): x is number => x !== null);
  const ends = rows.map((r) => parseDate(r.project.inputs.targetCompletionDate ?? r.project.inputs.startDate)).filter((x): x is number => x !== null);
  if (rows.length === 0 || todayEpoch === null) return null;
  const min = Math.min(...starts, todayEpoch);
  const max = Math.max(...ends, todayEpoch, min + 1);
  const span = max - min;
  const pos = (epoch: number): number => clamp(((epoch - min) / span) * 100);
  const todayPos = pos(todayEpoch);

  return (
    <section className="dr-section mt-gantt" aria-labelledby="mt-gantt-title">
      <h2 id="mt-gantt-title">{t(lang, 'mt.gantt.title')}</h2>
      <p className="link-help">{t(lang, 'mt.gantt.hint')}</p>
      <ol className="mt-gantt-list">
        {rows.map((row) => {
          const start = parseDate(row.project.inputs.startDate) ?? min;
          const end = parseDate(row.project.inputs.targetCompletionDate ?? row.project.inputs.startDate) ?? start;
          const left = pos(start);
          const width = Math.max(1.5, pos(end) - left);
          const done = row.metrics.completion ?? 0;
          const name = projectName(row);
          return (
            <li key={row.project.id}>
              <button type="button" className="mt-gantt-row" onClick={() => onSelect(row.project.id)} aria-label={`${name}: ${t(lang, 'mt.detail.open')}`}>
                <span className="mt-gantt-name">{name}</span>
                <span className="mt-gantt-track" aria-hidden="true">
                  <span className="mt-gantt-bar" style={{ left: `${left}%`, width: `${width}%` }}>
                    <span className="mt-gantt-fill" style={{ width: `${clamp(done * 100)}%` }} />
                  </span>
                  <span className="mt-gantt-today" style={{ left: `${todayPos}%` }} />
                </span>
                <span className="mt-gantt-facts">
                  {evening ? (
                    <>
                      {t(lang, 'mt.gantt.plan')} {row.today.target === null ? '—' : formatInteger(row.today.target, lang)} · {t(lang, 'mt.gantt.actual')}{' '}
                      {row.actual.recorded ? formatInteger(row.actual.completed, lang) : t(lang, 'mt.notRecorded')} · {t(lang, 'mt.gantt.diff')}{' '}
                      {row.difference === null ? '—' : `${row.difference > 0 ? '+' : ''}${formatInteger(row.difference, lang)}`} · {t(lang, 'mt.gantt.remaining')}{' '}
                      {formatInteger(row.metrics.remaining, lang)} · {t(lang, 'mt.gantt.tomorrow')} {row.tomorrow.planned === null ? '—' : formatInteger(row.tomorrow.planned, lang)}
                    </>
                  ) : (
                    <>
                      {t(lang, 'mt.gantt.planToday')} {row.today.planned === null ? t(lang, 'mt.notSet') : formatInteger(row.today.planned, lang)} · {t(lang, 'mt.gantt.assigned')}{' '}
                      {names(row) || t(lang, 'mt.noTesters')} · {t(lang, 'mt.gantt.due')} {row.project.inputs.targetCompletionDate ?? '—'}
                    </>
                  )}
                </span>
                <MeetingRiskBadge lang={lang} risks={row.risks} />
              </button>
            </li>
          );
        })}
      </ol>
      <p className="link-help">
        <span className="mt-gantt-todaykey" aria-hidden="true" /> {t(lang, 'mt.gantt.todayMark')}
      </p>
    </section>
  );
}
