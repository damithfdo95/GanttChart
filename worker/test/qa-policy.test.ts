import { describe, expect, it } from 'vitest';
import { qaCommitError } from '../../shared/qaRules';
import { QA_WORK_TYPES, defaultQaPolicy, qaPolicyError } from '../../shared/qaPolicy';
import { checkScope } from '../../shared/testManagement';

/** The QA policy and the QA work type are shared management data: the server validates both and only an SV may write the policy. */

const TODAY = '2026-10-07';
type Records = Record<string, string>;
const view = (records: Records) => ({
  get: (kind: string, id: string) => records[`${kind}:${id}`] ?? null,
  list: (kind: string) => Object.entries(records).filter(([k]) => k.startsWith(`${kind}:`)).map(([k, json]) => ({ id: k.slice(kind.length + 1), json })),
});
const J = JSON.stringify;
const settings = (over: Record<string, unknown> = {}) => ({ teams: [], holidays: [], supervisorName: '', projectJiraUrl: '', templates: { en: '', ja: '' }, progressRules: { working: 'totalCases', complete: 'totalCases' }, ...over });
const writeSettings = (role: 'admin' | 'editor' | 'viewer', json: string, records: Records = {}) =>
  qaCommitError({ role, userId: 'usr_a', today: TODAY, puts: [{ kind: 'settings', id: 'settings', json }], deletes: [], view: view(records) });
const scope = (over: Record<string, unknown> = {}) => ({ id: 'scp_1', projectId: 'PRJ-001', name: 'Regression', status: 'active', order: 10, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over });
const world: Records = { 'project:p1': J({ id: 'p1', projectId: 'PRJ-001', inputs: {} }) };

describe('QA policy on the server', () => {
  it('an SV may save a valid policy; absence (the default) is fine too', () => {
    expect(writeSettings('admin', J(settings({ qaPolicy: { ...defaultQaPolicy(), failedCases: 'blocked' } })))).toBeNull();
    expect(writeSettings('admin', J(settings()))).toBeNull();
  });

  it('rejects unknown keys, values, versions and oversized payloads', () => {
    const d = defaultQaPolicy();
    for (const bad of [{ ...d, extra: 1 }, { ...d, version: 9 }, { ...d, blockedCases: 'later' }, { ...d, blockingDefectSeverities: ['Nope'] }, { ...d, unresolvedDefectStatuses: Array(50).fill('Open') }, 'text', []]) {
      expect(writeSettings('admin', J(settings({ qaPolicy: bad }))), J(bad)).toBe('settings_invalid_qa_policy');
    }
    expect(qaPolicyError({ ...d, blockingDefectSeverities: ['Critical'], note: 'x'.repeat(2000) })).toBe('settings_invalid_qa_policy');
  });

  it('a Tester cannot write the settings record at all, so cannot change the policy', () => {
    expect(writeSettings('editor', J(settings({ qaPolicy: defaultQaPolicy() })))).toBe('tester_cannot_change_kind');
    expect(writeSettings('viewer', J(settings({ qaPolicy: { ...defaultQaPolicy(), defectsAction: 'atRisk' } })))).toBe('tester_cannot_change_kind');
  });

  it('is workspace data: the check looks only at the record being written, with no cross-workspace state', () => {
    // Two workspaces are two independent stores; a policy accepted for one says nothing about the other.
    expect(writeSettings('admin', J(settings({ qaPolicy: { ...defaultQaPolicy(), blockedCases: 'blocked' } })), world)).toBeNull();
    expect(writeSettings('admin', J(settings({ qaPolicy: { ...defaultQaPolicy(), blockedCases: 'nope' } })), world)).toBe('settings_invalid_qa_policy');
  });
});

describe('QA work type on the server', () => {
  it('every built-in type is a valid scope field; unknown types are refused; scopes without one stay valid', () => {
    for (const w of QA_WORK_TYPES) {
      expect(checkScope(scope({ workType: w })).ok, w).toBe(true);
      expect(qaCommitError({ role: 'admin', userId: 'usr_a', today: TODAY, puts: [{ kind: 'scope', id: 'scp_1', json: J(scope({ workType: w })) }], deletes: [], view: view(world) })).toBeNull();
    }
    expect(checkScope(scope())).toMatchObject({ ok: true });
    expect(checkScope(scope({ workType: 'weekly' }))).toMatchObject({ ok: false, error: 'scope_invalid_work_type' });
    expect(qaCommitError({ role: 'admin', userId: 'usr_a', today: TODAY, puts: [{ kind: 'scope', id: 'scp_1', json: J(scope({ workType: 5 })) }], deletes: [], view: view(world) })).toBe('scope_invalid_work_type');
  });

  it('a Tester cannot set or change a scope (and so its work type)', () => {
    expect(qaCommitError({ role: 'editor', userId: 'usr_a', today: TODAY, puts: [{ kind: 'scope', id: 'scp_1', json: J(scope({ workType: 'sanity' })) }], deletes: [], view: view(world) })).toBe('tester_cannot_change_kind');
  });
});
