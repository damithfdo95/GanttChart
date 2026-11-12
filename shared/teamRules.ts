/**
 * Team Management domain rules (TM-00 Phase 1): teams, memberships, skills,
 * schedules, leave, allocations and supervisors as shared-workspace records.
 *
 * The logical model comes from the Team Management specification (§4); the
 * physical shape follows this repository's document-store architecture: each
 * spec table is one record kind of opaque JSON keyed by (kind, id), validated
 * by these pure rules on BOTH sides — the browser before it saves and the
 * Worker before it accepts a commit (the `qaCommitError` pattern).
 *
 * Date semantics: half-open intervals — inclusive start, EXCLUSIVE end,
 * `undefined` end = open-ended (see shared/teamDates.ts; never convert by hand).
 */

import { coversDate, isTeamDate, periodsOverlap } from './teamDates';

// ---- enums -------------------------------------------------------------------

export const MEMBERSHIP_KINDS = ['PRIMARY', 'SECONDARY', 'SUPPORT'] as const;
export type MembershipKind = (typeof MEMBERSHIP_KINDS)[number];

export const DURATION_TYPES = ['PERMANENT', 'TEMPORARY'] as const;
export type DurationType = (typeof DURATION_TYPES)[number];

export const TEAM_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type TeamStatus = (typeof TEAM_STATUSES)[number];

export const TRANSFER_CHANGE_TYPES = ['PERMANENT_TRANSFER', 'TEMPORARY_PRIMARY_TRANSFER', 'TEMPORARY_SUPPORT', 'PERMANENT_SECONDARY_ASSIGNMENT'] as const;
export type TransferChangeType = (typeof TRANSFER_CHANGE_TYPES)[number];

export const TRANSFER_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'COMPLETED', 'CANCELLED'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const SKILL_PROFICIENCIES = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT'] as const;
export type SkillProficiency = (typeof SKILL_PROFICIENCIES)[number];

export const SKILL_CATEGORIES = ['DOMAIN', 'TECHNICAL', 'TOOLS'] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export const LEAVE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export const ALLOCATION_STATUSES = ['ACTIVE', 'ENDED'] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number];

export const SUPERVISOR_ROLES = ['SUPERVISOR', 'LEAD'] as const;
export type SupervisorRole = (typeof SUPERVISOR_ROLES)[number];

export const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACTOR'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const EMPLOYMENT_STATUSES = ['ACTIVE', 'INACTIVE', 'DEPARTED'] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

// ---- limits ------------------------------------------------------------------

export const TEAM_LIMITS = {
  name: 120,
  code: 40,
  description: 2000,
  reason: 2000,
  notes: 2000,
  decisionNote: 2000,
  skillName: 80,
  templateName: 120,
  holidayName: 120,
} as const;

/** 0 < hours/week <= 168 (there are only 168 hours in a week). */
export const MAX_ALLOCATION_HOURS_PER_WEEK = 168;

// ---- records -----------------------------------------------------------------

