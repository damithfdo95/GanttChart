import type { Language, PlanningRow, PlanningRowPatch } from '../types';
import type { PlanningRowErrors } from '../lib/validation/validate';
import { calculateDailyAvailableTesters } from '../lib/calculations/planning';
import { WORK_DAY_END, rowDayWindow, type DayWindow } from '../lib/calculations/workday';
import { formatDuration, formatInteger, minutesToTimeInput, parseTimeToMinutes } from '../lib/formatting/format';
import { isNonWorkingDate } from '../lib/dates/businessDays';
import { t, type TranslationKey } from '../i18n';

interface StaffingEditorProps {
  rows: PlanningRow[];
  rowErrors: PlanningRowErrors[];
  lang: Language;
  /** Project-level window defaults the per-row overrides fall back to (V7). */
  defaults: DayWindow;
  onUpdateRow: (index: number, patch: PlanningRowPatch) => void;
  onRemoveRow: (index: number) => void;
}

/** Number inputs are clamped to >= 0 so negatives cannot be entered. */
function clampToNonNegative(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === '') return 0;
  const n = Number(trimmed);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

/** Clamp a per-row overtime override into the shared 0–180 range. */
function clampOvertime(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(180, Math.max(0, Math.round(n)));
}

/**
 * Daily staffing editor (V2). Available Testers is auto-calculated and
 * read-only; rows keep their own ids so React reconciliation stays stable.
 *
 * V7: each row can override the planned window — Start Time, End Time,
 * Overtime and whether the lunch interval is taken. Empty inputs mean
 * "use the project default" (shown as the input placeholder); the derived
 * Hours column always shows the row's effective productive hours.
 */
