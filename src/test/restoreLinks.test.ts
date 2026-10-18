import { describe, expect, it } from 'vitest';
import { sanitizeRestoredAccountLinks } from '../lib/backup/restoreLinks';
import { defaultReportsState } from '../lib/storage/reports';
import { ackId, type NotificationAck, type NotificationDef } from '../../shared/notifications';
import type { BrandingRecord, RcsMember, ReportsState, TesterProjectAssignment } from '../types';

const NOW = '2026-10-14T09:00:00.000Z';

const member = (id: string, name: string, over: Partial<RcsMember> = {}): RcsMember => ({
  id,
  name,
  team: 'RCS',
  role: 'Tester',
  startDate: '2026-07-01',
  active: true,
  ...over,
});
const assignment = (over: Partial<TesterProjectAssignment> = {}): TesterProjectAssignment => ({
  id: 'asg-1',
  projectId: 'PRJ-001',
  userId: 'usr_hana',
  memberId: 'USER0001',
  startDate: '2026-10-01',
  active: true,
  ...over,
});
const def = (over: Partial<NotificationDef> = {}): NotificationDef => ({
  id: 'ntf_11111111-2222-3333-4444-555555555555',
  title: 'Daily stand-up',
  message: '',
  recurrence: 'daily',
  time: '09:00',
  audience: { kind: 'all' },
  enabled: true,
  createdAt: NOW,
  updatedAt: NOW,
  createdByUserId: 'usr_other',
  updatedByUserId: 'usr_other',
  ...over,
});
const ack = (userId: string): NotificationAck => ({
  id: ackId('ntf_11111111-2222-3333-4444-555555555555', '2026-10-14T09:00', userId),
  notificationId: 'ntf_11111111-2222-3333-4444-555555555555',
  occurrence: '2026-10-14T09:00',
  userId,
  at: NOW,
});

const state = (over: Partial<ReportsState> = {}): ReportsState => ({
  ...defaultReportsState(),
  ...over,
});

describe('sanitizeRestoredAccountLinks — the actor parameter', () => {
  it('a missing actor (undefined, null and empty string alike) stamps nothing and changes no account decision', () => {
    const current = state({
      rcsMembers: [member('USER0001', 'Hana Sato', { userId: 'usr_hana', email: 'hana@rakuten.com' })],
    });
    const file = state({
      rcsMembers: [member('USER0001', 'Hana', { userId: 'usr_FOREIGN' })],
      notifications: [def()],
      brandings: [{ id: 'branding', mime: 'image/png', data: 'iVBORw0KGgo=', bytes: 8, updatedAt: NOW, updatedByUserId: 'usr_other' }],
    });
    for (const actor of [undefined, null, ''] as const) {
      const out = sanitizeRestoredAccountLinks(file, current, actor);
      // The member link is the workspace's own, unaffected by the actor.
      expect(out.rcsMembers![0].userId).toBe('usr_hana');
      // Attribution of a new definition and the logo stays as the file had it.
      expect(out.notifications![0].createdByUserId).toBe('usr_other');
      expect(out.brandings![0].updatedByUserId).toBe('usr_other');
    }
  });

  it('a present actor attributes NEW notification definitions and the logo to the restorer', () => {
    const out = sanitizeRestoredAccountLinks(
      state({
        notifications: [def()],
        brandings: [{ id: 'branding', mime: 'image/png', data: 'iVBORw0KGgo=', bytes: 8, updatedAt: NOW, updatedByUserId: 'usr_other' }],
      }),
      state(),
      'usr_me',
    );
    expect(out.notifications![0]).toMatchObject({ createdByUserId: 'usr_me', updatedByUserId: 'usr_me' });
    expect(out.brandings![0].updatedByUserId).toBe('usr_me');
  });

  it('a definition the workspace already has stays exactly as the workspace has it, whatever the actor', () => {
    const same = def();
    const current = state({ notifications: [same] });
    const file = state({ notifications: [def({ title: 'From the file' })] });
    const out = sanitizeRestoredAccountLinks(file, current, 'usr_me');
    expect(out.notifications).toEqual([same]);
  });

  it('a new members-audience is filtered to the people of the restored workspace; one that reaches nobody is dropped', () => {
    const file = state({
      rcsMembers: [member('USER0001', 'Hana')],
      notifications: [
        def({ id: 'ntf_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', audience: { kind: 'members', memberIds: ['USER0001', 'USER0777'] } }),
        def({ id: 'ntf_99999999-8888-7777-6666-555555555555', audience: { kind: 'members', memberIds: ['USER0777'] } }),
      ],
    });
    const out = sanitizeRestoredAccountLinks(file, state(), 'usr_me');
    expect(out.notifications).toHaveLength(1);
    expect(out.notifications![0].audience).toEqual({ kind: 'members', memberIds: ['USER0001'] });
  });

  it('the actor never widens assignment accounts: an assignment keeps its userId only when the account is a member of this workspace', () => {
    const current = state({
      rcsMembers: [member('USER0001', 'Hana Sato', { userId: 'usr_hana' })],
    });
    const file = state({
      testerAssignments: [assignment({ userId: 'usr_hana' }), assignment({ id: 'asg-2', userId: 'usr_somebody_else' })],
    });
    // The actor is a THIRD account: neither assignment belongs to them.
    const out = sanitizeRestoredAccountLinks(file, current, 'usr_third');
    expect(out.testerAssignments![0].userId).toBe('usr_hana');
    expect(out.testerAssignments![1].userId).toBeUndefined();
    expect(out.testerAssignments![1]).toMatchObject({ memberId: 'USER0001', projectId: 'PRJ-001', active: true });
  });

  it('an actor who is not linked in this workspace validates no account', () => {
    const file = state({
      testerAssignments: [assignment({ userId: 'usr_actor' })],
      notifications: [def()],
    });
    const out = sanitizeRestoredAccountLinks(file, state(), 'usr_actor');
    expect(out.testerAssignments![0].userId).toBeUndefined();
    // The definition is still stamped — attribution is presentation, not an account link.
    expect(out.notifications![0].createdByUserId).toBe('usr_actor');
  });
});