/** One team: an organizational unit with supervisors and an optional hierarchy. */
export interface TeamRecord {
  id: string;
  name: string;
  /** Short unique code, e.g. "ECO". */
  code: string;
  description?: string;
  /** Parent team id; absent = root. Must not form a cycle. */
  parentTeamId?: string;
  /** Holiday calendar id (Phase 3); absent = workspace default. */
  calendarId?: string;
  status: TeamStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * One effective-dated membership of a member in a team. A member has at most
 * one PRIMARY membership per date; SECONDARY and SUPPORT memberships may
 * coexist. `effectiveTo` is EXCLUSIVE; `undefined` = open-ended.
 */
export interface TeamMembershipRecord {
  id: string;
  memberId: string;
  teamId: string;
  membershipKind: MembershipKind;
  durationType: DurationType;
  /** Inclusive "YYYY-MM-DD". */
  effectiveFrom: string;
  /** EXCLUSIVE "YYYY-MM-DD"; undefined = open-ended. */
  effectiveTo?: string;
  status: 'ACTIVE' | 'ENDED';
  reason?: string;
  createdBy: string;
  createdAt: string;
}

/** One skill in the reusable catalogue. */
export interface SkillRecord {
  id: string;
  name: string;
  category: SkillCategory;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
  updatedAt: string;
}

/** One member's proficiency in one catalogue skill. */
export interface MemberSkillRecord {
  id: string;
  memberId: string;
  skillId: string;
  proficiency: SkillProficiency;
  verifiedBy?: string;
  verifiedAt?: string;
}

/** One working-schedule template: weekly working days with times and breaks. */
export interface WorkScheduleRecord {
  id: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
  /** One entry per working weekday (0=Sunday … 6=Saturday). */
  days: WorkScheduleDay[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkScheduleDay {
  weekday: number;
  /** "HH:mm" local (business) time. */
  startTime: string;
  endTime: string;
  breakMinutes: number;
  /** Derived on write: endTime − startTime − breakMinutes. */
  workingMinutes: number;
}

/** One effective-dated schedule assignment of a template to a member. */
export interface MemberScheduleRecord {
  id: string;
  memberId: string;
  templateId: string;
  /** Inclusive. */
  effectiveFrom: string;
  /** EXCLUSIVE; undefined = open-ended. */
  effectiveTo?: string;
}

/** One leave request with its per-day minutes (Phase 3 workflow). */
export interface LeaveRequestRecord {
  id: string;
  memberId: string;
  /** Key into the configurable leave types (settings). */
  leaveTypeId: string;
  /** Inclusive. */
  startDate: string;
  /** EXCLUSIVE; undefined = open-ended is NOT allowed for leave — always set. */
  endDate: string;
  status: LeaveStatus;
  reason?: string;
  /** The primary-team supervisor at submission time (spec §3.5); set by the server. */
  approverId?: string;
  submittedAt: string;
  decidedAt?: string;
  decisionNote?: string;
  /** Per-day requested minutes, derived from the member's schedule on write. */
  days: LeaveDayRecord[];
}

export interface LeaveDayRecord {
  /** "YYYY-MM-DD". */
  date: string;
  requestedMinutes: number;
}

/** One holiday calendar with its holidays (Phase 3). */
export interface HolidayCalendarRecord {
  id: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
  holidays: HolidayRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface HolidayRecord {
  date: string;
  name: string;
  /** Minutes subtracted from that day's working minutes. */
  workingMinutesReduction: number;
}

/** One hours-per-week allocation of a member to a team (and optionally a project). */
export interface CapacityAllocationRecord {
  id: string;
  memberId: string;
  teamId: string;
  projectId?: string;
  hoursPerWeek: number;
  /** Inclusive. */
  effectiveFrom: string;
  /** EXCLUSIVE; undefined = open-ended. */
  effectiveTo?: string;
  status: AllocationStatus;
  notes?: string;
}

/** One effective-dated supervisor or lead of a team. */
export interface TeamSupervisorRecord {
  id: string;
  teamId: string;
  memberId: string;
  role: SupervisorRole;
  /** Inclusive. */
  effectiveFrom: string;
  /** EXCLUSIVE; undefined = open-ended. */
  effectiveTo?: string;
}

// ---- helpers -----------------------------------------------------------------

type Obj = Record<string, unknown>;

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 10 && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function plainText(value: unknown, max: number): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function isEnum<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

const ID_SHAPE = /^[A-Za-z0-9_.:-]{1,100}$/;
const TIME_SHAPE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The Team Management record kinds (mirrors RECORD_KINDS in shared/protocol.ts). */
export const TEAM_KINDS = ['team', 'teamMembership', 'teamSupervisor', 'skill', 'memberSkill', 'workSchedule', 'memberSchedule', 'leaveRequest', 'holidayCalendar', 'capacityAllocation'] as const;
export type TeamKind = (typeof TEAM_KINDS)[number];

// ---- per-record checks ---------------------------------------------------------

export type TeamCheck<T> = { ok: true; record: T } | { ok: false; error: string };

export function checkTeam(raw: unknown): TeamCheck<TeamRecord> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'team_not_an_object' };
  const c = raw as Obj;
  if (typeof c.id !== 'string' || !ID_SHAPE.test(c.id)) return { ok: false, error: 'team_invalid_id' };
  if (!plainText(c.name, TEAM_LIMITS.name) || (c.name as string).trim() === '') return { ok: false, error: 'team_invalid_name' };
  if (!plainText(c.code, TEAM_LIMITS.code) || (c.code as string).trim() === '') return { ok: false, error: 'team_invalid_code' };
  if (c.description !== undefined && !plainText(c.description, TEAM_LIMITS.description)) return { ok: false, error: 'team_invalid_description' };
  if (c.parentTeamId !== undefined && (typeof c.parentTeamId !== 'string' || !ID_SHAPE.test(c.parentTeamId))) return { ok: false, error: 'team_invalid_parent' };
  if (c.calendarId !== undefined && (typeof c.calendarId !== 'string' || !ID_SHAPE.test(c.calendarId))) return { ok: false, error: 'team_invalid_calendar' };
  if (!isEnum(c.status, TEAM_STATUSES)) return { ok: false, error: 'team_invalid_status' };
  if (!isTimestamp(c.createdAt) || !isTimestamp(c.updatedAt)) return { ok: false, error: 'team_invalid_timestamp' };
  return { ok: true, record: c as unknown as TeamRecord };
}

export function checkTeamMembership(raw: unknown): TeamCheck<TeamMembershipRecord> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'membership_not_an_object' };
  const c = raw as Obj;
  if (typeof c.id !== 'string' || !ID_SHAPE.test(c.id)) return { ok: false, error: 'membership_invalid_id' };
  if (typeof c.memberId !== 'string' || !ID_SHAPE.test(c.memberId)) return { ok: false, error: 'membership_invalid_member' };
  if (typeof c.teamId !== 'string' || !ID_SHAPE.test(c.teamId)) return { ok: false, error: 'membership_invalid_team' };
  if (!isEnum(c.membershipKind, MEMBERSHIP_KINDS)) return { ok: false, error: 'membership_invalid_kind' };
  if (!isEnum(c.durationType, DURATION_TYPES)) return { ok: false, error: 'membership_invalid_duration' };
  if (!isTeamDate(c.effectiveFrom)) return { ok: false, error: 'membership_invalid_from' };
  if (c.effectiveTo !== undefined && !isTeamDate(c.effectiveTo)) return { ok: false, error: 'membership_invalid_to' };
  if (c.effectiveTo !== undefined && (c.effectiveTo as string) <= (c.effectiveFrom as string)) return { ok: false, error: 'membership_end_not_after_start' };
  if (c.durationType === 'TEMPORARY' && c.effectiveTo === undefined) return { ok: false, error: 'membership_temporary_requires_end' };
  if (!isEnum(c.status, ['ACTIVE', 'ENDED'])) return { ok: false, error: 'membership_invalid_status' };
  if (c.reason !== undefined && !plainText(c.reason, TEAM_LIMITS.reason)) return { ok: false, error: 'membership_invalid_reason' };
  if (typeof c.createdBy !== 'string' || c.createdBy === '') return { ok: false, error: 'membership_invalid_created_by' };
  if (!isTimestamp(c.createdAt)) return { ok: false, error: 'membership_invalid_timestamp' };
  return { ok: true, record: c as unknown as TeamMembershipRecord };
}

