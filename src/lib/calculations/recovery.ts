import type { LunchWindow, MinutesOfDay, QaInputs, ScheduleStatus } from '../../types';
import { calculateProductiveHours, calculateTeamCapacity } from './capacity';
import { calculateProductiveElapsedTime, calculateScheduleStatus } from './schedule';
import { calculateActualRate, calculateProjectedActualFinish, calculateScheduleVariance } from './execution';
import { calculateRequiredRatePerHour } from './executive';
import { calculateEffectiveElapsedMinutes } from './blocking';
import {
  WORK_DAY_END,
  WORK_LUNCH,
  calculateWorkdayProjection,
  clampOvertimeMinutes,
  dayWindowsFromRows,
  projectDayWindowDefaults,
} from './workday';

/**
 * V6 — Recovery & What-If Analysis. Pure simulation engine: it never reads
 * the clock (the caller passes `now` and the unavailable minutes), never
 * touches project state, and reuses the existing calculation engine for
 * every shared concept. The scenario model is deliberately separate from
 * the project model: applying a scenario is an explicit user action
 * performed by the UI layer, never by these functions.
 *
 * Simulation model (documented):
 * - Scenario team capacity = testers × casesPerHourPerTester (available-time
 *   capability, before blocking).
 * - Future pace = capacity × blockingFactor, where blockingFactor is the
 *   share of productive elapsed time expected to remain unblocked after the
 *   simulated reduction. With no reduction the default scenario (current
 *   testers, baseline per-tester rate) reproduces the existing engine's
 *   projected finish exactly; with full reduction the unblocked pace
 *   (effective rate) applies.
 * - additionalProductiveMinutes extends the work window AFTER the target
 *   (overtime): the projected finish itself is unchanged, but the effective
 *   target for variance/recovery moves later.
 * - unavailableMinutesReduction only ever reduces the SIMULATED unavailable
 *   time; the stored blocking records are never modified.
 */

/** One what-if simulation input set — always separate from the project state. */
export interface RecoveryScenario {
  testers: number;
  casesPerHourPerTester: number;
  additionalProductiveMinutes: number;
  unavailableMinutesReduction: number;
}

/** Current project baseline, composed from the existing engine. */
export interface RecoveryBaseline {
  now: MinutesOfDay;
  lunch: LunchWindow;
  startTime: MinutesOfDay;
  targetFinish: MinutesOfDay;
  totalCases: number;
  casesCompleted: number;
  casesRemaining: number;
  currentTesters: number;
  planPerHourPerTester: number;
  planTeamCapacityPerHour: number;
  /** Gross actual team rate (existing engine semantics); null before start. */
  currentRatePerHour: number | null;
  /** Actual team rate over unblocked (effective) time; null before start. */
  effectiveRatePerHour: number | null;
  /**
   * Default scenario rate: the actual effective per-tester pace, falling
   * back to the plan rate when no actual data exists yet. With this rate the
   * untouched scenario reproduces the existing projected finish.
   */
  baselinePerTesterRate: number;
  productiveElapsedMinutes: number;
  /** Lunch-excluded productive minutes between now and the target (0 when past). */
  productiveRemainingMinutes: number;
  /** QA unavailable minutes for the current day (passed in by the caller). */
  unavailableMinutes: number;
  currentProjectedFinish: MinutesOfDay | null;
  currentVarianceMinutes: number | null;
  currentStatus: ScheduleStatus;
}

