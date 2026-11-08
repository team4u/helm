/**
 * 单一 state.sqlite：pi-durable 原生表（pi_ 前缀）+ helm 自有表 + FTS5 派生索引。
 * 所有 SQL 一律经同一 NodeSqliteDatabase adapter 排队执行（事务期间 adapter 会
 * 排队其他操作，绕过 facade 的裸调用可能与 pi 事务互相回滚）——绝不另开连接。
 * 持久化 PRAGMA 经 adapter 在打开时显式设置：journal_mode=WAL、
 * synchronous=NORMAL、busy_timeout=5000ms、wal_autocheckpoint=1000 页。
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite'
import type { SqliteStorage as SqliteStorageT } from '@earendil-works/pi-durable/storage/sqlite'
import type { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { join } from 'node:path'

export interface HelmDatabase {
  storage: SqliteStorageT
  /** helm 自有表读写，同样排队在同一连接上。 */
  db: NodeSqliteDatabase
  /** 幂等关闭：重复调用（如 harness.close 已关 storage 后）不抛错。 */
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
CREATE TABLE IF NOT EXISTS helm_workflow_runs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  result TEXT,
  error TEXT,
  nodes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
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
 * FTS5 表单独建：tokenize 配置在 schema 版本化之外，重建入口见 HelmStore.rebuildFts。
 * body 存脱敏后的纯文本（secret 值永不入库）。
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
 * 打开（或创建）唯一 state.sqlite；pi 表与 helm 表共享同一连接与事务队列。
 * adapter 由 openNodeSqliteDatabase 构建（单连接、WAL、synchronous=NORMAL、
 * busy_timeout=5s；不接触裸 node:sqlite 句柄）。
 */
export async function openHelmDatabase(dataDir: string): Promise<HelmDatabase> {
  const statePath = join(dataDir, 'state.sqlite')
  const db = await openNodeSqliteDatabase(statePath)
  const storage = await SqliteStorage.open(db, { prefix: 'pi_' })
  // helm 表 DDL 也走 adapter（排队，避免与 pi 迁移竞争）。开发阶段直接采用新 schema。
  await db.exec(HELM_SCHEMA)
  await db.exec(FTS_SCHEMA)
  let closed = false
  return {
    storage,
    db,
    async close() {
      // 幂等：SDK 侧（harness.close -> storage.close）可能已关闭同一连接，
      // SqliteStorage.close 与 adapter.close 均缓存/置位幂等，这里再显式置位
      // 防御未来 SDK 行为变化，保证重复关闭不抛错。
      if (closed) return
      closed = true
      await storage.close(BACKGROUND_CONTEXT)
      await db.close()
    },
  }
}
