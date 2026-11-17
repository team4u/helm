/**
 * RuntimeHostBackend: host adapter factory for `PluginHost` (extracted from `KernelRuntime`).
 *
 * Responsibilities:
 * - Wrap `KernelRuntime` capabilities (`profiles`, `skills`, `secrets`, `nodeIpc`, `conversations`,
 *   `asks`, `actions`, etc.) into the strongly-typed `PluginHostBackend` interface required by `PluginHost`;
 * - Construct the `PluginSessionDocStore` per-conversation durable persistence layer;
 * - Normalize boundary errors consistently (e.g., `normalizeProfileBoundaryError`, `FileNotFoundError -> 404 not_found`).
 */

import { HelmError, isValidProfileId } from '@helm/protocol'
import type { HelmHostOpenTunnelPort } from '@helm/protocol'
import { FileNotFoundError, atomicWriteFile, withFileLock } from '../services/index.js'
import type { PluginHostBackend, PluginSessionDocStore } from '../plugins/index.js'
import type { HelmStore } from './store.js'
import type { KernelRuntime } from './runtime.js'

/** Boundary normalization for `profiles.get/directory`: invalid id -> `400 validation_error`; rethrows all other errors as-is. */
function normalizeProfileBoundaryError(id: string, err: unknown): unknown {
  if (isValidProfileId(id)) return err
  return new HelmError('validation_error', `Invalid Profile ID: ${String(id)}`, 400, { profileId: id })
}

/**
 * Look up the plugin manifest after enable/disable: the real lifecycle step already completed inside `PluginHost`,
 * so this only reads back the result; a missing manifest indicates inconsistent host state and fails loudly without fabricating one.
 */
function requirePluginSummary(runtime: KernelRuntime, pluginId: string) {
  const summary = runtime.plugins.list().find((p) => p.id === pluginId)
  if (!summary) {
    throw new HelmError(
      'plugin_enable_failed',
      `Plugin '${pluginId}' not found in host manifest after lifecycle operation (inconsistent internal state)`,
      500,
      { pluginId },
    )
  }
  return summary
}

/**
 * Construct the host backend interface required by `PluginHost` (`PluginHostBackend`).
 */
