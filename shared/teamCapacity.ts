import { coversDate } from './teamDates';
import type { CapacityAllocationRecord, HolidayCalendarRecord, LeaveRequestRecord, MemberScheduleRecord, WorkScheduleRecord } from './teamRules';

export const DEFAULT_WORK_SCHEDULE: WorkScheduleRecord = {
  id: 'default-37.5h', name: 'Standard 37.5 hours', status: 'ACTIVE',
  days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: '09:00', endTime: '17:30', breakMinutes: 60, workingMinutes: 450 })),
  createdAt: '1970-01-01T00:00:00.000Z', updatedAt: '1970-01-01T00:00:00.000Z',
};

export interface CapacityInputs { memberId: string; teamId?: string; from: string; to: string; schedules: readonly WorkScheduleRecord[]; memberSchedules: readonly MemberScheduleRecord[]; calendars: readonly HolidayCalendarRecord[]; leaves: readonly LeaveRequestRecord[]; allocations: readonly CapacityAllocationRecord[] }
export interface CapacityResult { availableMinutes: number; allocatedMinutes: number; remainingMinutes: number; utilizationPercent: number; warning: 'NONE' | 'HIGH' | 'OVER' }

function dates(from: string, to: string): string[] {
  const out: string[] = [];
  for (let ms = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); ms < end; ms += 86_400_000) out.push(new Date(ms).toISOString().slice(0, 10));
  return out;
}

export function calculateMemberCapacity(input: CapacityInputs): CapacityResult {
  const templates = new Map(input.schedules.map((s) => [s.id, s]));
  const holidays = new Map(input.calendars.flatMap((c) => c.status === 'ACTIVE' ? c.holidays.map((h) => [h.date, h.workingMinutesReduction] as const) : []));
  const approvedLeave = new Map(input.leaves.filter((l) => l.memberId === input.memberId && l.status === 'APPROVED').flatMap((l) => l.days.map((d) => [d.date, d.requestedMinutes] as const)));
  let availableMinutes = 0;
  const rangeDates = dates(input.from, input.to);
  for (const date of rangeDates) {
    const assignment = input.memberSchedules.find((s) => s.memberId === input.memberId && coversDate(s.effectiveFrom, s.effectiveTo, date));
    const schedule = (assignment && templates.get(assignment.templateId)) ?? DEFAULT_WORK_SCHEDULE;
    const day = schedule.days.find((d) => d.weekday === new Date(`${date}T00:00:00Z`).getUTCDay());
    availableMinutes += Math.max(0, (day?.workingMinutes ?? 0) - (holidays.get(date) ?? 0) - (approvedLeave.get(date) ?? 0));
  }
  const workingDays = rangeDates.filter((d) => {
    const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
    return weekday >= 1 && weekday <= 5;
  }).length;
  const allocatedMinutes = input.allocations.filter((a) => a.memberId === input.memberId && a.status === 'ACTIVE' && (input.teamId === undefined || a.teamId === input.teamId) && rangeDates.some((d) => coversDate(a.effectiveFrom, a.effectiveTo, d))).reduce((sum, a) => sum + a.hoursPerWeek * 60 * (workingDays / 5), 0);
  const remainingMinutes = availableMinutes - allocatedMinutes;
  const utilizationPercent = availableMinutes === 0 ? (allocatedMinutes === 0 ? 0 : 100) : (allocatedMinutes / availableMinutes) * 100;
  return { availableMinutes, allocatedMinutes, remainingMinutes, utilizationPercent, warning: utilizationPercent > 100 ? 'OVER' : utilizationPercent >= 85 ? 'HIGH' : 'NONE' };
}
