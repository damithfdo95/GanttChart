import type { UserDto } from '../../../shared/tenancy';

export type UserSort = 'name' | 'email' | 'created' | 'status' | 'activity';
export type UserStatusFilter = 'all' | 'active' | 'disabled';
export type UserRoleFilter = 'all' | 'sv' | 'tester';

export interface UserView {
  q: string;
  status: UserStatusFilter;
  role: UserRoleFilter;
  sort: UserSort;
  dir: 'asc' | 'desc';
}

export const DEFAULT_USER_VIEW: UserView = { q: '', status: 'all', role: 'all', sort: 'name', dir: 'asc' };

const text = (u: UserDto): string => (u.displayName ?? u.email).toLowerCase();

/**
 * What the Team Members table shows: every member of the workspace (SVs and Testers, the Owner included), searched by
 * name or email, filtered by role and status, sorted. Pure; the server has already limited the list to the SV's own
 * workspace.
 */
export function viewUsers(users: readonly UserDto[], view: UserView): UserDto[] {
  const q = view.q.normalize('NFKC').trim().toLowerCase();
  const rows = users.filter(
    (u) => (view.role === 'all' || (view.role === 'sv' ? u.role === 'admin' : u.role === 'user')) && (view.status === 'all' || u.status === view.status) && (q === '' || u.email.toLowerCase().includes(q) || (u.displayName ?? '').toLowerCase().includes(q)),
  );
  const cmp = (a: UserDto, b: UserDto): number => {
    switch (view.sort) {
      case 'name':
        return text(a).localeCompare(text(b));
      case 'email':
        return a.email.localeCompare(b.email);
      case 'created':
        return a.createdAt.localeCompare(b.createdAt);
      case 'status':
        return a.status.localeCompare(b.status) || text(a).localeCompare(text(b));
      case 'activity':
        // Never signed in sorts as "oldest".
        return (a.lastLoginAt ?? '').localeCompare(b.lastLoginAt ?? '');
    }
  };
  return rows.sort((a, b) => (view.dir === 'asc' ? cmp(a, b) : -cmp(a, b)));
}
