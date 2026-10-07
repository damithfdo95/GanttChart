import { useMemo } from 'react';
import type { AppRole } from '../../shared/tenancy';
import { useTenant } from './tenant-context';
import { useReportsStateCtx } from './state-contexts';
import type { RcsMember, TesterProjectAssignment } from '../types';
import { isAssignedIn } from '../../shared/testerRules';

/**
 * What each kind of person may do on each screen: ONE table, used for the navigation and for the screens' own
 * controls, and documented in docs/ADMINISTRATION.md. It only decides what the BROWSER offers; the Worker enforces the
 * same rules on every request and every commit (shared/testerRules.ts, worker/src/permissions.ts), so hiding a button is
 * never what protects data.
 *
 * Words: an SV is the internal role `admin`; a Tester is the internal role `user`. The Super Admin has no QA screens.
 */

export type UiRole = 'sv' | 'tester';

/** manage = change anything there; input = enter their own data only; view = read only; none = not offered. */
export type ScreenAccess = 'manage' | 'input' | 'view' | 'none';

export type ScreenId = 'dashboard' | 'cycles' | 'overall' | 'gantt' | 'dailyReport' | 'tickets' | 'performance' | 'review' | 'reports' | 'team' | 'history' | 'settings';

export const SCREEN_ACCESS: Readonly<Record<ScreenId, Readonly<Record<UiRole, ScreenAccess>>>> = {
  // A Tester sees the Operator section (and enters Today's Execution); the manager panels are the SV's.
  dashboard: { sv: 'manage', tester: 'input' },
  cycles: { sv: 'manage', tester: 'none' },
  overall: { sv: 'manage', tester: 'view' },
  gantt: { sv: 'manage', tester: 'view' },
  dailyReport: { sv: 'manage', tester: 'none' },
  // Everyone sees every ticket; a Tester raises tickets and changes only their own.
  tickets: { sv: 'manage', tester: 'input' },
  // A Tester enters their own performance rows.
  performance: { sv: 'manage', tester: 'input' },
  review: { sv: 'manage', tester: 'none' },
  reports: { sv: 'manage', tester: 'none' },
  // SV: Team Members management. Tester: "My Team Member Profile" only.
  team: { sv: 'manage', tester: 'view' },
  history: { sv: 'manage', tester: 'none' },
  settings: { sv: 'manage', tester: 'none' },
};

export function uiRoleOf(role: AppRole | null): UiRole | null {
  if (role === 'admin') return 'sv';
  if (role === 'user') return 'tester';
  return null;
}

/** The access one role has to one screen. Plain local use (no accounts at all) is a single person who may do everything. */
export function accessTo(role: AppRole | null, screen: ScreenId): ScreenAccess {
  if (role === 'super_admin') return 'none';
  const ui = uiRoleOf(role);
  if (ui === null) return screen === 'team' ? 'none' : 'manage';
  return SCREEN_ACCESS[screen][ui];
}

export interface Access {
  /** null = plain local use without accounts. */
  role: UiRole | null;
  isTester: boolean;
  isSv: boolean;
  /** May create and change project structure, plans, cycles, settings. True for an SV and for plain local use. */
  canManage: boolean;
  /** The Tester's own Team Member profile id (the roster entry linked to their account), or null. */
  ownMemberId: string | null;
  /** The person's own account id, or null. */
  userId: string | null;
  /** Is this person assigned to the project (by stable Project ID) today? An SV and plain local use always are. */
  canRecordFor(projectStableId: string | undefined, today: string): boolean;
}

/** Is this account assigned to the project right now (the same test the server applies to a Tester's Today's Execution)? */
export function assignedTo(assignments: readonly TesterProjectAssignment[], userId: string, projectStableId: string, today: string): boolean {
  return isAssignedIn(assignments as unknown as ReadonlyArray<Record<string, unknown>>, userId, projectStableId, today);
}

/** The member profile that belongs to this account (linked by the server, never guessed from names). */
export function ownMemberOf(members: readonly RcsMember[], userId: string | null): RcsMember | null {
  if (userId === null) return null;
  return members.find((m) => m.userId === userId) ?? null;
}

export function useAccess(): Access {
  const { principal } = useTenant();
  const reports = useReportsStateCtx();
  const members = reports.state.rcsMembers;
  const userId = principal?.userId ?? null;
  const role = uiRoleOf(principal?.role ?? null);
  const assignments = reports.state.testerAssignments;
  return useMemo(
    () => ({
      role,
      isTester: role === 'tester',
      isSv: role === 'sv',
      canManage: role !== 'tester',
      ownMemberId: ownMemberOf(members ?? [], userId)?.id ?? null,
      userId,
      canRecordFor: (projectStableId, today) => role !== 'tester' || (userId !== null && projectStableId !== undefined && assignedTo(assignments ?? [], userId, projectStableId, today)),
    }),
    [role, members, userId, assignments],
  );
}
