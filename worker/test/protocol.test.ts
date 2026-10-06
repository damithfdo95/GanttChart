import { describe, expect, it } from 'vitest';
import { LIMITS, PROTOCOL_VERSION, parseClientMessage } from '../../shared/protocol';

const ok = (value: unknown) => parseClientMessage(JSON.stringify(value));

describe('parseClientMessage', () => {
  it('accepts ping, hello and commit', () => {
    expect(ok({ t: 'ping' })).toEqual({ ok: true, value: { t: 'ping' } });
    expect(ok({ t: 'hello', v: PROTOCOL_VERSION, clientId: 'c1', lastRevision: null })).toMatchObject({ ok: true });
    expect(ok({ t: 'hello', v: PROTOCOL_VERSION, clientId: 'c1', lastRevision: 7 })).toMatchObject({ ok: true });
    expect(
      ok({ t: 'commit', id: 'x', baseRevision: 3, puts: [{ kind: 'project', id: 'p', json: '{}' }], deletes: [{ kind: 'report', id: 'r' }], reason: 'edit' }),
    ).toMatchObject({ ok: true, value: { t: 'commit', baseRevision: 3 } });
  });

  it.each([
    ['not json', 'nope'],
    ['not an object', '[]'],
    ['no type', '{}'],
    ['unknown type', '{"t":"evil"}'],
  ])('rejects %s', (_name, text) => {
    expect(parseClientMessage(text).ok).toBe(false);
  });

  it('rejects malformed hello', () => {
    expect(ok({ t: 'hello', v: 99, clientId: 'c', lastRevision: null }).ok).toBe(false);
    expect(ok({ t: 'hello', v: PROTOCOL_VERSION, clientId: '', lastRevision: null }).ok).toBe(false);
    expect(ok({ t: 'hello', v: PROTOCOL_VERSION, clientId: 'c', lastRevision: -1 }).ok).toBe(false);
    expect(ok({ t: 'hello', v: PROTOCOL_VERSION, clientId: 'c', lastRevision: 1.5 }).ok).toBe(false);
  });

  it('rejects malformed commits', () => {
    const base = { t: 'commit', id: 'x', baseRevision: 0, puts: [], deletes: [] };
    expect(ok(base).ok).toBe(false); // empty
    expect(ok({ ...base, puts: [{ kind: 'nope', id: 'a', json: '{}' }] }).ok).toBe(false); // unknown kind
    expect(ok({ ...base, puts: [{ kind: 'project', id: '', json: '{}' }] }).ok).toBe(false); // empty id
    expect(ok({ ...base, puts: [{ kind: 'project', id: 'a', json: '' }] }).ok).toBe(false); // empty json
    expect(ok({ ...base, puts: [{ kind: 'project', id: 'a', json: 5 }] }).ok).toBe(false); // json not a string
    expect(ok({ ...base, baseRevision: -1, puts: [{ kind: 'project', id: 'a', json: '{}' }] }).ok).toBe(false);
    expect(ok({ ...base, id: '', puts: [{ kind: 'project', id: 'a', json: '{}' }] }).ok).toBe(false);
    expect(ok({ ...base, reason: 'x'.repeat(LIMITS.maxReasonChars + 1), puts: [{ kind: 'project', id: 'a', json: '{}' }] }).ok).toBe(false);
  });

  it('rejects the same record twice, oversize records, and too many records', () => {
    const a = { kind: 'project', id: 'a', json: '{}' };
    expect(ok({ t: 'commit', id: 'x', baseRevision: 0, puts: [a, a], deletes: [] }).ok).toBe(false);
    expect(ok({ t: 'commit', id: 'x', baseRevision: 0, puts: [a], deletes: [{ kind: 'project', id: 'a' }] }).ok).toBe(false);
    expect(ok({ t: 'commit', id: 'x', baseRevision: 0, puts: [{ ...a, json: 'x'.repeat(LIMITS.maxRecordChars + 1) }], deletes: [] }).ok).toBe(false);
    const many = Array.from({ length: LIMITS.maxCommitRecords + 1 }, (_, i) => ({ kind: 'report', id: `r${i}`, json: '{}' }));
    expect(ok({ t: 'commit', id: 'x', baseRevision: 0, puts: many, deletes: [] }).ok).toBe(false);
  });

  it('rejects oversize frames before parsing', () => {
    expect(parseClientMessage('x'.repeat(LIMITS.maxMessageChars + 1))).toEqual({ ok: false, error: 'message too large' });
  });
});
