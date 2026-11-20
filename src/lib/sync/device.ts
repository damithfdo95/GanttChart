/**
 * Per-device sync storage (IndexedDB). Everything here stays on this
 * browser: the link marker, the offline mirror and the stash of edits that a
 * conflict replaced. Every access is wrapped — blocked/full storage must never
 * break the app.
 *
 * These values used to live in localStorage, but the mirror is the full
 * workspace snapshot and routinely exceeded the localStorage quota, so the
 * device was never remembered as linked. They now live in a dedicated
 * IndexedDB database (see deviceDb.ts).
 */

import type { PersistedMirror, StashedEdit } from './client';
import { kvDelete, kvGet, kvPut } from './deviceDb';

export const LINK_KEY = 'ganttchart.sync.link.v1';
export const MIRROR_KEY = 'ganttchart.sync.mirror.v1';
export const STASH_KEY = 'ganttchart.sync.conflicts.v1';
const MAX_STASH = 50;

export interface DeviceLink {
  origin: string;
  linkedAt: string;
  email: string;
  /** The workspace this device's copy belongs to. Absent on links made before workspaces existed (treated as foreign). */
  tenantId?: string;
}

export async function readLink(origin: string): Promise<DeviceLink | null> {
  const link = await kvGet<DeviceLink>(LINK_KEY);
  if (link === undefined || typeof link.origin !== 'string' || link.origin !== origin) return null; // a link is per server
  return link;
}

export async function writeLink(link: DeviceLink): Promise<boolean> {
  return kvPut(LINK_KEY, link);
}

export async function readMirror(): Promise<PersistedMirror | null> {
  const m = await kvGet<PersistedMirror>(MIRROR_KEY);
  if (m === undefined || typeof m.revision !== 'number' || typeof m.records !== 'object' || m.records === null) return null;
  return m;
}

export async function writeMirror(mirror: PersistedMirror): Promise<boolean> {
  return kvPut(MIRROR_KEY, mirror);
}

export async function readStash(): Promise<StashedEdit[]> {
  const s = await kvGet<StashedEdit[]>(STASH_KEY);
  return Array.isArray(s) ? s : [];
}

/** Newest last; capped so a long-running conflict cannot fill the storage. */
export async function appendStash(edit: StashedEdit): Promise<void> {
  const next = [...(await readStash()), edit].slice(-MAX_STASH);
  await kvPut(STASH_KEY, next);
}

export async function clearStash(): Promise<void> {
  await kvDelete(STASH_KEY);
}

/** Forget everything sync-related on this device (the shared workspace itself is untouched). */
export async function unlinkDevice(): Promise<void> {
  await kvDelete(LINK_KEY);
  await kvDelete(MIRROR_KEY);
  await kvDelete(STASH_KEY);
}
