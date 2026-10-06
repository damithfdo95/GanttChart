import { describe, expect, it } from 'vitest';
import type { QaInputs } from '../types';
import {
  buildAdditionalTimeScenarios,
  buildBlockingScenarios,
  buildCurrentScenario,
  buildPresetScenario,
  buildRateScenarios,
  buildRecoveryBaseline,
  buildTesterScenarios,
  calculateRecoveryGapCases,
  calculateRecoveryGapMinutes,
  calculateScenarioResult,
  findRecoveryOptions,
} from '../lib/calculations/recovery';
import { calculateProductiveElapsedTime } from '../lib/calculations/schedule';
import { calculateActualRate, calculateScheduleVariance } from '../lib/calculations/execution';

/**
 * Fixed workday model: 9:00–17:30 with a 12:00–13:00 lunch, 8 testers × 4
 * cases/h/tester. The persisted intraday time fields in the fixture are
 * ignored by the engine. Deterministic `now` values — the engine never
 * reads the clock itself.
 */
function inputs(overrides: Partial<QaInputs> = {}): QaInputs {
  return {
    totalCases: 36,
    currentTesters: 8,
    startTime: 9 * 60, // Plan Start Time (per-project workday start)
    targetFinish: 17 * 60,
    lunchStart: 0,
    lunchEnd: 0,
    perHourPerTester: 4,
    casesCompleted: 15,
    casesPassed: 11,
    startDate: '2026-09-29',
    targetCompletionDate: null,
    targetCompletionTime: null,
    planningRows: [
      { id: 'p1', date: '2026-09-29', plannedTesters: 8, absentTesters: 0, nonWorkingDay: false, note: '' },
    ],
    ...overrides,
  };
}

const WORK_START = 9 * 60;
const WORK_END = 17 * 60 + 30;
const LUNCH = { start: 12 * 60, end: 13 * 60 };

// now = 10:00 → 1 productive hour elapsed (9:00–10:00), 15 cases done → 15 cases/h actual.
const NOW = 10 * 60;
// now = 11:00 → 2 productive hours elapsed (used with 60 blocked minutes).
const NOW_LATE = 11 * 60;

describe('buildRecoveryBaseline', () => {
  it('uses the existing engine for the baseline projection and variance', () => {
    const baseline = buildRecoveryBaseline(inputs(), NOW, 0);
    const elapsedHours = calculateProductiveElapsedTime(NOW, WORK_START, LUNCH) / 60;
    const rate = calculateActualRate(15, elapsedHours);
    expect(baseline.currentRatePerHour).toBe(rate); // 15/h
    expect(baseline.currentVarianceMinutes).toBe(calculateScheduleVariance(baseline.currentProjectedFinish, WORK_END));
    expect(baseline.casesRemaining).toBe(21);
    expect(baseline.currentStatus).toBe('DELAYED'); // expected 32 by 10:00, actual 15
    expect(baseline.currentProjectedFinish).toBe(NOW + 84); // 21 cases / 15/h = 84 min
  });

  it('anchors the default scenario rate to the actual effective pace', () => {
    const baseline = buildRecoveryBaseline(inputs(), NOW, 0);
    expect(baseline.baselinePerTesterRate).toBeCloseTo(15 / 8, 10);
  });

  it('falls back to the plan rate when no actual data exists', () => {
    const baseline = buildRecoveryBaseline(inputs({ casesCompleted: 0 }), NOW, 0);
    expect(baseline.currentRatePerHour).toBe(0);
    expect(baseline.baselinePerTesterRate).toBe(4);
  });

  it('excludes the fixed lunch from the productive time remaining', () => {
    const baseline = buildRecoveryBaseline(inputs(), NOW_LATE, 0);
    // 11:00 → 17:30 minus the fixed 12:00–13:00 lunch = 330 productive minutes.
    expect(baseline.productiveRemainingMinutes).toBe(330);
  });
});

