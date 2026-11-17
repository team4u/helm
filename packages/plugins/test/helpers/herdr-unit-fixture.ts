/**
 * builtin:herdr 零参插件的单元级受控环境（herdr*.test.ts 共享）。
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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  HelmError,
  type AgentGateResult,
  type AskResult,
  type ConversationSummary,
  type HelmHostNodeIpcPort,
  type MaybePromise,
  type Profile,
  type RpcResult,
} from '@helm/protocol'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { PluginHost, type PluginHostBackend } from '../../../kernel/src/plugins/index.js'
import type { WorkflowRunSummary } from '../../src/contracts.js'
import { createHerdrPlugin } from '../../src/herdr.js'
import type { HerdrEvent, HerdrPluginDependencies, HerdrTarget, HerdrTransport } from '../../src/herdr/contracts.js'
import { SEND_KEYS_CAS_CAPABILITY } from '../../src/herdr/rpc.js'
import { MemoryConfigStore, MemoryDocStore, makeConversationSummary } from './plugin-test-env.js'

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

function eventWireFrame(event: HerdrEvent): string {
  if (event.type === 'tab.closed') {
    return `${JSON.stringify({ event: 'tab_closed', data: { tab_id: event.tabId, workspace_id: event.workspaceId } })}\n`
  }
  if (event.type === 'workspace.closed') {
    return `${JSON.stringify({ event: 'workspace_closed', data: { workspace_id: event.workspaceId } })}\n`
  }
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
  targetOf: () => HerdrTarget = () => ({}),
): Promise<ServedTransport> {
  const sockets = new Set<Socket>()
  const socketsWithReleases: Array<{ socket: Socket; release: () => void }> = []
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
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
              const filters = Array.isArray(request.params['subscriptions']) ? (request.params['subscriptions'] as Array<Record<string, unknown>>) : []
              const paneIds = filters
                .filter((f) => f['type'] === 'pane.agent_status_changed' && typeof f['pane_id'] === 'string' && f['pane_id'] !== '')
                .map((f) => f['pane_id'] as string)
              const release = await transport.subscribe(targetOf(), (event) => {
                writeFrame(eventWireFrame(event))
              }, () => {
                socket.destroy()
              }, { paneIds })
              writeFrame(`${JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })}\n`)
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

function isPosixWritablePath(cwd: string): boolean {
  return cwd.startsWith('/') && !cwd.startsWith('//')
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
    if (ensureDir && isPosixWritablePath(paneCwd)) ensureHelmDir(paneCwd)
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
    if (ensureDir && isPosixWritablePath(path)) ensureHelmDir(path)
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

/**
 * 标准受控 `HerdrTransport` 实现：统一承载 `herdr.test.ts`、`herdr-send-keys-cas.test.ts`、
 * `herdr-node-routing.test.ts` 与 `herdr-attachments.test.ts` 所需的全部协议方法。
 */
export class StandardFakeHerdrTransport extends BaseFakeHerdrTransport {
  /** true = start 直接置 idle；false = 模拟真实服务端 unknown + launch_pending 序列。 */
  startReady = true
  ensureDirOnCreate = true
  autoCloseEmptyWorkspace = true
  afterSendKeys: HerdrPaneStatus = 'working'
  raceKeysOnSend = false
  pongVersion = 'test-server'
  pongResultOverride: unknown = undefined
  waitAbort: AbortSignal | undefined
  waitBreaks = 0
  snapshotText: string | undefined

