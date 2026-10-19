import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { dictionaries } from '../i18n/dictionaries';
import { MyProfile, TeamView } from '../features/tenancy/TeamScreen';
import type { PrincipalDto } from '../../shared/tenancy';
import type { TenancyApi } from '../lib/tenancy/api';
import teamScreen from '../features/tenancy/TeamScreen.tsx?raw';
import teamDirectory from '../features/tenancy/TeamDirectory.tsx?raw';
import sharedHistory from '../features/settings/SharedHistory.tsx?raw';
import revisionHistory from '../features/settings/RevisionHistory.tsx?raw';
import css from '../index.css?raw';

/**
 * Team Members and History use the standard authenticated page layout: the `.app` container
 * (same max-width and padding as Dashboard / Gantt / Settings), a standard page header, and cards.
 */

const tenant = (mode: 'local' | 'web') => ({ id: 'ten_x', name: 'Rakuten QA', storageMode: mode, status: 'active' as const, createdAt: 't', deletionRequestedAt: null });
const principal = (role: PrincipalDto['role']): PrincipalDto => ({
  email: 'taro.yamada@rakuten.com',
  userId: 'usr_taro',
  isOwner: role === 'admin',
  displayName: null,
  role,
  tenant: tenant('local'),
  access: role === 'user' ? 'editor' : null,
  workspaceRole: 'editor',
  sharedWorkspace: true,
});
const fakeApi = {} as unknown as TenancyApi;

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

