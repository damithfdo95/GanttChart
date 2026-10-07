import type { TranslationKey } from '../i18n';
import type { AppRole } from '../../shared/tenancy';
import { accessTo, type ScreenId } from './access';

export type Screen = ScreenId;

export interface NavItem {
  id: Screen;
  key: TranslationKey;
}

/**
 * Every screen, in order: day-to-day screens first (dashboard, cycles, projects / test executions, Gantt, daily
 * report, ...), then Team Members, History and Settings. Every entry is a screen that exists; nothing here is a
 * placeholder. Who sees which of them is decided in ONE place, `SCREEN_ACCESS` (app/access.ts): an SV sees all of
 * them, a Tester only the ones they work with. The Super Admin has no QA navigation: the platform console has its
 * own tabs and never shows workspace data.
 *
 * "RCS Members" and "Team / Testers" are one screen now: Team Members.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'dashboard', key: 'nav.dashboard' },
  { id: 'cycles', key: 'nav.cycles' },
  { id: 'overall', key: 'nav.overall' },
  { id: 'gantt', key: 'nav.gantt' },
  { id: 'testManagement', key: 'nav.testManagement' },
  { id: 'myTesting', key: 'nav.myTesting' },
  { id: 'dailyReport', key: 'nav.dailyReport' },
  { id: 'tickets', key: 'nav.tickets' },
  { id: 'performance', key: 'nav.performance' },
  { id: 'review', key: 'nav.review' },
  { id: 'reports', key: 'nav.reports' },
  { id: 'team', key: 'nav.team' },
  { id: 'history', key: 'nav.history' },
  { id: 'settings', key: 'nav.settings' },
];

/**
 * The navigation for a role. `null` is plain local use without any backend (no accounts at all): everything except
 * Team Members, which needs accounts. The Super Admin never reaches this shell (they get the console).
 */
export function navItems(role: AppRole | null): NavItem[] {
  return NAV_ITEMS.filter((item) => accessTo(role, item.id) !== 'none');
}
