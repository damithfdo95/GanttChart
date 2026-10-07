import { describe, expect, it } from 'vitest';
import { createProjectBackupPayload, importProjectIntoRegistry, parseProjectBackupPayload } from '../lib/backup/projectBackup';
import { DEMO_STATE, normalizeQaInputs } from '../lib/storage/storage';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { caseResultId } from '../domain/testManagement';
import { LEGACY_PLACEHOLDER_MEMBERS } from '../domain/members/legacyPlaceholders';
import type { CaseResult, ProjectRecord, QaInputs, TestCase, TestScope } from '../types';

const NOW = '2026-10-07T09:00:00.000Z';
const inputs = (): QaInputs => normalizeQaInputs({ ...(DEMO_STATE as QaInputs), totalCases: 10 });
const project = (projectId: string, id: string): ProjectRecord => ({ ...newProjectRecord(inputs(), { nameEn: `Project ${projectId}`, status: 'ongoing' }, NOW, []), id, projectId });

const scope = (id: string, projectId: string, code: string): TestScope => ({ id, projectId, name: `Scope ${code}`, code, status: 'active', order: 10, createdAt: NOW, updatedAt: NOW });
const tcase = (id: string, projectId: string, scopeId: string, key: string): TestCase => ({ id, projectId, scopeId, key, title: `Case ${key}`, priority: 'high', status: 'active', order: 10, createdAt: NOW, updatedAt: NOW });
const result = (testCaseId: string, projectId: string, scopeId: string, over: Partial<CaseResult> = {}): CaseResult => ({ id: caseResultId(testCaseId), projectId, scopeId, testCaseId, status: 'pass', retest: true, question: false, memo: 'ok', executedByUserId: 'usr_other_workspace', executedAt: NOW, updatedByUserId: 'usr_other_workspace', updatedAt: NOW, ...over });

const A = project('PRJ-001', 'a');
const B = project('PRJ-002', 'b');
const tm = {
  scopes: [scope('scp_a', 'PRJ-001', 'ECO'), scope('scp_b', 'PRJ-002', 'HTMA')],
  testCases: [tcase('tc_a1', 'PRJ-001', 'scp_a', 'ECO-001'), tcase('tc_a2', 'PRJ-001', 'scp_a', 'ECO-002'), tcase('tc_b1', 'PRJ-002', 'scp_b', 'HTMA-001')],
  caseResults: [result('tc_a1', 'PRJ-001', 'scp_a'), result('tc_b1', 'PRJ-002', 'scp_b')],
};

