/**
 * Corruption detection bookkeeping (V6.3 §22).
 *
 * When a persisted localStorage payload is invalid JSON or an invalid
 * schema, the raw payload is preserved under a recovery key BEFORE the
 * loader falls back to safe defaults — potentially recoverable data is
 * never silently destroyed. The loader records an event that the UI
 * consumes once at startup to show a recovery notice.
 */

export interface CorruptionEvent {
  /** The original localStorage key whose payload was unreadable. */
  key: string;
  /** The raw, unparsed payload exactly as read. */
  raw: string;
}

const RECOVERY_KEY_PREFIX = 'ganttchart.recovery.';

const events: CorruptionEvent[] = [];

/** Preserve an unreadable raw payload under a recovery key (best effort). */
export function stashCorruptedRaw(key: string, raw: string): void {
  try {
    window.localStorage.setItem(RECOVERY_KEY_PREFIX + key, raw);
  } catch {
    // The recovery stash is best effort; the app still falls back safely.
  }
  events.push({ key, raw });
}

/** True when a recovery payload is preserved for the given original key. */
export function hasRecoveryPayload(key: string): boolean {
  try {
    return window.localStorage.getItem(RECOVERY_KEY_PREFIX + key) !== null;
  } catch {
    return false;
  }
}

/** Take and clear the corruption events accumulated during load (UI consumes once). */
export function consumeCorruptionEvents(): CorruptionEvent[] {
  const consumed = events.slice();
  events.length = 0;
  return consumed;
}

/** True when unreadable data was detected during the current load (peek, V6.7 recovery states). */
export function hasCorruptionEvents(): boolean {
  return events.length > 0;
}

/** All localStorage keys managed by GanttChart (used by the full local reset). */
export const RECOVERY_KEY_PREFIX_EXPORT: string = RECOVERY_KEY_PREFIX;
