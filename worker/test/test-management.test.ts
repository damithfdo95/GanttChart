import { describe, expect, it } from 'vitest';
import { qaCommitError } from '../../shared/qaRules';
import { caseResultId, isAssignedToScope } from '../../shared/testManagement';

/** Scopes, test cases and results: the server-side commit rules as pure functions over an in-memory workspace. */

const NOW = '2026-10-07T09:00:00.000Z';
const TODAY = '2026-10-07';
const P = 'PRJ-001';

type Records = Record<string, string>;
const view = (records: Records) => ({
  get: (kind: string, id: string) => records[`${kind}:${id}`] ?? null,
  list: (kind: string) => Object.entries(records).filter(([k]) => k.startsWith(`${kind}:`)).map(([k, json]) => ({ id: k.slice(kind.length + 1), json })),
});

const project = (stable = P, id = 'proj-1') => JSON.stringify({ id, projectId: stable, nameEn: 'Android', inputs: { totalCases: 10 } });
const scope = (over: Record<string, unknown> = {}) => ({ id: 'scp_1', projectId: P, name: 'Ecosystem', code: 'ECO', status: 'active', order: 10, createdAt: NOW, updatedAt: NOW, ...over });
const tcase = (over: Record<string, unknown> = {}) => ({ id: 'tc_1', projectId: P, scopeId: 'scp_1', key: 'ECO-001', title: 'Login', priority: 'high', status: 'active', order: 10, createdAt: NOW, updatedAt: NOW, ...over });
const result = (over: Record<string, unknown> = {}) => ({ id: caseResultId('tc_1'), projectId: P, scopeId: 'scp_1', testCaseId: 'tc_1', status: 'pass', retest: false, question: false, executedByUserId: 'usr_a', executedAt: NOW, updatedByUserId: 'usr_a', updatedAt: NOW, ...over });
const assignment = (over: Record<string, unknown> = {}) => ({ id: 'a1', projectId: P, userId: 'usr_a', startDate: '2026-10-01', active: true, ...over });

const J = JSON.stringify;
const put = (kind: string, id: string, value: unknown) => ({ kind, id, json: J(value) });

const world = (over: Records = {}): Records => ({
  'project:proj-1': project(),
  [`scope:scp_1`]: J(scope()),
  [`testCase:tc_1`]: J(tcase()),
  'assignment:a1': J(assignment()),
  ...over,
});

const run = (role: 'admin' | 'editor' | 'viewer', puts: Array<{ kind: string; id: string; json: string }>, records: Records = world(), deletes: Array<{ kind: string; id: string }> = [], userId = 'usr_a') =>
  qaCommitError({ role, userId, today: TODAY, puts, deletes, view: view(records) });

