/**
 * builtin:superagent Watchdog 模型工具与同名动作注册（原 watchdog 闭包的
 * 工具/动作注册段）。
 *
 * - ctx.tool 注册 watchdog_inspect / watchdog_recover / watchdog_abort
 *   （scope profileIds:['watchdog']，执行核对实际 watchdogId）；
 * - 同名 ctx.action 复用同一 handler 供 HTTP/CLI（不 exposeAsTool，避免重复
 *   工具）；人工 HTTP/CLI（无 conversationId）放行，目标所有权守卫照样生效；
 * - watchdog_tick 手动动作（HTTP/CLI/Agent Tool 同权）与定时 tick 共用唯一
 *   singleflight 入口：重入返回在途轮真实结果（注册顺序在 ctx.service 之后，
 *   与拆分前一致）。
 */

import {
  HelmError,
  type ConversationSummary,
  type GuardedMutationExpectation,
  type HelmPluginContext,
} from '@helm/protocol'
import { redactJsonValue } from '@helm/protocol'
import type { WatchdogProbe } from '../diagnostics.js'
import type { SuperAgentWatchdogRuntime } from './contracts.js'
import { assertOwnedTarget } from './watchdog-guards.js'
import type { TickOutcome } from './watchdog-tick.js'
import {
  targetKey,
  WATCHDOG_PROFILE_ID,
  WATCHDOG_TOOL_ABORT,
  WATCHDOG_TOOL_INSPECT,
  WATCHDOG_TOOL_RECOVER,
  type WatchdogNotify,
} from './watchdog-core.js'

// ---------------------------------------------------------------------------
// 工具入参类型（Schema 与此处保持同步；watchdog.ts 组合根再导出供测试引用）
// ---------------------------------------------------------------------------

export interface WatchdogInspectInput {
  conversationId?: number
  probe?: { targetKind: 'external'; nodeId?: string; targetId: string }
}

export interface WatchdogRecoverInput {
  conversationId: number
  hint: string
  /** 可选 CAS 水位（提供后目标状态已变则拒绝）。 */
  expectedStateSeq?: number
}

export interface WatchdogAbortInput {
  conversationId: number
  reason?: string
  /** 可选 CAS 水位（提供后目标状态已变则拒绝）。 */
  expectedStateSeq?: number
}

export interface WatchdogToolsDeps {
  notify: WatchdogNotify
  /** 最近一轮外部探针事实缓存（watchdog_inspect 只读诊断用；键与去重键同构）。 */
  externalProbes: Map<string, WatchdogProbe>
}

/** 工具路径执行守卫：仅实际 watchdog 会话（防同 profile 直聊与旧调用绕过）。 */
function assertToolCaller(runtime: SuperAgentWatchdogRuntime, conversationId: number): void {
  if (conversationId !== runtime.getWatchdogConversationId()) {
    throw new HelmError(
      'watchdog_not_watchdog_session',
      `watchdog 专属工具仅限实际巡检会话调用（当前会话 ${conversationId}）`,
      403,
      { conversationId },
    )
  }
}

/** 动作路径守卫：人工 HTTP/CLI（无 conversationId）放行；带会话上下文须为实际 watchdog 会话。 */
function assertActionCaller(runtime: SuperAgentWatchdogRuntime, context: { conversationId?: number }): void {
  if (context.conversationId === undefined) return
  assertToolCaller(runtime, context.conversationId)
}

