import type { TranslationKey } from '../i18n';
import type { AppRole } from '../../shared/tenancy';

export type Screen = 'dashboard' | 'overall' | 'gantt' | 'dailyReport' | 'tickets' | 'performance' | 'review' | 'members' | 'reports' | 'history' | 'team' | 'settings';

export interface NavItem {
  id: Screen;
  key: TranslationKey;
  /** Only the Admin of a workspace sees it. */
  adminOnly?: boolean;
}

/**
 * The QA manager's navigation: day-to-day screens first (dashboard, projects / test executions, Gantt,
 * daily report, ...), then History, Team / Users (Admin only) and Settings. Every entry is a screen that
 * exists; nothing here is a placeholder. The Super Admin has no QA navigation: the platform console has
 * its own tabs and never shows workspace data.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'dashboard', key: 'nav.dashboard' },
  { id: 'overall', key: 'nav.overall' },
  { id: 'gantt', key: 'nav.gantt' },
  { id: 'dailyReport', key: 'nav.dailyReport' },
  { id: 'tickets', key: 'nav.tickets' },
  { id: 'performance', key: 'nav.performance' },
  { id: 'review', key: 'nav.review' },
  { id: 'members', key: 'nav.members' },
  { id: 'reports', key: 'nav.reports' },
  { id: 'history', key: 'nav.history' },
  { id: 'team', key: 'nav.team', adminOnly: true },
  { id: 'settings', key: 'nav.settings' },
];

/**
 * The navigation for a role. `null` is plain local use without any backend (no accounts at all). The Super Admin
 * never reaches this shell (they get the console), so an unexpected `super_admin` gets nothing.
 */
export function navItems(role: AppRole | null): NavItem[] {
  if (role === 'super_admin') return [];
  return NAV_ITEMS.filter((item) => item.adminOnly !== true || role === 'admin');
}
