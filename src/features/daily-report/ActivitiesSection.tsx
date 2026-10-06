import { useState } from 'react';
import type { DailyExecutionEntry, Language, ReportActivity } from '../../types';
import { t } from '../../i18n';

interface ActivitiesSectionProps {
  activities: ReportActivity[];
  lang: Language;
  readOnly?: boolean;
  /** The canonical daily execution entry for the report date (if any). */
  dayEntry?: DailyExecutionEntry | null;
  onChange: (activities: ReportActivity[]) => void;
}

/**
 * Number cell with clear-and-retype support: the raw string is kept as local
 * draft state while typing and committed (clamped to >= 0) on blur, so
 * clearing a field no longer snaps the value to 0 immediately.
 */
function NumberCell({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className="table-input num"
      type="number"
      min={0}
      step={1}
      aria-label={label}
      title={label}
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null) {
          onChange(Math.max(0, Number(draft) || 0));
          setDraft(null);
        }
      }}
    />
  );
}

/**
 * Today's Activities editor. Report-owned copies — editing the display name
 * or counts never modifies the original plan data. The per-row copy button
 * pulls the report date's counts from the canonical daily execution entry
 * (Dashboard → Today's Execution) into the report copy.
 */
export function ActivitiesSection({ activities, lang, readOnly, dayEntry, onChange }: ActivitiesSectionProps) {
  const update = (id: string, patch: Partial<ReportActivity>): void => {
    onChange(activities.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  };
  const move = (index: number, delta: number): void => {
    const next = [...activities];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const copyFromEntry = (id: string): void => {
    if (dayEntry === null || dayEntry === undefined) return;
    update(id, {
      memberCount: Math.max(0, dayEntry.testers),
      casesPassed: Math.max(0, dayEntry.pass),
      casesFailed: Math.max(0, dayEntry.fail),
      notApplicableCases: Math.max(0, dayEntry.notApplicable),
      blockedCases: Math.max(0, dayEntry.blocked),
      spoAssigned: Math.max(0, dayEntry.spo),
      casesRetest: Math.max(0, dayEntry.retest),
      casesQuestioned: Math.max(0, dayEntry.questioned),
    });
  };

  return (
    <section className="dr-section">
      <h2>{t(lang, 'dailyReport.activitiesSection')}</h2>
      {dayEntry !== null && dayEntry !== undefined ? (
        <p className="exec-help">{t(lang, 'dailyReport.copyFromEntriesHint')}</p>
      ) : (
        <p className="exec-help">{t(lang, 'dailyReport.activitiesLocalHint')}</p>
      )}
      {activities.length === 0 ? (
        <p className="dr-empty">{t(lang, 'dailyReport.noActivities')}</p>
      ) : (
        <div className="table-wrap">
          <table className="dr-table dr-activities table-wide">
            <thead>
              <tr>
                <th scope="col">{t(lang, 'columns.include')}</th>
                <th scope="col">{t(lang, 'columns.name')}</th>
                <th scope="col" className="num">{t(lang, 'columns.memberCount')}</th>
                <th scope="col" className="num">{t(lang, 'columns.completedCases')}</th>
                <th scope="col">{t(lang, 'columns.workingStatus')}</th>
                <th scope="col" className="num">{t(lang, 'columns.totalCases')}</th>
                <th scope="col" className="num">{t(lang, 'columns.workingEligible')}</th>
                <th scope="col" className="num">{t(lang, 'columns.started')}</th>
                <th scope="col" className="num">{t(lang, 'columns.pass')}</th>
                <th scope="col" className="num">{t(lang, 'fields.casesFailed')}</th>
                <th scope="col" className="num">{t(lang, 'columns.notApplicable')}</th>
                <th scope="col" className="num">{t(lang, 'columns.blocked')}</th>
                <th scope="col" className="num">{t(lang, 'columns.spoAssigned')}</th>
                <th scope="col" className="num">{t(lang, 'fields.casesRetest')}</th>
                <th scope="col" className="num">{t(lang, 'fields.casesQuestioned')}</th>
                <th scope="col">{t(lang, 'columns.dueDate')}</th>
                {readOnly !== true ? <th scope="col" /> : null}
              </tr>
            </thead>
            <tbody>
              {activities.map((activity, index) => {
                const nameLabel = `${t(lang, 'columns.name')} (${activity.name === '' ? index + 1 : activity.name})`;
                return (
                  <tr key={activity.id}>
                    <td className="center">
                      <input
                        type="checkbox"
                        aria-label={`${t(lang, 'columns.include')}: ${nameLabel}`}
                        checked={activity.included}
                        onChange={(e) => update(activity.id, { included: e.target.checked })}
                      />
                    </td>
                    <td>
                      <input
                        className="table-input"
                        type="text"
                        aria-label={nameLabel}
                        value={activity.name}
                        onChange={(e) => update(activity.id, { name: e.target.value })}
                      />
                    </td>
                    <td><NumberCell label={`${t(lang, 'columns.memberCount')}: ${nameLabel}`} value={activity.memberCount} onChange={(v) => update(activity.id, { memberCount: v })} /></td>
                    <td><NumberCell label={`${t(lang, 'columns.completedCases')}: ${nameLabel}`} value={activity.completedCases} onChange={(v) => update(activity.id, { completedCases: v })} /></td>
                    <td>
                      <input
                        className="table-input"
                        type="text"
                        aria-label={`${t(lang, 'columns.workingStatus')}: ${nameLabel}`}
                        value={activity.workingStatus}
                        onChange={(e) => update(activity.id, { workingStatus: e.target.value })}
                      />
                    </td>
                    <td><NumberCell label={`${t(lang, 'columns.totalCases')}: ${nameLabel}`} value={activity.totalCases} onChange={(v) => update(activity.id, { totalCases: v })} /></td>
                    <td><NumberCell label={`${t(lang, 'columns.workingEligible')}: ${nameLabel}`} value={activity.workingEligibleCases} onChange={(v) => update(activity.id, { workingEligibleCases: v })} /></td>
                    <td><NumberCell label={`${t(lang, 'columns.started')}: ${nameLabel}`} value={activity.startedCases} onChange={(v) => update(activity.id, { startedCases: v })} /></td>
                    <td><NumberCell label={`${t(lang, 'columns.pass')}: ${nameLabel}`} value={activity.casesPassed ?? 0} onChange={(v) => update(activity.id, { casesPassed: v })} /></td>
                    <td><NumberCell label={`${t(lang, 'fields.casesFailed')}: ${nameLabel}`} value={activity.casesFailed ?? 0} onChange={(v) => update(activity.id, { casesFailed: v })} /></td>
                    <td><NumberCell label={`${t(lang, 'columns.notApplicable')}: ${nameLabel}`} value={activity.notApplicableCases} onChange={(v) => update(activity.id, { notApplicableCases: v })} /></td>
                    <td><NumberCell label={`${t(lang, 'columns.blocked')}: ${nameLabel}`} value={activity.blockedCases} onChange={(v) => update(activity.id, { blockedCases: v })} /></td>
                    <td><NumberCell label={`${t(lang, 'columns.spoAssigned')}: ${nameLabel}`} value={activity.spoAssigned ?? 0} onChange={(v) => update(activity.id, { spoAssigned: v })} /></td>
                    <td><NumberCell label={`${t(lang, 'fields.casesRetest')}: ${nameLabel}`} value={activity.casesRetest ?? 0} onChange={(v) => update(activity.id, { casesRetest: v })} /></td>
                    <td><NumberCell label={`${t(lang, 'fields.casesQuestioned')}: ${nameLabel}`} value={activity.casesQuestioned ?? 0} onChange={(v) => update(activity.id, { casesQuestioned: v })} /></td>
                    <td>
                      <input
                        className="table-input input-date"
                        type="date"
                        aria-label={`${t(lang, 'columns.dueDate')}: ${nameLabel}`}
                        value={activity.dueDate ?? ''}
                        onChange={(e) => update(activity.id, { dueDate: e.target.value === '' ? null : e.target.value })}
                      />
                    </td>
                    {readOnly !== true ? (
                      <td className="dr-row-actions">
                        <button
                          type="button"
                          className="btn-icon"
                          title={t(lang, 'dailyReport.copyFromEntries')}
                          aria-label={`${t(lang, 'dailyReport.copyFromEntries')}: ${nameLabel}`}
                          disabled={dayEntry === null || dayEntry === undefined}
                          onClick={() => copyFromEntry(activity.id)}
                        >
                          ⟳
                        </button>
                        <button
                          type="button"
                          className="btn-icon"
                          title={t(lang, 'buttons.moveUp')}
                          aria-label={`${t(lang, 'buttons.moveUp')}: ${nameLabel}`}
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="btn-icon"
                          title={t(lang, 'buttons.moveDown')}
                          aria-label={`${t(lang, 'buttons.moveDown')}: ${nameLabel}`}
                          disabled={index === activities.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="btn-row-remove"
                          title={t(lang, 'buttons.remove')}
                          aria-label={`${t(lang, 'buttons.remove')}: ${nameLabel}`}
                          onClick={() => onChange(activities.filter((a) => a.id !== activity.id))}
                        >
                          ×
                        </button>
                      </td>
                    ) : null}
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
