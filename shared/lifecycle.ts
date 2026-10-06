/**
 * The account lifecycle in ONE place.
 *
 * A workspace (tenant) and its accounts each have a small, explicit state, and every
 * change between states is a named event in a table. Nothing in the application is
 * allowed to change a state any other way, and nothing infers a state from scattered
 * flags.
 *
 *   Workspace (tenant)      active ──disable──► deactivated ("Disabled" in the UI)
 *                           deactivated ──reactivate──► active
 *                           active ──requestDeletion──► deletion_requested
 *                           deletion_requested ──cancelDeletion (Admin) / rejectDeletion (Super Admin)──► active
 *                           deletion_requested ──approveDeletion (Super Admin)──► deleting ──completeDeletion──► (removed)
 *
 *   Account (Admin / User)  active ◄──► disabled
 *
 * "Disabled" is NOT "deletion requested": disabling keeps everything and can be undone
 * at once; a deletion request is a separate, reviewed path to permanent removal.
 *
 * The stored word for a disabled workspace is `deactivated` (kept for existing data and
 * for API compatibility); the product calls it "Disabled". The stored account state
 * `invited` (created, never signed in) has no behaviour of its own — nobody is invited
 * by email — so it is presented as `active` (with "never signed in" visible through the
 * empty last-activity), and new accounts are created `active`.
 */

import type { TenantStatus, UserStatus } from './tenancy';

export type TenantEvent = 'disable' | 'reactivate' | 'requestDeletion' | 'cancelDeletion' | 'rejectDeletion' | 'approveDeletion' | 'completeDeletion';

type Next = TenantStatus | 'removed';

/** Every legal change of a workspace's state. Anything not listed is refused. */
export const TENANT_TRANSITIONS: Readonly<Record<TenantStatus, Readonly<Partial<Record<TenantEvent, Next>>>>> = {
  active: { disable: 'deactivated', requestDeletion: 'deletion_requested' },
  deactivated: { reactivate: 'active' },
  deletion_requested: { cancelDeletion: 'active', rejectDeletion: 'active', approveDeletion: 'deleting' },
  // Approving again is allowed: it is how an interrupted deletion is resumed.
  deleting: { approveDeletion: 'deleting', completeDeletion: 'removed' },
};

export function nextTenantState(from: TenantStatus, event: TenantEvent): Next | null {
  return TENANT_TRANSITIONS[from][event] ?? null;
}

/** The two account states the product knows. */
export type UserLifecycle = 'active' | 'disabled';

/** A stored `invited` account is an active one that has not signed in yet. */
export function userLifecycle(stored: UserStatus): UserLifecycle {
  return stored === 'disabled' ? 'disabled' : 'active';
}

/** May the people of a workspace in this state use it at all? (Collaboration additionally needs Web storage.) */
export function tenantAllowsAccess(status: TenantStatus): boolean {
  return status === 'active' || status === 'deletion_requested';
}
