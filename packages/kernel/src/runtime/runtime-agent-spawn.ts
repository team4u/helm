/**
 * RuntimeAgentSpawn：子代理派生、验收 Gate 与执行事实维护（从 KernelRuntime 拆出）。
 *
 * 职责：
 * - spawnAgent 运行管道（schema 预编译校验 -> resume 独占检查 -> around 钩子 -> gate 校验 -> schema 验证）；
 * - 原生 subagent 执行环境装配与子会话初始状态广播（0ms 对齐 parentConversationId/parentToolCallId）；
 * - runGate 验收命令在目标节点执行（远端会话远端跑）；
 * - buildSpawnEnv 受管子进程环境构造；
 * - resolveSpawnTarget 通用 spawn 靶点解析（spawn-target.ts 同一权威链）；
 * - 维护 activeSpawnExecutions 活跃执行态与 agentSessions 别名映射。
 */

import { randomUUID } from 'node:crypto'
import type {
  AgentExecutionInfo,
  AgentSpawnRequest,
  ConversationPatch,
  ConversationSummary,
} from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { ConversationOwnership } from './runtime-ownership.js'
import type { Harness, Registry } from '@earendil-works/pi-durable'
import type { EnvFabric } from '../env/index.js'
import { assertSchemaCompilable } from '../plugins/schema.js'
import type { ConversationService } from './conversation-service.js'
import type { ConversationTracker } from './conversations.js'
import type { EventHub } from './events.js'
import type { HookBridge } from './hook-bridge.js'
import type { ModelRegistry } from './model-registry.js'
import { buildSpawnHost } from './spawn-host.js'
import { normalizeSessionCwd, trustedPlatformFromEnvFabric } from './target-cwd.js'
import {
  assertSpawnForkFields,
  resolveCleanForkAnchor,
  resolveForkMode,
  resolveInheritedModelOverride,
} from './spawn-fork.js'
import { assertSpawnRequestModes } from './spawn-reattach.js'
import { resolveSpawnTargetChain, resolveSpawnTargetNodeId } from './spawn-target.js'
import {
  agentGateResultMissingError,
  sanitizeAgentExecutionInfo,
  sanitizeAgentGateResult,
  sanitizeAgentNamespacedMeta,
} from '@helm/protocol'
import { isSpawnConversationInTurn, runNativeSpawn } from './spawn.js'
import { validateJsonSchema, type StructuredOutputSession } from './structured-output.js'
import type { HelmStore } from './store.js'
import type { HelmToolDeps } from './tool-deps.js'
import { buildManagedEnv, runGate } from './tools.js'
import { isValidEnvName, type SecretStash } from '../services/index.js'

/**
 * secretNames 边界校验（spawn 请求与 buildSpawnEnv 共用）：字符串数组、每项
 * 非空且为合法环境变量名、无重复；undefined（未授予）合法。非法形状显式拒绝。
 */
export function validateSecretNames(secretNames: string[] | undefined): string[] {
  if (secretNames === undefined) return []
  if (!Array.isArray(secretNames)) {
    throw new HelmError('validation_error', `secretNames 需为字符串数组（收到 ${typeof secretNames}）`, 400)
  }
  const seen = new Set<string>()
  for (const name of secretNames) {
    if (typeof name !== 'string' || name === '' || !isValidEnvName(name)) {
      throw new HelmError(
        'validation_error',
        `secretNames 含非法机密名 '${String(name)}'（需非空合法环境变量名）`,
        400,
        { name },
      )
    }
    if (seen.has(name)) {
      throw new HelmError('validation_error', `secretNames 重复：${name}`, 400, { name })
    }
    seen.add(name)
  }
  return [...secretNames]
}

export interface RuntimeAgentSpawnDeps {
  readonly store: HelmStore
  readonly toolDeps: HelmToolDeps
  readonly harness: Harness
  readonly registry: Registry
  readonly tracker: ConversationTracker
  readonly conversations: ConversationService
  readonly events: EventHub
  readonly envFabric: EnvFabric
  readonly modelsRegistry: ModelRegistry
  readonly hookBridge: HookBridge
  readonly stashService: SecretStash
  updateConversation(id: number, patch: ConversationPatch): Promise<ConversationSummary>
  markConversationOwnership(id: number, owner: ConversationOwnership): void
}