describe('Team Members page layout', () => {
  it('the whole SV screen sits in the standard page container, not edge to edge', () => {
    expect(teamScreen).toMatch(/<div className="app team-screen">\s*<TeamView/);
    // The Tester profile uses the same container.
    expect(teamScreen).toMatch(/<div className="app team-screen">\s*<header className="app-header">\s*<div className="app-title-group">\s*<h1 id="my-profile-title">/);
    expect(rule('.app')).toMatch(/max-width:\s*1360px/);
  });

  it('has a standard page header with compact secondary metadata, and no second "Team Members" heading', () => {
    const html = renderToStaticMarkup(createElement(TeamView, { lang: 'en', principal: principal('admin'), api: fakeApi, onOpenSettings: () => undefined }));
    expect(html).toContain('<header class="app-header"><div class="app-title-group"><h1>Team Members</h1><p class="app-subtitle">');
    expect(html).toContain('Rakuten QA');
    // Exactly one visible "Team Members" heading: the local-storage notice heading is screen-reader-only.
    expect(html).not.toMatch(/<h2 id="team-local-title">/);
    expect(html).toMatch(/<h2 id="team-local-title" class="sr-only">/);
  });

  it('the Add Team Member form is inside a card, and the directory list is its own card', () => {
    const html = renderToStaticMarkup(createElement(TeamView, { lang: 'en', principal: principal('admin'), api: fakeApi, onOpenSettings: () => undefined }));
    const addCard = html.indexOf('dr-section team-add-card');
    const form = html.indexOf('<form');
    const listCard = html.indexOf('dr-section team-list-card');
    expect(addCard).toBeGreaterThan(-1);
    expect(form).toBeGreaterThan(addCard);
    expect(listCard).toBeGreaterThan(form);
    // The form keeps all its fields (display name, email, role) and its submit button.
    const formHtml = html.slice(form, html.indexOf('</form>'));
    for (const label of ['Display name', 'Email', 'Role']) expect(formHtml).toContain(label);
    expect(formHtml).toContain('type="submit"');
    // The member table scrolls inside its card.
    expect(teamDirectory).toMatch(/team-list-card[\s\S]*tenancy-table-wrap[\s\S]*<table className="tenancy-table">/);
    expect(rule('.team-list-card .tenancy-table-wrap')).toMatch(/overflow-x:\s*auto/);
  });

  it('the form no longer floats as a narrow box: it spans the card and flows in columns', () => {
    const form = rule('.team-add-card .tenancy-form');
    expect(form).toMatch(/max-width:\s*none/);
    expect(form).toMatch(/grid-template-columns:\s*repeat\(auto-fit/);
  });

  it('the nested members tab does not double the page padding', () => {
    expect(rule('.team-screen .app')).toMatch(/padding:\s*0/);
  });

  it('role behaviour is unchanged: a Tester sees only their own profile, with no management controls', () => {
    const html = renderToStaticMarkup(
      createElement(MyProfile, { lang: 'en', principal: principal('user'), members: [], projects: [], assignments: [] }),
    );
    expect(html).toContain('class="app team-screen"');
    expect(html).not.toContain('team-add-card');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('Add Team Member');
    // And an SV-only view refuses a Tester principal exactly as before.
    expect(renderToStaticMarkup(createElement(TeamView, { lang: 'en', principal: principal('user'), api: fakeApi, onOpenSettings: () => undefined }))).toBe('');
  });
});

describe('History page layout', () => {
  it('the shared History screen uses the standard container and page header (title + Refresh)', () => {
    expect(sharedHistory).toMatch(/<div className="app shared-history">\s*<header className="app-header">\s*<div className="app-title-group">\s*<h1>\{t\(lang, 'shared\.history\.title'\)\}<\/h1>/);
    expect(sharedHistory).toMatch(/<div className="app-header-actions">\s*<button[^>]*onClick=\{\(\) => void load\(\)\}/);
  });

  it('filters are grouped in a toolbar card; the table is in its own card inside a scroll container', () => {
    const toolbar = sharedHistory.indexOf('dr-section history-toolbar');
    const filters = sharedHistory.indexOf('role="search"');
    const tableCard = sharedHistory.indexOf('dr-section history-table-card');
    const wrap = sharedHistory.indexOf('table-wrap history-table-wrap');
    const table = sharedHistory.indexOf('<table className="dr-table">');
    expect(toolbar).toBeGreaterThan(-1);
    expect(filters).toBeGreaterThan(toolbar);
    expect(tableCard).toBeGreaterThan(filters);
    // The table is never a direct child of the page root: card -> scroll wrapper -> table.
    expect(wrap).toBeGreaterThan(tableCard);
    expect(table).toBeGreaterThan(wrap);
    // Existing actions and the pager stay.
    expect(sharedHistory).toContain("t(lang, 'shared.history.preview')");
    expect(sharedHistory).toContain("t(lang, 'shared.history.restore')");
    expect(sharedHistory).toContain('table-pager');
  });

  it('long "What" content wraps inside its cell and the table scrolls inside its own container', () => {
    expect(rule('.shared-history td')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.shared-history .history-table-wrap > .dr-table')).toMatch(/min-width:\s*720px/);
    expect(rule('.table-wrap')).toMatch(/overflow-x:\s*auto/);
    expect(rule('.shared-history .hist-actions')).toMatch(/white-space:\s*nowrap/);
  });

  it('the local Revision History uses the same container and page header, with its table in a scroll wrapper', () => {
    expect(revisionHistory).toMatch(/<div className="app revision-history">\s*<header className="app-header">\s*<div className="app-title-group">\s*<h1>\{t\(lang, 'history\.revisions\.title'\)\}<\/h1>/);
    expect(revisionHistory).toContain('<div className="table-wrap">');
    expect(revisionHistory).not.toContain('SectionCard');
  });

  it('the revision logic is untouched (restore, preview, export, retention wiring still present)', () => {
    for (const marker of ['createRestoreRevision', 'selectRevision', 'exportHistoryBackup', 'REVISION_HISTORY_RETENTION']) {
      expect(revisionHistory).toContain(marker);
    }
    for (const marker of ['SHARED_HISTORY_DAYS', '/api/revisions/', 'showPreview', 'HISTORY_PAGE_SIZES']) {
      expect(sharedHistory).toContain(marker);
    }
  });
});

describe('shared layout guarantees', () => {
  it('EN/JA parity holds for the new heading and the key sets match', () => {
    const en = dictionaries.en as Record<string, string>;
    const ja = dictionaries.ja as Record<string, string>;
    expect(en['dir.listTitle']).toBeTruthy();
    expect(ja['dir.listTitle']).toBeTruthy();
    expect(Object.keys(en).sort()).toEqual(Object.keys(ja).sort());
  });

  it('the terminology is unchanged: "Team Members" / テスター', () => {
    expect((dictionaries.en as Record<string, string>)['nav.team']).toBe('Team Members');
    expect((dictionaries.ja as Record<string, string>)['nav.team']).toBe('チームメンバー');
  });
});
