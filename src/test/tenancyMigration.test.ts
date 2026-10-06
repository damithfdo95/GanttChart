import { beforeEach, describe, expect, it } from 'vitest';
import type { RecordPut } from '../../shared/protocol';
import { REPLACE_CONFIRMATION, SWITCH_TO_LOCAL_CONFIRMATION, canonicalRecordsHash, summarizeRecords } from '../../shared/tenancy';
import { ApiError, type ExportAll, type ServerState, type TenancyApi, type UploadBody, type UploadOk } from '../lib/tenancy/api';
import { completeWebToLocal, planLocalToWeb, prepareWebToLocal, runLocalToWeb, type LocalWorkspace, type MigrationDeps } from '../lib/tenancy/migration';
import { reportsToRecords } from '../lib/sync/records';
import { newProjectRecord } from '../domain/projects/lifecycle';
import { qaInputsFromAppState } from '../domain/projects/migrations';
import { DEMO_STATE, normalizeAppState } from '../lib/storage/storage';
import { defaultReportsState } from '../lib/storage/reports';
import type { DailyTopic, ProjectRecord, ReportsState } from '../types';

// ---- fixtures ----

function project(name: string): ProjectRecord {
  const p = newProjectRecord(qaInputsFromAppState(normalizeAppState({ ...DEMO_STATE })), { nameEn: name, nameJa: name, team: 'QA', status: 'ongoing' }, '2026-10-01T00:00:00Z');
  return { ...p, id: `id-${name}`, projectId: `PRJ-${name}` };
}
const topic = (id: string): DailyTopic => ({ id, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }) as unknown as DailyTopic;

function workspace(names: string[]): LocalWorkspace {
  const reports: ReportsState = { ...defaultReportsState(), projects: names.map(project), topics: [topic('t1')], activeProjectId: `id-${names[0]}` };
  return { app: normalizeAppState({ ...DEMO_STATE }), reports };
}

/** An in-memory cloud with the same rules as the real server, and switches to break each step. */
class FakeCloud implements TenancyApi {
  records: RecordPut[] = [];
  revision = 0;
  mode: 'local' | 'web' = 'local';
  frozen = false;
  calls: string[] = [];
  fail: Partial<Record<'inspect' | 'upload' | 'activate' | 'deactivate' | 'export', ApiError | Error>> = {};
  corruptUploadHash = false;
  corruptExportHash = false;
  tamperReadBack = false;

