import type Database from 'better-sqlite3';

const initialSchema = `
CREATE TABLE users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)), created_at INTEGER NOT NULL
);
CREATE TABLE initialization (
  id INTEGER PRIMARY KEY CHECK(id = 1), initialized_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id),
  csrf_token TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at > created_at)
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE files (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
  name_key TEXT NOT NULL, blob_key TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL CHECK(revision >= 1),
  size INTEGER NOT NULL CHECK(size >= 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(owner_id, name_key)
);
CREATE TABLE edit_leases (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id), session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  window_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL
);
CREATE INDEX edit_leases_user ON edit_leases(user_id);
CREATE INDEX edit_leases_session ON edit_leases(session_id);
`;
export function migrate(db: Database.Database): void {
  db.transaction(() => {
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version > 1) throw new Error('数据库版本高于当前服务支持的版本');
    if (version === 0) { db.exec(initialSchema); db.pragma('user_version = 1'); }
  }).immediate();
}