/** Build the current baseline. `unavailableMinutes` comes from the blocking data. */
export function buildRecoveryBaseline(
  inputs: QaInputs,
  now: MinutesOfDay,
  unavailableMinutes: number,
  todayWindow?: { start: MinutesOfDay; lunch: LunchWindow },
  anchorEpochDay?: number,
): RecoveryBaseline {
  // V7: today's pace uses the window that actually applies today (today's
  // execution entry when one exists); without one the project defaults apply.
  const startW = todayWindow?.start ?? inputs.startTime;
  const lunch: LunchWindow = todayWindow?.lunch ?? WORK_LUNCH;
  // Real daily overtime is part of the baseline: the effective target and
  // remaining productive time run to 17:30 + OT. A scenario's simulated
  // "additional productive time" stacks on top of the configured overtime.
  const ot = clampOvertimeMinutes(inputs.dailyOvertimeMinutes);
  const effectiveDayEnd = WORK_DAY_END + ot;
  const elapsed = calculateProductiveElapsedTime(now, startW, lunch);
  const grossRate = calculateActualRate(inputs.casesCompleted, elapsed / 60);
  const effectiveElapsed = calculateEffectiveElapsedMinutes(elapsed, unavailableMinutes);
  const effectiveRate = calculateActualRate(inputs.casesCompleted, effectiveElapsed / 60);
  const casesRemaining = Math.max(0, inputs.totalCases - inputs.casesCompleted);
  const currentProjectedFinish = calculateProjectedActualFinish(now, casesRemaining, grossRate, lunch);
  const baselinePerTesterRate =
    effectiveRate !== null && effectiveRate > 0 && inputs.currentTesters > 0
      ? effectiveRate / inputs.currentTesters
      : inputs.perHourPerTester;
  return {
    now,
    lunch,
    startTime: startW,
    targetFinish: effectiveDayEnd,
    totalCases: inputs.totalCases,
    casesCompleted: inputs.casesCompleted,
    casesRemaining,
    currentTesters: inputs.currentTesters,
    planPerHourPerTester: inputs.perHourPerTester,
    planTeamCapacityPerHour: calculateTeamCapacity(inputs.currentTesters, inputs.perHourPerTester),
    currentRatePerHour: grossRate,
    effectiveRatePerHour: effectiveRate,
    baselinePerTesterRate,
    productiveElapsedMinutes: elapsed,
    productiveRemainingMinutes: Math.max(
      0,
      calculateProductiveHours(Math.max(now, startW), effectiveDayEnd, lunch) * 60,
    ),
    unavailableMinutes: Math.max(0, unavailableMinutes),
    currentProjectedFinish,
    currentVarianceMinutes: calculateScheduleVariance(currentProjectedFinish, effectiveDayEnd),
    // Deadline-dominant status, consistent with the Dashboard status card:
    // the same capacity projection supplies the deadline buffer (omitted
    // when no anchor day is given — legacy pace-only behavior).
    currentStatus: calculateScheduleStatus(
      inputs,
      now,
      { start: startW, lunch },
      anchorEpochDay === undefined
        ? undefined
        : calculateWorkdayProjection({
            totalCases: inputs.totalCases,
            casesCompleted: inputs.casesCompleted,
            currentTesters: inputs.currentTesters,
            perHourPerTester: inputs.perHourPerTester,
            planningRows: inputs.planningRows,
            startDate: inputs.startDate,
            endDate: inputs.targetCompletionDate,
            planStartTime: inputs.startTime,
            anchor: { epochDay: anchorEpochDay, timeOfDay: now },
            dailyOvertimeMinutes: ot,
            dayWindows: dayWindowsFromRows(inputs.planningRows, projectDayWindowDefaults(inputs)),
          }).bufferMinutes,
    ),
  };
}

/** Result of one simulated scenario (all derived, never persisted). */
export interface ScenarioResult {
  scenario: RecoveryScenario;
  /** Available-time capability: testers × rate (cases/hour). */
  teamCapacityPerHour: number;
  /** Expected future pace after the blocking factor; null when not computable. */
  effectivePacePerHour: number | null;
  /** Target extended by the simulated overtime. */
  effectiveTargetFinish: MinutesOfDay;
  /** Lunch-excluded productive minutes available until the effective target. */
  availableProductiveMinutes: number;
  projectedFinish: MinutesOfDay | null;
  /** effectiveTarget − projected (existing variance semantics). */
  varianceMinutes: number | null;
  /** Existing status terminology (§6): no new competing status system. */
  status: ScheduleStatus;
  /** True when projected finish <= effective target (§9). */
  recovered: boolean;
  /** Cases expected to be completed by the effective target at scenario pace. */
  expectedCasesByTarget: number;
  /** Cases still remaining after the effective target. */
  remainingAfterTarget: number;
  /** Cases/hour needed to finish the remainder by the effective target. */
  requiredRatePerHour: number | null;
}

/**
 * Blocking factor: the share of productive elapsed time that is expected to
 * stay unblocked after the simulated reduction. 1 before start (nothing
 * observed yet — no de-rate).
 */