describe('calculateScenarioResult', () => {
  const baseline = () => buildRecoveryBaseline(inputs(), NOW, 0);

  it('scenario capacity: 8×4 = 32, 10×4 = 40 cases/hour (§24 example)', () => {
    const current = calculateScenarioResult(baseline(), buildCurrentScenario(baseline()));
    expect(current.teamCapacityPerHour).toBe(15); // 8 × (15/8): actual-anchored
    const boosted = calculateScenarioResult(baseline(), {
      testers: 10,
      casesPerHourPerTester: 4,
      additionalProductiveMinutes: 0,
      unavailableMinutesReduction: 0,
    });
    expect(boosted.teamCapacityPerHour).toBe(40);
  });

  it('the untouched scenario reproduces the existing projected finish exactly', () => {
    const base = baseline();
    const result = calculateScenarioResult(base, buildCurrentScenario(base));
    expect(result.projectedFinish).toBe(base.currentProjectedFinish);
    expect(result.varianceMinutes).toBe(base.currentVarianceMinutes);
  });

  it('more capacity finishes earlier and can recover the target', () => {
    const base = baseline();
    const same = calculateScenarioResult(base, {
      testers: 10,
      casesPerHourPerTester: 1.5, // 15/h — same pace as current
      additionalProductiveMinutes: 0,
      unavailableMinutesReduction: 0,
    });
    expect(same.projectedFinish).toBe(base.currentProjectedFinish);
    const faster = calculateScenarioResult(base, {
      testers: 10,
      casesPerHourPerTester: 4, // 40/h → 21 cases in 31.5 min → 10:31:30
      additionalProductiveMinutes: 0,
      unavailableMinutesReduction: 0,
    });
    expect(faster.projectedFinish).toBe(10 * 60 + 31.5);
    expect(faster.status).toBe('AHEAD');
    expect(faster.recovered).toBe(true);
  });

  it('skips the fixed lunch when advancing the projected finish (§24-14)', () => {
    const base = buildRecoveryBaseline(inputs(), NOW_LATE, 0);
    // Pace 7.5/h (15 cases in 2 h) → 21 cases = 168 productive min from
    // 11:00, crossing the 12:00–13:00 lunch → 14:48 (without the lunch skip
    // it would be 13:48). The untouched scenario stays identical.
    expect(base.currentProjectedFinish).toBe(14 * 60 + 48);
    const result = calculateScenarioResult(base, buildCurrentScenario(base));
    expect(result.projectedFinish).toBe(base.currentProjectedFinish);
    const fixed = calculateScenarioResult(base, {
      testers: 10,
      casesPerHourPerTester: 4, // 40/h → 31.5 min → 11:31:30 (no lunch crossing)
      additionalProductiveMinutes: 0,
      unavailableMinutesReduction: 0,
    });
    expect(fixed.projectedFinish).toBe(11 * 60 + 31.5);
  });

  it('handles projected finishes past midnight (§24-15)', () => {
    const base = buildRecoveryBaseline(inputs({ currentTesters: 2 }), NOW, 0);
    const result = calculateScenarioResult(base, {
      testers: 1,
      casesPerHourPerTester: 0.5, // 0.5/h → 21 cases = 42 h
      additionalProductiveMinutes: 0,
      unavailableMinutesReduction: 0,
    });
    expect(result.projectedFinish).not.toBeNull();
    expect(result.projectedFinish!).toBeGreaterThan(24 * 60);
    expect(result.status).toBe('DELAYED');
  });

  it('additional productive time extends the effective target only (§3C)', () => {
    const base = baseline();
    const without = calculateScenarioResult(base, buildCurrentScenario(base));
    const with60 = calculateScenarioResult(base, { ...buildCurrentScenario(base), additionalProductiveMinutes: 60 });
    expect(with60.projectedFinish).toBe(without.projectedFinish);
    expect(with60.effectiveTargetFinish).toBe(17 * 60 + 30 + 60);
    expect(with60.varianceMinutes).toBe(without.varianceMinutes! + 60);
    expect(with60.availableProductiveMinutes).toBe(without.availableProductiveMinutes + 60);
  });

  it('required rate uses the effective target and remaining cases', () => {
    const base = baseline();
    const result = calculateScenarioResult(base, { ...buildCurrentScenario(base), additionalProductiveMinutes: 60 });
    // 21 cases / 7.5 h (10:00→18:30 minus the fixed lunch) = 2.8 cases/h.
    expect(result.requiredRatePerHour).toBeCloseTo(21 / 7.5, 10);
  });

  it('expected cases by target are capped at total cases (§6)', () => {
    const base = baseline();
    const result = calculateScenarioResult(base, {
      testers: 20,
      casesPerHourPerTester: 4,
      additionalProductiveMinutes: 0,
      unavailableMinutesReduction: 0,
    });
    expect(result.expectedCasesByTarget).toBe(36);
    expect(result.remainingAfterTarget).toBe(0);
    expect(result.recovered).toBe(true);
  });

  it('zero remaining cases → COMPLETED (§24-17/18)', () => {
    const done = inputs({ casesCompleted: 36 });
    const base = buildRecoveryBaseline(done, NOW, 0);
    const result = calculateScenarioResult(base, buildCurrentScenario(base));
    expect(result.status).toBe('COMPLETED');
    expect(result.projectedFinish).toBeNull();
  });

  it('target already achieved → the current scenario is recovered (§24-19)', () => {
    const fast = inputs({ casesCompleted: 30 }); // 30/h → 6 cases left
    const base = buildRecoveryBaseline(fast, NOW, 0);
    expect(base.currentVarianceMinutes).toBeGreaterThan(0);
    const result = calculateScenarioResult(base, buildCurrentScenario(base));
    expect(result.recovered).toBe(true);
    expect(result.status).toBe('AHEAD');
  });
});

