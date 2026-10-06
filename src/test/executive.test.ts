import { describe, expect, it } from 'vitest';
import { calculateExecutiveSummary, calculateRequiredRatePerHour } from '../lib/calculations/executive';
import { DEMO_STATE } from '../lib/storage/storage';
import { parseDate } from '../lib/dates/dates';
import type { QaInputs } from '../types';

function demoInputs(): QaInputs {
  // Demo values (§26): 36 cases, 8 testers, 4/h, 15 done, Plan Start Time
  // 9:00 (the default). targetFinish/lunch are ignored — the calculation
  // uses the fixed 17:30 end and 12:00–13:00 lunch.
  return {
    totalCases: 36,
    currentTesters: 8,
    startTime: 9 * 60,
    targetFinish: 17 * 60,
    lunchStart: 0,
    lunchEnd: 0,
    perHourPerTester: 4,
    casesCompleted: 15,
    casesPassed: 11,
    startDate: '2026-09-29',
    targetCompletionDate: '2026-09-29',
    targetCompletionTime: null,
    planningRows: [
      { id: 'p1', date: '2026-09-29', plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' },
    ],
  };
}

describe('calculateRequiredRatePerHour', () => {
  it('divides remaining cases by the productive hours left', () => {
    // 13:00–17:00, now 15:00 → 2h left; 20 cases → 10 cases/h.
    expect(calculateRequiredRatePerHour(20, 13 * 60, 17 * 60, { start: 0, end: 0 }, 15 * 60)).toBe(10);
  });

  it('excludes lunch from the remaining time', () => {
    // now 11:00, target 14:00, lunch 12:00–13:00 → 2h left.
    expect(calculateRequiredRatePerHour(30, 9 * 60, 14 * 60, { start: 12 * 60, end: 13 * 60 }, 11 * 60)).toBe(15);
  });

  it('measures from start when now is before start', () => {
    expect(calculateRequiredRatePerHour(40, 13 * 60, 17 * 60, { start: 0, end: 0 }, 9 * 60)).toBe(10);
  });

  it('is null when nothing remains', () => {
    expect(calculateRequiredRatePerHour(0, 13 * 60, 17 * 60, { start: 0, end: 0 }, 14 * 60)).toBeNull();
  });

  it('is null when no productive time is left', () => {
    expect(calculateRequiredRatePerHour(5, 13 * 60, 17 * 60, { start: 0, end: 0 }, 17 * 60)).toBeNull();
  });
});

describe('calculateExecutiveSummary', () => {
  it('composes the 13 five-second metrics from the existing engine', () => {
    const summary = calculateExecutiveSummary(demoInputs(), 14 * 60);
    expect(summary.totalCases).toBe(36);
    expect(summary.casesCompleted).toBe(15);
    expect(summary.casesRemaining).toBe(21);
    expect(summary.progressRatio).toBeCloseTo(15 / 36, 10);
    expect(summary.currentTesters).toBe(8);
    expect(summary.requiredTesters).toBe(1); // ceil(21 remaining / (4 × 7.5 × 1 day))
    expect(summary.currentRatePerHour).toBeCloseTo(15 / 4, 10); // 15 cases / 4 elapsed hours (9:00–14:00 minus lunch)
    expect(summary.requiredRatePerHour).toBeCloseTo(21 / 3.5, 10); // 3.5h left at 14:00 (lunch already past)
    expect(summary.expectedFinish).toBe(9 * 60 + 39.375); // remaining 21 cases / 32 per hour from 9:00
    expect(summary.projectedFinish).not.toBeNull();
    expect(summary.targetFinish).toBe(17 * 60 + 30); // fixed workday end
    expect(summary.varianceMinutes).toBe(17 * 60 + 30 - summary.projectedFinish!);
    // Deadline-dominant status: pace is behind (expected ≈36 by 14:00,
    // actual 15) but the remaining 21 cases need only ~39 minutes of the
    // 32/h team capacity — the projection finishes well before the 17:30
    // deadline (positive buffer), so the verdict is ON_SCHEDULE, not a
    // contradictory red Delayed.
    expect(summary.status).toBe('ON_SCHEDULE');
  });

  it('reports DELAYED when the deadline is genuinely at risk (negative buffer)', () => {
    // 985 remaining cases on one planned day at 32/h — the capacity
    // projection cannot finish by the 17:30 deadline → DELAYED.
    const summary = calculateExecutiveSummary({ ...demoInputs(), totalCases: 1000 }, 14 * 60);
    expect(summary.status).toBe('DELAYED');
  });

  it('anchors the expected finish at NOW when the current day is given', () => {
    // Anchor 14:00 on the (only) planning day: the remaining 21 cases finish
    // 39.375 productive minutes from 14:00 → 14:39:22 today (0 day offset).
    const summary = calculateExecutiveSummary(demoInputs(), 14 * 60, parseDate('2026-09-29') ?? 0);
    expect(summary.expectedFinish).toBeCloseTo(14 * 60 + 39.375, 6);
    // Required testers over the remaining window: 3.5h left today only.
    expect(summary.requiredTesters).toBe(2); // ceil(21 / (4 × 3.5))
  });

  it('progress ratio is null with zero total cases', () => {
    const inputs = { ...demoInputs(), totalCases: 0, casesCompleted: 0 };
    expect(calculateExecutiveSummary(inputs, 14 * 60).progressRatio).toBeNull();
  });

  it('reports COMPLETED when everything is done', () => {
    const inputs = { ...demoInputs(), casesCompleted: 36, casesPassed: 36 };
    const summary = calculateExecutiveSummary(inputs, 14 * 60);
    expect(summary.status).toBe('COMPLETED');
    expect(summary.casesRemaining).toBe(0);
    expect(summary.requiredRatePerHour).toBeNull();
  });

  it('reports NOT STARTED before the work start (9:00) with no progress', () => {
    const inputs = { ...demoInputs(), casesCompleted: 0, casesPassed: 0 };
    expect(calculateExecutiveSummary(inputs, 8 * 60).status).toBe('NOT_STARTED');
  });

  it('matches the demo state values', () => {
    const summary = calculateExecutiveSummary(DEMO_STATE, 14 * 60);
    expect(summary.totalCases).toBe(DEMO_STATE.totalCases);
    expect(summary.casesCompleted).toBe(DEMO_STATE.casesCompleted);
    expect(summary.progressRatio).toBeCloseTo(DEMO_STATE.casesCompleted / DEMO_STATE.totalCases, 10);
  });
});