export class RuntimeAgentSpawn {
  /** 当前在途的 spawnAgent 执行事实：token -> AgentExecutionInfo。 */
  readonly activeSpawnExecutions = new Map<string, AgentExecutionInfo>()

  /** 原生 spawn session 映射：sessionId -> childConversationId。 */
  readonly agentSessions = new Map<string, number>()
  /** 本 Harness 共享的结构化输出结果槽（conversationId -> session）：并发 spawn
   * 的同名扩展被 registry 原地替换后，旧扩展闭包仍经此共享 map 按 conversationId
   * 动态命中自己的结果槽（与原模块级 WeakMap<Harness, Map> 同语义，改为显式注入）。 */
  readonly structuredOutputSessions = new Map<number, StructuredOutputSession>()

  constructor(private readonly deps: RuntimeAgentSpawnDeps) {}

  /**
   * 受管子进程 spawn 环境变量构造：
   * 绝不携带宿主 process.env（远端环境由目标机器自理，PATH/HOME 等不得外泄）。
   * 缺省不携带任何父会话 stash 机密（外部窗格最小授权）；仅显式 secretNames
   * 逐名注入：名字需在父会话 stash 内现存（含未过期/未结算），缺失显式 404，
   * 绝不静默降级为空注入。
   */
  buildSpawnEnv(
    conversationId: number,
    cwd: string,
    nodeId?: string,
    options?: { secretNames?: string[] },
  ): Record<string, string> {
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      throw new HelmError(
        'validation_error',
        `buildSpawnEnv 需要正整数 conversationId（收到 ${String(conversationId)}）`,
        400,
        { conversationId },
      )
    }
    if (typeof cwd !== 'string' || cwd === '') {
      throw new HelmError('validation_error', `buildSpawnEnv 需要非空 cwd（收到 ${String(cwd)}）`, 400, {
        cwd,
      })
    }
    const names = validateSecretNames(options?.secretNames)
    // 单次选择读取后基于实际返回键判缺失（同步边界，同次只采样 clock 一次）：
    // 先 has 后 envFor 的两段读会在 TTL 边界跨界——has 过、envFor 省略，返回
    // 假成功空注入。
    const stashEnv = this.deps.stashService.envFor(conversationId, names)
    const missing = names.filter((name) => !Object.hasOwn(stashEnv, name))
    if (missing.length > 0) {
      throw new HelmError(
        'secret_not_found',
        `会话 ${conversationId} 的 stash 内不存在（或已停止注入）机密：${missing.join(', ')}；请确认机密名与生命周期（TTL/回合作用域）`,
        404,
        { conversationId, missing },
      )
    }
    const resolvedNodeId = nodeId ?? this.deps.store.getConv(conversationId)?.nodeId ?? 'local'
    return buildManagedEnv(this.deps.toolDeps, cwd, conversationId, resolvedNodeId, { stashEnv })
  }

  /**
   * 子代理派生：agent_spawn around 管道（continuation）-> 默认原生 subagent。
   * 内核零 Git/worktree 语义：隔离等执行环境要求由插件层经 next(finalReq)
   * 兑现；内核只保留通用保证（meta envelope 校验 / schema 校验 / gate 回报
   * 对账 / 结果验证；命名空间业务值由所有方插件校验）。
   */
  async spawnAgent(request: AgentSpawnRequest): Promise<unknown> {
    if (request.schema !== undefined) assertSchemaCompilable(request.schema)
    validateSecretNames(request.secretNames)
    // envelope 边界（同步段，先于钩子链与一切 await）：meta 必须是 JSON-safe
    // 命名空间对象；业务值不在内核校验（所有方插件边界负责）。
    sanitizeAgentNamespacedMeta(request.meta, {
      agentId: request.agentId ?? 'subagent',
      field: 'spawn request meta',
    })
    assertSpawnRequestModes(request)
    const preResolvedForkAnchor = await this.preflightForkRequest(request)
    const token = randomUUID()
    try {
      if (request.resume !== undefined) {
        const resumeId = /^\d+$/.test(request.resume) ? Number(request.resume) : this.agentSessions.get(request.resume)
        const child = resumeId !== undefined ? this.deps.store.getConv(resumeId) : undefined
        if (resumeId !== undefined && child !== undefined && child.parentConversationId === request.parentConversationId) {
          // 早期互斥拒绝（钩子链前）：共享在途注册表（与 runNativeSpawn 同源；
          // 覆盖直调入口与「子会话已建但 onResolved 未回传」空窗）+ 本映射的
          // 预置坐标（覆盖钩子链窗口内宿主侧并发 resume）。权威占用在原生执行
          // 行同步 claim；本映射仅是执行事实镜像与早期检查面。
          if (
            isSpawnConversationInTurn(this.deps.harness, resumeId) ||
            [...this.activeSpawnExecutions.values()].some((info) => info.conversationId === resumeId)
          ) {
            throw new HelmError('subagent_in_use', `子会话 ${resumeId} 仍有在途执行，不能并发续接`, 409)
          }
          this.activeSpawnExecutions.set(token, { conversationId: resumeId, nodeId: child.nodeId ?? 'local', effectiveCwd: child.cwd })
        }
      } else if (request.reattach !== undefined) {
        const reattachConvId = request.reattach.conversationId
        const reattachExecId = request.reattach.executionId
        if (reattachConvId !== undefined) {
          const child = this.deps.store.getConv(reattachConvId)
          if (child === undefined || child.parentConversationId !== request.parentConversationId) {
            throw new HelmError(
              'not_found',
              `reattach 目标子会话 ${reattachConvId} 不存在或不属于父会话 ${request.parentConversationId}；绝不新建会话假冒重挂`,
              404,
              { conversationId: reattachConvId, parentConversationId: request.parentConversationId },
            )
          }
          if (
            isSpawnConversationInTurn(this.deps.harness, reattachConvId) ||
            [...this.activeSpawnExecutions.values()].some(
              (info) =>
                info.conversationId === reattachConvId ||
                (reattachExecId !== undefined && info.executionId === reattachExecId),
            )
          ) {
            throw new HelmError('subagent_in_use', `子会话 ${reattachConvId} 仍有在途重挂或执行，不能并发重挂`, 409, {
              conversationId: reattachConvId,
            })
          }
          this.activeSpawnExecutions.set(token, {
            conversationId: reattachConvId,
            nodeId: child.nodeId ?? 'local',
            effectiveCwd: request.reattach.effectiveCwd ?? child.cwd,
            ...(reattachExecId !== undefined ? { executionId: reattachExecId } : {}),
          })
        } else if (reattachExecId !== undefined) {
          if ([...this.activeSpawnExecutions.values()].some((info) => info.executionId === reattachExecId)) {
            throw new HelmError('subagent_in_use', `外部执行 ${reattachExecId} 仍有在途重挂或执行，不能并发重挂`, 409, {
              executionId: reattachExecId,
            })
          }
          this.activeSpawnExecutions.set(token, {
            executionId: reattachExecId,
            ...(request.reattach.effectiveCwd !== undefined ? { effectiveCwd: request.reattach.effectiveCwd } : {}),
          })
        }
      }
      const originalResolved = request.onResolved
      let execution: AgentExecutionInfo | undefined
      let gate: ReturnType<typeof sanitizeAgentGateResult> | undefined
      const observed: AgentSpawnRequest = {
        ...request,
        onResolved: (raw) => {
          const info = sanitizeAgentExecutionInfo(raw, { agentId: request.agentId ?? 'subagent' })
          info.nodeId ??= info.conversationId !== undefined ? this.deps.store.getConv(info.conversationId)?.nodeId : undefined
          execution = info
          this.activeSpawnExecutions.set(token, info)
          originalResolved?.(info)
        },
        onGateResult: (raw) => {
          gate = sanitizeAgentGateResult(raw, { agentId: request.agentId ?? 'subagent' })
          request.onGateResult?.(gate)
        },
      }
      const result = await this.spawnAgentObserved(observed, preResolvedForkAnchor)
      if (request.schema !== undefined) {
        // 跨插件边界终校验：原生行内部的自息/工具校验不因接管（handled）或
        // 钩子改写而存在，最终产物必须在此重新过一遍 Schema（不可删）。
        const validation = validateJsonSchema(result, request.schema)
        if (!validation.ok) {
          throw new HelmError('schema_validation_failed', `子代理最终结果未满足 Schema：${validation.errors.join('; ')}`, 502)
        }
      }
      if (request.gate !== undefined && execution?.executionId !== undefined && gate === undefined) {
        throw agentGateResultMissingError({ agentId: request.agentId ?? 'subagent', executionId: execution.executionId, command: request.gate })
      }
      if (gate !== undefined && !gate.ok) {
        throw new HelmError('gate_failed', `子代理验收命令失败：${gate.output}`, 502)
      }
      return result
    } finally {
      this.activeSpawnExecutions.delete(token)
    }
  }

  /** fork 请求前置校验与锚点锁定（入口预检与钩子 transform 终检共用）。 */
  private async preflightForkRequest(request: AgentSpawnRequest): Promise<number | undefined> {
    assertSpawnForkFields(request)
    if (request.fork !== true) return undefined
    if ((request.agentType ?? '').includes(':')) {
      throw new HelmError(
        'unsupported_runtime',
        `fork 仅支持原生 Profile 子会话，不支持外部运行时 '${request.agentType}'`,
        400,
        { agentType: request.agentType },
      )
    }
    const parentMeta = this.deps.store.getConv(request.parentConversationId)
    if (parentMeta === undefined) {
      throw new HelmError(
        'not_found',
        `父会话 ${request.parentConversationId} 不存在，无法执行 fork 派生`,
        404,
        { parentConversationId: request.parentConversationId },
      )
    }
    const { profileId: effectiveProfileId } = resolveForkMode(request.agentType, true, parentMeta.profileId)
    const profile = await this.deps.conversations.readProfile(effectiveProfileId)
    if (profile === undefined) {
      throw new HelmError(
        'not_found',
        `agentType '${effectiveProfileId}' 不是已注册的 Profile（profiles/${effectiveProfileId} 不存在）`,
        404,
        { agentType: effectiveProfileId },
      )
    }
    if (profile.runtime !== undefined) {
      throw new HelmError(
        'unsupported_runtime',
        `Profile '${effectiveProfileId}' 声明外部运行时 runtime.kind='${profile.runtime.kind}'（agent '${profile.runtime.agent}'），fork 仅支持原生 Profile 子会话`,
        400,
        { agentType: effectiveProfileId, runtimeKind: profile.runtime.kind },
      )
    }
    return resolveCleanForkAnchor(this.deps.harness, request.parentConversationId)
  }

  async spawnAgentObserved(request: AgentSpawnRequest, preResolvedForkAnchor?: number): Promise<unknown> {
    // 附件门禁在进入 hook 链之前：agent_spawn 钩子与原生执行行均受统一授权
    // 保护（产物存在 + 父会话链归属）；插件 next 改写后再校验一次。
    if (request.attachments !== undefined && request.attachments.length > 0) {
      await this.deps.conversations.resolveAuthorizedAttachments(request.parentConversationId, request.attachments)
    }
    // around（continuation）管道：插件可包裹完整生命周期（在 next 前分配资源、
    // next 后收敛）；handled 仍可完全接管；无插件时直接默认原生执行。
    return this.deps.hookBridge.runHookAround('agent_spawn', request, async (finalRequest) => {
      // envelope 边界（around 最终请求）：钩子链 transform/continuation 改写
      // 后的 meta 与 fork 关键参数在进入原生执行之前统一复验，防止钩子
      // 翻开 fork / 替换目标或绕过前置校验。
      sanitizeAgentNamespacedMeta(finalRequest.meta, {
        agentId: finalRequest.agentId ?? request.agentId ?? 'subagent',
        field: 'spawn request meta',
      })
      assertSpawnRequestModes(finalRequest)
      const forkChanged =
        request.fork !== true ||
        finalRequest.agentType !== request.agentType ||
        finalRequest.parentConversationId !== request.parentConversationId ||
        finalRequest.resume !== undefined
      let resolvedAnchor =
        !forkChanged && preResolvedForkAnchor !== undefined
          ? preResolvedForkAnchor
          : undefined
      if (finalRequest.fork === true && (forkChanged || preResolvedForkAnchor === undefined)) {
        resolvedAnchor = await this.preflightForkRequest(finalRequest)
      }
      if (
        finalRequest.attachments !== undefined &&
        finalRequest.attachments.length > 0 &&
        finalRequest !== request
      ) {
        await this.deps.conversations.resolveAuthorizedAttachments(finalRequest.parentConversationId, finalRequest.attachments)
      }
      const resolvedAttachments =
        finalRequest.attachments !== undefined && finalRequest.attachments.length > 0
          ? await this.deps.conversations.resolveAuthorizedAttachments(finalRequest.parentConversationId, finalRequest.attachments)
          : undefined

      // 原生执行行诚实边界：原生子会话工具环境按子会话自身 stash 计算，无法
      // 承接父会话机密授予——非空 secretNames 到达此处（无外部运行时钩子接管）
      // 显式拒绝，绝不静默忽略假装子代理已取得机密；空数组等同未授予。
      if (finalRequest.secretNames !== undefined && finalRequest.secretNames.length > 0) {
        throw new HelmError(
          'unsupported_secret_grant',
          `原生执行行不支持 secretNames 机密授予（${finalRequest.secretNames.join(', ')}）：原生子会话不继承父会话 stash；机密注入仅外部运行时（如 builtin:herdr 窗格）支持，请改用外部运行时 agentType 或去掉授予`,
          400,
          { secretNames: [...finalRequest.secretNames] },
        )
      }

      return runNativeSpawn(
        buildSpawnHost({
          finalRequest,
          source: {
            toolDeps: this.deps.toolDeps,
            harness: this.deps.harness,
            tracker: { getLastAssistantText: (id) => this.deps.tracker.getLastAssistantText(id) },
            defaultModel: this.deps.modelsRegistry.defaultModel,
            defaultThinkingLevel: this.deps.modelsRegistry.defaultThinkingLevel,
            models: () => this.deps.modelsRegistry.models,
            assertModelEnabled: (provider, modelId) => this.deps.modelsRegistry.assertModelEnabled(provider, modelId),
            agentSessions: this.agentSessions,
            structuredOutputSessions: this.structuredOutputSessions,
            resolvedAttachments,
            isNodeOnline: (nodeId) => this.deps.envFabric.isOnline(nodeId),
            buildAttachmentBlock: (resolved) => this.deps.conversations.buildAttachmentBlock(resolved),
            readProfileForSpawn: (profileId) => this.deps.conversations.readProfile(profileId),
            getConvMeta: (childId) => this.deps.store.getConv(childId),
            getConversationSummary: (childId) => {
              const meta = this.deps.store.getConv(childId)
              return meta ? this.deps.tracker.summaryOf(childId) : undefined
            },
            updateConversation: (childId, patch) => this.deps.updateConversation(childId, patch),
            installExtension: (extension) => {
              this.deps.registry.install(extension as never)
            },
            registerChildConversation: async (childId, parentId, profileId, childCwd, modelMirror, tags, thinkingLevel, nodeId, parentToolCallId, thinkingLevelOverride) => {
              const profile = await this.deps.conversations.readProfile(profileId)
              const parentMeta = this.deps.store.getConv(parentId)
              const { forkSameProfile } = resolveForkMode(profileId, finalRequest.fork, parentMeta?.profileId)
              const inheritedModelOverride = resolveInheritedModelOverride(
                finalRequest.model,
                forkSameProfile,
                parentMeta?.modelOverride,
              )
              const now = Date.now()
              this.deps.store.upsertConv({
                id: childId,
                title: `子代理 ${childId}`,
                profileId,
                tags,
                parentConversationId: parentId,
                ...(parentToolCallId !== undefined && parentToolCallId !== '' ? { parentToolCallId } : {}),
                nodeId: nodeId ?? resolveSpawnTargetNodeId(profile?.nodeId, parentMeta?.nodeId, forkSameProfile),
                cwd: childCwd,
                model: modelMirror,
                thinkingLevel: thinkingLevel ?? '',
                // 收敛后的显式覆盖（原生执行行已按目标模型能力 clamp，或同角色 fork 继承）；
                // 未显式指定时保持继承链语义（不存 override）。
                ...(thinkingLevelOverride !== undefined ? { thinkingLevelOverride } : {}),
                ...(inheritedModelOverride !== undefined && inheritedModelOverride !== ''
                  ? { modelOverride: inheritedModelOverride }
                  : {}),
                unread: false,
                pinned: false,
                stateChangeSeq: 1,
                completionSeq: 0,
                createdAt: now,
                updatedAt: now,
              })
              this.deps.markConversationOwnership(childId, 'helm')
              await this.deps.store.flushPublic()
              await this.deps.tracker.observe(childId)
              if (this.deps.store.getConv(childId) !== undefined && !this.deps.store.isDeleted(childId)) {
                this.deps.events.publish('conversation.upsert', this.deps.conversations.withOwnership(this.deps.tracker.summaryOf(childId)))
              }
            },
            resolveForkAnchor: (parentId: number) =>
              resolvedAnchor !== undefined && parentId === finalRequest.parentConversationId
                ? Promise.resolve(resolvedAnchor)
                : resolveCleanForkAnchor(this.deps.harness, parentId),
            bindChildToolCall: (childId, parentToolCallId) => {
              const meta = this.deps.store.getConv(childId)
              if (meta === undefined || meta.parentToolCallId === parentToolCallId) return
              this.deps.store.upsertConv({ ...meta, parentToolCallId, updatedAt: Date.now() })
              if (!this.deps.store.isDeleted(childId)) {
                this.deps.events.publish('conversation.upsert', this.deps.conversations.withOwnership(this.deps.tracker.summaryOf(childId)))
              }
            },
            // signal 桥守卫中止：现读归属与权威水位作守卫事实，经内核
            // abortConversationGuarded 原子复核（human-owned 一律拒绝——看门狗
            // 红线；事实过期/目标消失同样确定性拒绝，绝不回退普通中止）。
            abortChildConversationGuarded: async (childId) => {
              const summary = this.deps.conversations.summaryWithOwnership(childId)
              const ownedBy = summary.ownedBy ?? 'human'
              if (ownedBy === 'human') {
                throw new HelmError(
                  'ownership_conflict',
                  `子会话 ${childId} 当前归属 human，拒绝自动中止（看门狗红线）`,
                  409,
                  { conversationId: childId, currentOwnership: ownedBy },
                )
              }
              await this.deps.conversations.abortConversationGuarded(childId, {
                expectedOwnership: ownedBy,
                expectedStateSeq: summary.stateChangeSeq,
              })
            },
          },
        }),
        finalRequest,
      )
    })
  }

  /**
   * gate 门禁（独立 spawn 与 Workflow adapter 共用，只执行一次）。
   */
  runGate(
    command: string,
    options: {
      cwd?: string
      conversationId?: number
      nodeId?: string
      signal?: AbortSignal
      env?: Record<string, string>
      gateTimeoutMs?: number
    } = {},
  ): Promise<{ ok: boolean; output: string; exitCode?: number | null; timedOut?: boolean }> {
    let nodeId = options.nodeId
    if (nodeId === undefined && options.conversationId !== undefined) {
      nodeId = this.deps.store.getConv(options.conversationId)?.nodeId
    }
    return runGate(this.deps.toolDeps, command, { ...options, ...(nodeId !== undefined ? { nodeId } : {}) })
  }

  /**
   * 通用 spawn 靶点解析（ctx.host.resolveSpawnTarget 后端；与原生执行行
   * 同一权威链，见 runtime/spawn-target.ts）。
   */
  async resolveSpawnTarget(input: {
    parentConversationId: number
    profileId?: string
    requestCwd?: string
    fork?: boolean
  }): Promise<{ nodeId: string; sourceCwd: string; parentCwd: string | undefined }> {
    const parent = this.deps.store.getConv(input.parentConversationId)
    if (parent === undefined) {
      throw new HelmError('not_found', `父会话 ${input.parentConversationId} 不存在，无法解析 spawn 靶点`, 404, {
        parentConversationId: input.parentConversationId,
      })
    }
    const { profileId, forkSameProfile } = resolveForkMode(input.profileId, input.fork, parent.profileId)
    const profile = await this.deps.conversations.readProfile(profileId)
    if (profile === undefined) {
      throw new HelmError('not_found', `agentType '${profileId}' 不是已注册的 Profile（profiles/${profileId} 不存在）`, 404)
    }
    // 源 cwd 按目标节点平台统一收口（同角色 fork 为 request > parent > profile > Hub 缺省，
    // 其余为 request > profile > parent > Hub 缺省）：worktree 源目录解析拿到的
    // 是规范化后的路径；win32 目标上不可映射的 POSIX cwd 显式拒绝；远端
    // 平台无可信信息时透传。parentCwd 是父会话镜像事实，原样返回。
    const { nodeId, sourceCwd } = resolveSpawnTargetChain({
      profileNodeId: profile.nodeId,
      parentNodeId: parent.nodeId,
      requestCwd: input.requestCwd,
      profileCwd: profile.cwd,
      parentCwd: parent.cwd,
      defaultCwd: this.deps.toolDeps.defaultCwd,
      forkSameProfile,
      normalize: (cwd, targetNodeId) =>
        normalizeSessionCwd(cwd, {
          nodeId: targetNodeId,
          trustedPlatform: trustedPlatformFromEnvFabric(this.deps.envFabric),
          entry: 'resolve_spawn_target',
        }),
    })
    return { nodeId, sourceCwd, parentCwd: parent.cwd }
  }

  /** 当前进程内仍在执行的 spawn 执行事实（ctx.host.listActiveSpawnExecutions 后端）。 */
  listActiveSpawnExecutions(): AgentExecutionInfo[] {
    return [...this.activeSpawnExecutions.values()].map((info) => ({ ...info }))
  }

  /**
   * 目标节点进程占用快照（ctx.host.inspectNodePathUsage 后端）：
   * 经 EnvFabric 在目标节点真实扫描（local 进程内 / 远端 RPC），失败
   * （离线/不支持/权限/扫描不完整）由 fabric 显式抛 HelmError，本层绝不
   * 吞错、绝不回退本机；快照语义（非互斥、complete=false 必须 fail-closed）
   * 见 protocol/plugin.ts 端口注释。
   */
  async inspectNodePathUsage(input: {
    nodeId: string
    path: string
    signal?: AbortSignal
  }): Promise<import('@helm/protocol').NodePathUsage> {
    if (typeof input.nodeId !== 'string' || input.nodeId === '') {
      throw new HelmError('validation_error', `inspectNodePathUsage 需要非空 nodeId（收到 ${String(input.nodeId)}）`, 400)
    }
    if (typeof input.path !== 'string' || input.path === '' || input.path.includes('\u0000')) {
      throw new HelmError('validation_error', 'inspectNodePathUsage 需要非空且不含 NUL 的 path', 400)
    }
    return this.deps.envFabric.inspectPathUsage(input.nodeId, input.path, input.signal)
  }
}
