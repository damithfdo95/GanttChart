/**
 * First-run linking: how a browser that has never been connected to the shared
 * workspace is connected to it.
 *
 * This is deliberately a small PURE decision function so the rules that
 * protect people's data can be tested exhaustively:
 *
 *   server empty,  local fresh/demo   → create the shared workspace (starter project)
 *   server empty,  local has data     → ask: initialize it from this browser, or start fresh
 *   server data,   local fresh/demo   → adopt the shared workspace (nothing to lose)
 *   server data,   local has data     → ask. NEVER silently overwrite either side.
 *
 * Whole-workspace REPLACE is the only destructive choice: it needs an admin,
 * a typed confirmation, and is recoverable from the shared history.
 */

import type { ReportsState } from '../../types';
import type { RecordPut, Role } from '../../../shared/protocol';
import { countRecords, hasMeaningfulLocalData, reportsToRecords, type WorkspaceCounts } from './records';

export type LinkPlan =
  /** Nothing of value on this device: just take the shared workspace. */
  | { kind: 'adopt'; server: WorkspaceCounts }
  /** The shared workspace is empty and this device has nothing: create it with a starter project. */
  | { kind: 'create' }
  /** The shared workspace is empty but this device has real data: offer to initialize it from here. */
  | { kind: 'initialize'; local: WorkspaceCounts }
  /** Both sides have data: the user must choose. */
  | { kind: 'choose'; local: WorkspaceCounts; server: WorkspaceCounts; canReplace: boolean };

export function planLink(input: { local: ReportsState; serverRecords: readonly RecordPut[]; role: Role }): LinkPlan {
  // A server with only its settings record (or nothing) holds no user data.
  const serverCounts = countRecords(input.serverRecords);
  const serverHasData = input.serverRecords.some((r) => r.kind !== 'settings');
  const localHasData = hasMeaningfulLocalData(input.local);
  const localCounts = countRecords(reportsToRecords(input.local).values());

  if (!serverHasData) return localHasData ? { kind: 'initialize', local: localCounts } : { kind: 'create' };
  if (!localHasData) return { kind: 'adopt', server: serverCounts };
  return { kind: 'choose', local: localCounts, server: serverCounts, canReplace: input.role === 'admin' };
}

/** What the user picked on the link screen. */
export type LinkChoice =
  /** Take the shared workspace; this device's current data is replaced here (a backup file is downloaded first when it had data). */
  | 'use-shared'
  /** Keep this device's data AND the shared data: add what is missing, shared version wins on same-record clashes. */
  | 'merge'
  /** Make the shared workspace equal this device's data. Destructive for everyone; admin + typed confirmation. */
  | 'replace-shared'
  /** Fill the empty shared workspace from this device's data. */
  | 'initialize'
  /** Start the empty shared workspace fresh (starter project); this device's old data stays only in its backup/cache. */
  | 'start-fresh'
  /** Create the empty shared workspace with a starter project. */
  | 'create';

/** The exact text a person must type to replace the shared workspace. */
export const REPLACE_CONFIRMATION = 'REPLACE';

export type LinkValidation = { ok: true } | { ok: false; reason: 'role' | 'confirmation' | 'plan' };

/** Server-side-style guard run before ANY choice is executed (the UI also disables the buttons). */
export function validateLinkChoice(plan: LinkPlan, choice: LinkChoice, role: Role, typed?: string): LinkValidation {
  const allowed: Record<LinkPlan['kind'], LinkChoice[]> = {
    adopt: ['use-shared'],
    create: ['create'],
    initialize: ['initialize', 'start-fresh'],
    choose: ['use-shared', 'merge', 'replace-shared'],
  };
  if (!allowed[plan.kind].includes(choice)) return { ok: false, reason: 'plan' };
  if (role === 'viewer' && choice !== 'use-shared') return { ok: false, reason: 'role' }; // read-only people can only receive
  if (choice === 'replace-shared') {
    if (role !== 'admin') return { ok: false, reason: 'role' };
    if (typed !== REPLACE_CONFIRMATION) return { ok: false, reason: 'confirmation' };
  }
  return { ok: true };
}

/** How the sync client must treat the first server state for a choice. */
export function firstStateFor(choice: LinkChoice): 'apply' | 'overwrite' {
  return choice === 'replace-shared' ? 'overwrite' : 'apply';
}

/** Does this choice start from an EMPTY local state (so nothing local can leak into the shared workspace)? */
export function startsFromEmptyLocal(choice: LinkChoice): boolean {
  return choice === 'use-shared';
}

/** Choices that throw away this device's current data in this browser and so warrant a backup download first. */
export function needsLocalBackup(choice: LinkChoice, local: ReportsState): boolean {
  return (choice === 'use-shared' || choice === 'start-fresh') && hasMeaningfulLocalData(local);
}
