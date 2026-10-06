import { beforeEach, describe, expect, it } from 'vitest';
import type { DailyTopic, ProjectRecord, ReportsState } from '../types';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { qaInputsFromAppState } from '../domain/projects/migrations';
import { DEMO_STATE, normalizeAppState } from '../lib/storage/storage';
import { defaultReportsState } from '../lib/storage/reports';
import { REPLACE_CONFIRMATION, firstStateFor, needsLocalBackup, planLink, startsFromEmptyLocal, validateLinkChoice } from '../lib/sync/link';
import { reportsToRecords } from '../lib/sync/records';
import { LINK_KEY, MIRROR_KEY, STASH_KEY, appendStash, clearStash, readLink, readMirror, readStash, unlinkDevice, writeLink, writeMirror } from '../lib/sync/device';
import { detectServer, fetchServerWorkspace, probeSession, websocketUrl, type FetchLike } from '../lib/sync/serverMode';

function project(name: string, createdAt = '2026-10-01T00:00:00Z'): ProjectRecord {
  const p = newProjectRecord(qaInputsFromAppState(normalizeAppState({ ...DEMO_STATE })), { nameEn: name, nameJa: name, team: 'QA', status: 'ongoing' }, createdAt);
  return { ...p, id: `id-${name}`, projectId: `PRJ-${name}` };
}
const topic = (id: string): DailyTopic => ({ id, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }) as unknown as DailyTopic;

const fresh = (): ReportsState => ({ ...defaultReportsState(), projects: [project('Demo')] });
const withData = (): ReportsState => ({ ...fresh(), topics: [topic('t1')], projects: [project('Demo'), project('Real', '2026-10-02T00:00:00Z')] });
const serverRecords = (s: ReportsState) => [...reportsToRecords(s).values()];
// A brand-new server holds nothing (or at most the shared settings record).
const EMPTY_SERVER = serverRecords(defaultReportsState()).filter((r) => r.kind === 'settings');

describe('planLink — the four situations', () => {
  it('empty server + fresh device → create the shared workspace', () => {
    expect(planLink({ local: fresh(), serverRecords: EMPTY_SERVER, role: 'admin' })).toEqual({ kind: 'create' });
    expect(planLink({ local: fresh(), serverRecords: [], role: 'editor' })).toEqual({ kind: 'create' });
  });

  it('empty server + device with real data → ask whether to initialize from it', () => {
    const plan = planLink({ local: withData(), serverRecords: EMPTY_SERVER, role: 'editor' });
    expect(plan).toMatchObject({ kind: 'initialize', local: { projects: 2, topics: 1 } });
  });

  it('a server that holds even just a member roster counts as having data (never overwritten)', () => {
    const rosterOnly = serverRecords(defaultReportsState());
    expect(rosterOnly.some((r) => r.kind === 'member')).toBe(true);
    expect(planLink({ local: withData(), serverRecords: rosterOnly, role: 'admin' }).kind).toBe('choose');
    expect(planLink({ local: fresh(), serverRecords: rosterOnly, role: 'admin' }).kind).toBe('adopt');
  });

  it('shared data + fresh device → adopt (nothing here to lose)', () => {
    const plan = planLink({ local: fresh(), serverRecords: serverRecords(withData()), role: 'editor' });
    expect(plan).toMatchObject({ kind: 'adopt', server: { projects: 2, topics: 1 } });
  });

  it('shared data + device with real data → the user must choose (never silently overwritten)', () => {
    const plan = planLink({ local: withData(), serverRecords: serverRecords({ ...withData(), topics: [] }), role: 'editor' });
    expect(plan).toMatchObject({ kind: 'choose', canReplace: false, local: { topics: 1 }, server: { topics: 0 } });
  });

  it('only an admin may even be offered "replace"', () => {
    const base = { local: withData(), serverRecords: serverRecords(withData()) };
    expect(planLink({ ...base, role: 'admin' })).toMatchObject({ kind: 'choose', canReplace: true });
    expect(planLink({ ...base, role: 'editor' })).toMatchObject({ canReplace: false });
    expect(planLink({ ...base, role: 'viewer' })).toMatchObject({ canReplace: false });
  });
});