export function checkSkill(raw: unknown): TeamCheck<SkillRecord> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'skill_not_an_object' };
  const c = raw as Obj;
  if (typeof c.id !== 'string' || !ID_SHAPE.test(c.id)) return { ok: false, error: 'skill_invalid_id' };
  if (!plainText(c.name, TEAM_LIMITS.skillName) || (c.name as string).trim() === '') return { ok: false, error: 'skill_invalid_name' };
  if (!isEnum(c.category, SKILL_CATEGORIES)) return { ok: false, error: 'skill_invalid_category' };
  if (!isEnum(c.status, ['ACTIVE', 'INACTIVE'])) return { ok: false, error: 'skill_invalid_status' };
  if (!isTimestamp(c.createdAt) || !isTimestamp(c.updatedAt)) return { ok: false, error: 'skill_invalid_timestamp' };
  return { ok: true, record: c as unknown as SkillRecord };
}

export function checkMemberSkill(raw: unknown): TeamCheck<MemberSkillRecord> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'member_skill_not_an_object' };
  const c = raw as Obj;
  if (typeof c.id !== 'string' || !ID_SHAPE.test(c.id)) return { ok: false, error: 'member_skill_invalid_id' };
  if (typeof c.memberId !== 'string' || !ID_SHAPE.test(c.memberId)) return { ok: false, error: 'member_skill_invalid_member' };
  if (typeof c.skillId !== 'string' || !ID_SHAPE.test(c.skillId)) return { ok: false, error: 'member_skill_invalid_skill' };
  if (!isEnum(c.proficiency, SKILL_PROFICIENCIES)) return { ok: false, error: 'member_skill_invalid_proficiency' };
  if (c.verifiedBy !== undefined && !plainText(c.verifiedBy, 120)) return { ok: false, error: 'member_skill_invalid_verified_by' };
  if (c.verifiedAt !== undefined && !isTimestamp(c.verifiedAt)) return { ok: false, error: 'member_skill_invalid_verified_at' };
  return { ok: true, record: c as unknown as MemberSkillRecord };
}

