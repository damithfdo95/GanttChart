/**
 * Tenant-scoped API routes: everything under /api/tenant, /api/export, /api/stats
 * and /api/revisions, plus the storage-mode migration routes. The tenant is
 * ALWAYS the verified principal's — never a client-supplied value.
 */

import { businessDate } from '../../../shared/businessTime';
import { accountRoleOf, memberRoleOf, memberRoleWord } from '../../../shared/members';
import { parseNotificationInput } from '../../../shared/notifications';
import { isRecordKind, type RecordKind } from '../../../shared/protocol';
import {
  CLOSE_CODES,
  REPLACE_CONFIRMATION,
  REQUEST_DELETION_CONFIRMATION,
  TRANSFER_OWNERSHIP_CONFIRMATION,
  SWITCH_TO_LOCAL_CONFIRMATION,
  canonicalRecordsHash,
  isUserId,
  normalizeEmail,
  parseDisplayName,
  type UserAccess,
} from '../../../shared/tenancy';
import { actorOf, json, member, memberProblem, need, notificationProblem, problem, readJson, registryProblem, revisionParam, roomFor, type Ctx } from '../http';
import { workspaceRoleOf, type MemberPrincipal } from '../permissions';
import { isDateString } from '../../../shared/notifications';

export async function tenantRoutes(ctx: Ctx): Promise<Response | null> {
  const { path, method, url } = ctx;
  const isRead = method === 'GET';
  const p = member(ctx);

  // Tenant-scoped routes exist for members only.
  const tenantPath = path === '/api/tenant' || path.startsWith('/api/tenant/') || path === '/api/export' || path === '/api/stats' || path === '/api/revisions' || path.startsWith('/api/revisions/');
  if (!tenantPath) return null;
  if (p === null) return problem(403, 'forbidden', { reason: 'role' }); // a Super Admin has no tenant

  if (path === '/api/tenant' && isRead) {
    const denial = need(ctx, 'tenant.view');
    if (denial !== null) return denial;
    return json({ tenant: await ctx.registry.getTenant(p.tenantId) });
  }

  // ---- shared workspace data (web mode) ----
  if (path === '/api/export' && isRead) {
    const denial = need(ctx, 'data.read');
    if (denial !== null) return denial;
    const snap = await roomFor(ctx, p).exportAll(p.tenantId, workspaceRoleOf(p) ?? 'viewer', p.userId);
    return json({ ...snap, hash: await canonicalRecordsHash(snap.records) });
  }

  if (path === '/api/stats' && isRead) {
    const denial = need(ctx, 'data.restore');
    if (denial !== null) return denial;
    return json(await roomFor(ctx, p).stats(p.tenantId));
  }

  if (path === '/api/revisions' && isRead) {
    const denial = need(ctx, 'history.read'); // SV only
    if (denial !== null) return denial;
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));
    const beforeRaw = url.searchParams.get('before');
    const before = beforeRaw === null ? undefined : (revisionParam(beforeRaw) ?? undefined);
    // Optional narrowing (all applied by the server, so a page is a page of the filtered list). Bad values are refused, never ignored.
    const filter: { kind?: RecordKind; actor?: string; from?: string; to?: string } = {};
    const kind = url.searchParams.get('kind');
    if (kind !== null && kind !== '') {
      if (!isRecordKind(kind)) return problem(400, 'invalid_kind');
      filter.kind = kind;
    }
    const actor = url.searchParams.get('actor');
    if (actor !== null && actor !== '') {
      if (actor.length > 254 || /[\u0000-\u001f]/.test(actor)) return problem(400, 'invalid_actor');
      filter.actor = actor;
    }
    // Dates are business-time (Asia/Tokyo, UTC+9, no daylight saving) calendar days: [from 00:00, to + 1 day 00:00).
    const dayStart = (date: string): string => new Date(Date.parse(`${date}T00:00:00+09:00`)).toISOString();
    const from = url.searchParams.get('from');
    if (from !== null && from !== '') {
      if (!isDateString(from)) return problem(400, 'invalid_date');
      filter.from = dayStart(from);
    }
    const to = url.searchParams.get('to');
    if (to !== null && to !== '') {
      if (!isDateString(to)) return problem(400, 'invalid_date');
      filter.to = new Date(Date.parse(dayStart(to)) + 86_400_000).toISOString();
    }
    return json(await roomFor(ctx, p).listRevisions(p.tenantId, limit, before, filter));
  }

  const rev = /^\/api\/revisions\/([^/]+)(\/restore)?$/.exec(path);
  if (rev !== null) {
    const revision = revisionParam(rev[1] ?? '');
    if (revision === null) return problem(400, 'Invalid revision');
    if (rev[2] === undefined && isRead) {
      const denial = need(ctx, 'history.read');
      if (denial !== null) return denial;
      const records = await roomFor(ctx, p).previewRevision(p.tenantId, revision);
      return records === null ? problem(404, 'Revision not available') : json({ revision, records });
    }
    if (rev[2] === '/restore' && method === 'POST') {
      const denial = need(ctx, 'data.restore');
      if (denial !== null) return denial;
      const body = await readJson(ctx); // not used, but a forged tenant in it is rejected like everywhere else
      if (!body.ok) return body.response;
      const result = await roomFor(ctx, p).restoreRevision(p.tenantId, revision, p.email);
      return result.ok ? json(result) : problem(409, result.error);
    }
  }

  // ---- users (Admin of a web workspace) ----
  if (path === '/api/tenant/users' && isRead) {
    const denial = need(ctx, 'users.manage');
    if (denial !== null) return denial;
    return json({ users: await ctx.registry.listUsers(p.tenantId) });
  }

  // ---- Scheduled notifications (SV administers; everybody closes their own) -----------------------

  if (path === '/api/tenant/notifications' && method === 'POST') {
    const denial = need(ctx, 'notifications.manage');
    if (denial !== null) return denial;
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    const fields = parseNotificationInput(body.body);
    if (!fields.ok) return problem(400, fields.error);
    const saved = await roomFor(ctx, p).saveNotification(p.tenantId, { fields: fields.value, actor: { userId: p.userId, email: p.email } });
    if (!saved.ok) return notificationProblem(saved.error);
    await ctx.registry.recordMemberEvent({ tenantId: p.tenantId, action: 'notification.created', actor: actorOf(p), meta: { title: fields.value.title, recurrence: fields.value.recurrence } });
    return json({ id: saved.id }, 201);
  }

  const notificationRoute = /^\/api\/tenant\/notifications\/([^/]+)(?:\/(ack))?$/.exec(path);
  if (notificationRoute !== null) {
    const id = decodeURIComponent(notificationRoute[1] ?? '');
    if (!/^ntf_[A-Za-z0-9_.:-]{1,190}$/.test(id)) return problem(400, 'invalid_notification_id');
    if (notificationRoute[2] === 'ack' && method === 'POST') {
      const denial = need(ctx, 'notifications.ack');
      if (denial !== null) return denial;
      const body = await readJson(ctx);
      if (!body.ok) return body.response;
      if (typeof body.body.occurrence !== 'string') return problem(400, 'invalid_occurrence');
      // The person is the verified caller; the clock is the server's (a development header may move it, never in production).
      const devNow = ctx.env.ENVIRONMENT === 'development' ? Number(ctx.request.headers.get('x-dev-now')) : NaN;
      const nowMs = Number.isFinite(devNow) && devNow > 0 ? devNow : Date.now();
      const done = await roomFor(ctx, p).acknowledgeNotification(p.tenantId, { userId: p.userId, role: workspaceRoleOf(p) ?? 'viewer', notificationId: id, occurrence: body.body.occurrence, nowMs, email: p.email });
      return done.ok ? json({ created: done.created }) : notificationProblem(done.error);
    }
    if (notificationRoute[2] === undefined && method === 'PATCH') {
      const denial = need(ctx, 'notifications.manage');
      if (denial !== null) return denial;
      const body = await readJson(ctx);
      if (!body.ok) return body.response;
      const fields = parseNotificationInput(body.body);
      if (!fields.ok) return problem(400, fields.error);
      const saved = await roomFor(ctx, p).saveNotification(p.tenantId, { id, fields: fields.value, actor: { userId: p.userId, email: p.email } });
      if (!saved.ok) return notificationProblem(saved.error);
      await ctx.registry.recordMemberEvent({ tenantId: p.tenantId, action: `notification.${saved.action}`, actor: actorOf(p), meta: { title: fields.value.title, recurrence: fields.value.recurrence } });
      return json({ id: saved.id, action: saved.action });
    }
    if (notificationRoute[2] === undefined && method === 'DELETE') {
      const denial = need(ctx, 'notifications.manage');
      if (denial !== null) return denial;
      const gone = await roomFor(ctx, p).deleteNotification(p.tenantId, { id, actor: { email: p.email } });
      if (!gone.ok) return notificationProblem(gone.error);
      await ctx.registry.recordMemberEvent({ tenantId: p.tenantId, action: 'notification.deleted', actor: actorOf(p), meta: { title: gone.title } });
      return json({ deleted: true });
    }
  }

  // ---- Workspace logo (SV) ---------------------------------------------------------------

  if (path === '/api/tenant/branding' && method === 'PUT') {
    const denial = need(ctx, 'branding.manage');
    if (denial !== null) return denial;
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    const set = await roomFor(ctx, p).setBranding(p.tenantId, { mime: String(body.body.mime ?? ''), data: String(body.body.data ?? ''), actor: { userId: p.userId, email: p.email } });
    if (!set.ok) return problem(set.error === 'logo_too_large' ? 413 : 400, set.error);
    await ctx.registry.recordMemberEvent({ tenantId: p.tenantId, action: 'branding.updated', actor: actorOf(p), meta: { bytes: set.bytes } });
    return json({ bytes: set.bytes });
  }
  if (path === '/api/tenant/branding' && method === 'DELETE') {
    const denial = need(ctx, 'branding.manage');
    if (denial !== null) return denial;
    const gone = await roomFor(ctx, p).removeBranding(p.tenantId, { actor: { email: p.email } });
    if (!gone.ok) return problem(409, gone.error);
    if (gone.removed) await ctx.registry.recordMemberEvent({ tenantId: p.tenantId, action: 'branding.removed', actor: actorOf(p) });
    return json({ removed: gone.removed });
  }

  // ---- Housekeeping of meeting history (an SV opening Meeting History; at most once a business day) ----
  if (path === '/api/tenant/retention' && method === 'POST') {
    const denial = need(ctx, 'maintenance.run');
    if (denial !== null) return denial;
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    return json(await roomFor(ctx, p).runRetention(p.tenantId));
  }

  // ---- Team Members: profiles (the people directory) and the accounts linked to them ----
  //
  // A profile is a person of this workspace; an account is a login identity. They are separate: a profile may have no account, and
  // an SV decides every link. Nothing here ever links by display name; the tenant is always the principal's.

  if (path === '/api/tenant/users' && method === 'POST') {
    const denial = need(ctx, 'users.manage');
    if (denial !== null) return denial;
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    const access = (body.body.access ?? 'editor') as UserAccess;
    // The only roles a member can be created with. The words are the product's (SV / Tester), never the internal ones.
    const wanted = body.body.role === undefined ? 'tester' : body.body.role;
    if (wanted !== 'sv' && wanted !== 'tester') return problem(400, 'invalid_role');
    // Someone who is already in the directory (same normalised email) is LINKED, never duplicated; a removed profile must be reactivated first.
    const wantedEmail = normalizeEmail(body.body.email);
    if (wantedEmail !== null) {
      const same = (await roomFor(ctx, p).listMembers(p.tenantId)).find((m) => m.email === wantedEmail);
      // (a profile that already has an account makes the registry answer email_taken, as before)
      if (same !== undefined && !same.active && same.userId === undefined) return problem(409, 'member_removed');
    }
    const result = await ctx.registry.createUser({
      tenantId: p.tenantId, // from the principal, never from the body
      email: String(body.body.email ?? ''),
      displayName: body.body.displayName,
      role: wanted === 'sv' ? 'admin' : 'user',
      access,
      reserved: ctx.superAdmins,
      actor: actorOf(p), // from the principal, never from the body
    });
    if (!result.ok) return registryProblem(result.error);
    // The account's Team Member profile (the roster entry attendance, performance and tickets refer to): an existing one with this email, else a new one.
    let profile: 'created' | 'linked' | 'existing' | 'failed' = 'failed';
    let memberId: string | null = null;
    try {
      const made = await roomFor(ctx, p).ensureMemberProfile(p.tenantId, {
        userId: result.value.id,
        name: result.value.displayName ?? result.value.email,
        email: result.value.email,
        role: result.value.role === 'admin' ? 'SV' : 'Tester',
        today: businessDate(),
        actor: p.email,
      });
      if (made.ok) {
        profile = made.linked ? 'linked' : made.created ? 'created' : 'existing';
        memberId = made.memberId;
        if (made.linked) await ctx.registry.recordMemberEvent({ tenantId: p.tenantId, action: 'member.account_linked', actor: actorOf(p), userId: result.value.id, meta: { how: 'email' } });
      }
    } catch {
      profile = 'failed'; // the account exists; an SV can link a roster entry to it from Team Members
    }
    return json({ user: result.value, profile, memberId }, 201);
  }

  // Create a Team Member PROFILE, with or without a login account.
  if (path === '/api/tenant/members' && method === 'POST') {
    const denial = need(ctx, 'users.manage');
    if (denial !== null) return denial;
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    const name = parseDisplayName(body.body.displayName);
    if (!name.ok || name.value === null) return problem(400, 'invalid_display_name');
    const wanted = body.body.role === undefined ? 'tester' : body.body.role;
    if (wanted !== 'sv' && wanted !== 'tester') return problem(400, 'invalid_role');
    let email: string | undefined;
    if (body.body.email !== undefined && body.body.email !== null && String(body.body.email).trim() !== '') {
      const e = normalizeEmail(body.body.email);
      if (e === null) return problem(400, 'invalid_email');
      email = e;
    }
    const withAccount = body.body.createAccount === true;
    if (withAccount && email === undefined) return problem(400, 'email_required_for_account');
    const access = (body.body.access ?? 'editor') as UserAccess;
    const roleWord = wanted === 'sv' ? 'SV' : 'Tester';
    const room = roomFor(ctx, p);
    const made = await room.createMemberProfile(p.tenantId, { name: name.value, ...(email === undefined ? {} : { email }), role: roleWord, today: businessDate(), actor: p.email });
    if (!made.ok) return memberProblem(made.error);
    await ctx.registry.recordMemberEvent({ tenantId: p.tenantId, action: 'member.created', actor: actorOf(p), meta: { name: name.value, memberRole: wanted, withAccount } });
    if (!withAccount) return json({ memberId: made.memberId, user: null }, 201);
    const account = await ctx.registry.createUser({ tenantId: p.tenantId, email: email as string, displayName: name.value, role: wanted === 'sv' ? 'admin' : 'user', access, reserved: ctx.superAdmins, actor: actorOf(p) });
    if (!account.ok) {
      await room.discardMemberProfile(p.tenantId, made.memberId, p.email); // nothing refers to it yet
      return registryProblem(account.error);
    }
    const linked = await room.linkMember(p.tenantId, { memberId: made.memberId, userId: account.value.id, email: account.value.email, role: roleWord, actor: p.email });
    if (linked.ok) await ctx.registry.recordMemberEvent({ tenantId: p.tenantId, action: 'member.account_linked', actor: actorOf(p), userId: account.value.id, meta: { how: 'created', name: name.value } });
    return json({ memberId: made.memberId, user: account.value, linked: linked.ok }, 201);
  }

  // Link an existing profile to an existing account of this workspace (an SV's decision; never guessed from names).
  if (path === '/api/tenant/members/link' && method === 'POST') {
    const denial = need(ctx, 'users.manage');
    if (denial !== null) return denial;
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    const memberId = body.body.memberId;
    const userId = body.body.userId;
    if (typeof memberId !== 'string' || memberId.length === 0 || memberId.length > 100) return problem(400, 'invalid_member_id');
    if (!isUserId(userId)) return problem(400, 'invalid_user_id');
    const account = await ctx.registry.getUser(p.tenantId, userId);
    if (account === null) return problem(404, 'user_not_found');
    const linked = await roomFor(ctx, p).linkMember(p.tenantId, { memberId, userId, email: account.email, role: account.role === 'admin' ? 'SV' : 'Tester', actor: p.email });
    if (!linked.ok) return memberProblem(linked.error);
    if (linked.created) await ctx.registry.recordMemberEvent({ tenantId: p.tenantId, action: 'member.account_linked', actor: actorOf(p), userId, meta: { how: 'existing', assignments: linked.assignments } });
    return json(linked);
  }

  // Give ONE account of this workspace its Team Member profile (an SV's explicit choice, for accounts that predate profiles).
  if (path === '/api/tenant/members/profile' && method === 'POST') {
    const denial = need(ctx, 'users.manage');
    if (denial !== null) return denial;
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    if (!isUserId(body.body.userId)) return problem(400, 'invalid_user_id');
    const account = await ctx.registry.getUser(p.tenantId, body.body.userId);
    if (account === null) return problem(404, 'user_not_found');
    const made = await roomFor(ctx, p).ensureMemberProfile(p.tenantId, {
      userId: account.id,
      name: account.displayName ?? account.email,
      email: account.email,
      role: account.role === 'admin' ? 'SV' : 'Tester',
      today: businessDate(),
      actor: p.email,
    });
    if (!made.ok) return memberProblem(made.error);
    if (made.created) await ctx.registry.recordMemberEvent({ tenantId: p.tenantId, action: 'member.created', actor: actorOf(p), userId: account.id, meta: { name: account.displayName ?? account.email, memberRole: account.role === 'admin' ? 'sv' : 'tester', withAccount: true } });
    if (made.linked) await ctx.registry.recordMemberEvent({ tenantId: p.tenantId, action: 'member.account_linked', actor: actorOf(p), userId: account.id, meta: { how: 'email' } });
    return json(made, made.created ? 201 : 200);
  }

  const memberRoute = /^\/api\/tenant\/members\/([^/]+)(?:\/(account|role|remove|reactivate))?$/.exec(path);
  if (memberRoute !== null && memberRoute[1] !== 'link' && memberRoute[1] !== 'profile') {
    const memberId = decodeURIComponent(memberRoute[1] ?? '');
    const action = memberRoute[2];
    const denial = need(ctx, 'users.manage');
    if (denial !== null) return denial;
    if (memberId.length === 0 || memberId.length > 100) return problem(400, 'invalid_member_id');
    // The body (and any tenant the request tries to name) is checked before anything is looked up.
    const parsed = await readJson(ctx);
    if (!parsed.ok) return parsed.response;
    const room = roomFor(ctx, p);
    const found = await room.readMember(p.tenantId, memberId); // another workspace's id is simply unknown here
    if (found === null) return problem(404, 'member_not_found');
    const actor = actorOf(p);

    // Edit the profile: display name, team and (while there is no account) the email.
    if (action === undefined && method === 'PATCH') {
      const body = parsed;
      const input: { name?: string; team?: string; email?: string | null; startDate?: string; endDate?: string | null; nameHistory?: Array<{ name: string; fromDate?: string; toDate?: string }> } = {};
      const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
      if (body.body.startDate !== undefined) {
        if (!isDate(body.body.startDate)) return problem(400, 'invalid_date');
        input.startDate = body.body.startDate;
      }
      if (body.body.endDate !== undefined) {
        if (body.body.endDate !== null && !isDate(body.body.endDate)) return problem(400, 'invalid_date');
        input.endDate = body.body.endDate;
      }
      if (body.body.nameHistory !== undefined) {
        if (!Array.isArray(body.body.nameHistory) || body.body.nameHistory.length > 20) return problem(400, 'invalid_name_history');
        const history: Array<{ name: string; fromDate?: string; toDate?: string }> = [];
        for (const e of body.body.nameHistory as unknown[]) {
          const o = typeof e === 'object' && e !== null ? (e as Record<string, unknown>) : null;
          const n = o === null ? null : parseDisplayName(o.name);
          if (o === null || n === null || !n.ok || n.value === null) return problem(400, 'invalid_name_history');
          if (o.fromDate !== undefined && !isDate(o.fromDate)) return problem(400, 'invalid_date');
          if (o.toDate !== undefined && !isDate(o.toDate)) return problem(400, 'invalid_date');
          history.push({ name: n.value, ...(o.fromDate === undefined ? {} : { fromDate: o.fromDate as string }), ...(o.toDate === undefined ? {} : { toDate: o.toDate as string }) });
        }
        input.nameHistory = history;
      }
      if (body.body.displayName !== undefined) {
        const n = parseDisplayName(body.body.displayName);
        if (!n.ok || n.value === null) return problem(400, 'invalid_display_name');
        input.name = n.value;
      }
      if (body.body.team !== undefined) {
        if (typeof body.body.team !== 'string' || body.body.team.trim() === '' || body.body.team.length > 80) return problem(400, 'invalid_team');
        input.team = body.body.team.trim();
      }
      if (body.body.email !== undefined) {
        if (body.body.email === null || String(body.body.email).trim() === '') input.email = null;
        else {
          const e = normalizeEmail(body.body.email);
          if (e === null) return problem(400, 'invalid_email');
          input.email = e;
        }
      }
      const edited = await room.editMemberProfile(p.tenantId, { memberId, ...input, today: businessDate(), actor: p.email });
      if (!edited.ok) return memberProblem(edited.error);
      if (edited.changed) await ctx.registry.recordMemberEvent({ tenantId: p.tenantId, action: 'member.updated', actor, userId: found.userId ?? null, meta: { name: input.name ?? found.name, fields: edited.fields.join(',') } });
      return json({ memberId, changed: edited.changed });
    }

    // Provision a login account for a profile that has none; the profile becomes the linked one (no duplicate).
    if (action === 'account' && method === 'POST') {
      const body = parsed;
      if (found.userId !== undefined) return problem(409, 'member_already_linked');
      if (!found.active) return problem(409, 'member_inactive');
      if (found.email === undefined) return problem(400, 'email_required_for_account');
      const intended = memberRoleOf(found.role);
      if (intended === null) return problem(400, 'role_required_for_account');
      const access = (body.body.access ?? 'editor') as UserAccess;
      const account = await ctx.registry.createUser({ tenantId: p.tenantId, email: found.email, displayName: found.name, role: accountRoleOf(intended), access, reserved: ctx.superAdmins, actor });
      if (!account.ok) return registryProblem(account.error);
      const linked = await room.linkMember(p.tenantId, { memberId, userId: account.value.id, email: account.value.email, role: memberRoleWord(intended), actor: p.email });
      if (linked.ok) await ctx.registry.recordMemberEvent({ tenantId: p.tenantId, action: 'member.account_linked', actor, userId: account.value.id, meta: { how: 'created', name: found.name, assignments: linked.assignments } });
      return json({ memberId, user: account.value, linked: linked.ok, assignments: linked.ok ? linked.assignments : 0 }, 201);
    }

    // Change the role: SV <-> Tester. A linked profile changes its ACCOUNT's role (the Owner and yourself are protected).
    if (action === 'role' && method === 'POST') {
      const body = parsed;
      const wanted = body.body.role;
      if (wanted !== 'sv' && wanted !== 'tester') return problem(400, 'invalid_role');
      const word = memberRoleWord(wanted);
      let disconnected = true;
      if (found.userId !== undefined) {
        const changed = await ctx.registry.changeRole({ tenantId: p.tenantId, userId: found.userId, role: accountRoleOf(wanted), actor });
        if (!changed.ok) return registryProblem(changed.error);
        const set = await room.setMemberRole(p.tenantId, { memberId, role: word, actor: p.email });
        if (!set.ok) return memberProblem(set.error);
        // The person's live connections are ended, so the next one is authorised as the new role (the next request already is).
        try {
          await room.disconnectUser(p.tenantId, found.userId, CLOSE_CODES.roleChanged, 'role changed');
        } catch {
          disconnected = false; // reported; the session-expiry check still bounds the connection
        }
      } else {
        const set = await room.setMemberRole(p.tenantId, { memberId, role: word, actor: p.email });
        if (!set.ok) return memberProblem(set.error);
        if (set.changed) await ctx.registry.recordMemberEvent({ tenantId: p.tenantId, action: 'member.role_changed', actor, meta: { name: found.name, from: memberRoleOf(found.role) ?? '', to: wanted, linked: false } });
      }
      return json({ memberId, role: wanted, disconnected });
    }

    // Remove from active use. History stays; a linked account is disabled in the same action and its connections are closed.
    if (action === 'remove' && method === 'POST') {
      let disconnected = true;
      let accountDisabled = false;
      if (found.userId !== undefined) {
        const off = await ctx.registry.updateUser({ tenantId: p.tenantId, userId: found.userId, status: 'disabled', actor });
        if (!off.ok) return registryProblem(off.error);
        accountDisabled = true;
      }
      const set = await room.setMemberActive(p.tenantId, { memberId, active: false, today: businessDate(), actor: p.email });
      if (!set.ok) return memberProblem(set.error);
      if (found.userId !== undefined) {
        try {
          await room.disconnectUser(p.tenantId, found.userId, CLOSE_CODES.accessRevoked, 'member removed');
        } catch {
          disconnected = false;
        }
      }
      if (set.changed) await ctx.registry.recordMemberEvent({ tenantId: p.tenantId, action: 'member.removed', actor, userId: found.userId ?? null, meta: { name: found.name, accountDisabled } });
      return json({ memberId, accountDisabled, disconnected });
    }

    // Bring a removed profile back (the same identity). A disabled account is re-enabled only when asked for explicitly.
    if (action === 'reactivate' && method === 'POST') {
      const body = parsed;
      const set = await room.setMemberActive(p.tenantId, { memberId, active: true, today: businessDate(), actor: p.email });
      if (!set.ok) return memberProblem(set.error);
      let accountReactivated = false;
      let accountStillDisabled = false;
      if (found.userId !== undefined) {
        const account = await ctx.registry.getUser(p.tenantId, found.userId);
        if (account !== null && account.status === 'disabled') {
          if (body.body.reactivateAccount === true) {
            const on = await ctx.registry.updateUser({ tenantId: p.tenantId, userId: found.userId, status: 'enabled', actor });
            if (!on.ok) return registryProblem(on.error);
            accountReactivated = true;
          } else accountStillDisabled = true;
        }
      }
      if (set.changed) await ctx.registry.recordMemberEvent({ tenantId: p.tenantId, action: 'member.reactivated', actor, userId: found.userId ?? null, meta: { name: found.name, accountReactivated } });
      return json({ memberId, accountReactivated, accountStillDisabled });
    }
  }

  const userRoute = /^\/api\/tenant\/users\/([^/]+)$/.exec(path);
  if (userRoute !== null && method === 'PATCH') {
    const denial = need(ctx, 'users.manage');
    if (denial !== null) return denial;
    if (!isUserId(userRoute[1])) return problem(400, 'invalid_user_id');
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    if (body.body.status === 'enabled') {
      // A login must not be switched on while the person is removed from the directory: reactivate the Team Member instead.
      const profile = (await roomFor(ctx, p).listMembers(p.tenantId)).find((m) => m.userId === userRoute[1]);
      if (profile !== undefined && !profile.active) return problem(409, 'member_removed');
    }
    const result = await ctx.registry.updateUser({
      tenantId: p.tenantId,
      userId: userRoute[1],
      status: body.body.status as 'enabled' | 'disabled' | undefined,
      access: body.body.access as UserAccess | undefined,
      actor: actorOf(p),
    });
    if (!result.ok) return registryProblem(result.error);
    // A disabled user, or one whose access level changed, must not keep a live connection.
    let disconnected = true;
    if (body.body.status === 'disabled' || body.body.access !== undefined) {
      try {
        await roomFor(ctx, p).disconnectUser(p.tenantId, userRoute[1], CLOSE_CODES.accessRevoked, 'access changed');
      } catch {
        disconnected = false; // reported to the caller; the session-expiry check still bounds the connection
      }
    }
    return json({ user: result.value, disconnected });
  }

  // ---- ownership (the Owner SV only) ----
  if (path === '/api/tenant/owner' && method === 'POST') {
    const denial = need(ctx, 'tenant.transferOwnership');
    if (denial !== null) return denial;
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    if (body.body.confirm !== TRANSFER_OWNERSHIP_CONFIRMATION) return problem(400, 'confirmation_required');
    if (!isUserId(body.body.userId)) return problem(400, 'invalid_user_id');
    const result = await ctx.registry.transferOwnership({ tenantId: p.tenantId, actor: actorOf(p), toUserId: body.body.userId });
    return result.ok ? json(result.value) : registryProblem(result.error);
  }

  // ---- deletion request (the Owner SV) ----
  if (path === '/api/tenant/deletion-request' && method === 'POST') {
    const denial = need(ctx, 'tenant.requestDeletion');
    if (denial !== null) return denial;
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    // Asking for permanent deletion is deliberate: the typed word is checked HERE, not only in the browser.
    if (body.body.confirm !== REQUEST_DELETION_CONFIRMATION) return problem(400, 'confirmation_required');
    const result = await ctx.registry.requestDeletion(p.tenantId, p.userId);
    return result.ok ? json({ tenant: result.value }) : registryProblem(result.error);
  }
  if (path === '/api/tenant/deletion-request/cancel' && method === 'POST') {
    const denial = need(ctx, 'tenant.requestDeletion');
    if (denial !== null) return denial;
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    const result = await ctx.registry.cancelDeletion(p.tenantId, p.userId);
    return result.ok ? json({ tenant: result.value }) : registryProblem(result.error);
  }

  // ---- Testers of this workspace: the roster everyone may see; assignment is the Admin's ----
  if (path === '/api/tenant/team' && isRead) {
    const denial = need(ctx, 'team.view');
    if (denial !== null) return denial;
    return json({ testers: await ctx.registry.listTesters(p.tenantId) });
  }

  if (path === '/api/tenant/assignments' && method === 'POST') {
    const denial = need(ctx, 'assignments.manage');
    if (denial !== null) return denial;
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    const projectId = body.body.projectId;
    let userId = body.body.userId;
    const scopeId = body.body.scopeId;
    if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 100) return problem(400, 'invalid_project_id');
    if (scopeId !== undefined && (typeof scopeId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(scopeId))) return problem(400, 'invalid_scope_id');
    // A Team Member may be named instead of an account. A linked member resolves to THEIR account; one without an account gets a
    // business assignment that becomes usable when the account is linked (it grants nothing until then).
    if (userId === undefined && body.body.memberId !== undefined) {
      const memberId = body.body.memberId;
      if (typeof memberId !== 'string' || memberId.length === 0 || memberId.length > 100) return problem(400, 'invalid_member_id');
      const target = await roomFor(ctx, p).readMember(p.tenantId, memberId);
      if (target === null) return problem(404, 'member_not_found');
      if (!target.active) return problem(409, 'member_inactive');
      if (memberRoleOf(target.role) !== 'tester') return problem(409, 'member_not_tester');
      if (target.userId === undefined) {
        const made = await roomFor(ctx, p).assignMember(p.tenantId, { memberId, projectId, ...(typeof scopeId === 'string' ? { scopeId } : {}), today: businessDate(), actor: p.email });
        return made.ok ? json({ ...made, linked: false }, made.created ? 201 : 200) : memberProblem(made.error);
      }
      userId = target.userId;
    }
    if (!isUserId(userId)) return problem(400, 'invalid_user_id');
    // The account must be a Tester of THIS workspace (the tenant is the principal's, never the request's) and must be enabled.
    const tester = await ctx.registry.getTester(p.tenantId, userId);
    if (tester === null) return problem(404, 'tester_not_found');
    if (tester.status === 'disabled') return problem(409, 'tester_disabled');
    const result = await roomFor(ctx, p).assignTester(p.tenantId, {
      projectId,
      userId,
      testerName: tester.displayName ?? tester.email,
      actor: p.email,
      ...(typeof scopeId === 'string' ? { scopeId } : {}),
      today: businessDate(),
    });
    if (!result.ok) return problem(result.error === 'project_not_found' || result.error === 'scope_not_found' ? 404 : 409, result.error);
    return json(result, result.created ? 201 : 200);
  }

  // ---- this workspace's administrative history (Admin only; never another tenant's) ----
  if (path === '/api/tenant/audit' && isRead) {
    const denial = need(ctx, 'audit.tenant');
    if (denial !== null) return denial;
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));
    const beforeRaw = url.searchParams.get('before');
    const before = beforeRaw === null ? undefined : (revisionParam(beforeRaw) ?? undefined);
    return json({ audit: await ctx.registry.listAdminAudit({ kind: 'tenant', tenantId: p.tenantId }, limit, before) });
  }

  // ---- storage mode and migration (Admin) ----
  if (path.startsWith('/api/tenant/storage/')) return storageRoutes(ctx, p);

  return null;
}

