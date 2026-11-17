/**
 * service-context.ts — WorkflowService 与各 runner 模块（service-run /
 * run-settle / run-progress / background-agent-runner / service-recovery）
 * 共享的服务内核上下文：类型定义 + caps 装配解析，零运行时行为。
 *
 * 门面（service.ts）在构造器中组装 WorkflowServiceContext 一次，各 runner
 * 经它读写共享事实（持久层 / 活跃表 / 接管保留 / 宿主端口）并回调门面私有
 * 接缝（writeRecord / emitEventSafe / makeEngineHost 等），避免 runner 反向
 * 持有门面实例形成环。
 */

import { HelmError, type ConversationSummary } from '@helm/protocol'
import type { ActiveRun } from './active-run.js'
import type { CancellationTracker } from './cancellation-tracker.js'
import type { WorkflowServiceHost } from './host-adapter.js'
import type { WorkflowLibrary } from './library-store.js'
import type { RunRecord, RunStore, WorkflowStateStore } from './run-store.js'
import type { WorkflowHost } from './runtime.js'

/** WorkflowService 构造选项（门面与 runner 共用的装配输入）。 */
export interface WorkflowServiceOptions {
  dataDir: string
  host: WorkflowServiceHost
  /** run 索引与 summary 的 SQLite doc store（主 app 注入 KernelRuntime.documentStore）。 */
  state: WorkflowStateStore
  concurrency?: number
  agentCap?: number
  itemCap?: number
  nestedCap?: number
  /**
   * 持久面值级脱敏钩子（主 app 注入 kernel.stash.redact）：所有即将写入
   * state/journal 的字符串值（args/result/error/进度预览）先经此替换。值级
   * 递归，不做 stringify 后整体替换。运行时执行始终用原始脚本与值，持久版本
   * 脱敏后不可逆——重放取回的是脱敏值，秘密必须经 env / action 输入 marker
   * 传递，不得依赖 resume 还原 secret 原文。
   */
  redact?: (text: string) => string
  /**
   * 重启自动恢复开关（缺省 true）：true 时宿主关停走 suspend() 保留 running
   * 与子会话，启动时原位恢复；false 时回退旧版 close() / failed(interrupted)。
   */
  autoRecoverOnRestart?: boolean | (() => boolean)
  /**
   * 延迟外部运行时（executionId）重挂至 runtime.started（待 herdr 等插件
   * 完成 start() 后执行），原生子会话仍于 init() 阶段即完成重挂（早于 harness.resume()）。
   */
  deferExternalReattach?: boolean
}

/** 引擎调度 caps（只含显式提供的项；正整数约束见 resolveCaps）。 */
export interface WorkflowCaps {
  concurrency?: number
  agentCap?: number
  itemCap?: number
  nestedCap?: number
}

/**
 * caps 边界校验与归一：零或负值会让 run 在首个调度点死锁，非正整数显式
 * validation_error，绝不静默锐化；未提供的项不进入结果对象。
 */
export function resolveCaps(options: WorkflowServiceOptions): WorkflowCaps {
  const capError = (field: string, value: number): HelmError =>
    new HelmError(
      'validation_error',
      `工作流 ${field} 必须是正整数（收到 ${value}；零或负值会让 run 在首个调度点死锁）`,
      400,
      { field, value },
    )
  const positiveOrThrow = (field: string, value: number | undefined): number | undefined => {
    if (value === undefined) return undefined
    if (!Number.isInteger(value) || value < 1) throw capError(field, value)
    return value
  }
  const concurrency = positiveOrThrow('concurrency', options.concurrency)
  const agentCap = positiveOrThrow('agentCap', options.agentCap)
  const itemCap = positiveOrThrow('itemCap', options.itemCap)
  const nestedCap = positiveOrThrow('nestedCap', options.nestedCap)
  return {
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(agentCap !== undefined ? { agentCap } : {}),
    ...(itemCap !== undefined ? { itemCap } : {}),
    ...(nestedCap !== undefined ? { nestedCap } : {}),
  }
}

/** runner 共享的 WorkflowService 内核事实与门面接缝（现查现用）。 */
export interface WorkflowServiceContext {
  host: WorkflowServiceHost
  /** run 索引与 summary 的 SQLite doc store。 */
  state: WorkflowStateStore
  /** run 记录 / 索引持久层。 */
  runs: RunStore
  /** 已保存工作流文件库。 */
  library: WorkflowLibrary
  /** 取消窗口（引用计数）与子树边界取消。 */
  cancellation: CancellationTracker
  /** 在途 run 的内存运行态。 */
  active: Map<string, ActiveRun>
  /**
   * 进程内接管保留（防并发双接管）：resume 已在旧 record 落接管标记、新 run
   * 快照尚未落盘的窗口内占位（语义详见 service.run）。
   */
  takeoverReservations: Set<string>
  /** 持久面值级脱敏钩子。 */
  redact: (text: string) => string
  /** 引擎调度 caps。 */
  caps: WorkflowCaps
  /** 服务停机屏障（close 后拒绝新 run / 后台结算通知跳过）。 */
  isClosed(): boolean
  /** 停机屏障断言（closed 抛 HelmError('closed', 409)）。 */
  assertNotClosed(): void
  /** 启动恢复（interrupted 标记与通知 outbox 补发；幂等缓存于 service-recovery）。 */
  init(): Promise<void>
  /** run 记录写入（活跃子会话以内存 Set 为唯一真源合入后原子落盘）。 */
  writeRecord(record: RunRecord): void
  /** workflow.updated 事件的 fire-and-forget 收口（失败只诊断不逃逸）。 */
  emitEventSafe(type: string, payload: unknown): void
  /** 引擎 WorkflowHost 组装（spawn/action/gate 适配，实现位于 host-adapter）。 */
  makeEngineHost(run: ActiveRun, parent: ConversationSummary): WorkflowHost
  /** 守卫中止 run 的子会话（human 红线由内核原子复核）。 */
  abortChildConversation(run: ActiveRun, conversationId: number): Promise<void>
  /** 当前是否开启重启自动恢复（兼顾配置与 HELM_AUTO_RECOVER 逃生阀）。 */
  isAutoRecoverOnRestart(): boolean
  /** 判定 run 是否正处于宿主关停优雅挂起路径（非用户取消）。 */
  isRunSuspending(run: ActiveRun): boolean
  /** 启动时是否把外部 executionId / pre-resolve 重挂推迟到 runtime.started。 */
  deferExternalReattach: boolean
  /** 推迟外部重挂时等待 runtime.started 放行门；非推迟模式下立即 resolved。 */
  waitExternalRuntimeReady(): Promise<void>
}