describe('scopes', () => {
  const none: Records = { 'project:proj-1': project() };

  it('an SV creates a scope for a project of THIS workspace (also in the same commit as the project)', () => {
    expect(run('admin', [put('scope', 'scp_9', scope({ id: 'scp_9', code: 'HTMA' }))])).toBeNull();
    expect(run('admin', [put('scope', 'scp_9', scope({ id: 'scp_9', projectId: 'PRJ-404' }))], none)).toBe('scope_project_not_found');
    expect(run('admin', [put('project', 'proj-2', JSON.parse(project('PRJ-002', 'proj-2'))), put('scope', 'scp_9', scope({ id: 'scp_9', projectId: 'PRJ-002', code: 'NEW' }))], none)).toBeNull();
  });

  it('refuses malformed scopes with a reason', () => {
    expect(run('admin', [put('scope', 'scp_9', scope({ id: 'scp_9', name: '' }))])).toBe('scope_invalid_name');
    expect(run('admin', [put('scope', 'scp_9', scope({ id: 'scp_9', code: 'bad code' }))])).toBe('scope_invalid_code');
    expect(run('admin', [put('scope', 'scp_9', scope({ id: 'scp_9', status: 'deleted' }))])).toBe('scope_invalid_status');
    expect(run('admin', [put('scope', 'scp_other', scope({ id: 'scp_9' }))])).toBe('scope_id_mismatch');
    expect(run('admin', [{ kind: 'scope', id: 'scp_9', json: 'nope' }])).toBe('scope_not_an_object');
  });

  it('a code is unique within a project but may repeat in another', () => {
    expect(run('admin', [put('scope', 'scp_9', scope({ id: 'scp_9', code: 'ECO' }))])).toBe('scope_code_taken');
    expect(run('admin', [put('scope', 'scp_9', scope({ id: 'scp_9', code: 'ECO', projectId: 'PRJ-002' })), put('project', 'proj-2', JSON.parse(project('PRJ-002', 'proj-2')))])).toBeNull();
    expect(run('admin', [put('scope', 'scp_8', scope({ id: 'scp_8', code: 'X' })), put('scope', 'scp_9', scope({ id: 'scp_9', code: 'X' }))])).toBe('scope_code_taken');
    // editing a scope does not clash with itself
    expect(run('admin', [put('scope', 'scp_1', scope({ name: 'Renamed' }))])).toBeNull();
  });

  it('a scope never changes project; it can be archived and reactivated', () => {
    expect(run('admin', [put('scope', 'scp_1', scope({ projectId: 'PRJ-002' }))])).toBe('scope_project_immutable');
    expect(run('admin', [put('scope', 'scp_1', scope({ status: 'archived' }))])).toBeNull();
  });

  it('only an SV administers scopes: a Tester is refused before anything else', () => {
    expect(run('editor', [put('scope', 'scp_9', scope({ id: 'scp_9', code: 'HTMA' }))])).toBe('tester_cannot_change_kind');
    expect(run('viewer', [put('scope', 'scp_1', scope({ name: 'Hijack' }))])).toBe('tester_cannot_change_kind');
    expect(run('editor', [], world(), [{ kind: 'scope', id: 'scp_1' }])).toBe('tester_cannot_delete');
  });
});

describe('test cases', () => {
  it('an SV creates a case in a scope of the same project; a scope and its cases can arrive in one commit', () => {
    expect(run('admin', [put('testCase', 'tc_2', tcase({ id: 'tc_2', key: 'ECO-002' }))])).toBeNull();
    expect(run('admin', [put('scope', 'scp_2', scope({ id: 'scp_2', code: 'HTMA' })), put('testCase', 'tc_9', tcase({ id: 'tc_9', scopeId: 'scp_2', key: 'HTMA-001' }))])).toBeNull();
  });

  it('refuses a missing scope, a scope of another project, an archived scope and malformed fields', () => {
    expect(run('admin', [put('testCase', 'tc_2', tcase({ id: 'tc_2', key: 'ECO-002', scopeId: 'scp_404' }))])).toBe('testcase_scope_not_found');
    const other = world({ 'scope:scp_2': J(scope({ id: 'scp_2', projectId: 'PRJ-002', code: 'ZZ' })) });
    expect(run('admin', [put('testCase', 'tc_2', tcase({ id: 'tc_2', key: 'ECO-002', scopeId: 'scp_2' }))], other)).toBe('testcase_scope_project_mismatch');
    expect(run('admin', [put('testCase', 'tc_2', tcase({ id: 'tc_2', key: 'ECO-002' }))], world({ 'scope:scp_1': J(scope({ status: 'archived' })) }))).toBe('testcase_scope_archived');
    expect(run('admin', [put('testCase', 'tc_2', tcase({ id: 'tc_2', key: 'not a key' }))])).toBe('testcase_invalid_key');
    expect(run('admin', [put('testCase', 'tc_2', tcase({ id: 'tc_2', key: 'ECO-002', title: '' }))])).toBe('testcase_invalid_title');
    expect(run('admin', [put('testCase', 'tc_2', tcase({ id: 'tc_2', key: 'ECO-002', priority: 'urgent' }))])).toBe('testcase_invalid_priority');
    expect(run('admin', [put('testCase', 'tc_other', tcase({ id: 'tc_2', key: 'ECO-002' }))])).toBe('testcase_id_mismatch');
  });

  it('a key is unique within the project (any scope, archived too), including inside one commit', () => {
    expect(run('admin', [put('testCase', 'tc_2', tcase({ id: 'tc_2' }))])).toBe('testcase_key_taken');
    expect(run('admin', [put('testCase', 'tc_2', tcase({ id: 'tc_2', key: 'ECO-001', scopeId: 'scp_1' }))], world({ 'testCase:tc_1': J(tcase({ status: 'archived' })) }))).toBe('testcase_key_taken');
    expect(run('admin', [put('testCase', 'tc_2', tcase({ id: 'tc_2', key: 'ECO-002' })), put('testCase', 'tc_3', tcase({ id: 'tc_3', key: 'ECO-002' }))])).toBe('testcase_key_taken');
    expect(run('admin', [put('testCase', 'tc_2', tcase({ id: 'tc_2', key: 'ECO-002', projectId: 'PRJ-002', scopeId: 'scp_2' }))], world({ 'scope:scp_2': J(scope({ id: 'scp_2', projectId: 'PRJ-002', code: 'ZZ' })) }))).toBeNull(); // another project's namespace
  });

  it('the key, the scope and the project of a case never change; the rest can', () => {
    expect(run('admin', [put('testCase', 'tc_1', tcase({ key: 'ECO-777' }))])).toBe('testcase_key_immutable');
    expect(run('admin', [put('testCase', 'tc_1', tcase({ scopeId: 'scp_2' }))], world({ 'scope:scp_2': J(scope({ id: 'scp_2', code: 'ZZ' })) }))).toBe('testcase_scope_immutable');
    expect(run('admin', [put('testCase', 'tc_1', tcase({ title: 'Better title', status: 'archived' }))])).toBeNull();
  });

  it('a large bulk add (500 cases) is one valid commit, and one duplicate inside it refuses the whole commit', () => {
    const many = Array.from({ length: 500 }, (_, i) => put('testCase', `tc_b${i}`, tcase({ id: `tc_b${i}`, key: `ECO-${100 + i}` })));
    expect(run('admin', many)).toBeNull();
    const dup = [...many.slice(0, 499), put('testCase', 'tc_dup', tcase({ id: 'tc_dup', key: 'ECO-100' }))];
    expect(run('admin', dup)).toBe('testcase_key_taken');
  });

  it('a Tester can never create, edit or archive a case', () => {
    expect(run('editor', [put('testCase', 'tc_2', tcase({ id: 'tc_2', key: 'ECO-002' }))])).toBe('tester_cannot_change_kind');
    expect(run('editor', [put('testCase', 'tc_1', tcase({ status: 'archived' }))])).toBe('tester_cannot_change_kind');
  });
});

