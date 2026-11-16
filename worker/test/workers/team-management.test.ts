import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { PrincipalDto, UserDto } from '../../../shared/tenancy';
import { activateWeb, addUser, createTenant, email, get, post, rec, whoami } from './tenancy-harness';

const NOW = '2026-11-01T00:00:00.000Z';
type Stored = { kind: string; id: string; json: string };

describe('Team Management routes and Durable Object workflows', () => {
  it('applies transfers atomically, isolates leave, computes calendar/capacity, and expires assignments', async () => {
    const adminEmail = email('tm-admin');
    const tenant = await createTenant('Team Management QA', adminEmail);
    const admin = (await whoami(adminEmail)).json as PrincipalDto;
    if (admin.userId === null) throw new Error('admin user id missing');

    await activateWeb(tenant, [
      rec('member', 'MEM-ADMIN', { name: 'Admin', role: 'SV', active: true, userId: admin.userId }),
      rec('team', 'TEAM-A', { name: 'Alpha', code: 'A', status: 'ACTIVE', createdAt: NOW, updatedAt: NOW }),
      rec('team', 'TEAM-B', { name: 'Beta', code: 'B', status: 'ACTIVE', createdAt: NOW, updatedAt: NOW }),
      rec('teamMembership', 'TMB-A', { memberId: 'MEM-ADMIN', teamId: 'TEAM-A', membershipKind: 'PRIMARY', durationType: 'PERMANENT', effectiveFrom: '2026-01-01', status: 'ACTIVE', createdBy: adminEmail, createdAt: NOW }),
      rec('teamMembership', 'TMB-OLD', { memberId: 'MEM-ADMIN', teamId: 'TEAM-A', membershipKind: 'SUPPORT', durationType: 'TEMPORARY', effectiveFrom: '2026-01-01', effectiveTo: '2026-02-01', status: 'ACTIVE', createdBy: adminEmail, createdAt: NOW }),
      rec('teamSupervisor', 'SUP-A', { teamId: 'TEAM-A', memberId: 'MEM-ADMIN', role: 'SUPERVISOR', effectiveFrom: '2026-01-01' }),
      rec('workSchedule', 'WS-STD', { name: 'Standard', status: 'ACTIVE', days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: '09:00', endTime: '17:30', breakMinutes: 60, workingMinutes: 450 })), createdAt: NOW, updatedAt: NOW }),
      rec('memberSchedule', 'MS-ADMIN', { memberId: 'MEM-ADMIN', templateId: 'WS-STD', effectiveFrom: '2026-01-01' }),
      rec('holidayCalendar', 'CAL-JP', { name: 'Japan', status: 'ACTIVE', holidays: [{ date: '2026-11-18', name: 'Holiday', workingMinutesReduction: 450 }], createdAt: NOW, updatedAt: NOW }),
      rec('capacityAllocation', 'CAP-A', { memberId: 'MEM-ADMIN', teamId: 'TEAM-A', hoursPerWeek: 10, effectiveFrom: '2026-01-01', status: 'ACTIVE' }),
    ]);

    const transfer = await post(adminEmail, '/api/tenant/transfers', {
      id: 'TR-1', memberId: 'MEM-ADMIN', fromTeamId: 'TEAM-A', toTeamId: 'TEAM-B', changeType: 'PERMANENT_TRANSFER', effectiveDate: '2026-11-16', status: 'DRAFT', sourceApproverId: 'MEM-ADMIN', destinationApproverId: 'MEM-ADMIN', createdBy: adminEmail, createdAt: NOW,
    });
    expect(transfer.status).toBe(201);

    const leave = await post(adminEmail, '/api/tenant/leave', { id: 'LV-ADMIN', memberId: 'MEM-ADMIN', leaveTypeId: 'annual', startDate: '2026-11-17', endDate: '2026-11-18', status: 'PENDING', submittedAt: NOW, days: [{ date: '2026-11-17', requestedMinutes: 1 }] });
    expect(leave.status).toBe(201);
    expect((await post(adminEmail, '/api/tenant/leave/LV-ADMIN/decide', { status: 'APPROVED' })).status).toBe(200);

    const testerEmail = email('tm-tester');
    const tester: UserDto = await addUser(tenant, testerEmail, 'viewer');
    const adminExport = await get<{ records: Stored[] }>(adminEmail, '/api/export');
    const testerMember = adminExport.json.records.filter((r) => r.kind === 'member').map((r) => JSON.parse(r.json) as { id: string; userId?: string }).find((m) => m.userId === tester.id);
    if (!testerMember) throw new Error('tester profile missing');
    expect((await post(testerEmail, '/api/tenant/leave', { id: 'LV-TESTER', memberId: testerMember.id, leaveTypeId: 'sick', startDate: '2026-11-19', endDate: '2026-11-20', status: 'PENDING', submittedAt: NOW, days: [{ date: '2026-11-19', requestedMinutes: 1 }] })).status).toBe(201);

    const testerExport = await get<{ records: Stored[] }>(testerEmail, '/api/export');
    const testerLeave = testerExport.json.records.filter((r) => r.kind === 'leaveRequest').map((r) => JSON.parse(r.json) as { id: string; days: Array<{ requestedMinutes: number }> });
    expect(testerLeave.map((r) => r.id)).toEqual(['LV-TESTER']);
    expect(testerLeave[0]?.days[0]?.requestedMinutes).toBe(450); // server-derived, not the submitted minute

    const calendar = await get<{ leave: unknown[] }>(adminEmail, '/api/tenant/calendar?from=2026-11-16&to=2026-11-21');
    expect(calendar.status).toBe(200);
    expect(calendar.json.leave).toHaveLength(1);
    const capacity = await get<{ capacity: Array<{ memberId: string; availableMinutes: number }> }>(adminEmail, '/api/tenant/capacity?from=2026-11-16&to=2026-11-21');
    expect(capacity.status).toBe(200);
    expect(capacity.json.capacity.find((row) => row.memberId === 'MEM-ADMIN')?.availableMinutes).toBe(1350);

    const expiry = await env.WORKSPACE.getByName(tenant.id).runAssignmentExpiry(tenant.id, Date.parse('2026-11-20T00:00:00Z'));
    expect(expiry.ended).toBeGreaterThanOrEqual(1);
    const finalExport = await get<{ records: Stored[] }>(adminEmail, '/api/export');
    const memberships = finalExport.json.records.filter((r) => r.kind === 'teamMembership').map((r) => JSON.parse(r.json) as { id: string; status: string });
    expect(memberships.find((m) => m.id === 'TMB-A')?.status).toBe('ENDED');
    expect(memberships.find((m) => m.id === 'TMB-OLD')?.status).toBe('ENDED');
    expect(finalExport.json.records.some((r) => r.kind === 'teamTransfer' && r.id === 'TR-1')).toBe(true);
  });
});
