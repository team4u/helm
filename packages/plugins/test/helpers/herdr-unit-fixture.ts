/**
 * builtin:herdr 零参插件的单元级受控环境（herdr.test / herdr-plugin-fixes /
 * herdr-attachments 共享）。
 *
 * 生产插件依赖全部来自 ctx.host 公共端口：连接走真实 transport（UDS 行
 * 协议），交接文件读写走真实文件系统。测试仍使用进程内 FakeTransport 形状
 * （可编程 panes/outputFiles/gate 行为）——本模块把它「搬到真实边界」：
 *
 * - serveTransport：临时 UDS socket 上按 Herdr 官方行协议提供服务器，帧
 *   分发到受控 transport.call / transport.subscribe（一问一答；events.
 *   subscribe 回 ack 后保持连接推裸事件帧）。插件生产 transport 经
 *   backend.nodeIpc（LocalNodeChannel，endpoint 指向本 socket）真实到达，
 *   测试注入零私有缝。
 * - FsOutputFiles：Map 形状的交接文件存储（键 <cwd>/.helm/<name>），set
 *   真实落盘（含父目录创建）、delete 真实删除——生产 readLocalOutput /
 *   removeLocalOutput 在同一路径真实生效。
 */
import { connect, createServer, type Server, type Socket } from 'node:net'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { HelmError, type AgentGateResult, type RpcResult } from '@helm/protocol'
import type { HerdrEvent, HerdrPluginDependencies, HerdrTarget, HerdrTransport } from '../../src/herdr/contracts.js'
import { SEND_KEYS_CAS_CAPABILITY } from '../../src/herdr/rpc.js'

/**
 * 单元/集成测试用极速时间参数（缩短轮询、退避、md 稳定性复检与 steer 预算，
 * 避免无谓真时钟睡眠；生产默认值保留在各自模块内）。
 */
export const HERDR_FAST_TEST_TIMINGS: Pick<
  HerdrPluginDependencies,
  | 'pollIntervalMs'
  | 'blockedBackoffBaseMs'
  | 'blockedBackoffCapMs'
  | 'askPollTransientBackoffBaseMs'
  | 'askPollTransientBackoffCapMs'
  | 'abortCancelBackoffCapMs'
  | 'mdStableRecheckMs'
  | 'subscriptionRetryBaseMs'
  | 'subscriptionRetryCapMs'
  | 'steerWaitBudgetMs'
> = {
  pollIntervalMs: 10,
  blockedBackoffBaseMs: 15,
  blockedBackoffCapMs: 60,
  askPollTransientBackoffBaseMs: 15,
  askPollTransientBackoffCapMs: 60,
  abortCancelBackoffCapMs: 80,
  mdStableRecheckMs: 10,
  subscriptionRetryBaseMs: 25,
  subscriptionRetryCapMs: 80,
  steerWaitBudgetMs: 150,
}

/**
 * Map 形状的交接文件存储（真实落盘）：生产链路 readLocalOutput /
 * removeLocalOutput 经真实 fs 读取同一路径；测试 set/delete 同步真实文件。
 */
export class FsOutputFiles {
  private store = new Map<string, string>()

  set(key: string, content: string): void {
    mkdirSync(dirname(key), { recursive: true })
    writeFileSync(key, content, 'utf8')
    this.store.set(key, content)
  }

  get(key: string): string | undefined {
    return this.store.get(key) ?? (() => {
      try {
        return readFileSync(key, 'utf8')
      } catch {
        return undefined
      }
    })()
  }

  delete(key: string): boolean {
    const existed = this.store.has(key) || (() => {
      try {
        readFileSync(key)
        return true
      } catch {
        return false
      }
    })()
    try {
      unlinkSync(key)
    } catch {
      // 已被生产链路删除：幂等。
    }
    this.store.delete(key)
    return existed
  }

  has(key: string): boolean {
    return this.store.has(key)
  }
}

export interface ServedTransport {
  socketPath: string
  close(): Promise<void>
}

/**
 * 内部 HerdrEvent → 官方 wire 事件帧（{"event","data"}）。
 *
 * 全局 EventEnvelope 名称使用 snake_case（pane_created 等）；专用状态事件
 * pane.agent_status_changed 保留点号。官方 pane.created/updated 的 EventData
 * 携带完整 PaneInfo，但生产消费方只读取 pane 身份后重取快照，故 fixture
 * 只发 pane_id；tab/workspace.closed 走拓扑身份字段——与生产 transport
 * dispatchEventFrame 解析规则逐条对齐。
 */