describe('results (SV)', () => {
  it('an SV records a result as themselves', () => {
    expect(run('admin', [put('caseResult', caseResultId('tc_1'), result())])).toBeNull();
  });

  it('the actor is the account the server knows, whatever the message says', () => {
    expect(run('admin', [put('caseResult', caseResultId('tc_1'), result({ updatedByUserId: 'usr_someone_else' }))])).toBe('result_actor_mismatch');
    expect(run('admin', [put('caseResult', caseResultId('tc_1'), result({ executedByUserId: 'usr_someone_else' }))])).toBe('result_actor_mismatch');
    expect(run('admin', [put('caseResult', caseResultId('tc_1'), result({ updatedByUserId: null }))])).toBe('result_actor_mismatch');
  });

  it('a result must belong to an existing case, with the same project and scope', () => {
    expect(run('admin', [put('caseResult', caseResultId('tc_404'), result({ id: caseResultId('tc_404'), testCaseId: 'tc_404' }))])).toBe('result_case_not_found');
    expect(run('admin', [put('caseResult', caseResultId('tc_1'), result({ scopeId: 'scp_9' }))])).toBe('result_case_mismatch');
    expect(run('admin', [put('caseResult', caseResultId('tc_1'), result({ projectId: 'PRJ-002' }))])).toBe('result_case_mismatch');
    expect(run('admin', [put('caseResult', 'res_wrong', result())])).toBe('result_id_mismatch');
    expect(run('admin', [put('caseResult', 'x', result({ id: 'x' }))])).toBe('result_invalid_id');
  });

  it('validates the fields: status, flags, lengths', () => {
    expect(run('admin', [put('caseResult', caseResultId('tc_1'), result({ status: 'done' }))])).toBe('result_invalid_status');
    expect(run('admin', [put('caseResult', caseResultId('tc_1'), result({ retest: 'yes' }))])).toBe('result_invalid_flag');
    expect(run('admin', [put('caseResult', caseResultId('tc_1'), result({ memo: 'x'.repeat(501) }))])).toBe('result_invalid_memo');
    expect(run('admin', [put('caseResult', caseResultId('tc_1'), result({ device: 'x'.repeat(81) }))])).toBe('result_invalid_device');
  });

  it('no new result in an archived scope or for an archived case; an unchanged one is not an error', () => {
    const archivedScope = world({ 'scope:scp_1': J(scope({ status: 'archived' })) });
    expect(run('admin', [put('caseResult', caseResultId('tc_1'), result())], archivedScope)).toBe('result_scope_archived');
    const archivedCase = world({ 'testCase:tc_1': J(tcase({ status: 'archived' })) });
    expect(run('admin', [put('caseResult', caseResultId('tc_1'), result())], archivedCase)).toBe('result_case_archived');
    const existing = world({ [`caseResult:${caseResultId('tc_1')}`]: J(result()), 'scope:scp_1': J(scope({ status: 'archived' })) });
    expect(run('admin', [put('caseResult', caseResultId('tc_1'), result())], existing)).toBeNull(); // nothing changes
  });

  it('a result never moves to another case, scope or project', () => {
    const existing = world({ [`caseResult:${caseResultId('tc_1')}`]: J(result()), 'scope:scp_2': J(scope({ id: 'scp_2', code: 'ZZ' })) });
    expect(run('admin', [put('caseResult', caseResultId('tc_1'), result({ scopeId: 'scp_2' }))], existing)).toBe('result_case_mismatch');
  });
});

