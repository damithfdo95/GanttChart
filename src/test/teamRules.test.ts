import { describe, expect, it } from 'vitest';
import {
  checkCapacityAllocation,
  checkLeaveRequest,
  checkMemberSchedule,
  checkSkill,
  checkTeam,
  checkTeamMembership,
  checkTeamSupervisor,
  checkWorkSchedule,
  membershipsOn,
  primaryMembershipOf,
  supervisorOf,
  teamCommitError,
  type CapacityAllocationRecord,
  type MemberScheduleRecord,
  type SkillRecord,
  type TeamMembershipRecord,
  type TeamRecord,
  type TeamSupervisorRecord,
  type WorkScheduleRecord,
} from '../../shared/teamRules';

const NOW = '2026-11-05T00:00:00Z';

function team(over: Partial<TeamRecord> = {}): TeamRecord {
  return { id: 'TEAM-ECO', name: 'Ecosystem', code: 'ECO', status: 'ACTIVE', createdAt: NOW, updatedAt: NOW, ...over };
}

function membership(over: Partial<TeamMembershipRecord> = {}): TeamMembershipRecord {
  return {
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
  };
}

function schedule(over: Partial<WorkScheduleRecord> = {}): WorkScheduleRecord {
  return {
    id: 'WS-STD',
    name: 'Standard 37.5h',
    status: 'ACTIVE',
    days: [
      { weekday: 1, startTime: '09:00', endTime: '17:30', breakMinutes: 60, workingMinutes: 450 },
      { weekday: 2, startTime: '09:00', endTime: '17:30', breakMinutes: 60, workingMinutes: 450 },
      { weekday: 3, startTime: '09:00', endTime: '17:30', breakMinutes: 60, workingMinutes: 450 },
      { weekday: 4, startTime: '09:00', endTime: '17:30', breakMinutes: 60, workingMinutes: 450 },
      { weekday: 5, startTime: '09:00', endTime: '17:30', breakMinutes: 60, workingMinutes: 450 },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function allocation(over: Partial<CapacityAllocationRecord> = {}): CapacityAllocationRecord {
  return { id: 'CAP-0001', memberId: 'USER0001', teamId: 'TEAM-ECO', hoursPerWeek: 24, effectiveFrom: '2026-01-01', status: 'ACTIVE', ...over };
}

/** A commit view over in-memory records. */
function viewOf(store: Record<string, Array<{ id: string; json: string }>>): { get(kind: string, id: string): string | null; list(kind: string): Array<{ id: string; json: string }> } {
  return {
    get: (kind, id) => store[kind]?.find((r) => r.id === id)?.json ?? null,
    list: (kind) => store[kind] ?? [],
  };
}

function put(kind: string, record: unknown): { kind: string; id: string; json: string } {
  const id = (record as { id: string }).id;
  return { kind, id, json: JSON.stringify(record) };
}

describe('checkTeam', () => {
  it('accepts a well-formed team', () => {
    expect(checkTeam(team())).toEqual({ ok: true, record: team() });
  });
  it('rejects a bad name, code, status or parent', () => {
    expect(checkTeam(team({ name: '' })).ok).toBe(false);
    expect(checkTeam(team({ name: 'x'.repeat(121) })).ok).toBe(false);
    expect(checkTeam(team({ code: '' })).ok).toBe(false);
    expect(checkTeam(team({ status: 'GONE' as never })).ok).toBe(false);
    expect(checkTeam(team({ parentTeamId: 'bad id!' })).ok).toBe(false);
  });
});

describe('checkTeamMembership', () => {
  it('accepts a well-formed membership', () => {
    expect(checkTeamMembership(membership())).toEqual({ ok: true, record: membership() });
  });
  it('requires a temporary membership to have an end', () => {
    expect(checkTeamMembership(membership({ durationType: 'TEMPORARY' })).ok).toBe(false);
    expect(checkTeamMembership(membership({ durationType: 'TEMPORARY', effectiveTo: '2026-12-15' })).ok).toBe(true);
  });
  it('requires the exclusive end to be after the start', () => {
    expect(checkTeamMembership(membership({ effectiveTo: '2026-01-01' })).ok).toBe(false);
    expect(checkTeamMembership(membership({ effectiveTo: '2025-12-31' })).ok).toBe(false);
  });
  it('rejects invalid kinds, dates and references', () => {
    expect(checkTeamMembership(membership({ membershipKind: 'BOSS' as never })).ok).toBe(false);
    expect(checkTeamMembership(membership({ effectiveFrom: '2026-13-01' })).ok).toBe(false);
    expect(checkTeamMembership(membership({ memberId: '' })).ok).toBe(false);
  });
});

describe('checkWorkSchedule', () => {
  it('accepts the standard template', () => {
    expect(checkWorkSchedule(schedule())).toEqual({ ok: true, record: schedule() });
  });
  it('rejects duplicate weekdays, bad times and non-positive working minutes', () => {
    const days = schedule().days;
    expect(checkWorkSchedule(schedule({ days: [...days, { ...days[0] }] })).ok).toBe(false);
    expect(checkWorkSchedule(schedule({ days: [{ weekday: 1, startTime: '18:00', endTime: '09:00', breakMinutes: 0, workingMinutes: 450 }] })).ok).toBe(false);
    expect(checkWorkSchedule(schedule({ days: [{ weekday: 1, startTime: '09:00', endTime: '17:30', breakMinutes: 60, workingMinutes: 0 }] })).ok).toBe(false);
    expect(checkWorkSchedule(schedule({ days: [{ weekday: 7, startTime: '09:00', endTime: '17:30', breakMinutes: 60, workingMinutes: 450 }] })).ok).toBe(false);
  });
});

describe('checkLeaveRequest', () => {
  const leave = {
    id: 'LV-0001',
    memberId: 'USER0001',
    leaveTypeId: 'annual',
    startDate: '2026-12-01',
    endDate: '2026-12-04',
    status: 'PENDING',
    submittedAt: NOW,
    days: [{ date: '2026-12-01', requestedMinutes: 450 }],
  };
  it('accepts a well-formed request', () => {
    expect(checkLeaveRequest(leave).ok).toBe(true);
  });
  it('requires an end after the start and at least one day', () => {
    expect(checkLeaveRequest({ ...leave, endDate: '2026-12-01' }).ok).toBe(false);
    expect(checkLeaveRequest({ ...leave, days: [] }).ok).toBe(false);
  });
  it('bounds requested minutes to a day', () => {
    expect(checkLeaveRequest({ ...leave, days: [{ date: '2026-12-01', requestedMinutes: 0 }] }).ok).toBe(false);
    expect(checkLeaveRequest({ ...leave, days: [{ date: '2026-12-01', requestedMinutes: 1441 }] }).ok).toBe(false);
  });
});

describe('checkCapacityAllocation', () => {
  it('accepts a well-formed allocation', () => {
    expect(checkCapacityAllocation(allocation())).toEqual({ ok: true, record: allocation() });
  });
  it('bounds hours per week', () => {
    expect(checkCapacityAllocation(allocation({ hoursPerWeek: 0 })).ok).toBe(false);
    expect(checkCapacityAllocation(allocation({ hoursPerWeek: 169 })).ok).toBe(false);
    expect(checkCapacityAllocation(allocation({ hoursPerWeek: 40 })).ok).toBe(true);
  });
});

describe('checkSkill / checkMemberSchedule / checkTeamSupervisor', () => {
  it('validates skills', () => {
    const skill: SkillRecord = { id: 'SKL-001', name: 'API', category: 'TECHNICAL', status: 'ACTIVE', createdAt: NOW, updatedAt: NOW };
    expect(checkSkill(skill).ok).toBe(true);
    expect(checkSkill({ ...skill, category: 'OTHER' as never }).ok).toBe(false);
    expect(checkSkill({ ...skill, name: '' }).ok).toBe(false);
  });
  it('validates member schedules', () => {
    const ms: MemberScheduleRecord = { id: 'MS-0001', memberId: 'USER0001', templateId: 'WS-STD', effectiveFrom: '2026-01-01' };
    expect(checkMemberSchedule(ms).ok).toBe(true);
    expect(checkMemberSchedule({ ...ms, effectiveTo: '2026-01-01' }).ok).toBe(false);
  });
  it('validates supervisors', () => {
    const sup: TeamSupervisorRecord = { id: 'SUP-0001', teamId: 'TEAM-ECO', memberId: 'USER0002', role: 'SUPERVISOR', effectiveFrom: '2026-01-01' };
    expect(checkTeamSupervisor(sup).ok).toBe(true);
    expect(checkTeamSupervisor({ ...sup, role: 'CHIEF' as never }).ok).toBe(false);
  });
});

describe('teamCommitError', () => {
  it('ignores commits that touch nothing of ours', () => {
    expect(teamCommitError({ puts: [put('project', { id: 'p1' })], deletes: [], view: viewOf({}) })).toBeNull();
  });

  it('accepts a valid team and membership', () => {
    const store = { member: [{ id: 'USER0001', json: JSON.stringify({ id: 'USER0001', name: 'A', team: 'Ecosystem', role: 'tester', startDate: '2026-01-01', active: true }) }] };
    const result = teamCommitError({ puts: [put('team', team()), put('teamMembership', membership())], deletes: [], view: viewOf(store) });
    expect(result).toBeNull();
  });

  it('rejects a membership whose member or team does not exist', () => {
    expect(teamCommitError({ puts: [put('teamMembership', membership())], deletes: [], view: viewOf({}) })).toBe('membership_member_missing');
    const store = { member: [{ id: 'USER0001', json: JSON.stringify({ id: 'USER0001' }) }] };
    expect(teamCommitError({ puts: [put('teamMembership', membership())], deletes: [], view: viewOf(store) })).toBe('membership_team_missing');
  });

  it('rejects overlapping PRIMARY memberships of one member', () => {
    const store = {
      member: [{ id: 'USER0001', json: JSON.stringify({ id: 'USER0001' }) }],
      team: [put('team', team()), put('team', team({ id: 'TEAM-HTMA', name: 'HTMA', code: 'HTMA' }))].map((p) => ({ id: p.id, json: p.json })),
      teamMembership: [put('teamMembership', membership())].map((p) => ({ id: p.id, json: p.json })),
    };
    const overlapping = membership({ id: 'TMB-0002', teamId: 'TEAM-HTMA', effectiveFrom: '2026-06-01' });
    expect(teamCommitError({ puts: [put('teamMembership', overlapping)], deletes: [], view: viewOf(store) })).toBe('membership_primary_overlap');
    // A SECONDARY membership in the same period is fine.
    const secondary = membership({ id: 'TMB-0003', teamId: 'TEAM-HTMA', membershipKind: 'SECONDARY', effectiveFrom: '2026-06-01' });
    expect(teamCommitError({ puts: [put('teamMembership', secondary)], deletes: [], view: viewOf(store) })).toBeNull();
  });

  it('allows adjacent PRIMARY periods (the transfer chain)', () => {
    const store = {
      member: [{ id: 'USER0001', json: JSON.stringify({ id: 'USER0001' }) }],
      team: [put('team', team()), put('team', team({ id: 'TEAM-HTMA', name: 'HTMA', code: 'HTMA' }))].map((p) => ({ id: p.id, json: p.json })),
      teamMembership: [put('teamMembership', membership({ effectiveTo: '2026-12-01' }))].map((p) => ({ id: p.id, json: p.json })),
    };
    const next = membership({ id: 'TMB-0002', teamId: 'TEAM-HTMA', effectiveFrom: '2026-12-01' });
    expect(teamCommitError({ puts: [put('teamMembership', next)], deletes: [], view: viewOf(store) })).toBeNull();
  });

  it('rejects a team hierarchy cycle', () => {
    const a = team({ id: 'TEAM-A', code: 'A', parentTeamId: 'TEAM-B' });
    const b = team({ id: 'TEAM-B', code: 'B', parentTeamId: 'TEAM-A' });
    expect(teamCommitError({ puts: [put('team', a), put('team', b)], deletes: [], view: viewOf({}) })).toBe('team_parent_cycle');
  });

  it('rejects a parent that does not exist', () => {
    expect(teamCommitError({ puts: [put('team', team({ parentTeamId: 'TEAM-GHOST' }))], deletes: [], view: viewOf({}) })).toBe('team_parent_missing');
  });

  it('rejects an allocation without a covering membership', () => {
    const store = {
      member: [{ id: 'USER0001', json: JSON.stringify({ id: 'USER0001' }) }],
      team: [put('team', team())].map((p) => ({ id: p.id, json: p.json })),
    };
    expect(teamCommitError({ puts: [put('capacityAllocation', allocation())], deletes: [], view: viewOf(store) })).toBe('allocation_no_membership');
  });

  it('rejects an allocation that outlives the membership', () => {
    const store = {
      member: [{ id: 'USER0001', json: JSON.stringify({ id: 'USER0001' }) }],
      team: [put('team', team())].map((p) => ({ id: p.id, json: p.json })),
      teamMembership: [put('teamMembership', membership({ effectiveTo: '2026-06-01' }))].map((p) => ({ id: p.id, json: p.json })),
    };
    expect(teamCommitError({ puts: [put('capacityAllocation', allocation({ effectiveTo: '2026-09-01' }))], deletes: [], view: viewOf(store) })).toBe('allocation_beyond_membership');
    // Ending exactly at the membership end is fine (both exclusive).
    expect(teamCommitError({ puts: [put('capacityAllocation', allocation({ effectiveTo: '2026-06-01' }))], deletes: [], view: viewOf(store) })).toBeNull();
  });

  it('rejects overlapping member schedule periods', () => {
    const store = {
      member: [{ id: 'USER0001', json: JSON.stringify({ id: 'USER0001' }) }],
      workSchedule: [put('workSchedule', schedule())].map((p) => ({ id: p.id, json: p.json })),
      memberSchedule: [put('memberSchedule', { id: 'MS-0001', memberId: 'USER0001', templateId: 'WS-STD', effectiveFrom: '2026-01-01', effectiveTo: '2026-03-01' })].map((p) => ({ id: p.id, json: p.json })),
    };
    const overlap = { id: 'MS-0002', memberId: 'USER0001', templateId: 'WS-STD', effectiveFrom: '2026-02-01' };
    expect(teamCommitError({ puts: [put('memberSchedule', overlap)], deletes: [], view: viewOf(store) })).toBe('member_schedule_overlap');
    const after = { id: 'MS-0003', memberId: 'USER0001', templateId: 'WS-STD', effectiveFrom: '2026-03-01' };
    expect(teamCommitError({ puts: [put('memberSchedule', after)], deletes: [], view: viewOf(store) })).toBeNull();
  });

  it('rejects a member schedule with a missing template', () => {
    const store = { member: [{ id: 'USER0001', json: JSON.stringify({ id: 'USER0001' }) }] };
    const ms = { id: 'MS-0001', memberId: 'USER0001', templateId: 'WS-GHOST', effectiveFrom: '2026-01-01' };
    expect(teamCommitError({ puts: [put('memberSchedule', ms)], deletes: [], view: viewOf(store) })).toBe('member_schedule_template_missing');
  });
});

describe('read-side selectors', () => {
  const eco = membership();
  const htmaTemp = membership({ id: 'TMB-0002', teamId: 'TEAM-HTMA', membershipKind: 'SUPPORT', durationType: 'TEMPORARY', effectiveFrom: '2026-12-01', effectiveTo: '2026-12-15' });
  const memberships = [eco, htmaTemp];

  it('primaryMembershipOf finds the covering primary', () => {
    expect(primaryMembershipOf(memberships, 'USER0001', '2026-11-05')?.id).toBe('TMB-0001');
    expect(primaryMembershipOf(memberships, 'USER0001', '2025-01-01')).toBeNull();
    expect(primaryMembershipOf(memberships, 'USER9999', '2026-11-05')).toBeNull();
  });

  it('membershipsOn lists primary first and respects the exclusive end', () => {
    const on = membershipsOn(memberships, 'USER0001', '2026-12-10');
    expect(on.map((m) => m.id)).toEqual(['TMB-0001', 'TMB-0002']);
    const after = membershipsOn(memberships, 'USER0001', '2026-12-20');
    expect(after.map((m) => m.id)).toEqual(['TMB-0001']);
  });

  it('supervisorOf finds the effective-dated supervisor', () => {
    const sup: TeamSupervisorRecord[] = [
      { id: 'SUP-0001', teamId: 'TEAM-ECO', memberId: 'USER0002', role: 'SUPERVISOR', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-01' },
      { id: 'SUP-0002', teamId: 'TEAM-ECO', memberId: 'USER0003', role: 'SUPERVISOR', effectiveFrom: '2026-06-01' },
    ];
    expect(supervisorOf(sup, 'TEAM-ECO', '2026-03-01')?.memberId).toBe('USER0002');
    expect(supervisorOf(sup, 'TEAM-ECO', '2026-07-01')?.memberId).toBe('USER0003');
    expect(supervisorOf(sup, 'TEAM-HTMA', '2026-07-01')).toBeNull();
  });
});
