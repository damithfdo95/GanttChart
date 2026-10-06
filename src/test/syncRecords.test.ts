import { describe, expect, it } from 'vitest';
import type { DailyTopic, ProjectRecord, ReportsState } from '../types';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { qaInputsFromAppState } from '../domain/projects/migrations';
import { DEMO_STATE, normalizeAppState } from '../lib/storage/storage';
import { defaultReportsState } from '../lib/storage/reports';
import {
  applyRecordChanges,
  countRecords,
  hasMeaningfulLocalData,
  recordKey,
  reportsFromRecords,
  reportsToRecords,
  sharedSettings,
  splitRecordKey,
} from '../lib/sync/records';

function project(name: string, createdAt: string): ProjectRecord {
  const p = newProjectRecord(qaInputsFromAppState(normalizeAppState({ ...DEMO_STATE })), { nameEn: name, nameJa: name, team: 'QA', status: 'ongoing' }, createdAt);
  return { ...p, id: `id-${name}`, projectId: `PRJ-${name}` };
}

function topic(id: string, createdAt: string): DailyTopic {
  return { id, createdAt, updatedAt: createdAt } as unknown as DailyTopic;
}

function base(): ReportsState {
  const s = defaultReportsState();
  return {
    ...s,
    projects: [project('A', '2026-10-01T00:00:00Z'), project('B', '2026-10-02T00:00:00Z')],
    topics: [topic('t1', '2026-10-01T00:00:00Z'), topic('t2', '2026-10-02T00:00:00Z')],
    activeProjectId: 'id-A',
    settings: { ...s.settings, autoBackup: { enabled: true, folderName: 'C:/my/folder', retentionDays: 30 } },
  };
}

const puts = (state: ReportsState) => [...reportsToRecords(state).values()];

describe('what is shared and what stays on the device', () => {
  it('never puts per-device fields into shared records', () => {
    const recs = [...reportsToRecords(base()).values()];
    const settings = recs.find((r) => r.kind === 'settings')!;
    expect(settings.json).not.toContain('autoBackup');
    expect(settings.json).not.toContain('C:/my/folder');
    expect(recs.some((r) => r.json.includes('"activeProjectId"'))).toBe(false);
    expect(sharedSettings(base().settings)).not.toHaveProperty('autoBackup');
  });

  it('emits one record per shared item plus the settings record, with unique keys', () => {
    const map = reportsToRecords(base());
    expect(countRecords(map.values())).toMatchObject({ projects: 2, topics: 2 });
    expect([...map.keys()]).toContain(recordKey('settings', 'settings'));
    expect(splitRecordKey(recordKey('project', 'id-A'))).toEqual({ kind: 'project', id: 'id-A' });
  });

  it('is deterministic: identical state gives identical JSON', () => {
    expect([...reportsToRecords(base()).values()]).toEqual([...reportsToRecords(base()).values()]);
  });
});

