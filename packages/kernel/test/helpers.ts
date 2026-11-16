/**
 * helm kernel service test base seat: delegate `@helm/test-kit` provide directory, wait for,DTO and memory store fixture.
 * keep in-memory module (without `node:fs` / `node:child_process` directly import), ensure pure test can shard run.
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

/** each test group independent temporary data directory (real file behavior). */
export async function makeTempDir(prefix = 'helm-services-test-'): Promise<string> {
  return kitMakeTempDir(prefix)
}

/** polling wait for condition into establish (support location parameter `(predicate, timeoutMs, intervalMs)` and option object). */
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

/** memory plugin global document store implement, supply plugin/host test sharing. */
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

/** memory plugin config store implement, supply plugin/host test sharing. */
export class MemoryConfigStore implements PluginConfigStore {
  readonly store = new Map<string, Record<string, unknown>>()

  get(pluginId: string): Record<string, unknown> {
    return { ...this.store.get(pluginId) }
  }

  set(pluginId: string, value: Record<string, unknown>): void {
    this.store.set(pluginId, { ...value })
  }
}

/** construct already mount fauxProvider  Models instance and its control handle. */
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
