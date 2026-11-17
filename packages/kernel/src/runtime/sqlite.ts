/**
 * Single unified `state.sqlite`: pi-durable generated tables (`pi_` prefix) + helm-owned tables + FTS5 derived index.
 * All SQL goes through the same `NodeSqliteDatabase` adapter serialized queue (during transactions the adapter
 * queues other operations; raw calls bypassing this facade can conflict with pi transactions or roll back each
 * other) — never open a second connection.
 * Persistence PRAGMAs are configured explicitly when opening via the adapter: `journal_mode=WAL`,
 * `synchronous=NORMAL`, `busy_timeout=5000ms`, `wal_autocheckpoint=1000` pages.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { SqliteDatabase } from '@earendil-works/chord/sqlite'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite'
import type { SqliteStorage as SqliteStorageT } from '@earendil-works/pi-durable/storage/sqlite'
import type { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { join } from 'node:path'

export interface HelmDatabase {
  storage: SqliteStorageT
  /** Read/write access for helm-owned tables, serialized on the same database connection. */
  db: NodeSqliteDatabase
  /** Idempotent close: repeated calls (e.g. after `harness.close` closes storage) will not throw. */
  close(): Promise<void>
}

const HELM_SCHEMA = `
CREATE TABLE IF NOT EXISTS helm_conversations (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  profile_id TEXT NOT NULL DEFAULT 'default',
  tags TEXT NOT NULL DEFAULT '[]',
  parent_conversation_id INTEGER,
  node_id TEXT NOT NULL DEFAULT 'local',
  cwd TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  model_override TEXT,
  thinking_level TEXT NOT NULL DEFAULT '',
  thinking_level_override TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  state_change_seq INTEGER NOT NULL DEFAULT 1,
  completion_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS helm_conversation_tool_links (
  conversation_id INTEGER PRIMARY KEY,
  parent_tool_call_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS helm_asks (
  id TEXT PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  owner_plugin_id TEXT,
  spec TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  expected_state_seq INTEGER,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE TABLE IF NOT EXISTS helm_artifacts (
  id TEXT PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS helm_artifacts_conv ON helm_artifacts (conversation_id);
CREATE TABLE IF NOT EXISTS helm_plugin_docs (
  plugin_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, name)
);
CREATE TABLE IF NOT EXISTS helm_plugin_session_docs (
  plugin_id TEXT NOT NULL,
  name TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, name, conversation_id)
);
CREATE INDEX IF NOT EXISTS helm_plugin_session_docs_conv
  ON helm_plugin_session_docs (conversation_id);
CREATE TABLE IF NOT EXISTS helm_seq (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS helm_tombstones (
  id INTEGER PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);
`

/**
 * Separate FTS5 table creation: tokenizer config is outside schema versioning; see `HelmStore.rebuildFts` for rebuilds.
 * The `body` column stores redacted plain text (secret values are never persisted).
 */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS helm_conversation_fts USING fts5(
  conversation_id UNINDEXED,
  entry_id UNINDEXED,
  title,
  body
);
`

/**
 * Open (or create) the single `state.sqlite`; pi tables and helm tables share one connection and transaction queue.
 * The adapter is built by `openNodeSqliteDatabase` (single connection, WAL, `synchronous=NORMAL`,
 * `busy_timeout=5s`; do not touch raw `node:sqlite` handles directly).
 */
export async function openHelmDatabase(dataDir: string): Promise<HelmDatabase> {
  const statePath = join(dataDir, 'state.sqlite')
  const db = await openNodeSqliteDatabase(statePath)
  // Proxy view: pi-durable `SqliteStorage` and `HelmStore` share the underlying connection and serialized
  // transaction queue, so `harness.close() -> storage.close()` must not disconnect the underlying `db` prematurely
  // (closed solely by `teardownKernelRuntime` via trailing `database.close()`).
  const storageDb: SqliteDatabase = {
    exec: (sql) => db.exec(sql),
    run: (sql, ...params) => db.run(sql, ...params),
    runCounted: (sql, ...params) => db.runCounted(sql, ...params),
    get: (sql, ...params) => db.get(sql, ...params),
    all: (sql, ...params) => db.all(sql, ...params),
    transaction: (callback) => db.transaction(callback),
    close: async () => {},
  }
  let storage: SqliteStorageT
  try {
    storage = await SqliteStorage.open(storageDb, { prefix: 'pi_' })
    // Run helm table DDL through the adapter queue as well to avoid racing pi initialization. Use latest schema directly during dev.
    await db.exec(HELM_SCHEMA)
    await db.exec(FTS_SCHEMA)
  } catch (error) {
    await db.close().catch(() => {})
    throw error
  }
  let closed = false
  return {
    storage,
    db,
    async close() {
      // Idempotent: `harness.close()` may already close `storage` (`storageDb.close` is a no-op;
      // the underlying `db` is closed only here). Keep `storage.close()` fallback for test paths opening `HelmDatabase` standalone.
      if (closed) return
      closed = true
      await storage.close(BACKGROUND_CONTEXT)
      await db.close()
    },
  }
}