function eventWireFrame(event: HerdrEvent): string {
  if (event.type === 'tab.closed') {
    return `${JSON.stringify({ event: 'tab_closed', data: { tab_id: event.tabId, workspace_id: event.workspaceId } })}\n`
  }
  if (event.type === 'workspace.closed') {
    return `${JSON.stringify({ event: 'workspace_closed', data: { workspace_id: event.workspaceId } })}\n`
  }
  // 状态专用事件保留点号（官方契约）；全局 EventEnvelope 使用 snake_case。
  const wireType = event.type === 'pane.agent_status_changed' ? event.type : event.type.replace('.', '_')
  const data: Record<string, unknown> = { pane_id: event.paneId }
  return `${JSON.stringify({ event: wireType, data })}\n`
}

/**
 * 把受控 FakeTransport 暴露为真实 UDS 行协议服务器（零参插件的生产
 * transport 直连）。targetOf 为每次协议调用的 HerdrTarget 解析函数。
 */
export async function serveTransport(
  transport: HerdrTransport,
  socketPath: string,
  targetOf: () => { nodeId?: string } = () => ({}),
): Promise<ServedTransport> {
  const sockets = new Set<Socket>()
  const socketsWithReleases: Array<{ socket: Socket; release: () => void }> = []
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    // 客户端结束请求后，异步事件帧可能晚到；测试服务器不得因写入已关闭
    // 的订阅 socket 产生未处理 EPIPE，生产协议仍由客户端负责取消订阅。
    socket.on('error', () => {})
    const writeFrame = (frame: string): void => {
      if (!socket.destroyed && socket.writable) socket.write(frame, () => {})
    }
    let buffer = ''
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        void (async () => {
          const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> }
          try {
            if (request.method === 'events.subscribe') {
              // 官方订阅请求：params.subscriptions 为过滤数组；逐窗格状态过滤
              // （pane.agent_status_changed + pane_id）映射为 options.paneIds 传给
              // 受控 transport，主树动态重建订阅（paneIds 集合变化）可被观测。
              const filters = Array.isArray(request.params['subscriptions']) ? (request.params['subscriptions'] as Array<Record<string, unknown>>) : []
              const paneIds = filters
                .filter((f) => f['type'] === 'pane.agent_status_changed' && typeof f['pane_id'] === 'string' && f['pane_id'] !== '')
                .map((f) => f['pane_id'] as string)
              const release = await transport.subscribe(targetOf(), (event) => {
                writeFrame(eventWireFrame(event))
              }, () => {
                // 受控 transport 注入流故障：销毁订阅 socket 模拟真实断线，
                // 客户端 close 路径如实触发其 onError（不静默吞掉注入故障）。
                socket.destroy()
              }, { paneIds })
              writeFrame(`${JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })}\n`)
              // 生产 stop() 直接 socket.destroy()（FIN 不保证对端 close 事件同步
              // 到达）：fixture 在订阅 socket 结束（close 或 error）时同步释放受控
              // transport 监听，半途失败清理断言才能观测到释放。
              // 客户端 stop() 只 destroy 本方 socket；fixture server 侧经 close
              // 事件感知并释放受控 transport 监听（与生产对端释放语义一致）。
              socket.once('end', () => release())
              socket.once('close', () => release())
              socketsWithReleases.push({ socket, release })
              return
            }
            const result = await transport.call(targetOf(), request.method, request.params)
            socket.end(`${JSON.stringify({ id: request.id, result })}\n`)
          } catch (error) {
            const body = error instanceof HelmError
              ? { code: error.code, message: error.message }
              : { code: 'internal', message: error instanceof Error ? error.message : String(error) }
            socket.end(`${JSON.stringify({ id: request.id, error: body })}\n`)
          }
        })()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return {
    socketPath,
    close: async () => {
      // close() 销毁全部连接：触发每个订阅 socket 的 close 释放（见上）。
      for (const entry of socketsWithReleases) entry.socket.destroy()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** 交接文件目录真实化辅助：mkdirSync(join(cwd, '.helm'), recursive)。 */
export function ensureHelmDir(cwd: string): string {
  const dir = join(cwd, '.helm')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 单次行协议调用（任意节点通用）：写入一行请求，读到首个换行响应即返回。
 * 供 backend.nodeIpc.call 将远端 nodeId 的帧转发到受控 socket（协议与
 * LocalNodeChannel 一致，但不限 'local'）。
 */
export async function ipcLineCall(
  socketPath: string,
  line: string,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
): Promise<RpcResult<string>> {
  signal?.throwIfAborted()
  return await new Promise((resolve) => {
    const socket = connect(socketPath)
    socket.setNoDelay(true)
    let buffer = ''
    let settled = false
    const settle = (result: RpcResult<string>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      resolve(result)
    }
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => settle({ ok: false, error: { code: 'timeout', message: `ipcLineCall no response within ${timeoutMs}ms` } }), timeoutMs)
    const onAbort = () => settle({ ok: false, error: { code: 'aborted', message: 'ipcLineCall aborted' } })
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.on('connect', () => socket.write(`${line}\n`))
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      settle({ ok: true, value: buffer.slice(0, newline) })
    })
    socket.once('error', (err) => settle({ ok: false, error: { code: 'unknown', message: err.message } }))
  })
}

