import { describe, expect, it } from 'vitest';
import { qaCommitError } from '../../shared/qaRules';
import { SV_ONLY_KINDS } from '../../shared/testerRules';
import { reportPublicationCommitError } from '../../shared/reportPublication';

/** Publication of a finalized Daily Report through the shared commit checks, exercised without any runtime. */

const J = JSON.stringify;
const finalized = (over: Record<string, unknown> = {}) => ({
  id: 'rep-1', reportDate: '2026-10-25', language: 'en', status: 'FINALIZED', previewText: 'Hello', activities: [], nextDay: [], finalizedAt: '2026-10-25T09:00:00.000Z', finalizedBy: 'Sup', updatedAt: '2026-10-25T09:00:00.000Z', ...over,
});
const published = (over: Record<string, unknown> = {}) => finalized({ publicationStatus: 'published', publishedAt: '2026-10-26T01:00:00.000Z', publishedByUserId: 'usr_1', publicationMethod: 'manualCopy', updatedAt: '2026-10-26T01:00:00.000Z', ...over });
const world = (records: Record<string, object>) => ({ get: (kind: string, id: string) => (records[`${kind}:${id}`] === undefined ? null : J(records[`${kind}:${id}`])), list: () => [] });
const run = (puts: Array<{ kind: string; id: string; json: string }>, view = world({}), role: 'admin' | 'editor' = 'admin') =>
  qaCommitError({ role, puts, deletes: [], view, userId: 'usr_1', today: '2026-10-26' });
const put = (record: object) => [{ kind: 'report', id: 'rep-1', json: J(record) }];

describe('report publication on the server', () => {
  it('an SV can publish a finalized report; nothing but the publication metadata may change', () => {
    const view = world({ 'report:rep-1': finalized() });
    expect(run(put(published()), view)).toBeNull();
    expect(run(put(published({ previewText: 'Edited' })), view)).toBe('report_publication_changes_content');
  });

  it('refuses invalid metadata, a draft, an unpublish and a re-stamp', () => {
    const view = world({ 'report:rep-1': finalized() });
    expect(run(put(published({ publicationMethod: 'slack' })), view)).toBe('report_publication_invalid_method');
    expect(run(put(published({ publishedAt: 'soon' })), view)).toBe('report_publication_invalid_time');
    expect(run(put(published({ publishedByUserId: 'http://x.example' })), view)).toBe('report_publication_invalid_actor');
    expect(run(put(published({ status: 'DRAFT' })), world({ 'report:rep-1': finalized({ status: 'DRAFT' }) }))).toBe('report_publication_draft');
    const already = world({ 'report:rep-1': published() });
    expect(run(put(finalized()), already)).toBe('report_publication_immutable');
    expect(run(put(published({ publishedAt: '2026-11-01T00:00:00.000Z' })), already)).toBe('report_publication_immutable');
    expect(run(put(published()), already)).toBeNull();
  });

  it('only an SV publishes: the publication rule itself refuses anyone else, and a Tester is refused outright', () => {
    const view = world({ 'report:rep-1': finalized() });
    expect(reportPublicationCommitError({ puts: put(published()), view, isSv: false })).toBe('report_publication_sv_only');
    expect(reportPublicationCommitError({ puts: put(published()), view, isSv: true })).toBeNull();
    expect(run(put(published()), view, 'editor')).not.toBeNull();
  });

  it('older reports without publication fields keep committing, and reports stay a Tester-invisible kind', () => {
    expect(run(put(finalized({ previewText: 'older edit' })), world({ 'report:rep-1': finalized() }))).toBeNull();
    expect(SV_ONLY_KINDS.has('report')).toBe(true);
  });
});
