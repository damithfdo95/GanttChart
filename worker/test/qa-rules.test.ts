import { describe, expect, it } from 'vitest';
import { CYCLE_STATUSES, checkCycle, entryCompleted, executionEntryError, isIsoDate, projectExecutionError, qaCommitError, type CycleRecord } from '../../shared/qaRules';

const NOW = '2026-10-07T00:00:00.000Z';
const cycle = (over: Partial<CycleRecord> = {}): CycleRecord => ({
  id: 'cyc_a',
  name: 'Android 4.2.0 Release',
  status: 'planned',
  plannedStart: '2026-10-01',
  plannedEnd: '2026-10-31',
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const entry = (over: Record<string, unknown> = {}) => ({ id: 'e1', date: '2026-10-05', testers: 3, pass: 10, fail: 2, notApplicable: 0, spo: 0, blocked: 1, retest: 0, questioned: 0, overtimeMinutes: 0, ...over });
const project = (entries: Array<Record<string, unknown>>, over: Record<string, unknown> = {}, total = 100) =>
  JSON.stringify({ id: 'p1', projectId: 'PRJ-001', inputs: { totalCases: total, dailyExecuted: entries }, ...over });

describe('dates', () => {
  it('accepts real calendar dates only', () => {
    for (const ok of ['2026-02-28', '2028-02-29', '2026-12-31', '1999-01-01']) expect(isIsoDate(ok), ok).toBe(true);
    for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-1-1', '26-01-01', '2026-01-01T00:00', '', null, undefined, 20260101, '2027-02-29']) expect(isIsoDate(bad), String(bad)).toBe(false);
  });
});

describe('cycle records', () => {
  it('a normal cycle is valid in every status', () => {
    for (const status of CYCLE_STATUSES) expect(checkCycle(cycle({ status }))).toMatchObject({ ok: true });
    expect(checkCycle(cycle({ version: '4.2.0', description: 'RC validation', plannedStart: null, plannedEnd: null }))).toMatchObject({ ok: true });
    expect(checkCycle(cycle({ name: '日本語のリリース' }))).toMatchObject({ ok: true });
  });

  it('refuses what can never be a cycle', () => {
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ name: '' }, 'cycle_invalid_name'],
      [{ name: '   ' }, 'cycle_invalid_name'],
      [{ name: 'x'.repeat(121) }, 'cycle_invalid_name'],
      [{ name: 'a\u0000b' }, 'cycle_invalid_name'],
      [{ id: '' }, 'cycle_invalid_id'],
      [{ id: 'has space' }, 'cycle_invalid_id'],
      [{ status: 'done' }, 'cycle_invalid_status'],
      [{ plannedStart: '2026-02-30' }, 'cycle_invalid_date'],
      [{ plannedEnd: 'soon' }, 'cycle_invalid_date'],
      [{ plannedStart: '2026-11-01', plannedEnd: '2026-10-01' }, 'cycle_end_before_start'],
      [{ completedAt: 'never' }, 'cycle_invalid_completed_at'],
      [{ createdAt: 'x' }, 'cycle_invalid_timestamp'],
      [{ version: 'v'.repeat(61) }, 'cycle_invalid_version'],
      [{ description: 'd'.repeat(2001) }, 'cycle_invalid_description'],
    ];
    for (const [over, error] of bad) expect(checkCycle(cycle(over as Partial<CycleRecord>)), JSON.stringify(over)).toEqual({ ok: false, error });
    for (const junk of [null, 5, 'x', [], undefined]) expect(checkCycle(junk).ok).toBe(false);
  });

  it('a one-day cycle is fine; a start equal to the end is not "before"', () => {
    expect(checkCycle(cycle({ plannedStart: '2026-10-05', plannedEnd: '2026-10-05' })).ok).toBe(true);
  });
});

