import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RcsMember, RcsMemberNameHistory, ReportsState } from '../types';
import { DEMO_STATE } from '../lib/storage/storage';
import {
  defaultReportsState,
  isRcsMember,
  isRcsMemberNameHistory,
  loadReportsState,
  saveReportsState,
} from '../lib/storage/reports';
import { createBackupPayload, parseBackupPayload } from '../lib/backup/backup';
import {
  nameHistoryEntryLabel,
  normalizeMemberNameHistory,
  resolveMemberIdentity,
  upsertRcsMember,
} from '../domain/members';
import { migrateAssignmentsToMembers } from '../domain/assignments';
import { validateMemberNameHistory, validateRcsMember } from '../lib/validation/validateMember';

/**
 * V6.9-A §37 — member name history: model, validation, current-name
 * handling, historical resolution, cross-member collision, persistence,
 * backup/restore and JSON round trips. Historical names never replace the
 * current name and old records are never rewritten.
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

function member(overrides: Partial<RcsMember> = {}): RcsMember {
  return {
    id: 'USER0003',
    name: 'Yamauchi K.',
    team: 'RCS',
    role: 'Tester',
    startDate: '2026-07-01',
    active: true,
    ...overrides,
  };
}

describe('V6.9-A name history validation', () => {
  it('accepts a valid historical entry with dates', () => {
    expect(validateMemberNameHistory([{ name: 'Yamauchi Kentaro', fromDate: '2026-07-01', toDate: '2026-09-30' }], 'Yamauchi K.')).toEqual({});
  });

  it('rejects empty names and trims before comparing', () => {
    expect(validateMemberNameHistory([{ name: '   ' }], 'Yamauchi K.')).toEqual({ 0: 'errors.nameHistoryNameRequired' });
    // A trimmed duplicate counts as a duplicate.
    expect(validateMemberNameHistory([{ name: 'Yamauchi Kentaro' }, { name: ' Yamauchi Kentaro ' }], 'Yamauchi K.')).toEqual({
      1: 'errors.nameHistoryDuplicate',
    });
  });

  it('rejects a duplicate historical name within the same member', () => {
    expect(validateMemberNameHistory([{ name: 'A' }, { name: 'A' }], 'Current')).toEqual({ 1: 'errors.nameHistoryDuplicate' });
  });

  it('rejects an entry equal to the current name (unnecessary duplication)', () => {
    expect(validateMemberNameHistory([{ name: 'Yamauchi K.' }], 'Yamauchi K.')).toEqual({
      0: 'errors.nameHistoryCurrentDuplicate',
    });
    expect(validateMemberNameHistory([{ name: ' Yamauchi K. ' }], ' Yamauchi K. ')).toEqual({
      0: 'errors.nameHistoryCurrentDuplicate',
    });
  });

  it('rejects invalid dates and toDate before fromDate', () => {
    expect(validateMemberNameHistory([{ name: 'Old', fromDate: '2026-02-30' }], 'Current')).toEqual({
      0: 'errors.nameHistoryDateInvalid',
    });
    expect(validateMemberNameHistory([{ name: 'Old', toDate: '2026-13-01' }], 'Current')).toEqual({
      0: 'errors.nameHistoryDateInvalid',
    });
    expect(validateMemberNameHistory([{ name: 'Old', fromDate: '2026-09-30', toDate: '2026-07-01' }], 'Current')).toEqual({
      0: 'errors.nameHistoryDateOrder',
    });
    expect(validateMemberNameHistory([{ name: 'Old', fromDate: '2026-07-01', toDate: '2026-09-30' }], 'Current')).toEqual({});
  });

  it('validates the name history as part of member validation', () => {
    const valid = member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] });
    expect(validateRcsMember(valid, []).isValid).toBe(true);
    const invalid = member({ nameHistory: [{ name: '' }, { name: 'Yamauchi K.' }] });
    const outcome = validateRcsMember(invalid, []);
    expect(outcome.isValid).toBe(false);
    expect(outcome.errors.nameHistoryEntries).toEqual({
      0: 'errors.nameHistoryNameRequired',
      1: 'errors.nameHistoryCurrentDuplicate',
    });
  });

  it('normalizes history entries: trims names, drops empties and empty dates', () => {
    const normalized = normalizeMemberNameHistory([
      { name: ' Yamauchi Kentaro ', fromDate: '', toDate: '2026-09-30' },
      { name: '' },
      { name: '  Former Name  ' },
    ]);
    expect(normalized).toEqual([
      { name: 'Yamauchi Kentaro', toDate: '2026-09-30' },
      { name: 'Former Name' },
    ]);
  });

  it('labels one history entry readably', () => {
    expect(nameHistoryEntryLabel({ name: 'Yamauchi Kentaro', fromDate: '2026-07-01', toDate: '2026-09-30' })).toBe(
      'Yamauchi Kentaro (2026-07-01–2026-09-30)',
    );
    expect(nameHistoryEntryLabel({ name: 'Yamauchi Kentaro' })).toBe('Yamauchi Kentaro');
  });
});

describe('V6.9-A name history resolution & integrity', () => {
  it('a renamed member keeps the current name; history resolves old records', () => {
    const members = [member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] })];
    expect(members[0].name).toBe('Yamauchi K.'); // current name unchanged
    expect(resolveMemberIdentity('Yamauchi Kentaro', members)).toMatchObject({
      status: 'resolved',
      memberId: 'USER0003',
      matchedBy: 'nameHistory',
    });
  });

  it('historical names belonging to multiple members are never auto-resolved', () => {
    const members = [
      member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] }),
      member({ id: 'USER0012', name: 'Yamauchi Kentaro' }),
    ];
    expect(resolveMemberIdentity('Yamauchi Kentaro', members).status).toBe('ambiguous');
  });

  it('assignment migration resolves legacy names through name history', () => {
    const members = [member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] })];
    const result = migrateAssignmentsToMembers(
      [{ id: 'asg-1', projectId: 'PRJ-001', testerName: 'Yamauchi Kentaro', startDate: '2026-07-01', active: true }],
      members,
    );
    expect(result.resolved).toHaveLength(1);
    expect(result.assignments[0].memberId).toBe('USER0003');
    expect(result.assignments[0].testerName).toBe('Yamauchi Kentaro'); // never rewritten
  });
});

describe('V6.9-A name history persistence', () => {
  it('validates the shape guard for history entries and members', () => {
    expect(isRcsMemberNameHistory({ name: 'Yamauchi Kentaro' })).toBe(true);
    expect(isRcsMemberNameHistory({ name: 'A', fromDate: '2026-07-01', toDate: '2026-09-30' })).toBe(true);
    expect(isRcsMemberNameHistory({ name: 3 as unknown as string })).toBe(false);
    expect(isRcsMemberNameHistory({ fromDate: '2026-07-01' })).toBe(false);
    expect(isRcsMember(member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] }))).toBe(true);
    expect(isRcsMember(member({ nameHistory: [{ nope: true } as unknown as RcsMemberNameHistory] }))).toBe(false);
    // Legacy members without history remain valid.
    expect(isRcsMember(member())).toBe(true);
  });

  it('saves and loads members with name history through the workspace persistence', () => {
    const state: ReportsState = {
      ...defaultReportsState(),
      rcsMembers: [member({ nameHistory: [{ name: 'Yamauchi Kentaro', fromDate: '2026-07-01', toDate: '2026-09-30' }] })],
    };
    expect(saveReportsState(state)).toBe(true);
    const loaded = loadReportsState().rcsMembers!;
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('Yamauchi K.');
    expect(loaded[0].nameHistory).toEqual([{ name: 'Yamauchi Kentaro', fromDate: '2026-07-01', toDate: '2026-09-30' }]);
  });

  it('round-trips name history through backup/restore without duplication', () => {
    const state: ReportsState = {
      ...defaultReportsState(),
      rcsMembers: [member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] })],
    };
    const payload = createBackupPayload(DEMO_STATE, state);
    const parsed = parseBackupPayload(JSON.stringify(payload));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const restored = parsed.data.reportsState.rcsMembers!;
    expect(restored[0].nameHistory).toEqual([{ name: 'Yamauchi Kentaro' }]);
    // The JSON round trip is a pure serialize/parse of the same shape.
    const again = JSON.parse(JSON.stringify(restored[0]));
    expect(again.nameHistory).toEqual([{ name: 'Yamauchi Kentaro' }]);
    expect(again.name).toBe('Yamauchi K.'); // current name never replaced by history
  });

  it('keeps history through edits via upsertRcsMember (id stable, history explicit)', () => {
    let members = [member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] })];
    members = upsertRcsMember(members, { ...members[0], team: 'PrV' });
    expect(members[0].id).toBe('USER0003');
    expect(members[0].nameHistory).toEqual([{ name: 'Yamauchi Kentaro' }]);
    expect(members[0].team).toBe('PrV');
  });
});
