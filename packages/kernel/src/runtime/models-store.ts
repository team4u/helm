/**
 * 文件版动态模型目录缓存（models-store.json）：pi-ai ModelsStore 的持久实现。
 *
 * 职责：
 * - 按 providerId 持久化动态目录条目（ModelsStoreEntry：models/etag/lastModified/
 *   checkedAt），重启后 models.refresh({ allowNetwork: false }) 可离线恢复缓存目录；
 * - read/write/delete 全部经 withFileLock 按真实路径进程内串行 + 原子落盘（0600），
 *   并发 update 不丢失彼此写入；
 * - 文件不存在（ENOENT）返回空目录；JSON 解析失败或顶层非 plain object 显式抛
 *   HelmError('models_store_corrupted')，绝不静默当空目录用（诚实性纪律）。
 *
 * 该文件不含任何密钥（模型目录元数据非机密；0600 仅为一致性保守权限）。
 */

import type { ModelsStore, ModelsStoreEntry } from '@earendil-works/pi-ai'
import { HelmError } from '@helm/protocol'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteJson } from '../services/atomic-file.js'
import { withFileLock } from '../services/file-lock.js'

/** 顶层形状：providerId -> 持久化目录条目。 */
type StoreShape = Record<string, ModelsStoreEntry>

/** ModelsStore.update 变更函数：undefined = 不改写；null = 删除；对象 = 写入。 */
type Mutation = (current: ModelsStoreEntry | undefined) => Promise<ModelsStoreEntry | null | undefined> | ModelsStoreEntry | null | undefined

/** ENOENT 判定（文件缺失是合法空目录，其余读取错误原样上抛）。 */
function isNoSuchFileError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOENT'
  )
}

/** 读取并解析 models-store.json；损坏显式抛 models_store_corrupted（不静默清空）。 */
async function loadRaw(path: string): Promise<StoreShape> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if (isNoSuchFileError(err)) return {}
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new HelmError(
      'models_store_corrupted',
      `models-store.json 不是合法 JSON（${path}）：${err instanceof Error ? err.message : String(err)}`,
      500,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HelmError(
      'models_store_corrupted',
      `models-store.json 顶层需为对象（providerId -> 目录条目）：${path}`,
      500,
    )
  }
  return parsed as StoreShape
}

/**
 * 文件版 ModelsStore（单 Hub 进程使用；跨进程写并发不在本契约范围——
 * CLI 一律经 HTTP 触发内核刷新，不直写该文件）。
 */
export class FileModelsStore implements ModelsStore {
  private readonly path: string

  constructor(dataDir: string) {
    this.path = join(dataDir, 'models-store.json')
  }

  async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
    return withFileLock(this.path, async () => {
      const current = await loadRaw(this.path)
      return current[providerId] !== undefined ? structuredClone(current[providerId]) : undefined
    })
  }

  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
    await this.update(providerId, () => entry)
  }

  async delete(providerId: string): Promise<void> {
    await this.update(providerId, () => null)
  }

  /** 锁内读改写：fn 返回 undefined 不改写；null 删除；对象写入并原子落盘。 */
  async update(providerId: string, fn: Mutation): Promise<void> {
    await withFileLock(this.path, async () => {
      const current = await loadRaw(this.path)
      const next = await fn(current[providerId])
      if (next === undefined) return
      if (next === null) delete current[providerId]
      else current[providerId] = next
      await atomicWriteJson(this.path, current, { mode: 0o600 })
    })
  }
}

/** 工厂：与 services 层其余存储同构（dataDir -> FileModelsStore）。 */
export function createFileModelsStore(dataDir: string): FileModelsStore {
  return new FileModelsStore(dataDir)
}
