import { useMemo } from 'react';
import { useAppStateCtx } from '../app/state-contexts';
import { formatDate, todayEpochDays } from '../lib/dates/dates';
import { generateId } from '../lib/id';
import { formatSignedDuration, pad2 } from '../lib/formatting/format';
import {
  isoToAbsoluteMinutes,
  milestoneStatus,
  milestoneVarianceMinutes,
  type MilestoneStatus,
} from '../lib/calculations/milestones';
import type { Milestone, MilestoneType } from '../types';
import { t, type TranslationKey } from '../i18n';

interface MilestonePanelProps {
  /** Current wall-clock minutes-of-day; combined with today for OVERDUE detection. */
  now: number;
}

function minutesToTimeInput(minutes: number): string {
  const clamped = Math.max(0, Math.min(1439, Math.round(minutes)));
  return `${pad2(Math.floor(clamped / 60))}:${pad2(clamped % 60)}`;
}

const MILESTONE_STATUS_KEY: Record<MilestoneStatus, TranslationKey> = {
  PENDING: 'milestones.pending',
  REACHED: 'milestones.reached',
  OVERDUE: 'milestones.overdue',
};

/**
 * Level 2 §7: configurable milestones with automatic reach detection.
 * actualAt is stamped by the Dashboard effect (evaluateMilestones); this
 * panel only edits the configuration and displays derived status.
 */
export function MilestonePanel({ now }: MilestonePanelProps) {
  const { state, updateField } = useAppStateCtx();
  const lang = state.language;
  const milestones = state.milestones ?? [];
  const nowAbsoluteMinutes = todayEpochDays() * 1440 + now;

  const setMilestones = (next: Milestone[]): void => updateField('milestones', next);

  const addMilestone = (): void => {
    setMilestones([
      ...milestones,
      { id: generateId(), name: '', type: 'EXECUTE', targetPct: 100, plannedDate: null, plannedTime: null, actualAt: null },
    ]);
  };

  const updateMilestone = (id: string, patch: Partial<Milestone>): void => {
    setMilestones(milestones.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  };

  const removeMilestone = (id: string): void => {
    if (!window.confirm(t(lang, 'milestones.confirmRemove'))) return;
    setMilestones(milestones.filter((m) => m.id !== id));
  };

  const displayName = (m: Milestone): string => {
    if (m.name.trim() !== '') return m.name;
    return t(lang, m.type === 'EXECUTE' ? 'milestones.defaultName.execute' : 'milestones.defaultName.pass', { pct: m.targetPct });
  };

  const actualDisplay = (m: Milestone): string => {
    if (m.actualAt === null) return '—';
    const abs = isoToAbsoluteMinutes(m.actualAt);
    if (abs === null) return '—';
    return `${formatDate(Math.floor(abs / 1440))} ${minutesToTimeInput(abs % 1440)}`;
  };

  const statusByType = useMemo(
    () => milestones.map((m) => milestoneStatus(m, nowAbsoluteMinutes)),
    [milestones, nowAbsoluteMinutes],
  );

  return (
    <section className="milestone-panel">
      <p className="milestone-hint">{t(lang, 'milestones.autoHint')}</p>
      {milestones.length === 0 ? (
        <p className="empty-note">{t(lang, 'milestones.empty')}</p>
      ) : (
        <div className="table-wrap">
          <table className="dr-table milestone-table">
            <thead>
              <tr>
                <th scope="col">{t(lang, 'milestones.name')}</th>
                <th scope="col">{t(lang, 'milestones.type')}</th>
                <th scope="col" className="num">{t(lang, 'milestones.targetPct')}</th>
                <th scope="col">{t(lang, 'milestones.plannedAt')}</th>
                <th scope="col">{t(lang, 'milestones.actualAt')}</th>
                <th scope="col" className="num">{t(lang, 'milestones.variance')}</th>
                <th scope="col">{t(lang, 'milestones.status')}</th>
                <th scope="col">{t(lang, 'columns.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {milestones.map((m, index) => {
                const status = statusByType[index];
                const variance = milestoneVarianceMinutes(m);
                return (
                  <tr key={m.id} className={status === 'REACHED' ? 'completes' : undefined}>
                    <td>
                      <input
                        className="input"
                        type="text"
                        placeholder={displayName(m)}
                        aria-label={t(lang, 'milestones.name')}
                        value={m.name}
                        onChange={(e) => updateMilestone(m.id, { name: e.target.value })}
                      />
                    </td>
                    <td>
                      <select
                        className="input"
                        aria-label={t(lang, 'milestones.type')}
                        value={m.type}
                        onChange={(e) => updateMilestone(m.id, { type: e.target.value as MilestoneType })}
                      >
                        <option value="EXECUTE">{t(lang, 'milestones.execute')}</option>
                        <option value="PASS">{t(lang, 'milestones.pass')}</option>
                      </select>
                    </td>
                    <td className="num">
                      <input
                        className="input input-cell"
                        type="number"
                        min={1}
                        max={100}
                        step={1}
                        aria-label={t(lang, 'milestones.targetPct')}
                        value={m.targetPct}
                        onChange={(e) => {
                          const pct = Number(e.target.value);
                          if (Number.isFinite(pct) && pct > 0 && pct <= 100) updateMilestone(m.id, { targetPct: pct });
                        }}
                      />
                    </td>
                    <td>
                      <span className="ms-planned-inputs">
                        <input
                          className="input input-date"
                          type="date"
                          aria-label={t(lang, 'milestones.plannedDate')}
                          value={m.plannedDate ?? ''}
                          onChange={(e) => updateMilestone(m.id, { plannedDate: e.target.value === '' ? null : e.target.value })}
                        />
                        <input
                          className="input input-cell"
                          type="time"
                          aria-label={t(lang, 'milestones.plannedTime')}
                          value={m.plannedTime ?? ''}
                          onChange={(e) => updateMilestone(m.id, { plannedTime: e.target.value === '' ? null : e.target.value })}
                        />
                      </span>
                    </td>
                    <td>{actualDisplay(m)}</td>
                    <td className={`num ${variance === null ? '' : variance <= 0 ? 'tone-text-good' : 'tone-text-bad'}`}>
                      {formatSignedDuration(variance)}
                    </td>
                    <td>
                      <span className={`ms-status ${status.toLowerCase()}`}>
                        {t(lang, MILESTONE_STATUS_KEY[status])}
                      </span>
                    </td>
                    <td>
                      <button type="button" className="btn btn-ghost" onClick={() => removeMilestone(m.id)}>
                        {t(lang, 'buttons.remove')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="milestone-actions">
        <button type="button" className="btn" onClick={addMilestone}>
          {t(lang, 'milestones.add')}
        </button>
      </div>
    </section>
  );
}
