import type { RcsMember, ReportsState, TesterProjectAssignment } from '../../types';

/**
 * Restored-workspace account-link sanitizer (Stage 8D/8E).
 *
 * A backup file is DATA, never authority about accounts: restoring it must
 * never create, transfer or change a login-account association. People with
 * a login keep the link this workspace has now, and everything the file
 * claims about accounts is dropped unless the workspace independently
 * confirms it.
 *
 * Deterministic rules:
 *
 * - Members (the account registry): a profile that exists in this workspace
 *   keeps the userId, email, role, active state and removal date the
 *   workspace has now (its descriptive fields come from the file). A profile
 *   the workspace does not know stays unlinked whatever the file says, and
 *   its email survives only when no other profile — current or earlier in
 *   the file — already carries it (emails stay unique; first come, first
 *   served). Profiles missing from the file are kept: a restore must not
 *   silently remove the workspace's account registry.
 * - Assignments: a business assignment survives, but its userId is kept only
 *   when that account is linked to a member of this workspace. The actor
 *   parameter never widens this: an assignment's account reference is a fact
 *   about the workspace, not about who is restoring.
 * - Notifications: a definition the workspace already has stays exactly as
 *   the workspace has it. A new definition from the file is attributed to
 *   the person restoring it (when signed in), and its members-audience is
 *   filtered to the people that exist in the restored workspace; a
 *   members-audience that reaches nobody drops the definition.
 * - Acknowledgments: the file's are ignored and the workspace's own stay,
 *   so a restore can never close or reopen anything for anyone.
 * - JIRA / TestRail connections: the device's own stays; a file never carries
 *   or replaces credentials.
 * - Branding: the file's logo becomes the workspace's, attributed to the
 *   person restoring it (when signed in).
 */
export function sanitizeRestoredAccountLinks(
  file: ReportsState,
  current: ReportsState,
  actorUserId?: string | null,
): ReportsState {
  const actor = typeof actorUserId === 'string' && actorUserId !== '' ? actorUserId : null;

  const currentMembers = current.rcsMembers ?? [];
  const currentById = new Map(currentMembers.map((m) => [m.id, m] as const));
  // A profile link is the only account authority this app has.
  const validAccounts = new Set(
    currentMembers.filter((m) => m.userId !== undefined).map((m) => m.userId as string),
  );
  // Emails are unique among profiles; the workspace's own emails are reserved.
  const takenEmails = new Set(
    currentMembers.filter((m) => m.email !== undefined).map((m) => (m.email as string).toLowerCase()),
  );

  // ---- Members: the workspace's account state wins; the file never links -------
  const fileMembers = file.rcsMembers ?? [];
  const members: RcsMember[] = fileMembers.map((m) => {
    const here = currentById.get(m.id);
    if (here !== undefined) {
      // A profile keeps the link, email, role and state the workspace has now.
      return mergeMemberWithCurrent(m, here);
    }
    // An unlinked profile stays unlinked whatever the file says; its email
    // survives only when no other profile already carries it.
    const out = stripAccountFields(m);
    if (m.email !== undefined && !takenEmails.has(m.email.toLowerCase())) {
      out.email = m.email;
      takenEmails.add(m.email.toLowerCase());
    }
    return out;
  });
  const fileMemberIds = new Set(fileMembers.map((m) => m.id));
  for (const m of currentMembers) {
    if (!fileMemberIds.has(m.id)) members.push({ ...m });
  }

  // ---- Assignments: the business record survives; the account only when valid here ----
  const testerAssignments =
    file.testerAssignments === undefined
      ? undefined
      : file.testerAssignments.map((a) =>
          a.userId !== undefined && validAccounts.has(a.userId) ? a : stripUserId(a),
        );

  // ---- Notifications: the workspace's own stay; new ones are the restorer's ----
  const currentDefs = new Map((current.notifications ?? []).map((d) => [d.id, d] as const));
  const memberIdsHere = new Set(members.map((m) => m.id));
  const notifications =
    file.notifications === undefined
      ? undefined
      : file.notifications.flatMap((def) => {
          const mine = currentDefs.get(def.id);
          if (mine !== undefined) return [mine];
          let next = def;
          if (def.audience.kind === 'members') {
            const kept = (def.audience.memberIds ?? []).filter((id) => memberIdsHere.has(id));
            if (kept.length === 0) return [];
            next = { ...next, audience: { ...next.audience, memberIds: kept } };
          }
          if (actor !== null) {
            next = { ...next, createdByUserId: actor, updatedByUserId: actor };
          }
          return [next];
        });

  // ---- Acknowledgments: the file's are ignored, the workspace's own stay ----
  const notificationAcks = current.notificationAcks ?? [];

  // ---- Branding: the file's logo, attributed to the person restoring it ----
  const brandings =
    file.brandings === undefined
      ? undefined
      : file.brandings.map((b) => (actor === null ? b : { ...b, updatedByUserId: actor }));

  // ---- JIRA / TestRail connections: device-local, so a file can neither set nor clear them ----
  const { jira: _fileJira, testrail: _fileTestrail, ...fileSettings } = file.settings;
  const settings = {
    ...fileSettings,
    ...(current.settings.jira !== undefined ? { jira: current.settings.jira } : {}),
    ...(current.settings.testrail !== undefined ? { testrail: current.settings.testrail } : {}),
  };

  return {
    ...file,
    settings,
    rcsMembers: file.rcsMembers === undefined && members.length === 0 ? undefined : members,
    testerAssignments,
    notifications,
    notificationAcks,
    brandings,
  };
}

/** The file's descriptive fields with every account-owned field removed. */
function stripAccountFields(m: RcsMember): RcsMember {
  const clone: Record<string, unknown> = { ...m };
  delete clone.userId;
  delete clone.email;
  delete clone.removedAt;
  return clone as unknown as RcsMember;
}

/** The file's member carrying the workspace's account-owned fields. */
function mergeMemberWithCurrent(fileMember: RcsMember, here: RcsMember): RcsMember {
  const out = stripAccountFields(fileMember);
  out.role = here.role;
  out.active = here.active;
  if (here.userId !== undefined) out.userId = here.userId;
  if (here.email !== undefined) out.email = here.email;
  if (here.removedAt !== undefined) out.removedAt = here.removedAt;
  return out;
}

/** The assignment with its account reference removed; business fields untouched. */
function stripUserId(a: TesterProjectAssignment): TesterProjectAssignment {
  const clone: Record<string, unknown> = { ...a };
  delete clone.userId;
  return clone as unknown as TesterProjectAssignment;
}