  private async state(): Promise<ServerState> {
    return { revision: this.revision, hash: await canonicalRecordsHash(this.records), counts: summarizeRecords(this.records), hasData: this.records.some((r) => r.kind !== 'settings'), frozen: this.frozen };
  }
  private maybeFail(k: keyof FakeCloud['fail']): void {
    const e = this.fail[k];
    if (e) throw e;
  }
  async inspect() {
    this.calls.push('inspect');
    this.maybeFail('inspect');
    const server = await this.state();
    if (this.tamperReadBack) server.hash = 'f'.repeat(64);
    return { tenant: { id: 'ten_x', name: 'T', storageMode: this.mode, status: 'active' as const, createdAt: '', deletionRequestedAt: null }, server };
  }
  async upload(b: UploadBody): Promise<UploadOk> {
    this.calls.push(`upload${b.replace ? ':replace' : ''}`);
    this.maybeFail('upload');
    const incoming = await canonicalRecordsHash(b.records);
    const current = await canonicalRecordsHash(this.records);
    if (incoming !== current) {
      if (b.expectedRevision !== this.revision) throw new ApiError(409, 'revision_mismatch', {});
      if (this.records.some((r) => r.kind !== 'settings') && !b.replace) throw new ApiError(409, 'server_not_empty', {});
      if (b.replace && b.confirm !== REPLACE_CONFIRMATION) throw new ApiError(400, 'confirmation_required', {});
      this.records = [...b.records];
      this.revision += 1;
    }
    const hash = this.corruptUploadHash ? 'e'.repeat(64) : await canonicalRecordsHash(this.records);
    return { ok: true, revision: this.revision, hash, counts: summarizeRecords(this.records), alreadyApplied: incoming === current };
  }
  async activateWeb(revision: number, hash: string) {
    this.calls.push('activate');
    this.maybeFail('activate');
    if (revision !== this.revision || hash !== (await canonicalRecordsHash(this.records))) throw new ApiError(409, 'verification_failed', {});
    this.mode = 'web';
    this.frozen = false;
    return { tenant: { id: 'ten_x', name: 'T', storageMode: 'web' as const, status: 'active' as const, createdAt: '', deletionRequestedAt: null } };
  }
  async deactivateWeb(revision: number, hash: string, confirm: string) {
    this.calls.push('deactivate');
    this.maybeFail('deactivate');
    if (confirm !== SWITCH_TO_LOCAL_CONFIRMATION) throw new ApiError(400, 'confirmation_required', {});
    if (revision !== this.revision || hash !== (await canonicalRecordsHash(this.records))) throw new ApiError(409, 'workspace_changed', {});
    this.mode = 'local';
    this.frozen = true;
    return { tenant: { id: 'ten_x', name: 'T', storageMode: 'local' as const, status: 'active' as const, createdAt: '', deletionRequestedAt: null }, cloudCopy: 'archived' };
  }
  async exportAll(): Promise<ExportAll> {
    this.calls.push('export');
    this.maybeFail('export');
    return { revision: this.revision, hash: this.corruptExportHash ? 'd'.repeat(64) : await canonicalRecordsHash(this.records), records: [...this.records] };
  }
  // The rest of the interface is not used by migration.
  whoami = async () => { throw new Error('unused'); };
  listUsers = async () => { throw new Error('unused'); };
  createUser = async () => { throw new Error('unused'); };
  updateUser = async () => { throw new Error('unused'); };
  requestDeletion = async () => { throw new Error('unused'); };
  cancelDeletion = async () => { throw new Error('unused'); };
  listTenants = async () => { throw new Error('unused'); };
  createTenant = async () => { throw new Error('unused'); };
  setTenantStatus = async () => { throw new Error('unused'); };
  approveDeletion = async () => { throw new Error('unused'); };
  audit = async () => { throw new Error('unused'); };
}

class Device {
  backups: LocalWorkspace[] = [];
  saved: LocalWorkspace | null = null;
  adopted: { revision: number; records: RecordPut[] } | null = null;
  unlinked = false;
  failBackup = false;
  failSave = false;
  dropOnSave = false; // the "database" silently loses a record
  readBackNull = false;

  deps(api: TenancyApi): MigrationDeps {
    return {
      api,
      downloadBackup: (w) => {
        if (this.failBackup) throw new Error('disk full');
        this.backups.push(w);
      },
      saveLocal: async (w) => {
        if (this.failSave) throw new Error('quota');
        this.saved = this.dropOnSave ? { ...w, reports: { ...w.reports, topics: [], rcsMembers: [] } } : w;
      },
      loadLocal: async () => (this.readBackNull ? null : this.saved),
      adoptWebDevice: (b) => {
        this.adopted = b;
      },
      unlinkDevice: () => {
        this.unlinked = true;
      },
    };
  }
}

let cloud: FakeCloud;
let device: Device;
beforeEach(() => {
  cloud = new FakeCloud();
  device = new Device();
});

async function plan(local: LocalWorkspace) {
  const r = await planLocalToWeb(local, cloud);
  if (!r.ok) throw new Error(`plan failed: ${r.error}`);
  return r.plan;
}

