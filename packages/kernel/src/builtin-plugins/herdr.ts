/**
 * builtin:herdr：agent_spawn 拦截驱动本机/远端 Herdr CLI Agent。
 *
 * 职界（设计文档 §4.2）：
 * - 「终端跑过程，文件交结果」：后台窗格 + .helm/wf-out-* 交接与原地追问自愈；
 * - blocked ↔ AskDoc 单飞审批桥（expectedStateSeq CAS 乐观锁，异步权威
 *   agent.get 现查真实 seq，绝不返回创建时快照）；
 * - $helm 状态 Token 投射（防自激环的去重心跳 + 随服务启停的有界续命）；
 * - 双轨保活清理（workflowRunId -> workflow.settled 事件；单回合 -> 父 turn_settled）；
 * - 启动对账回收 helm-wf-* 孤儿窗格（仅确认自有资源；failed 保留现场；
 *   真正仍 working/blocked 的保留并报告，绝不伪装结束；keepalive 孤儿可回收；
 *   精确 agent.name === 记录归属验证，身份不符放弃所有权）；
 * - ctx.action list/read/focus（HTTP/CLI 同权 --json；read 40 行脱敏；
 *   focus 为用户显式操作；read/focus 支持 nodeId 消歧，歧义显式 409）。
 *
 * 连接纪律（一次启用一个冻结连接配置）：
 * - 启用时解析 config.session/socketPath 为冻结 HerdrTarget，所有命令、事件、
 *   文件、清理（含远端 pane）统一走同一目标；停用后不再触达任何服务器；
 * - 不热换连接（防误关另一服务器同 ID 人类窗格）；配置变更在下次启用生效。
 *
 * 服务生命周期：service.start 才连接（subscribe ack -> snapshot 对账），
 * 半途失败自行清理已获取资源；stop 清理订阅/定时器/Asks 与可回收自有 pane。
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HelmError, type PluginDefinition, type WorkflowRunSummary } from '@helm/protocol'
import {
  DIAGNOSTICS_COLLECT_EVENT,
  appendProbes,
  parseCollection,
} from './diagnostics.js'
import { createHerdrTransport } from './herdr/transport.js'
import { targetNodeId, type HerdrConfig, type HerdrEvent, type HerdrPluginDependencies, type HerdrTarget, type HerdrTransport } from './herdr/contracts.js'
import { AskCoordinator, type AskEntry } from './herdr/asks.js'
import { MetadataProjector } from './herdr/metadata.js'
import { PaneRegistry, EMPTY_MANAGED_DOC, nodeIdOf, scopeKey, type ManagedDoc, type ManagedPane } from './herdr/panes.js'
import { HerdrExecutor } from './herdr/executor.js'
import {
  assertOkResult,
  isOkResult,
  parseAgentResult,
  parsePaneRead,
  parseSessionSnapshot,
} from './herdr/rpc.js'
import { isValidSessionName, isValidNodeId, resolveSocketPath } from './herdr/transport.js'
import { normalizeStartupTimeoutMs } from './herdr/spawn-rules.js'
import { assembleHerdrDepsFromHost, nodeChannelFromHost } from './herdr/host-ports.js'
import { HERDR_STEER_CONTROLS } from './herdr/contracts.js'
import { isAncestorOrSelf } from './lineage.js'
import { OverviewProjector, type OverviewDoc } from './herdr/overview.js'

/**
 * clientRoot 兼容 src / dist 运行路径（与 workflow 插件同机制）：
 * 编译后 dist/builtin-plugins/herdr.js 同级无 client/（tsx 源目录有）；
 * 探测失败回退包内 src 源目录，仍失败显式抛错（不静默降级）。
 */
function resolveHerdrClientRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const local = join(here, 'herdr', 'client')
  if (existsSync(local)) return local
  const pkgRoot = dirname(dirname(here))
  const srcFallback = join(pkgRoot, 'src', 'builtin-plugins', 'herdr', 'client')
  if (existsSync(srcFallback)) return srcFallback
  throw new HelmError(
    'herdr_plugin_client_missing',
    `内置插件 builtin:herdr 找不到 client 组件目录（期望 ${local} 或 ${srcFallback}）`,
    500,
  )
}

/** Herdr 23 种 CLI agent.start kind（detect::agent_label 全集）；供 ProfileRuntimeUiSpec 候选。 */
const HERDR_AGENT_SUGGESTIONS: ReadonlyArray<string> = [
  'pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline',
  'omp', 'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid',
  'amp', 'grok', 'hermes', 'kilo', 'qodercli', 'qwen', 'maki', 'muse',
]

