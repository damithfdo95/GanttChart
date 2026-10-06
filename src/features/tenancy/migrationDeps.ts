import type { MigrationDeps } from '../../lib/tenancy/migration';
import type { TenancyApi } from '../../lib/tenancy/api';
import { createBackupPayload } from '../../lib/backup/backup';
import { downloadTextFile } from '../../lib/export/download';
import { getStorageDiagnostics, loadWorkspaceFromIndexedDb, persistWorkspaceAsync } from '../../lib/storage/db/persistenceBackend';
import { recordKey } from '../../lib/sync/records';
import { unlinkDevice, writeLink, writeMirror } from '../../lib/sync/device';

function stamp(): string {
  return new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
}

/**
 * The real, browser-backed dependencies of the storage migrations. All the
 * decisions live in lib/tenancy/migration.ts (pure and tested); this only does
 * the I/O.
 */
export function browserMigrationDeps(api: TenancyApi, who: { email: string; tenantId: string }): MigrationDeps {
  return {
    api,
    downloadBackup(workspace) {
      downloadTextFile(`ganttchart-before-storage-change-${stamp()}.json`, 'application/json', JSON.stringify(createBackupPayload(workspace.app, workspace.reports), null, 2));
    },
    async saveLocal(workspace) {
      const result = await persistWorkspaceAsync(workspace.app, workspace.reports, { reason: 'import', forceRevision: true });
      if (!result.ok) throw new Error('local_save_failed');
    },
    async loadLocal() {
      // Reading back is only meaningful from the real database; the localStorage fallback cannot prove completeness.
      if ((await getStorageDiagnostics()).mode !== 'indexeddb') return null;
      const loaded = await loadWorkspaceFromIndexedDb();
      return loaded.ok ? { app: loaded.app, reports: loaded.reports } : null;
    },
    adoptWebDevice(baseline) {
      const records: Record<string, string> = {};
      for (const r of baseline.records) records[recordKey(r.kind, r.id)] = r.json;
      writeMirror({ revision: baseline.revision, records });
      writeLink({ origin: window.location.origin, linkedAt: new Date().toISOString(), email: who.email, tenantId: who.tenantId });
    },
    unlinkDevice() {
      unlinkDevice();
    },
  };
}
