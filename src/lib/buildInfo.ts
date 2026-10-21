/**
 * Build/release metadata (Settings → Release).
 *
 * The values are injected at compile time by vite.config.ts (`define`), so the
 * running app can answer "which build is this?" without any network request.
 * Outside a git checkout (e.g. an exported archive) the git fields are ''.
 *
 * Declared here (not in a global .d.ts) so every consumer imports one typed
 * module instead of relying on ambient globals.
 */

declare const __BUILD_VERSION__: string;
declare const __BUILD_COMMIT__: string;
declare const __BUILD_RELEASE__: string;
declare const __BUILD_DATE__: string;

export interface BuildInfo {
  /** package.json version at build time, e.g. "1.0.0". */
  version: string;
  /** Short commit hash of the built tree, e.g. "1a2b3c4d5e6f" ('' without git). */
  commit: string;
  /** `git describe --tags --always --dirty`, e.g. "v1.2.3" or "v1.2.3-4-g1a2b3c4-dirty". */
  release: string;
  /** Build timestamp (ISO 8601, UTC). */
  builtAt: string;
}

/** The single build-time snapshot; safe to import anywhere (plain constants). */
export const BUILD_INFO: BuildInfo = {
  version: __BUILD_VERSION__,
  commit: __BUILD_COMMIT__,
  release: __BUILD_RELEASE__,
  builtAt: __BUILD_DATE__,
};

/** True when the bundle was built from a git checkout with at least one tag. */
export function isTaggedRelease(info: BuildInfo = BUILD_INFO): boolean {
  // `git describe --always` falls back to a bare (hex) hash when no tag is
  // reachable; a real tag always starts with an optional "v" then a digit,
  // followed by a dot (v1.2.3, 1.2.3, v1.2.3-4-g1a2b3c4…).
  return /^v?\d+\./.test(info.release);
}