export function checkWorkSchedule(raw: unknown): TeamCheck<WorkScheduleRecord> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'schedule_not_an_object' };
  const c = raw as Obj;
  if (typeof c.id !== 'string' || !ID_SHAPE.test(c.id)) return { ok: false, error: 'schedule_invalid_id' };
  if (!plainText(c.name, TEAM_LIMITS.templateName) || (c.name as string).trim() === '') return { ok: false, error: 'schedule_invalid_name' };
  if (!isEnum(c.status, ['ACTIVE', 'INACTIVE'])) return { ok: false, error: 'schedule_invalid_status' };
  if (!Array.isArray(c.days) || c.days.length === 0) return { ok: false, error: 'schedule_invalid_days' };
  const seenWeekdays = new Set<number>();
  for (const d of c.days) {
    if (typeof d !== 'object' || d === null || Array.isArray(d)) return { ok: false, error: 'schedule_invalid_day' };
    const day = d as Obj;
    if (typeof day.weekday !== 'number' || !Number.isInteger(day.weekday) || day.weekday < 0 || day.weekday > 6) return { ok: false, error: 'schedule_invalid_weekday' };
    if (seenWeekdays.has(day.weekday)) return { ok: false, error: 'schedule_duplicate_weekday' };
    seenWeekdays.add(day.weekday);
    if (typeof day.startTime !== 'string' || !TIME_SHAPE.test(day.startTime)) return { ok: false, error: 'schedule_invalid_start_time' };
    if (typeof day.endTime !== 'string' || !TIME_SHAPE.test(day.endTime)) return { ok: false, error: 'schedule_invalid_end_time' };
    if (day.startTime >= day.endTime) return { ok: false, error: 'schedule_end_before_start' };
    if (typeof day.breakMinutes !== 'number' || !Number.isInteger(day.breakMinutes) || day.breakMinutes < 0 || day.breakMinutes > 480) return { ok: false, error: 'schedule_invalid_break' };
    if (typeof day.workingMinutes !== 'number' || !Number.isInteger(day.workingMinutes) || day.workingMinutes <= 0) return { ok: false, error: 'schedule_invalid_working_minutes' };
  }
  if (!isTimestamp(c.createdAt) || !isTimestamp(c.updatedAt)) return { ok: false, error: 'schedule_invalid_timestamp' };
  return { ok: true, record: c as unknown as WorkScheduleRecord };
}

export function checkMemberSchedule(raw: unknown): TeamCheck<MemberScheduleRecord> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'member_schedule_not_an_object' };
  const c = raw as Obj;
  if (typeof c.id !== 'string' || !ID_SHAPE.test(c.id)) return { ok: false, error: 'member_schedule_invalid_id' };
  if (typeof c.memberId !== 'string' || !ID_SHAPE.test(c.memberId)) return { ok: false, error: 'member_schedule_invalid_member' };
  if (typeof c.templateId !== 'string' || !ID_SHAPE.test(c.templateId)) return { ok: false, error: 'member_schedule_invalid_template' };
  if (!isTeamDate(c.effectiveFrom)) return { ok: false, error: 'member_schedule_invalid_from' };
  if (c.effectiveTo !== undefined && !isTeamDate(c.effectiveTo)) return { ok: false, error: 'member_schedule_invalid_to' };
  if (c.effectiveTo !== undefined && (c.effectiveTo as string) <= (c.effectiveFrom as string)) return { ok: false, error: 'member_schedule_end_not_after_start' };
  return { ok: true, record: c as unknown as MemberScheduleRecord };
}

export function checkLeaveRequest(raw: unknown): TeamCheck<LeaveRequestRecord> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'leave_not_an_object' };
  const c = raw as Obj;
  if (typeof c.id !== 'string' || !ID_SHAPE.test(c.id)) return { ok: false, error: 'leave_invalid_id' };
  if (typeof c.memberId !== 'string' || !ID_SHAPE.test(c.memberId)) return { ok: false, error: 'leave_invalid_member' };
  if (typeof c.leaveTypeId !== 'string' || c.leaveTypeId === '') return { ok: false, error: 'leave_invalid_type' };
  if (!isTeamDate(c.startDate)) return { ok: false, error: 'leave_invalid_start' };
  if (!isTeamDate(c.endDate)) return { ok: false, error: 'leave_invalid_end' };
  if ((c.endDate as string) <= (c.startDate as string)) return { ok: false, error: 'leave_end_not_after_start' };
  if (!isEnum(c.status, LEAVE_STATUSES)) return { ok: false, error: 'leave_invalid_status' };
  if (c.reason !== undefined && !plainText(c.reason, TEAM_LIMITS.reason)) return { ok: false, error: 'leave_invalid_reason' };
  if (c.approverId !== undefined && (typeof c.approverId !== 'string' || !ID_SHAPE.test(c.approverId))) return { ok: false, error: 'leave_invalid_approver' };
  if (!isTimestamp(c.submittedAt)) return { ok: false, error: 'leave_invalid_submitted_at' };
  if (c.decidedAt !== undefined && !isTimestamp(c.decidedAt)) return { ok: false, error: 'leave_invalid_decided_at' };
  if (c.decisionNote !== undefined && !plainText(c.decisionNote, TEAM_LIMITS.decisionNote)) return { ok: false, error: 'leave_invalid_decision_note' };
  if (!Array.isArray(c.days) || c.days.length === 0) return { ok: false, error: 'leave_invalid_days' };
  for (const d of c.days) {
    if (typeof d !== 'object' || d === null || Array.isArray(d)) return { ok: false, error: 'leave_invalid_day' };
    const day = d as Obj;
    if (!isTeamDate(day.date)) return { ok: false, error: 'leave_invalid_day_date' };
    if (typeof day.requestedMinutes !== 'number' || !Number.isInteger(day.requestedMinutes) || day.requestedMinutes <= 0 || day.requestedMinutes > 1440) return { ok: false, error: 'leave_invalid_day_minutes' };
  }
  return { ok: true, record: c as unknown as LeaveRequestRecord };
}