describe('blocking reduction (§13)', () => {
  // 15:00: 2 productive hours elapsed, 60 blocked → 15 cases in 1 effective
  // hour → effective pace 15/h, gross pace 7.5/h.
  it('no reduction reproduces the gross-rate baseline exactly', () => {
    const base = buildRecoveryBaseline(inputs(), NOW_LATE, 60);
    expect(base.currentRatePerHour).toBe(7.5);
    expect(base.effectiveRatePerHour).toBe(15);
    const result = calculateScenarioResult(base, { ...buildCurrentScenario(base), unavailableMinutesReduction: 0 });
    expect(result.projectedFinish).toBe(base.currentProjectedFinish);
    expect(result.effectivePacePerHour).toBeCloseTo(7.5, 10);
  });

  it('full reduction moves the finish earlier using the unblocked pace', () => {
    const base = buildRecoveryBaseline(inputs(), NOW_LATE, 60);
    const result = calculateScenarioResult(base, { ...buildCurrentScenario(base), unavailableMinutesReduction: 60 });
    expect(result.effectivePacePerHour).toBeCloseTo(15, 10);
    // 21 / 15/h = 84 productive min from 11:00, crossing the fixed lunch → 13:24.
    expect(result.projectedFinish).toBe(13 * 60 + 24);
    expect(result.projectedFinish!).toBeLessThan(base.currentProjectedFinish!);
  });

  it('partial reduction stays between the gross and effective paces', () => {
    const base = buildRecoveryBaseline(inputs(), NOW_LATE, 60);
    const partial = calculateScenarioResult(base, { ...buildCurrentScenario(base), unavailableMinutesReduction: 30 });
    expect(partial.effectivePacePerHour).toBeCloseTo(11.25, 10); // 15 × 0.75
    expect(partial.effectivePacePerHour!).toBeGreaterThan(base.currentRatePerHour!);
    expect(partial.effectivePacePerHour!).toBeLessThan(15);
  });

  it('generates no blocking scenarios without unavailable time', () => {
    const base = buildRecoveryBaseline(inputs(), NOW, 0);
    expect(buildBlockingScenarios(base)).toHaveLength(0);
  });

  it('generates percentage-based reduction scenarios when blocked', () => {
    const base = buildRecoveryBaseline(inputs(), NOW_LATE, 60);
    expect(buildBlockingScenarios(base).map((o) => o.value)).toEqual([15, 30, 45, 60]);
  });
});

describe('recovery gap (§10)', () => {
  it('is the productive delay between target and current projection', () => {
    // 3/h actual (3 cases in the first hour), 33 remaining → 11 h of work
    // → projected 22:00 (crossing the fixed lunch once) — 4.5 h past 17:30.
    const slow = buildRecoveryBaseline(inputs({ casesCompleted: 3 }), NOW, 0);
    expect(slow.currentProjectedFinish).toBe(22 * 60);
    expect(calculateRecoveryGapMinutes(slow)).toBe(270); // productive content of [17:30, 22:00]
  });

  it('is null without a projection and 0 when already on target', () => {
    expect(calculateRecoveryGapMinutes(buildRecoveryBaseline(inputs({ casesCompleted: 0 }), NOW, 0))).toBeNull();
    expect(calculateRecoveryGapMinutes(buildRecoveryBaseline(inputs({ casesCompleted: 30 }), NOW, 0))).toBe(0);
  });

  it('converts the gap to cases at the current pace', () => {
    expect(calculateRecoveryGapCases(60, 15)).toBe(15);
    expect(calculateRecoveryGapCases(0, 15)).toBe(0);
    expect(calculateRecoveryGapCases(null, 15)).toBeNull();
    expect(calculateRecoveryGapCases(60, null)).toBeNull();
  });
});

