import { describe, expect, it } from 'vitest';
import { summarizeProjectGroup, type ProjectScheduleMetrics } from '../domain/projects/selectors';

/** Metrics factory for the pure group aggregation. */
function metric(overrides: Partial<ProjectScheduleMetrics> = {}): ProjectScheduleMetrics {
  return {
    planningStatus: 'onTrack',
    overdue: false,
    deadline: '2026-10-20',
    plannedFinish: { epochDay: 20660, time: 15 * 60 },
    bufferMinutes: 240,
    ...overrides,
  };
}

/** Worst-case portfolio verdict (the Overall group status card). */
describe('summarizeProjectGroup', () => {
  it('an empty group has the neutral noProjects verdict and no facts', () => {
    expect(summarizeProjectGroup([])).toEqual({
      verdict: 'noProjects',
      projectCount: 0,
      latestPlannedFinish: null,
      earliestDeadline: null,
      worstBufferMinutes: null,
    });
  });

  it('any overdue project makes the whole group Overdue (worst-case severity)', () => {
    const summary = summarizeProjectGroup([
      metric(),
      metric({ overdue: true, planningStatus: 'onTrack' }),
    ]);
    expect(summary.verdict).toBe('overdue');
  });

  it('at-risk dominates capacity shortage and on-track', () => {
    const summary = summarizeProjectGroup([
      metric({ planningStatus: 'onTrack' }),
      metric({ planningStatus: 'capacityShortage' }),
      metric({ planningStatus: 'atRisk' }),
    ]);
    expect(summary.verdict).toBe('atRisk');
  });

  it('capacity shortage dominates on-track', () => {
    const summary = summarizeProjectGroup([
      metric({ planningStatus: 'onTrack' }),
      metric({ planningStatus: 'capacityShortage' }),
    ]);
    expect(summary.verdict).toBe('capacityShortage');
  });

  it('all completed → completed; a mix of completed and on-track → on-track', () => {
    expect(summarizeProjectGroup([metric({ planningStatus: 'completed' }), metric({ planningStatus: 'completed' })]).verdict).toBe('completed');
    expect(summarizeProjectGroup([metric({ planningStatus: 'completed' }), metric()]).verdict).toBe('onTrack');
  });

  it('on-hold and no-target projects never darken an otherwise on-track group', () => {
    const summary = summarizeProjectGroup([
      metric(),
      metric({ planningStatus: 'onHold', deadline: null, plannedFinish: null, bufferMinutes: null }),
      metric({ planningStatus: 'noTarget', deadline: null, bufferMinutes: null }),
    ]);
    expect(summary.verdict).toBe('onTrack');
  });

  it('project count reflects the group size', () => {
    expect(summarizeProjectGroup([metric(), metric(), metric()]).projectCount).toBe(3);
  });

  it('planned finish is the LATEST in the group (when all work is done)', () => {
    const summary = summarizeProjectGroup([
      metric({ plannedFinish: { epochDay: 20660, time: 10 * 60 } }),
      metric({ plannedFinish: { epochDay: 20661, time: 9 * 60 } }),
      metric({ plannedFinish: { epochDay: 20660, time: 16 * 60 } }),
      metric({ plannedFinish: null }),
    ]);
    expect(summary.latestPlannedFinish).toEqual({ epochDay: 20661, time: 9 * 60 });
  });

  it('deadline is the EARLIEST in the group (nearest pressure point)', () => {
    const summary = summarizeProjectGroup([
      metric({ deadline: '2026-10-25' }),
      metric({ deadline: '2026-10-18' }),
      metric({ deadline: null }),
      metric({ deadline: '2026-10-20' }),
    ]);
    expect(summary.earliestDeadline).toBe('2026-10-18');
  });

  it('buffer is the WORST (minimum) in the group', () => {
    const summary = summarizeProjectGroup([
      metric({ bufferMinutes: 600 }),
      metric({ bufferMinutes: -120 }),
      metric({ bufferMinutes: 90 }),
      metric({ bufferMinutes: null }),
    ]);
    expect(summary.worstBufferMinutes).toBe(-120);
  });

  it('null metrics fields are skipped, not treated as zero', () => {
    const summary = summarizeProjectGroup([
      metric({ deadline: '2026-10-20', bufferMinutes: null }),
      metric({ deadline: null, bufferMinutes: 30 }),
    ]);
    expect(summary.earliestDeadline).toBe('2026-10-20');
    expect(summary.worstBufferMinutes).toBe(30);
  });

  it('a group where nothing is computable keeps null aggregates', () => {
    const summary = summarizeProjectGroup([
      metric({ deadline: null, plannedFinish: null, bufferMinutes: null }),
    ]);
    expect(summary.verdict).toBe('onTrack');
    expect(summary.latestPlannedFinish).toBeNull();
    expect(summary.earliestDeadline).toBeNull();
    expect(summary.worstBufferMinutes).toBeNull();
  });
});
