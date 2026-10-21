import { describe, expect, it } from 'vitest';
import { isTaggedRelease, type BuildInfo } from '../lib/buildInfo';

/**
 * Build/release metadata (Settings → Release). The constants themselves come
 * from vite's `define` at compile time; only the pure helper is unit-tested.
 */

const info = (release: string): BuildInfo => ({ version: '1.0.0', commit: 'abc123def456', release, builtAt: '2026-10-21T09:30:00.000Z' });

describe('buildInfo', () => {
  it('recognizes a tagged release (v-prefixed or plain semver)', () => {
    expect(isTaggedRelease(info('v1.2.3'))).toBe(true);
    expect(isTaggedRelease(info('1.2.3'))).toBe(true);
    expect(isTaggedRelease(info('v1.2.3-4-g1a2b3c4d5e6'))).toBe(true);
  });

  it('treats describe fallbacks as untagged development builds, but a dirty tag stays tagged', () => {
    expect(isTaggedRelease(info('1a2b3c4d5e6f'))).toBe(false); // --always fallback: bare hash
    expect(isTaggedRelease(info('v1.2.3-dirty'))).toBe(true); // tag found, tree just has local changes
    expect(isTaggedRelease(info(''))).toBe(false); // built outside a git checkout
  });
});
