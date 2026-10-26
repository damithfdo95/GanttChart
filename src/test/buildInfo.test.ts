import { describe, expect, it } from 'vitest';
import { isTaggedRelease, type BuildInfo } from '../lib/buildInfo';
import { businessStamp } from '../../shared/businessTime';

/**
 * Build/release metadata (Settings → Release). The constants themselves come
 * from vite's `define` at compile time; only the pure helper is unit-tested.
 */

const info = (release: string): BuildInfo => ({ version: '0.10.0-pilot.2', commit: 'abc123def456', release, builtAt: '2026-10-21T09:30:00.000Z', channel: 'pilot' });

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

describe('businessStamp (Settings → Release built-at display, JST)', () => {
  it('renders an ISO/UTC instant as YYYY-MM-DD HH:mm in JST (UTC+9)', () => {
    expect(businessStamp('2026-10-21T09:30:00.000Z')).toBe('2026-10-21 18:30'); // 09:30Z → 18:30 JST
    expect(businessStamp('2026-10-21T15:59:00Z')).toBe('2026-10-22 00:59'); // crosses the JST calendar day
  });

  it('accepts a Date or epoch ms and formats the same way', () => {
    expect(businessStamp(new Date('2026-10-21T09:30:00.000Z'))).toBe('2026-10-21 18:30');
    expect(businessStamp(Date.parse('2026-10-21T09:30:00.000Z'))).toBe('2026-10-21 18:30');
  });

  it('degrades to an empty string on invalid input, never "Invalid Date"', () => {
    expect(businessStamp('not a date')).toBe('');
    expect(businessStamp(Number.NaN)).toBe('');
  });
});
