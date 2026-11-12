import { describe, expect, it } from 'vitest';
import { planTeamBackfill } from '../../shared/teamBackfill';
import type { RcsMember } from '../types';
import type { TeamMembershipRecord, TeamRecord } from '../../shared/teamRules';

const NOW = '2026-11-05T00:00:00Z';

function member(over: Partial<RcsMember> = {}): RcsMember {
  return { id: 'USER0001', name: 'Member A', team: 'Ecosystem', role: 'tester', startDate: '2026-01-01', active: true, ...over };
}

describe('planTeamBackfill', () => {
  it('creates one team per distinct label and one PRIMARY membership per member', () => {
    const members = [
      member(),
      member({ id: 'USER0002', name: 'Member B', team: 'HTMA' }),
      member({ id: 'USER0003', name: 'Member C', team: 'Ecosystem' }),
    ];
    const plan = planTeamBackfill({ members, teamLabels: ['Ecosystem', 'HTMA'], now: NOW, createdBy: 'sv@example.com' }, [], []);
    expect(plan.teams.map((t) => t.name).sort()).toEqual(['Ecosystem', 'HTMA']);
    expect(plan.memberships).toHaveLength(3);
    const ecoTeam = plan.teams.find((t) => t.name === 'Ecosystem')!;
    const eco = plan.memberships.filter((m) => m.teamId === ecoTeam.id);
    expect(eco).toHaveLength(2);
    expect(plan.memberships.every((m) => m.membershipKind === 'PRIMARY' && m.durationType === 'PERMANENT')).toBe(true);
  });

  it('converts the member inclusive endDate to an exclusive membership end', () => {
    const members = [member({ endDate: '2026-06-30' })];
    const plan = planTeamBackfill({ members, teamLabels: ['Ecosystem'], now: NOW, createdBy: 'sv@example.com' }, [], []);
    expect(plan.memberships[0].effectiveTo).toBe('2026-07-01');
    expect(plan.memberships[0].status).toBe('ACTIVE');
  });

  it('marks a removed member membership ENDED', () => {
    const members = [member({ active: false, endDate: '2026-06-30' })];
    const plan = planTeamBackfill({ members, teamLabels: ['Ecosystem'], now: NOW, createdBy: 'sv@example.com' }, [], []);
    expect(plan.memberships[0].status).toBe('ENDED');
  });

  it('is idempotent: members that already have a PRIMARY membership are skipped', () => {
    const members = [member()];
    const existing: TeamMembershipRecord[] = [
      { id: 'TMB-0001', memberId: 'USER0001', teamId: 'TEAM-ECO', membershipKind: 'PRIMARY', durationType: 'PERMANENT', effectiveFrom: '2026-01-01', status: 'ACTIVE', createdBy: 'sv@example.com', createdAt: NOW },
    ];
    const plan = planTeamBackfill({ members, teamLabels: ['Ecosystem'], now: NOW, createdBy: 'sv@example.com' }, [], existing);
    expect(plan.memberships).toHaveLength(0);
  });

  it('matches existing teams by code or name instead of creating duplicates', () => {
    const existingTeams: TeamRecord[] = [{ id: 'TEAM-ECO', name: 'Ecosystem', code: 'ECO', status: 'ACTIVE', createdAt: NOW, updatedAt: NOW }];
    const members = [member()];
    const plan = planTeamBackfill({ members, teamLabels: ['Ecosystem'], now: NOW, createdBy: 'sv@example.com' }, existingTeams, []);
    expect(plan.teams).toHaveLength(0);
    expect(plan.memberships[0].teamId).toBe('TEAM-ECO');
  });

  it('de-duplicates colliding generated codes', () => {
    const members = [member({ team: 'eco' }), member({ id: 'USER0002', team: 'ECO!' })];
    const plan = planTeamBackfill({ members, teamLabels: [], now: NOW, createdBy: 'sv@example.com' }, [], []);
    // Both labels normalize to code ECO; the second gets a suffix.
    expect(plan.teams.map((t) => t.code).sort()).toEqual(['ECO', 'ECO2']);
  });

  it('reports members without a team label and unmatched settings labels', () => {
    const members = [member(), member({ id: 'USER0002', name: 'No Team', team: '' })];
    const plan = planTeamBackfill({ members, teamLabels: ['Ecosystem', 'Ghost Team'], now: NOW, createdBy: 'sv@example.com' }, [], []);
    expect(plan.membersWithoutTeam).toEqual(['No Team']);
    expect(plan.unmatchedLabels).toEqual(['Ghost Team']);
  });

  it('never modifies the input members', () => {
    const members = [member()];
    const before = JSON.stringify(members);
    planTeamBackfill({ members, teamLabels: ['Ecosystem'], now: NOW, createdBy: 'sv@example.com' }, [], []);
    expect(JSON.stringify(members)).toBe(before);
  });
});