export function checkHolidayCalendar(raw: unknown): TeamCheck<HolidayCalendarRecord> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'calendar_not_an_object' };
  const c = raw as Obj;
  if (typeof c.id !== 'string' || !ID_SHAPE.test(c.id)) return { ok: false, error: 'calendar_invalid_id' };
  if (!plainText(c.name, TEAM_LIMITS.holidayName) || (c.name as string).trim() === '') return { ok: false, error: 'calendar_invalid_name' };
  if (!isEnum(c.status, ['ACTIVE', 'INACTIVE'])) return { ok: false, error: 'calendar_invalid_status' };
  if (!Array.isArray(c.holidays)) return { ok: false, error: 'calendar_invalid_holidays' };
  const seenDates = new Set<string>();
  for (const h of c.holidays) {
    if (typeof h !== 'object' || h === null || Array.isArray(h)) return { ok: false, error: 'calendar_invalid_holiday' };
    const holiday = h as Obj;
    if (!isTeamDate(holiday.date)) return { ok: false, error: 'calendar_invalid_holiday_date' };
    if (seenDates.has(holiday.date)) return { ok: false, error: 'calendar_duplicate_holiday' };
    seenDates.add(holiday.date);
    if (!plainText(holiday.name, TEAM_LIMITS.holidayName) || (holiday.name as string).trim() === '') return { ok: false, error: 'calendar_invalid_holiday_name' };
    if (typeof holiday.workingMinutesReduction !== 'number' || !Number.isInteger(holiday.workingMinutesReduction) || holiday.workingMinutesReduction < 0 || holiday.workingMinutesReduction > 1440) return { ok: false, error: 'calendar_invalid_reduction' };
  }
  if (!isTimestamp(c.createdAt) || !isTimestamp(c.updatedAt)) return { ok: false, error: 'calendar_invalid_timestamp' };
  return { ok: true, record: c as unknown as HolidayCalendarRecord };
}

export function checkCapacityAllocation(raw: unknown): TeamCheck<CapacityAllocationRecord> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'allocation_not_an_object' };
  const c = raw as Obj;
  if (typeof c.id !== 'string' || !ID_SHAPE.test(c.id)) return { ok: false, error: 'allocation_invalid_id' };
  if (typeof c.memberId !== 'string' || !ID_SHAPE.test(c.memberId)) return { ok: false, error: 'allocation_invalid_member' };
  if (typeof c.teamId !== 'string' || !ID_SHAPE.test(c.teamId)) return { ok: false, error: 'allocation_invalid_team' };
  if (c.projectId !== undefined && (typeof c.projectId !== 'string' || !ID_SHAPE.test(c.projectId))) return { ok: false, error: 'allocation_invalid_project' };
  if (typeof c.hoursPerWeek !== 'number' || !Number.isFinite(c.hoursPerWeek) || c.hoursPerWeek <= 0 || c.hoursPerWeek > MAX_ALLOCATION_HOURS_PER_WEEK) return { ok: false, error: 'allocation_invalid_hours' };
  if (!isTeamDate(c.effectiveFrom)) return { ok: false, error: 'allocation_invalid_from' };
  if (c.effectiveTo !== undefined && !isTeamDate(c.effectiveTo)) return { ok: false, error: 'allocation_invalid_to' };
  if (c.effectiveTo !== undefined && (c.effectiveTo as string) <= (c.effectiveFrom as string)) return { ok: false, error: 'allocation_end_not_after_start' };
  if (!isEnum(c.status, ALLOCATION_STATUSES)) return { ok: false, error: 'allocation_invalid_status' };
  if (c.notes !== undefined && !plainText(c.notes, TEAM_LIMITS.notes)) return { ok: false, error: 'allocation_invalid_notes' };
  return { ok: true, record: c as unknown as CapacityAllocationRecord };
}

