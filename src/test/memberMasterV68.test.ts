import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RcsMember, ReportsState } from '../types';
import { SEED_RCS_MEMBERS } from '../types';
import {
  activeMembers,
  findMemberById,
  findMembersByName,
  findUniqueMemberByName,
  identityDisplayName,
  nextMemberId,
  removeRcsMember,
  seedRcsMembers,
  upsertRcsMember,
} from '../domain/members';
import { validateRcsMember } from '../lib/validation/validateMember';
import { isRcsMember, defaultReportsState, loadReportsState, saveReportsState } from '../lib/storage/reports';
import { createBackupPayload, parseBackupPayload } from '../lib/backup/backup';
import { DEMO_STATE } from '../lib/storage/storage';

/**
 * V6.8 — RCS Member Master: stable identity model, validation, seeding,
 * active/inactive behavior, persistence, backup/restore and JSON round
 * trips. The member id is the identity; the name is display data.
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
    name: 'Yamauchi Kentaro',
    team: 'RCS',
    role: 'Tester',
    startDate: '2026-07-01',
    active: true,
    ...overrides,
  };
}

describe('V6.8 seed members', () => {
  it('seeds the 8 provided RCS members with stable ids', () => {
    const seeded = seedRcsMembers();
    expect(seeded.map((m) => m.id)).toEqual([
      'USER0001', 'USER0002', 'USER0003', 'USER0004',
      'USER0005', 'USER0006', 'USER0007', 'USER0008',
    ]);
    expect(seeded.find((m) => m.id === 'USER0003')).toEqual(member());
    expect(seeded.find((m) => m.id === 'USER0001')!.role).toBe('SV');
    expect(seeded.find((m) => m.id === 'USER0002')!.name).toBe('Damith Fernando');
    expect(SEED_RCS_MEMBERS).toHaveLength(8);
  });

  it('seeds exactly once: an absent field is seeded, an emptied roster stays empty', () => {
    const state = { ...defaultReportsState(), rcsMembers: undefined } as ReportsState;
    saveReportsState(state);
    expect(loadReportsState().rcsMembers).toHaveLength(8);
    // The user deliberately deleted every member — never re-seeded.
    const emptied = { ...defaultReportsState(), rcsMembers: [] } as ReportsState;
    saveReportsState(emptied);
    expect(loadReportsState().rcsMembers).toEqual([]);
  });
});

describe('V6.8 member CRUD and identity', () => {
  it('upserts by stable id and keeps the id when a member is edited', () => {
    let members = [member(), member({ id: 'USER0004', name: 'Kobayashi Masashi' })];
    members = upsertRcsMember(members, { ...members[0], name: 'Yamauchi K.' }); // rename
    expect(members).toHaveLength(2);
    expect(members[0].id).toBe('USER0003');
    expect(members[0].name).toBe('Yamauchi K.');
    // Adding a new member appends; removing never renumbers ids.
    members = upsertRcsMember(members, member({ id: 'USER0009', name: 'Sato Hanako' }));
    expect(members).toHaveLength(3);
    members = removeRcsMember(members, 'USER0003');
    expect(members.map((m) => m.id)).toEqual(['USER0004', 'USER0009']);
  });

  it('generates the next free USER000N id without collisions', () => {
    expect(nextMemberId(seedRcsMembers())).toBe('USER0009');
    expect(nextMemberId([])).toBe('USER0001');
    const withGap = [...seedRcsMembers(), member({ id: 'USER0010', name: 'X' })];
    expect(nextMemberId(withGap)).toBe('USER0011');
    const withNine = [...seedRcsMembers(), member({ id: 'USER0009', name: 'X' })];
    expect(nextMemberId(withNine)).toBe('USER0010');
  });

  it('deactivates and reactivates without touching identity or history', () => {
    let members = seedRcsMembers();
    const yamauchi = findMemberById(members, 'USER0003')!;
    members = upsertRcsMember(members, { ...yamauchi, active: false });
    expect(findMemberById(members, 'USER0003')!.active).toBe(false);
    expect(activeMembers(members).some((m) => m.id === 'USER0003')).toBe(false);
    expect(activeMembers(members)).toHaveLength(7); // excluded from new-assignment lists
    expect(members.some((m) => m.id === 'USER0003')).toBe(true); // still in the master
    members = upsertRcsMember(members, { ...findMemberById(members, 'USER0003')!, active: true });
    expect(activeMembers(members)).toHaveLength(8);
  });

  it('finds members by name: unique, ambiguous and empty', () => {
    const members = [
      member(), // USER0003 Yamauchi Kentaro
      member({ id: 'USER0009', name: 'Yamauchi Kentaro' }), // same name, different member
    ];
    expect(findMembersByName(members, 'Yamauchi Kentaro')).toHaveLength(2);
    expect(findUniqueMemberByName(members, 'Yamauchi Kentaro')).toBeUndefined(); // never a guess
    expect(findUniqueMemberByName(members, ' Nobody ')).toBeUndefined();
    const unique = [member()];
    expect(findUniqueMemberByName(unique, ' yamauchi kentaro ')).toBeUndefined(); // exact match only
    expect(findUniqueMemberByName(unique, 'Yamauchi Kentaro')!.id).toBe('USER0003');
  });

  it('resolves display names for identity keys', () => {
    const members = seedRcsMembers();
    expect(identityDisplayName('USER0003', members)).toBe('Yamauchi Kentaro');
    expect(identityDisplayName('Legacy Name', members)).toBe('Legacy Name');
  });
});

describe('V6.8 member validation', () => {
  it('accepts a well-formed member and rejects missing required fields', () => {
    expect(validateRcsMember(member(), []).isValid).toBe(true);
    expect(validateRcsMember(member({ id: '  ' }), []).errors.id).toBe('errors.memberIdRequired');
    expect(validateRcsMember(member({ name: '' }), []).errors.name).toBe('errors.memberNameRequired');
    expect(validateRcsMember(member({ team: '' }), []).errors.team).toBe('errors.memberTeamRequired');
    expect(validateRcsMember(member({ role: '' }), []).errors.role).toBe('errors.memberRoleRequired');
    expect(validateRcsMember(member({ startDate: '2026-02-30' }), []).errors.startDate).toBe('errors.memberDateInvalid');
  });

  it('rejects duplicate member ids (trimmed) and invalid date ranges', () => {
    const existing = seedRcsMembers();
    expect(validateRcsMember(member(), existing).errors.id).toBe('errors.memberIdDuplicate');
    expect(validateRcsMember(member({ id: ' USER0003 ' }), existing).errors.id).toBe('errors.memberIdDuplicate');
    // Editing the member itself never counts as a duplicate.
    expect(validateRcsMember(member(), existing, 'USER0003').isValid).toBe(true);
    expect(validateRcsMember(member({ endDate: '2026-06-30' }), []).errors.endDate).toBe('errors.memberEndBeforeStart');
    expect(validateRcsMember(member({ endDate: '2026-12-31' }), []).isValid).toBe(true);
  });
});

describe('V6.8 member persistence', () => {
  it('validates the member shape guard', () => {
    expect(isRcsMember(member())).toBe(true);
    expect(isRcsMember(member({ endDate: '2026-12-31' }))).toBe(true);
    expect(isRcsMember({ ...member(), id: 3 as unknown as string })).toBe(false);
    expect(isRcsMember({ ...member(), active: 'yes' as unknown as boolean })).toBe(false);
    expect(isRcsMember({ ...member(), team: undefined as unknown as string })).toBe(false);
  });

  it('saves and loads members with unchanged ids through the workspace persistence', () => {
    const state: ReportsState = {
      ...defaultReportsState(),
      rcsMembers: [member(), member({ id: 'USER0010', name: 'Sato Hanako', active: false, endDate: '2026-09-30' })],
    };
    expect(saveReportsState(state)).toBe(true);
    const loaded = loadReportsState();
    expect(loaded.rcsMembers).toHaveLength(2);
    expect(loaded.rcsMembers!.find((m) => m.id === 'USER0010')!.name).toBe('Sato Hanako');
    expect(loaded.rcsMembers!.find((m) => m.id === 'USER0010')!.active).toBe(false);
  });

  it('round-trips members through backup/restore with stable ids', () => {
    const state: ReportsState = {
      ...defaultReportsState(),
      rcsMembers: [member({ name: 'Yamauchi K. (renamed)' })],
    };
    const payload = createBackupPayload(DEMO_STATE, state);
    const parsed = parseBackupPayload(JSON.stringify(payload));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const restored = parsed.data.reportsState.rcsMembers!;
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe('USER0003'); // ids unchanged by restore
    expect(restored[0].name).toBe('Yamauchi K. (renamed)');
  });

  it('seeds members for a legacy V6.7 backup (rcsMembers absent)', () => {
    const legacy: ReportsState = { ...defaultReportsState(), rcsMembers: undefined };
    const parsed = parseBackupPayload(JSON.stringify(createBackupPayload(DEMO_STATE, legacy)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Export-path normalization fills the seed set exactly once for legacy data.
    expect(parsed.data.reportsState.rcsMembers).toHaveLength(8);
    expect(parsed.data.reportsState.rcsMembers!.find((m) => m.id === 'USER0003')!.name).toBe('Yamauchi Kentaro');
    saveReportsState(parsed.data.reportsState);
    expect(loadReportsState().rcsMembers).toHaveLength(8); // still 8 — never duplicated on load
  });
});
