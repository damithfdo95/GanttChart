import { describe, expect, it } from 'vitest';
import {
  canonicalRecordsHash,
  isTenantId,
  isUserId,
  newTenantId,
  newUserId,
  normalizeEmail,
  normalizeTenantName,
  recordsHaveData,
  summarizeRecords,
  validateImportRecords,
} from '../../shared/tenancy';

describe('stable ids', () => {
  it('are prefixed, unguessable and distinguishable', () => {
    const t = newTenantId();
    const u = newUserId();
    expect(isTenantId(t)).toBe(true);
    expect(isUserId(u)).toBe(true);
    expect(isTenantId(u)).toBe(false); // a user id is never a tenant id
    expect(isUserId(t)).toBe(false);
    expect(newTenantId()).not.toBe(t);
  });

  it('reject anything that is not exactly an id (injection, labels, other prefixes)', () => {
    for (const bad of ['', 'workspace', 'ten_', 'ten_123', 'ten_../../x', 'TEN_' + crypto.randomUUID(), 'usr_' + crypto.randomUUID(), 5, null, undefined, {}]) {
      expect(isTenantId(bad)).toBe(false);
    }
  });
});

describe('normalizeEmail', () => {
  it('canonicalises case, whitespace and full-width characters', () => {
    expect(normalizeEmail('  Alice@Example.COM ')).toBe('alice@example.com');
    expect(normalizeEmail('ａｌｉｃｅ＠example.com')).toBe('alice@example.com');
    expect(normalizeEmail('alice@example.com' + String.fromCharCode(10))).toBe('alice@example.com'); // pasted values are trimmed
  });

  it('rejects things that are not a single plausible address', () => {
    for (const bad of ['', ' ', 'a', 'a@', '@b.co', 'a@b', 'a@b.c', 'a@@b.co', 'a@b@c.co', 'a b@c.co', 'a@c .co', 'a,b@c.co', '<a@c.co>', 'a@-c.co', 'a@c..co', 'x'.repeat(65) + '@c.co', 123 as never, null as never]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });
});

describe('normalizeTenantName', () => {
  it('trims and collapses whitespace; rejects empty, huge and control characters', () => {
    expect(normalizeTenantName('  Alpha   QA ')).toBe('Alpha QA');
    expect(normalizeTenantName('品質保証チーム')).toBe('品質保証チーム');
    for (const bad of ['', '   ', 'x'.repeat(81), 'a\u0000b', 5 as never]) expect(normalizeTenantName(bad)).toBeNull();
  });
});

describe('canonicalRecordsHash', () => {
  const r = (kind: 'project' | 'report', id: string, json: string) => ({ kind, id, json });

  it('is independent of order and stable', async () => {
    const a = await canonicalRecordsHash([r('project', 'p1', '{"id":"p1"}'), r('report', 'r1', '{"id":"r1"}')]);
    const b = await canonicalRecordsHash([r('report', 'r1', '{"id":"r1"}'), r('project', 'p1', '{"id":"p1"}')]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when ANY byte of any record, any id or any kind changes', async () => {
    const base = await canonicalRecordsHash([r('project', 'p1', '{"id":"p1","n":1}')]);
    expect(await canonicalRecordsHash([r('project', 'p1', '{"id":"p1","n":2}')])).not.toBe(base);
    expect(await canonicalRecordsHash([r('project', 'p2', '{"id":"p1","n":1}')])).not.toBe(base);
    expect(await canonicalRecordsHash([r('report', 'p1', '{"id":"p1","n":1}')])).not.toBe(base);
    expect(await canonicalRecordsHash([])).not.toBe(base);
  });

  it('cannot be fooled by moving bytes between fields', async () => {
    const a = await canonicalRecordsHash([r('project', 'ab', '{"id":"ab"}')]);
    const b = await canonicalRecordsHash([r('project', 'a', 'b{"id":"ab"}')]);
    expect(a).not.toBe(b);
  });
});

describe('validateImportRecords', () => {
  const good = [
    { kind: 'project', id: 'p1', json: '{"id":"p1"}' },
    { kind: 'settings', id: 'settings', json: '{"teams":[]}' },
  ];

  it('accepts a well-formed workspace', () => {
    const v = validateImportRecords(good);
    expect(v.ok).toBe(true);
  });

  it.each([
    ['not an array', {}],
    ['a non-object record', [5]],
    ['an unknown kind', [{ kind: 'secrets', id: 'x', json: '{"id":"x"}' }]],
    ['an empty id', [{ kind: 'project', id: '', json: '{"id":""}' }]],
    ['invalid JSON', [{ kind: 'project', id: 'p', json: '{nope' }]],
    ['a JSON array body', [{ kind: 'project', id: 'p', json: '[]' }]],
    ['an id that does not match the content', [{ kind: 'project', id: 'p', json: '{"id":"other"}' }]],
    ['a settings record with a different id', [{ kind: 'settings', id: 'x', json: '{}' }]],
    ['a duplicate key', [good[0], good[0]]],
    ['a non-string json', [{ kind: 'project', id: 'p', json: { id: 'p' } }]],
  ])('rejects %s', (_name, input) => {
    expect(validateImportRecords(input).ok).toBe(false);
  });

  it('rejects oversized uploads', () => {
    const many = Array.from({ length: 20_001 }, (_, i) => ({ kind: 'report', id: `r${i}`, json: `{"id":"r${i}"}` }));
    expect(validateImportRecords(many)).toEqual({ ok: false, error: 'too many records' });
    const big = [{ kind: 'report', id: 'r', json: JSON.stringify({ id: 'r', pad: 'x'.repeat(1_000_001) }) }];
    expect(validateImportRecords(big)).toEqual({ ok: false, error: 'record too large' });
  });

  it('summarises and detects "has data" (settings alone is not data)', () => {
    expect(summarizeRecords(good as never)).toEqual({ project: 1, settings: 1 });
    expect(recordsHaveData([{ kind: 'settings' }])).toBe(false);
    expect(recordsHaveData([{ kind: 'settings' }, { kind: 'member' }])).toBe(true);
    expect(recordsHaveData([])).toBe(false);
  });
});