describe('sanitizeRestoredAccountLinks — unlinked (Local) workspaces', () => {
  it('every account link in the file is dropped when the workspace has no logins', () => {
    const file = state({
      rcsMembers: [member('USER0001', 'Hana', { userId: 'usr_hana' })],
      testerAssignments: [assignment()],
    });
    const out = sanitizeRestoredAccountLinks(file, state());
    expect(out.rcsMembers![0].userId).toBeUndefined();
    expect(out.testerAssignments![0].userId).toBeUndefined();
  });
});

describe('sanitizeRestoredAccountLinks — members and emails', () => {
  const current = state({
    rcsMembers: [
      member('USER0001', 'Hana Sato', { userId: 'usr_hana', email: 'hana@rakuten.com' }),
      member('USER0002', 'Taro Tanaka', { email: 'taro@rakuten.com' }),
    ],
  });

  it('a mismatched id (a person the workspace does not have) never adopts the file\'s link or email-colliding claim', () => {
    const file = state({ rcsMembers: [member('USER0009', 'Newcomer', { userId: 'usr_SNEAKY', email: 'hana@rakuten.com' })] });
    const out = sanitizeRestoredAccountLinks(file, current).rcsMembers!;
    expect(out[0].userId).toBeUndefined();
    expect(out[0].email).toBeUndefined();
  });

  it('duplicate emails inside the file are resolved deterministically (first in file order wins)', () => {
    const file = state({
      rcsMembers: [member('USER0009', 'First', { email: 'fresh@rakuten.com' }), member('USER0010', 'Second', { email: 'fresh@rakuten.com' })],
    });
    const out = sanitizeRestoredAccountLinks(file, current).rcsMembers!;
    expect(out.find((m) => m.id === 'USER0009')!.email).toBe('fresh@rakuten.com');
    expect(out.find((m) => m.id === 'USER0010')!.email).toBeUndefined();
  });

  it('a workspace member missing from the file is kept with their link; a present one keeps the workspace\'s account state', () => {
    const file = state({ rcsMembers: [member('USER0001', 'Hana (old file)', { userId: 'usr_FOREIGN', email: 'other@x.com', role: 'SV', active: false })] });
    const out = sanitizeRestoredAccountLinks(file, current).rcsMembers!;
    const hana = out.find((m) => m.id === 'USER0001')!;
    expect(hana).toMatchObject({ name: 'Hana (old file)', userId: 'usr_hana', email: 'hana@rakuten.com', role: 'Tester', active: true });
    const taro = out.find((m) => m.id === 'USER0002')!;
    expect(taro).toMatchObject({ email: 'taro@rakuten.com' });
  });
});