describe('results (Tester)', () => {
  const asTester = (puts: Array<{ kind: string; id: string; json: string }>, records: Records = world(), userId = 'usr_a') => run('editor', puts, records, [], userId);
  const mine = () => put('caseResult', caseResultId('tc_1'), result());

  it('a Tester records a result on a case of a project they are assigned to (project-level = every scope)', () => {
    expect(asTester([mine()])).toBeNull();
  });

  it('a scope-level assignment covers only that scope', () => {
    const scoped = world({ 'assignment:a1': J(assignment({ scopeId: 'scp_1' })) });
    expect(asTester([mine()], scoped)).toBeNull();
    const elsewhere = world({ 'assignment:a1': J(assignment({ scopeId: 'scp_2' })) });
    expect(asTester([mine()], elsewhere)).toBe('tester_result_not_assigned');
  });

  it('not assigned, assigned to another project, ended, not started, inactive, someone else’s: refused', () => {
    expect(asTester([mine()], world({ 'assignment:a1': J(assignment({ userId: 'usr_b' })) }))).toBe('tester_result_not_assigned');
    expect(asTester([mine()], world({ 'assignment:a1': J(assignment({ projectId: 'PRJ-002' })) }))).toBe('tester_result_not_assigned');
    expect(asTester([mine()], world({ 'assignment:a1': J(assignment({ endDate: '2026-10-06' })) }))).toBe('tester_result_not_assigned');
    expect(asTester([mine()], world({ 'assignment:a1': J(assignment({ startDate: '2026-10-08' })) }))).toBe('tester_result_not_assigned');
    expect(asTester([mine()], world({ 'assignment:a1': J(assignment({ active: false })) }))).toBe('tester_result_not_assigned');
    const { 'assignment:a1': _gone, ...none } = world();
    expect(asTester([mine()], none)).toBe('tester_result_not_assigned');
    // a roster/name assignment is not an account
    expect(asTester([mine()], world({ 'assignment:a1': J({ id: 'a1', projectId: P, memberId: 'USER0001', startDate: '2026-10-01', active: true }) }))).toBe('tester_result_not_assigned');
  });

  it('an archived scope or case refuses the Tester too', () => {
    expect(asTester([mine()], world({ 'scope:scp_1': J(scope({ status: 'archived' })) }))).toBe('result_scope_archived');
    expect(asTester([mine()], world({ 'testCase:tc_1': J(tcase({ status: 'archived' })) }))).toBe('result_case_archived');
  });

  it('a Tester cannot record as someone else, and cannot delete a result', () => {
    expect(asTester([put('caseResult', caseResultId('tc_1'), result({ updatedByUserId: 'usr_b', executedByUserId: 'usr_b' }))])).toBe('result_actor_mismatch');
    expect(run('editor', [], world({ [`caseResult:${caseResultId('tc_1')}`]: J(result()) }), [{ kind: 'caseResult', id: caseResultId('tc_1') }])).toBe('tester_cannot_delete');
  });

  it('a Tester cannot name a case of a scope they are not on by pointing the result at another scope', () => {
    const rec = world({ 'assignment:a1': J(assignment({ scopeId: 'scp_2' })), 'scope:scp_2': J(scope({ id: 'scp_2', code: 'ZZ' })) });
    expect(asTester([put('caseResult', caseResultId('tc_1'), result({ scopeId: 'scp_2' }))], rec)).toBe('result_case_mismatch');
  });

  it('a read-only member behaves as a Tester here (and cannot commit at all upstream)', () => {
    expect(run('viewer', [mine()], world({ 'assignment:a1': J(assignment({ userId: 'usr_b' })) }))).toBe('tester_result_not_assigned');
  });

  it('the assignment test is shared with the browser', () => {
    const list = [assignment({ scopeId: 'scp_1' })];
    expect(isAssignedToScope(list, 'usr_a', P, 'scp_1', TODAY)).toBe(true);
    expect(isAssignedToScope(list, 'usr_a', P, 'scp_2', TODAY)).toBe(false);
    expect(isAssignedToScope(list, 'usr_b', P, 'scp_1', TODAY)).toBe(false);
  });
});