describe('daily execution entries', () => {
  it('accepts a normal entry, zeros, and fractional head counts', () => {
    expect(executionEntryError(entry())).toBeNull();
    expect(executionEntryError(entry({ pass: 0, fail: 0, blocked: 0 }))).toBeNull();
    expect(executionEntryError(entry({ testers: 2.5 }))).toBeNull();
    expect(executionEntryError(entry({ uncategorizedCompleted: 4 }))).toBeNull();
  });

  it('rejects negative, fractional, non-numeric and absurd counts and impossible dates', () => {
    for (const f of ['pass', 'fail', 'notApplicable', 'spo', 'blocked', 'retest', 'questioned']) {
      for (const bad of [-1, 1.5, NaN, Infinity, '3', null, 20_000_000]) expect(executionEntryError(entry({ [f]: bad })), `${f}=${String(bad)}`).toBe(`execution_entry_invalid_${f}`);
    }
    expect(executionEntryError(entry({ date: '2026-02-30' }))).toBe('execution_entry_invalid_date');
    expect(executionEntryError(entry({ date: 'today' }))).toBe('execution_entry_invalid_date');
    expect(executionEntryError(entry({ testers: -1 }))).toBe('execution_entry_invalid_testers');
    expect(executionEntryError(entry({ overtimeMinutes: 181 }))).toBe('execution_entry_invalid_overtimeMinutes');
    expect(executionEntryError(entry({ uncategorizedCompleted: -2 }))).toBe('execution_entry_invalid_uncategorizedCompleted');
    expect(executionEntryError(entry({ id: '' }))).toBe('execution_entry_invalid_id');
    expect(executionEntryError(null)).toBe('execution_entry_not_an_object');
  });

  it('counts completed as pass + fail + N/A + SPO + the migrated remainder (blocked is never completed)', () => {
    expect(entryCompleted(entry({ pass: 5, fail: 3, notApplicable: 2, spo: 1, uncategorizedCompleted: 4, blocked: 99 }))).toBe(15);
  });
});