export function createPluginHostBackend(runtime: KernelRuntime): PluginHostBackend {
  return {
    isClosing: () => runtime.isClosing,
    profiles: {
      list: () => runtime.profiles.list(),
      get: (id) =>
        runtime.profiles.get(id).catch((err: unknown) => {
          throw normalizeProfileBoundaryError(id, err)
        }),
      getSystem: async (id) => {
        try {
          return await runtime.profiles.getSystem(id)
        } catch (err) {
          if (err instanceof FileNotFoundError) {
            throw new HelmError('not_found', `SYSTEM.md not found for Profile '${id}'`, 404, { profileId: id })
          }
          throw err
        }
      },
      save: (profile) => runtime.profiles.save(profile),
      directory: (id) => runtime.profileDirectory(id),
    },
    skills: {
      list: () => runtime.skills.list(),
      readFile: (skillId, path) => runtime.skills.readFile(skillId, path),
      directory: (id) => runtime.skillDirectory(id),
      ensureSkill: (asset, pluginId) => runtime.ensurePluginSkill(asset, pluginId),
    },
    secrets: {
      get: (pluginId, key) => runtime.credentials.getPluginSecret(pluginId, key),
      set: (pluginId, key, value) => runtime.credentials.setPluginSecret(pluginId, key, value),
      delete: (pluginId, key) => runtime.credentials.deletePluginSecret(pluginId, key),
      addRedaction: (value) => runtime.stash.addRedaction(value),
    },
    setPluginConfig: (pluginId, value) =>
      runtime.pluginConfigStore.set(pluginId, value, runtime.plugins.getConfigSchema(pluginId) ?? {}),
    nodeIpc: {
      isOnline: (nodeId) => runtime.envFabric.isOnline(nodeId),
      getNodeHubUrl: (nodeId) => runtime.envFabric.getNodeHubUrl(nodeId),
      // Authoritative node platform (reported on NodeRegistry registration; local -> process.platform):
      // used by plugins to normalize cwd per target node platform (undefined when remote is unregistered/unreported;
      // consumers must neither guess nor rewrite). Routed through the sole EnvFabric.nodePlatformOf read-only port
      // rather than duplicating platform lookup logic here.
      nodePlatform: (nodeId) => runtime.envFabric.nodePlatformOf(nodeId),
      call: (nodeId, input, signal) => runtime.envFabric.ipcCall(nodeId, input, signal),
      subscribe: (nodeId, input, onLine, onClosed, signal) =>
        runtime.envFabric.ipcSubscribe(nodeId, input, onLine, onClosed, signal),
    },
    nodeFetch: (nodeId) => runtime.envFabric.nodeFetch(nodeId),
    openTunnel: ((nodeId: string, target: { host?: string; port: number }, signal?: AbortSignal) =>
      runtime.envFabric.openTunnel(nodeId, target, signal)) as HelmHostOpenTunnelPort,
    // Host plugin governance ports: delegate directly to PluginHost's public methods (sharing the same chain
    // as HTTP management: per-plugin lifecycle queue, active-task tracking, locked/in-use protection, avoiding a
    // second package management implementation). Returns the latest manifest after enable/disable.
    plugins: {
      doctorPlugin: (target) => runtime.plugins.doctorExternalPlugin(target),
      installPlugin: (source, options) => runtime.plugins.installPluginPackage(source, options),
      updatePlugin: (pluginId) => runtime.plugins.updatePluginPackage(pluginId),
      removePlugin: (pluginId) => runtime.plugins.removePluginPackage(pluginId),
      enablePlugin: async (pluginId) => {
        await runtime.plugins.enable(pluginId)
        return requirePluginSummary(runtime, pluginId)
      },
      disablePlugin: async (pluginId, options) => {
        await runtime.plugins.disable(pluginId, options)
        return requirePluginSummary(runtime, pluginId)
      },
    },
    dispatchTrigger: (event) => runtime.dispatchTrigger(event),
    submitInput: async (id, text, opts) => {
      await runtime.submitInput(id, text, opts)
    },
    createConversation: (init) => runtime.createConversation(init),
    forkConversation: (id, opts) => runtime.forkConversation(id, opts),
    listConversations: (filter) => runtime.listConversations(filter),
    getConversation: (id) => runtime.getConversation(id),
    getConversationDetail: (id, options) => runtime.getConversationDetail(id, options),
    updateConversation: (id, patch) => runtime.updateConversation(id, patch),
    abortConversation: (id) => runtime.abortConversation(id),
    abortConversationGuarded: (id, guard) => runtime.abortConversationGuarded(id, guard),
    submitInputGuarded: async (id, text, opts, guard) => {
      await runtime.submitInputGuarded(id, text, opts, guard)
    },
    getConversationOwnership: (id) => runtime.getConversationOwnership(id),
    listArtifacts: (conversationId) => Promise.resolve(runtime.artifacts.list(conversationId)),
    getArtifact: (artifactId, conversationId) => runtime.resolveAuthorizedAttachment(conversationId, artifactId),
    redact: (text) => runtime.stash.redact(text),
    refreshModels: (options) => runtime.refreshModels(options),
    withFileLock: <T>(path: string, fn: () => Promise<T>, opts?: { signal?: AbortSignal }) =>
      withFileLock(path, async () => {
        opts?.signal?.throwIfAborted()
        return fn()
      }),
    atomicWriteFile: (path, content) => atomicWriteFile(path, content),
    completeText: (input) => runtime.completeConversationText(input),
    executionEnv: (nodeId, cwd) => runtime.envFabric.envFor(nodeId, cwd),
    buildSpawnEnv: (conversationId, cwd, nodeId, options) =>
      runtime.agentSpawn.buildSpawnEnv(conversationId, cwd, nodeId, options),
    spawnAgent: (request) => runtime.agentSpawn.spawnAgent(request),
    runGate: (command, options) => runtime.agentSpawn.runGate(command, options),
    resolveSpawnTarget: (input) => runtime.agentSpawn.resolveSpawnTarget(input),
    listActiveSpawnExecutions: () => runtime.agentSpawn.listActiveSpawnExecutions(),
    inspectNodePathUsage: (input) => runtime.agentSpawn.inspectNodePathUsage(input),
    manageConversation: (id, pluginId) => runtime.manageConversation(id, pluginId),
    markConversationOwnership: (id, owner) => runtime.markConversationOwnership(id, owner),
    createAsk: (spec) => runtime.createAsk(spec),
    cancelAsk: (askId, reason) => runtime.cancelAsk(askId, reason),
    registerAskSeqResolver: (resolver) => runtime.registerAskSeqResolver(resolver),
    execEnv: async (req, opts) => {
      const res = await runtime.execEnv(req, undefined, opts?.signal)
      return {
        ...res,
        output: runtime.stash.redact(res.output),
      }
    },
    withFileMutationQueue: (target, fn, opts) =>
      runtime.envFabric.withFileMutationQueue(target, fn, opts?.signal),
    onEvent: (type, listener) => runtime.onEvent(type, listener),
    emitEvent: (type, payload, options) => runtime.emitHostEvent(type, payload, options),
  }
}

/**
 * Construct the global durable document store port (shared by `PluginHost` docs and kernel metadata).
 */
export function createGlobalDocumentStore(store: HelmStore): {
  get<T>(key: string, initial: T): T
  set<T>(key: string, value: T): void
  deletePlugin(pluginId: string): void
  flush(): Promise<void>
} {
  return {
    get: <T>(key: string, initial: T): T => {
      const raw = store.getPluginDoc('__global', key)
      if (raw === undefined) return initial
      return JSON.parse(raw) as T
    },
    set: <T>(key: string, value: T): void => {
      store.putPluginDoc('__global', key, JSON.stringify(value))
    },
    deletePlugin: (pluginId: string): void => {
      store.deleteGlobalPluginDocs(pluginId)
    },
    flush: () => store.flushPublic(),
  }
}

/**
 * Construct the per-conversation durable storage layer required by `PluginHost` (`PluginSessionDocStore`).
 */
export function createPluginSessionDocStore(store: HelmStore): PluginSessionDocStore {
  return {
    get: (pluginId, name, conversationId) =>
      store.getPluginSessionDoc(pluginId, name, conversationId),
    put: (pluginId, name, conversationId, valueJson) =>
      store.putPluginSessionDoc(pluginId, name, conversationId, valueJson),
    delete: (pluginId, name, conversationId) =>
      store.deletePluginSessionDoc(pluginId, name, conversationId),
    deletePlugin: (pluginId) => store.deletePluginSessionDocs(pluginId),
    listConversationIds: (pluginId, name) =>
      store.listPluginSessionDocConversations(pluginId, name),
    flush: () => store.flushPublic(),
  }
}