describe('reportsFromRecords (full snapshot)', () => {
  it('round-trips the shared data and keeps THIS device’s own fields', () => {
    const source = base();
    const device: ReportsState = {
      ...defaultReportsState(),
      activeProjectId: 'id-B',
      settings: { ...defaultReportsState().settings, autoBackup: { enabled: false, folderName: 'D:/other', retentionDays: 7 } },
    };
    const built = reportsFromRecords(puts(source), device);
    expect(built.projects.map((p) => p.id)).toEqual(['id-A', 'id-B']);
    expect(built.topics.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(built.activeProjectId).toBe('id-B'); // the device's own selection
    expect(built.settings.autoBackup?.folderName).toBe('D:/other'); // the device's own backup folder
    expect(built.settings.teams).toEqual(source.settings.teams); // shared settings come from the server
  });

  it('rebuilds the same array order on every client regardless of arrival order', () => {
    const recs = puts(base());
    const a = reportsFromRecords(recs, defaultReportsState());
    const b = reportsFromRecords([...recs].reverse(), defaultReportsState());
    expect(a.projects.map((p) => p.id)).toEqual(b.projects.map((p) => p.id));
    expect(a.topics.map((t) => t.id)).toEqual(b.topics.map((t) => t.id));
  });

  it('falls back to the first project when the device’s selection no longer exists', () => {
    const built = reportsFromRecords(puts(base()), { ...defaultReportsState(), activeProjectId: 'gone' });
    expect(built.activeProjectId).toBe('id-A');
    expect(reportsFromRecords([], { ...defaultReportsState(), activeProjectId: 'x' }).activeProjectId).toBeNull();
  });
});

describe('applyRecordChanges (incremental remote changes)', () => {
  it('replaces, inserts and deletes only the touched records', () => {
    const s = base();
    const edited = { ...s.projects[0], nameEn: 'Renamed' };
    const added = project('C', '2026-10-03T00:00:00Z');
    const next = applyRecordChanges(
      s,
      [
        { kind: 'project', id: 'id-A', json: JSON.stringify(edited) },
        { kind: 'project', id: 'id-C', json: JSON.stringify(added) },
      ],
      [{ kind: 'topic', id: 't1' }],
    );
    expect(next.projects.map((p) => `${p.id}:${p.nameEn}`)).toEqual(['id-A:Renamed', 'id-B:B', 'id-C:C']);
    expect(next.topics.map((t) => t.id)).toEqual(['t2']);
    expect(next.projects[1]).toBe(s.projects[1]); // untouched records keep their identity
  });

  it('returns the SAME state object when the change is already applied (no spurious re-render/commit)', () => {
    const s = base();
    expect(applyRecordChanges(s, [{ kind: 'project', id: 'id-A', json: JSON.stringify(s.projects[0]) }], [])).toBe(s);
    expect(applyRecordChanges(s, [], [{ kind: 'report', id: 'nope' }])).toBe(s);
  });

  it('keeps the device’s autoBackup when shared settings change, and applies the shared part', () => {
    const s = base();
    const remote = { ...sharedSettings(s.settings), supervisorName: 'New Boss' };
    const next = applyRecordChanges(s, [{ kind: 'settings', id: 'settings', json: JSON.stringify(remote) }], []);
    expect(next.settings.supervisorName).toBe('New Boss');
    expect(next.settings.autoBackup?.folderName).toBe('C:/my/folder');
  });

  it('never applies an unreadable record', () => {
    const s = base();
    expect(applyRecordChanges(s, [{ kind: 'project', id: 'id-A', json: '{broken' }], [])).toBe(s);
    expect(applyRecordChanges(s, [{ kind: 'project', id: 'id-A', json: '"just a string"' }], [])).toBe(s);
  });

  it('repairs the active project when it is deleted remotely', () => {
    const s = base();
    const next = applyRecordChanges(s, [], [{ kind: 'project', id: 'id-A' }]);
    expect(next.activeProjectId).toBe('id-B');
    const none = applyRecordChanges(next, [], [{ kind: 'project', id: 'id-B' }]);
    expect(none.activeProjectId).toBeNull();
  });

  it('a device with no project selected lands on the first shared project as soon as one exists', () => {
    const empty: ReportsState = { ...defaultReportsState(), activeProjectId: null };
    const fresh = project('Z', '2026-10-05T00:00:00Z');
    const next = applyRecordChanges(empty, [{ kind: 'project', id: fresh.id, json: JSON.stringify(fresh) }], []);
    expect(next.activeProjectId).toBe(fresh.id);
    expect(applyRecordChanges(empty, [], [])).toBe(empty); // still nothing to select: unchanged
  });

  it('uses the record key as the id even if the JSON body disagrees', () => {
    const s = base();
    const next = applyRecordChanges(s, [{ kind: 'topic', id: 't9', json: JSON.stringify({ ...topic('other', '2026-10-09T00:00:00Z') }) }], []);
    expect(next.topics.map((t) => t.id)).toContain('t9');
    expect(next.topics.map((t) => t.id)).not.toContain('other');
  });
});

describe('hasMeaningfulLocalData', () => {
  it('is false for a fresh install (one untouched seeded project)', () => {
    const s = { ...defaultReportsState(), projects: [project('A', '2026-10-01T00:00:00Z')] };
    expect(hasMeaningfulLocalData(s)).toBe(false);
    expect(hasMeaningfulLocalData(defaultReportsState())).toBe(false);
  });

  it('is true as soon as a person has entered something', () => {
    const fresh = { ...defaultReportsState(), projects: [project('A', '2026-10-01T00:00:00Z')] };
    expect(hasMeaningfulLocalData({ ...fresh, topics: [topic('t', '2026-10-01T00:00:00Z')] })).toBe(true);
    expect(hasMeaningfulLocalData({ ...fresh, projects: [...fresh.projects, project('B', '2026-10-02T00:00:00Z')] })).toBe(true);
    expect(hasMeaningfulLocalData({ ...fresh, projects: [{ ...fresh.projects[0], updatedAt: '2026-10-05T00:00:00Z' }] })).toBe(true);
  });
});