describe('a changed project record', () => {
  it('only NEW or CHANGED entries are examined: old data is never refused for what it already holds', () => {
    const legacy = project([entry({ id: 'old', pass: -5 })]);
    expect(projectExecutionError(legacy, project([entry({ id: 'old', pass: -5 }), entry({ id: 'new', date: '2026-10-06' })]))).toBeNull();
    expect(projectExecutionError(legacy, project([entry({ id: 'old', pass: -4 })]))).toBe('execution_entry_invalid_pass');
  });

  it('refuses a bad new entry', () => {
    expect(projectExecutionError(project([]), project([entry({ pass: -1 })]))).toBe('execution_entry_invalid_pass');
    expect(projectExecutionError(project([]), project([entry({ fail: 1.5 })]))).toBe('execution_entry_invalid_fail');
    expect(projectExecutionError(project([]), project([entry({ date: '2026-13-01' })]))).toBe('execution_entry_invalid_date');
  });

  it('refuses a second entry for the same day, but tolerates a duplicate that already existed', () => {
    const one = project([entry({ id: 'a' })]);
    expect(projectExecutionError(one, project([entry({ id: 'a' }), entry({ id: 'b' })]))).toBe('execution_entry_duplicate_date');
    const already = project([entry({ id: 'a' }), entry({ id: 'b' })]);
    expect(projectExecutionError(already, project([entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c', date: '2026-10-06' })]))).toBeNull();
  });

  it('a change may not push completed cases above the planned total', () => {
    const base = project([entry({ id: 'a', pass: 60, fail: 20, blocked: 0 })], {}, 100); // 80 completed
    expect(projectExecutionError(base, project([entry({ id: 'a', pass: 60, fail: 20 }), entry({ id: 'b', date: '2026-10-06', pass: 20, fail: 0 })], {}, 100))).toBeNull(); // exactly 100
    expect(projectExecutionError(base, project([entry({ id: 'a', pass: 60, fail: 20 }), entry({ id: 'b', date: '2026-10-06', pass: 21, fail: 0 })], {}, 100))).toBe('executed_exceeds_planned');
    // blocked cases are an open-status tally, never "completed": they cannot exceed anything
    expect(projectExecutionError(base, project([entry({ id: 'a', pass: 60, fail: 20, blocked: 500 })], {}, 100))).toBeNull();
  });

  it('lowering the planned total below what was executed is NOT refused (history is preserved; the screen warns)', () => {
    const base = project([entry({ id: 'a', pass: 60, fail: 20 })], {}, 100);
    expect(projectExecutionError(base, project([entry({ id: 'a', pass: 60, fail: 20 })], {}, 50))).toBeNull();
    // ... and reducing an over-planned day is allowed, while increasing it further is not
    const over = project([entry({ id: 'a', pass: 60, fail: 20 })], {}, 50);
    expect(projectExecutionError(over, project([entry({ id: 'a', pass: 50, fail: 20 })], {}, 50))).toBeNull();
    expect(projectExecutionError(over, project([entry({ id: 'a', pass: 70, fail: 20 })], {}, 50))).toBe('executed_exceeds_planned');
  });

  it('a project that is new to the workspace (restore/import) is checked for shape but not refused for its totals', () => {
    expect(projectExecutionError(null, project([entry({ pass: 500 })], {}, 100))).toBeNull();
    expect(projectExecutionError(null, project([entry({ pass: -1 })], {}, 100))).toBe('execution_entry_invalid_pass');
  });

  it('refuses something that is not a project at all', () => {
    expect(projectExecutionError(null, '[]')).toBe('project_not_an_object');
    expect(projectExecutionError(null, 'nope')).toBe('project_not_an_object');
  });
});

describe('who may change what, and what may refer to what', () => {
  const store = (records: Record<string, string>) => ({
    get: (kind: string, id: string) => records[`${kind}:${id}`] ?? null,
    list: (kind: string) => Object.entries(records).filter(([k]) => k.startsWith(`${kind}:`)).map(([k, json]) => ({ id: k.slice(kind.length + 1), json })),
  });
  const commit = (role: 'admin' | 'editor' | 'viewer', puts: Array<{ kind: string; id: string; json: string }>, deletes: Array<{ kind: string; id: string }> = [], records: Record<string, string> = {}) =>
    qaCommitError({ role, userId: 'usr_t', today: '2026-10-07', puts, deletes, view: store(records) });
  const cycleJson = (over: Partial<CycleRecord> = {}) => JSON.stringify(cycle(over));

  it('only the Admin creates, edits or deletes cycles', () => {
    expect(commit('admin', [{ kind: 'cycle', id: 'cyc_a', json: cycleJson() }])).toBeNull();
    for (const role of ['editor', 'viewer'] as const) {
      // A Tester is stopped before the cycle rule is even reached: they may touch nothing but projects.
      expect(commit(role, [{ kind: 'cycle', id: 'cyc_a', json: cycleJson() }])).toBe('tester_cannot_change_kind');
      expect(commit(role, [], [{ kind: 'cycle', id: 'cyc_a' }])).toBe('tester_cannot_delete');
    }
  });

  it('a malformed cycle, or one whose id differs from its record id, is refused', () => {
    expect(commit('admin', [{ kind: 'cycle', id: 'cyc_a', json: cycleJson({ name: '' }) }])).toBe('cycle_invalid_name');
    expect(commit('admin', [{ kind: 'cycle', id: 'cyc_other', json: cycleJson() }])).toBe('cycle_id_mismatch');
    expect(commit('admin', [{ kind: 'cycle', id: 'cyc_a', json: 'nope' }])).toBe('cycle_not_an_object');
  });

  it('a project may only name a cycle of THIS workspace (existing, or created in the same commit)', () => {
    const records = { 'cycle:cyc_a': cycleJson() };
    expect(commit('admin', [{ kind: 'project', id: 'p1', json: project([], { cycleId: 'cyc_a' }) }], [], records)).toBeNull();
    expect(commit('admin', [{ kind: 'project', id: 'p1', json: project([], { cycleId: 'cyc_foreign' }) }], [], records)).toBe('project_cycle_not_found');
    expect(
      commit('admin', [
        { kind: 'cycle', id: 'cyc_new', json: cycleJson({ id: 'cyc_new' }) },
        { kind: 'project', id: 'p1', json: project([], { cycleId: 'cyc_new' }) },
      ]),
    ).toBeNull();
    expect(commit('admin', [{ kind: 'project', id: 'p1', json: project([], { cycleId: 5 }) }])).toBe('project_invalid_cycle');
  });

  it('only an SV moves a project between cycles or in/out of one; a Tester changing the cycle is refused', () => {
    const records = { 'cycle:cyc_a': cycleJson(), 'cycle:cyc_b': cycleJson({ id: 'cyc_b' }), 'project:p1': project([], { cycleId: 'cyc_a' }) };
    expect(commit('editor', [{ kind: 'project', id: 'p1', json: project([], { cycleId: 'cyc_b' }) }], [], records)).toBe('tester_project_structure');
    expect(commit('editor', [{ kind: 'project', id: 'p1', json: project([], { cycleId: null }) }], [], records)).toBe('tester_project_structure');
    expect(commit('admin', [{ kind: 'project', id: 'p1', json: project([entry()], { cycleId: 'cyc_a' }) }], [], records)).toBeNull(); // same cycle: an ordinary edit
    expect(commit('admin', [{ kind: 'project', id: 'p1', json: project([], { cycleId: 'cyc_b' }) }], [], records)).toBeNull();
    expect(commit('admin', [{ kind: 'project', id: 'p1', json: project([], {}) }], [], records)).toBeNull(); // taken out of its cycle
  });

  it('an archived cycle takes no new projects, but a project already in it can be edited', () => {
    const records = { 'cycle:cyc_a': cycleJson({ status: 'archived' }), 'project:p1': project([], { cycleId: 'cyc_a' }) };
    expect(commit('admin', [{ kind: 'project', id: 'p2', json: project([], { cycleId: 'cyc_a' }) }], [], records)).toBe('project_cycle_archived');
    expect(commit('admin', [{ kind: 'project', id: 'p1', json: project([entry()], { cycleId: 'cyc_a' }) }], [], records)).toBeNull();
  });

  it('a project from before cycles existed (no cycleId) is simply valid', () => {
    expect(commit('admin', [{ kind: 'project', id: 'p1', json: project([entry()]) }], [], { 'project:p1': project([]) })).toBeNull();
  });

  const assignment = (over: Record<string, unknown> = {}) => JSON.stringify({ id: 'a1', projectId: 'PRJ-001', userId: 'usr_x', testerName: 'Hana', startDate: '2026-10-01', active: true, ...over });

  it('an assignment of a Tester ACCOUNT can never be created through the sync channel, only by the server', () => {
    expect(commit('admin', [{ kind: 'assignment', id: 'a1', json: assignment() }])).toBe('assignment_requires_api');
    expect(commit('editor', [{ kind: 'assignment', id: 'a1', json: assignment() }])).toBe('tester_cannot_change_kind');
  });

  it('once it exists only the Admin edits or removes it, and its project and account never change', () => {
    const records = { 'assignment:a1': assignment() };
    expect(commit('admin', [{ kind: 'assignment', id: 'a1', json: assignment({ active: false, endDate: '2026-10-10' }) }], [], records)).toBeNull();
    expect(commit('editor', [{ kind: 'assignment', id: 'a1', json: assignment({ active: false }) }], [], records)).toBe('tester_cannot_change_kind');
    expect(commit('admin', [{ kind: 'assignment', id: 'a1', json: assignment({ userId: 'usr_y' }) }], [], records)).toBe('assignment_immutable_fields');
    expect(commit('admin', [{ kind: 'assignment', id: 'a1', json: assignment({ projectId: 'PRJ-002' }) }], [], records)).toBe('assignment_immutable_fields');
    expect(commit('admin', [], [{ kind: 'assignment', id: 'a1' }], records)).toBeNull();
    expect(commit('editor', [], [{ kind: 'assignment', id: 'a1' }], records)).toBe('tester_cannot_delete');
    expect(commit('admin', [{ kind: 'assignment', id: 'a1', json: assignment({ userId: 5 }) }], [], records)).toBe('assignment_invalid_user');
  });

  it('roster (member-based) assignments are untouched by these rules', () => {
    const legacy = JSON.stringify({ id: 'a2', projectId: 'PRJ-001', memberId: 'USER0003', startDate: '2026-10-01', active: true });
    expect(commit('admin', [{ kind: 'assignment', id: 'a2', json: legacy }])).toBeNull();
    expect(commit('admin', [], [{ kind: 'assignment', id: 'a2' }], { 'assignment:a2': legacy })).toBeNull();
  });

  it('an invalid execution entry inside a project is refused with the reason', () => {
    expect(commit('admin', [{ kind: 'project', id: 'p1', json: project([entry({ pass: -3 })]) }], [], { 'project:p1': project([]) })).toBe('execution_entry_invalid_pass');
  });
});
