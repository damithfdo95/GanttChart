/**
 * How a signed-in session ends, in one place.
 *
 *  - 'logout'  the person chose to sign out: show the neutral "Signing out…" screen and leave for Access's logout.
 *  - 'expired' the sign-in ended on its own (an API call was refused as unauthenticated): show the PUBLIC page with a notice.
 *
 * Either way the application stops showing authenticated data at once; the device's own data is untouched.
 */

export type SessionEnd = 'logout' | 'expired';

export type LandingNotice = 'signInFailed' | 'sessionEnded' | 'logoutIncomplete' | null;

export type EndedPhase = { kind: 'signed-out' } | { kind: 'landing'; notice: LandingNotice };

export function phaseAfterEnd(end: SessionEnd): EndedPhase {
  return end === 'logout' ? { kind: 'signed-out' } : { kind: 'landing', notice: 'sessionEnded' };
}
