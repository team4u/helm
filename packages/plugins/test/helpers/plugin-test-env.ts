/**
 * `@helmx/plugins` 测试公共环境基座。
 *
 * 集中提供插件测试常用的内存存储（`MemoryDocStore` / `MemoryConfigStore`）、
 * `makeFauxModels()` 假模型工厂，并统一转发 `@helmx/test-kit` 各子入口常用辅助，
 * 消除各测试文件重复定义样板。
 */

import assert from 'node:assert/strict'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxProvider,
  type FauxProviderHandle,
  type RegisterFauxProviderOptions,
} from '@earendil-works/pi-ai/providers/faux'
import type { PluginConfigStore, PluginDocStore } from '../../../kernel/src/plugins/index.js'

export {
  deferred,
  jsonResponse,
  makeConversationSummary,
  makePluginSummary,
  makeProfile,
  sleep,
  waitFor,
  type Deferred,
  type WaitForOptions,
} from '@helmx/test-kit'

export {
  assertRejectsCode,
  cleanupDir,
  HOST_MANAGED_HELMX_ENV_NAMES,
  makeTempDir,
  sanitizedHostEnv,
  useTempDir,
  type CleanupRegistrar,
} from '@helmx/test-kit/node'

export {
  createGitTemplate,
  initGitRepo,
  type GitTemplate,
} from '@helmx/test-kit/git'

export type { FauxProviderHandle, RegisterFauxProviderOptions }

/**
 * 内存版 `PluginDocStore`：隔离插件全局文档（`${pluginId}:${name}`），
 * 提供 `store` / `writes` / `flushCount` 与 `clear` / `has` / `peek` / `keys` 检查辅助。
 */
export class MemoryDocStore implements PluginDocStore {
  readonly store = new Map<string, unknown>()
  readonly writes: string[] = []
  flushCount = 0

  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? structuredClone(this.store.get(key) as T) : structuredClone(initial)
  }

  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
    this.writes.push(key)
  }

  deletePlugin(pluginId: string): void {
    const prefix = `${pluginId}:`
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes(':')) {
        this.store.delete(key)
      }
    }
  }

  async flush(): Promise<void> {
    this.flushCount += 1
  }

  /** 清空已存储文档、写记录与 flush 计数。 */
  clear(): void {
    this.store.clear()
    this.writes.length = 0
    this.flushCount = 0
  }

  /** 判断指定存储键是否存在。 */
  has(key: string): boolean {
    return this.store.has(key)
  }

  /** 读取存储键的克隆快照（不触发初值回落）。 */
  peek<T = unknown>(key: string): T | undefined {
    return this.store.has(key) ? structuredClone(this.store.get(key) as T) : undefined
  }

  /** 返回当前所有存储键列表。 */
  keys(): string[] {
    return [...this.store.keys()]
  }
}

/**
 * 内存版 `PluginConfigStore`：支持可选的全局默认配置 `initial`，
 * 并按 `pluginId` 独立持久化 `set()` 写入的配置快照。
 */
export class MemoryConfigStore implements PluginConfigStore {
  readonly store = new Map<string, Record<string, unknown>>()
  private readonly defaults: Record<string, unknown>

  constructor(initial: Record<string, unknown> = {}) {
    this.defaults = structuredClone(initial)
  }

  get(pluginId: string): Record<string, unknown> {
    const saved = this.store.get(pluginId)
    return saved !== undefined ? structuredClone(saved) : structuredClone(this.defaults)
  }

  set(pluginId: string, value: Record<string, unknown>): void {
    this.store.set(pluginId, structuredClone(value))
  }

  /** 清空已写入的插件级配置覆盖。 */
  clear(): void {
    this.store.clear()
  }
}

/** 创建官方 `fauxProvider` 句柄（配合 `KernelRuntimeOptions.providers` 注入，不阻断插件 `ctx.provider`）。 */
export function makeFauxProvider(options?: RegisterFauxProviderOptions): FauxProviderHandle {
  return fauxProvider(options)
}

/** 创建挂载 `fauxProvider` 的真实 `Models` 集合与控制句柄。 */
export function makeFauxModels(options?: RegisterFauxProviderOptions): {
  models: ReturnType<typeof createModels>
  faux: FauxProviderHandle
} {
  const models = createModels()
  const faux = fauxProvider(options)
  models.setProvider(faux.provider)
  return { models, faux }
}

/** 断言异步过程不会产生逃逸 `unhandledRejection`（观察面故障须就地诊断）。 */
export async function assertNoUnhandledRejection(body: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    await body()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(unhandled, [], '不得产生 unhandledRejection（观察面故障须就地诊断）')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
}