/** 临时目录工厂（测试自清理约定由调用方 rmSync）。 */
export function unitTempDir(prefix: string): string {
  return join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

/** 受控 Herdr 窗格状态枚举。 */
export type HerdrPaneStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

/** 受控 Herdr 窗格状态模型。 */
export interface HerdrPaneState {
  paneId: string
  tabId: string
  workspaceId: string
  agentStatus: HerdrPaneStatus
  seq: number
  name?: string
  cwd: string
  focused?: boolean
  launchPending?: boolean
}

/** 构造 wire `AgentInfo` 对象。 */
export function agentInfoOf(pane: HerdrPaneState) {
  return {
    pane_id: pane.paneId,
    tab_id: pane.tabId,
    workspace_id: pane.workspaceId,
    agent_status: pane.agentStatus,
    interactive_ready: pane.agentStatus !== 'unknown',
    state_change_seq: pane.seq,
    cwd: pane.cwd,
    ...(pane.launchPending !== undefined ? { launch_pending: pane.launchPending } : {}),
    ...(pane.focused !== undefined ? { focused: pane.focused } : {}),
    ...(pane.name !== undefined ? { name: pane.name } : {}),
  }
}

/** 默认服务端 capabilities 通告（含 send_keys CAS 能力）。 */
export const DEFAULT_HERDR_PONG_CAPABILITIES: Record<string, unknown> = {
  live_handoff: false,
  detached_server_daemon: false,
  endpoint_protocol_generation: 1,
  [SEND_KEYS_CAS_CAPABILITY]: true,
}

/**
 * 共享受控 `HerdrTransport` 基座：封装 panes/tabs/workspaces 状态、调用记录、
 * 事件订阅分发、CAS 校验、交接文件读写与 Gate stub，供各测试按需扩展 `call()`。
 */
export abstract class BaseFakeHerdrTransport implements HerdrTransport {
  panes = new Map<string, HerdrPaneState>()
  tabs = new Map<string, { closed: boolean }>()
  workspaces = new Map<string, { closed: boolean }>()
  calls: Array<{ target: HerdrTarget; method: string; params: Record<string, unknown> }> = []
  eventListeners: Array<(e: HerdrEvent) => void> = []
  sendKeysLog: Array<{ paneId: string; keys: string[] }> = []
  metadataReports: Array<Record<string, unknown>> = []
  removedFiles: string[] = []
  outputFiles = new FsOutputFiles()
  errors = new Map<string, () => Error>()
  subscribeAck: 'ok' | 'fail' = 'ok'
  promptStatus: HerdrPaneStatus | Array<HerdrPaneStatus> = 'idle'
  onPrompt: ((pane: HerdrPaneState, text: string) => void) | undefined
  pongCapabilities: Record<string, unknown> | null = { ...DEFAULT_HERDR_PONG_CAPABILITIES }
  gateRuns = 0

  protected record(target: HerdrTarget, method: string, params: Record<string, unknown>): void {
    this.calls.push({ target, method, params })
  }

  protected paneOf(ref: unknown): HerdrPaneState {
    const id = typeof ref === 'string' ? ref : String((ref as { pane_id?: unknown })?.pane_id ?? '')
    const pane = this.panes.get(id)
    if (!pane) throw new HelmError('agent_not_found', `no pane ${id}`, 404)
    return pane
  }

  protected createTabPane(params: Record<string, unknown>, ensureDir = false) {
    const n = this.panes.size + 1
    const workspaceId = (params['workspace_id'] as string | undefined) ?? 'ws-default'
    const paneId = `${workspaceId}:p${n}`
    const tabId = `${workspaceId}:t${n}`
    const paneCwd = (params['cwd'] as string) ?? '/tmp'
    if (ensureDir) ensureHelmDir(paneCwd)
    this.panes.set(paneId, {
      paneId,
      tabId,
      workspaceId,
      agentStatus: 'idle',
      seq: 1,
      cwd: paneCwd,
    })
    this.tabs.set(tabId, { closed: false })
    return {
      type: 'tab_created',
      tab: { tab_id: tabId, workspace_id: workspaceId },
      root_pane: { pane_id: paneId, workspace_id: workspaceId, tab_id: tabId },
    }
  }

  protected createWorktreePane(params: Record<string, unknown>, ensureDir = false) {
    const n = this.panes.size + 1
    const workspaceId = `ws-wt-${n}`
    const paneId = `${workspaceId}:p1`
    const tabId = `${workspaceId}:t1`
    const path = `${params['cwd']}/.worktrees/wt${n}`
    if (ensureDir) ensureHelmDir(path)
    this.panes.set(paneId, { paneId, tabId, workspaceId, agentStatus: 'idle', seq: 1, cwd: path })
    this.tabs.set(tabId, { closed: false })
    this.workspaces.set(workspaceId, { closed: false })
    return {
      type: 'worktree_created',
      workspace: { workspace_id: workspaceId },
      tab: { tab_id: tabId, workspace_id: workspaceId },
      root_pane: { pane_id: paneId, workspace_id: workspaceId, tab_id: tabId },
      worktree: { path, branch: (params['branch'] as string) ?? 'helm/wf-x' },
    }
  }

  protected handlePing(version = 'test-server') {
    return {
      type: 'pong',
      version,
      protocol: 22,
      ...(this.pongCapabilities !== null ? { capabilities: { ...this.pongCapabilities } } : {}),
    }
  }

  protected assertSendKeysCas(pane: HerdrPaneState | undefined, params: Record<string, unknown>): void {
    const expected = params['expected_state_seq']
    if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0) {
      throw new HelmError('invalid_params', 'agent.send_keys 必须携带非负整数 expected_state_seq（CAS 契约）', 400)
    }
    if (pane !== undefined && expected !== pane.seq) {
      throw new HelmError('stale_state', `expected_state_seq=${expected} 与当前 state_change_seq=${pane.seq} 不符，按键未发送`, 409)
    }
  }

  protected buildSessionSnapshot() {
    return {
      type: 'session_snapshot',
      snapshot: {
        version: 'test',
        protocol: 22,
        workspaces: [],
        tabs: [],
        layouts: [],
        panes: [...this.panes.values()]
          .filter((p) => !this.tabs.get(p.tabId)?.closed)
          .map((p) => ({
            pane_id: p.paneId,
            workspace_id: p.workspaceId,
            tab_id: p.tabId,
            focused: p.focused ?? false,
            agent_status: p.name !== undefined ? p.agentStatus : 'unknown',
            cwd: p.cwd,
          })),
        agents: [...this.panes.values()]
          .filter((p) => p.name !== undefined && !this.tabs.get(p.tabId)?.closed)
          .map(agentInfoOf),
      },
    }
  }

  abstract call(target: HerdrTarget, method: string, params: Record<string, unknown>): Promise<unknown>

  async readOutput(target: HerdrTarget, cwd: string, fileName: string): Promise<string> {
    const errorFactory = this.errors.get('readOutput')
    if (errorFactory) throw errorFactory()
    this.record(target, 'readOutput', { cwd, fileName })
    const content = this.outputFiles.get(`${cwd}/.helm/${fileName}`)
    if (content === undefined) {
      throw new HelmError('herdr_output_missing', `交接文件不存在: ${cwd}/.helm/${fileName}`, 404)
    }
    return content
  }

  async removeOutput(target: HerdrTarget, cwd: string, fileName: string): Promise<void> {
    this.record(target, 'removeOutput', { cwd, fileName })
    const key = `${cwd}/.helm/${fileName}`
    if (this.outputFiles.delete(key)) this.removedFiles.push(key)
  }

  async runGate(
    target: HerdrTarget,
    command: string,
    cwd: string,
    signal?: AbortSignal,
    env?: Record<string, string>,
  ): Promise<AgentGateResult> {
    void signal
    this.record(target, 'runGate', { command, cwd, env })
    this.gateRuns += 1
    return { ok: true, output: 'remote gate ok' }
  }

  async subscribe(
    target: HerdrTarget,
    onEvent: (event: HerdrEvent) => void,
    onError: (error: unknown) => void,
  ): Promise<() => void> {
    if (this.subscribeAck === 'fail') {
      throw new HelmError('herdr_socket', 'subscribe failed', 502)
    }
    this.record(target, 'events.subscribe', {})
    this.eventListeners.push(onEvent)
    void onError
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== onEvent)
    }
  }

  emit(event: HerdrEvent): void {
    for (const listener of [...this.eventListeners]) listener(event)
  }

  advancePane(paneId: string, status: HerdrPaneStatus): void {
    const pane = this.panes.get(paneId)
    if (!pane) return
    pane.agentStatus = status
    pane.seq += 1
    if (pane.launchPending !== undefined) pane.launchPending = false
    this.emit({ type: 'pane.updated', paneId: pane.paneId })
  }
}
