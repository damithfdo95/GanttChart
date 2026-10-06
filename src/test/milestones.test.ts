import { describe, expect, it } from 'vitest';
import type { Milestone } from '../types';
import {
  evaluateMilestones,
  isoToAbsoluteMinutes,
  milestonePlannedMinutes,
  milestoneStatus,
  milestoneVarianceMinutes,
} from '../lib/calculations/milestones';

function milestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: 'm1',
    name: '',
    type: 'EXECUTE',
    targetPct: 50,
    plannedDate: null,
    plannedTime: null,
    actualAt: null,
    ...overrides,
  };
}

describe('evaluateMilestones', () => {
  it('stamps actualAt when the target percentage is reached', () => {
    const next = evaluateMilestones([milestone()], 55, 0, '2026-09-29T04:00:00.000Z');
    expect(next[0].actualAt).toBe('2026-09-29T04:00:00.000Z');
  });

  it('uses the pass percentage for PASS milestones', () => {
    const next = evaluateMilestones([milestone({ type: 'PASS' })], 100, 49, '2026-09-29T04:00:00.000Z');
    expect(next[0].actualAt).toBeNull();
    const reached = evaluateMilestones([milestone({ type: 'PASS' })], 100, 50, '2026-09-29T04:00:00.000Z');
    expect(reached[0].actualAt).toBe('2026-09-29T04:00:00.000Z');
  });

  it('is idempotent — an already reached milestone is never re-stamped', () => {
    const stamped = milestone({ actualAt: '2026-09-28T00:00:00.000Z' });
    const next = evaluateMilestones([stamped], 90, 90, '2026-09-29T04:00:00.000Z');
    expect(next[0].actualAt).toBe('2026-09-28T00:00:00.000Z');
  });

  it('returns the same array reference when nothing changed', () => {
    const list = [milestone(), milestone({ type: 'PASS' })];
    expect(evaluateMilestones(list, 10, 10, 'now')).toBe(list);
  });

  it('handles null progress (zero total cases) without stamping', () => {
    const next = evaluateMilestones([milestone()], null, null, 'now');
    expect(next[0].actualAt).toBeNull();
  });

  it('stamps exactly once when progress later drops back', () => {
    const first = evaluateMilestones([milestone()], 60, 0, '2026-09-29T01:00:00.000Z');
    const second = evaluateMilestones(first, 40, 0, '2026-09-29T02:00:00.000Z');
    expect(second[0].actualAt).toBe('2026-09-29T01:00:00.000Z');
  });
});

describe('planned and actual absolute minutes', () => {
  it('combines planned date and time (midnight when no time)', () => {
    expect(milestonePlannedMinutes(milestone({ plannedDate: '2026-09-29' }))).toBe(milestonePlannedMinutes(milestone({ plannedDate: '2026-09-29', plannedTime: '00:00' })));
  });

  it('parses a planned time', () => {
    const planned = milestonePlannedMinutes(milestone({ plannedDate: '2026-09-29', plannedTime: '17:30' }));
    expect(planned).not.toBeNull();
    expect(planned! % 1440).toBe(17 * 60 + 30);
  });

  it('is null when unset or malformed', () => {
    expect(milestonePlannedMinutes(milestone())).toBeNull();
    expect(milestonePlannedMinutes(milestone({ plannedDate: '2026-02-30' }))).toBeNull();
    expect(milestonePlannedMinutes(milestone({ plannedDate: '2026-09-29', plannedTime: '99:00' }))).toBeNull();
  });

  it('converts ISO timestamps to Tokyo absolute minutes', () => {
    // 2026-09-29T02:30Z is 11:30 in Asia/Tokyo on the same day.
    const minutes = isoToAbsoluteMinutes('2026-09-29T02:30:00.000Z');
    expect(minutes).not.toBeNull();
    expect(minutes! % 1440).toBe(11 * 60 + 30);
    expect(Math.floor(minutes! / 1440)).toBe(Math.floor(milestonePlannedMinutes(milestone({ plannedDate: '2026-09-29' }))! / 1440));
  });

  it('returns null for unparseable timestamps', () => {
    expect(isoToAbsoluteMinutes('not a date')).toBeNull();
  });
});

describe('milestoneVarianceMinutes', () => {
  it('is actual − planned (negative = reached early)', () => {
    // Planned 2026-09-29 17:30 Tokyo; actually reached 2026-09-29T07:00Z = 16:00 Tokyo.
    const m = milestone({ plannedDate: '2026-09-29', plannedTime: '17:30', actualAt: '2026-09-29T07:00:00.000Z' });
    expect(milestoneVarianceMinutes(m)).toBe(-90);
  });

  it('is null when not reached or no planned point', () => {
    expect(milestoneVarianceMinutes(milestone({ plannedDate: '2026-09-29' }))).toBeNull();
    expect(milestoneVarianceMinutes(milestone({ actualAt: '2026-09-29T07:00:00.000Z' }))).toBeNull();
  });
});

describe('milestoneStatus', () => {
  const planned = milestonePlannedMinutes(milestone({ plannedDate: '2026-09-29', plannedTime: '12:00' }))!;

  it('REACHED once actualAt is stamped', () => {
    expect(milestoneStatus(milestone({ actualAt: '2026-09-29T00:00:00.000Z' }), planned + 10000)).toBe('REACHED');
  });

  it('OVERDUE when the planned point passed without being reached', () => {
    expect(milestoneStatus(milestone({ plannedDate: '2026-09-29', plannedTime: '12:00' }), planned + 1)).toBe('OVERDUE');
  });

  it('PENDING before the planned point', () => {
    expect(milestoneStatus(milestone({ plannedDate: '2026-09-29', plannedTime: '12:00' }), planned - 1)).toBe('PENDING');
    expect(milestoneStatus(milestone(), 0)).toBe('PENDING');
  });
});