export function StaffingEditor({ rows, rowErrors, lang, defaults, onUpdateRow, onRemoveRow }: StaffingEditorProps) {
  return (
    <div className="staffing-editor">
      <div className="table-wrap">
        <table className="staffing-table">
          <thead>
            <tr>
              <th scope="col">{t(lang, 'columns.date')}</th>
              <th scope="col" className="num">{t(lang, 'columns.plannedTesters')}</th>
              <th scope="col" className="num">{t(lang, 'columns.absentTesters')}</th>
              <th scope="col" className="num">{t(lang, 'columns.availableTesters')}</th>
              <th scope="col" className="num">{t(lang, 'columns.startTime')}</th>
              <th scope="col" className="num">{t(lang, 'columns.endTime')}</th>
              <th scope="col" className="num">{t(lang, 'columns.overtime')}</th>
              <th scope="col" className="center">{t(lang, 'columns.interval')}</th>
              <th scope="col" className="num">{t(lang, 'columns.productiveHours')}</th>
              <th scope="col" className="center">{t(lang, 'columns.nonWorkingDay')}</th>
              <th scope="col">{t(lang, 'columns.note')}</th>
              <th scope="col">{t(lang, 'columns.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const e = rowErrors[i];
              const dateError: TranslationKey | undefined = e?.dateInvalid
                ? 'errors.planDateInvalid'
                : e?.dateOrder
                  ? 'errors.planDateOrder'
                  : undefined;
              const rowDate = row.date;
              const calendarOff = isNonWorkingDate(rowDate);
              const window = rowDayWindow(row, defaults);
              return (
                <tr key={row.id} className={row.nonWorkingDay || calendarOff ? 'off' : undefined}>
                  <td>
                    <input
                      type="date"
                      className={`table-input ${dateError ? 'table-input-invalid' : ''}`}
                      value={row.date}
                      aria-label={`${t(lang, 'columns.date')} (${rowDate})`}
                      title={dateError ? t(lang, dateError) : undefined}
                      aria-invalid={dateError !== undefined}
                      onChange={(ev) => onUpdateRow(i, { date: ev.target.value })}
                    />
                    {calendarOff ? <span className="tag tag-off">{t(lang, 'plan.nonWorkingTag')}</span> : null}
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      className={`table-input num ${e?.plannedTestersInvalid ? 'table-input-invalid' : ''}`}
                      value={row.plannedTesters}
                      aria-label={`${t(lang, 'columns.plannedTesters')} (${rowDate})`}
                      title={e?.plannedTestersInvalid ? t(lang, 'errors.plannedTesters') : undefined}
                      aria-invalid={e?.plannedTestersInvalid === true}
                      onChange={(ev) => onUpdateRow(i, { plannedTesters: clampToNonNegative(ev.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      className={`table-input num ${e?.absentTestersInvalid ? 'table-input-invalid' : ''}`}
                      value={row.absentTesters}
                      aria-label={`${t(lang, 'columns.absentTesters')} (${rowDate})`}
                      title={e?.absentTestersInvalid ? t(lang, 'errors.absentTesters') : undefined}
                      aria-invalid={e?.absentTestersInvalid === true}
                      onChange={(ev) => onUpdateRow(i, { absentTesters: clampToNonNegative(ev.target.value) })}
                    />
                  </td>
                  <td className="num available-cell">
                    {formatInteger(calculateDailyAvailableTesters(row.plannedTesters, row.absentTesters), lang)}
                  </td>
                  <td>
                    <input
                      type="time"
                      className="table-input"
                      value={row.startTime === undefined ? '' : minutesToTimeInput(row.startTime)}
                      placeholder={minutesToTimeInput(defaults.start)}
                      aria-label={`${t(lang, 'columns.startTime')} (${rowDate})`}
                      title={minutesToTimeInput(defaults.start)}
                      onChange={(ev) => {
                        const minutes = ev.target.value === '' ? undefined : parseTimeToMinutes(ev.target.value);
                        onUpdateRow(i, { startTime: minutes ?? undefined });
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="time"
                      className="table-input"
                      value={row.endTime === undefined ? '' : minutesToTimeInput(row.endTime)}
                      placeholder={minutesToTimeInput(WORK_DAY_END)}
                      aria-label={`${t(lang, 'columns.endTime')} (${rowDate})`}
                      title={minutesToTimeInput(WORK_DAY_END)}
                      onChange={(ev) => {
                        const minutes = ev.target.value === '' ? undefined : parseTimeToMinutes(ev.target.value);
                        onUpdateRow(i, { endTime: minutes ?? undefined });
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      max={180}
                      step={15}
                      className="table-input num"
                      value={row.overtimeMinutes ?? ''}
                      placeholder={String(defaults.end - WORK_DAY_END)}
                      aria-label={`${t(lang, 'columns.overtime')} (${rowDate})`}
                      title={String(defaults.end - WORK_DAY_END)}
                      onChange={(ev) => {
                        const ot = clampOvertime(ev.target.value);
                        onUpdateRow(i, { overtimeMinutes: ot });
                      }}
                    />
                  </td>
                  <td className="center">
                    <input
                      type="checkbox"
                      checked={row.intervalEnabled ?? defaults.lunch.start > 0}
                      aria-label={`${t(lang, 'columns.interval')} (${rowDate})`}
                      title={t(lang, 'newProject.intervalOn')}
                      onChange={(ev) => onUpdateRow(i, { intervalEnabled: ev.target.checked })}
                    />
                  </td>
                  <td className="num" title={`${minutesToTimeInput(window.start)}–${minutesToTimeInput(window.end)}`}>
                    {formatDuration(row.nonWorkingDay || calendarOff ? 0 : rowDayWindowProductive(row, defaults) * 60)}
                  </td>
                  <td className="center">
                    <input
                      type="checkbox"
                      checked={row.nonWorkingDay}
                      aria-label={`${t(lang, 'columns.nonWorkingDay')} (${rowDate})`}
                      onChange={(ev) => onUpdateRow(i, { nonWorkingDay: ev.target.checked })}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      className="table-input"
                      value={row.note}
                      aria-label={`${t(lang, 'columns.note')} (${rowDate})`}
                      onChange={(ev) => onUpdateRow(i, { note: ev.target.value })}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn-row-remove"
                      title={t(lang, 'buttons.remove')}
                      aria-label={`${t(lang, 'buttons.remove')} (${rowDate})`}
                      disabled={rows.length <= 1}
                      onClick={() => onRemoveRow(i)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function rowDayWindowProductive(row: PlanningRow, defaults: DayWindow): number {
  const window = rowDayWindow(row, defaults);
  // Productive hours = span minus the actual lunch overlap (zero when off).
  const lunchOverlap = Math.max(0, Math.min(window.end, window.lunch.end) - Math.max(window.start, window.lunch.start));
  return window.end > window.start ? (window.end - window.start - lunchOverlap) / 60 : 0;
}
