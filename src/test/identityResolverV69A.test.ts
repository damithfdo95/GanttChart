import { describe, expect, it } from 'vitest';
import type { RcsMember } from '../types';
import {
  attendanceIdentityKey,
  findMembersByHistoricalName,
  findMembersByName,
  getMemberDisplayName,
  getMemberIdentityLabel,
  reporterIdentityKey,
  resolveMemberIdentity,
  testerIdentityKey,
} from '../domain/members';

/**
 * V6.9-A §36 — the centralized identity resolver: current-name matching,
 * historical-name matching (through member name history), unmatched,
 * ambiguous (never guessed), whitespace normalization and the established
 * case-sensitivity rules.
 */

function member(overrides: Partial<RcsMember> = {}): RcsMember {
  return {
    id: 'USER0003',
    name: 'Yamauchi K.',
    team: 'RCS',
    role: 'Tester',
    startDate: '2026-07-01',
    active: true,
    ...overrides,
  };
}

describe('V6.9-A resolveMemberIdentity', () => {
  it('resolves a current name to the member id (matchedBy currentName)', () => {
    const members = [member()];
    expect(resolveMemberIdentity('Yamauchi K.', members)).toEqual({
      status: 'resolved',
      memberId: 'USER0003',
      matchedBy: 'currentName',
    });
  });

  it('resolves a historical name through the member name history (matchedBy nameHistory)', () => {
    const members = [member({ nameHistory: [{ name: 'Yamauchi Kentaro', fromDate: '2026-07-01', toDate: '2026-09-30' }] })];
    expect(resolveMemberIdentity('Yamauchi Kentaro', members)).toEqual({
      status: 'resolved',
      memberId: 'USER0003',
      matchedBy: 'nameHistory',
    });
  });

  it('returns unmatched for an unknown name', () => {
    const members = [member()];
    expect(resolveMemberIdentity('Unknown Person', members)).toEqual({
      status: 'unmatched',
      name: 'Unknown Person',
    });
  });

  it('returns ambiguous when the same historical name belongs to two members — never guesses', () => {
    const members = [
      member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] }),
      member({ id: 'USER0012', name: 'Yamauchi Kentaro', team: 'Other Team', role: 'Tester' }),
    ];
    expect(resolveMemberIdentity('Yamauchi Kentaro', members)).toEqual({
      status: 'ambiguous',
      name: 'Yamauchi Kentaro',
      candidateMemberIds: ['USER0003', 'USER0012'],
    });
  });

  it('trims whitespace before matching (both sides)', () => {
    const members = [
      member({ name: '  Yamauchi K.  ', nameHistory: [{ name: ' Yamauchi Kentaro ' }] }),
    ];
    expect(resolveMemberIdentity('  Yamauchi K. ', members)).toMatchObject({ status: 'resolved', memberId: 'USER0003' });
    expect(resolveMemberIdentity('  Yamauchi Kentaro ', members)).toMatchObject({ status: 'resolved', memberId: 'USER0003' });
  });

  it('follows the established comparison rules: exact (case-sensitive) match only', () => {
    const members = [member()];
    // V6.8 findUniqueMemberByName is exact after trimming; V6.9-A keeps it.
    expect(resolveMemberIdentity('yamauchi k.', members).status).toBe('unmatched');
    expect(resolveMemberIdentity('YAMAUCHI K.', members).status).toBe('unmatched');
  });

  it('resolves when the name matches one member through both current name and its own history', () => {
    const members = [member({ nameHistory: [{ name: 'Yamauchi K.' }] })];
    expect(resolveMemberIdentity('Yamauchi K.', members)).toEqual({
      status: 'resolved',
      memberId: 'USER0003',
      matchedBy: 'currentName',
    });
  });

  it('treats one member\'s current name colliding with another member\'s history as ambiguous', () => {
    const members = [
      member({ id: 'USER0010', name: 'Sato Hanako' }),
      member({ id: 'USER0011', name: 'Other Person', nameHistory: [{ name: 'Sato Hanako' }] }),
    ];
    expect(resolveMemberIdentity('Sato Hanako', members)).toMatchObject({
      status: 'ambiguous',
      candidateMemberIds: ['USER0010', 'USER0011'],
    });
  });

  it('matches an empty name to nothing', () => {
    expect(resolveMemberIdentity('', [member()])).toEqual({ status: 'unmatched', name: '' });
    expect(resolveMemberIdentity('   ', [member()])).toEqual({ status: 'unmatched', name: '' });
  });

  it('finds members by current and historical name', () => {
    const members = [
      member({ nameHistory: [{ name: 'Yamauchi Kentaro' }] }),
      member({ id: 'USER0004', name: 'Kobayashi Masashi' }),
    ];
    expect(findMembersByName(members, 'Yamauchi K.')).toHaveLength(1);
    expect(findMembersByHistoricalName(members, 'Yamauchi Kentaro')).toHaveLength(1);
    expect(findMembersByHistoricalName(members, 'Kobayashi Masashi')).toHaveLength(0);
  });
});

describe('V6.9-A identity keys use the same resolver', () => {
  const members = [
    member(),
    member({ id: 'USER0004', name: 'Kobayashi Masashi', nameHistory: [{ name: 'Kobayashi M.' }] }),
  ];

  it('testerIdentityKey: memberId first, then current/historical name resolution', () => {
    expect(testerIdentityKey({ memberId: 'USER0004', testerName: 'anything' }, members)).toBe('USER0004');
    expect(testerIdentityKey({ testerName: 'Yamauchi K.' }, members)).toBe('USER0003');
    expect(testerIdentityKey({ testerName: 'Kobayashi M.' }, members)).toBe('USER0004');
    expect(testerIdentityKey({ testerName: 'Legacy Person' }, members)).toBe('Legacy Person');
  });

  it('reporterIdentityKey: reporterMemberId first, then current/historical name resolution', () => {
    expect(reporterIdentityKey({ reporterMemberId: 'USER0003', reportedBy: 'anything' }, members)).toBe('USER0003');
    expect(reporterIdentityKey({ reportedBy: 'Yamauchi K.' }, members)).toBe('USER0003');
    expect(reporterIdentityKey({ reportedBy: 'Kobayashi M.' }, members)).toBe('USER0004');
    expect(reporterIdentityKey({ reportedBy: 'External Vendor' }, members)).toBe('External Vendor');
  });

  it('attendanceIdentityKey: memberId first, then name resolution', () => {
    expect(attendanceIdentityKey({ date: '2026-09-01', memberId: 'USER0003', memberName: 'x' }, members)).toBe('USER0003');
    expect(attendanceIdentityKey({ date: '2026-09-01', memberName: 'Kobayashi M.' }, members)).toBe('USER0004');
    expect(attendanceIdentityKey({ date: '2026-09-01', memberName: 'Visitor' }, members)).toBe('Visitor');
  });

  it('provides display helpers', () => {
    expect(getMemberDisplayName(members[0])).toBe('Yamauchi K.');
    expect(getMemberIdentityLabel(members[0])).toBe('USER0003 — Yamauchi K.');
  });
});
