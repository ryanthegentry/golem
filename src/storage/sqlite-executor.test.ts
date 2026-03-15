/**
 * SQLExecutor adapter tests — verifies better-sqlite3 ↔ @arkade-os/sdk compatibility.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { createSQLExecutor } from './sqlite-executor.js';

let tmpDir: string;
let db: Database.Database;

afterEach(() => {
  if (db) db.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createSQLExecutor', () => {
  it('run executes SQL statements', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-exec-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    const executor = createSQLExecutor(db);

    await executor.run('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
    await executor.run('INSERT INTO test (id, name) VALUES (?, ?)', [1, 'alice']);

    const row = await executor.get<{ id: number; name: string }>('SELECT * FROM test WHERE id = ?', [1]);
    expect(row).toEqual({ id: 1, name: 'alice' });
  });

  it('get returns undefined for no match', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-exec-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    const executor = createSQLExecutor(db);

    await executor.run('CREATE TABLE test (id INTEGER PRIMARY KEY)');
    const row = await executor.get('SELECT * FROM test WHERE id = ?', [999]);
    expect(row).toBeUndefined();
  });

  it('all returns array of rows', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-exec-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    const executor = createSQLExecutor(db);

    await executor.run('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
    await executor.run('INSERT INTO test (id, name) VALUES (?, ?)', [1, 'alice']);
    await executor.run('INSERT INTO test (id, name) VALUES (?, ?)', [2, 'bob']);

    const rows = await executor.all<{ id: number; name: string }>('SELECT * FROM test ORDER BY id');
    expect(rows).toEqual([
      { id: 1, name: 'alice' },
      { id: 2, name: 'bob' },
    ]);
  });

  it('all returns empty array for no matches', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-exec-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    const executor = createSQLExecutor(db);

    await executor.run('CREATE TABLE test (id INTEGER PRIMARY KEY)');
    const rows = await executor.all('SELECT * FROM test');
    expect(rows).toEqual([]);
  });

  it('handles params as undefined (no params)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-exec-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    const executor = createSQLExecutor(db);

    await executor.run('CREATE TABLE test (id INTEGER PRIMARY KEY DEFAULT 1)');
    await executor.run('INSERT INTO test DEFAULT VALUES');
    const row = await executor.get('SELECT * FROM test');
    expect(row).toEqual({ id: 1 });
  });
});