export function checkTeamSupervisor(raw: unknown): TeamCheck<TeamSupervisorRecord> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'supervisor_not_an_object' };
  const c = raw as Obj;
  if (typeof c.id !== 'string' || !ID_SHAPE.test(c.id)) return { ok: false, error: 'supervisor_invalid_id' };
  if (typeof c.teamId !== 'string' || !ID_SHAPE.test(c.teamId)) return { ok: false, error: 'supervisor_invalid_team' };
  if (typeof c.memberId !== 'string' || !ID_SHAPE.test(c.memberId)) return { ok: false, error: 'supervisor_invalid_member' };
  if (!isEnum(c.role, SUPERVISOR_ROLES)) return { ok: false, error: 'supervisor_invalid_role' };
  if (!isTeamDate(c.effectiveFrom)) return { ok: false, error: 'supervisor_invalid_from' };
  if (c.effectiveTo !== undefined && !isTeamDate(c.effectiveTo)) return { ok: false, error: 'supervisor_invalid_to' };
  if (c.effectiveTo !== undefined && (c.effectiveTo as string) <= (c.effectiveFrom as string)) return { ok: false, error: 'supervisor_end_not_after_start' };
  return { ok: true, record: c as unknown as TeamSupervisorRecord };
}

// ---- cross-record commit rules -------------------------------------------------

export interface TeamCommitInput {
  puts: ReadonlyArray<{ kind: string; id: string; json: string }>;
  deletes: ReadonlyArray<{ kind: string; id: string }>;
  view: { get(kind: string, id: string): string | null; list?(kind: string): Array<{ id: string; json: string }> };
}

/** Post-commit memberships (puts supersede stored records; both are already validated). */
function membershipsOf(input: TeamCommitInput): TeamMembershipRecord[] {
  const out: TeamMembershipRecord[] = [];
  const seen = new Set<string>();
  for (const p of input.puts) {
    if (p.kind !== 'teamMembership') continue;
    const check = checkTeamMembership(JSON.parse(p.json));
    if (check.ok) {
      out.push(check.record);
      seen.add(p.id);
    }
  }
  for (const r of input.view.list?.('teamMembership') ?? []) {
    if (seen.has(r.id)) continue; // superseded by a put in this commit
    const check = checkTeamMembership(JSON.parse(r.json));
    if (check.ok) out.push(check.record);
  }
  return out;
}

/**
 * Rules for Team Management changes that arrive as ordinary commits. Returns
 * a short machine-readable reason, or null when the commit is acceptable.
 *
 *  - every new/changed record is well formed (the per-record checks above);
 *  - a team's `parentTeamId` must name a team of this workspace and the
 *    hierarchy must stay free of cycles (checked on the post-commit state);
 *  - a member has at most one ACTIVE PRIMARY membership at any date
 *    (overlapping PRIMARY periods for the same member are rejected);
 *  - a membership's member and team must exist (in the commit or the store);
 *  - a member schedule period must not overlap another period of the same
 *    member, and its template must exist;
 *  - a capacity allocation's member and team must exist, and the allocation
 *    must not extend beyond the member's covering membership of that team;
 *  - a team supervisor's member and team must exist.
 *
 * Checks run on CHANGES only: data that already exists is never rejected for
 * being old (the `qaCommitError` principle).
 */
