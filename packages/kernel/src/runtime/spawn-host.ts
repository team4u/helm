/**
 * 原生 spawn 宿主端口（SpawnHost）。
 *
 * 从 runtime.ts 拆出：spawnAgentObserved 此前向 runNativeSpawn 传 60+ 行
 * 内联对象字面量（十几个闭包回调），坏味道审查要求提炼为显式命名接口。
 * SpawnHost = NativeSpawnDeps 的宿主侧实现契约；类型上直接继承
 * NativeSpawnDeps（单一事实来源），文档在此逐端口说明宿主语义。
 */
import type { Harness } from '@earendil-works/pi-durable'
import type { Models } from '@earendil-works/pi-ai'
import type { AgentSpawnRequest, ConversationAttachmentRef, ConversationPatch, ConversationSummary } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { Profile } from '../services/index.js'
import { requireModelRef } from './models.js'
import type { HelmToolDeps } from './tool-deps.js'
import type { NativeSpawnDeps, ResolvedProfile } from './spawn.js'

/**
 * 宿主注入 runNativeSpawn 的完整依赖集（镜像登记、Profile 解析、会话配置
 * 更新、扩展安装、附件块构造与节点可用性校验）。
 *
 * 各端口的 Why 注释见 spawn.ts 的 NativeSpawnDeps 声明（单一事实来源）；
 * 本接口只是给它一个可在 runtime.ts 与测试中按名引用的显式名字。
 */
export type SpawnHost = NativeSpawnDeps

/** 已授权附件（存在性 + 父链归属校验完成；prompt 拼装用）。 */
export interface ResolvedAttachmentRef {
  ref: ConversationAttachmentRef
  absPath: string
}

/** 构造 SpawnHost 的宿主能力面（KernelRuntime 实现注入）。 */
export interface SpawnHostSource {
  readonly toolDeps: HelmToolDeps
  readonly harness: Harness
  readonly tracker: {
    getLastAssistantText(conversationId: number): string | undefined
  }
  readonly defaultModel: string | undefined
  readonly defaultThinkingLevel: string | undefined
  /** 当前 Models 集合（思考档位能力收敛用；缺省不收敛）。 */
  readonly models?: () => Models
  /** 模型禁用预检（ModelRegistry.assertModelEnabled；创建子会话前拒绝禁用模型）。 */
  assertModelEnabled?(provider: string, modelId: string): void
  readonly agentSessions: Map<string, number>
  readonly resolvedAttachments: ResolvedAttachmentRef[] | undefined
  isNodeOnline(nodeId: string): boolean
  /** [Attached Files] 清单块（无正文前缀；spawn 任务提示词用）。 */
  buildAttachmentBlock(resolved: ResolvedAttachmentRef[]): string
  /** 读真实 Profile（不存在返回 undefined；损坏由宿主显式报错）。 */
  readProfileForSpawn(profileId: string): Promise<Profile | undefined>
  /** 会话镜像读取（不存在返回 undefined）。 */
  getConvMeta(childId: number): { modelOverride?: string; parentConversationId?: number } | undefined
  /** tracker 权威摘要（不存在返回 undefined）。 */
  getConversationSummary(childId: number): ConversationSummary | undefined
  /** 复用宿主 updateConversation（SDK configure + 镜像 + 继承链）。 */
  updateConversation(childId: number, patch: ConversationPatch): Promise<ConversationSummary>
  /** per-child SDK 扩展安装（同名重装为原地替换）。 */
  installExtension(extension: NativeSpawnDeps['installChildExtension'] extends (e: infer E) => void ? E : never): void
  /**
   * 子会话登记（镜像 upsert + helm 归属 + observe + 创建即广播）。
   * parentToolCallId 由 buildSpawnHost 从最终请求透传（显式参数，避免
   * 闭包里隐式捕获 transform 后的请求）。
   */
  registerChildConversation(
    childId: number,
    parentId: number,
    profileId: string,
    childCwd: string,
    modelMirror: string,
    tags: string[],
    thinkingLevel: string | undefined,
    nodeId: string | undefined,
    parentToolCallId: string | undefined,
    /** 收敛后的显式思考档位覆盖（request.effort 未提供时 undefined）。 */
    thinkingLevelOverride: string | undefined,
  ): Promise<void>
  /** resume 续接时更新子会话 parentToolCallId（镜像 + 广播）。 */
  bindChildToolCall(childId: number, parentToolCallId: string): void
  /**
   * 守卫式中止子会话（signal 桥/启动期取消的红线入口）：实现现读归属事实
   * 并经内核 abortConversationGuarded 原子复核（human-owned 一律拒绝）。
   * 缺省不接线时 spawn 回退 SDK conversation.abort（原始取消能力）。
   */
  abortChildConversationGuarded?(childId: number): Promise<void>
}