  async call(target: HerdrTarget, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.record(target, method, params)
    const errorFactory = this.errors.get(method)
    if (errorFactory) throw errorFactory()
    switch (method) {
      case 'tab.create':
        return this.createTabPane(params, this.ensureDirOnCreate)
      case 'worktree.create':
        return this.createWorktreePane(params, this.ensureDirOnCreate)
      case 'tab.close': {
        const tabId = params['tab_id'] as string
        const tab = this.tabs.get(tabId)
        if (!tab) throw new HelmError('tab_not_found', `no tab ${tabId}`, 404)
        tab.closed = true
        if (this.autoCloseEmptyWorkspace) {
          const pane = [...this.panes.values()].find((p) => p.tabId === tabId)
          if (pane && ![...this.panes.values()].some((p) => p.workspaceId === pane.workspaceId && !this.tabs.get(p.tabId)?.closed)) {
            const workspace = this.workspaces.get(pane.workspaceId)
            if (workspace) workspace.closed = true
          }
        }
        return { type: 'ok' }
      }
      case 'workspace.close': {
        const wsId = params['workspace_id'] as string
        const ws = this.workspaces.get(wsId)
        if (!ws) throw new HelmError('workspace_not_found', `no workspace ${wsId}`, 404)
        ws.closed = true
        return { type: 'ok' }
      }
      case 'agent.start': {
        const pane = this.paneOf(params['pane_id'])
        pane.name = params['name'] as string
        if (this.startReady) {
          pane.agentStatus = 'idle'
          pane.seq += 1
          if (pane.launchPending !== undefined) pane.launchPending = false
        } else {
          pane.agentStatus = 'unknown'
          pane.launchPending = true
        }
        return { type: 'agent_started', agent: agentInfoOf(pane), argv: [] }
      }
      case 'agent.get': {
        const pane = this.paneOf(params['target'])
        return { type: 'agent_info', agent: agentInfoOf(pane) }
      }
      case 'agent.wait': {
        const pane = this.paneOf(params['target'])
        const until = ((params['until'] as string[]) ?? []).map((s) => s as HerdrPaneStatus)
        const waitSignal = this.waitAbort
        const timeoutMs = (params['timeout_ms'] as number | undefined) ?? 20_000
        const deadline = Date.now() + timeoutMs
        while (Date.now() <= deadline) {
          if (pane.agentStatus === 'unknown' && pane.launchPending === true) {
            await delay(15)
            pane.agentStatus = 'idle'
            pane.launchPending = false
          }
          if (until.length === 0 || until.includes(pane.agentStatus)) {
            return { type: 'agent_info', agent: agentInfoOf(pane) }
          }
          try {
            await delay(10, undefined, waitSignal !== undefined ? { signal: waitSignal } : {})
          } catch {
            this.waitBreaks += 1
            break
          }
        }
        throw new HelmError('timeout', 'timed out waiting for agent status', 408)
      }
      case 'agent.prompt': {
        const pane = this.paneOf(params['target'])
        const text = params['text'] as string
        const script = this.promptStatus
        pane.agentStatus = Array.isArray(script) ? (script.shift() ?? 'idle') : script
        pane.seq += 1
        if (this.onPrompt) this.onPrompt(pane, text)
        this.emit({ type: 'pane.updated', paneId: pane.paneId })
        return { type: 'agent_prompted', agent: agentInfoOf(pane) }
      }
      case 'agent.read': {
        const pane = this.paneOf(params['target'])
        const text = this.snapshotText !== undefined ? this.snapshotText : `tail of ${pane.paneId}: SECRET-VALUE line`
        return { type: 'pane_read', read: { pane_id: pane.paneId, text } }
      }
      case 'ping':
        if (this.pongResultOverride !== undefined) return this.pongResultOverride
        return this.handlePing(this.pongVersion)
      case 'agent.send_keys': {
        const pane = this.paneOf(params['target'])
        if (this.raceKeysOnSend) {
          pane.seq += 1
          pane.agentStatus = 'working'
        }
        this.assertSendKeysCas(pane, params)
        this.sendKeysLog.push({ paneId: pane.paneId, keys: params['keys'] as string[] })
        return { type: 'ok' }
      }
      case 'agent.focus': {
        const focused = this.paneOf(params['target'])
        focused.focused = true
        return { type: 'agent_info', agent: { ...agentInfoOf(focused), focused: true } }
      }
      case 'pane.report_metadata':
        this.metadataReports.push(params)
        return { type: 'ok' }
      case 'session.snapshot':
        return this.buildSessionSnapshot()
      default:
        throw new HelmError('method_not_found', `fake transport 不支持 ${method}`, 400)
    }
  }

  consumeKeys(paneId: string, status: HerdrPaneStatus = this.afterSendKeys): void {
    this.advancePane(paneId, status)
  }
}

export function makeHerdrConversation(id: number, over: Partial<ConversationSummary> = {}): ConversationSummary {
  return makeConversationSummary({ id, cwd: '/tmp/helm-herdr-parent', model: '', ...over })
}

/**
 * 统一受控 `PluginHostBackend`：供 `herdr*.test.ts` 复用，消除各测试文件重复手写 150 行桩代码。
 */
