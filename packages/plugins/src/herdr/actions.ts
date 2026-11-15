/**
 * builtin:herdr 的 ctx.action 注册（list / read / focus / steer）与 pane 消歧。
 *
 * 从 herdr.ts 拆出（行为与拆分前逐行等价）；依赖经 HerdrActionsDeps 注入：
 * - HTTP/CLI 同权 --json；read 40 行脱敏；focus 为用户显式操作；
 * - read/focus 支持 nodeId 消歧，歧义显式 409；
 * - steer 为 onResolved.controls.steer 委托目标：直调同样独立做调用方祖先链
 *   授权、父会话/run 强匹配与受管 (nodeId, paneId) 精确定位（不因直调豁免授权）。
 */

import { HelmError, type HelmPluginContext } from '@helm/protocol'
import type { ExternalSteerRequest, ExternalSteerResult } from '../contracts.js'
import { isAncestorOrSelf } from '../lineage.js'
import { HERDR_STEER_CONTROLS, type HerdrTransport } from './contracts.js'
import type { HerdrExecutor } from './executor.js'
import { nodeIdOf, type ManagedPane, type PaneRegistry } from './panes.js'
import { parseAgentResult, parsePaneRead } from './rpc.js'
import { isValidNodeId } from './transport.js'

/** actions 对插件主干（herdr.ts）的最小依赖面。 */
export interface HerdrActionsDeps {
  /** registry 现值（未启用时 undefined：list 空表，其余按未管理/未连接报错）。 */
  registry(): PaneRegistry | undefined
  executor(): HerdrExecutor | undefined
  transport(): HerdrTransport
  redact(text: string): string
  /**
   * 会话父链解析（宿主 getConversation 桥；not_found 折叠为 undefined，
   * 其余错误如实上抛）——steer 调用方祖先链授权用。
   */
  parentOfConversation(id: number): number | undefined
}

/** pane 消歧解析：registry 命中多个节点同 ID pane 时显式 409。 */
function resolvePane(registry: PaneRegistry | undefined, input: { paneId: string; nodeId?: string }): ManagedPane {
  if (registry === undefined) {
    throw new HelmError('not_found', `pane ${input.paneId} 不由 builtin:herdr 管理`, 404, { paneId: input.paneId })
  }
  if (input.nodeId !== undefined && input.nodeId !== '') {
    if (!isValidNodeId(input.nodeId)) {
      throw new HelmError('validation_error', `nodeId '${input.nodeId}' 非法`, 400, { nodeId: input.nodeId })
    }
    const pane = registry.get(input.nodeId === 'local' ? undefined : input.nodeId, input.paneId)
    if (pane === undefined) {
      throw new HelmError('not_found', `pane ${input.paneId}@${input.nodeId} 不由 builtin:herdr 管理`, 404, {
        paneId: input.paneId,
        nodeId: input.nodeId,
      })
    }
    return pane
  }
  const candidates = registry.all().filter((p) => p.paneId === input.paneId)
  if (candidates.length === 0) {
    throw new HelmError('not_found', `pane ${input.paneId} 不由 builtin:herdr 管理`, 404, { paneId: input.paneId })
  }
  if (candidates.length > 1) {
    throw new HelmError(
      'pane_ambiguous',
      `pane ${input.paneId} 在多个节点存在（${candidates.map((p) => nodeIdOf(p) ?? 'local').join(', ')}），请用 nodeId 字段消歧`,
      409,
      { paneId: input.paneId, nodeIds: candidates.map((p) => nodeIdOf(p) ?? 'local') },
    )
  }
  return candidates[0]!
}

