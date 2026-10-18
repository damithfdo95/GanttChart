import { describe, expect, it } from 'vitest';
import { shouldReloadForStaleChunk } from '../app/staleChunk';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('shouldReloadForStaleChunk', () => {
  it('reloads once, then not again within a minute, then again after it', () => {
    const store = memory();
    expect(shouldReloadForStaleChunk(store, 1_000_000)).toBe(true);
    expect(shouldReloadForStaleChunk(store, 1_030_000)).toBe(false);
    expect(shouldReloadForStaleChunk(store, 1_060_001)).toBe(true);
  });

  it('never reloads when storage is unavailable or throws (no reload loops)', () => {
    expect(shouldReloadForStaleChunk(null, 1)).toBe(false);
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => undefined };
    expect(shouldReloadForStaleChunk(broken, 1)).toBe(false);
  });
});
