/**
 * PluginHostBackend standard stub (each business fixture combine sharing).
 *
 * based on `createPluginHostBackendFixture()` derive, only for pure mechanism/without business semantics member
 * provide security empty by default implement; the rest business side member inherit baseline explicit 501 reject (by test plugin mistakenly invoke
 * when test immediately RED, never with succeeded empty response cover wrong).
 *
 * use method:hostBackendStub() directly do baseline;completeBackend(partial) business
 * member together into into (Object.assign, business member explicit override stub member).
 */
import type { PluginHostBackend } from '../../src/plugins/index.js'
import { createPluginHostBackendFixture } from './plugin-host-backend.js'

/** return carries security empty by default implement (pure mechanism port) PluginHostBackend standard stub. */
export function hostBackendStub(): PluginHostBackend {
  const base = createPluginHostBackendFixture()
  return {
    ...base,
    profiles: {
      ...base.profiles,
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
    },
    skills: {
      ...base.skills,
      list: () => Promise.resolve([]),
    },
    secrets: {
      ...base.secrets,
      get: () => Promise.resolve(undefined),
      addRedaction: () => () => {},
    },
    listConversations: () => [],
    getConversationOwnership: () => 'human',
    listArtifacts: () => Promise.resolve([]),
    withFileLock: <T,>(_path: string, fn: () => Promise<T>) => fn(),
    withFileMutationQueue: <T,>(_t: unknown, fn: () => Promise<T>) => fn(),
    buildSpawnEnv: () => ({}),
    listActiveSpawnExecutions: () => [],
    onEvent: () => () => {},
    emitEvent: () => {},
    cancelAsk: () => Promise.resolve(),
    registerAskSeqResolver: () => () => {},
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
  }
}

/** business backend(class instance/part literal)+ stub member together into complete PluginHostBackend. */
export function completeBackend<T extends object>(partial: T): T & PluginHostBackend {
  return Object.assign(hostBackendStub(), partial) as T & PluginHostBackend
}