describe('Local → Web: inspect first (changes nothing)', () => {
  it('describes both sides and what would happen', async () => {
    const local = workspace(['A', 'B']);
    const p = await plan(local);
    expect(p.local.counts).toMatchObject({ project: 2, topic: 1 });
    expect(p.server).toMatchObject({ revision: 0, hasData: false });
    expect(p.needsReplace).toBe(false);
    expect(p.alreadyUploaded).toBe(false);
    expect(cloud.calls).toEqual(['inspect']); // read-only
  });

  it('flags that existing cloud data would be replaced', async () => {
    cloud.records = [{ kind: 'project', id: 'other', json: '{"id":"other"}' }];
    cloud.revision = 3;
    const p = await plan(workspace(['A']));
    expect(p.needsReplace).toBe(true);
    expect(p.server.hasData).toBe(true);
  });

  it('recognises an earlier attempt that already uploaded the same workspace', async () => {
    const local = workspace(['A']);
    cloud.records = [...reportsToRecords(local.reports).values()];
    cloud.revision = 1;
    expect(await plan(local)).toMatchObject({ alreadyUploaded: true, needsReplace: false });
  });

  it('reports an unreachable server instead of guessing', async () => {
    cloud.fail.inspect = new ApiError(500, 'Internal error', {});
    expect(await planLocalToWeb(workspace(['A']), cloud)).toMatchObject({ ok: false, error: 'server_unreachable' });
  });
});

describe('Local → Web: the happy path', () => {
  it('backs up, uploads atomically, verifies, activates, and only THEN adopts the device', async () => {
    const local = workspace(['A']);
    const p = await plan(local);
    const r = await runLocalToWeb(local, p, {}, device.deps(cloud));
    expect(r).toMatchObject({ ok: true, revision: 1 });
    expect(device.backups).toHaveLength(1); // a backup file was produced
    expect(cloud.calls).toEqual(['inspect', 'upload', 'inspect', 'activate']); // upload, fresh read-back, then switch
    expect(cloud.mode).toBe('web');
    expect(cloud.records.length).toBe(p.local.records.length);
    expect(device.adopted).toMatchObject({ revision: 1 });
    expect(device.adopted?.records).toEqual(p.local.records);
  });

  it('is retry-safe: running the whole migration twice leaves ONE revision and no duplicate data', async () => {
    const local = workspace(['A']);
    const first = await runLocalToWeb(local, await plan(local), {}, device.deps(cloud));
    cloud.mode = 'local'; // pretend the activation response was lost; the user retries
    const again = await runLocalToWeb(local, await plan(local), {}, device.deps(cloud));
    expect(first).toMatchObject({ ok: true, revision: 1 });
    expect(again).toMatchObject({ ok: true, revision: 1 });
    expect(cloud.revision).toBe(1);
  });
});

describe('Local → Web: it never overwrites cloud data silently', () => {
  beforeEach(() => {
    cloud.records = [{ kind: 'project', id: 'cloud-p', json: '{"id":"cloud-p","name":"CLOUD DATA"}' }];
    cloud.revision = 4;
  });

  it('refuses to proceed without the explicit replace choice and the typed confirmation — and touches nothing', async () => {
    const local = workspace(['A']);
    const p = await plan(local);
    for (const options of [{}, { replace: true }, { replace: true, typed: 'replace' }, { replace: false, typed: REPLACE_CONFIRMATION }]) {
      const r = await runLocalToWeb(local, p, options, device.deps(cloud));
      expect(r).toMatchObject({ ok: false, step: 'confirm', error: 'replace_not_confirmed', sourceIntact: true });
    }
    expect(device.backups).toHaveLength(0);
    expect(cloud.calls.filter((c) => c.startsWith('upload'))).toEqual([]);
    expect(cloud.records[0].json).toContain('CLOUD DATA');
    expect(cloud.mode).toBe('local');
  });

  it('with the deliberate choice it replaces — after a backup — and the device is adopted', async () => {
    const local = workspace(['A']);
    const r = await runLocalToWeb(local, await plan(local), { replace: true, typed: REPLACE_CONFIRMATION }, device.deps(cloud));
    expect(r).toMatchObject({ ok: true, revision: 5 });
    expect(device.backups).toHaveLength(1);
    expect(cloud.calls).toContain('upload:replace');
    expect(cloud.records.some((x) => x.json.includes('CLOUD DATA'))).toBe(false);
  });

  it('if someone changed the cloud since inspection, the upload is refused and nothing is switched', async () => {
    const local = workspace(['A']);
    const p = await plan(local);
    cloud.revision = 9; // changed meanwhile
    const r = await runLocalToWeb(local, p, { replace: true, typed: REPLACE_CONFIRMATION }, device.deps(cloud));
    expect(r).toMatchObject({ ok: false, step: 'upload', error: 'revision_mismatch' });
    expect(cloud.mode).toBe('local');
    expect(device.adopted).toBeNull();
  });
});

