import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RcsMember, TesterProjectAssignment } from '../types';
import { migrateAssignmentsToMembers } from '../domain/assignments';
import { getAssignedTestersForDate } from '../lib/calculations/testerAttribution';
import { seedRcsMembers } from '../domain/members';
import { isTesterProjectAssignment } from '../lib/storage/reports';
import { defaultReportsState, loadReportsState, saveReportsState } from '../lib/storage/reports';
import type { ReportsState } from '../types';

/** Assignment factory: active by default (V6.8 identity-based). */
function asg(input: Omit<TesterProjectAssignment, 'id' | 'active'>): TesterProjectAssignment {
  return { id: 'asg-' + Math.random().toString(36).slice(2, 8), active: true, ...input };
}

/**
 * V6.8 §11  ELegacy assignment migration: testerName records gain a stable
 * memberId only when the name matches exactly one member. Unmatched records
 * are preserved; ambiguous records are flagged, never guessed.
 */

class MemoryStorage {
  map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('window', { localStorage: storage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function legacyAssignment(overrides: Partial<TesterProjectAssignment> = {}): TesterProjectAssignment {
  return {
    id: 'asg-' + Math.random().toString(36).slice(2, 8),
    projectId: 'PRJ-001',
    testerName: 'Yamauchi Kentaro',
    startDate: '2026-09-01',
    active: true,
    ...overrides,
  };
}

describe('V6.8 assignment migration', () => {
  const members = seedRcsMembers();

  it('resolves a unique name match to the stable member id, preserving all fields', () => {
    const original = legacyAssignment({ testerName: 'Yamauchi Kentaro', team: 'RCS', endDate: '2026-09-30' });
    const result = migrateAssignmentsToMembers([original], members);
    expect(result.resolved).toHaveLength(1);
    expect(result.unmatched).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(0);
    expect(result.assignments).toHaveLength(1);
    const migrated = result.assignments[0];
    expect(migrated.memberId).toBe('USER0003');
    // Everything else is preserved verbatim  Enothing is rewritten or removed.
    expect(migrated.id).toBe(original.id);
    expect(migrated.testerName).toBe('Yamauchi Kentaro'); // legacy data preserved
    expect(migrated.team).toBe('RCS');
    expect(migrated.startDate).toBe('2026-09-01');
    expect(migrated.endDate).toBe('2026-09-30');
    expect(migrated.active).toBe(true);
    expect(migrated.projectId).toBe('PRJ-001');
  });

  it('preserves unmatched records without inventing a member', () => {
    const original = legacyAssignment({ testerName: 'Mystery Tester' });
    const result = migrateAssignmentsToMembers([original], members);
    expect(result.resolved).toHaveLength(0);
    expect(result.unmatched).toHaveLength(1);
    expect(result.assignments[0]).toEqual(original); // byte-identical record
    expect(result.assignments[0].memberId).toBeUndefined();
  });

  it('flags ambiguous names for manual resolution instead of guessing', () => {
    const withDuplicateNames = [
      ...members,
      { id: 'USER0100', name: 'Yamauchi Kentaro', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true },
    ];
    const original = legacyAssignment({ testerName: 'Yamauchi Kentaro' });
    const result = migrateAssignmentsToMembers([original], withDuplicateNames);
    expect(result.resolved).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.assignments[0]).toEqual(original);
    expect(result.assignments[0].memberId).toBeUndefined();
  });

  it('is idempotent: already-migrated assignments are untouched on re-runs', () => {
    const first = migrateAssignmentsToMembers(
      [legacyAssignment({ testerName: 'Yamauchi Kentaro' }), legacyAssignment({ testerName: 'Ghost' })],
      members,
    );
    const second = migrateAssignmentsToMembers(first.assignments, members);
    expect(second.resolved).toHaveLength(0);
    expect(second.assignments).toEqual(first.assignments);
  });

  it('runs on load through the workspace normalization', () => {
    const state: ReportsState = {
      ...defaultReportsState(),
      rcsMembers: seedRcsMembers(),
      testerAssignments: [
        legacyAssignment({ testerName: 'Yamauchi Kentaro' }),
        legacyAssignment({ testerName: 'Unmatched Person' }),
      ],
    };
    saveReportsState(state);
    const loaded = loadReportsState();
    expect(loaded.testerAssignments!.find((a) => a.testerName === 'Yamauchi Kentaro')!.memberId).toBe('USER0003');
    expect(loaded.testerAssignments!.find((a) => a.testerName === 'Unmatched Person')!.memberId).toBeUndefined();
  });

  it('validates both identity shapes in the shape guard', () => {
    expect(isTesterProjectAssignment(legacyAssignment())).toBe(true); // legacy name-based
    expect(isTesterProjectAssignment({ ...legacyAssignment(), testerName: undefined, memberId: 'USER0003' })).toBe(true); // V6.8 id-based
    expect(isTesterProjectAssignment({ ...legacyAssignment(), testerName: undefined, memberId: undefined })).toBe(false); // neither
  });
});

describe('V6.8 member-based assignments', () => {
  const members = seedRcsMembers();

  it('matches assignments by member identity and period', () => {
    const assignments = [
      asg({ projectId: 'PRJ-001', memberId: 'USER0003', testerName: 'Yamauchi Kentaro', startDate: '2026-09-01' }),
      asg({ projectId: 'PRJ-001', memberId: 'USER0004', startDate: '2026-09-10', endDate: '2026-09-15' }),
      asg({ projectId: 'PRJ-002', memberId: 'USER0003', startDate: '2026-09-01' }),
      { ...asg({ projectId: 'PRJ-001', memberId: 'USER0005', startDate: '2026-09-01' }), active: false },
    ];
    // 2026-09-12: USER0003 (PRJ-001) + USER0004 (in period); PRJ-002 and inactive excluded.
    const matched = getAssignedTestersForDate(assignments, 'PRJ-001', '2026-09-12', members);
    expect(matched.map((a) => a.memberId).sort()).toEqual(['USER0003', 'USER0004']);
    expect(getAssignedTestersForDate(assignments, 'PRJ-001', '2026-09-16', members).map((a) => a.memberId)).toEqual(['USER0003']);
  });

  it('keeps legacy name-based assignments working alongside member identity', () => {
    const assignments = [
      asg({ projectId: 'PRJ-001', testerName: 'Legacy Tester', startDate: '2026-09-01' }),
    ];
    const matched = getAssignedTestersForDate(assignments, 'PRJ-001', '2026-09-05', members);
    expect(matched).toHaveLength(1);
    expect(matched[0].testerName).toBe('Legacy Tester');
    expect(matched[0].memberId).toBeUndefined();
  });

  it('sorts deterministically by identity key (idempotent allocation order)', () => {
    const assignments = [
      asg({ projectId: 'PRJ-001', memberId: 'USER0005', startDate: '2026-09-01' }),
      asg({ projectId: 'PRJ-001', memberId: 'USER0003', startDate: '2026-09-01' }),
      asg({ projectId: 'PRJ-001', testerName: 'Alpha Legacy', startDate: '2026-09-01' }),
    ];
    const matched = getAssignedTestersForDate(assignments, 'PRJ-001', '2026-09-02', members);
    expect(matched.map((a) => a.memberId ?? a.testerName)).toEqual(['Alpha Legacy', 'USER0003', 'USER0005']);
  });

  it('inactive members keep matching their historical assignments (visibility, §9)', () => {
    // A deactivated member's PAST assignment still resolves  Einactive only
    // removes the member from NEW assignment selectors (activeMembers).
    const assignments = [
      asg({ projectId: 'PRJ-001', memberId: 'USER0003', startDate: '2026-07-01', endDate: '2026-07-31' }),
    ];
    expect(getAssignedTestersForDate(assignments, 'PRJ-001', '2026-07-15', members)).toHaveLength(1);
  });
});

describe('V6.8 member master type stability (compile-level)', () => {
  it('creates identity-based assignments through the domain helper', () => {
    const assignment = asg({
      projectId: 'PRJ-001',
      memberId: 'USER0007',
      testerName: 'Niizeki Keitaro',
      startDate: '2026-09-01',
    });
    expect(assignment.memberId).toBe('USER0007');
    expect(assignment.id).not.toBe('');
    expect(assignment.active).toBe(true);
  });

  it('exposes the RCS member type through the workspace state', () => {
    const state: ReportsState = { ...defaultReportsState() };
    const members: readonly RcsMember[] = state.rcsMembers ?? [];
    expect(members.length).toBe(0); // no default people: an empty roster is valid
  });
});
