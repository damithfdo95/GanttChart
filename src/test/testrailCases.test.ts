import { describe, expect, it } from 'vitest';
import { mapTestRailPriority, planTestRailCaseImport, existingTestRailCaseIds } from '../domain/testManagement/testrailCases';
import type { TestCase } from '../../shared/testManagement';
import type { TestRailCaseRow } from '../../shared/testrail';

// ---- fixtures ---------------------------------------------------------------

const caseRow = (over: Partial<TestRailCaseRow> = {}): TestRailCaseRow => ({
  caseId: 101,
  title: 'Login with existing account',
  ...(over.priorityName !== undefined ? { priorityName: over.priorityName } : {}),
  ...(over.typeName !== undefined ? { typeName: over.typeName } : {}),
  ...over,
});

const existingCase = (over: Partial<TestCase> = {}): TestCase => ({
  id: 'tc_1',
  projectId: 'PRJ-001',
  scopeId: 'sc_1',
  key: 'ECO-001',
  title: 'Existing case',
  priority: 'medium',
  status: 'active',
  order: 10,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

// ---- tests ------------------------------------------------------------------

describe('mapTestRailPriority', () => {
  it('maps TestRail priority names to case priorities', () => {
    expect(mapTestRailPriority('Critical')).toBe('critical');
    expect(mapTestRailPriority('High')).toBe('high');
    expect(mapTestRailPriority('Medium')).toBe('medium');
    expect(mapTestRailPriority('Low')).toBe('low');
  });

  it('falls back to medium for unknown or missing priorities', () => {
    expect(mapTestRailPriority(undefined)).toBe('medium');
    expect(mapTestRailPriority('Exotic')).toBe('medium');
    expect(mapTestRailPriority('')).toBe('medium');
  });
});

describe('existingTestRailCaseIds', () => {
  it('collects the TestRail case ids of one project only', () => {
    const cases = [
      existingCase({ testrailCaseId: 101 }),
      existingCase({ id: 'tc_2', key: 'ECO-002', testrailCaseId: 102 }),
      existingCase({ id: 'tc_3', key: 'ECO-003', projectId: 'PRJ-002', testrailCaseId: 103 }),
      existingCase({ id: 'tc_4', key: 'ECO-004' }),
    ];
    expect(existingTestRailCaseIds(cases, 'PRJ-001')).toEqual(new Set([101, 102]));
  });
});

describe('planTestRailCaseImport', () => {
  it('plans one importable row per new case with sequential keys', () => {
    const plan = planTestRailCaseImport([caseRow(), caseRow({ caseId: 102, title: 'Logout' })], [existingCase()], 'PRJ-001', 'ECO');
    expect(plan.rows.map((r) => r.importable)).toEqual([true, true]);
    // ECO-001 is taken by the existing case; the import assigns the next free keys.
    expect(plan.rows.map((r) => r.key)).toEqual(['ECO-002', 'ECO-003']);
    expect(plan.commitRows).toHaveLength(2);
    expect(plan.commitRows[0]).toMatchObject({ title: 'Login with existing account', priority: 'medium', testrailCaseId: 101 });
    expect(plan.duplicateCount).toBe(0);
    expect(plan.invalidCount).toBe(0);
  });

  it('skips cases whose TestRail id is already linked (existing or earlier in the batch)', () => {
    const plan = planTestRailCaseImport(
      [caseRow(), caseRow({ caseId: 102 }), caseRow()],
      [existingCase({ testrailCaseId: 101 })],
      'PRJ-001',
      'ECO',
    );
    expect(plan.rows[0]?.skipReason).toBe('duplicate');
    expect(plan.rows[1]?.importable).toBe(true);
    // the third row repeats caseId 101 within the batch → duplicate of itself
    expect(plan.rows[2]?.skipReason).toBe('duplicate');
    expect(plan.duplicateCount).toBe(2);
    expect(plan.commitRows).toHaveLength(1);
    expect(plan.commitRows[0]?.testrailCaseId).toBe(102);
  });

  it('skips cases without a usable title', () => {
    const plan = planTestRailCaseImport([caseRow({ caseId: 103, title: '   ' }), caseRow({ caseId: 104 })], [], 'PRJ-001', 'ECO');
    expect(plan.rows[0]?.skipReason).toBe('noTitle');
    expect(plan.invalidCount).toBe(1);
    expect(plan.commitRows).toHaveLength(1);
  });

  it('maps priority and type names onto the commit rows', () => {
    const plan = planTestRailCaseImport([caseRow({ caseId: 105, priorityName: 'Critical', typeName: 'Functional' })], [], 'PRJ-001', 'ECO');
    expect(plan.commitRows[0]).toMatchObject({ priority: 'critical', type: 'Functional' });
  });

  it('falls back to the TC prefix for a scope without a code', () => {
    const plan = planTestRailCaseImport([caseRow()], [], 'PRJ-001', '');
    expect(plan.rows[0]?.key).toBe('TC-001');
  });
});
