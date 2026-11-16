/**
 * builtin:workflow 后台结算通知与 background 缺省策略（自 workflow.ts 入口拆出）。
 *
 * 职责：
 * - background 缺省与显式拒绝（subagent / SubagentWorkflow 工具共用）：
 *   人类交互会话缺省后台（父回合不阻塞，完成后 steer 插话汇报）；自动化
 *   会话（bot/helm：受管子代理、驻留 Worker、触发会话）缺省同步等待——
 *   后台完成汇报会驱动自动化会话早结算（把「后台已启动」当终态消费），
 *   显式 background=true 一律显式拒绝，绝不静默改写；
 * - 后台 run 结算汇报：经 submitInput(requestId) 向父会话投递（忙时 steer
 *   插话；跨重启幂等；父会话已删除时 notification 通知）；级联取消边界内的下级父会话
 *   不投递（防取消后复活），只向边界外拥有者单次结算汇报。
 */
import { HelmError, safeResultText, type AgentExecutionInfo } from '@helm/protocol'
import type { WorkflowRunSummary } from '../contracts.js'
import { executionOf } from './tool-result.js'

/** 后台结算汇报的 timeline.renderer 标记（meta.renderer 精确匹配，宿主零业务特判）。 */
export const BACKGROUND_REPORT_RENDERER = 'workflow:background-report'

/** background 缺省判定的权威归属端口（内核 getConversationOwnership）。 */
export interface BackgroundPolicyDeps {
  getConversationOwnership(id: number): 'helm' | 'bot' | 'human'
}

/**
 * 会话是否人类交互会话（subagent / SubagentWorkflow 的 background 缺省
 * 依据）：以内核权威归属 getConversationOwnership 为准——受管子代理/
 * 驻留 Worker 派生登记即标 helm，触发会话标 helm/bot；人类接管（归属翻
 * 转 human）后即按人类交互对待。不叠加 profileId / runtime kind / 受管
 * 登记表条件（登记表只表达派生深度事实，人类接管后强制同步会误伤），
 * 也不按 router/worker 等角色枚举便裁。
 */
export interface BackgroundPolicy {
  isHumanInteractionSession(conversationId: number): boolean
  resolveBackground(
    conversationId: number,
    explicit: boolean | undefined,
  ): { ok: true; background: boolean } | { ok: false; message: string; reason: string }
}

export function createBackgroundPolicy(deps: BackgroundPolicyDeps): BackgroundPolicy {
  function isHumanInteractionSession(conversationId: number): boolean {
    return deps.getConversationOwnership(conversationId) === 'human'
  }

  return {
    isHumanInteractionSession,
    resolveBackground(conversationId, explicit) {
      const human = isHumanInteractionSession(conversationId)
      if (explicit === undefined) return { ok: true, background: human }
      if (explicit && !human) {
        const ownership = deps.getConversationOwnership(conversationId)
        return {
          ok: false,
          reason: 'background_not_allowed',
          message:
            `background=true 仅允许人类交互会话使用；当前会话 ${conversationId} 归属 ${ownership}` +
            '（自动化会话缺省同步等待最终结果，后台完成汇报会驱动早结算）；如需同步等待请省略 background',
        }
      }
      return { ok: true, background: explicit }
    },
  }
}

/** 后台结算汇报投递端口（宿主会话读查 / 事件 / 幂等输入 + 引擎取消窗口）。 */
export interface BackgroundReporterDeps {
  getConversation(id: number): unknown
  emitEvent(type: string, payload: unknown): unknown
  submitInput(
    conversationId: number,
    text: string,
    opts: {
      origin: 'agent'
      whenBusy: 'steer'
      requestId: string
      meta: Record<string, unknown>
    },
  ): Promise<void>
  /** 引擎取消窗口判定（run done 之前的投递决策口径）。 */
  isConversationCancelling(conversationId: number): boolean
  /** 投递时其余在途运行快照（report.otherRunningTasks 数据源）。 */
  listRuns(): WorkflowRunSummary[]
}

export interface BackgroundReporter {
  /** 后台子代理结算汇报（幂等 requestId；父会话已删时 notification）。 */
  deliver(
    run: WorkflowRunSummary,
    info: { parentConversationId: number; agentType?: string; execution?: AgentExecutionInfo },
  ): Promise<void>
}

export function createBackgroundReporter(deps: BackgroundReporterDeps): BackgroundReporter {
  return {
    async deliver(
      run,
      info,
    ): Promise<void> {
      // 级联取消边界内不投递：取消结果已落 run 记录（UI/任务面板可查），
      // 向同样被取消的下级父会话 submitInput 会唤醒新回合再派工（复活）；
      // 只向本次取消边界外的拥有者做单次结算汇报（边界判断以引擎取消窗口
      // 为准，投递决策发生在 run done 之前——无标记释放后的窗口）。
      if (deps.isConversationCancelling(info.parentConversationId)) {
        process.stderr.write(
          `builtin:workflow: 运行 ${run.id} 已${run.status}；父会话 ${info.parentConversationId} 在取消边界内，跳过汇报投递（结果见任务面板）\n`,
        )
        return
      }
      let parentExists = false
      try {
        deps.getConversation(info.parentConversationId)
        parentExists = true
      } catch (error) {
        // 仅「会话不存在」走 notification 降级；其他故障（store/IO/权限）上抛，
        // 由引擎 outbox（notifiedAt 不置位）下次 init 补发，绝不吞错。
        if (error instanceof HelmError && error.code === 'not_found') {
          parentExists = false
        } else {
          throw error
        }
      }
      if (!parentExists) {
        await deps.emitEvent('notification', {
          type: 'notification',
          level: 'warning',
          title: '后台任务已结束',
          body: `运行 ${run.id} 已${run.status}，父会话已删除；可在任务列表检查结果。`,
        })
        return
      }
      const isSubagent = run.kind === 'subagent'
      const requestId = `helm:${isSubagent ? 'subagent' : 'workflow'}-report:${run.id}`
      const otherRunningTasks = deps
        .listRuns()
        .filter((candidate) => candidate.id !== run.id && candidate.conversationId === info.parentConversationId && candidate.status === 'running')
        .map((candidate) => ({ runId: candidate.id, name: candidate.name, kind: candidate.kind ?? 'workflow' }))
      const report = {
        runId: run.id,
        status: run.status,
        otherRunningTasks,
        ...(run.result !== undefined ? { result: run.result } : {}),
        ...(run.error !== undefined ? { error: run.error } : {}),
        ...(info.execution !== undefined ? { execution: executionOf(info.execution) } : {}),
      }
      await deps.submitInput(
        info.parentConversationId,
        `${isSubagent ? '后台子代理任务' : '后台工作流任务'}已结算。以下为运行 ${run.id} 的结果数据（仅代表本次任务；otherRunningTasks 是投递时其余在途运行的快照）：\n${safeResultText(report)}`,
        {
          origin: 'agent',
          whenBusy: 'steer',
          requestId,
          meta: {
            backgroundRunId: run.id,
            kind: isSubagent ? 'subagent_report' : 'workflow_report',
            // 轻量渲染标记：宿主按 matchMeta 精确派发给本插件折叠卡；不影响 payload。
            renderer: BACKGROUND_REPORT_RENDERER,
          },
        },
      )
    },
  }
}