export function calculateBlockingFactor(productiveElapsedMinutes: number, unavailableMinutes: number, reductionMinutes: number): number {
  if (productiveElapsedMinutes <= 0) return 1;
  const stillBlocked = Math.max(0, unavailableMinutes - Math.max(0, reductionMinutes));
  return Math.max(0, Math.min(1, (productiveElapsedMinutes - stillBlocked) / productiveElapsedMinutes));
}

/** Simulate one scenario against the baseline. Pure and deterministic. */
export function calculateScenarioResult(baseline: RecoveryBaseline, scenario: RecoveryScenario): ScenarioResult {
  const testers = Math.max(1, Math.round(scenario.testers));
  const rate = Math.max(0, scenario.casesPerHourPerTester);
  const additional = Math.max(0, scenario.additionalProductiveMinutes);
  const reduction = Math.max(0, scenario.unavailableMinutesReduction);

  const teamCapacityPerHour = calculateTeamCapacity(testers, rate);
  const blockingFactor = calculateBlockingFactor(baseline.productiveElapsedMinutes, baseline.unavailableMinutes, reduction);
  const effectivePacePerHour = teamCapacityPerHour > 0 && blockingFactor > 0 ? teamCapacityPerHour * blockingFactor : null;

  const effectiveTargetFinish = baseline.targetFinish + additional;
  const projectedFinish =
    effectivePacePerHour === null || baseline.casesRemaining <= 0
      ? null
      : calculateProjectedActualFinish(baseline.now, baseline.casesRemaining, effectivePacePerHour, baseline.lunch);
  const varianceMinutes = calculateScheduleVariance(projectedFinish, effectiveTargetFinish);

  // Status uses the existing terminology (§6): COMPLETED > NOT_STARTED >
  // DELAYED / ON_SCHEDULE / AHEAD from the variance sign.
  let status: ScheduleStatus;
  if (baseline.casesRemaining <= 0) status = 'COMPLETED';
  else if (projectedFinish === null || varianceMinutes === null) status = 'NOT_STARTED';
  else if (varianceMinutes < 0) status = 'DELAYED';
  else if (varianceMinutes === 0) status = 'ON_SCHEDULE';
  else status = 'AHEAD';

  const availableProductiveMinutes = Math.max(
    0,
    calculateProductiveHours(Math.max(baseline.now, baseline.startTime), effectiveTargetFinish, baseline.lunch) * 60,
  );
  const achievable =
    effectivePacePerHour === null ? 0 : Math.min(baseline.casesRemaining, effectivePacePerHour * (availableProductiveMinutes / 60));
  const expectedCasesByTarget = baseline.casesCompleted + achievable;

  return {
    scenario: { testers, casesPerHourPerTester: rate, additionalProductiveMinutes: additional, unavailableMinutesReduction: reduction },
    teamCapacityPerHour,
    effectivePacePerHour,
    effectiveTargetFinish,
    availableProductiveMinutes,
    projectedFinish,
    varianceMinutes,
    status,
    recovered: projectedFinish !== null && projectedFinish <= effectiveTargetFinish,
    expectedCasesByTarget,
    remainingAfterTarget: Math.max(0, baseline.casesRemaining - achievable),
    requiredRatePerHour: calculateRequiredRatePerHour(
      baseline.casesRemaining,
      baseline.startTime,
      effectiveTargetFinish,
      baseline.lunch,
      baseline.now,
    ),
  };
}

/**
 * Recovery gap (§10): effective productive minutes still required to reach
 * the target under current conditions — the lunch-excluded content of the
 * interval [target, current projected finish]. 0 when already on target,
 * null when no projection exists yet.
 */
export function calculateRecoveryGapMinutes(baseline: RecoveryBaseline): number | null {
  if (baseline.currentProjectedFinish === null) return null;
  if (baseline.currentProjectedFinish <= baseline.targetFinish) return 0;
  return calculateProductiveHours(baseline.targetFinish, baseline.currentProjectedFinish, baseline.lunch) * 60;
}

/** Cases corresponding to the gap at the current pace; null when not computable. */
export function calculateRecoveryGapCases(gapMinutes: number | null, pacePerHour: number | null): number | null {
  if (gapMinutes === null || pacePerHour === null || pacePerHour <= 0) return null;
  if (gapMinutes <= 0) return 0;
  return (gapMinutes / 60) * pacePerHour;
}

// ---- Automatic scenario generation (§8, §11–§13) --------------------------

