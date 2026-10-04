import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrate } from './migrations.js';

export function openDatabase(dataDir: string): Database.Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'metadata.sqlite'));
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    const mode = db.pragma('journal_mode = WAL', { simple: true });
    db.pragma('synchronous = FULL');
    if (mode !== 'wal' || db.pragma('synchronous', { simple: true }) !== 2) throw new Error('无法启用 SQLite 持久化配置');
    migrate(db);
    return db;
  } catch (error) { db.close(); throw error; }
}