describe('deleting', () => {
  it('a scope with cases, or a case with a result, cannot be deleted - archive instead', () => {
    expect(run('admin', [], world(), [{ kind: 'scope', id: 'scp_1' }])).toBe('scope_has_cases');
    const withResult = world({ [`caseResult:${caseResultId('tc_1')}`]: J(result()) });
    expect(run('admin', [], withResult, [{ kind: 'testCase', id: 'tc_1' }])).toBe('testcase_has_results');
  });

  it('a never-executed case can go, a scope goes once its cases are gone (even in the same commit)', () => {
    expect(run('admin', [], world(), [{ kind: 'testCase', id: 'tc_1' }])).toBeNull();
    expect(run('admin', [], world(), [{ kind: 'testCase', id: 'tc_1' }, { kind: 'scope', id: 'scp_1' }])).toBeNull();
  });

  it('deleting a project takes its scopes, cases and results with it; so does cleaning up after it', () => {
    const withResult = world({ [`caseResult:${caseResultId('tc_1')}`]: J(result()) });
    const all = [{ kind: 'project', id: 'proj-1' }, { kind: 'scope', id: 'scp_1' }, { kind: 'testCase', id: 'tc_1' }, { kind: 'caseResult', id: caseResultId('tc_1') }];
    expect(run('admin', [], withResult, all)).toBeNull();
    // the project went in an earlier commit: the leftovers are orphans and may be cleaned up
    const { 'project:proj-1': _p, ...orphans } = withResult;
    expect(run('admin', [], orphans, [{ kind: 'testCase', id: 'tc_1' }])).toBeNull();
    expect(run('admin', [], orphans, [{ kind: 'scope', id: 'scp_1' }])).toBeNull();
  });

  it('an SV may reset a result; a Tester never may', () => {
    const withResult = world({ [`caseResult:${caseResultId('tc_1')}`]: J(result()) });
    expect(run('admin', [], withResult, [{ kind: 'caseResult', id: caseResultId('tc_1') }])).toBeNull();
    expect(run('editor', [], withResult, [{ kind: 'caseResult', id: caseResultId('tc_1') }])).toBe('tester_cannot_delete');
  });
});

describe('assignments with a scope', () => {
  it('the scope of an account assignment cannot change afterwards, and the server alone creates it', () => {
    const rec = world({ 'assignment:a1': J(assignment({ scopeId: 'scp_1' })) });
    expect(run('admin', [put('assignment', 'a1', assignment({ scopeId: 'scp_2' }))], rec)).toBe('assignment_immutable_fields');
    expect(run('admin', [put('assignment', 'a1', assignment({ scopeId: 'scp_1', active: false, endDate: TODAY }))], rec)).toBeNull();
    expect(run('admin', [put('assignment', 'a9', assignment({ id: 'a9', scopeId: 'scp_1' }))], rec)).toBe('assignment_requires_api');
  });
});