/** 注册 list / read / focus / steer 四个动作（herdr.ts definePlugin 期调用一次）。 */
export function registerHerdrActions(ctx: HelmPluginContext, deps: HerdrActionsDeps): void {
  // ---- actions（HTTP/CLI 同权；read 40 行脱敏；focus 显式操作） ----
  ctx.action<Record<string, never>, { panes: Array<Record<string, unknown>> }>({
    id: 'list',
    description: '列出本插件管理的 Herdr 窗格（nodeId/pane/状态/归属）',
    idempotent: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { panes: { type: 'array', items: { type: 'object' } } },
      required: ['panes'],
      additionalProperties: false,
    },
    handler() {
      const registry = deps.registry()
      return {
        panes: registry
          ? registry.all().map((p) => ({
              nodeId: nodeIdOf(p) ?? 'local',
              paneId: p.paneId,
              agentName: p.agentName,
              outcome: p.outcome,
              effectiveCwd: p.effectiveCwd,
              parentConversationId: p.parentConversationId,
              ...(p.workflowRunId !== undefined ? { workflowRunId: p.workflowRunId } : {}),
            }))
          : [],
      }
    },
  })

  ctx.action<{ paneId: string; nodeId?: string }, { paneId: string; nodeId: string; text: string }>({
    id: 'read',
    description: '读取本插件管理窗格的终端尾部快照（40 行，脱敏；跨节点同 ID 用 nodeId 消歧）',
    idempotent: true,
    inputSchema: {
      type: 'object',
      properties: {
        paneId: { type: 'string', minLength: 1 },
        nodeId: { type: 'string', description: '目标节点（缺省本机；同 ID 多节点时必填消歧）' },
      },
      required: ['paneId'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { paneId: { type: 'string' }, nodeId: { type: 'string' }, text: { type: 'string' } },
      required: ['paneId', 'nodeId', 'text'],
      additionalProperties: false,
    },
    async handler(input) {
      const pane = resolvePane(deps.registry(), input)
      const read = parsePaneRead(
        await deps.transport().call(pane.target, 'agent.read', {
          target: pane.paneId,
          source: 'recent_unwrapped',
          lines: 40,
          format: 'text',
        }),
      )
      return { paneId: pane.paneId, nodeId: nodeIdOf(pane) ?? 'local', text: deps.redact(read.text) }
    },
  })

  ctx.action<{ paneId: string; nodeId?: string }, { paneId: string; nodeId: string; focused: boolean }>({
    id: 'focus',
    description: '在 Herdr 终端聚焦指定窗格（用户显式操作；跨节点同 ID 用 nodeId 消歧）',
    inputSchema: {
      type: 'object',
      properties: {
        paneId: { type: 'string', minLength: 1 },
        nodeId: { type: 'string', description: '目标节点（缺省本机；同 ID 多节点时必填消歧）' },
      },
      required: ['paneId'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { paneId: { type: 'string' }, nodeId: { type: 'string' }, focused: { type: 'boolean' } },
      required: ['paneId', 'nodeId', 'focused'],
      additionalProperties: false,
    },
    async handler(input) {
      const pane = resolvePane(deps.registry(), input)
      // 真实协议（服务端源码 agents.rs:35-41）：agent.focus 返回
      // ResponseResult::AgentInfo { agent }（agent_info），非 ok。
      const info = parseAgentResult(
        await deps.transport().call(pane.target, 'agent.focus', { target: pane.paneId }),
        'agent.focus',
        'agent_info',
      )
      if (info.focused !== true) {
        throw new HelmError(
          'herdr_focus_failed',
          `agent.focus 返回 focused=false（pane ${pane.paneId}@${nodeIdOf(pane) ?? 'local'}）`,
          502,
          { paneId: pane.paneId, nodeId: nodeIdOf(pane) ?? 'local' },
        )
      }
      return { paneId: pane.paneId, nodeId: nodeIdOf(pane) ?? 'local', focused: true }
    },
  })

  // ---- 动作 steer：受管窗格运行中插话（onResolved.controls.steer 委托目标） ----
  // 通常由 builtin:workflow.steer 依据节点 controls 动态路由到本动作，也可
  // HTTP/CLI/run_action 直调；直调同样独立做调用方祖先链授权、父会话/run
  // 强匹配与受管 (nodeId, paneId) 精确定位（不因直调豁免授权）。投递唯一
  // 入口 executor.steerPane：受管 task 阶段预检后调用现有 agent.prompt；
  // preflight 不承诺提交点 CAS，steered 仅代表投递成功。
  ctx.action<ExternalSteerRequest, ExternalSteerResult>({
    id: HERDR_STEER_CONTROLS.actionId,
    description:
      '向本插件受管、且由 workflow run 派生的 Herdr 窗格补充指导。仅任务执行期预检为 working 时发送，使用 Herdr 原生 agent.prompt；预检与投递之间刚变为 idle 时允许接续一轮。blocked 交原审批桥处理，关闭、交接和 Gate 阶段拒绝。guardLevel=preflight 表示发送前检查，不保证提交点 CAS；steered=true 仅代表已投递。超时或断线不自动重试。',
    inputSchema: {
      type: 'object',
      properties: {
        executionId: { type: 'string', minLength: 1, description: '受管执行标识（onResolved.executionId，即 paneId）' },
        nodeId: { type: 'string', description: "实际执行节点（'local' 或节点 ID；必须与窗格登记一致）" },
        workflowRunId: { type: 'string', minLength: 1, description: '派生该窗格的 workflow run ID（强匹配；仅限 run 管理下的窗格）' },
        parentConversationId: { type: 'number', minimum: 1, description: '派生该窗格的父会话 ID（强匹配）' },
        text: { type: 'string', minLength: 1, description: '插话指导内容（非空；脱敏后附交接契约提醒注入终端）' },
      },
      required: ['executionId', 'nodeId', 'workflowRunId', 'parentConversationId', 'text'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        steered: { type: 'boolean', const: true },
        executionId: { type: 'string' },
        nodeId: { type: 'string' },
        stateChangeSeq: { type: 'number', minimum: 0, description: '发送前预检观测的权威水位' },
        ownership: { type: 'string', const: 'helm' },
        guardLevel: { type: 'string', const: 'preflight', description: '发送前预检，不承诺提交点 CAS' },
      },
      required: ['steered', 'executionId', 'nodeId', 'stateChangeSeq', 'ownership', 'guardLevel'],
      additionalProperties: false,
    },
    cli: {
      command: ['herdr', 'steer'],
      description: '向受管 Herdr 窗格补充指导（通常用 helm workflows steer <runId> 自动路由）',
      timeoutMs: 15_000,
    },
    async handler(input, context) {
      const registry = deps.registry()
      const executor = deps.executor()
      if (registry === undefined || executor === undefined) {
        throw new HelmError(
          'herdr_not_connected',
          'Herdr 服务未启动（未连接目标服务器），无法插话',
          409,
        )
      }
      // 受管节点精确定位：显式 nodeId 必须与登记一致（不接受同 pane 不同
      // node；'local' 折叠为本机缺省）。
      if (input.nodeId !== 'local' && !isValidNodeId(input.nodeId)) {
        throw new HelmError('validation_error', `nodeId '${input.nodeId}' 非法`, 400, { nodeId: input.nodeId })
      }
      const pane = registry.get(input.nodeId === 'local' ? undefined : input.nodeId, input.executionId)
      if (pane === undefined) {
        throw new HelmError(
          'not_found',
          `窗格 ${input.executionId}@${input.nodeId} 不由 builtin:herdr 管理`,
          404,
          { executionId: input.executionId, nodeId: input.nodeId },
        )
      }
      // 调用方祖先链独立授权：携带会话上下文的调用必须是 run 父会话的
      // 自身或祖先。会话上下文在模型路径由内核注入；HTTP 自报
      // conversationId 仅作作用域提示（非认证），不匹配同样拒绝。
      const caller = context.conversationId
      if (caller !== undefined) {
        if (!isAncestorOrSelf(input.parentConversationId, caller, deps.parentOfConversation)) {
          throw new HelmError(
            'herdr_steer_out_of_scope',
            `会话 ${caller} 无权插话窗格 ${input.executionId}：该窗格属父会话 ${input.parentConversationId} 的运行，仅其自身或祖先（或人工 HTTP/CLI）可插话`,
            403,
            { callerConversationId: caller, parentConversationId: input.parentConversationId, executionId: input.executionId },
          )
        }
      }
      // 投递（归属、阶段与运行状态在 executor 内独立复核）。
      const { stateChangeSeq } = await executor.steerPane(pane, {
        workflowRunId: input.workflowRunId,
        parentConversationId: input.parentConversationId,
        text: input.text,
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
      })
      return {
        steered: true as const,
        executionId: pane.paneId,
        nodeId: nodeIdOf(pane) ?? 'local',
        stateChangeSeq,
        ownership: 'helm' as const,
        guardLevel: 'preflight' as const,
      }
    },
  })
}
