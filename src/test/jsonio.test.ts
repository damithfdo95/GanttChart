import { describe, expect, it } from 'vitest';
import { createExportPayload, parseImportPayload } from '../lib/jsonio/jsonio';
import { DEMO_STATE } from '../lib/storage/storage';

const V1_PAYLOAD = {
  app: 'ganttchart',
  version: 1,
  exportedAt: '2026-09-17T00:00:00.000Z',
  data: {
    totalCases: 80,
    currentTesters: 3,
    startTime: 540,
    targetFinish: 1020,
    lunchStart: 720,
    lunchEnd: 780,
    perHourPerTester: 3,
    casesCompleted: 10,
    language: 'en',
  },
};

function v2Payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    app: 'ganttchart',
    version: 2,
    exportedAt: '2026-09-17T00:00:00.000Z',
    data: { ...DEMO_STATE, ...overrides },
  });
}

describe('parseImportPayload (v2, strict)', () => {
  it('accepts a valid multi-day payload', () => {
    const result = parseImportPayload(v2Payload());
    expect(result.ok).toBe(true);
  });

  it('rejects negative planned testers', () => {
    const rows = DEMO_STATE.planningRows.map((r, i) => (i === 1 ? { ...r, plannedTesters: -2 } : r));
    expect(parseImportPayload(v2Payload({ planningRows: rows })).ok).toBe(false);
  });

  it('rejects negative absent testers', () => {
    const rows = DEMO_STATE.planningRows.map((r, i) => (i === 1 ? { ...r, absentTesters: -1 } : r));
    expect(parseImportPayload(v2Payload({ planningRows: rows })).ok).toBe(false);
  });

  it('rejects invalid calendar dates', () => {
    const rows = DEMO_STATE.planningRows.map((r, i) => (i === 2 ? { ...r, date: '2026-02-30' } : r));
    expect(parseImportPayload(v2Payload({ planningRows: rows })).ok).toBe(false);
  });

  it('rejects out-of-order row dates', () => {
    const rows = [...DEMO_STATE.planningRows];
    const first = rows[0].date;
    rows[0] = { ...rows[0], date: rows[4].date };
    rows[4] = { ...rows[4], date: first };
    expect(parseImportPayload(v2Payload({ planningRows: rows })).ok).toBe(false);
  });

  it('rejects an invalid target completion time', () => {
    expect(parseImportPayload(v2Payload({ targetCompletionTime: '25:99' })).ok).toBe(false);
  });

  it('rejects an invalid target completion date', () => {
    expect(parseImportPayload(v2Payload({ targetCompletionDate: '2026-13-40' })).ok).toBe(false);
  });

  it('rejects completed cases exceeding total cases', () => {
    expect(parseImportPayload(v2Payload({ casesCompleted: 999 })).ok).toBe(false);
  });

  it('rejects empty planning rows', () => {
    expect(parseImportPayload(v2Payload({ planningRows: [] })).ok).toBe(false);
  });

  it('rejects unknown versions, apps and malformed JSON', () => {
    expect(parseImportPayload('{"app":"ganttchart","version":99}').ok).toBe(false);
    expect(parseImportPayload('{"app":"other","version":2}').ok).toBe(false);
    expect(parseImportPayload('{not json').ok).toBe(false);
    expect(parseImportPayload('null').ok).toBe(false);
  });
});

describe('parseImportPayload (v1 compatibility)', () => {
  it('migrates valid v1 payloads forward', () => {
    const result = parseImportPayload(JSON.stringify(V1_PAYLOAD));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.totalCases).toBe(80);
      expect(result.data.casesCompleted).toBe(10);
      expect(result.data.language).toBe('en');
      expect(result.data.planningRows.length).toBe(1);
      expect(result.data.planningRows[0].plannedTesters).toBe(3);
      expect(result.data.targetCompletionTime).toBe('17:00');
    }
  });
});

describe('createExportPayload', () => {
  it('writes the v2 envelope with the full planning state', () => {
    const payload = createExportPayload(DEMO_STATE);
    expect(payload.app).toBe('ganttchart');
    expect(payload.version).toBe(2);
    expect(payload.data).toEqual(DEMO_STATE);
    expect(payload.data.planningRows.length).toBe(5);
  });
});