describe('Local → Web: any failure leaves the LOCAL workspace authoritative', () => {
  const sourceIntact = () => {
    expect(cloud.mode).toBe('local');
    expect(device.adopted).toBeNull();
    expect(device.unlinked).toBe(false);
  };

  it('backup fails → nothing is uploaded', async () => {
    device.failBackup = true;
    const local = workspace(['A']);
    const r = await runLocalToWeb(local, await plan(local), {}, device.deps(cloud));
    expect(r).toMatchObject({ ok: false, step: 'backup', sourceIntact: true });
    expect(cloud.calls).toEqual(['inspect']);
    sourceIntact();
  });

  it('upload fails → no switch', async () => {
    cloud.fail.upload = new ApiError(500, 'failed', {});
    const local = workspace(['A']);
    expect(await runLocalToWeb(local, await plan(local), {}, device.deps(cloud))).toMatchObject({ ok: false, step: 'upload', error: 'failed' });
    sourceIntact();
  });

  it('the server reports a different hash than what was sent → verification fails, no switch', async () => {
    cloud.corruptUploadHash = true;
    const local = workspace(['A']);
    expect(await runLocalToWeb(local, await plan(local), {}, device.deps(cloud))).toMatchObject({ ok: false, step: 'verify', error: 'hash_mismatch' });
    expect(cloud.calls).not.toContain('activate');
    sourceIntact();
  });

  it('a fresh read of the server disagrees → verification fails, no switch', async () => {
    const local = workspace(['A']);
    const p = await plan(local);
    cloud.tamperReadBack = true;
    expect(await runLocalToWeb(local, p, {}, device.deps(cloud))).toMatchObject({ ok: false, step: 'verify', error: 'read_back_mismatch' });
    expect(cloud.calls).not.toContain('activate');
    sourceIntact();
  });

  it('the read-back cannot be performed → no switch', async () => {
    const local = workspace(['A']);
    const p = await plan(local);
    let n = 0;
    const flaky = Object.create(cloud) as FakeCloud;
    flaky.inspect = async () => {
      n += 1;
      if (n > 0) throw new ApiError(503, 'unavailable', {});
      return cloud.inspect();
    };
    expect(await runLocalToWeb(local, p, {}, device.deps(flaky))).toMatchObject({ ok: false, step: 'verify', error: 'read_back_failed' });
    sourceIntact();
  });

  it('the server refuses to activate → stays local, and a retry can succeed', async () => {
    cloud.fail.activate = new ApiError(409, 'verification_failed', {});
    const local = workspace(['A']);
    const p = await plan(local);
    expect(await runLocalToWeb(local, p, {}, device.deps(cloud))).toMatchObject({ ok: false, step: 'activate', error: 'verification_failed' });
    sourceIntact();
    delete cloud.fail.activate;
    const retry = await runLocalToWeb(local, await plan(local), {}, device.deps(cloud));
    expect(retry).toMatchObject({ ok: true });
    expect(cloud.revision).toBe(1); // the upload was not repeated
  });
});

