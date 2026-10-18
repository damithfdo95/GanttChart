/**
 * After a deploy, a tab opened before it still asks for screen files whose hashed names no longer
 * exist. Vite reports that as `vite:preloadError`; reloading once fetches the new build. The
 * guard stops a reload loop when the failure is something else (offline, server down): at most one
 * automatic reload per minute.
 */

const RELOAD_KEY = 'ganttchart.staleChunkReloadAt';
const MIN_GAP_MS = 60_000;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** True when a reload should happen now; records it so the next failure within a minute does not. */
export function shouldReloadForStaleChunk(store: KeyValueStore | null, nowMs: number): boolean {
  if (store === null) return false;
  try {
    const last = Number(store.getItem(RELOAD_KEY));
    if (Number.isFinite(last) && last > 0 && nowMs - last < MIN_GAP_MS) return false;
    store.setItem(RELOAD_KEY, String(nowMs));
    return true;
  } catch {
    return false; // storage blocked: never risk a reload loop
  }
}

export function installStaleChunkReload(): void {
  window.addEventListener('vite:preloadError', (event) => {
    let store: KeyValueStore | null = null;
    try {
      store = window.sessionStorage;
    } catch {
      store = null;
    }
    if (shouldReloadForStaleChunk(store, Date.now())) {
      event.preventDefault();
      window.location.reload();
    }
  });
}
