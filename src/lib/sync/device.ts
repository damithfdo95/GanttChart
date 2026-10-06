/**
 * Per-device sync storage (localStorage). Everything here stays on this
 * browser: the link marker, the offline mirror and the stash of edits that a
 * conflict replaced. Every access is wrapped — blocked/full storage must never
 * break the app.
 */

import type { PersistedMirror, StashedEdit } from './client';

export const LINK_KEY = 'ganttchart.sync.link.v1';
export const MIRROR_KEY = 'ganttchart.sync.mirror.v1';
export const STASH_KEY = 'ganttchart.sync.conflicts.v1';
const MAX_STASH = 50;

export interface DeviceLink {
  origin: string;
  linkedAt: string;
  email: string;
}

function read<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function remove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* blocked storage */
  }
}

export function readLink(origin: string): DeviceLink | null {
  const link = read<DeviceLink>(LINK_KEY);
  if (link === null || typeof link.origin !== 'string' || link.origin !== origin) return null; // a link is per server
  return link;
}

export function writeLink(link: DeviceLink): boolean {
  return write(LINK_KEY, link);
}

export function readMirror(): PersistedMirror | null {
  const m = read<PersistedMirror>(MIRROR_KEY);
  if (m === null || typeof m.revision !== 'number' || typeof m.records !== 'object' || m.records === null) return null;
  return m;
}

export function writeMirror(mirror: PersistedMirror): boolean {
  return write(MIRROR_KEY, mirror);
}

export function readStash(): StashedEdit[] {
  const s = read<StashedEdit[]>(STASH_KEY);
  return Array.isArray(s) ? s : [];
}

/** Newest last; capped so a long-running conflict cannot fill the storage. */
export function appendStash(edit: StashedEdit): void {
  const next = [...readStash(), edit].slice(-MAX_STASH);
  write(STASH_KEY, next);
}

export function clearStash(): void {
  remove(STASH_KEY);
}

/** Forget everything sync-related on this device (the shared workspace itself is untouched). */
export function unlinkDevice(): void {
  remove(LINK_KEY);
  remove(MIRROR_KEY);
  remove(STASH_KEY);
}
