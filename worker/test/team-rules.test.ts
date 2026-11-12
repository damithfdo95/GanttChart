import { beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceStore, type CommitInput } from '../src/store';
import { createTestStorage } from './helpers/sqlJsStorage';
import { teamCommitError, type TeamMembershipRecord, type TeamRecord } from '../../shared/teamRules';
import { applyRecordChanges } from '../../src/lib/sync/records';
import { defaultReportsState } from '../../src/lib/storage/reports';
import type { RecordPut } from '../../shared/protocol';

type TestStorage = Awaited<ReturnType<typeof createTestStorage>>;

let storage: TestStorage;
let store: WorkspaceStore;
let seq = 0;

beforeEach(async () => {
  storage = await createTestStorage();
  store = new WorkspaceStore(storage);
  store.init();
  seq = 0;
});

const NOW = '2026-11-05T00:00:00.000Z';

const team = (over: Partial<TeamRecord> = {}): TeamRecord => ({ id: 'TEAM-ECO', name: 'Ecosystem', code: 'ECO', status: 'ACTIVE', createdAt: NOW, updatedAt: NOW, ...over });
const membership = (over: Partial<TeamMembershipRecord> = {}): TeamMembershipRecord => ({
  id: 'TMB-0001',
  memberId: 'USER0001',
  teamId: 'TEAM-ECO',
  membershipKind: 'PRIMARY',
  durationType: 'PERMANENT',
  effectiveFrom: '2026-01-01',
  status: 'ACTIVE',
  createdBy: 'sv@example.com',
  createdAt: NOW,
  ...over,
});

/** A commit through the same rules hook the WorkspaceRoom wires in production. */
function commit(overrides: Partial<CommitInput> & Pick<CommitInput, 'puts' | 'deletes'>) {
  seq += 1;
  return store.commit({
    commitId: `c${seq}`,
    baseRevision: store.revision(),
    actor: 'sv@example.com',
    reason: 'edit',
    now: NOW,
    rules: ({ puts, deletes, get, list }) => teamCommitError({ puts, deletes, view: { get, list } }),
    ...overrides,
  });
}

describe('Team Management records in the store (rules hook wired as in production)', () => {
  it('accepts well-formed team and membership records', () => {
    const member: RecordPut = { kind: 'member', id: 'USER0001', json: JSON.stringify({ id: 'USER0001', name: 'A', team: 'Ecosystem', role: 'tester', startDate: '2026-01-01', active: true }) };
    const r = commit({ puts: [member, { kind: 'team', id: 'TEAM-ECO', json: JSON.stringify(team()) }, { kind: 'teamMembership', id: 'TMB-0001', json: JSON.stringify(membership()) }], deletes: [] });
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(store.snapshot().records.map((x) => `${x.kind}:${x.id}`).sort()).toEqual(['member:USER0001', 'team:TEAM-ECO', 'teamMembership:TMB-0001']);
  });

  it('rejects a malformed team record (the rules hook refuses the commit)', () => {
    const r = commit({ puts: [{ kind: 'team', id: 'TEAM-BAD', json: JSON.stringify(team({ id: 'TEAM-BAD', name: '' })) }], deletes: [] });
    expect(r).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('rejects overlapping PRIMARY memberships through the rules hook', () => {
    const member: RecordPut = { kind: 'member', id: 'USER0001', json: JSON.stringify({ id: 'USER0001', name: 'A', team: 'Ecosystem', role: 'tester', startDate: '2026-01-01', active: true }) };
    commit({ puts: [member, { kind: 'team', id: 'TEAM-ECO', json: JSON.stringify(team()) }, { kind: 'teamMembership', id: 'TMB-0001', json: JSON.stringify(membership()) }], deletes: [] });
    const second = commit({
      puts: [
        { kind: 'team', id: 'TEAM-HTMA', json: JSON.stringify(team({ id: 'TEAM-HTMA', name: 'HTMA', code: 'HTMA' })) },
        { kind: 'teamMembership', id: 'TMB-0002', json: JSON.stringify(membership({ id: 'TMB-0002', teamId: 'TEAM-HTMA', effectiveFrom: '2026-06-01' })) },
      ],
      deletes: [],
    });
    expect(second).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('forward compatibility: an older client and the new kinds', () => {
  it('teamCommitError ignores commits that touch none of the new kinds', () => {
    const view = { get: () => null, list: () => [] as Array<{ id: string; json: string }> };
    expect(teamCommitError({ puts: [{ kind: 'project', id: 'p1', json: '{}' }], deletes: [], view })).toBeNull();
  });

  it('applyRecordChanges skips a kind this build does not map (no crash, no data loss)', () => {
    // Simulate an OLD client: a record kind its FIELD_BY_KIND has no entry
    // for (any future kind; here a made-up one, cast into the protocol type).
    // Applying it must not throw and must return the SAME state reference.
    const state = defaultReportsState();
    const futurePut: RecordPut = { kind: 'futureKind' as RecordPut['kind'], id: 'FUT-1', json: JSON.stringify({ id: 'FUT-1', whatever: true }) };
    const next = applyRecordChanges(state, [futurePut], []);
    expect(next).toBe(state);
  });
});