export type RecoveryOptionKind = 'current' | 'testers' | 'rate' | 'blocking' | 'additionalTime' | 'balanced';

export interface RecoveryOption {
  kind: RecoveryOptionKind;
  /**
   * kind-dependent meaning: testers = tester count; rate = multiplier
   * percent (105 = +5%); blocking = reduction minutes; additionalTime =
   * additional minutes; balanced = 0.
   */
  value: number;
  scenario: RecoveryScenario;
}

/** Bounded, configuration-style constants (§16) — no scattered magic numbers. */
export const RECOVERY_CONSTANTS = {
  testerMaxExtra: 8,
  testerMinDelta: -1,
  rateStepPercent: [5, 10, 15, 20, 25, 30] as const,
  blockingStepPercent: [25, 50, 75, 100] as const,
  additionalTimeStepMinutes: [15, 30, 45, 60] as const,
  optionsTesterExtra: [1, 2, 3] as const,
  balancedRateMultiplier: 1.1,
  balancedBlockingReductionMinutes: 30,
} as const;

function roundRate(rate: number): number {
  return Math.round(rate * 100) / 100;
}

/** The untouched scenario matching the current project values. */
export function buildCurrentScenario(baseline: RecoveryBaseline): RecoveryScenario {
  return {
    testers: baseline.currentTesters,
    casesPerHourPerTester: baseline.baselinePerTesterRate,
    additionalProductiveMinutes: 0,
    unavailableMinutesReduction: 0,
  };
}

/**
 * Tester scenarios (§11): current−1 up to current + testerMaxExtra, stopping
 * after the first clearly recovered count above the current one.
 */
export function buildTesterScenarios(baseline: RecoveryBaseline): RecoveryOption[] {
  const options: RecoveryOption[] = [];
  const start = Math.max(1, baseline.currentTesters + RECOVERY_CONSTANTS.testerMinDelta);
  const limit = baseline.currentTesters + RECOVERY_CONSTANTS.testerMaxExtra;
  for (let testers = start; testers <= limit; testers++) {
    const scenario: RecoveryScenario = {
      testers,
      casesPerHourPerTester: baseline.baselinePerTesterRate,
      additionalProductiveMinutes: 0,
      unavailableMinutesReduction: 0,
    };
    options.push({ kind: 'testers', value: testers, scenario });
    if (testers >= baseline.currentTesters && calculateScenarioResult(baseline, scenario).recovered) break;
  }
  return options;
}

/** Rate scenarios (§12): current rate and +5% … +30%. */
export function buildRateScenarios(baseline: RecoveryBaseline): RecoveryOption[] {
  const options: RecoveryOption[] = [
    { kind: 'rate', value: 100, scenario: { ...buildCurrentScenario(baseline) } },
  ];
  for (const pct of RECOVERY_CONSTANTS.rateStepPercent) {
    options.push({
      kind: 'rate',
      value: 100 + pct,
      scenario: {
        testers: baseline.currentTesters,
        casesPerHourPerTester: roundRate(baseline.baselinePerTesterRate * (1 + pct / 100)),
        additionalProductiveMinutes: 0,
        unavailableMinutesReduction: 0,
      },
    });
  }
  return options;
}

/** Blocking reduction scenarios (§13): 25/50/75/100% of the current unavailable time. */
export function buildBlockingScenarios(baseline: RecoveryBaseline): RecoveryOption[] {
  if (baseline.unavailableMinutes <= 0) return [];
  return RECOVERY_CONSTANTS.blockingStepPercent.map((pct) => ({
    kind: 'blocking' as const,
    value: Math.round((baseline.unavailableMinutes * pct) / 100),
    scenario: {
      testers: baseline.currentTesters,
      casesPerHourPerTester: baseline.baselinePerTesterRate,
      additionalProductiveMinutes: 0,
      unavailableMinutesReduction: Math.round((baseline.unavailableMinutes * pct) / 100),
    },
  }));
}

/** Additional productive time (overtime) scenarios: 15/30/45/60 minutes. */
export function buildAdditionalTimeScenarios(baseline: RecoveryBaseline): RecoveryOption[] {
  return RECOVERY_CONSTANTS.additionalTimeStepMinutes.map((minutes) => ({
    kind: 'additionalTime' as const,
    value: minutes,
    scenario: {
      testers: baseline.currentTesters,
      casesPerHourPerTester: baseline.baselinePerTesterRate,
      additionalProductiveMinutes: minutes,
      unavailableMinutesReduction: 0,
    },
  }));
}