export interface SpawnHostOptions {
  readonly source: SpawnHostSource
  /** agent_spawn transform 后的最终请求。 */
  readonly finalRequest: AgentSpawnRequest
}

/** Profile -> ResolvedProfile 字段裁剪（只保留 spawn 关心的键）。 */
export function toResolvedProfile(profile: Profile): ResolvedProfile {
  return {
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.thinkingLevel ? { thinkingLevel: profile.thinkingLevel } : {}),
    ...(profile.cwd !== undefined ? { cwd: profile.cwd } : {}),
    ...(profile.nodeId !== undefined ? { nodeId: profile.nodeId } : {}),
    ...(profile.runtime !== undefined ? { runtime: profile.runtime } : {}),
  }
}

/** 由宿主能力面构造 runNativeSpawn 依赖集（原 60+ 行内联字面量的显式替代）。 */
export function buildSpawnHost(options: SpawnHostOptions): SpawnHost {
  const { source, finalRequest } = options
  return {
    ...source.toolDeps,
    harness: source.harness,
    getLastAssistantText: (id) => source.tracker.getLastAssistantText(id),
    resolveModel: () => requireModelRef(source.defaultModel),
    ...(source.assertModelEnabled !== undefined
      ? { assertModelEnabled: (provider: string, modelId: string) => source.assertModelEnabled!(provider, modelId) }
      : {}),
    resolveThinkingLevel: () => source.defaultThinkingLevel,
    ...(source.models !== undefined
      ? { modelsForClamp: source.models }
      : {}),
    agentSessions: source.agentSessions,
    assertNodeAvailable: (nodeId) => {
      if (!source.isNodeOnline(nodeId)) {
        throw new HelmError('node_offline', `目标节点 ${nodeId} 离线，不能启动子代理`, 409, { nodeId })
      }
    },
    resolveAttachmentsForPrompt:
      source.resolvedAttachments !== undefined
        ? async () => source.buildAttachmentBlock(source.resolvedAttachments!)
        : undefined,
    registerChildConversation: (childId, parentId, profileId, childCwd, modelMirror, tags, thinkingLevel, nodeId, thinkingLevelOverride) =>
      source.registerChildConversation(
        childId, parentId, profileId, childCwd, modelMirror, tags, thinkingLevel, nodeId,
        finalRequest.parentToolCallId, thinkingLevelOverride,
      ),
    bindChildToolCall: (childId, parentToolCallId) => source.bindChildToolCall(childId, parentToolCallId),
    ...(source.abortChildConversationGuarded !== undefined
      ? { abortChildConversationGuarded: (childId: number) => source.abortChildConversationGuarded!(childId) }
      : {}),
    resolveProfile: async (profileId) => {
      const profile = await source.readProfileForSpawn(profileId)
      if (!profile) return undefined
      return toResolvedProfile(profile)
    },
    getModelOverride: (childId) => source.getConvMeta(childId)?.modelOverride,
    getParentOfConversation: (childId) => source.getConvMeta(childId)?.parentConversationId,
    // resume 配置基线端口：镜像读取与真实更新（SDK configure + 持久化 +
    // 模型继承链，复用宿主 updateConversation，不重建身份字段）。
    getConversation: (childId) => source.getConversationSummary(childId),
    updateConversation: (childId, patch) => source.updateConversation(childId, patch),
    installChildExtension: (extension) => source.installExtension(extension),
  }
}