describe('automatic scenarios (§8, §11–§13, §16)', () => {
  it('tester scenarios run current−1 upward and stop after recovery (§11)', () => {
    // 3/h actual (3 cases in the first hour), 33 remaining = 11 h → 22:00
    // (delayed 4.5 h). Rate anchored at 3/8 = 0.375 per tester: recovery
    // needs ≥ 33/6.5 ≈ 5.08/h within the 6.5 h left → 14 testers.
    const base = buildRecoveryBaseline(inputs({ casesCompleted: 3 }), NOW, 0);
    const options = buildTesterScenarios(base);
    const values = options.map((o) => o.value);
    expect(values[0]).toBe(7); // current − 1
    expect(values).toContain(8); // current always present
    expect(values[values.length - 1]).toBe(14); // first recovered count above current
    expect(options.length).toBeLessThanOrEqual(2 + 8);
  });

  it('rate scenarios are current plus 5% steps to 30% (§12)', () => {
    const base = buildRecoveryBaseline(inputs(), NOW, 0);
    const options = buildRateScenarios(base);
    expect(options.map((o) => o.value)).toEqual([100, 105, 110, 115, 120, 125, 130]);
    expect(options[2].scenario.casesPerHourPerTester).toBeCloseTo((15 / 8) * 1.1, 1);
  });

  it('additional time scenarios are the configured steps', () => {
    const base = buildRecoveryBaseline(inputs(), NOW, 0);
    expect(buildAdditionalTimeScenarios(base).map((o) => o.value)).toEqual([15, 30, 45, 60]);
  });

  it('presets are pure functions of the baseline (§16)', () => {
    const base = buildRecoveryBaseline(inputs(), NOW_LATE, 60);
    expect(buildPresetScenario('plus1Tester', base).testers).toBe(9);
    expect(buildPresetScenario('plus2Testers', base).testers).toBe(10);
    expect(buildPresetScenario('plus10Rate', base).casesPerHourPerTester).toBeCloseTo((15 / 8) * 1.1, 1);
    expect(buildPresetScenario('minus30Blocking', base).unavailableMinutesReduction).toBe(30);
    const balanced = buildPresetScenario('balanced', base);
    expect(balanced.testers).toBe(9);
    expect(balanced.casesPerHourPerTester).toBeCloseTo((15 / 8) * 1.1, 1);
    expect(balanced.unavailableMinutesReduction).toBe(30);
  });

  it('findRecoveryOptions returns a bounded, best-first list (§8)', () => {
    const base = buildRecoveryBaseline(inputs({ currentTesters: 2 }), NOW_LATE, 60);
    const found = findRecoveryOptions(base);
    expect(found.options.length).toBe(3 + 6 + 4 + 4 + 1);
    const variances = found.options.map((o) => o.result.varianceMinutes ?? Number.NEGATIVE_INFINITY);
    expect([...variances].sort((a, b) => b - a)).toEqual(variances);
    expect(found.best).toBe(found.options[0]);
    if (found.anyRecovered) {
      expect(found.best?.result.recovered).toBe(true);
    }
  });

  it('combined scenarios flow through the same capacity/time model (§14)', () => {
    const base = buildRecoveryBaseline(inputs({ currentTesters: 4 }), NOW_LATE, 60);
    const combined = calculateScenarioResult(base, {
      testers: 5,
      casesPerHourPerTester: 4.4,
      additionalProductiveMinutes: 30,
      unavailableMinutesReduction: 30,
    });
    expect(combined.teamCapacityPerHour).toBe(22);
    expect(combined.effectivePacePerHour).toBeCloseTo(16.5, 10); // 22 × 0.75 blocking factor
    // (21 / 16.5) h from 11:00 crosses the fixed lunch → 13:00 + the rest.
    expect(combined.projectedFinish).toBeCloseTo(13 * 60 + (21 / 16.5) * 60 - 60, 8);
    expect(combined.effectiveTargetFinish).toBe(17 * 60 + 30 + 30);
  });

  it('no-recovery condition reports the best scenario factually (§19)', () => {
    const base = buildRecoveryBaseline(inputs({ totalCases: 1000, casesCompleted: 1, currentTesters: 1 }), NOW, 0);
    const found = findRecoveryOptions(base);
    expect(found.anyRecovered).toBe(false);
    expect(found.best).not.toBeNull();
    expect(found.best!.result.recovered).toBe(false);
    expect(found.best!.result.varianceMinutes!).toBeLessThan(0);
  });
});
