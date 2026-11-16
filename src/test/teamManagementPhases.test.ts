import { describe, expect, it } from 'vitest';
import { calculateMemberCapacity, DEFAULT_WORK_SCHEDULE } from '../../shared/teamCapacity';
import { canOnTeam } from '../../shared/teamAccess';
import { checkTeamTransfer } from '../../shared/teamRules';
import { allocatedHoursByTeam, leaveUtilization, teamComposition, transferFlow } from '../domain/teamManagement/analytics';

describe('team management phases 2-5', () => {
  it('validates temporary transfers and rejects same-team moves', () => {
    const base = { id: 'tr1', memberId: 'm1', fromTeamId: 'a', toTeamId: 'b', changeType: 'TEMPORARY_PRIMARY_TRANSFER', effectiveDate: '2026-11-01', plannedEndDate: '2026-12-01', status: 'SCHEDULED', sourceApproverId: 's1', destinationApproverId: 's2', createdBy: 'sv', createdAt: '2026-10-01T00:00:00Z' } as const;
    expect(checkTeamTransfer(base).ok).toBe(true);
    expect(checkTeamTransfer({ ...base, toTeamId: 'a' })).toEqual({ ok: false, error: 'transfer_same_team' });
  });
  it('scopes supervisors by team and half-open date', () => {
    const rows = [{ id: 's1', teamId: 'a', memberId: 'm1', role: 'SUPERVISOR', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-01' }] as const;
    expect(canOnTeam({ role: 'user', memberId: 'm1' }, 'transfers.approve', 'a', rows, '2026-11-30')).toBe(true);
    expect(canOnTeam({ role: 'user', memberId: 'm1' }, 'transfers.approve', 'a', rows, '2026-12-01')).toBe(false);
    expect(canOnTeam(null, 'transfers.approve', 'a', rows, '2026-11-30')).toBe(false);
  });
  it('calculates schedule minus holiday and approved leave, with allocations', () => {
    const result = calculateMemberCapacity({ memberId: 'm1', from: '2026-11-16', to: '2026-11-21', schedules: [DEFAULT_WORK_SCHEDULE], memberSchedules: [], calendars: [{ id: 'c', name: 'JP', status: 'ACTIVE', holidays: [{ date: '2026-11-18', name: 'Holiday', workingMinutesReduction: 450 }], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }], leaves: [{ id: 'l', memberId: 'm1', leaveTypeId: 'annual', startDate: '2026-11-19', endDate: '2026-11-20', status: 'APPROVED', submittedAt: '2026-01-01T00:00:00Z', days: [{ date: '2026-11-19', requestedMinutes: 450 }] }], allocations: [{ id: 'a', memberId: 'm1', teamId: 't', hoursPerWeek: 15, effectiveFrom: '2026-01-01', status: 'ACTIVE' }] });
    expect(result.availableMinutes).toBe(1350); expect(result.allocatedMinutes).toBe(900); expect(result.remainingMinutes).toBe(450);
  });
  it('derives analytics without stored aggregates', () => {
    expect(teamComposition([{ id: 'm', memberId: 'u', teamId: 't', membershipKind: 'PRIMARY', durationType: 'PERMANENT', effectiveFrom: '2026-01-01', status: 'ACTIVE', createdBy: 'x', createdAt: '2026-01-01T00:00:00Z' }], '2026-11-01')).toEqual([{ teamId: 't', members: 1 }]);
    expect(transferFlow([{ id: 'x', memberId: 'u', fromTeamId: 'a', toTeamId: 'b', changeType: 'PERMANENT_TRANSFER', effectiveDate: '2026-01-01', status: 'COMPLETED', createdBy: 'x', createdAt: '2026-01-01T00:00:00Z' }])).toEqual([{ changeType: 'PERMANENT_TRANSFER', count: 1 }]);
    expect(leaveUtilization([{ id: 'l', memberId: 'u', leaveTypeId: 'annual', startDate: '2026-01-01', endDate: '2026-01-02', status: 'APPROVED', submittedAt: '2026-01-01T00:00:00Z', days: [{ date: '2026-01-01', requestedMinutes: 450 }] }])).toEqual([{ leaveTypeId: 'annual', minutes: 450 }]);
    expect(allocatedHoursByTeam([{ id: 'a', memberId: 'u', teamId: 't', hoursPerWeek: 10, effectiveFrom: '2026-01-01', status: 'ACTIVE' }])).toEqual([{ teamId: 't', hours: 10 }]);
  });
});
