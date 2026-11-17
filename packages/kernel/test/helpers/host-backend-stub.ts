/**
 * Standard PluginHostBackend stub (shared across domain test fixtures).
 *
 * Derived from `createPluginHostBackendFixture()`, supplying safe empty defaults only for pure
 * mechanism / non-business members while keeping baseline 501 rejections on domain members so
 * unintended plugin calls fail RED immediately instead of passing on fake empty responses.
 *
 * Usage: `hostBackendStub()` provides the baseline; `completeBackend(partial)` merges domain
 * overrides (`Object.assign`, so domain members explicitly override stub defaults).
 */
import type { PluginHostBackend } from '../../src/plugins/index.js'
import { createPluginHostBackendFixture } from './plugin-host-backend.js'

/** Returns the standard PluginHostBackend stub with safe empty defaults for mechanism-only ports. */
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

/** Merges a domain backend (class instance or object literal) with stub defaults into a complete PluginHostBackend. */
export function completeBackend<T extends object>(partial: T): T & PluginHostBackend {
  return Object.assign(hostBackendStub(), partial) as T & PluginHostBackend
}
