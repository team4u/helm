/**
 * builtin:superagent —— 独立 Watchdog 组合根（两层巡检：0-Token 规则表 + L2 认知排障）。
 *
 * 本模块只做装配；策略与机制分居同级子模块：
 * - ./superagent/watchdog-core.ts: 常量、共享类型与纯辅助（含通知构造）
 * - ./superagent/watchdog-activity.ts: 会话活动统计（真实事件驱动；3 个 onEvent）
 * - ./superagent/watchdog-dedup.ts: 去重文档 CRUD 与已消亡目标淘汰（私有 ctx.doc）
 * - ./superagent/watchdog-tick.ts: singleflight 定时巡检采集（diagnostics.collect）
 * - ./superagent/watchdog-classify.ts: 规则表评估（native/external/workflow_run 分类
 *   与共同决策原语）
 * - ./superagent/watchdog-ops.ts: 五类动作执行（notify/abort/bridge/resume/wake）
 * - ./superagent/watchdog-guards.ts: 目标守卫与 turn_settled/before_turn/tool_call
 *   会话强守卫
 * - ./superagent/watchdog-tools.ts: watchdog_inspect/recover/abort 工具与同名动作、
 *   watchdog_tick 手动动作
 *
 * 巡检机制总览（原内核 watchdog 定时器 + watchdog_tick 钩子已移除）完全由
 * ctx.service 拥有：singleflight 定时 tick（默认 15s，unref）先经 ctx.host
 * 只读端口（listConversations / getConversationOwnership）与会话活动统计构造
 * 原生会话事实，再以 'diagnostics.collect' 内部事件（broadcast:false，await
 * 全部监听器）采集外部探针（如 Herdr 终端窗格），汇总后按确定性规则表执行
 * notify / bridge_to_ask / auto_abort_and_notify / wake_watchdog。
 *
 * 安全红线（执行层强约束，不依赖 SYSTEM.md）：
 * - Watchdog 自身（id 或 profileId=watchdog）绝不做探针目标；其 failed/aborted
 *   仅通知（turn_settled），防自巡检死循环；
 * - ownedBy=human 与一切外部终端窗格只读：只允许 notify / 诊断，绝无按键、
 *   恢复注入、自动中止；一切自动变更（abort / submitInput）统一走内核
 *   guarded 端口（abortConversationGuarded / submitInputGuarded）——探针
 *   ownedBy + stateChangeSeq 随调用传入，内核在第一个不可逆动作前的同一
 *   串行域内原子复核，human 红线不再依赖插件层 check-then-act；
 * - 外部窗格的中止只能经由核对 facts.parentConversationId 指向的 owned 原生
 *   工作会话后由 L2/规则对该会话 abort，由 Herdr 原取消链清理；
 * - 外部探针 facts.stalledBasis='since-last-state-change'：stalledMs 只反映
 *   状态翻转间隔，不含 working 内部活动，绝不能单独作为自动中止证据。
 */

import { HelmxError, type HelmxPluginContext } from '@helmx/protocol'
import type { WatchdogProbe } from '../diagnostics.js'
import type { SuperAgentWatchdogRuntime } from './contracts.js'
import { ConversationActivityTracker } from './watchdog-activity.js'
import { WatchdogDedupStore, type WatchdogDedupDoc } from './watchdog-dedup.js'
import { evaluateCollection } from './watchdog-classify.js'
import { WatchdogOpsExecutor } from './watchdog-ops.js'
import { WatchdogTickController } from './watchdog-tick.js'
import { registerWatchdogSessionGuards } from './watchdog-guards.js'
import { registerWatchdogTickAction, registerWatchdogTools } from './watchdog-tools.js'
import { createWatchdogNotifier, STOP_TICK_WAIT_MS } from './watchdog-core.js'

export {
  WATCHDOG_TOOL_INSPECT,
  WATCHDOG_TOOL_RECOVER,
  WATCHDOG_TOOL_ABORT,
  WATCHDOG_ALLOWED_TOOLS,
  TICK_COLLECT_TIMEOUT_MS,
} from './watchdog-core.js'
export type {
  WatchdogInspectInput,
  WatchdogRecoverInput,
  WatchdogAbortInput,
} from './watchdog-tools.js'

// ---------------------------------------------------------------------------
// 注册入口（组合根：装配各子模块并保持与拆分前一致的注册顺序）
// ---------------------------------------------------------------------------

