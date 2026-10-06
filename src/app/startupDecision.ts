/**
 * Which screen does a signed-in person start on? A pure function of what the
 * server said about them and what this device remembers, so every branch is
 * unit-tested.
 *
 * The rules that matter:
 *  - Not signed in (no session) shows the PUBLIC page only. The page itself is public, so a device's
 *    saved copy is never opened for someone who has not signed in; they sign in first.
 *  - Denied is final: no offline copy is opened for a person the server refuses.
 *  - A Super Admin never gets a workspace, only the platform console.
 *  - A workspace stored locally (an Admin's local mode) runs the plain local app.
 *  - A device copy only counts for the SAME person in the SAME workspace. A copy
 *    that belongs to someone else (shared browser, moved between workspaces, or
 *    an old link that never recorded its workspace) is treated as foreign: the
 *    person is taken straight to the server's workspace and the foreign copy is
 *    never offered for merging — that would carry one workspace's data into
 *    another.
 */

import type { Identity } from '../../shared/protocol';
import type { DenyReason, PrincipalDto } from '../../shared/tenancy';
import type { ServerDetection } from '../lib/sync/serverMode';
import type { DeviceLink } from '../lib/sync/device';

export interface DeviceState {
  link: DeviceLink | null;
  hasMirror: boolean;
}

export type StartupDecision =
  | { kind: 'local' }
  /** Not signed in: the public page with the Sign In button (no data, no offline copy is opened). */
  | { kind: 'landing' }
  | { kind: 'denied'; reason: DenyReason; email: string }
  | { kind: 'super-admin'; principal: PrincipalDto }
  /** A tenant whose data lives in this browser (local storage mode). `clearDevice`: leftover sync state of an earlier web mode. */
  | { kind: 'local-tenant'; principal: PrincipalDto; clearDevice: boolean }
  /** Start from this device's own copy of the shared workspace and sync in the background. */
  | { kind: 'resume'; principal: PrincipalDto | null; identity: Identity }
  /** First time on this device: link, or (foreign copy) take the server's workspace without offering a merge. */
  | { kind: 'link'; principal: PrincipalDto; identity: Identity; foreignDevice: boolean }
  | { kind: 'problem'; problem: 'unreachable' | 'error'; status?: number };

/** The device copy belongs to exactly this person in exactly this workspace. */
export function deviceBelongsTo(device: DeviceState, principal: PrincipalDto): boolean {
  const link = device.link;
  if (link === null || !device.hasMirror || principal.tenant === null) return false;
  return link.tenantId === principal.tenant.id && link.email.toLowerCase() === principal.email.toLowerCase();
}

export function decideStartup(detection: ServerDetection, device: DeviceState): StartupDecision {
  switch (detection.mode) {
    case 'local':
      return { kind: 'local' };
    case 'denied':
      return { kind: 'denied', reason: detection.reason, email: detection.email };
    case 'error':
      return { kind: 'problem', problem: 'error', status: detection.status };
    case 'login-required':
      return { kind: 'landing' };
    case 'unreachable': {
      // Offline: a device that was linked keeps working from its own copy (the sync client reports it
      // and recovers). The server has not been able to say who this is, so only a copy that was
      // recorded as linked is used.
      if (device.link !== null && device.hasMirror && device.link.tenantId !== undefined) {
        return { kind: 'resume', principal: null, identity: { email: device.link.email, role: 'editor' } };
      }
      return { kind: 'problem', problem: 'unreachable' };
    }
    case 'server': {
      const { principal, identity } = detection;
      if (principal.role === 'super_admin') return { kind: 'super-admin', principal };
      if (identity === null || !principal.sharedWorkspace) {
        return { kind: 'local-tenant', principal, clearDevice: device.link !== null || device.hasMirror };
      }
      if (deviceBelongsTo(device, principal)) return { kind: 'resume', principal, identity };
      return { kind: 'link', principal, identity, foreignDevice: device.link !== null || device.hasMirror };
    }
  }
}