export function createHerdrPlugin(): PluginDefinition {
  return {
    id: 'builtin:herdr',
    name: 'Herdr 终端',
    description: '跨节点 Herdr 协同：驱动远端 CLI 工具执行、终端审批桥（AskDoc CAS）与状态栏投射。',
    icon: 'terminal',
    version: '0.1.0',
    clientRoot: resolveHerdrClientRoot(),
    definePlugin(ctx) {
      // ---- 宿主公共端口组装（零参工厂：全部依赖来自 ctx.host）----
      // definePlugin 阶段仅持有宿主引用（停用注册/定义收集不触网）；
      // 依赖在 service.start 启用时组装（周期内冻结，热重接线不生效）。
      const hostApi = ctx.host
      // ---- 状态（每次启用周期重建） ----
      /** 本周期内部依赖与生产 transport（start 时组装；早期回调先于 start 时组装）。 */
      const depsRef: { current?: HerdrPluginDependencies } = {}
      const transportRef: { current?: HerdrTransport } = {}
      function resolveDeps(): HerdrPluginDependencies {
        const nodeChannel = nodeChannelFromHost(hostApi)
        transportRef.current ??= createHerdrTransport({ redact: (text) => hostApi.redact(text), nodeChannel })
        depsRef.current = assembleHerdrDepsFromHost(hostApi, { transport: transportRef.current })
        return depsRef.current
      }
      const depsOf = (): HerdrPluginDependencies => depsRef.current ?? resolveDeps()
      const transportOf = (): HerdrTransport => {
        if (transportRef.current === undefined) depsOf()
        return transportRef.current!
      }
      const asks = new AskCoordinator(() => refreshOverview())
      const registryRef: { current?: PaneRegistry } = {}
      const projectorRef: { current?: MetadataProjector } = {}
      const executorRef: { current?: HerdrExecutor } = {}
      const unsubscribeRef: { current?: () => void } = {}
      const overviewRef: { current?: OverviewProjector } = {}
      /** 事件回调在途任务：stop 必须等待，防停用后 doc 写入与回调污染新周期。 */
      const eventTasks = new Set<Promise<void>>()
      let connectionAbort = new AbortController()
      let subscriptionTail: Promise<void> = Promise.resolve()
      let subscribedPaneKey: string | undefined
      /** 本启用周期冻结的本机连接目标（所有本机调用/事件/清理共用）。 */
      let frozenLocalTarget: HerdrTarget = {}
      let overviewDoc: ReturnType<typeof ctx.doc<OverviewDoc>>
      let managedDoc: ReturnType<typeof ctx.doc<ManagedDoc>>
      let asksRelease: (() => void) | undefined
      let workflowRelease: (() => void) | undefined

      /** 最近一次 socket 事件处理的 pane seq 缓存（事件去重，agent.get 为权威）。 */
      const eventSeqCache = new Map<string, number>()
      /**
       * 探针观察水位（本启用周期；scopeKey(nodeId, paneId) 键）：
       * stalledMs 口径 = 「最近一次观察到 (status, seq) 变化的时点」至今的时长——
       * 首次观测从 0 起，水位或状态变化重置；探测失败（unreachable）不变更
       * 水位（读失败不是进展证据，停滞继续累计）。注意该口径只反映状态变迁，
       * 不含工作活动（长时间无状态翻转的活跃任务会如实表现为停滞递增）。
       */
      const probeObservations = new Map<string, { status: string; seq: number | undefined; since: number }>()
      /** 连续探测失败计数（agent.get 成功即清零；仅诊断事实，不触发自动动作）。 */
      const probeFailures = new Map<string, number>()
      /** 停用中：doc 句柄已失效，overview 刷新静默跳过（KISS：无写入即无异常）。 */
      let stopping = false

      const host = {
        parentCwdOf(id: number): string | undefined {
          // getConversation 错误如实传播（不存在即显式失败，绝不吞）。
          return ctx.host.getConversation(id).cwd
        },
        parentNodeIdOf(id: number): string | undefined {
          // 父会话绑定节点（Conversation.nodeId；undefined = 本机）。错误同上如实传播。
          return ctx.host.getConversation(id).nodeId
        },
        askConversationId(id: number): number {
          return id
        },
        notify(title: string, body: string, level: 'info' | 'error'): void {
          ctx.host.emitEvent('notification', { type: 'notification', level, title: depsOf().redact(title), body: depsOf().redact(body) })
        },
        createAsk(spec: Parameters<typeof ctx.host.createAsk>[0]) {
          return ctx.host.createAsk(spec)
        },
        cancelAsk(askId: string, reason: 'cancelled' | 'superseded') {
          return ctx.host.cancelAsk(askId, reason)
        },
      }

      function projector(): MetadataProjector {
        if (projectorRef.current === undefined) {
          projectorRef.current = new MetadataProjector(
            (target, method, params) => {
              const pane = registryRef.current?.get(targetNodeId(target), String(params['pane_id']))
              return transportOf().call(pane?.target ?? frozenLocalTarget, method, params, { timeoutMs: 5_000 })
            },
            (paneId, error) => {
              host.notify(
                'Herdr 状态投射失败',
                `pane ${paneId} report_metadata 失败：${error instanceof Error ? depsOf().redact(error.message) : String(error)}`,
                'error',
              )
            },
          )
        }
        return projectorRef.current
      }

      function refreshOverview(): void {
        if (stopping) return
        const overview = overviewRef.current
        const registry = registryRef.current
        if (overview && registry) overview.republish(registry, asks)
      }

      function trackPaneEvent(event: HerdrEvent): void {
        if (stopping) return
        const task = onPaneEvent(event).catch((error) => {
          if (stopping) return
          host.notify(
            'Herdr 事件处理失败',
            `${event.type} ${'workspaceId' in event ? event.workspaceId : event.paneId}：${error instanceof Error ? depsOf().redact(error.message) : String(error)}`,
            'error',
          )
        })
        eventTasks.add(task)
        void task.then(() => eventTasks.delete(task), () => eventTasks.delete(task))
      }

      /**
       * 订阅断线自愈重连：单例定时器 + 指数退避（封顶 60s），成功重建后复位；
       * stopResources 清理。去重靠 synchronizeSubscription 自身的队列串行
       * （重复 schedule 仅保留最新到期时间），不叠加并发重连风暴。
       */
      let subscriptionRetryTimer: NodeJS.Timeout | undefined
      let subscriptionRetryAttempt = 0

      function scheduleSubscriptionRetry(): void {
        if (stopping || connectionAbort.signal.aborted) return
        if (subscriptionRetryTimer !== undefined) return
        const attempt = subscriptionRetryAttempt++
        const delayMs = Math.min(1_000 * 2 ** Math.min(attempt, 6), 60_000)
        subscriptionRetryTimer = setTimeout(() => {
          subscriptionRetryTimer = undefined
          if (stopping || connectionAbort.signal.aborted) return
          void synchronizeSubscription(lastSubscribedPaneIds(), connectionAbort.signal)
            .then((rebuilt) => { if (rebuilt) subscriptionRetryAttempt = 0 })
            .catch(() => {
              // 重建失败：退避后继续重试（下次 onError 或本轮兜底）。
              scheduleSubscriptionRetry()
            })
        }, delayMs)
        subscriptionRetryTimer.unref?.()
      }

      function clearSubscriptionRetry(): void {
        if (subscriptionRetryTimer !== undefined) {
          clearTimeout(subscriptionRetryTimer)
          subscriptionRetryTimer = undefined
        }
        subscriptionRetryAttempt = 0
      }

      /** 当前订阅应覆盖的 pane 集合：以 registry 在管未结算窗格为准（重建用）。 */
      function lastSubscribedPaneIds(): string[] {
        const registry = registryRef.current
        if (!registry) return []
        return registry
          .all()
          .filter((pane) => pane.outcome !== 'settled' && nodeIdOf(pane) === undefined)
          .map((pane) => pane.paneId)
      }

      function synchronizeSubscription(paneIds: string[], signal: AbortSignal): Promise<boolean> {
        const ids = [...new Set(paneIds)].sort()
        const key = JSON.stringify(ids)
        const task = subscriptionTail.then(async () => {
          if (stopping || signal.aborted || connectionAbort.signal.aborted) return false
          if (subscribedPaneKey === key && unsubscribeRef.current) return false
          let retired = false
          let failure: { error: unknown } | undefined
          let rawRelease: (() => void) | undefined
          const release = () => {
            retired = true
            rawRelease?.()
            rawRelease = undefined
          }
          rawRelease = await transportOf().subscribe(
            frozenLocalTarget,
            trackPaneEvent,
            (error) => {
              if (stopping || retired) return
              failure = { error }
              if (unsubscribeRef.current === release) subscribedPaneKey = undefined
              overviewRef.current?.markSubscriptionFailed(error)
              host.notify('Herdr 事件订阅断开', error instanceof Error ? error.message : String(error), 'error')
              // 断线自愈：即使 watchdogEnabled=false 也安排退避重连（去重单例）。
              scheduleSubscriptionRetry()
            },
            { paneIds: ids, signal: connectionAbort.signal },
          )
          if (stopping || signal.aborted || connectionAbort.signal.aborted) {
            release()
            return false
          }
          if (failure) {
            release()
            throw failure.error
          }
          // 先确认新流 ACK，再释放旧流，避免切换逐窗格过滤时漏掉状态事件。
          const previous = unsubscribeRef.current
          unsubscribeRef.current = release
          subscribedPaneKey = key
          previous?.()
          overviewRef.current?.markSubscriptionReady()
          subscriptionRetryAttempt = 0
          return true
        })
        // 保持队列可继续；原 task 的错误由启动路径或总览刷新路径诊断。
        subscriptionTail = task.then(() => {}, () => {})
        // 启动/重建失败（subscribe 招错，非 onError 路径）同样安排退避重连。
        task.catch(() => scheduleSubscriptionRetry())
        return task
      }

      // ---- socket 事件路径：总览全量重取；Ask 协调仅限本插件自有 pane ----
      async function onPaneEvent(event: HerdrEvent): Promise<void> {
        if (stopping) return
        const overview = overviewRef.current
        const registry = registryRef.current
        let refresh: Promise<void> | undefined
        if (overview && registry) {
          if (event.type === 'pane.closed' || event.type === 'pane.exited') overview.evictPane(event.paneId)
          refresh = overview.refresh(registry, asks, frozenLocalTarget)
        }
        try {
          if (event.type === 'pane.created' || event.type === 'pane.focused' || event.type === 'pane.moved' ||
              event.type === 'tab.closed' || event.type === 'workspace.closed') return
          if (!registry) return
          const pane = registry.get(undefined, event.paneId)
          if (pane === undefined || JSON.stringify(pane.target) !== JSON.stringify(frozenLocalTarget)) return
          if (event.type === 'pane.closed' || event.type === 'pane.exited') {
            for (const removed of asks.paneClosed(pane.paneId, nodeIdOf(pane))) {
              await cancelQuietly(removed, 'superseded')
            }
            if (stopping) return
            projector().forget(pane.paneId, nodeIdOf(pane))
            // 外部结算路径同步释放 executor 侧机密 env/未启动标记：后续
            // closePane 会因 settled 幂等早退，不在此对齐则每关一个在途窗格
            // 就驻留一份 HELM_TOKEN 直到停用重建。
            executorRef.current?.releasePaneState(pane)
            if (pane.outcome !== 'failed' && pane.outcome !== 'settled') {
              registry.update(nodeIdOf(pane), pane.paneId, { outcome: 'settled', settledAt: Date.now() })
            }
            forgetPaneCaches(nodeIdOf(pane), pane.paneId)
            refreshOverview()
            return
          }
          const info = parseAgentResult(
            await transportOf().call(frozenLocalTarget, 'agent.get', { target: pane.paneId }, {
              signal: connectionAbort.signal,
              timeoutMs: 5_000,
            }),
            'agent.get',
            'agent_info',
          )
          if (stopping || info.name !== pane.agentName || info.tabId !== pane.tabId) return
          for (const superseded of asks.observeAuthority({
            paneId: pane.paneId,
            nodeId: nodeIdOf(pane),
            seq: info.stateChangeSeq,
            status: info.agentStatus,
          })) {
            await cancelQuietly(superseded, 'superseded')
          }
          if (stopping) return
          const cacheKey = `local:${pane.paneId}`
          if ((eventSeqCache.get(cacheKey) ?? 0) >= info.stateChangeSeq) return
          eventSeqCache.set(cacheKey, info.stateChangeSeq)
          // 仅在执行循环在途时预登记 blocked 墓位（供其 beginBlocked 复用去重）：
          // 执行循环已越过该 seq 或 spawn 已结束时登记会成永不消费的幽灵
          // creating 条目（overview pendingAsk 虚标）；非 running 窗格绝不登记。
          if (info.agentStatus === 'blocked' && pane.outcome === 'running') {
            asks.beginBlocked(nodeIdOf(pane), pane.paneId, info.stateChangeSeq)
          }
        } finally {
          await refresh
        }
      }

      async function cancelQuietly(entry: AskEntry, reason: 'cancelled' | 'superseded'): Promise<void> {
        try {
          await ctx.host.cancelAsk(entry.askId, reason)
        } catch (error) {
          if (error instanceof HelmError && error.status === 404) return
          host.notify(
            'Herdr 审批销单失败',
            `ask ${entry.askId} cancel 失败：${error instanceof Error ? depsOf().redact(error.message) : String(error)}`,
            'error',
          )
        }
      }

      // ---- 启动对账：subscribe ack -> snapshot 扫描 ----
      /** 窗格从 registry 结算移除时同步回收探针/事件缓存（防长驻泄漏）。 */
      function forgetPaneCaches(nodeId: string | undefined, paneId: string): void {
        const scope = scopeKey(nodeId, paneId)
        eventSeqCache.delete(`${nodeId ?? 'local'}:${paneId}`)
        probeObservations.delete(scope)
        probeFailures.delete(scope)
      }

      async function reconcile(): Promise<void> {
        const registry = registryRef.current!
        const snapshots = new Map<string, ReturnType<typeof parseSessionSnapshot>>([
          [JSON.stringify(frozenLocalTarget), parseSessionSnapshot(await transportOf().call(frozenLocalTarget, 'session.snapshot', {}, { timeoutMs: 5_000 }))],
        ])
        for (const pane of registry.all()) {
          if (pane.outcome === 'settled') continue
          const key = JSON.stringify(pane.target)
          if (!snapshots.has(key)) snapshots.set(key, parseSessionSnapshot(await transportOf().call(pane.target, 'session.snapshot', {}, { timeoutMs: 5_000 })))
          const agent = snapshots.get(key)!.agents.find((a) => a.paneId === pane.paneId)
          if (pane.outcome === 'failed') continue // 持久 failed：保留诊断现场
          if (agent === undefined) {
            // 窗格已消失：登记 settled（无资源可回收）+ executor 侧对齐。
            registry.update(nodeIdOf(pane), pane.paneId, { outcome: 'settled', settledAt: Date.now() })
            executorRef.current?.releasePaneState(pane)
            forgetPaneCaches(nodeIdOf(pane), pane.paneId)
            continue
          }
          // 精确归属验证：agent.name 必须等于记录的 agentName（不 startsWith——
          // helm-wf-abc 不能认领 helm-wf-abcde）。身份不符放弃所有权，不误关。
          if (agent.name !== pane.agentName) {
            registry.update(nodeIdOf(pane), pane.paneId, { outcome: 'settled', settledAt: Date.now() })
            executorRef.current?.releasePaneState(pane)
            forgetPaneCaches(nodeIdOf(pane), pane.paneId)
            continue
          }
          // 真正仍在 working/blocked：保留并报告（绝不伪装结束自动回收）。
          if (agent.agentStatus === 'working' || agent.agentStatus === 'blocked' || agent.agentStatus === 'unknown') {
            host.notify(
              'Herdr 启动对账发现在途窗格',
              `pane ${pane.paneId}（${pane.agentName}）仍处于 ${agent.agentStatus}，保留待 ${pane.workflowRunId !== undefined ? 'workflow' : '父回合'}结算或人工处理`,
              'info',
            )
            continue
          }
          // 已结束（idle/done/unknown）且无在途 spawn（进程重启）：孤儿可回收。
          if (pane.outcome === 'running' || pane.outcome === 'keepalive') {
            await executorRef.current!.closePane(pane, 'settled').catch((error) => {
              host.notify(
                'Herdr 孤儿回收失败',
                `pane ${pane.paneId} 对账回收失败：${error instanceof Error ? depsOf().redact(error.message) : String(error)}`,
                'error',
              )
            })
          }
        }
      }

      // ---- 双轨清理 ----
      // 逐项隔离：单个 closePane 抛错（其内部已如实通知）不得中止同批其余
      // keepalive 窗格的清理（事件一次性，错过即永久滞留）；executorRef 在
      // stopResources 置空窗口内可能为 undefined，跳过而非 TypeError。
      async function settleWorkflow(run: WorkflowRunSummary): Promise<void> {
        const registry = registryRef.current
        const executor = executorRef.current
        if (!registry || !executor) return
        for (const pane of registry.findByWorkflow(run.id)) {
          if (pane.outcome === 'failed') continue
          try {
            await executor.closePane(pane, 'workflow-settled')
          } catch (error) {
            host.notify('Herdr workflow 清理中断项', `pane ${pane.paneId}（workflow ${run.id}）清理失败已跳过：${error instanceof Error ? depsOf().redact(error.message) : String(error)}`, 'error')
          }
        }
        registry.prune()
      }

      async function settleParentTurn(conversationId: number): Promise<void> {
        const registry = registryRef.current
        const executor = executorRef.current
        if (!registry || !executor) return
        for (const pane of registry.findByParent(conversationId)) {
          if (pane.workflowRunId !== undefined) continue // workflow 轨道
          if (pane.outcome === 'failed') continue
          if (pane.outcome === 'running') continue // 同回合仍在途（并发 spawn）
          try {
            await executor.closePane(pane, 'turn-settled')
          } catch (error) {
            host.notify('Herdr 回合清理中断项', `pane ${pane.paneId}（父会话 ${conversationId}）清理失败已跳过：${error instanceof Error ? depsOf().redact(error.message) : String(error)}`, 'error')
          }
        }
        registry.prune()
      }

      // ---- 文档与 UI ----
      managedDoc = ctx.doc<ManagedDoc>('managed', EMPTY_MANAGED_DOC)
      overviewDoc = ctx.doc<OverviewDoc>(
        'overview',
        { version: 2, updatedAt: 0, stale: true, panes: [], asks: [] },
        { public: true },
      )

      ctx.ui.sidebarItem({
        id: 'herdr',
        label: 'Herdr 终端',
        icon: 'terminal',
        target: 'screen:builtin:herdr/overview',
        order: 40,
      })
      ctx.ui.screen({
        id: 'overview',
        label: 'Herdr 终端总览',
        icon: 'terminal',
        client: { module: 'index.tsx', export: 'HerdrOverviewScreen' },
      })
      ctx.ui.profileRuntime({
        id: 'herdr',
        kind: 'herdr',
        label: '外部 Herdr 运行时',
        icon: 'terminal',
        description: '（可选）作为 subagent 时绑定 Herdr CLI',
        agentSuggestions: [...HERDR_AGENT_SUGGESTIONS],
      })

      // ---- hooks ----
      ctx.hook.onAgentSpawn(async (request) => {
        const executor = executorRef.current
        if (executor === undefined) return { action: 'continue' }
        try {
          const outcome = await executor.handle(request)
          if (outcome.action === 'continue') return { action: 'continue' }
          const registry = registryRef.current
          if (!stopping && registry) await overviewRef.current?.refresh(registry, asks, frozenLocalTarget)
          return { action: 'handled', result: outcome.result }
        } finally {
          refreshOverview()
        }
      }, { priority: 100 })

      ctx.hook.onTurnSettled(async (payload) => {
        await settleParentTurn(payload.conversation.id)
      })

      // diagnostics.collect 监听（原 watchdog_tick priority 100 钩子改道）：
      // 巡检发起方（builtin:superagent Watchdog service）采集原生事实后经宿主
      // 内部事件追加本插件自有窗格的真实 probes（含远端轮询）。事件在宿主
      // await，采集失败如实上抛给发起方，绝不静默吞。
      // human 归属红线：非自有 pane 一律不产生 probe；总览重取为只读采集。
      ctx.host.onEvent(DIAGNOSTICS_COLLECT_EVENT, async (raw) => {
        // 事件入口边界校验：非法载荷显式抛错给发布方（await 语义），不猜不吞。
        const collection = parseCollection(raw)
        const registry = registryRef.current
        if (!registry) return
        const overview = overviewRef.current
        if (overview !== undefined) {
          // cwd/seen 等无事件变化（官方 actions.rs:1780 只改 cwd 不发事件）
          // 依赖本 tick 重取快照对齐；单飞合并，不新增独立定时器。
          await overview.refresh(registry, asks, frozenLocalTarget)
        }
        const now = Date.now()
        const activePanes = registry.all().filter((pane) => pane.outcome !== 'settled')
        // 并发探针：单窗格 agent.get 带 5s 短超时且 Promise.all 并发采集，
        // 防止单个慢/挂节点串行卡死采集预算。
        const probes = await Promise.all(
          activePanes.map(async (pane): Promise<ReturnType<typeof buildProbe> | undefined> => {
            const scope = scopeKey(nodeIdOf(pane), pane.paneId)
            let status = 'unknown'
            let authoritySeq: number | undefined
            try {
              const info = parseAgentResult(
                await transportOf().call(
                  pane.target,
                  'agent.get',
                  { target: pane.paneId },
                  { signal: connectionAbort.signal, timeoutMs: 5_000 },
                ),
                'agent.get',
                'agent_info',
              )
              if (info.name !== pane.agentName || info.tabId !== pane.tabId) {
                registry.update(nodeIdOf(pane), pane.paneId, { outcome: 'settled', settledAt: Date.now() })
                executorRef.current?.releasePaneState(pane)
                forgetPaneCaches(nodeIdOf(pane), pane.paneId)
                return undefined
              }
              for (const superseded of asks.observeAuthority({
                paneId: pane.paneId,
                nodeId: nodeIdOf(pane),
                seq: info.stateChangeSeq,
                status: info.agentStatus,
              })) {
                await cancelQuietly(superseded, 'superseded')
              }
              status = info.agentStatus
              authoritySeq = info.stateChangeSeq
              probeFailures.delete(scope)
            } catch {
              status = 'unreachable'
              // 权威不可达：绝不猜造 seq；水位不变更（停滞继续累计），
              // 连续失败计数如实递增。
              probeFailures.set(scope, (probeFailures.get(scope) ?? 0) + 1)
            }
            return buildProbe(pane, status, authoritySeq, now)
          }),
        )
        appendProbes(collection, probes.filter((probe) => probe !== undefined))
      })

      /** 单窗格探针构造（停滞水位维护与 facts 口径；采集事件主体）。 */
      function buildProbe(
        pane: ManagedPane,
        status: string,
        authoritySeq: number | undefined,
        now: number,
      ) {
        const scope = scopeKey(nodeIdOf(pane), pane.paneId)
        // 停滞水位：首次观测从 0 起；(status, seq) 任一变化重置；
        // unreachable 保持旧水位累计（读失败不是进展证据，不用总运行时长
        // 冒充停滞，也不因探测失败归零重跑）。
        const prev = probeObservations.get(scope)
        let stalledMs = 0
        if (status === 'unreachable') {
          // 读失败：沿用旧观测点继续累计（无旧观测时从当下起算，不伪造进展）。
          if (prev !== undefined) {
            stalledMs = now - prev.since
          } else {
            probeObservations.set(scope, { status, seq: undefined, since: now })
          }
        } else if (prev === undefined || prev.status !== status || prev.seq !== authoritySeq) {
          probeObservations.set(scope, { status, seq: authoritySeq, since: now })
        } else {
          stalledMs = now - prev.since
        }
        const pendingAskCount = asks
          .entries()
          .filter(
            (e) =>
              e.paneId === pane.paneId &&
              e.nodeId === nodeIdOf(pane) &&
              (e.phase === 'pending' || e.phase === 'creating'),
          ).length
        return {
          targetId: pane.paneId,
          targetKind: 'external' as const,
          nodeId: nodeIdOf(pane) ?? 'local',
          ownedBy: 'helm' as const,
          status,
          ...(authoritySeq !== undefined ? { stateChangeSeq: authoritySeq } : {}),
          stalledMs,
          ...(status === 'unreachable' ? { consecutiveErrors: probeFailures.get(scope) ?? 1 } : {}),
          facts: {
            kind: 'herdr',
            agentName: pane.agentName,
            outcome: pane.outcome,
            effectiveCwd: pane.effectiveCwd,
            parentConversationId: pane.parentConversationId,
            pendingAskCount,
            // 口径如实：stalledMs 基于状态/水位变化观察时点，不含工作活动。
            stalledBasis: 'since-last-state-change',
          },
        }
      }

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
          const registry = registryRef.current
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

      /** pane 消歧解析：registry 命中多个节点同 ID pane 时显式 409。 */
      function resolvePane(input: { paneId: string; nodeId?: string }): ManagedPane {
        const registry = registryRef.current
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
          const pane = resolvePane(input)
          const read = parsePaneRead(
            await transportOf().call(pane.target, 'agent.read', {
              target: pane.paneId,
              source: 'recent_unwrapped',
              lines: 40,
              format: 'text',
            }),
          )
          return { paneId: pane.paneId, nodeId: nodeIdOf(pane) ?? 'local', text: depsOf().redact(read.text) }
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
          const pane = resolvePane(input)
          // 真实协议（服务端源码 agents.rs:35-41）：agent.focus 返回
          // ResponseResult::AgentInfo { agent }（agent_info），非 ok。
          const info = parseAgentResult(
            await transportOf().call(pane.target, 'agent.focus', { target: pane.paneId }),
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
      ctx.action<
        { executionId: string; nodeId: string; workflowRunId: string; parentConversationId: number; text: string },
        { steered: true; executionId: string; nodeId: string; stateChangeSeq: number; ownership: 'helm'; guardLevel: 'preflight' }
      >({
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
          const registry = registryRef.current
          const executor = executorRef.current
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
            const parentOf = (id: number): number | undefined => {
              try {
                return hostApi.getConversation(id).parentConversationId
              } catch (error) {
                if (error instanceof HelmError && error.code === 'not_found') return undefined
                throw error
              }
            }
            if (!isAncestorOrSelf(input.parentConversationId, caller, parentOf)) {
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

      // ---- config schema（启用前可配置；变更在下次启用生效） ----
      ctx.configSchema({
        session: { type: 'string', label: 'Herdr 会话名', description: '本机 herdr sessions/<name> 子目录', default: '' },
        socketPath: { type: 'string', label: 'Socket 路径覆盖', description: '缺省用 HERDR_SOCKET_PATH 或默认会话路径', default: '' },
        startupTimeoutMs: {
          type: 'number',
          label: 'agent 启动超时（毫秒）',
          description: '3001..300000，默认 30000',
          default: 30000,
        },
      })

      // ---- service：start 连接（ack 先于对账），stop 清理全部 ----
      ctx.service({
        id: 'herdr-connection',
        liveTasks() {
          return registryRef.current ? registryRef.current.liveTaskLabels() : []
        },
        async start() {
          stopping = false
          connectionAbort = new AbortController()
          const config = ctx.getConfig() as Partial<HerdrConfig>
          // 端口组装（周期内冻结；缺端口能力由宿主端口自身显式报错）。
          resolveDeps()
          const deps = depsRef.current!
          // 冻结本启用周期的本机连接目标（此后所有调用共用；热配置不再生效）。
          frozenLocalTarget = resolveLocalTarget(config)
          const startupTimeout = normalizeStartupTimeoutMs(config.startupTimeoutMs)
          const restored = managedDoc.get()
          const registry = new PaneRegistry(
            { get: () => managedDoc.get(), set: (doc) => managedDoc.set(doc) },
            restored,
          )
          registryRef.current = registry
          const executor = new HerdrExecutor(
            deps,
            registry,
            asks,
            projector(),
            {
              parentCwdOf: host.parentCwdOf,
              parentNodeIdOf: host.parentNodeIdOf,
              askConversationId: host.askConversationId,
              notify: host.notify,
              startupTimeoutMs: () => startupTimeout,
              createAsk: host.createAsk,
              cancelAsk: host.cancelAsk,
            },
            deps.transport!,
            frozenLocalTarget,
            deps.pollIntervalMs,
          )
          executorRef.current = executor
          overviewRef.current = new OverviewProjector(
            { redact: deps.redact, notify: host.notify },
            (doc) => { if (!stopping) overviewDoc.set(doc) },
            async (target, signal) => {
              const snapshot = () => transportOf().call(target, 'session.snapshot', {}, {
                signal,
                timeoutMs: 5_000,
              }).then(parseSessionSnapshot)
              let current = await snapshot()
              // 新过滤流 ACK 后重读，覆盖首次快照与逐窗格订阅建立之间的状态变化。
              while (await synchronizeSubscription(current.panes.map((pane) => pane.paneId), signal)) {
                current = await snapshot()
              }
              return current
            },
            () => !stopping && overviewRef.current !== undefined,
          )
          // Ask CAS seq 解析器：异步权威 agent.get 现查目标 pane 当前真实 seq
          //（先于任何 createAsk；归属经 askId 三段校验）。
          asksRelease = ctx.host.registerAskSeqResolver((askId) =>
            asks.seqResolver(askId, async (nodeId, paneId) => {
              const pane = registry.get(nodeId, paneId)
              if (pane === undefined) return undefined
              try {
                const info = parseAgentResult(
                  await transportOf().call(pane.target, 'agent.get', { target: paneId }, { timeoutMs: 5_000 }),
                  'agent.get',
                  'agent_info',
                )
                if (info.name !== pane.agentName) return undefined
                return info.stateChangeSeq
              } catch {
                // 权威不可达：undefined（AskService 以 ask_state_unavailable 拒答，
                // 绝不把坏数据当 CAS 权威）。
                return undefined
              }
            }),
          )
          workflowRelease = ctx.host.onEvent('workflow.settled', (raw) => settleWorkflow(raw as WorkflowRunSummary))

          try {
            // subscribe ack 先行；任一步失败都释放解析器、监听与已获取资源。
            await synchronizeSubscription([], connectionAbort.signal)
            await reconcile()
            // 对账后回收结算记录（doc 句柄有效；停用路径禁 flush 故不在此后回收）。
            registry.prune()
            projector().start()
            const registry0 = registryRef.current
            if (registry0 !== undefined) await overviewRef.current?.refresh(registry0, asks, frozenLocalTarget)
          } catch (error) {
            await stopResources()
            throw error
          }
        },
        async stop() {
          await stopResources()
        },
      })

      /** 启用时解析并固定本机 socket 路径，显式路径优先于继承环境与 session。 */
      function resolveLocalTarget(config: Partial<HerdrConfig>): HerdrTarget {
        const session = typeof config.session === 'string' && config.session !== '' ? config.session : undefined
        const socketPath = typeof config.socketPath === 'string' && config.socketPath !== '' ? config.socketPath : undefined
        if (session !== undefined && !isValidSessionName(session)) {
          throw new HelmError('validation_error', `Herdr session 名 '${session}' 非法（字母数字开头，可含 - _，≤64 字符）`, 400, {
            session,
          })
        }
        // 显式 socket 优先；将继承环境和 session 路径在启用时固化。
        return { socketPath: resolveSocketPath({ ...(session !== undefined ? { session } : {}), ...(socketPath !== undefined ? { socketPath } : {}) }) }
      }

      /** 服务资源清理：订阅/解析器/监听 + 可回收自有 pane（failed 保留现场）。 */
      async function stopResources(): Promise<void> {
        const errors: unknown[] = []
        stopping = true
        connectionAbort.abort()
        clearSubscriptionRetry()
        projector().stop()
        try {
          unsubscribeRef.current?.()
        } catch (err) {
          errors.push(err)
        }
        unsubscribeRef.current = undefined
        subscribedPaneKey = undefined
        try {
          await overviewRef.current?.close()
        } catch (err) {
          errors.push(err)
        }
        await subscriptionTail
        if (eventTasks.size > 0) {
          const outcomes = await Promise.allSettled([...eventTasks])
          for (const outcome of outcomes) if (outcome.status === 'rejected') errors.push(outcome.reason)
          eventTasks.clear()
        }
        try {
          asksRelease?.()
        } catch (err) {
          errors.push(err)
        }
        asksRelease = undefined
        try {
          workflowRelease?.()
        } catch (err) {
          errors.push(err)
        }
        workflowRelease = undefined
        // 销单全部 pending Ask；取消失败如实记录（不空吞）。dispose 路径宿主
        // 可能已先行销毁（plugin_host_disposed 409 属预期终态，不再计为失败——
        // AskService 自身的进程级清理负责收尾，协调器条目已全部兜底结算）。
        for (const entry of asks.entries()) {
          if (entry.phase === 'pending' || entry.phase === 'creating') {
            try {
              await ctx.host.cancelAsk(entry.askId, 'cancelled')
            } catch (err) {
              const expected =
                err instanceof HelmError && (err.status === 404 || err.code === 'plugin_host_disposed' || err.code === 'plugin_context_expired')
              if (!expected) errors.push(err)
            }
          }
        }
        asks.settleAllAsSuperseded()
        const registry = registryRef.current
        if (registry) {
          for (const pane of registry.all()) {
            if (pane.outcome === 'failed' || pane.outcome === 'settled') continue
            // 远端可回收 pane 同样清理（closePane 幂等、仅关自有资源；
            // 冻结 target 保证触达的是创建它的那台服务器）。
            try {
              await executorRef.current?.closePane(pane, 'settled', { volatileMark: true })
            } catch (err) {
              errors.push(err)
            }
          }
        }
        registryRef.current = undefined
        executorRef.current = undefined
        projectorRef.current = undefined
        overviewRef.current = undefined
        eventSeqCache.clear()
        // 探针观察水位/失败计数随启用周期作废（新周期从首次观测重新起算）。
        probeObservations.clear()
        probeFailures.clear()
        if (errors.length > 0) {
          const detail = errors.map((e) => (e instanceof Error ? depsOf().redact(e.message) : String(e))).join('; ')
          throw new HelmError('plugin_service_stop_failed', `herdr 服务清理失败：${detail}`, 500, { errors: detail })
        }
      }

    },
  }
}

export type { OverviewDoc } from './herdr/overview.js'
