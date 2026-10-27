import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, navItems } from '../app/navigation';
import { dictionaries } from '../i18n/dictionaries';
import appSource from '../app/App.tsx?raw';
import ganttSource from '../features/gantt/Gantt.tsx?raw';
import meetingSource from '../features/meeting/MeetingView.tsx?raw';
import dashboardSource from '../features/dashboard/Dashboard.tsx?raw';
import brandSource from '../features/branding/BrandMark.tsx?raw';
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
    expect(css).toMatch(/body\.mt-presenting \.app-sidebar, body\.mt-presenting \.gantt-mode/);
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

  it('the app shell renders every tab from ONE map inside one semantic nav in the left sidebar, with no separate History/Settings row', () => {
    expect(appSource.match(/navItems\(/g)).toHaveLength(1);
    expect(appSource).toContain('<aside className="app-sidebar">');
    expect(appSource).toContain('<main className="app-main">');
    expect(appSource).toContain("<nav className=\"app-nav\" aria-label={t(state.language, 'nav.mainNavigation')}>");
    expect(appSource).toContain('<div className="app-nav-tabs">');
    expect(appSource).not.toMatch(/'history'[^\n]*className/);
    expect(appSource).not.toMatch(/nav-break|nav-second|nav-secondary/);
  });

  it('account and status controls are a separate region inside the sidebar, after the navigation', () => {
    const navEnd = appSource.indexOf('</nav>');
    const account = appSource.indexOf('className="account-area"');
    expect(navEnd).toBeGreaterThan(0);
    expect(account).toBeGreaterThan(navEnd);
    expect(account).toBeLessThan(appSource.indexOf('</aside>'));
    expect(appSource).toMatch(/className="account-area" role="group" aria-label=\{t\(state\.language, 'nav\.accountArea'\)\}/);
    for (const part of ['<WorkspaceBadge />', '<SyncStatusIndicator />', '<SaveStatusIndicator />', '<ShellLogout />']) expect(appSource).toContain(part);
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
  it('the sidebar is a vertical column beside the content; labels wrap instead of being cut, and the column may shrink', () => {
    expect(rule('.app-layout')).toMatch(/grid-template-columns:\s*220px minmax\(0, 1fr\)/);
    expect(rule('.app-main')).toMatch(/min-width:\s*0/);
    expect(rule('.app-sidebar')).toMatch(/position:\s*sticky/);
    expect(rule('.app-nav-tabs')).toMatch(/flex-direction:\s*column/);
    const tab = rule('.app-nav button');
    expect(tab).toMatch(/width:\s*100%/);
    expect(tab).toMatch(/overflow-wrap:\s*anywhere/);
    expect(tab).not.toMatch(/white-space:\s*nowrap/);
  });

  it('screens keep their own content width and padding inside the main column', () => {
    expect(rule('.app')).toMatch(/max-width:\s*1360px/);
    expect(rule('.app')).toMatch(/padding:\s*20px 24px 48px/);
  });

  it('keeps the blue active item, adds a non-colour marker, and keeps a visible keyboard focus', () => {
    const active = rule('.app-nav button.active');
    expect(active).toContain('var(--accent)');
    expect(active).toMatch(/box-shadow:\s*inset/);
    expect(css).toMatch(/\.app-nav button:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--accent\)/);
    expect(appSource).toContain("aria-current={activeScreen === item.id ? 'page' : undefined}");
  });

  it('on a narrow window the sidebar is a top bar and the menu is a drawer that opens from a button (never a wide fixed column)', () => {
    const narrow = css.slice(css.indexOf('@media (max-width: 900px) {\n  .app-layout'));
    expect(narrow).toMatch(/\.app-layout\s*\{\s*display:\s*block/);
    expect(narrow).toMatch(/\.app-sidebar\s*\{[^}]*position:\s*static/);
    expect(narrow).toMatch(/\.app-sidebar-panel\s*\{\s*display:\s*none/);
    expect(narrow).toMatch(/\.app-layout\.menu-open \.app-sidebar-panel\s*\{\s*display:\s*flex/);
    expect(rule('.sidebar-menu-toggle')).toMatch(/display:\s*none/);
    expect(appSource).toContain('aria-expanded={menuOpen}');
    expect(appSource).toContain('aria-controls="app-sidebar-panel"');
    expect(appSource).toContain("e.key !== 'Escape'");
  });

  it('there is ONE primary language control (the sidebar); the Dashboard has none and the Gantt slot only shows while presenting', () => {
    expect((appSource.match(/className="lang-toggle sidebar-lang-toggle"/g) ?? [])).toHaveLength(1);
    expect(dashboardSource).not.toContain('lang-toggle');
    expect(dashboardSource).not.toContain('LANGUAGES');
    expect(rule('.gantt-lang-slot')).toMatch(/display:\s*none/);
    expect(css).toMatch(/body\.mt-presenting \.gantt-lang-slot\s*\{\s*display:\s*inline-flex/);
    expect(appSource).toContain("aria-label={t(state.language, 'app.languageLabel')}");
  });
});

describe('sidebar behaviour: menu visibility, access, error handling', () => {
  it('Left Menu Visibility filters the sidebar, but Settings can never be hidden', () => {
    expect(appSource).toContain("const menuNav = visibleNav.filter((item) => item.id === 'settings' || !hiddenNav.has(item.id));");
    expect(appSource).toContain('{menuNav\n');
    expect(appSource).toContain('const allowed = menuNav.some((item) => item.id === screen);');
  });

  it('navigation destinations come only from the existing access model (no second permission list in the shell)', () => {
    expect(appSource).toContain('const visibleNav = navItems(principal?.role ?? null);');
    expect(appSource).not.toMatch(/tester.*\[\s*'/i);
    for (const id of ['dashboard', 'commandCenter', 'improvement', 'testManagement', 'dailyReport', 'performance', 'settings']) expect(ids('admin')).toContain(id);
    for (const id of ['commandCenter', 'improvement', 'settings', 'dailyReport', 'cycles']) expect(ids('user')).not.toContain(id);
  });

  it('every destination the access model allows is rendered: the only filters between navItems and the buttons are visibility, Settings and the JIRA connection', () => {
    const block = appSource.slice(appSource.indexOf('<div className="app-nav-tabs">'), appSource.indexOf('</nav>'));
    expect(block).toMatch(/\{menuNav\s*\.filter\(\(item\) => item\.id !== 'jira' \|\| jiraConfigured\)\s*\.map\(\(item\) => \(/);
    expect((block.match(/\.filter\(/g) ?? [])).toHaveLength(1);
    expect(appSource).toContain('const visibleNav = navItems(principal?.role ?? null);');
    // The active item is announced to assistive technology and marked visually.
    expect(block).toContain("aria-current={activeScreen === item.id ? 'page' : undefined}");
    expect(block).toContain("className={activeScreen === item.id ? 'active' : undefined}");
  });

  it('the screen area keeps the error boundary and the dashboard fallback', () => {
    expect(appSource).toContain('<ScreenErrorBoundary key={activeScreen}');
    expect(appSource).toContain("(screen === 'jira' && !jiraConfigured) || !allowed ? 'dashboard' : screen");
    expect(appSource.indexOf('<ScreenErrorBoundary')).toBeGreaterThan(appSource.indexOf('<main className="app-main">'));
  });

  it('the sidebar brand shows the workspace name beside the logo and falls back to the name alone', () => {
    expect(appSource).toContain('<SidebarBrandMark lang={state.language} />');
    expect(brandSource).toContain('brand-mark brand-mark--textonly');
    expect(brandSource).toContain('<img className="brand-logo" src={src} alt="" />');
  });
});

describe('EN/JA parity for the new labels', () => {
  it('has the same keys with different, non-empty text', () => {
    const en = dictionaries.en as Record<string, string>;
    const ja = dictionaries.ja as Record<string, string>;
    for (const key of ['gantt.viewSwitch', 'nav.accountArea', 'nav.menu', 'mt.planningView', 'mt.meetingView']) {
      expect(en[key]).toBeTruthy();
      expect(ja[key]).toBeTruthy();
    }
    expect(Object.keys(en).sort()).toEqual(Object.keys(ja).sort());
  });
});
