/**
 * RuntimeHostBackend：PluginHost 宿主适配器构造工厂（从 KernelRuntime 拆出）。
 *
 * 职责：
 * - 将 KernelRuntime 提供的各项能力（profiles, skills, secrets, nodeIpc, conversations, asks, actions 等）
 *   封装为 PluginHost 所需的强类型 PluginHostBackend 接口对象；
 * - 构造 PluginSessionDocStore 会话分片持久层；
 * - 统一边界错误规范化（如 normalizeProfileBoundaryError，FileNotFoundError -> 404 not_found）。
 */

import { HelmError } from '@helm/protocol'
import type { HelmHostOpenTunnelPort } from '@helm/protocol'
import {
  FileNotFoundError,
  assertProfileId,
  atomicWriteFile,
  withFileLock,
} from '../services/index.js'
import type { PluginHostBackend, PluginSessionDocStore } from '../plugins/index.js'
import type { HelmStore } from './store.js'
import type { KernelRuntime } from './runtime.js'

/** profiles.get/directory 边界归一：非法 id -> 400 validation_error；其余错误原样上抛。 */
export function normalizeProfileBoundaryError(id: string, err: unknown): unknown {
  try {
    assertProfileId(id)
    return err
  } catch {
    return new HelmError('validation_error', `Profile id 非法：${String(id)}`, 400, { profileId: id })
  }
}

/**
 * 启用/停用后取插件清单：真实生命周期已在 PluginHost 完成，这里只做事实回读；
 * 操作成功但清单缺失属于宿主状态不一致，如实报错不虚构。
 */
function requirePluginSummary(runtime: KernelRuntime, pluginId: string) {
  const summary = runtime.plugins.list().find((p) => p.id === pluginId)
  if (!summary) {
    throw new HelmError(
      'plugin_enable_failed',
      `插件 ${pluginId} 生命周期操作后未在宿主清单中发现该插件（内部状态不一致）`,
      500,
      { pluginId },
    )
  }
  return summary
}

/**
 * 构造 PluginHost 所需的宿主后端接口（PluginHostBackend）。
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
            throw new HelmError('not_found', `Profile '${id}' 的 SYSTEM.md 不存在`, 404, { profileId: id })
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
      call: (nodeId, input, signal) => runtime.envFabric.ipcCall(nodeId, input, signal),
      subscribe: (nodeId, input, onLine, onClosed, signal) =>
        runtime.envFabric.ipcSubscribe(nodeId, input, onLine, onClosed, signal),
    },
    nodeFetch: (nodeId) => runtime.envFabric.nodeFetch(nodeId),
    openTunnel: ((nodeId: string, target: { host?: string; port: number }, signal?: AbortSignal) =>
      runtime.envFabric.openTunnel(nodeId, target, signal)) as HelmHostOpenTunnelPort,
    // 宿主插件治理端口：直接委托 PluginHost 既有公共方法（与 HTTP 管理面同链：
    // per-plugin 生命周期队列、在途任务跟踪、locked/在途保护全部复用，
    // 不引入第二套包管理器）。enable/disable 后返回最新清单。
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
    listConversations: (filter) => runtime.listConversations(filter),
    getConversation: (id) => runtime.getConversation(id),
    getConversationDetail: (id, options) => runtime.getConversationDetail(id, options),
    updateConversation: (id, patch) => runtime.updateConversation(id, patch),
    abortConversation: (id) => runtime.abortConversation(id),
    getConversationOwnership: (id) => runtime.getConversationOwnership(id),
    getConversationActivity: (id) => runtime.getConversationActivity(id),
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
    buildSpawnEnv: (conversationId, cwd, nodeId) => runtime.buildSpawnEnv(conversationId, cwd, nodeId),
    spawnAgent: (request) => runtime.spawnAgent(request),
    runGate: (command, options) => runtime.runGate(command, options),
    prepareInterruptedConversations: (ids) => runtime.prepareInterruptedConversations(ids),
    resolveSpawnTarget: (input) => runtime.resolveSpawnTarget(input),
    listActiveSpawnExecutions: () => runtime.listActiveSpawnExecutions(),
    probeNodeFs: (input) => runtime.probeNodeFs(input),
    redactText: (text) => runtime.stash.redact(text),
    invokeAction: (pluginId, actionId, input, context) => runtime.plugins.invokeAction(pluginId, actionId, input, context),
    prepareAction: (pluginId, actionId, input, context) =>
      runtime.plugins.prepareAction(pluginId, actionId, input, context),
    listActions: () => runtime.plugins.listActions(),
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
 * 构造全局持久文档存储端口（PluginHost docs 与内核元数据共用）。
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
 * 构造 PluginHost 所需的会话分片持久层（PluginSessionDocStore）。
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
