/**
 * helm 内核服务测试基座：委托 `@helm/test-kit` 提供目录、等待、DTO 与内存存储夹具。
 * 保持纯内存模块（无 `node:fs` / `node:child_process` 直接导入），确保纯测试可分片运行。
 */
import assert from 'node:assert/strict'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import {
  deferred,
  makeConversationSummary,
  makePluginSummary,
  makeProfile,
  sleep,
  type Deferred,
} from '@helm/test-kit'
import {
  assertRejectsCode,
  cleanupDir,
  makeTempDir as kitMakeTempDir,
  useTempDir,
  waitFor as kitWaitFor,
  type CleanupRegistrar,
  type WaitForOptions,
} from '@helm/test-kit/node'
import type { PluginConfigStore, PluginDocStore } from '../src/plugins/index.js'

/** 每个测试组独立的临时数据目录（真实文件行为）。 */
export async function makeTempDir(prefix = 'helm-services-test-'): Promise<string> {
  return kitMakeTempDir(prefix)
}

/** 轮询等待条件成立（支持位置参数 `(predicate, timeoutMs, intervalMs)` 与选项对象）。 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutOrOptions: number | WaitForOptions = {},
  intervalMs?: number,
): Promise<void> {
  const options: WaitForOptions =
    typeof timeoutOrOptions === 'number'
      ? { timeoutMs: timeoutOrOptions, ...(intervalMs !== undefined ? { intervalMs } : {}) }
      : timeoutOrOptions
  return kitWaitFor(predicate, options)
}

/** 内存插件全局文档存储实现，供插件/宿主测试共享。 */
export class MemoryDocStore implements PluginDocStore {
  readonly store = new Map<string, unknown>()

  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (structuredClone(this.store.get(key)) as T) : initial
  }

  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
  }

  deletePlugin(pluginId: string): void {
    const prefix = `${pluginId}:`
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes(':')) this.store.delete(key)
    }
  }

  async flush(): Promise<void> {}
}

/** 内存插件配置存储实现，供插件/宿主测试共享。 */
export class MemoryConfigStore implements PluginConfigStore {
  readonly store = new Map<string, Record<string, unknown>>()

  get(pluginId: string): Record<string, unknown> {
    return { ...this.store.get(pluginId) }
  }

  set(pluginId: string, value: Record<string, unknown>): void {
    this.store.set(pluginId, { ...value })
  }
}

/** 构造已挂载 fauxProvider 的 Models 实例及其控制句柄。 */
export function makeFauxModels(options?: Parameters<typeof fauxProvider>[0]): {
  models: ReturnType<typeof createModels>
  faux: ReturnType<typeof fauxProvider>
} {
  const models = createModels()
  const faux = fauxProvider(options)
  models.setProvider(faux.provider)
  return { models, faux }
}

export {
  assert,
  assertRejectsCode,
  cleanupDir,
  deferred,
  makeConversationSummary,
  makePluginSummary,
  makeProfile,
  sleep,
  useTempDir,
  type CleanupRegistrar,
  type Deferred,
  type WaitForOptions,
}