describe('single-project export includes the project\'s Test Management', () => {
  it('writes the scopes, cases and results of THIS project and none of another project', () => {
    const payload = createProjectBackupPayload(A, [], NOW, tm);
    expect(payload.data.testManagement?.scopes.map((s) => s.id)).toEqual(['scp_a']);
    expect(payload.data.testManagement?.testCases.map((c) => c.id)).toEqual(['tc_a1', 'tc_a2']);
    expect(payload.data.testManagement?.caseResults.map((r) => r.testCaseId)).toEqual(['tc_a1']);
    const text = JSON.stringify(payload);
    expect(text).not.toContain('HTMA');
    expect(text).not.toContain('tc_b1');
  });

  it('a project without test management exports exactly the old format (no new field)', () => {
    const payload = createProjectBackupPayload(A, [], NOW);
    expect('testManagement' in payload.data).toBe(false);
    expect('testManagement' in createProjectBackupPayload(A, [], NOW, { scopes: tm.scopes.filter((s) => s.projectId === 'PRJ-002') }).data).toBe(false);
  });

  it('survives a file round trip, with the same ids and relationships, when nothing collides', () => {
    const parsed = parseProjectBackupPayload(JSON.stringify(createProjectBackupPayload(A, [], NOW, tm)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const merged = importProjectIntoRegistry([], [], parsed.data);
    expect(merged.importedProject.projectId).toBe('PRJ-001');
    expect(merged.testManagement.scopes.map((s) => s.id)).toEqual(['scp_a']);
    expect(merged.testManagement.testCases.map((c) => [c.id, c.key, c.scopeId, c.projectId])).toEqual([['tc_a1', 'ECO-001', 'scp_a', 'PRJ-001'], ['tc_a2', 'ECO-002', 'scp_a', 'PRJ-001']]);
    expect(merged.testManagement.caseResults).toHaveLength(1);
    expect(merged.testManagement.caseResults[0]).toMatchObject({ id: caseResultId('tc_a1'), testCaseId: 'tc_a1', scopeId: 'scp_a', status: 'pass', retest: true, memo: 'ok' });
  });

  it('importing the same project again creates a SECOND, consistent copy under a new project id; nothing is overwritten', () => {
    const parsed = parseProjectBackupPayload(JSON.stringify(createProjectBackupPayload(A, [], NOW, tm)));
    if (!parsed.ok) throw new Error('parse');
    const merged = importProjectIntoRegistry([A], [], parsed.data, { existing: tm });
    const newId = merged.importedProject.projectId;
    expect(newId).not.toBe('PRJ-001');
    const t2 = merged.testManagement;
    const oldIds = new Set([...tm.scopes, ...tm.testCases].map((x) => x.id));
    for (const x of [...t2.scopes, ...t2.testCases]) {
      expect(oldIds.has(x.id)).toBe(false);
      expect(x.projectId).toBe(newId);
    }
    const scopeIds = new Set(t2.scopes.map((s) => s.id));
    const caseIds = new Set(t2.testCases.map((c) => c.id));
    expect(t2.testCases.every((c) => scopeIds.has(c.scopeId))).toBe(true);
    expect(t2.caseResults.every((r) => caseIds.has(r.testCaseId) && scopeIds.has(r.scopeId) && r.id === caseResultId(r.testCaseId) && r.projectId === newId)).toBe(true);
    expect(t2.testCases.map((c) => c.key)).toEqual(['ECO-001', 'ECO-002']); // keys are per project: the copy keeps its keys
  });

  it('ids that collide with existing records (without the project being re-IDed) are replaced together, never overwritten', () => {
    const parsed = parseProjectBackupPayload(JSON.stringify(createProjectBackupPayload(A, [], NOW, tm)));
    if (!parsed.ok) throw new Error('parse');
    const merged = importProjectIntoRegistry([], [], parsed.data, { existing: { scopes: [scope('scp_a', 'PRJ-009', 'X')], testCases: [] } });
    expect(merged.testManagement.scopes[0].id).not.toBe('scp_a');
    expect(merged.testManagement.testCases.every((c) => c.scopeId === merged.testManagement.scopes[0].id)).toBe(true);
  });

  it('accounts of another workspace are never rebound: restored results are attributed to the person restoring them (or kept as they were when nobody is signed in)', () => {
    const parsed = parseProjectBackupPayload(JSON.stringify(createProjectBackupPayload(A, [], NOW, tm)));
    if (!parsed.ok) throw new Error('parse');
    const restored = importProjectIntoRegistry([], [], parsed.data, { actor: 'usr_sv_here' }).testManagement.caseResults[0];
    expect(restored).toMatchObject({ updatedByUserId: 'usr_sv_here', executedByUserId: 'usr_sv_here' });
    expect(JSON.stringify(restored)).not.toContain('usr_other_workspace');
    const local = importProjectIntoRegistry([], [], parsed.data).testManagement.caseResults[0];
    expect(local.updatedByUserId).toBe('usr_other_workspace'); // plain local use: nothing to rebind to; the screens show "Former member"
  });

  it('an export never carries account assignments, and the import brings no roster people', () => {
    const text = JSON.stringify(createProjectBackupPayload(A, [], NOW, tm));
    expect(text).not.toContain('"userId"');
    expect(text).not.toMatch(/USER000[1-8]/);
    for (const m of LEGACY_PLACEHOLDER_MEMBERS) expect(text).not.toContain(m.name);
    const parsed = parseProjectBackupPayload(text);
    if (!parsed.ok) throw new Error('parse');
    expect(Object.keys(importProjectIntoRegistry([], [], parsed.data))).not.toContain('rcsMembers');
  });

  it('old exports (no testManagement) still import, with nothing added', () => {
    const old = createProjectBackupPayload(A, [], NOW);
    const parsed = parseProjectBackupPayload(JSON.stringify(old));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const merged = importProjectIntoRegistry([], [], parsed.data);
    expect(merged.testManagement).toEqual({ scopes: [], testCases: [], caseResults: [] });
  });

  it('records in a file that belong to another project, or are malformed, are ignored on import', () => {
    const payload = createProjectBackupPayload(A, [], NOW, tm);
    const bad = JSON.parse(JSON.stringify(payload));
    bad.data.testManagement.scopes.push(scope('scp_x', 'PRJ-777', 'FOR'), { id: 'junk' });
    bad.data.testManagement.testCases.push({ ...tcase('tc_x', 'PRJ-001', 'scp_a', 'ECO-003'), key: 'not a key' });
    const parsed = parseProjectBackupPayload(JSON.stringify(bad));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.testManagement?.scopes.map((s) => s.id)).toEqual(['scp_a']);
    expect(parsed.data.testManagement?.testCases.map((c) => c.id)).toEqual(['tc_a1', 'tc_a2']);
  });

  it('project B round trips on its own too', () => {
    const parsed = parseProjectBackupPayload(JSON.stringify(createProjectBackupPayload(B, [], NOW, tm)));
    if (!parsed.ok) throw new Error('parse');
    expect(parsed.data.testManagement?.scopes.map((s) => s.id)).toEqual(['scp_b']);
  });
});
