/**
 * builtin:workflow 引擎宿主适配（自 workflow.ts 入口拆出）。
 *
 * 职责：把 HelmHostApi 受信端口适配为 WorkflowServiceHost（引擎的唯一宿主
 * 形状），并承载两条安全纪律：
 * - 守卫式子会话中止（abortConversationGuarded 适配器）：现读归属与权威
 *   水位作守卫事实，经内核原子复核；human 红线由内核在串行域内兜底拒绝；
 * - emitEvent 适配器收口：投影/广播失败只诊断（stderr + 显式
 *   notification），绝不逃逸为 unhandledRejection——run 终态以 records
 *   持久层为准。
 */
import { HelmError, type HelmHostApi } from '@helm/protocol'
import type { WorkflowRunSummary } from '../contracts.js'
import type { AgentExecutionInfo } from '@helm/protocol'
import type { WorkflowServiceHost } from './engine/service.js'
import type { RunsProjection } from './projection.js'

/** 引擎适配所需宿主端口（全部经 ctx.host 受信通道注入）。 */
export type EngineHostPorts = Pick<
  HelmHostApi,
  | 'spawnAgent'
  | 'invokeAction'
  | 'prepareAction'
  | 'execEnv'
  | 'listActions'
  | 'getConversation'
  | 'getConversationOwnership'
  | 'abortConversationGuarded'
  | 'emitEvent'
  | 'runGate'
  | 'isClosing'
>

export interface WorkflowEngineHostDeps {
  host: EngineHostPorts
  /** runs 投影（emitEvent / onRunSettled / onBackgroundAgentSettled 同步入口）。 */
  projection: RunsProjection
  /** 后台结算汇报（onBackgroundAgentSettled 投递；stop 期间由调用侧跳过）。 */
  deliverBackgroundReport: (
    run: WorkflowRunSummary,
    info: { parentConversationId: number; agentType?: string; execution?: AgentExecutionInfo },
  ) => Promise<void>
}

export function createWorkflowEngineHost(deps: WorkflowEngineHostDeps): WorkflowServiceHost {
  const { host, projection } = deps
  return {
    spawnAgent: (request) => host.spawnAgent(request),
    invokeAction: async (pluginId, actionId, input, invokeContext) => {
      // ctx.host.invokeAction 已是宿主统一脱敏出口（protocol 契约）。
      return host.invokeAction(pluginId, actionId, input, invokeContext)
    },
    // 真实宿主接完整 prepareAction preflight（插件状态/scope/inputSchema +
    // 定义端 idempotent）；失败显式上抛，绝不退回 listActions 清单冒充。
    prepareAction: (pluginId, actionId, input, prepareContext) =>
      host.prepareAction(pluginId, actionId, input, prepareContext),
    // 跨节点命令执行：取消信号透传，失败由引擎显式上抛（不吞、不假成功）。
    execEnv: (req, signal) => host.execEnv(req, { signal }),
    listActions: () => host.listActions(),
    getConversation: (id) => host.getConversation(id),
    // 守卫式子会话中止（自动化取消唯一入口）：现读归属与权威水位作守卫
    // 事实，经内核 abortConversationGuarded 原子复核；human 红线由内核在
    // 串行域内兜底拒绝。事实读取不可用（如受控停止窗口）时携空守卫调用
    // ——内核仍拒 human，绝不因此回退普通 abortConversation；守卫拒绝
    // （归属翻转/水位推进/目标删除）确定性放弃并诊断，不重试不掩盖。
    abortConversationGuarded: async (id) => {
      let guard: { expectedOwnership?: 'bot' | 'helm'; expectedStateSeq?: number } = {}
      try {
        const ownership = host.getConversationOwnership(id)
        guard =
          ownership === 'human'
            ? {}
            : {
                expectedOwnership: ownership,
                expectedStateSeq: host.getConversation(id).stateChangeSeq,
              }
      } catch (error) {
        if (error instanceof HelmError && error.code === 'not_found') return
        // 事实读取不可用：空守卫仍经内核原子复核（human 仍被拒）。
        guard = {}
      }
      // 原样透传内核结果（含拒绝），适配器绝不吞异常：引擎各调用点自带
      // 容忍分类（init 逐子诊断 try/catch、abortChildConversation 的
      // .catch、prepareRecovery 按 not_found/ownership_conflict 与意外
      // 错误区分屏障阻断/重试）——吞掉意外错误会让恢复屏障在未落取消
      // 标记时静默“成功”。
      await host.abortConversationGuarded(id, guard)
    },
    // 引擎侧签名是 void（各调用点 fire-and-forget 不 await）：适配器必须
    // 自吞异常——runs 投影（listRuns 可抛 workflow_index_corrupt）与广播
    // 失败只能诊断，逃逸会变成 unhandledRejection 拖垮进程（stop 路径
    // 同款纪律：stderr + 显式 notification，绝不静默）。
    emitEvent: async (type, payload) => {
      try {
        if (type === 'workflow.updated') {
          projection.sync()
          // 全局只发布状态失效提示，详情经会话投影订阅，不旁路广播节点输出。
          const run = (payload as { run: WorkflowRunSummary }).run
          await host.emitEvent(type, { run: { id: run.id, conversationId: run.conversationId, status: run.status } })
          return
        }
        await host.emitEvent(type, payload)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`builtin:workflow: emitEvent ${type} 投影/广播失败（run 状态以 records 持久层为准）: ${message}\n`)
        Promise.resolve(
          host.emitEvent('notification', {
            type: 'notification',
            level: 'warning',
            title: '工作流事件投影未同步',
            body: `同步 runs 投影或广播 ${type} 事件失败（运行终态以任务面板重查为准）：${message}`,
          }),
        ).catch(() => {})
      }
    },
    onRunSettled: async (summary) => {
      projection.sync()
      // workflow.settled：herdr 双轨保活清理等插件监听；emitEvent 可等待，
      // 清理监听器的错误经此上抛给引擎结算链（写入 run 诊断，不吞成
      // 后台 notification）。
      await host.emitEvent('workflow.settled', summary, { broadcast: false })
    },
    onBackgroundAgentSettled: async (summary, info) => {
      projection.sync()
      // stop 期间不投递（notifiedAt 未置位，下次 init 按 outbox 补发）。
      if (!projection.isStopping()) await deps.deliverBackgroundReport(summary, info)
    },
    runGate: (command, gateOptions) =>
      host.runGate(command, {
        ...(gateOptions.cwd !== undefined ? { cwd: gateOptions.cwd } : {}),
        ...(gateOptions.conversationId !== undefined ? { conversationId: gateOptions.conversationId } : {}),
        ...(gateOptions.signal !== undefined ? { signal: gateOptions.signal } : {}),
        ...(gateOptions.gateTimeoutMs !== undefined ? { gateTimeoutMs: gateOptions.gateTimeoutMs } : {}),
      }),
    isHostClosing: () => host.isClosing,
  }
}