export class HerdrFakeBackend implements PluginHostBackend {
  conversations = new Map<number, ConversationSummary>()
  events: Array<{ type: string; payload: unknown }> = []
  notifications: Array<{ title: string; body: string; level: string }> = []
  askSeqResolvers = new Set<(askId: string) => MaybePromise<number | undefined>>()
  workflowListeners = new Set<(run: WorkflowRunSummary) => void | Promise<void>>()
  typedListeners = new Map<string, Set<(payload: unknown) => void | Promise<void>>>()
  spawnEnvLog: Array<{ conversationId: number; cwd: string; nodeId: string }> = []
  gateLog: Array<{ command: string; cwd?: string; env?: Record<string, string> }> = []
  profileStore = new Map<string, Profile>()
  completeTextImpl: ((input: { conversationId: number; systemPrompt: string; text: string }) => Promise<string>) | undefined
  getArtifactImpl: ((id: string, conversationId: number) => Promise<{ id: string; name: string; mimeType: string; size: number; absPath: string }>) | undefined
  createdAsks: Array<Record<string, unknown>> = []
  cancelledAsks: Array<{ id: string; reason?: string }> = []
  pendingAskResolvers = new Map<string, (r: AskResult) => void>()
  askCreateError: Error | undefined
  spawnToken = 'SECRET-TOKEN'

  constructor() {
    this.conversations.set(1, makeHerdrConversation(1))
    this.conversations.set(2, makeHerdrConversation(2))
  }

