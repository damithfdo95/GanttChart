import type { UserDto } from '../../../shared/tenancy';

export type UserSort = 'name' | 'email' | 'created' | 'status' | 'activity';
export type UserStatusFilter = 'all' | 'active' | 'disabled';

export interface UserView {
  q: string;
  status: UserStatusFilter;
  sort: UserSort;
  dir: 'asc' | 'desc';
}

export const DEFAULT_USER_VIEW: UserView = { q: '', status: 'all', sort: 'name', dir: 'asc' };

const text = (u: UserDto): string => (u.displayName ?? u.email).toLowerCase();

/**
 * What the Admin's user table shows: only subordinate Users (the Admin's own account is not a row to manage),
 * searched by name or email, filtered by status, sorted. Pure; the server has already limited the list to the
 * Admin's own workspace.
 */
export function viewUsers(users: readonly UserDto[], view: UserView): UserDto[] {
  const q = view.q.normalize('NFKC').trim().toLowerCase();
  const rows = users.filter(
    (u) => u.role === 'user' && (view.status === 'all' || u.status === view.status) && (q === '' || u.email.toLowerCase().includes(q) || (u.displayName ?? '').toLowerCase().includes(q)),
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