/** The default scenario for one of the quick presets (§16). */
export function buildPresetScenario(id: RecoveryPresetId, baseline: RecoveryBaseline): RecoveryScenario {
  switch (id) {
    case 'plus1Tester':
      return { ...buildCurrentScenario(baseline), testers: baseline.currentTesters + 1 };
    case 'plus2Testers':
      return { ...buildCurrentScenario(baseline), testers: baseline.currentTesters + 2 };
    case 'plus10Rate':
      return {
        ...buildCurrentScenario(baseline),
        casesPerHourPerTester: roundRate(baseline.baselinePerTesterRate * 1.1),
      };
    case 'plus20Rate':
      return {
        ...buildCurrentScenario(baseline),
        casesPerHourPerTester: roundRate(baseline.baselinePerTesterRate * 1.2),
      };
    case 'minus30Blocking':
      return { ...buildCurrentScenario(baseline), unavailableMinutesReduction: Math.min(30, baseline.unavailableMinutes) };
    case 'balanced':
      return {
        testers: baseline.currentTesters + 1,
        casesPerHourPerTester: roundRate(baseline.baselinePerTesterRate * RECOVERY_CONSTANTS.balancedRateMultiplier),
        additionalProductiveMinutes: 0,
        unavailableMinutesReduction: Math.min(RECOVERY_CONSTANTS.balancedBlockingReductionMinutes, baseline.unavailableMinutes),
      };
  }
}

export const RECOVERY_PRESET_IDS = ['plus1Tester', 'plus2Testers', 'plus10Rate', 'plus20Rate', 'minus30Blocking', 'balanced'] as const;
export type RecoveryPresetId = (typeof RECOVERY_PRESET_IDS)[number];

/** One evaluated row for the options table. */
export interface EvaluatedRecoveryOption {
  option: RecoveryOption;
  result: ScenarioResult;
}

/** Result of the automatic "Find Recovery Options" search (§8, §19). */
export interface RecoveryOptionsResult {
  options: EvaluatedRecoveryOption[];
  /** Best evaluated scenario (largest variance = earliest finish); null when none. */
  best: EvaluatedRecoveryOption | null;
  anyRecovered: boolean;
}

/**
 * Bounded automatic search: single-change options (a few tester counts,
 * rate steps, blocking reductions, overtime steps) plus the balanced
 * combination — never the full Cartesian product. Sorted best-first.
 */
export function findRecoveryOptions(baseline: RecoveryBaseline): RecoveryOptionsResult {
  const options: RecoveryOption[] = [];
  for (const extra of RECOVERY_CONSTANTS.optionsTesterExtra) {
    options.push({
      kind: 'testers',
      value: baseline.currentTesters + extra,
      scenario: { ...buildCurrentScenario(baseline), testers: baseline.currentTesters + extra },
    });
  }
  for (const pct of RECOVERY_CONSTANTS.rateStepPercent) {
    options.push({
      kind: 'rate',
      value: 100 + pct,
      scenario: {
        testers: baseline.currentTesters,
        casesPerHourPerTester: roundRate(baseline.baselinePerTesterRate * (1 + pct / 100)),
        additionalProductiveMinutes: 0,
        unavailableMinutesReduction: 0,
      },
    });
  }
  options.push(...buildBlockingScenarios(baseline));
  options.push(...buildAdditionalTimeScenarios(baseline));
  options.push({ kind: 'balanced', value: 0, scenario: buildPresetScenario('balanced', baseline) });

  const evaluated = options
    .map((option) => ({ option, result: calculateScenarioResult(baseline, option.scenario) }))
    .sort((a, b) => {
      if (a.result.recovered !== b.result.recovered) return a.result.recovered ? -1 : 1;
      const av = a.result.varianceMinutes ?? Number.NEGATIVE_INFINITY;
      const bv = b.result.varianceMinutes ?? Number.NEGATIVE_INFINITY;
      return bv - av;
    });
  return {
    options: evaluated,
    best: evaluated.length > 0 ? evaluated[0] : null,
    anyRecovered: evaluated.some((row) => row.result.recovered),
  };
}