  dispatchTrigger(): Promise<void> { return Promise.resolve() }
  submitInput(): Promise<void> { return Promise.resolve() }
  profiles = {
    list: async () => [...this.profileStore.values()],
    get: async (id: string) => this.profileStore.get(id),
    getSystem: async (id: string) => {
      throw new HelmError('not_found', `Profile ${id} 无 SYSTEM.md`, 404)
    },
    save: async () => { throw new HelmError('unsupported', 'fixture 只读', 501) },
    directory: async (id: string) => `/tmp/herdr-fixture-profiles/${id}`,
  }
  skills = {
    list: async () => [],
    readFile: async () => { throw new HelmError('unsupported', '本 fixture 无技能', 501) },
    directory: async (id: string) => `/tmp/herdr-fixture-skills/${id}`,
    ensureSkill: async () => { throw new HelmError('unsupported', '本 fixture 无技能', 501) },
  }
  secrets = {
    get: async () => undefined,
    set: async () => {},
    delete: async () => {},
    addRedaction: () => () => {},
  }
  setPluginConfig(): Promise<void> { return Promise.resolve() }
  nodeIpc: HelmHostNodeIpcPort = {
    isOnline: () => true,
    getNodeHubUrl: () => undefined,
    call: async () => { throw new HelmError('unsupported', '本 fixture 无节点 IPC', 501) },
    subscribe: async () => { throw new HelmError('unsupported', '本 fixture 无节点 IPC', 501) },
  }
  redact = (text: string) => text.replaceAll('SECRET-TOKEN', '[REDACTED]').replaceAll('SECRET-VALUE', '[REDACTED]')
  buildSpawnEnv = (conversationId: number, cwd: string, nodeId: string) => {
    this.spawnEnvLog.push({ conversationId, cwd, nodeId })
    return {
      HELM_ENV: '1',
      HELM_HUB_URL: 'http://127.0.0.1:3202',
      HELM_TOKEN: this.spawnToken,
      HELM_CWD: cwd,
      HELM_CONVERSATION_ID: String(conversationId),
    }
  }
  async getConversationDetail(): Promise<never> { throw new HelmError('unsupported', '本 fixture 无详情', 501) }
  async listArtifacts(): Promise<never[]> { return [] }
  async getArtifact(id: string, conversationId: number): Promise<{ id: string; name: string; mimeType: string; size: number; absPath: string }> {
    if (this.getArtifactImpl !== undefined) return this.getArtifactImpl(id, conversationId)
    return undefined as never
  }
  async completeText(input: { conversationId: number; systemPrompt: string; text: string }): Promise<string> {
    if (this.completeTextImpl !== undefined) return this.completeTextImpl(input)
    throw new HelmError('unsupported', '本 fixture 无模型', 501)
  }
  executionEnv = (_nodeId: string, cwd: string) => {
    if (isPosixWritablePath(cwd)) mkdirSync(cwd, { recursive: true })
    return new NodeExecutionEnv({ cwd })
  }
  withFileLock<T>(_path: string, fn: () => Promise<T>): Promise<T> { return fn() }
  async atomicWriteFile(): Promise<never> { throw new HelmError('unsupported', '本 fixture 无原子写', 501) }
  async refreshModels(): Promise<never> { throw new HelmError('unsupported', '本 fixture 无模型刷新', 501) }
  createConversation(): Promise<ConversationSummary> { return Promise.resolve(makeHerdrConversation(99)) }
  forkConversation(id: number): Promise<ConversationSummary> { return Promise.resolve(makeHerdrConversation(id + 100)) }
  listConversations(): ConversationSummary[] { return [...this.conversations.values()] }
  getConversation(id: number): ConversationSummary {
    const found = this.conversations.get(id)
    if (found === undefined) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
    return found
  }
  updateConversation(id: number): Promise<ConversationSummary> { return Promise.resolve(this.getConversation(id)) }
  manageConversation(): () => void { return () => {} }
  markConversationOwnership(): void {}
  async createAsk(spec: { id?: string }): Promise<AskResult> {
    if (this.askCreateError) throw this.askCreateError
    const id = spec.id ?? `ask-${this.createdAsks.length + 1}`
    this.createdAsks.push({ ...spec, id })
    return new Promise<AskResult>((resolve) => {
      this.pendingAskResolvers.set(id, resolve)
    })
  }
  answerAsk(id: string, result: AskResult): void {
    this.pendingAskResolvers.get(id)?.(result)
    this.pendingAskResolvers.delete(id)
  }
  async cancelAsk(id: string, reason?: 'cancelled' | 'superseded'): Promise<void> {
    this.cancelledAsks.push({ id, reason })
    this.pendingAskResolvers.get(id)?.({ id, status: reason === 'cancelled' ? 'cancelled' : 'superseded', answers: {} })
    this.pendingAskResolvers.delete(id)
  }
  registerAskSeqResolver(resolver: (askId: string) => MaybePromise<number | undefined>): () => void {
    this.askSeqResolvers.add(resolver)
    return () => { this.askSeqResolvers.delete(resolver) }
  }
  async abortConversation(): Promise<void> {}
  getConversationOwnership(): 'helm' | 'bot' | 'human' { return 'human' }
  isClosing(): boolean { return false }
  async spawnAgent(): Promise<unknown> { return {} }
  async runGate(command: string, options?: { cwd?: string; env?: Record<string, string> }): Promise<{ ok: boolean; output: string }> {
    this.gateLog.push({ command, cwd: options?.cwd, env: options?.env })
    return { ok: true, output: 'local gate ok' }
  }
  async invokeAction(): Promise<unknown> { return {} }
  prepareAction(): { idempotent: boolean } { return { idempotent: false } }
  async execEnv(): Promise<import('@helm/protocol').EnvExecResponse> {
    throw new HelmError('unsupported', '本 fixture 不执行节点命令', 501)
  }
  withFileMutationQueue(): Promise<never> { throw new Error('本 fixture 不承载文件互斥队列') }
  redactText(text: string): string { return text }
  async resolveSpawnTarget(): Promise<never> { throw new HelmError('unsupported', '本 fixture 不解析 spawn 靶点', 501) }
  listActiveSpawnExecutions(): [] { return [] }
  async inspectNodePathUsage(): Promise<never> { throw new HelmError('unsupported', '本 fixture 不扫描进程占用', 501) }
  listActions(): [] { return [] }
  onEvent(type: string, listener: (payload: unknown) => void | Promise<void>): () => void {
    const set = this.typedListeners.get(type) ?? new Set()
    set.add(listener)
    this.typedListeners.set(type, set)
    if (type === 'workflow.settled') {
      this.workflowListeners.add(listener as (run: WorkflowRunSummary) => void | Promise<void>)
    }
    return () => {
      set.delete(listener)
      this.workflowListeners.delete(listener as (run: WorkflowRunSummary) => void | Promise<void>)
    }
  }
  async emitEvent(type: string, payload: unknown): Promise<void> {
    this.events.push({ type, payload })
    if (type === 'notification') {
      const n = payload as { title: string; body: string; level: string }
      this.notifications.push(n)
    }
    for (const listener of [...(this.typedListeners.get(type) ?? [])]) {
      await listener(payload)
    }
  }
}

export interface HerdrUnitEnvOptions<TTransport extends HerdrTransport = StandardFakeHerdrTransport> {
  enabled?: boolean
  docs?: MemoryDocStore
  dataDir?: string
  socketPath?: string
  localTarget?: HerdrTarget
  transport?: TTransport
  backend?: HerdrFakeBackend
  config?: Record<string, unknown>
  conversationOverrides?: Partial<ConversationSummary>
  hubUrls?: Record<string, string>
  timingOverrides?: Parameters<typeof createHerdrPlugin>[0]
  analyzeBlockedSnapshot?: (input: { snapshot: string; conversationId: number }) => Promise<string>
}

