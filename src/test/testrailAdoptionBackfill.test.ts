import { describe, expect, it } from 'vitest';
import type { ExternalIdentity, ProjectRecord, RcsMember, TesterDailyPerformance } from '../types';
import { backfillTestRailMemberAdoption } from '../domain/testrail/adoptionBackfill';

/**
 * The boot-time backfill: tester records written under a TestRail display
 * name BEFORE the user was linked to a Team Member are adopted into the
 * member's stable identity — idempotently, without ever guessing an
 * ambiguous name.
 */

function member(overrides: Partial<RcsMember> = {}): RcsMember {
  return { id: 'USER0001', name: 'Hana Sato', team: 'PrV', role: 'Tester', startDate: '2026-01-01', active: true, ...overrides };
}

function identity(overrides: Partial<ExternalIdentity> = {}): ExternalIdentity {
  return { id: 'EI1', provider: 'testrail', externalId: '5', memberId: 'USER0001', displayName: 'Hana (TestRail)', active: true, linkedAt: '2026-10-01T00:00:00Z', ...overrides };
}

function record(overrides: Partial<TesterDailyPerformance> = {}): TesterDailyPerformance {
  return { id: 'r1', date: '2026-10-20', testerName: 'Hana (TestRail)', projectId: 'PRJ-001', casesTested: 12, ...overrides };
}

function project(records: readonly TesterDailyPerformance[]): ProjectRecord {
  return {
    id: 'p1',
    projectId: 'PRJ-001',
    nameEn: 'Project',
    nameJa: '',
    team: 'RCS',
    status: 'ongoing',
    updatedAt: 'a',
    inputs: { totalCases: 100, dailyExecuted: [], bugTickets: [], testerDailyPerformance: [...records] },
  } as unknown as ProjectRecord;
}

describe('backfillTestRailMemberAdoption', () => {
  it('adopts records written under the link display name and the member name', () => {
    const projects = [project([record({ testerName: 'Hana (TestRail)' }), record({ testerName: 'Hana Sato' }), record({ testerName: 'Ken Ito' })])];
    const healed = backfillTestRailMemberAdoption(projects, [member()], [identity()]);
    const records = healed[0].inputs.testerDailyPerformance ?? [];
    expect(records[0].memberId).toBe('USER0001');
    expect(records[1].memberId).toBe('USER0001');
    expect(records[2].memberId).toBeUndefined(); // other testers untouched
  });

  it('is idempotent — the second run changes nothing', () => {
    const projects = [project([record({ testerName: 'Hana (TestRail)' })])];
    const once = backfillTestRailMemberAdoption(projects, [member()], [identity()]);
    const twice = backfillTestRailMemberAdoption(once, [member()], [identity()]);
    expect(twice).toBe(once); // same reference: nothing left to heal
  });

  it('never touches records already linked to another member', () => {
    const projects = [project([record({ testerName: 'Hana (TestRail)', memberId: 'USER0009' })])];
    const healed = backfillTestRailMemberAdoption(projects, [member()], [identity()]);
    expect((healed[0].inputs.testerDailyPerformance ?? [])[0].memberId).toBe('USER0009');
  });

  it('never guesses a name claimed by two members', () => {
    const members = [member(), member({ id: 'USER0002', name: 'Ken Ito' })];
    // Both members' links carry the SAME display name → ambiguous.
    const identities = [identity(), identity({ id: 'EI2', externalId: '6', memberId: 'USER0002', displayName: 'Hana (TestRail)' })];
    const projects = [project([record({ testerName: 'Hana (TestRail)' })])];
    const healed = backfillTestRailMemberAdoption(projects, members, identities);
    expect((healed[0].inputs.testerDailyPerformance ?? [])[0].memberId).toBeUndefined();
  });

  it('ignores retired links and other providers', () => {
    const identities = [identity({ active: false }), identity({ provider: 'jira' })];
    const projects = [project([record({ testerName: 'Hana (TestRail)' })])];
    const healed = backfillTestRailMemberAdoption(projects, [member()], identities);
    // No active testrail link: the member's own registered name still adopts
    // records recorded under it, but the TestRail display name does not.
    expect((healed[0].inputs.testerDailyPerformance ?? [])[0].memberId).toBeUndefined();
  });

  it('adopts by the member registered name when no testrail links exist', () => {
    const projects = [project([record({ testerName: 'Hana Sato' })])];
    const healed = backfillTestRailMemberAdoption(projects, [member()], []);
    expect((healed[0].inputs.testerDailyPerformance ?? [])[0].memberId).toBe('USER0001');
  });

  it('returns the same reference when there is nothing to heal', () => {
    const projects = [project([record({ testerName: 'Ken Ito' })])];
    expect(backfillTestRailMemberAdoption(projects, [member()], [identity()])).toBe(projects);
  });
});
