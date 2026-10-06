import type { LunchWindow, MinutesOfDay } from '../types';
import { formatClock, pad2 } from '../lib/formatting/format';

export interface TimelineLabels {
  start: string;
  now: string;
  expected: string;
  projected: string;
  target: string;
  lunch: string;
  progress: string;
  /** Level 2 §2: planned-progress overlay and tester capacity chips. */
  planned?: string;
  capacity?: string;
}

interface TimelineProps {
  startTime: MinutesOfDay;
  targetFinish: MinutesOfDay;
  lunch: LunchWindow;
  expectedFinish: MinutesOfDay | null;
  projectedFinish: MinutesOfDay | null;
  now: MinutesOfDay;
  /** Completed fraction of total cases, 0..1. */
  progress: number;
  labels: TimelineLabels;
  /** Planned completion fraction by now, 0..1 (drawn as an overlay). */
  plannedProgress?: number | null;
  /** Team hourly capacity (cases/h) shown as a chip. */
  capacityPerHour?: number | null;
}

interface Tick {
  left: number;
  label: string | null;
}

/**
 * Single-day execution timeline (§18): work window, lunch block, actual
 * progress fill, and markers for now / expected finish / projected finish /
 * target finish. Pure CSS positioning — no chart library, no external assets.
 */
export function Timeline({
  startTime,
  targetFinish,
  lunch,
  expectedFinish,
  projectedFinish,
  now,
  progress,
  labels,
  plannedProgress = null,
  capacityPerHour = null,
}: TimelineProps) {
  const domainEnd = Math.max(
    startTime + 60, // avoid a degenerate zero-span domain
    targetFinish,
    now,
    expectedFinish ?? startTime,
    projectedFinish ?? startTime,
  );
  const span = domainEnd - startTime;
  const pct = (value: number): number => ((value - startTime) / span) * 100;

  // Hourly gridlines with a clock label every 2 hours.
  const ticks: Tick[] = [];
  for (let m = Math.ceil(startTime / 60) * 60; m <= domainEnd; m += 60) {
    const hour = (m / 60) % 24;
    ticks.push({ left: pct(m), label: hour % 2 === 0 ? `${pad2(hour)}:00` : null });
  }

  // Actual progress is drawn over the planned execution span [start, expected finish].
  const plannedEnd = expectedFinish ?? targetFinish;
  const progressMinutes = Math.max(0, Math.min(1, progress)) * Math.max(0, plannedEnd - startTime);
  const plannedMinutes =
    plannedProgress === null ? null : Math.max(0, Math.min(1, plannedProgress)) * Math.max(0, plannedEnd - startTime);
  const lunchVisible = lunch.end > startTime && lunch.start < domainEnd && lunch.end > lunch.start;

  const expectedPos = expectedFinish === null ? null : pct(expectedFinish);
  const projectedPos = projectedFinish === null ? null : pct(projectedFinish);
  const nowPos = Math.min(100, Math.max(0, pct(now)));

  return (
    <div className="timeline">
      <div className="timeline-canvas">
        {ticks.map((tick) => (
          <div key={tick.left} className="timeline-tick" style={{ left: `${tick.left}%` }}>
            {tick.label ? <span className="timeline-tick-label">{tick.label}</span> : null}
          </div>
        ))}
        <div className="timeline-window" style={{ left: '0%', width: `${Math.max(0, pct(targetFinish))}%` }} />
        {lunchVisible ? (
          <div
            className="timeline-lunch"
            style={{ left: `${pct(lunch.start)}%`, width: `${Math.max(0, pct(lunch.end) - pct(lunch.start))}%` }}
          />
        ) : null}
        {plannedMinutes === null ? null : (
          <div className="timeline-planned" style={{ left: '0%', width: `${Math.max(0, pct(startTime + plannedMinutes))}%` }} />
        )}
        <div className="timeline-progress" style={{ left: '0%', width: `${Math.max(0, pct(startTime + progressMinutes))}%` }} />
        <div className="timeline-marker marker-target" style={{ left: `${pct(targetFinish)}%` }} />
        {expectedPos === null ? null : (
          <div className="timeline-marker marker-expected" style={{ left: `${expectedPos}%` }} />
        )}
        {projectedPos === null ? null : (
          <div className="timeline-marker marker-projected" style={{ left: `${projectedPos}%` }} />
        )}
        <div className="timeline-marker marker-now" style={{ left: `${nowPos}%` }} />
      </div>
      <div className="timeline-legend">
        <span className="legend-chip">{labels.start}: {formatClock(startTime)}</span>
        {lunchVisible ? (
          <span className="legend-chip chip-lunch">
            {labels.lunch}: {formatClock(lunch.start)}–{formatClock(lunch.end)}
          </span>
        ) : null}
        <span className="legend-chip chip-now">{labels.now}: {formatClock(now)}</span>
        {expectedPos === null ? null : (
          <span className="legend-chip chip-expected">{labels.expected}: {formatClock(expectedFinish)}</span>
        )}
        {projectedPos === null ? null : (
          <span className="legend-chip chip-projected">{labels.projected}: {formatClock(projectedFinish)}</span>
        )}
        <span className="legend-chip chip-target">{labels.target}: {formatClock(targetFinish)}</span>
        {capacityPerHour === null ? null : (
          <span className="legend-chip chip-capacity">
            {labels.capacity ?? 'Capacity'}: {capacityPerHour}
          </span>
        )}
        {plannedProgress === null ? null : (
          <span className="legend-chip chip-planned">
            {labels.planned ?? 'Planned'}: {Math.round(Math.max(0, Math.min(1, plannedProgress)) * 100)}%
          </span>
        )}
        <span className="legend-chip chip-progress">
          {labels.progress}: {Math.round(Math.max(0, Math.min(1, progress)) * 100)}%
        </span>
      </div>
    </div>
  );
}
