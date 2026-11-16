/**
 * Hub integration test shared use environment and fixture auxiliary, re- use `@helm/test-kit` original language.
 */
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createPluginBuildProvider } from '@helm/plugin-build'
import {
  makeConversationSummary,
  sleep,
  waitFor,
} from '@helm/test-kit'
import { createGitTemplate, type GitTemplate } from '@helm/test-kit/git'
import { cleanupDir, makeTempDir, useTempDir } from '@helm/test-kit/node'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginConfigStore, PluginDocStore } from '../../../kernel/src/plugins/index.js'
import { createHelm, type HelmOptions } from '../../src/app.js'

export {
  cleanupDir,
  createGitTemplate,
  makeConversationSummary,
  makeTempDir,
  sleep,
  useTempDir,
  waitFor,
}
export type { GitTemplate }

export type FauxProviderOptions = Parameters<typeof fauxProvider>[0]
export type FauxProviderHandle = ReturnType<typeof fauxProvider>
export type ModelsRegistry = ReturnType<typeof createModels>

/** create and register official faux provider  Models instance. */
export function makeFauxModels(options?: FauxProviderOptions): {
  models: ModelsRegistry
  faux: FauxProviderHandle
} {
  const faux = fauxProvider(options)
  const models = createModels()
  models.setProvider(faux.provider)
  return { models, faux }
}

export type HubTestApp = Awaited<ReturnType<typeof createHelm>>

export interface CreateHubTestAppOptions extends Omit<HelmOptions, 'models'> {
  models?: HelmOptions['models']
  fauxOptions?: FauxProviderOptions
}

/** start mount faux provider real `createHelm` instance. */
export async function createHubTestApp(options: CreateHubTestAppOptions = {}): Promise<{
  app: HubTestApp
  kernel: HubTestApp['kernel']
  faux: FauxProviderHandle
  models: ModelsRegistry
}> {
  const { fauxOptions, models: providedModels, buildProvider, model, ...rest } = options
  const { models, faux } = makeFauxModels(fauxOptions)
  const app = await createHelm({
    buildProvider: buildProvider ?? createPluginBuildProvider(),
    model: model ?? 'faux/faux-1',
    models: providedModels ?? models,
    ...rest,
  })
  return { app, kernel: app.kernel, faux, models }
}

export interface HubTestEnv {
  dataDir: string
  app: HubTestApp
  kernel: HubTestApp['kernel']
  faux: FauxProviderHandle
  models: ModelsRegistry
  close: () => Promise<void>
}

export interface OpenHubTestEnvOptions extends CreateHubTestAppOptions {
  /** temp directory prefix (only in not pass dataDir when takes effect). */
  prefix?: string
  /** is otherwise ignore app.close() exception (few count test in already has known base seat close defect trace when explicit open start). */
  swallowCloseError?: boolean
}

/**
 * create carries temporary `dataDir`(if not explicit provide) real `createHelm` environment.
 * only when directory by this function self create when,`close` only then will recursion clean up the directory.
 */
export async function openHubTestEnv(options: OpenHubTestEnvOptions = {}): Promise<HubTestEnv> {
  const {
    prefix = 'helm-hub-test-',
    dataDir: givenDataDir,
    cwd,
    swallowCloseError = false,
    ...appOpts
  } = options
  const ownsDir = givenDataDir === undefined
  const dataDir = givenDataDir ?? mkdtempSync(join(tmpdir(), prefix))
  try {
    const { app, kernel, faux, models } = await createHubTestApp({
      dataDir,
      cwd: cwd ?? dataDir,
      ...appOpts,
    })
    return {
      dataDir,
      app,
      kernel,
      faux,
      models,
      async close() {
        try {
          if (swallowCloseError) {
            await app.close().catch(() => {})
          } else {
            await app.close()
          }
        } finally {
          if (ownsDir) rmSync(dataDir, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    if (ownsDir) rmSync(dataDir, { recursive: true, force: true })
    throw error
  }
}

/** memory plugin document store fixture (supply without SQLite  PluginHost governance single test use). */
export class MemoryDocStore implements PluginDocStore {
  store = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial
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

/** memory plugin config store fixture (support null delete semantics, and `HelmPluginConfigStore` consistent). */
export class MemoryConfigStore implements PluginConfigStore {
  store = new Map<string, Record<string, unknown>>()
  get(pluginId: string): Record<string, unknown> {
    return { ...(this.store.get(pluginId) ?? {}) }
  }
  set(pluginId: string, value: Record<string, unknown>): void {
    const current = this.store.get(pluginId) ?? {}
    const next = { ...current }
    for (const [key, v] of Object.entries(value)) {
      if (v === null) delete next[key]
      else next[key] = v
    }
    if (Object.keys(next).length === 0) this.store.delete(pluginId)
    else this.store.set(pluginId, next)
  }
}