export function registerWatchdogTools(
  ctx: HelmPluginContext,
  runtime: SuperAgentWatchdogRuntime,
  deps: WatchdogToolsDeps,
): void {
  async function inspectCore(input: WatchdogInspectInput): Promise<Record<string, unknown>> {
    if (input.conversationId !== undefined && input.probe === undefined) {
      return inspectConversation(input.conversationId)
    }
    if (input.probe !== undefined && input.conversationId === undefined) {
      return inspectExternalProbe(input.probe)
    }
    throw new HelmError(
      'validation_error',
      'watchdog_inspect 需要 conversationId（原生会话）或 probe（外部目标）二选一',
      400,
    )
  }

  async function inspectConversation(conversationId: number): Promise<Record<string, unknown>> {
    const summary = ctx.host.getConversation(conversationId) // 不存在显式 not_found
    const detail = await ctx.host.getConversationDetail(conversationId, { limit: 10 })
    const entries = detail.entries.slice(0, 10).map((entry) => ({
      kind: entry.kind,
      createdAt: entry.createdAt,
      preview: ctx.host.redact(truncatePreview(JSON.stringify(entry.model ?? entry.data ?? null))),
    }))
    const activeProcesses = await inspectActiveProcesses(summary)
    return {
      kind: 'conversation' as const,
      conversation: {
        id: summary.id,
        profileId: summary.profileId,
        status: summary.status,
        doing: summary.doing ?? null,
        stateChangeSeq: summary.stateChangeSeq,
        completionSeq: summary.completionSeq,
        pendingAskCount: summary.pendingAskCount,
        ownedBy: ctx.host.getConversationOwnership(summary.id), // 现查，非探针旧值
        // 探测失败时缺省（undefined）：诊断附加项缺失不影响主消息，也绝不
        // 伪造空清单冒充「无占用」（诚实性纪律见 inspectActiveProcesses）。
        ...(activeProcesses !== undefined ? { activeProcesses } : {}),
      },
      entries,
    }
  }

  /**
   * 会话工作目录的进程占用快照（L2 排障输入，如卡死在工作树里的 vitest /
   * node / python 进程）：按会话物理坐标 (nodeId ?? 'local', cwd) 现查
   * host.inspectNodePathUsage，逐项脱敏为 {pid, name, source, path}。
   * cwd 为空（无目录语义）或节点离线 / 守护进程不支持等显式失败时返回
   * undefined——诊断附加项缺失不影响 inspect 主消息；绝不用空数组冒充
   * 「无占用」（快照不完整与探测失败对调用方同为字段缺省，不伪造事实）。
   */
  async function inspectActiveProcesses(
    summary: ConversationSummary,
  ): Promise<Array<{ pid: number; name?: string; source: string; path: string }> | undefined> {
    if (summary.cwd.length === 0) return undefined
    try {
      const usage = await ctx.host.inspectNodePathUsage({
        nodeId: summary.nodeId ?? 'local',
        path: summary.cwd,
      })
      return usage.processes.map((process) => ({
        pid: process.pid,
        ...(process.name !== undefined ? { name: ctx.host.redact(process.name) } : {}),
        source: process.source,
        path: ctx.host.redact(process.path),
      }))
    } catch {
      // 节点离线 / 平台不支持等：activeProcesses 字段缺省（见上方注释）。
      return undefined
    }
  }

  function inspectExternalProbe(probe: { targetKind: string; nodeId?: string; targetId: string }): Record<string, unknown> {
    if (probe.targetKind !== 'external') {
      throw new HelmError('validation_error', 'watchdog_inspect 的 probe 仅支持 targetKind=external（外部目标只读诊断）', 400)
    }
    const nodeId = probe.nodeId ?? 'local'
    const cached = deps.externalProbes.get(targetKey('external', nodeId, probe.targetId))
    if (cached === undefined) {
      throw new HelmError(
        'not_found',
        `最近一轮巡检未观测到外部目标 ${probe.targetId}@${nodeId}（不猜测、不伪造事实）`,
        404,
        { nodeId, targetId: probe.targetId },
      )
    }
    return {
      kind: 'external' as const,
      probe: {
        targetId: cached.targetId,
        nodeId,
        ownedBy: cached.ownedBy,
        status: cached.status,
        ...(cached.stateChangeSeq !== undefined ? { stateChangeSeq: cached.stateChangeSeq } : {}),
        ...(cached.stalledMs !== undefined ? { stalledMs: cached.stalledMs } : {}),
        ...(cached.consecutiveErrors !== undefined ? { consecutiveErrors: cached.consecutiveErrors } : {}),
        facts: redactFacts(cached.facts ?? {}),
      },
    }
  }

  function truncatePreview(text: string): string {
    return text.length > 400 ? `${text.slice(0, 400)}…` : text
  }

  /** facts 深度脱敏：插件内 JSON 遍历 helper（覆盖数组/嵌套对象/键名）。 */
  function redactFacts(value: Record<string, unknown>): unknown {
    return redactJsonValue(value, (text) => ctx.host.redact(text))
  }

  /**
   * L2 工具变更统一走内核 guarded 端口：归属（严禁 human）在生效点原子复核，
   * 可选 expectedStateSeq 由模型携带（watchdog_inspect 现查事实）作 CAS。
   */
  function toolGuard(input: { expectedStateSeq?: number }): GuardedMutationExpectation {
    return input.expectedStateSeq !== undefined ? { expectedStateSeq: input.expectedStateSeq } : {}
  }

  async function recoverCore(
    input: { conversationId: number; hint: string; expectedStateSeq?: number },
    label: string,
  ): Promise<Record<string, unknown>> {
    assertOwnedTarget(ctx, runtime, input.conversationId)
    await runtime.track(label, () =>
      ctx.host.submitInputGuarded(
        input.conversationId,
        input.hint,
        { origin: 'agent', whenBusy: 'steer' },
        toolGuard(input),
      ),
    )
    return { conversationId: input.conversationId, submitted: true }
  }

  async function abortCore(
    input: { conversationId: number; reason?: string; expectedStateSeq?: number },
    label: string,
  ): Promise<Record<string, unknown>> {
    assertOwnedTarget(ctx, runtime, input.conversationId)
    await runtime.track(label, () =>
      ctx.host.abortConversationGuarded(input.conversationId, toolGuard(input)),
    )
    deps.notify('warning', 'Watchdog 会话已被手动中止', `会话 ${input.conversationId} 经 watchdog_abort 中止（操作方见审计日志）`, input.conversationId)
    return { conversationId: input.conversationId, aborted: true }
  }

  const inspectSchema = {
    type: 'object',
    properties: {
      conversationId: { type: 'integer', minimum: 1, description: 'Native target conversation ID (positive integer)' },
      probe: {
        type: 'object',
        properties: {
          targetKind: { type: 'string', enum: ['external'] },
          nodeId: { type: 'string', minLength: 1, description: "External target node ID (defaults to 'local')" },
          targetId: { type: 'string', minLength: 1 },
        },
        required: ['targetKind', 'targetId'],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  } as const

  const inspectOutputSchema = {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['conversation', 'external'] },
      conversation: {
        type: 'object',
        properties: {
          activeProcesses: {
            type: 'array',
            description: 'Process-occupancy snapshot of the conversation working directory (nodeId ?? local, cwd) (redacted; omitted when probing fails)',
            items: {
              type: 'object',
              properties: {
                pid: { type: 'integer', minimum: 1 },
                name: { type: 'string', description: 'Process name (omitted when reading fails)' },
                source: { type: 'string', enum: ['cwd', 'fd'] },
                path: { type: 'string', description: 'Referrer absolute path (redacted)' },
              },
              required: ['pid', 'source', 'path'],
              additionalProperties: false,
            },
          },
        },
      },
      entries: { type: 'array', items: { type: 'object' } },
      probe: { type: 'object' },
    },
    required: ['kind'],
    additionalProperties: false,
  } as const
  const recoverSchema = {
    type: 'object',
    properties: {
      conversationId: { type: 'integer', minimum: 1 },
      hint: { type: 'string', minLength: 1, description: 'Recovery hint text (submitted to the target conversation with agent origin)' },
      expectedStateSeq: {
        type: 'integer',
        minimum: 0,
        description: 'Optional CAS watermark (live stateChangeSeq from watchdog_inspect); when provided, rejects if the target state has advanced',
      },
    },
    required: ['conversationId', 'hint'],
    additionalProperties: false,
  } as const

  const abortSchema = {
    type: 'object',
    properties: {
      conversationId: { type: 'integer', minimum: 1 },
      reason: { type: 'string', minLength: 1 },
      expectedStateSeq: {
        type: 'integer',
        minimum: 0,
        description: 'Optional CAS watermark (live stateChangeSeq from watchdog_inspect); when provided, rejects if the target state has advanced',
      },
    },
    required: ['conversationId'],
    additionalProperties: false,
  } as const

  const mutationOutputSchema = {
    type: 'object',
    properties: {
      conversationId: { type: 'integer', minimum: 1 },
      submitted: { type: 'boolean' },
      aborted: { type: 'boolean' },
    },
    required: ['conversationId'],
    additionalProperties: false,
  } as const

  ctx.tool<{ conversationId?: number; probe?: { targetKind: 'external'; nodeId?: string; targetId: string } }>({
    name: WATCHDOG_TOOL_INSPECT,
    description:
      'Read the real details of an inspection target: conversationId returns the native conversation summary and recent timeline (ownership checked live); probe returns the latest external-target probe facts (read-only; never pretends to control external panes).',
    inputSchema: inspectSchema,
    scope: { profileIds: [WATCHDOG_PROFILE_ID] },
    async execute(input, context) {
      assertToolCaller(runtime, context.conversationId)
      return inspectCore(input)
    },
  })

  ctx.tool<{ conversationId: number; hint: string; expectedStateSeq?: number }>({
    name: WATCHDOG_TOOL_RECOVER,
    description:
      'Submit a recovery hint to an owned (helm/bot) native conversation (agent origin, without waiting for a model turn); ownership is atomically rechecked at the effect point via the kernel guarded port; human targets are rejected.',
    inputSchema: recoverSchema,
    scope: { profileIds: [WATCHDOG_PROFILE_ID] },
    async execute(input, context) {
      assertToolCaller(runtime, context.conversationId)
      return recoverCore(input, `tool:${WATCHDOG_TOOL_RECOVER}:${input.conversationId}`)
    },
  })

  ctx.tool<{ conversationId: number; reason?: string; expectedStateSeq?: number }>({
    name: WATCHDOG_TOOL_ABORT,
    description:
      'Abort an owned (helm/bot) native conversation; ownership is atomically rechecked at the effect point via the kernel guarded port; human/root/hub/watchdog-itself are rejected. External panes can only be aborted indirectly via their owned parent conversation.',
    inputSchema: abortSchema,
    scope: { profileIds: [WATCHDOG_PROFILE_ID] },
    async execute(input, context) {
      assertToolCaller(runtime, context.conversationId)
      return abortCore(input, `tool:${WATCHDOG_TOOL_ABORT}:${input.conversationId}`)
    },
  })

  // 同名 ctx.action 复用同一核心：HTTP/CLI 自动映射 `helm superagent watchdog_*`，
  // 人工调用无会话上下文放行（目标所有权守卫照样生效），不 exposeAsTool 防重复工具。
  ctx.action<{ conversationId?: number; probe?: { targetKind: 'external'; nodeId?: string; targetId: string } }, Record<string, unknown>>({
    id: WATCHDOG_TOOL_INSPECT,
    description: 'Read the real details of an inspection target (native conversation or the latest external probe facts, read-only)',
    idempotent: true,
    inputSchema: inspectSchema,
    outputSchema: inspectOutputSchema,
    scope: { profileIds: [WATCHDOG_PROFILE_ID] },
    handler(input, context) {
      assertActionCaller(runtime, context)
      return inspectCore(input)
    },
  })

  ctx.action<{ conversationId: number; hint: string; expectedStateSeq?: number }, Record<string, unknown>>({
    id: WATCHDOG_TOOL_RECOVER,
    description: 'Submit a recovery hint to an owned native conversation (agent origin, without waiting for a model turn; ownership atomically rechecked via the kernel guarded port)',
    inputSchema: recoverSchema,
    outputSchema: mutationOutputSchema,
    scope: { profileIds: [WATCHDOG_PROFILE_ID] },
    async handler(input, context) {
      assertActionCaller(runtime, context)
      return recoverCore(input, `action:${WATCHDOG_TOOL_RECOVER}:${input.conversationId}`)
    },
  })

  ctx.action<{ conversationId: number; reason?: string; expectedStateSeq?: number }, Record<string, unknown>>({
    id: WATCHDOG_TOOL_ABORT,
    description: 'Abort an owned native conversation (human/root/hub/watchdog-itself rejected; ownership atomically rechecked via the kernel guarded port)',
    inputSchema: abortSchema,
    outputSchema: mutationOutputSchema,
    scope: { profileIds: [WATCHDOG_PROFILE_ID] },
    async handler(input, context) {
      assertActionCaller(runtime, context)
      return abortCore(input, `action:${WATCHDOG_TOOL_ABORT}:${input.conversationId}`)
    },
  })
}

