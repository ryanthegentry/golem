/**
 * Adapter: better-sqlite3 → @arkade-os/sdk SQLExecutor interface.
 *
 * better-sqlite3 is synchronous; SQLExecutor expects async.
 * This adapter wraps sync calls in resolved promises.
 */

import type Database from 'better-sqlite3';
import type { SQLExecutor } from '@arkade-os/sdk/repositories/sqlite';

export function createSQLExecutor(db: Database.Database): SQLExecutor {
  return {
    async run(sql: string, params?: unknown[]): Promise<void> {
      db.prepare(sql).run(...(params ?? []));
    },
    async get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined> {
      return db.prepare(sql).get(...(params ?? [])) as T | undefined;
    },
    async all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      return db.prepare(sql).all(...(params ?? [])) as T[];
    },
  };
}
