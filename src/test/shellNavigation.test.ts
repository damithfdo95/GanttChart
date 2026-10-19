import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, navItems } from '../app/navigation';
import { dictionaries } from '../i18n/dictionaries';
import appSource from '../app/App.tsx?raw';
import ganttSource from '../features/gantt/Gantt.tsx?raw';
import meetingSource from '../features/meeting/MeetingView.tsx?raw';
import css from '../index.css?raw';

const ids = (role: Parameters<typeof navItems>[0]) => navItems(role).map((i) => i.id);
/** The declarations of the first top-level CSS rule whose selector is exactly `selector`. */
const rule = (selector: string): string => {
  for (const block of css.split('}')) {
    const open = block.indexOf('{');
    if (open < 0) continue;
    const head = block.slice(0, open);
    const name = head.slice(Math.max(head.lastIndexOf('*/') + 2, 0)).trim();
    if (name === selector) return block.slice(open + 1);
  }
  return '';
};

describe('Gantt Planning / Meeting switch lives in the Gantt page header', () => {
  it('is built by the Gantt screen and handed to both views, never rendered by the app shell', () => {
    expect(ganttSource).toMatch(/const viewSwitch = \(/);
    expect(ganttSource).toMatch(/<MeetingView[^>]*viewSwitch=\{viewSwitch\}/);
    expect(ganttSource).toMatch(/<GanttPlanning[^>]*viewSwitch=\{viewSwitch\}/);
    expect(appSource).not.toContain('mt.planningView');
    expect(appSource).not.toContain('gantt-mode');
  });

  it('sits in the Planning View title group (next to the title) and at the top of the Meeting View header', () => {
    expect(ganttSource).toMatch(/<div className="app-title-group">\s*<h1>\{t\(lang, 'nav\.gantt'\)\}<\/h1>\s*\{viewSwitch\}\s*<\/div>/);
    expect(meetingSource).toMatch(/<header className="mt-head">\s*<div>\s*\{viewSwitch === undefined \? null : <div className="gantt-view-slot">\{viewSwitch\}<\/div>\}/);
  });

  it('keeps both views selectable and marks the current one (aria-selected, class and a check mark)', () => {
    expect(ganttSource).toContain("(['planning', 'meeting'] as const)");
    expect(ganttSource).toContain('onClick={() => setMode(id)}');
    expect(ganttSource).toContain('aria-selected={mode === id}');
    expect(ganttSource).toContain("className={mode === id ? 'active' : undefined}");
    expect(ganttSource).toContain('{mode === id ? <span aria-hidden="true">✓ </span> : null}');
  });

  it('has no leftover floating margin; presenting still hides the switch', () => {
    expect(css).not.toMatch(/\.gantt-mode\s*\{\s*margin/);
    expect(css).toMatch(/body\.mt-presenting \.app-shell, body\.mt-presenting \.gantt-mode/);
  });

  it('a Tester keeps the plain read-only Planning View without a switch (the language toggle stays)', () => {
    expect(ganttSource).toMatch(/if \(isTester\) return <GanttPlanning focusProjectId=\{focusProjectId\} onFocusHandled=\{onFocusHandled\} langToggle=\{langToggle\} \/>;/);
    // The tester branch must not receive the Planning/Meeting view switch.
    expect(ganttSource).not.toMatch(/isTester\) return <GanttPlanning[^>]*viewSwitch/);
  });
});

describe('global navigation is one collection', () => {
  it('History and Settings are ordinary entries of the same list as every other screen', () => {
    const sv = ids('admin');
    expect(sv).toContain('history');
    expect(sv).toContain('settings');
    expect(sv.indexOf('team')).toBeLessThan(sv.indexOf('history'));
    expect(sv.indexOf('history')).toBeLessThan(sv.indexOf('settings'));
    expect(NAV_ITEMS.map((i) => i.id)).toEqual(expect.arrayContaining(['history', 'settings']));
  });

  it('the app shell renders every tab from ONE map inside one nav strip, with no separate History/Settings row', () => {
    expect(appSource.match(/navItems\(/g)).toHaveLength(1);
    expect(appSource).toContain('<div className="app-nav-tabs">');
    expect(appSource).not.toMatch(/'history'[^\n]*className/);
    expect(appSource).not.toMatch(/nav-break|nav-second|nav-secondary/);
  });

  it('account and status controls are a separate region after the navigation', () => {
    const navEnd = appSource.indexOf('</nav>');
    const account = appSource.indexOf('className="account-area"');
    expect(navEnd).toBeGreaterThan(0);
    expect(account).toBeGreaterThan(navEnd);
    expect(appSource).toMatch(/className="account-area" role="group" aria-label=\{t\(state\.language, 'nav\.accountArea'\)\}/);
  });

  it('keeps role-based navigation: an SV sees Team Members, a Tester no SV-only screens, the Super Admin none', () => {
    expect(ids('admin')).toContain('team');
    expect(ids('admin')).not.toContain('myTesting');
    const tester = ids('user');
    for (const sv of ['settings', 'history', 'cycles', 'testManagement', 'dailyReport', 'review', 'reports']) expect(tester).not.toContain(sv);
    expect(tester).toContain('myTesting');
    expect(ids('super_admin')).toEqual([]);
  });

  it('uses the Tester wording and one name for the screen, in English and Japanese', () => {
    const en = dictionaries.en as Record<string, string>;
    const ja = dictionaries.ja as Record<string, string>;
    expect(en['nav.team']).toBe('Team Members');
    expect(ja['nav.team']).toBe('チームメンバー');
    expect(en['tenancy.role.user']).toBe('Tester');
    expect(ja['tenancy.role.user']).toBe('テスター');
  });
});

describe('navigation styling guards', () => {
  it('the tab strip scrolls sideways instead of wrapping, and tabs never wrap their label', () => {
    const strip = rule('.app-nav-tabs');
    expect(strip).toMatch(/overflow-x:\s*auto/);
    expect(strip).not.toMatch(/flex-wrap:\s*wrap/);
    expect(strip).toMatch(/min-width:\s*0/);
    const tab = rule('.app-nav button');
    expect(tab).toMatch(/white-space:\s*nowrap/);
    expect(tab).toMatch(/flex:\s*none/);
    expect(tab).toMatch(/height:\s*38px/);
  });

  it('the shell shares the page content width and padding so left edges line up', () => {
    expect(rule('.app-shell')).toMatch(/max-width:\s*1360px/);
    expect(rule('.app-shell')).toMatch(/padding:\s*12px 24px 0/);
    expect(rule('.app')).toMatch(/max-width:\s*1360px/);
    expect(rule('.app')).toMatch(/padding:\s*20px 24px 48px/);
  });

  it('keeps the blue active tab, adds a non-colour marker, and keeps a visible keyboard focus', () => {
    const active = rule('.app-nav button.active');
    expect(active).toContain('var(--accent)');
    expect(active).toMatch(/box-shadow:\s*inset/);
    expect(css).toMatch(/button:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--accent\)/);
    expect(appSource).toContain("aria-current={activeScreen === item.id ? 'page' : undefined}");
  });
});

describe('EN/JA parity for the new labels', () => {
  it('has the same keys with different, non-empty text', () => {
    const en = dictionaries.en as Record<string, string>;
    const ja = dictionaries.ja as Record<string, string>;
    for (const key of ['gantt.viewSwitch', 'nav.accountArea', 'mt.planningView', 'mt.meetingView']) {
      expect(en[key]).toBeTruthy();
      expect(ja[key]).toBeTruthy();
    }
    expect(Object.keys(en).sort()).toEqual(Object.keys(ja).sort());
  });
});
