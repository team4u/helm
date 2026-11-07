/**
 * builtin:herdr：agent_spawn 拦截驱动本机/远端 Herdr CLI Agent。
 *
 * 职界（设计文档 §4.2）：
 * - 「终端跑过程，文件交结果」：后台窗格 + .helm/wf-out-* 交接与原地追问自愈；
 * - blocked ↔ AskDoc 单飞审批桥（expectedStateSeq CAS 乐观锁，异步权威
 *   agent.get 现查真实 seq，绝不返回创建时快照）；
 * - $helm 状态 Token 投射（防自激环的去重心跳 + 随服务启停的有界续命）；
 * - 双轨保活清理（workflowRunId -> onWorkflowSettled；单回合 -> 父 turn_settled）；
 * - 启动对账回收 helm-wf-* 孤儿窗格（仅确认自有资源；failed 保留现场；
 *   真正仍 working/blocked 的保留并报告，绝不伪装结束；keepalive 孤儿可回收；
 *   精确 agent.name === 记录归属验证，身份不符放弃所有权）；
 * - ctx.action list/read/focus（HTTP/CLI 同权 --json；read 40 行脱敏；
 *   focus 为用户显式操作；read/focus 支持 machine 消歧，歧义显式 409）。
 *
 * 连接纪律（一次启用一个冻结连接配置）：
 * - 启用时解析 config.session/socketPath 为冻结 HerdrTarget，所有命令、事件、
 *   文件、清理（含远端 pane）统一走同一目标；停用后不再触达任何服务器；
 * - 不热换连接（防误关另一服务器同 ID 人类窗格）；配置变更在下次启用生效。
 *
 * 服务生命周期：service.start 才连接（subscribe ack -> snapshot 对账），
 * 半途失败自行清理已获取资源；stop 清理订阅/定时器/Asks 与可回收自有 pane。
 */

