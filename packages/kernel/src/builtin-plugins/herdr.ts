/**
 * builtin:herdr：agent_spawn 拦截驱动本机/远端 Herdr CLI Agent。
 *
 * 职界（设计文档 §4.2）：
 * - 「终端跑过程，文件交结果」：后台窗格 + .helm/wf-out-* 交接与原地追问自愈；
 * - blocked ↔ AskDoc 单飞审批桥（expectedStateSeq CAS 乐观锁）；
 * - $helm 状态 Token 投射（防自激环的去重心跳）；
 * - 双轨保活清理（workflowRunId -> onWorkflowSettled；单回合 -> 父 turn_settled）；
 * - 启动对账回收 helm-wf-* 孤儿窗格（仅确认自有资源；failed 保留现场；
 *   同 ID 已换 human agent 的 pane 不误关）；
 * - ctx.action list/read/focus（HTTP/CLI 同权 --json；read 仅 40 行脱敏；
 *   focus 为用户显式操作，无任意自动按键动作）。
 *
 * 服务生命周期：service.start 才连接（subscribe ack -> snapshot 对账），
 * 半途失败自行清理已获取资源；stop 清理订阅/定时器/Asks 与可回收自有 pane。
 */

import { HelmError, type PluginDefinition, type WorkflowRunSummary } from '@helm/protocol'
import { createHerdrTransport } from './herdr/transport.js'
import type { HerdrConfig, HerdrPluginDependencies, HerdrTarget, HerdrTransport } from './herdr/contracts.js'
import { AskCoordinator, type AskEntry } from './herdr/asks.js'
import { MetadataProjector } from './herdr/metadata.js'
import { PaneRegistry, EMPTY_MANAGED_DOC, type ManagedDoc, type ManagedPane } from './herdr/panes.js'
import { HerdrExecutor, type ExecutorHost } from './herdr/executor.js'
import { isOkResult, parseAgentResult, parsePaneRead, parseSessionSnapshot } from './herdr/rpc.js'