describe('sanitizeRestoredAccountLinks — valid existing assignments', () => {
  it('an assignment keeps its account when that account is a member here, and keeps its business fields either way', () => {
    const current = state({
      rcsMembers: [member('USER0001', 'Hana Sato', { userId: 'usr_hana' })],
      testerAssignments: [assignment()],
    });
    const file = state({
      testerAssignments: [assignment({ scopeId: 'scp_a' }), assignment({ id: 'asg-2', userId: 'usr_FOREIGN', memberId: 'USER0002', scopeId: 'scp_a' })],
    });
    const out = sanitizeRestoredAccountLinks(file, current).testerAssignments!;
    expect(out[0].userId).toBe('usr_hana');
    expect(out[0].scopeId).toBe('scp_a');
    expect(out[1].userId).toBeUndefined();
    expect(out[1]).toMatchObject({ memberId: 'USER0002', projectId: 'PRJ-001', active: true });
  });
});

describe('sanitizeRestoredAccountLinks — acknowledgments', () => {
  it('the file\'s acknowledgments are ignored and the workspace\'s own stay', () => {
    const file = state({ notificationAcks: [ack('usr_forged')] });
    const current = state({ notificationAcks: [ack('usr_real')] });
    expect(sanitizeRestoredAccountLinks(file, current, 'usr_me').notificationAcks).toEqual([ack('usr_real')]);
    expect(sanitizeRestoredAccountLinks(file, state(), 'usr_me').notificationAcks).toEqual([]);
  });
});

describe('sanitizeRestoredAccountLinks — untouched state', () => {
  it('business collections other than the link-sensitive ones pass through unchanged', () => {
    const file = state({ notifications: [def()], dailyPlans: [{ id: 'dp_2026-10-14_PRJ-001_all', date: '2026-10-14', projectId: 'PRJ-001', plannedCases: 10, createdAt: NOW, updatedAt: NOW }] });
    const out = sanitizeRestoredAccountLinks(file, state(), null);
    expect(out.dailyPlans).toEqual(file.dailyPlans);
    expect(out.projects).toEqual(file.projects);
  });

  it('a workspace identical to the file keeps its own members as they are', () => {
    const linked = member('USER0001', 'Hana Sato', { userId: 'usr_hana', email: 'hana@rakuten.com' });
    const same = state({ rcsMembers: [linked] });
    const out = sanitizeRestoredAccountLinks(same, same, 'usr_me');
    expect(out.rcsMembers).toEqual([linked]);
  });
});

describe('sanitizeRestoredAccountLinks — branding type', () => {
  it('branding passes through as the file has it: absent when absent, attributed to the restorer when present', () => {
    // defaultReportsState() carries brandings: [] — an empty file list stays an empty list.
    expect(sanitizeRestoredAccountLinks(state(), state(), 'usr_me').brandings).toEqual([]);
    const file = { ...state() } as ReportsState;
    delete (file as Partial<ReportsState>).brandings;
    expect(sanitizeRestoredAccountLinks(file, state(), 'usr_me').brandings).toBeUndefined();
    const branded: BrandingRecord = { id: 'branding', mime: 'image/png', data: 'iVBORw0KGgo=', bytes: 8, updatedAt: NOW, updatedByUserId: 'usr_x' };
    expect(sanitizeRestoredAccountLinks(state({ brandings: [branded] }), state(), null).brandings).toEqual([branded]);
    expect(sanitizeRestoredAccountLinks(state({ brandings: [branded] }), state(), 'usr_me').brandings![0].updatedByUserId).toBe('usr_me');
  });
});
