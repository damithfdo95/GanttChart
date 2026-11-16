import { coversDate } from './teamDates';
import type { TeamSupervisorRecord } from './teamRules';

export type TeamAction = 'teams.manage' | 'assignments.manage' | 'transfers.approve' | 'transfers.cancel' | 'leave.approve' | 'capacity.manage';
export interface TeamPrincipal { role: 'admin' | 'user'; memberId?: string }

/** Resource-scoped authorization. The caller identity is trusted; request fields are not. */
export function canOnTeam(principal: TeamPrincipal | null, _action: TeamAction, teamId: string, supervisors: readonly TeamSupervisorRecord[], date: string): boolean {
  if (principal === null) return false;
  if (principal.role === 'admin') return true;
  if (principal.memberId === undefined) return false;
  return supervisors.some((row) => row.teamId === teamId && row.memberId === principal.memberId && coversDate(row.effectiveFrom, row.effectiveTo, date));
}