describe('validateLinkChoice — guards behind the buttons', () => {
  const choose = planLink({ local: withData(), serverRecords: serverRecords(withData()), role: 'admin' });

  it('only the choices that belong to a situation are accepted', () => {
    expect(validateLinkChoice(choose, 'merge', 'editor').ok).toBe(true);
    expect(validateLinkChoice(choose, 'use-shared', 'editor').ok).toBe(true);
    expect(validateLinkChoice(choose, 'initialize', 'admin')).toEqual({ ok: false, reason: 'plan' });
    expect(validateLinkChoice({ kind: 'create' }, 'merge', 'admin')).toEqual({ ok: false, reason: 'plan' });
  });

  it('REPLACE needs an admin AND the exact typed confirmation', () => {
    expect(validateLinkChoice(choose, 'replace-shared', 'editor', REPLACE_CONFIRMATION)).toEqual({ ok: false, reason: 'role' });
    expect(validateLinkChoice(choose, 'replace-shared', 'admin')).toEqual({ ok: false, reason: 'confirmation' });
    expect(validateLinkChoice(choose, 'replace-shared', 'admin', 'replace')).toEqual({ ok: false, reason: 'confirmation' });
    expect(validateLinkChoice(choose, 'replace-shared', 'admin', ' REPLACE')).toEqual({ ok: false, reason: 'confirmation' });
    expect(validateLinkChoice(choose, 'replace-shared', 'admin', REPLACE_CONFIRMATION)).toEqual({ ok: true });
  });

  it('a read-only person may only receive the shared workspace', () => {
    expect(validateLinkChoice(choose, 'merge', 'viewer')).toEqual({ ok: false, reason: 'role' });
    expect(validateLinkChoice(choose, 'use-shared', 'viewer')).toEqual({ ok: true });
    const init = planLink({ local: withData(), serverRecords: EMPTY_SERVER, role: 'viewer' });
    expect(validateLinkChoice(init, 'initialize', 'viewer')).toEqual({ ok: false, reason: 'role' });
  });
});

describe('how a choice drives the sync client', () => {
  it('only REPLACE overwrites the server; everything else applies server state to this device', () => {
    expect(firstStateFor('replace-shared')).toBe('overwrite');
    for (const c of ['use-shared', 'merge', 'initialize', 'start-fresh', 'create'] as const) expect(firstStateFor(c)).toBe('apply');
  });

  it('only "use shared" starts from an empty device state, so nothing local can reach the server', () => {
    expect(startsFromEmptyLocal('use-shared')).toBe(true);
    expect(startsFromEmptyLocal('merge')).toBe(false);
    expect(startsFromEmptyLocal('replace-shared')).toBe(false);
  });

  it('a backup file is offered before this device’s real data is replaced', () => {
    expect(needsLocalBackup('use-shared', withData())).toBe(true);
    expect(needsLocalBackup('start-fresh', withData())).toBe(true);
    expect(needsLocalBackup('use-shared', fresh())).toBe(false); // nothing worth backing up
    expect(needsLocalBackup('merge', withData())).toBe(false); // nothing is discarded
  });
});

describe('device storage', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { window?: unknown }).window = {
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    };
  });

  it('a link only counts for the server it was made on', () => {
    writeLink({ origin: 'https://a.workers.dev', linkedAt: 'x', email: 'a@b.c' });
    expect(readLink('https://a.workers.dev')?.email).toBe('a@b.c');
    expect(readLink('https://other.workers.dev')).toBeNull();
  });

  it('round-trips the offline mirror and rejects a malformed one', () => {
    writeMirror({ revision: 4, records: { k: '{}' } });
    expect(readMirror()).toEqual({ revision: 4, records: { k: '{}' } });
    store.set(MIRROR_KEY, '{"revision":"x"}');
    expect(readMirror()).toBeNull();
    store.set(MIRROR_KEY, 'not json');
    expect(readMirror()).toBeNull();
  });

  it('keeps only the most recent stashed edits', () => {
    for (let i = 0; i < 60; i++) appendStash({ at: String(i), kind: 'project', id: `p${i}`, json: '{}' });
    const stash = readStash();
    expect(stash).toHaveLength(50);
    expect(stash[0].id).toBe('p10');
    expect(stash[49].id).toBe('p59');
    clearStash();
    expect(readStash()).toEqual([]);
  });

  it('unlink forgets the device’s sync state but nothing else', () => {
    writeLink({ origin: 'o', linkedAt: 'x', email: 'e' });
    writeMirror({ revision: 1, records: {} });
    appendStash({ at: 'x', kind: 'topic', id: 't', json: null });
    store.set('ganttchart.v2', 'APP DATA');
    unlinkDevice();
    expect([LINK_KEY, MIRROR_KEY, STASH_KEY].some((k) => store.has(k))).toBe(false);
    expect(store.get('ganttchart.v2')).toBe('APP DATA');
  });

  it('never throws when storage is blocked', () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
        removeItem: () => {
          throw new Error('blocked');
        },
      },
    };
    expect(writeMirror({ revision: 1, records: {} })).toBe(false);
    expect(readMirror()).toBeNull();
    expect(readStash()).toEqual([]);
    expect(() => unlinkDevice()).not.toThrow();
  });
});