async function storageRoutes(ctx: Ctx, p: MemberPrincipal): Promise<Response> {
  const denial = need(ctx, 'storage.migrate');
  if (denial !== null) return denial;
  const room = roomFor(ctx, p);
  const { path, method } = ctx;

  // What the server holds for this tenant right now (works in either mode).
  if (path === '/api/tenant/storage/inspect' && method === 'GET') {
    return json({ tenant: await ctx.registry.getTenant(p.tenantId), server: await room.verifyState(p.tenantId) });
  }

  // Atomic upload of a whole workspace as ONE revision. Never overwrites silently.
  if (path === '/api/tenant/storage/upload' && method === 'POST') {
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    const b = body.body;
    const migrationId = typeof b.migrationId === 'string' && b.migrationId.length > 0 && b.migrationId.length <= 100 ? b.migrationId : null;
    if (migrationId === null) return problem(400, 'invalid_migration_id');
    if (typeof b.expectedRevision !== 'number' || !Number.isSafeInteger(b.expectedRevision) || b.expectedRevision < 0) return problem(400, 'invalid_expected_revision');
    const replace = b.replace === true;
    // Replacing existing cloud data is destructive: it needs the typed confirmation, checked HERE.
    if (replace && b.confirm !== REPLACE_CONFIRMATION) return problem(400, 'confirmation_required');
    const result = await room.importWorkspace(p.tenantId, { migrationId, records: b.records, expectedRevision: b.expectedRevision, replace, actor: p.email });
    if (result.ok) {
      if (!result.alreadyApplied) {
        const records = Object.values(result.counts).reduce((a, n) => a + n, 0);
        await ctx.registry.appendAudit({ action: 'storage.migration_uploaded', actor: actorOf(p), tenantId: p.tenantId, meta: { revision: result.revision, records, replaced: replace } });
      }
      return json(result);
    }
    const status = result.error === 'invalid' ? 400 : result.error === 'failed' ? 500 : 409;
    return problem(status, result.error, { message: result.message, revision: result.revision });
  }

  // Switch authority to the cloud — only after the server re-verifies the uploaded content itself.
  if (path === '/api/tenant/storage/activate-web' && method === 'POST') {
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    const { revision, hash } = body.body;
    if (typeof revision !== 'number' || typeof hash !== 'string') return problem(400, 'invalid_verification');
    const state = await room.verifyState(p.tenantId);
    if (state.revision !== revision || state.hash !== hash) return problem(409, 'verification_failed', { revision: state.revision });
    await room.thaw(p.tenantId);
    const result = await ctx.registry.setStorageMode(p.tenantId, 'web', actorOf(p));
    return result.ok ? json({ tenant: result.value }) : registryProblem(result.error);
  }

  // Switch back to local — only if the cloud copy is exactly what the caller downloaded; the copy is KEPT.
  if (path === '/api/tenant/storage/deactivate-web' && method === 'POST') {
    const body = await readJson(ctx);
    if (!body.ok) return body.response;
    const { revision, hash } = body.body;
    if (typeof revision !== 'number' || typeof hash !== 'string') return problem(400, 'invalid_verification');
    // Leaving the cloud locks every collaborator out: it needs the typed confirmation, checked HERE too.
    if (body.body.confirm !== SWITCH_TO_LOCAL_CONFIRMATION) return problem(400, 'confirmation_required');
    if (p.storageMode !== 'web') return problem(409, 'wrong_mode');
    const frozen = await room.freezeIfUnchanged(p.tenantId, { revision, hash });
    if (!frozen.ok) return problem(409, frozen.error);
    const result = await ctx.registry.setStorageMode(p.tenantId, 'local', actorOf(p));
    if (!result.ok) {
      await room.thaw(p.tenantId); // roll back: the workspace stays live
      return registryProblem(result.error);
    }
    return json({ tenant: result.value, cloudCopy: 'archived' });
  }

  return problem(404, 'Not found');
}