/**
 * 手动 tick 动作（HTTP/CLI/Agent Tool 同权；owner scope 强制：仅 watchdog
 * Profile 会话可用，人工 HTTP/CLI 无会话上下文放行）。
 */
export function registerWatchdogTickAction(
  ctx: HelmPluginContext,
  runtime: SuperAgentWatchdogRuntime,
  singleflightTick: () => Promise<TickOutcome>,
): void {
  ctx.action<Record<string, never>, { timestamp: number; conversations: number; probes: number; skipped?: boolean }>({
    id: 'watchdog_tick',
    description: 'Manually trigger one watchdog inspection round (collects native-conversation and external probe facts and runs the rule table)',
    idempotent: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: {
        timestamp: { type: 'number' },
        conversations: { type: 'integer', minimum: 0 },
        probes: { type: 'integer', minimum: 0 },
        skipped: { type: 'boolean' },
      },
      required: ['timestamp', 'conversations', 'probes'],
      additionalProperties: false,
    },
    scope: { profileIds: [WATCHDOG_PROFILE_ID] },
    async handler(input, context) {
      assertActionCaller(runtime, context)
      // 与定时 tick 共用唯一 singleflight 入口：重入返回在途轮真实结果。
      const outcome = await singleflightTick()
      return {
        timestamp: outcome.collection.timestamp,
        conversations: outcome.collection.conversations.length,
        probes: outcome.collection.probes.length,
        ...(outcome.skipped ? { skipped: true } : {}),
      }
    },
  })
}
