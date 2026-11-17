/**
 * Shared Hub integration test environment and fixture helpers, reusing `@helm/test-kit` primitives.
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

/** Creates and returns an official faux provider handle (`KernelRuntimeOptions.providers`). */
export function makeFauxProvider(options?: FauxProviderOptions): FauxProviderHandle {
  return fauxProvider(options)
}

/** Creates a `Models` registry populated with an official faux provider. */
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

export interface CreateHubTestAppOptions extends HelmOptions {
  fauxOptions?: FauxProviderOptions
}

/** Launches a real `createHelm` instance mounted with a faux provider (defaults to `providers`; explicit `models` opts into external ownership). */
export async function createHubTestApp(options: CreateHubTestAppOptions = {}): Promise<{
  app: HubTestApp
  kernel: HubTestApp['kernel']
  faux: FauxProviderHandle
  models?: ModelsRegistry
}> {
  const { fauxOptions, models: providedModels, providers: providedProviders, buildProvider, model, ...rest } = options
  const faux = makeFauxProvider(fauxOptions)
  const app = await createHelm({
    buildProvider: buildProvider ?? createPluginBuildProvider(),
    model: model ?? 'faux/faux-1',
    ...(providedModels !== undefined
      ? { models: providedModels }
      : { providers: providedProviders ?? [faux.provider] }),
    ...(providedModels !== undefined && providedProviders !== undefined ? { providers: providedProviders } : {}),
    ...rest,
  })
  return {
    app,
    kernel: app.kernel,
    faux,
    ...(providedModels !== undefined ? { models: providedModels as ModelsRegistry } : {}),
  }
}

export interface HubTestEnv {
  dataDir: string
  app: HubTestApp
  kernel: HubTestApp['kernel']
  faux: FauxProviderHandle
  models?: ModelsRegistry
  close: () => Promise<void>
}

export interface OpenHubTestEnvOptions extends CreateHubTestAppOptions {
  /** Temporary directory prefix (only used when `dataDir` is omitted). */
  prefix?: string
  /** Whether to ignore errors from `app.close()` (only for tests explicitly exercising teardown defects). */
  swallowCloseError?: boolean
}

/**
 * Creates a real `createHelm` environment with a temporary `dataDir` (when omitted).
 * `close()` recursively removes `dataDir` only if this helper created it.
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
      ...(models !== undefined ? { models } : {}),
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

/** In-memory plugin document store fixture (for SQLite-free `PluginHost` governance unit tests). */
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

/** In-memory plugin config store fixture (supports `null` deletion semantics matching `HelmPluginConfigStore`). */
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
