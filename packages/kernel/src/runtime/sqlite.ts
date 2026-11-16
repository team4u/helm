/**
 * single one state.sqlite:pi-durable original generate table (pi_ prefix)+ helm self has table + FTS5 derive index.
 * all SQL one rule via the same NodeSqliteDatabase adapter queue up execute (transaction during adapter will
 * queue up other operation, bypass facade bare invoke may and pi transaction mutual each other rollback) - - never another open connect.
 * persist PRAGMA via adapter in open when explicit settings:journal_mode=WAL,
 * synchronous=NORMAL,busy_timeout=5000ms,wal_autocheckpoint=1000 page.
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
  /** helm self has table read write, same queue up in the same connect on. */
  db: NodeSqliteDatabase
  /** idempotent close: duplicate invoke (such as harness.close already closure storage after) do not throws. */
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
 * FTS5 table separate create:tokenize config in schema version of outside, rebuild entry see HelmStore.rebuildFts.
 * body store redaction after pure text (secret value forever do not store).
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
 * open (or create) unique state.sqlite;pi table and helm table sharing the same connect and transaction queue.
 * adapter by openNodeSqliteDatabase build (single connect,WAL,synchronous=NORMAL,
 * busy_timeout=5s; do not connect trigger bare node:sqlite handle).
 */
export async function openHelmDatabase(dataDir: string): Promise<HelmDatabase> {
  const statePath = join(dataDir, 'state.sqlite')
  const db = await openNodeSqliteDatabase(statePath)
  // proxy view:pi-durable SqliteStorage and HelmStore sharing the same thing connect and serial
  // transaction queue, therefore harness.close() -> storage.close() when must not mention before disconnect thing db
  // (by teardownKernelRuntime tail database.close() unique close).
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
    // helm table DDL also away adapter(queue up, avoid and pi migration competition). development phase directly adopt new schema.
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
      // idempotent:harness.close() may already close storage(storageDb.close is no-op,
      // thing db by this where unique close); keep storage.close() fall back ensure separate open
      // HelmDatabase test path same seal opening storage.
      if (closed) return
      closed = true
      await storage.close(BACKGROUND_CONTEXT)
      await db.close()
    },
  }
}
