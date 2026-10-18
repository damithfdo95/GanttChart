import { describe, expect, it } from 'vitest';
import { SEARCH_MAX_TOTAL } from '../lib/jira/useJiraSearch';
import screen from '../features/jira/JiraScreen.tsx?raw';

describe('JIRA tab guards (source-level)', () => {
  it('Fetch is blocked, in the button and in the handler, when "all mapped" has nothing mapped', () => {
    expect(screen).toMatch(/const noMappedScope = scope === SCOPE_ALL_MAPPED && mappedProjects\.length === 0/);
    expect(screen).toMatch(/disabled=\{loading \|\| dateRangeInvalid \|\| noMappedScope\}/);
    expect(screen).toMatch(/if \(dateRangeInvalid \|\| noMappedScope\) return;/);
  });

  it('tells the person when the shown results are older than the filters', () => {
    expect(screen).toMatch(/fetchedJql !== jql/);
    expect(screen).toContain("'jira.tab.staleResults'");
  });

  it('derives the cap note from the shared search cap, not a literal', () => {
    expect(screen).toContain('analysis.totals.fetched >= SEARCH_MAX_TOTAL');
    expect(SEARCH_MAX_TOTAL).toBe(500);
  });
});
