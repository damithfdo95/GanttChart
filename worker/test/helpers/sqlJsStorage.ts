import initSqlJs from 'sql.js';
import type { SqlValue, StoreStorage } from '../../src/store';

/** In-memory real SQLite (sql.js) behind the same interface as ctx.storage. */
export async function createTestStorage(): Promise<StoreStorage & { failOn: (needle: string | null) => void; writes: { count: number } }> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  let failNeedle: string | null = null;
  const writes = { count: 0 };
  return {
    writes,
    failOn(needle) {
      failNeedle = needle;
    },
    sql: {
      exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]) {
        if (failNeedle !== null && query.includes(failNeedle)) throw new Error(`injected failure: ${failNeedle}`);
        if (/^\s*(INSERT|UPDATE|DELETE)/i.test(query)) writes.count += 1;
        const stmt = db.prepare(query);
        try {
          if (bindings.length > 0) {
            // The store only ever binds strings/numbers/null; sql.js has no ArrayBuffer binding.
            stmt.bind(bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b)));
          }
          const rows: T[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject() as T);
          return {
            toArray: () => rows,
            one: () => {
              if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
              return rows[0];
            },
          };
        } finally {
          stmt.free();
        }
      },
    },
    transactionSync<R>(fn: () => R): R {
      db.run('BEGIN');
      try {
        const result = fn();
        db.run('COMMIT');
        return result;
      } catch (error) {
        db.run('ROLLBACK');
        throw error;
      }
    },
  };
}
