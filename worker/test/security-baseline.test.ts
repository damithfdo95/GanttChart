import { describe, expect, it, vi } from 'vitest';
import { LIMITS, RECORD_KINDS, parseClientMessage } from '../../shared/protocol';
import { SV_ONLY_KINDS } from '../../shared/testerRules';
import { qaCommitError } from '../../shared/qaRules';
import { logEvent, newRequestId, safeError, withRequestId } from '../src/log';

/** The security baseline of the Worker's shared rules: machine-readable role x record-kind matrix, input limits, safe errors and logs. */

const J = JSON.stringify;
const view = { get: () => null, list: () => [] as Array<{ id: string; json: string }> };
const tester = (puts: Array<{ kind: string; id: string; json: string }>, deletes: Array<{ kind: string; id: string }> = []) =>
  qaCommitError({ role: 'editor', puts, deletes, view, userId: 'usr_t', today: '2026-10-25' });
const supervisor = (puts: Array<{ kind: string; id: string; json: string }>) => qaCommitError({ role: 'admin', puts, deletes: [], view, userId: 'usr_s', today: '2026-10-25' });

/**
 * What a Tester may write at all, by record kind. EVERY other kind is refused (default deny): adding a record kind without deciding
 * its Tester access fails this test. A Tester's allowed kinds are further limited by the rules in testerRules / testManagement.
 */
const TESTER_WRITABLE_KINDS: ReadonlySet<string> = new Set(['project', 'caseResult', 'caseExecution']);

describe('authorization matrix: role x record kind (default deny)', () => {
  it('a Tester can never create or change any record kind outside the three they work with', () => {
    for (const kind of RECORD_KINDS) {
      if (TESTER_WRITABLE_KINDS.has(kind)) continue;
      expect(tester([{ kind, id: 'x-1', json: J({ id: 'x-1' }) }]), kind).toBe('tester_cannot_change_kind');
    }
  });

  it('a Tester can never delete anything', () => {
    for (const kind of RECORD_KINDS) expect(tester([], [{ kind, id: 'x-1' }]), kind).toBe('tester_cannot_delete');
  });

  it('every record kind is either decided for Testers or listed here as SV-only information', () => {
    for (const kind of SV_ONLY_KINDS) expect((RECORD_KINDS as readonly string[]).includes(kind), kind).toBe(true);
    // Reports (and their publication metadata) are SV information and a Tester cannot write them.
    expect(SV_ONLY_KINDS.has('report')).toBe(true);
    expect(tester([{ kind: 'report', id: 'r1', json: J({ id: 'r1', status: 'FINALIZED', publicationStatus: 'published' }) }])).toBe('tester_cannot_change_kind');
  });

  it('an SV is not blocked by the Tester rule, but publication of a report still needs a finalized original', () => {
    const draft = { id: 'r1', status: 'DRAFT', publicationStatus: 'published', publishedAt: '2026-10-25T00:00:00.000Z', publicationMethod: 'other' };
    expect(supervisor([{ kind: 'report', id: 'r1', json: J(draft) }])).toBe('report_publication_draft');
  });
});

describe('input limits are enforced before anything is stored', () => {
  const commit = (over: Record<string, unknown>) => parseClientMessage(J({ t: 'commit', id: 'c', baseRevision: 0, puts: [], deletes: [], ...over }));

  it('rejects an oversized message, record, id and batch', () => {
    expect(parseClientMessage('x'.repeat(LIMITS.maxMessageChars + 1))).toEqual({ ok: false, error: 'message too large' });
    expect(commit({ puts: [{ kind: 'project', id: 'p', json: 'x'.repeat(LIMITS.maxRecordChars + 1) }] }).ok).toBe(false);
    expect(commit({ puts: [{ kind: 'project', id: 'p'.repeat(LIMITS.maxIdChars + 1), json: '{}' }] }).ok).toBe(false);
    const many = Array.from({ length: LIMITS.maxCommitRecords + 1 }, (_, i) => ({ kind: 'project', id: `p${i}`, json: '{}' }));
    expect(commit({ puts: many })).toEqual({ ok: false, error: 'too many records' });
    expect(commit({ id: 'c'.repeat(LIMITS.maxCommitIdChars + 1) }).ok).toBe(false);
    expect(commit({ reason: 'r'.repeat(LIMITS.maxReasonChars + 1) }).ok).toBe(false);
  });

  it('rejects malformed and unknown protocol input', () => {
    for (const text of ['', 'nope', '[]', '{}', '{"t":"evil"}', '{"t":"commit"}', '{"t":"commit","id":1}', '{"t":"commit","id":"c","baseRevision":"0","puts":[],"deletes":[]}']) {
      expect(parseClientMessage(text).ok, text).toBe(false);
    }
    expect(commit({ puts: [{ kind: 'notAKind', id: 'p', json: '{}' }] }).ok).toBe(false);
    expect(commit({ puts: [{ kind: 'project', id: 'p', json: 123 }] }).ok).toBe(false);
  });

  it('accepts input exactly at the limits', () => {
    const exact = Array.from({ length: LIMITS.maxCommitRecords }, (_, i) => ({ kind: 'project', id: `p${i}`, json: '{}' }));
    expect(commit({ puts: exact }).ok).toBe(true);
  });
});

describe('safe errors and structured logs', () => {
  it('a request id is random, opaque and never taken from the caller', () => {
    const a = newRequestId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(newRequestId()).not.toBe(a);
  });

  it('a JSON error carries the stable code, the request id header and a requestId field - and nothing technical', async () => {
    const res = await withRequestId(new Response(J({ error: 'Internal error', code: 'internal_error' }), { status: 500, headers: { 'Content-Type': 'application/json' } }), 'req-123');
    expect(res.status).toBe(500);
    expect(res.headers.get('X-Request-Id')).toBe('req-123');
    expect(await res.json()).toEqual({ error: 'Internal error', code: 'internal_error', requestId: 'req-123' });
  });

  it('success responses get the header only, non-JSON bodies are untouched, and a WebSocket upgrade is returned as it is', async () => {
    const ok = await withRequestId(new Response(J({ fine: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }), 'req-1');
    expect(ok.headers.get('X-Request-Id')).toBe('req-1');
    expect(await ok.json()).toEqual({ fine: true });
    const text = await withRequestId(new Response('plain', { status: 404, headers: { 'Content-Type': 'text/plain' } }), 'req-2');
    expect(await text.text()).toBe('plain');
    const upgrade = { status: 101, headers: new Headers(), webSocket: {} } as unknown as Response;
    expect(await withRequestId(upgrade, 'req-3')).toBe(upgrade);
  });

  it('safeError never includes a stack and is bounded to one short line', () => {
    const error = new Error('boom\n   at secretFunction (/internal/path.ts:1:1)\n' + 'x'.repeat(500));
    const text = safeError(error);
    expect(text).not.toContain('\n');
    expect(text).not.toContain('/internal/path');
    expect(text.length).toBeLessThanOrEqual(160);
    expect(safeError('plain')).toBe('plain');
  });

  it('logEvent writes one JSON line with the event name and only the fields given', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logEvent('warn', 'commit_denied', { reason: 'forbidden', role: 'editor' });
    expect(JSON.parse(spy.mock.calls[0]?.[0] as string)).toEqual({ event: 'commit_denied', reason: 'forbidden', role: 'editor' });
    spy.mockRestore();
  });
});