describe('Web → Local: prepare (download, validate, save, read back)', () => {
  async function cloudWithData() {
    const local = workspace(['A', 'B']);
    cloud.records = [...reportsToRecords(local.reports).values()];
    cloud.revision = 7;
    cloud.mode = 'web';
    return local;
  }

  it('saves a verified local copy and reports what to switch against; changes nothing in the cloud', async () => {
    const local = await cloudWithData();
    const r = await prepareWebToLocal({ app: local.app, reports: defaultReportsState() }, device.deps(cloud));
    expect(r).toMatchObject({ ok: true, prepared: { revision: 7 } });
    expect(device.saved?.reports.projects.map((p) => p.id).sort()).toEqual(['id-A', 'id-B']);
    expect(cloud.calls).toEqual(['export']);
    expect(cloud.mode).toBe('web');
    expect(cloud.frozen).toBe(false);
  });

  it.each([
    ['the download fails', () => (cloud.fail.export = new ApiError(500, 'x', {})), 'verify', 'x'],
    ['the snapshot is corrupted in transit', () => (cloud.corruptExportHash = true), 'verify', 'snapshot_corrupt'],
    ['the local save fails', () => (device.failSave = true), 'save', 'local_save_failed'],
    ['the local database cannot be read back', () => (device.readBackNull = true), 'save', 'local_read_back_failed'],
    ['the local database silently drops records', () => (device.dropOnSave = true), 'save', 'local_copy_incomplete'],
  ])('%s → it stops, and the cloud is still live', async (_name, arrange, step, error) => {
    const local = await cloudWithData();
    arrange();
    const r = await prepareWebToLocal({ app: local.app, reports: defaultReportsState() }, device.deps(cloud));
    expect(r).toMatchObject({ ok: false, step, error });
    expect(cloud.mode).toBe('web');
    expect(cloud.calls).not.toContain('deactivate');
    expect(device.unlinked).toBe(false);
  });
});

describe('Web → Local: the deliberate switch', () => {
  async function prepared() {
    const local = workspace(['A']);
    cloud.records = [...reportsToRecords(local.reports).values()];
    cloud.revision = 3;
    cloud.mode = 'web';
    const r = await prepareWebToLocal({ app: local.app, reports: defaultReportsState() }, device.deps(cloud));
    if (!r.ok) throw new Error('prepare failed');
    return r.prepared;
  }

  it('needs the exact typed word; anything else does nothing at all', async () => {
    const p = await prepared();
    for (const typed of ['', 'local', ' LOCAL', 'yes', REPLACE_CONFIRMATION]) {
      expect(await completeWebToLocal(p, typed, device.deps(cloud))).toMatchObject({ ok: false, step: 'confirm', error: 'not_confirmed' });
    }
    expect(cloud.calls).not.toContain('deactivate');
    expect(cloud.mode).toBe('web');
  });

  it('switches, forgets this device’s sync baseline, and KEEPS the cloud copy (archived)', async () => {
    const p = await prepared();
    const r = await completeWebToLocal(p, SWITCH_TO_LOCAL_CONFIRMATION, device.deps(cloud));
    expect(r).toEqual({ ok: true });
    expect(cloud.mode).toBe('local');
    expect(cloud.frozen).toBe(true);
    expect(cloud.records.length).toBeGreaterThan(0); // not deleted
    expect(device.unlinked).toBe(true);
  });

  it('if a collaborator changed the workspace after the download, the switch is refused and the device stays linked', async () => {
    const p = await prepared();
    cloud.revision += 1;
    cloud.records = [...cloud.records, { kind: 'topic', id: 'late', json: '{"id":"late"}' }];
    const r = await completeWebToLocal(p, SWITCH_TO_LOCAL_CONFIRMATION, device.deps(cloud));
    expect(r).toMatchObject({ ok: false, step: 'switch', error: 'workspace_changed', sourceIntact: true });
    expect(cloud.mode).toBe('web');
    expect(device.unlinked).toBe(false);
  });

  it('a failing server leaves everything as it was', async () => {
    const p = await prepared();
    cloud.fail.deactivate = new ApiError(500, 'boom', {});
    expect(await completeWebToLocal(p, SWITCH_TO_LOCAL_CONFIRMATION, device.deps(cloud))).toMatchObject({ ok: false, step: 'switch' });
    expect(cloud.mode).toBe('web');
    expect(device.unlinked).toBe(false);
  });
});