import { HelmError, type PluginDefinition, type WorkflowRunSummary } from '@helm/protocol'
import { createHerdrTransport } from './herdr/transport.js'
import type { HerdrConfig, HerdrPluginDependencies, HerdrTarget, HerdrTransport } from './herdr/contracts.js'
import { AskCoordinator, type AskEntry } from './herdr/asks.js'
import { MetadataProjector } from './herdr/metadata.js'
import { PaneRegistry, EMPTY_MANAGED_DOC, machineOf, type ManagedDoc, type ManagedPane } from './herdr/panes.js'
import { HerdrExecutor } from './herdr/executor.js'
import {
  assertOkResult,
  isOkResult,
  parseAgentResult,
  parsePaneRead,
  parseSessionSnapshot,
} from './herdr/rpc.js'
import { isValidSessionName, isValidMachineName, resolveSocketPath } from './herdr/transport.js'
import { normalizeStartupTimeoutMs } from './herdr/spawn-rules.js'

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
      /** 本启用周期冻结的本机连接目标（所有本机调用/事件/清理共用）。 */
      let frozenLocalTarget: HerdrTarget = {}
      let overviewDoc: ReturnType<typeof ctx.doc<OverviewDoc>>
      let managedDoc: ReturnType<typeof ctx.doc<ManagedDoc>>
      let asksRelease: (() => void) | undefined
      let workflowRelease: (() => void) | undefined

      /** 最近一次 socket 事件处理的 pane seq 缓存（事件去重，agent.get 为权威）。 */
      const eventSeqCache = new Map<string, number>()
      /** 停用中：doc 句柄已失效，overview 刷新静默跳过（KISS：无写入即无异常）。 */
      let stopping = false

      const host = {
        parentCwdOf(id: number): string | undefined {
          // getConversation 错误如实传播（不存在即显式失败，绝不吞）。
          return ctx.host.getConversation(id).cwd
        },
        askConversationId(id: number): number {
          return id
        },
        notify(title: string, body: string, level: 'info' | 'error'): void {
          ctx.host.emitEvent('notification', { type: 'notification', level, title: deps.redact(title), body: deps.redact(body) })
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
              const pane = registryRef.current?.get(target.machine, String(params['pane_id']))
              return transport.call(pane?.target ?? frozenLocalTarget, method, params, { timeoutMs: 5_000 })
            },
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
        if (stopping || !overviewDoc) return
        const registry = registryRef.current
        overviewDoc.set({
          version: 1,
          updatedAt: Date.now(),
          panes: registry
            ? registry.all().map((p) => ({
                machine: machineOf(p) ?? 'local',
                paneId: p.paneId,
                agentName: p.agentName,
                outcome: p.outcome,
                effectiveCwd: p.effectiveCwd,
                ...(p.worktree !== undefined ? { worktree: p.worktree } : {}),
                pendingAsk: asks.entries().some((e) => e.paneId === p.paneId && e.machine === machineOf(p) && (e.phase === 'pending' || e.phase === 'creating')),
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
        // 事件不带 machine：先精确匹配本机记录，无匹配不误挂远端同 ID pane。
        const pane = registry.get(undefined, event.paneId)
        if (pane === undefined || JSON.stringify(pane.target) !== JSON.stringify(frozenLocalTarget)) return
        if (event.type === 'pane.closed' || event.type === 'pane.exited') {
          for (const removed of asks.paneClosed(pane.paneId, machineOf(pane))) {
            await cancelQuietly(removed, 'superseded')
          }
          projector().forget(pane.paneId, machineOf(pane))
          if (pane.outcome !== 'failed' && pane.outcome !== 'settled') {
            registry.update(machineOf(pane), pane.paneId, { outcome: 'settled', settledAt: Date.now() })
          }
          refreshOverview()
          return
        }
        // pane.updated：读权威状态（事件无 seq），仅 blocked 进入协调器。
        const info = parseAgentResult(
          await transport.call(frozenLocalTarget, 'agent.get', { target: pane.paneId }),
          'agent.get',
          'agent_info',
        )
        for (const superseded of asks.observeAuthority({
          paneId: pane.paneId,
          machine: machineOf(pane),
          seq: info.stateChangeSeq,
          status: info.agentStatus,
        })) {
          await cancelQuietly(superseded, 'superseded')
        }
        const cacheKey = `local:${pane.paneId}`
        if ((eventSeqCache.get(cacheKey) ?? 0) >= info.stateChangeSeq) return
        eventSeqCache.set(cacheKey, info.stateChangeSeq)
        if (info.agentStatus !== 'blocked') return
        // 仅登记占位（单飞标记）：Ask 创建与 send_keys 消费统一由 spawn 路径的
        // owner 流程执行（双路径先到后到均只有一个消费者）。
        asks.beginBlocked(machineOf(pane), pane.paneId, info.stateChangeSeq)
      }

      async function cancelQuietly(entry: AskEntry, reason: 'cancelled' | 'superseded'): Promise<void> {
        try {
          await ctx.host.cancelAsk(entry.askId, reason)
        } catch (error) {
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
        const snapshots = new Map<string, ReturnType<typeof parseSessionSnapshot>>([
          [JSON.stringify(frozenLocalTarget), parseSessionSnapshot(await transport.call(frozenLocalTarget, 'session.snapshot', {}))],
        ])
        for (const pane of registry.all()) {
          if (pane.outcome === 'settled') continue
          const key = JSON.stringify(pane.target)
          if (!snapshots.has(key)) snapshots.set(key, parseSessionSnapshot(await transport.call(pane.target, 'session.snapshot', {})))
          const agent = snapshots.get(key)!.agents.find((a) => a.paneId === pane.paneId)
          if (pane.outcome === 'failed') continue // 持久 failed：保留诊断现场
          if (agent === undefined) {
            // 窗格已消失：登记 settled（无资源可回收）。
            registry.update(machineOf(pane), pane.paneId, { outcome: 'settled', settledAt: Date.now() })
            continue
          }
          // 精确归属验证：agent.name 必须等于记录的 agentName（不 startsWith——
          // helm-wf-abc 不能认领 helm-wf-abcde）。身份不符放弃所有权，不误关。
          if (agent.name !== pane.agentName) {
            registry.update(machineOf(pane), pane.paneId, { outcome: 'settled', settledAt: Date.now() })
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
                `pane ${pane.paneId} 对账回收失败：${error instanceof Error ? deps.redact(error.message) : String(error)}`,
                'error',
              )
            })
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
        const outcome = await executor.handle(request)
        if (outcome.action === 'continue') return { action: 'continue' }
        return { action: 'handled', result: outcome.result }
      }, { priority: 100 })

      ctx.hook.onTurnSettled(async (payload) => {
        await settleParentTurn(payload.conversation.id)
      })

      // watchdog_tick（priority 100）：追加本插件自有窗格的真实 probes（含远端轮询）。
      // human 归属红线：非自有 pane 一律不产生 probe。
      ctx.hook.onWatchdogTick(
        async (payload) => {
          const registry = registryRef.current
          if (!registry) return
          const now = Date.now()
          for (const pane of registry.all()) {
            if (pane.outcome === 'settled') continue
            let status = 'unknown'
            try {
              const info = parseAgentResult(
                await transport.call(
                  pane.target,
                  'agent.get',
                  { target: pane.paneId },
                ),
                'agent.get',
                'agent_info',
              )
              if (info.name !== pane.agentName) {
                registry.update(machineOf(pane), pane.paneId, { outcome: 'settled', settledAt: Date.now() })
                continue
              }
              for (const superseded of asks.observeAuthority({
                paneId: pane.paneId,
                machine: machineOf(pane),
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
                ...(machineOf(pane) !== undefined ? { machine: machineOf(pane) } : {}),
              },
            })
          }
        },
        { priority: 100 },
      )

      // ---- actions（HTTP/CLI 同权；read 40 行脱敏；focus 显式操作） ----
      ctx.action<Record<string, never>, { panes: Array<Record<string, unknown>> }>({
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
                  machine: machineOf(p) ?? 'local',
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

      /** pane 消歧解析：registry 命中多个 machine 同 ID pane 时显式 409。 */
      function resolvePane(input: { paneId: string; machine?: string }): ManagedPane {
        const registry = registryRef.current
        if (registry === undefined) {
          throw new HelmError('not_found', `pane ${input.paneId} 不由 builtin:herdr 管理`, 404, { paneId: input.paneId })
        }
        if (input.machine !== undefined && input.machine !== '') {
          if (!isValidMachineName(input.machine)) {
            throw new HelmError('validation_error', `machine '${input.machine}' 非法`, 400, { machine: input.machine })
          }
          const pane = registry.get(input.machine === 'local' ? undefined : input.machine, input.paneId)
          if (pane === undefined) {
            throw new HelmError('not_found', `pane ${input.paneId}@${input.machine} 不由 builtin:herdr 管理`, 404, {
              paneId: input.paneId,
              machine: input.machine,
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
            `pane ${input.paneId} 在多台机器存在（${candidates.map((p) => machineOf(p) ?? 'local').join(', ')}），请用 machine 字段消歧`,
            409,
            { paneId: input.paneId, machines: candidates.map((p) => machineOf(p) ?? 'local') },
          )
        }
        return candidates[0]!
      }

      ctx.action<{ paneId: string; machine?: string }, { paneId: string; machine: string; text: string }>({
        id: 'read',
        description: '读取本插件管理窗格的终端尾部快照（40 行，脱敏；跨机器同 ID 用 machine 消歧）',
        inputSchema: {
          type: 'object',
          properties: {
            paneId: { type: 'string', minLength: 1 },
            machine: { type: 'string', description: '目标机（缺省本机；同 ID 多机时必填消歧）' },
          },
          required: ['paneId'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { paneId: { type: 'string' }, machine: { type: 'string' }, text: { type: 'string' } },
          required: ['paneId', 'machine', 'text'],
          additionalProperties: false,
        },
        async handler(input) {
          const pane = resolvePane(input)
          const read = parsePaneRead(
            await transport.call(pane.target, 'agent.read', {
              target: pane.paneId,
              source: 'recent_unwrapped',
              lines: 40,
              format: 'text',
            }),
          )
          return { paneId: pane.paneId, machine: machineOf(pane) ?? 'local', text: deps.redact(read.text) }
        },
      })

      ctx.action<{ paneId: string; machine?: string }, { paneId: string; machine: string; focused: boolean }>({
        id: 'focus',
        description: '在 Herdr 终端聚焦指定窗格（用户显式操作；跨机器同 ID 用 machine 消歧）',
        inputSchema: {
          type: 'object',
          properties: {
            paneId: { type: 'string', minLength: 1 },
            machine: { type: 'string', description: '目标机（缺省本机；同 ID 多机时必填消歧）' },
          },
          required: ['paneId'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { paneId: { type: 'string' }, machine: { type: 'string' }, focused: { type: 'boolean' } },
          required: ['paneId', 'machine', 'focused'],
          additionalProperties: false,
        },
        async handler(input) {
          const pane = resolvePane(input)
          // 真实协议（服务端源码 agents.rs:35-41）：agent.focus 返回
          // ResponseResult::AgentInfo { agent }（agent_info），非 ok。
          const info = parseAgentResult(
            await transport.call(pane.target, 'agent.focus', { target: pane.paneId }),
            'agent.focus',
            'agent_info',
          )
          if (info.focused !== true) {
            throw new HelmError(
              'herdr_focus_failed',
              `agent.focus 返回 focused=false（pane ${pane.paneId}@${machineOf(pane) ?? 'local'}）`,
              502,
              { paneId: pane.paneId, machine: machineOf(pane) ?? 'local' },
            )
          }
          return { paneId: pane.paneId, machine: machineOf(pane) ?? 'local', focused: true }
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
          const config = ctx.getConfig() as Partial<HerdrConfig>
          // 冻结本启用周期的本机连接目标（此后所有调用共用；热配置不再生效）。
          frozenLocalTarget = resolveLocalTarget(config)
          const startupTimeout = normalizeStartupTimeoutMs(config.startupTimeoutMs)
          void startupTimeout

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
              askConversationId: host.askConversationId,
              notify: host.notify,
              startupTimeoutMs: () => startupTimeout,
              createAsk: host.createAsk,
              cancelAsk: host.cancelAsk,
            },
            transport,
            frozenLocalTarget,
          )
          executorRef.current = executor
          // Ask CAS seq 解析器：异步权威 agent.get 现查目标 pane 当前真实 seq
          //（先于任何 createAsk；归属经 askId 三段校验）。
          asksRelease = ctx.host.registerAskSeqResolver((askId) =>
            asks.seqResolver(askId, async (machine, paneId) => {
              const pane = registry.get(machine, paneId)
              if (pane === undefined) return undefined
              try {
                const info = parseAgentResult(
                  await transport.call(pane.target, 'agent.get', { target: paneId }),
                  'agent.get',
                  'agent_info',
                )
                return info.stateChangeSeq
              } catch {
                // 权威不可达：undefined（AskService 以 ask_state_unavailable 拒答，
                // 绝不把坏数据当 CAS 权威）。
                return undefined
              }
            }),
          )
          workflowRelease = ctx.host.onWorkflowSettled(settleWorkflow)

          // subscribe ack 先行；失败时已获取资源自行清理后重抛。
          const unsubscribe = await transport.subscribe(
            frozenLocalTarget,
            (event) => {
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
          // 有界心跳：随服务启停，只重投射已登记 token（不自激）。
          projector().start()
          refreshOverview()
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
        projector().stop()
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