export function createHerdrPlugin(deps: HerdrPluginDependencies): PluginDefinition {
  return {
    id: 'builtin:herdr',
    name: 'Herdr 终端',
    version: '0.1.0',
    definePlugin(ctx) {
      // ---- 状态（每次启用周期重建） ----
      const transport: HerdrTransport = deps.transport ?? createHerdrTransport({ redact: deps.redact })
      const asks = new AskCoordinator(() => refreshOverview())
      const registryRef: { current?: PaneRegistry } = {}
      const projectorRef: { current?: MetadataProjector } = {}
      const executorRef: { current?: HerdrExecutor } = {}
      const unsubscribeRef: { current?: () => void } = {}
      let overviewDoc: ReturnType<typeof ctx.doc<OverviewDoc>>
      let managedDoc: ReturnType<typeof ctx.doc<ManagedDoc>>
      let asksRelease: (() => void) | undefined
      let workflowRelease: (() => void) | undefined

      /** 最近一次 socket 事件处理的 pane seq 缓存（事件去重，agent.get 为权威）。 */
      const eventSeqCache = new Map<string, number>()

      const host: ExecutorHost = {
        parentCwdOf(id) {
          try {
            return ctx.host.getConversation(id).cwd
          } catch {
            return undefined
          }
        },
        askConversationId(id) {
          return id
        },
        notify(title, body, level) {
          ctx.host.emitEvent('notification', { type: 'notification', level, title, body })
        },
        async createAsk(spec) {
          return ctx.host.createAsk(spec)
        },
        startupTimeoutMs() {
          return startupTimeoutMs()
        },
        async cancelAskQuietly(askId) {
          try {
            await ctx.host.cancelAsk(askId, 'cancelled')
          } catch (error) {
            if (error instanceof HelmError && error.status === 404) return
            host.notify(
              'Herdr 审批销单失败',
              `ask ${askId} cancel 失败：${error instanceof Error ? deps.redact(error.message) : String(error)}`,
              'error',
            )
          }
        },
      }

      function projector(): MetadataProjector {
        if (projectorRef.current === undefined) {
          projectorRef.current = new MetadataProjector(
            (target, method, params) => transport.call(target, method, params),
            (paneId, error) => {
              host.notify(
                'Herdr 状态投射失败',
                `pane ${paneId} report_metadata 失败：${error instanceof Error ? deps.redact(error.message) : String(error)}`,
                'error',
              )
            },
          )
        }
        return projectorRef.current
      }

      function refreshOverview(): void {
        if (!overviewDoc) return
        const registry = registryRef.current
        overviewDoc.set({
          version: 1,
          updatedAt: Date.now(),
          panes: registry
            ? registry.all().map((p) => ({
                machine: p.machine ?? 'local',
                paneId: p.paneId,
                agentName: p.agentName,
                outcome: p.outcome,
                effectiveCwd: p.effectiveCwd,
                ...(p.worktree !== undefined ? { worktree: p.worktree } : {}),
                pendingAsk: asks.get(p.machine, p.paneId, Number.NaN) !== undefined,
              }))
            : [],
          asks: asks.describe(),
        })
      }

      // ---- socket 事件路径：只为本插件自有 pane 创建/处理 Ask ----
      async function onPaneEvent(event: { type: string; paneId: string }): Promise<void> {
        if (event.type === 'pane.created') return
        const registry = registryRef.current
        if (!registry) return
        const pane = findByMachine(event.paneId)
        if (pane === undefined) return // 非本插件 pane：只读不处理（默认 human）
        if (event.type === 'pane.closed' || event.type === 'pane.exited') {
          for (const removed of asks.paneClosed(pane.paneId, pane.machine)) {
            await cancelQuietly(removed, 'superseded')
          }
          projector().forget(pane.paneId, pane.machine)
          if (pane.outcome !== 'failed' && pane.outcome !== 'settled') {
            registry.update(pane.machine, pane.paneId, { outcome: 'settled', settledAt: Date.now() })
          }
          refreshOverview()
          return
        }
        // pane.updated：读权威状态（事件无 seq），仅 blocked 进入协调器。
        const info = parseAgentResult(
          await transport.call(pane.machine === undefined ? {} : { machine: pane.machine }, 'agent.get', {
            target: pane.paneId,
          }),
          'agent.get',
          'agent_info',
        )
        // seq 推进：终端先处理——待结 Ask 销单 superseded（不吞错，失败通知）。
        for (const superseded of asks.observeAuthority({
          paneId: pane.paneId,
          machine: pane.machine,
          seq: info.stateChangeSeq,
          status: info.agentStatus,
        })) {
          await cancelQuietly(superseded, 'superseded')
        }
        const cacheKey = `${pane.machine ?? 'local'}:${pane.paneId}`
        if ((eventSeqCache.get(cacheKey) ?? 0) >= info.stateChangeSeq) return
        eventSeqCache.set(cacheKey, info.stateChangeSeq)
        if (info.agentStatus !== 'blocked') return
        // 仅登记占位（单飞标记）：Ask 创建与 send_keys 消费统一由 spawn 路径的
        // owner 流程执行（双路径先到后到均只有一个消费者）。
        asks.beginBlocked(pane.machine, pane.paneId, info.stateChangeSeq)
      }

      function findByMachine(paneId: string): ManagedPane | undefined {
        const registry = registryRef.current
        if (!registry) return undefined
        for (const pane of registry.all()) if (pane.paneId === paneId) return pane
        return undefined
      }

      async function cancelQuietly(entry: AskEntry, reason: 'cancelled' | 'superseded'): Promise<void> {
        try {
          await ctx.host.cancelAsk(entry.askId, reason)
        } catch (error) {
          // 404（已被结算/未入库）属预期竞态；其它如实通知。
          if (error instanceof HelmError && error.status === 404) return
          host.notify(
            'Herdr 审批销单失败',
            `ask ${entry.askId} cancel 失败：${error instanceof Error ? deps.redact(error.message) : String(error)}`,
            'error',
          )
        }
      }

      // ---- 启动对账：subscribe ack -> snapshot 扫描 ----
      async function reconcile(): Promise<void> {
        const registry = registryRef.current!
        const snapshot = parseSessionSnapshot(
          await transport.call(localTarget(), 'session.snapshot', {}),
        )
        const liveAgents = new Map(snapshot.agents.map((a) => [`${a.paneId}`, a]))
        for (const pane of registry.all()) {
          if (pane.machine !== undefined) continue // 仅本机 socket 可对账
          const agent = liveAgents.get(pane.paneId)
          if (pane.outcome === 'failed') continue // 持久 failed：保留诊断现场
          if (agent === undefined) {
            // 窗格已消失：登记 settled（无资源可回收）。
            registry.update(pane.machine, pane.paneId, { outcome: 'settled', settledAt: Date.now() })
            continue
          }
          // 同 ID 但 agent 已非 helm-wf-*（被 human 重建/换 agent）：放弃归属，不误关。
          if (agent.name === undefined || !agent.name.startsWith('helm-wf-')) {
            registry.update(pane.machine, pane.paneId, { outcome: 'settled', settledAt: Date.now() })
            continue
          }
          // 自有已结束窗格（idle/done/unknown 且非 running/keepalive 待结算）：回收。
          if (
            (agent.agentStatus === 'idle' || agent.agentStatus === 'done' || agent.agentStatus === 'unknown') &&
            pane.outcome === 'running'
          ) {
            // running 但进程重启后无在途 spawn：属孤儿，回收。
            await executorRef.current!.closePane(pane, 'settled').catch(() => {})
          }
        }
      }

      // ---- 双轨清理 ----
      async function settleWorkflow(run: WorkflowRunSummary): Promise<void> {
        const registry = registryRef.current
        if (!registry) return
        for (const pane of registry.findByWorkflow(run.id)) {
          if (pane.outcome === 'failed') continue
          await executorRef.current!.closePane(pane, 'workflow-settled')
        }
      }

      async function settleParentTurn(conversationId: number): Promise<void> {
        const registry = registryRef.current
        if (!registry) return
        for (const pane of registry.findByParent(conversationId)) {
          if (pane.workflowRunId !== undefined) continue // workflow 轨道
          if (pane.outcome === 'failed') continue
          if (pane.outcome === 'running') continue // 同回合仍在途（并发 spawn）
          await executorRef.current!.closePane(pane, 'turn-settled')
        }
      }

      // ---- 文档与 UI ----
      managedDoc = ctx.doc<ManagedDoc>('managed', EMPTY_MANAGED_DOC)
      overviewDoc = ctx.doc<OverviewDoc>(
        'overview',
        { version: 1, updatedAt: 0, panes: [], asks: [] },
        { public: true },
      )

      ctx.ui.sidebarItem({
        id: 'herdr',
        label: 'Herdr 终端',
        icon: 'terminal',
        target: 'screen:builtin:herdr/overview',
        order: 40,
      })
      ctx.ui.screen({ id: 'overview', label: 'Herdr 终端总览', icon: 'terminal' })

      // ---- hooks ----
      ctx.hook.onAgentSpawn(async (request) => {
        const executor = executorRef.current
        if (executor === undefined) return { action: 'continue' }
        const handled = await executor.handle(request)
        if (!handled) return { action: 'continue' }
        return { action: 'handled', result: (request as { __herdrResult?: unknown }).__herdrResult }
      }, { priority: 100 })

      ctx.hook.onTurnSettled(async (payload) => {
        await settleParentTurn(payload.conversation.id)
      })

      // watchdog_tick（priority 100）：追加本插件自有窗格的真实 probes。
      // human 归属红线：非自有 pane 一律不产生 probe（只读都不做——无归属信息）。
      ctx.hook.onWatchdogTick(
        async (payload) => {
          const registry = registryRef.current
          if (!registry) return
          const now = Date.now()
          for (const pane of registry.all()) {
            if (pane.machine !== undefined) continue // 本机 socket 才可探测
            let status = 'unknown'
            try {
              const info = parseAgentResult(
                await transport.call(localTarget(), 'agent.get', { target: pane.paneId }),
                'agent.get',
                'agent_info',
              )
              for (const superseded of asks.observeAuthority({
                paneId: pane.paneId,
                machine: pane.machine,
                seq: info.stateChangeSeq,
                status: info.agentStatus,
              })) {
                await cancelQuietly(superseded, 'superseded')
              }
              status = info.agentStatus
            } catch {
              status = 'unreachable'
            }
            payload.probes.push({
              targetId: pane.paneId,
              ownedBy: 'helm',
              status,
              stalledMs: now - pane.createdAt,
              facts: {
                agentName: pane.agentName,
                outcome: pane.outcome,
                effectiveCwd: pane.effectiveCwd,
                ...(pane.machine !== undefined ? { machine: pane.machine } : {}),
              },
            })
          }
        },
        { priority: 100 },
      )

      // ---- actions（HTTP/CLI 同权；read 40 行脱敏；focus 显式操作） ----
      ctx.action<{ paneId: string }, { panes: Array<Record<string, unknown>> }>({
        id: 'list',
        description: '列出本插件管理的 Herdr 窗格（machine/pane/状态/归属）',
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
                  machine: p.machine ?? 'local',
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

      ctx.action<{ paneId: string }, { paneId: string; text: string }>({
        id: 'read',
        description: '读取本插件管理窗格的终端尾部快照（40 行，脱敏）',
        inputSchema: {
          type: 'object',
          properties: { paneId: { type: 'string', minLength: 1 } },
          required: ['paneId'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { paneId: { type: 'string' }, text: { type: 'string' } },
          required: ['paneId', 'text'],
          additionalProperties: false,
        },
        async handler(input) {
          const registry = registryRef.current
          const pane = registry ? findByMachine(input.paneId) : undefined
          if (pane === undefined) {
            throw new HelmError('not_found', `pane ${input.paneId} 不由 builtin:herdr 管理`, 404, { paneId: input.paneId })
          }
          const read = parsePaneRead(
            await transport.call(pane.machine === undefined ? {} : { machine: pane.machine }, 'agent.read', {
              target: pane.paneId,
              source: 'recent_unwrapped',
              lines: 40,
              format: 'text',
            }),
          )
          return { paneId: pane.paneId, text: deps.redact(read.text) }
        },
      })

      ctx.action<{ paneId: string }, { paneId: string; focused: boolean }>({
        id: 'focus',
        description: '在 Herdr 终端聚焦指定窗格（用户显式操作）',
        inputSchema: {
          type: 'object',
          properties: { paneId: { type: 'string', minLength: 1 } },
          required: ['paneId'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { paneId: { type: 'string' }, focused: { type: 'boolean' } },
          required: ['paneId', 'focused'],
          additionalProperties: false,
        },
        async handler(input) {
          const registry = registryRef.current
          const pane = registry ? findByMachine(input.paneId) : undefined
          if (pane === undefined) {
            throw new HelmError('not_found', `pane ${input.paneId} 不由 builtin:herdr 管理`, 404, { paneId: input.paneId })
          }
          const result = await transport.call(
            pane.machine === undefined ? {} : { machine: pane.machine },
            'agent.focus',
            { target: pane.paneId },
          )
          if (!isOkResult(result)) {
            throw new HelmError('herdr_protocol_violation', `agent.focus 未返回 ok：${JSON.stringify(result)?.slice(0, 200)}`, 502)
          }
          return { paneId: pane.paneId, focused: true }
        },
      })

      // ---- config schema（启用前可配置） ----
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
          const restored = managedDoc.get()
          const registry = new PaneRegistry(
            { get: () => managedDoc.get(), set: (doc) => managedDoc.set(doc) },
            restored,
          )
          registryRef.current = registry
          executorRef.current = new HerdrExecutor(deps, registry, asks, projector(), host)
          // Ask CAS seq 解析器注册（先于任何 createAsk）。
          asksRelease = ctx.host.registerAskSeqResolver((askId) => asks.seqResolver(askId))
          workflowRelease = ctx.host.onWorkflowSettled(settleWorkflow)

          // subscribe ack 先行；失败时已获取资源自行清理后重抛。
          const unsubscribe = await transport.subscribe(
            localTarget(),
            (event) => {
              // 事件处理错误必须传回（通知），不 catch 空吞。
              onPaneEvent(event).catch((error) => {
                host.notify(
                  'Herdr 事件处理失败',
                  `${event.type} pane ${event.paneId}：${error instanceof Error ? deps.redact(error.message) : String(error)}`,
                  'error',
                )
              })
            },
            (error) => {
              host.notify(
                'Herdr 事件订阅断开',
                error instanceof Error ? deps.redact(error.message) : String(error),
                'error',
              )
            },
          )
          unsubscribeRef.current = unsubscribe
          try {
            await reconcile()
          } catch (error) {
            // 对账失败：自行清理已获取资源（Host 只 stop 已完成 start 的服务）。
            await stopResources()
            throw error
          }
          refreshOverview()
        },
        async stop() {
          await stopResources()
        },
      })

      /** 本机目标（config.session/socketPath 热读取；空串回落默认）。 */
      function localTarget(): HerdrTarget {
        const config = ctx.getConfig() as Partial<HerdrConfig>
        const session = typeof config.session === 'string' && config.session !== '' ? config.session : undefined
        const socketPath = typeof config.socketPath === 'string' && config.socketPath !== '' ? config.socketPath : undefined
        return session !== undefined ? { session } : socketPath !== undefined ? { socketPath } : {}
      }

      /** agent.start 启动超时（config.startupTimeoutMs，3001..300000，默认 30000）。 */
      function startupTimeoutMs(): number {
        const config = ctx.getConfig() as Partial<HerdrConfig>
        const raw = typeof config.startupTimeoutMs === 'number' ? config.startupTimeoutMs : 30_000
        if (!Number.isInteger(raw) || raw < 3001 || raw > 300_000) return 30_000
        return raw
      }

      /** 服务资源清理：订阅/解析器/监听 + 可回收自有 pane（failed 保留现场）。 */
      async function stopResources(): Promise<void> {
        const errors: unknown[] = []
        try {
          unsubscribeRef.current?.()
        } catch (err) {
          errors.push(err)
        }
        unsubscribeRef.current = undefined
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
        // 销单全部 pending Ask；取消失败如实通知（不空吞）。
        for (const entry of asks.entries()) {
          if (entry.phase === 'pending' || entry.phase === 'creating') {
            try {
              await ctx.host.cancelAsk(entry.askId, 'cancelled')
            } catch (err) {
              if (!(err instanceof HelmError && err.status === 404)) errors.push(err)
            }
          }
        }
        asks.settleAllAsSuperseded()
        const registry = registryRef.current
        if (registry) {
          for (const pane of registry.all()) {
            if (pane.outcome === 'failed' || pane.outcome === 'settled') continue
            if (pane.machine !== undefined) continue // 远端 pane：stop 仅停本机订阅
            try {
              await executorRef.current?.closePane(pane, 'settled')
            } catch (err) {
              errors.push(err)
            }
          }
        }
        registryRef.current = undefined
        executorRef.current = undefined
        projectorRef.current = undefined
        eventSeqCache.clear()
        if (errors.length > 0) {
          const detail = errors.map((e) => (e instanceof Error ? deps.redact(e.message) : String(e))).join('; ')
          throw new HelmError('plugin_service_stop_failed', `herdr 服务清理失败：${detail}`, 500, { errors: detail })
        }
      }

    },
  }
}

interface OverviewDoc {
  version: 1
  updatedAt: number
  panes: Array<{
    machine: string
    paneId: string
    agentName: string
    outcome: string
    effectiveCwd: string
    worktree?: { path: string; branch?: string }
    pendingAsk: boolean
  }>
  asks: Array<{ paneId: string; machine?: string; seq: number; phase: string }>
}