export function teamCommitError(input: TeamCommitInput): string | null {
  const { puts, deletes, view } = input;
  const touches = TEAM_KINDS.some((k) => puts.some((p) => p.kind === k) || deletes.some((d) => d.kind === k));
  if (!touches) return null;

  // Per-record shape checks on puts.
  for (const p of puts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(p.json);
    } catch {
      return 'team_invalid_json';
    }
    switch (p.kind) {
      case 'team': {
        const check = checkTeam(parsed);
        if (!check.ok) return check.error;
        if (check.record.id !== p.id) return 'team_id_mismatch';
        break;
      }
      case 'teamMembership': {
        const check = checkTeamMembership(parsed);
        if (!check.ok) return check.error;
        if (check.record.id !== p.id) return 'membership_id_mismatch';
        break;
      }
      case 'teamSupervisor': {
        const check = checkTeamSupervisor(parsed);
        if (!check.ok) return check.error;
        if (check.record.id !== p.id) return 'supervisor_id_mismatch';
        break;
      }
      case 'skill': {
        const check = checkSkill(parsed);
        if (!check.ok) return check.error;
        if (check.record.id !== p.id) return 'skill_id_mismatch';
        break;
      }
      case 'memberSkill': {
        const check = checkMemberSkill(parsed);
        if (!check.ok) return check.error;
        if (check.record.id !== p.id) return 'member_skill_id_mismatch';
        break;
      }
      case 'workSchedule': {
        const check = checkWorkSchedule(parsed);
        if (!check.ok) return check.error;
        if (check.record.id !== p.id) return 'schedule_id_mismatch';
        break;
      }
      case 'memberSchedule': {
        const check = checkMemberSchedule(parsed);
        if (!check.ok) return check.error;
        if (check.record.id !== p.id) return 'member_schedule_id_mismatch';
        break;
      }
      case 'leaveRequest': {
        const check = checkLeaveRequest(parsed);
        if (!check.ok) return check.error;
        if (check.record.id !== p.id) return 'leave_id_mismatch';
        break;
      }
      case 'holidayCalendar': {
        const check = checkHolidayCalendar(parsed);
        if (!check.ok) return check.error;
        if (check.record.id !== p.id) return 'calendar_id_mismatch';
        break;
      }
      case 'capacityAllocation': {
        const check = checkCapacityAllocation(parsed);
        if (!check.ok) return check.error;
        if (check.record.id !== p.id) return 'allocation_id_mismatch';
        break;
      }
    }
  }

  // Post-commit state of teams (puts supersede stored records; deletes remove).
  const teams = new Map<string, TeamRecord>();
  for (const r of view.list?.('team') ?? []) {
    const check = checkTeam(JSON.parse(r.json));
    if (check.ok) teams.set(r.id, check.record);
  }
  const deleted = new Set(deletes.filter((d) => d.kind === 'team').map((d) => d.id));
  for (const p of puts) {
    if (p.kind !== 'team') continue;
    const check = checkTeam(JSON.parse(p.json));
    if (check.ok) teams.set(p.id, check.record);
  }
  for (const id of deleted) teams.delete(id);

  // Team hierarchy: parents must exist and the forest must stay acyclic.
  for (const team of teams.values()) {
    if (team.parentTeamId === undefined) continue;
    if (!teams.has(team.parentTeamId)) return 'team_parent_missing';
    let cursor: string | undefined = team.parentTeamId;
    const guard = new Set<string>([team.id]);
    while (cursor !== undefined) {
      if (guard.has(cursor)) return 'team_parent_cycle';
      guard.add(cursor);
      cursor = teams.get(cursor)?.parentTeamId;
    }
  }

  // Post-commit state of members (existence only).
  const memberIds = new Set<string>();
  for (const r of view.list?.('member') ?? []) memberIds.add(r.id);
  for (const p of puts) if (p.kind === 'member') memberIds.add(p.id);

  // Memberships: references + the one-PRIMARY-per-date rule.
  const memberships = membershipsOf(input);
  for (const m of memberships) {
    if (!memberIds.has(m.memberId)) return 'membership_member_missing';
    if (!teams.has(m.teamId)) return 'membership_team_missing';
  }
  const primaries = memberships.filter((m) => m.membershipKind === 'PRIMARY' && m.status === 'ACTIVE');
  const byMember = new Map<string, TeamMembershipRecord[]>();
  for (const m of primaries) {
    const list = byMember.get(m.memberId) ?? [];
    list.push(m);
    byMember.set(m.memberId, list);
  }
  for (const list of byMember.values()) {
    list.sort((x, y) => (x.effectiveFrom < y.effectiveFrom ? -1 : x.effectiveFrom > y.effectiveFrom ? 1 : 0));
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1];
      const curr = list[i];
      if (prev !== undefined && curr !== undefined && periodsOverlap(prev.effectiveFrom, prev.effectiveTo, curr.effectiveFrom, curr.effectiveTo)) return 'membership_primary_overlap';
    }
  }

  // Member schedules: template must exist; periods of one member must not overlap.
  const templates = new Set<string>();
  for (const r of view.list?.('workSchedule') ?? []) templates.add(r.id);
  for (const p of puts) if (p.kind === 'workSchedule') templates.add(p.id);
  const schedules: MemberScheduleRecord[] = [];
  const scheduleSeen = new Set<string>();
  for (const p of puts) {
    if (p.kind !== 'memberSchedule') continue;
    const check = checkMemberSchedule(JSON.parse(p.json));
    if (check.ok) {
      schedules.push(check.record);
      scheduleSeen.add(p.id);
    }
  }
  for (const r of view.list?.('memberSchedule') ?? []) {
    if (scheduleSeen.has(r.id)) continue;
    const check = checkMemberSchedule(JSON.parse(r.json));
    if (check.ok) schedules.push(check.record);
  }
  for (const s of schedules) {
    if (!memberIds.has(s.memberId)) return 'member_schedule_member_missing';
    if (!templates.has(s.templateId)) return 'member_schedule_template_missing';
  }
  const scheduleByMember = new Map<string, MemberScheduleRecord[]>();
  for (const s of schedules) {
    const list = scheduleByMember.get(s.memberId) ?? [];
    list.push(s);
    scheduleByMember.set(s.memberId, list);
  }
  for (const list of scheduleByMember.values()) {
    list.sort((x, y) => (x.effectiveFrom < y.effectiveFrom ? -1 : x.effectiveFrom > y.effectiveFrom ? 1 : 0));
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1];
      const curr = list[i];
      if (prev !== undefined && curr !== undefined && periodsOverlap(prev.effectiveFrom, prev.effectiveTo, curr.effectiveFrom, curr.effectiveTo)) return 'member_schedule_overlap';
    }
  }

  // Capacity allocations: references + must not outlive the covering membership.
  const allocations: CapacityAllocationRecord[] = [];
  const allocationSeen = new Set<string>();
  for (const p of puts) {
    if (p.kind !== 'capacityAllocation') continue;
    const check = checkCapacityAllocation(JSON.parse(p.json));
    if (check.ok) {
      allocations.push(check.record);
      allocationSeen.add(p.id);
    }
  }
  for (const r of view.list?.('capacityAllocation') ?? []) {
    if (allocationSeen.has(r.id)) continue;
    const check = checkCapacityAllocation(JSON.parse(r.json));
    if (check.ok) allocations.push(check.record);
  }
  for (const a of allocations) {
    if (!memberIds.has(a.memberId)) return 'allocation_member_missing';
    if (!teams.has(a.teamId)) return 'allocation_team_missing';
    const covering = memberships.some(
      (m) => m.memberId === a.memberId && m.teamId === a.teamId && m.status === 'ACTIVE' && coversDate(m.effectiveFrom, m.effectiveTo, a.effectiveFrom),
    );
    if (!covering) return 'allocation_no_membership';
    if (a.effectiveTo !== undefined) {
      const allocationEnd = a.effectiveTo;
      const inside = memberships.some(
        (m) =>
          m.memberId === a.memberId &&
          m.teamId === a.teamId &&
          m.status === 'ACTIVE' &&
          periodsOverlap(m.effectiveFrom, m.effectiveTo, a.effectiveFrom, allocationEnd) &&
          (m.effectiveTo === undefined || allocationEnd <= m.effectiveTo),
      );
      if (!inside) return 'allocation_beyond_membership';
    }
  }

  // Supervisors: references must exist.
  const supervisors: TeamSupervisorRecord[] = [];
  const supervisorSeen = new Set<string>();
  for (const p of puts) {
    if (p.kind !== 'teamSupervisor') continue;
    const check = checkTeamSupervisor(JSON.parse(p.json));
    if (check.ok) {
      supervisors.push(check.record);
      supervisorSeen.add(p.id);
    }
  }
  for (const r of view.list?.('teamSupervisor') ?? []) {
    if (supervisorSeen.has(r.id)) continue;
    const check = checkTeamSupervisor(JSON.parse(r.json));
    if (check.ok) supervisors.push(check.record);
  }
  for (const s of supervisors) {
    if (!teams.has(s.teamId)) return 'supervisor_team_missing';
    if (!memberIds.has(s.memberId)) return 'supervisor_member_missing';
  }

  // Skills: member and catalogue skill must exist.
  const skills = new Set<string>();
  for (const r of view.list?.('skill') ?? []) skills.add(r.id);
  for (const p of puts) if (p.kind === 'skill') skills.add(p.id);
  for (const p of puts) {
    if (p.kind !== 'memberSkill') continue;
    const check = checkMemberSkill(JSON.parse(p.json));
    if (!check.ok) continue; // already checked above
    if (!memberIds.has(check.record.memberId)) return 'member_skill_member_missing';
    if (!skills.has(check.record.skillId)) return 'member_skill_skill_missing';
  }

  return null;
}