describe('detectServer', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const html = () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } });
  const run = (f: FetchLike) => detectServer(f);

  it('recognises the shared backend and reads the identity', async () => {
    expect(await run(async () => json({ email: 'a@b.c', role: 'admin' }))).toEqual({ mode: 'server', identity: { email: 'a@b.c', role: 'admin' } });
  });

  it('treats a static host / vite dev (SPA fallback or 404) as local-only mode', async () => {
    expect(await run(async () => html())).toEqual({ mode: 'local' });
    expect(await run(async () => new Response('nope', { status: 404 }))).toEqual({ mode: 'local' });
    expect(await run(async () => json({ unexpected: true }))).toEqual({ mode: 'local' });
    expect(await run(async () => new Response('{bad', { status: 200, headers: { 'content-type': 'application/json' } }))).toEqual({ mode: 'local' });
  });

  it('an Access login redirect or 401/403 means the sign-in ended', async () => {
    const redirect = { type: 'opaqueredirect', status: 0, ok: false, headers: new Headers() } as unknown as Response;
    expect(await run(async () => redirect)).toEqual({ mode: 'login-required' });
    expect(await run(async () => new Response('x', { status: 302 }))).toEqual({ mode: 'login-required' });
    expect(await run(async () => new Response('x', { status: 401 }))).toEqual({ mode: 'login-required' });
    expect(await run(async () => new Response('x', { status: 403 }))).toEqual({ mode: 'login-required' });
  });

  it('a failing-closed backend (Access not configured) is an error, not "local"', async () => {
    expect(await run(async () => new Response('Access is not configured', { status: 500 }))).toEqual({ mode: 'error', status: 500 });
  });

  it('a network failure is unreachable', async () => {
    expect(
      await run(async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).toEqual({ mode: 'unreachable' });
  });

  it('probeSession maps detection to what the sync client needs', async () => {
    expect(await probeSession(async () => json({ email: 'a@b.c', role: 'editor' }))).toBe('ok');
    expect(await probeSession(async () => new Response('x', { status: 403 }))).toBe('expired');
    expect(
      await probeSession(async () => {
        throw new TypeError('offline');
      }),
    ).toBe('unreachable');
  });
});

describe('fetchServerWorkspace / websocketUrl', () => {
  it('parses a valid export and rejects malformed ones', async () => {
    const ok = await fetchServerWorkspace(async () => new Response(JSON.stringify({ revision: 3, records: [{ kind: 'project', id: 'p', json: '{}' }] }), { status: 200 }));
    expect(ok).toEqual({ revision: 3, records: [{ kind: 'project', id: 'p', json: '{}' }] });
    expect(await fetchServerWorkspace(async () => new Response(JSON.stringify({ revision: 3, records: [{ kind: 'evil', id: 'p', json: '{}' }] })))).toBeNull();
    expect(await fetchServerWorkspace(async () => new Response(JSON.stringify({ revision: 'x', records: [] })))).toBeNull();
    expect(await fetchServerWorkspace(async () => new Response('x', { status: 403 }))).toBeNull();
    expect(
      await fetchServerWorkspace(async () => {
        throw new Error('down');
      }),
    ).toBeNull();
  });

  it('builds the socket URL for http and https pages', () => {
    expect(websocketUrl({ protocol: 'https:', host: 'ganttchart.me.workers.dev' })).toBe('wss://ganttchart.me.workers.dev/ws');
    expect(websocketUrl({ protocol: 'http:', host: 'localhost:8787' })).toBe('ws://localhost:8787/ws');
  });
});