export interface HerdrUnitEnv<TTransport extends HerdrTransport = StandardFakeHerdrTransport> {
  host: PluginHost
  backend: HerdrFakeBackend
  transport: TTransport
  docs: MemoryDocStore
  dataDir: string
  socketPath: string
  parentCwd: string
  profiles: Map<string, Profile>
  spawnEnvLog: Array<{ conversationId: number; cwd: string; nodeId: string }>
  gateLog: Array<{ command: string; cwd?: string; env?: Record<string, string> }>
  close(): Promise<void>
}

/**
 * 打开真实 `PluginHost` + UDS `serveTransport` 的单元级 Herdr 测试环境。
 */
export async function openHerdrUnitEnv<TTransport extends HerdrTransport = StandardFakeHerdrTransport>(
  options: HerdrUnitEnvOptions<TTransport> = {},
): Promise<HerdrUnitEnv<TTransport>> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'helm-herdr-unit-'))
  const backend = options.backend ?? new HerdrFakeBackend()
  const parentCwd = options.conversationOverrides?.cwd ?? join(dataDir, 'parent')
  if (isPosixWritablePath(parentCwd)) ensureHelmDir(parentCwd)
  const parentConversation = backend.conversations.get(1)
  if (parentConversation !== undefined) {
    Object.assign(parentConversation, options.conversationOverrides, { cwd: parentCwd })
  }
  const docs = options.docs ?? new MemoryDocStore()
  const transport = (options.transport ?? new StandardFakeHerdrTransport()) as TTransport
  if (options.analyzeBlockedSnapshot !== undefined) {
    const analyze = options.analyzeBlockedSnapshot
    backend.completeTextImpl = async (input) => analyze({ snapshot: input.text, conversationId: input.conversationId })
  }

  const socketPath = options.socketPath ?? join(dataDir, 'herdr.sock')
  const localTarget = options.localTarget ?? {}
  let routedNodeId: string | undefined
  const served = await serveTransport(transport, socketPath, () =>
    routedNodeId !== undefined && routedNodeId !== 'local' ? { nodeId: routedNodeId } : localTarget,
  )
  const hubUrls = options.hubUrls
  backend.nodeIpc = {
    isOnline: (nodeId: string) => hubUrls === undefined || nodeId === 'local' || nodeId in hubUrls || nodeId === 'remote-node',
    getNodeHubUrl: (nodeId: string) => hubUrls?.[nodeId],
    call: async (nodeId, input, signal) => {
      signal?.throwIfAborted()
      routedNodeId = nodeId
      try {
        return await ipcLineCall(socketPath, input.line, input.timeoutMs, signal)
      } finally {
        routedNodeId = undefined
      }
    },
    subscribe: async () => { throw new HelmError('unsupported', '本 fixture 无节点 IPC 订阅', 501) },
  }

  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    host: backend,
    docs,
    config: new MemoryConfigStore({ ...(options.config ?? {}), socketPath }),
  })
  try {
    await host.register(
      createHerdrPlugin({
        ...HERDR_FAST_TEST_TIMINGS,
        ...options.timingOverrides,
      }),
      { enabled: options.enabled ?? true },
    )
  } catch (error) {
    await host.dispose().catch(() => {})
    await served.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
    throw error
  }

  return {
    host,
    backend,
    transport,
    docs,
    dataDir,
    socketPath,
    parentCwd,
    profiles: backend.profileStore,
    spawnEnvLog: backend.spawnEnvLog,
    gateLog: backend.gateLog,
    async close() {
      await host.dispose().catch(() => {})
      await served.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

export function herdrFileNameOf(text: string): string {
  return text.match(/wf-out-[A-Za-z0-9_.-]+\.(json|md)/)?.[0] ?? ''
}

export async function spawnHerdrDirect(
  env: { host: PluginHost },
  request: Record<string, unknown> = {},
): Promise<unknown> {
  const outcome = await env.host.runHook('agent_spawn', {
    parentConversationId: 1,
    prompt: 'do the thing',
    ...request,
  } as never)
  if (outcome.action === 'handled') return outcome.result
  if (outcome.action === 'transform') return { __transformed: outcome.value }
  return { __notHandled: true }
}

export function herdrTurnSettledOf(conversationId: number): never {
  return {
    conversation: makeHerdrConversation(conversationId),
    inputs: [],
    outcome: 'completed',
    settledAt: Date.now(),
  } as never
}

export function scriptHerdrSuccess(
  env: { transport: Pick<BaseFakeHerdrTransport, 'promptStatus' | 'onPrompt' | 'outputFiles'> },
  content: string,
): void {
  env.transport.promptStatus = 'done'
  env.transport.onPrompt = (pane, text) => {
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${herdrFileNameOf(text)}`, content)
  }
}