export function registerSuperAgentWatchdog(
  ctx: HelmxPluginContext,
  runtime: SuperAgentWatchdogRuntime,
): void {
  const dedupDoc = ctx.doc<WatchdogDedupDoc>('watchdog-dedup', { version: 1, fired: {} })

  /** 最近一轮外部探针事实（内存缓存，watchdog_inspect 只读诊断用；键与去重键同构）。 */
  const lastExternalProbes = new Map<string, WatchdogProbe>()
  /** 进行中的 bridge Ask（dedup key -> askId）：service stop 取消 + 防同水位重复创建。 */
  const inFlightBridges = new Map<string, string>()
  /** 服务停止后不再发起新的自动处置（close 期间不无边界等待）。 */
  let closing = false
  const isClosing = (): boolean => closing

  const notify = createWatchdogNotifier(ctx.host, isClosing)

  // ---- 会话活动统计（真实事件驱动；停用随订阅解除，无 timer） ----------------
  const activity = new ConversationActivityTracker()
  activity.subscribe(ctx)

  // ---- 去重文档（读入严格校验：损坏显式 superagent_doc_corrupt，绝不静默回空）----
  const dedup = new WatchdogDedupStore(dedupDoc, ctx, {
    externalProbes: lastExternalProbes,
    notify,
    isClosing,
  })

  // ---- 动作执行（notify / abort / bridge / resume / wake） -------------------
  const ops = new WatchdogOpsExecutor({
    ctx,
    runtime,
    dedup,
    notify,
    isClosing,
    inFlightBridges,
  })

  // ---- 规则评估 + singleflight 定时巡检 --------------------------------------
  const tick = new WatchdogTickController({
    ctx,
    activity,
    evaluate: (collection) =>
      evaluateCollection(
        {
          runtime,
          dedup,
          externalProbes: lastExternalProbes,
          isInactive: () => closing || ctx.host.isClosing,
          executeOps: (tickAt, findings, plannedOps) => ops.executeOps(tickAt, findings, plannedOps),
        },
        collection,
      ),
    notify,
    isClosing,
  })

  // ---- 执行层强守卫：turn_settled 自监控 + before_turn 白名单 + tool_call 阻断 --
  registerWatchdogSessionGuards(ctx, runtime, { activity, notify })

  // ---- 模型工具（ctx.tool 精确短名）+ 同名 ctx.action（HTTP/CLI 复用） --------
  registerWatchdogTools(ctx, runtime, { notify, externalProbes: lastExternalProbes })

  // ---------------------------------------------------------------------------
  // ctx.service：stop 取消自有 pending Ask（close 不无边界等待；停用后不写旧 Doc）
  // ---------------------------------------------------------------------------

  ctx.service({
    id: 'superagent-watchdog',
    start() {
      closing = false
      tick.schedule()
    },
    async stop() {
      closing = true
      // 先停定时器（不再产生新 tick），再有界等在途 tick 收敛：跨插件采集
      //（diagnostics.collect 监听器）不可取消，无界等待会与慢监听方互相挂死，
      // 超时即放弃等待并继续取消自有 Ask（残留诊断如实通知，不伤主流程）。
      if (!(await tick.onStop())) {
        notify(
          'warning',
          'Watchdog 停用时在途巡检未收敛',
          `stop 等待在途 tick 超过 ${STOP_TICK_WAIT_MS}ms（外部采集监听器不可取消），已放弃等待；该轮不再产生新处置`,
        )
      }
      // 逐个 await 取消（非 allSettled 吞错）：已结算/不存在的 Ask 属事实性状态
      // 可忽略；其余失败聚合为显式错误上抛（PluginHost 聚合为 plugin_service_stop_failed）。
      const failures: Array<{ askId: string; error: unknown }> = []
      for (const askId of [...inFlightBridges.values()]) {
        try {
          await ctx.host.cancelAsk(askId, 'cancelled')
        } catch (err) {
          if (err instanceof HelmxError && (err.code === 'ask_already_settled' || err.code === 'not_found')) {
            continue // 已结算/已清理：事实性终态，非故障
          }
          failures.push({ askId, error: err })
        }
      }
      if (failures.length > 0) {
        throw new HelmxError(
          'watchdog_ask_cancel_failed',
          `Watchdog 停用前取消挂起授权问询失败：${failures.map((f) => `${f.askId}（${f.error instanceof Error ? f.error.message : String(f.error)}）`).join('；')}`,
          500,
          { failures },
        )
      }
    },
    liveTasks() {
      // 挂起的人类授权 Ask 与在途 tick 是在途任务：停用/卸载前 PluginHost 据此
      // 409 拒绝，避免吞掉待答审批或撕裂进行中的巡检；close() 路径则由 stop
      // 主动取消并等待。
      return [
        ...(tick.hasInflightTick() ? ['watchdog-tick'] : []),
        ...[...inFlightBridges.entries()].map(([key, askId]) => `bridge-ask:${askId}(${key})`),
      ]
    },
  })

  // ---- 手动 tick 动作（HTTP/CLI/Agent Tool 同权；与定时 tick 共用 singleflight）--
  registerWatchdogTickAction(ctx, runtime, () => tick.singleflightTick())
}
