import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultReportsState, normalizeReportsState, isReportsState } from '../lib/storage/reports';
import { sharedSettings } from '../lib/sync/records';
import { navItems } from '../app/navigation';

const root = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

describe('Left Menu Visibility (ported from the other PC)', () => {
  const withHidden = (hidden: unknown) => {
    const base = defaultReportsState();
    return { ...base, settings: { ...base.settings, hiddenNavItems: hidden as never } };
  };

  it('keeps valid screen ids, sorted and de-duplicated; drops unknown and malformed values; omits the field when nothing is hidden', () => {
    const state = normalizeReportsState(withHidden(['tickets', 'dashboard', 'tickets', 'nonsense', 7]));
    expect(state.settings.hiddenNavItems).toEqual(['dashboard', 'tickets']);
    expect(normalizeReportsState(withHidden('x')).settings).not.toHaveProperty('hiddenNavItems');
    expect(normalizeReportsState(withHidden([])).settings).not.toHaveProperty('hiddenNavItems');
    expect(normalizeReportsState(defaultReportsState()).settings).not.toHaveProperty('hiddenNavItems');
  });

  it('older settings without the field still load, and a non-string list is refused by the shape guard', () => {
    expect(isReportsState(defaultReportsState())).toBe(true);
    expect(isReportsState(withHidden(['dashboard']))).toBe(true);
    expect(isReportsState(withHidden([1, 2]))).toBe(false);
  });

  it('is a workspace setting, so it travels in the shared settings record', () => {
    expect(sharedSettings(withHidden(['gantt']).settings)).toMatchObject({ hiddenNavItems: ['gantt'] });
  });

  it('only changes the SV menu: the shell filters navItems by the setting, and a Tester menu has no hideable item beyond their own screens', () => {
    const app = read('app/App.tsx');
    expect(app).toContain('const menuNav = visibleNav.filter((item) => !hiddenNav.has(item.id));');
    expect(app).toContain('const allowed = menuNav.some((item) => item.id === screen);');
    expect(app).toContain('{menuNav\n');
    const settingsUi = read('features/settings/MenuVisibilitySettings.tsx');
    expect(settingsUi).toContain("navItems('admin').filter((item) => item.id !== 'settings')"); // Settings itself can never be hidden
    expect(navItems('user').map((i) => i.id)).not.toContain('settings');
  });

  it('Settings sections are collapsible with one unique heading id each', () => {
    const c = read('features/settings/SettingsCollapsible.tsx');
    expect(c).toContain('useId()');
    expect(c).not.toContain('settings-collapsible-title');
    const settings = read('features/settings/Settings.tsx');
    expect((settings.match(/<SettingsCollapsible /g) ?? []).length).toBeGreaterThanOrEqual(7);
    expect(settings).toContain('<SupportPanel'); // current-main sections are kept
  });
});