// ---- read-side selectors -------------------------------------------------------

/** The member's PRIMARY membership covering `date`, or null. */
export function primaryMembershipOf(memberships: readonly TeamMembershipRecord[], memberId: string, date: string): TeamMembershipRecord | null {
  let best: TeamMembershipRecord | null = null;
  for (const m of memberships) {
    if (m.memberId !== memberId || m.membershipKind !== 'PRIMARY' || m.status !== 'ACTIVE') continue;
    if (!coversDate(m.effectiveFrom, m.effectiveTo, date)) continue;
    if (best === null || m.effectiveFrom > best.effectiveFrom) best = m;
  }
  return best;
}

/** All ACTIVE memberships of the member covering `date` (primary first). */
export function membershipsOn(memberships: readonly TeamMembershipRecord[], memberId: string, date: string): TeamMembershipRecord[] {
  return memberships
    .filter((m) => m.memberId === memberId && m.status === 'ACTIVE' && coversDate(m.effectiveFrom, m.effectiveTo, date))
    .sort((a, b) => (a.membershipKind === 'PRIMARY' ? -1 : b.membershipKind === 'PRIMARY' ? 1 : a.effectiveFrom < b.effectiveFrom ? -1 : 1));
}

/** The team's supervisor covering `date` (latest effective), or null. */
export function supervisorOf(supervisors: readonly TeamSupervisorRecord[], teamId: string, date: string): TeamSupervisorRecord | null {
  let best: TeamSupervisorRecord | null = null;
  for (const s of supervisors) {
    if (s.teamId !== teamId || s.role !== 'SUPERVISOR') continue;
    if (!coversDate(s.effectiveFrom, s.effectiveTo, date)) continue;
    if (best === null || s.effectiveFrom > best.effectiveFrom) best = s;
  }
  return best;
}
