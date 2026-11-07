/**
 * builtin:herdr overview 文档整链验收。
 *
 * 被测对象：启用 builtin:herdr 后公开的 overview doc（version 2）：
 * - panes[] 覆盖本机全部窗格（含人类 shell），每行携带真实 agentStatus、
 *   仅 Agent 终端才有 stateChangeSeq（shell 未知即省略，绝不伪造）、
 *   cwd、ownedBy（helm/human）；human 行不带 Helm 任务 outcome；
 * - 事件驱动：SSE 先等 snapshot 后，窗格创建/状态/焦点/move/closed 变化
 *   应反映到 public doc；move 换 ID 后旧行消失、新行出现；
 * - 动态订阅：paneId 集合变化时主树接线会重建订阅（先全局后带 paneIds），
 *   新增窗格后最新订阅 options.paneIds 必须包含新 ID；
 * - 无事件 cwd 变化经真实 watchdogTick 刷新（kernel.watchdogTick 公开方法）；
 * - human 红线：人类窗格 blocked 不产生 Ask/不发键/不回收；停用不误关 human；
 * - 坏快照/订阅断开：doc 显式 stale+error 且保留最后成功数据，恢复即清除；
 * - 生命周期：stop 等待在途刷新后不再写旧 doc；重新启用新周期无旧回调污染。
 *
 * 基建：真实 createHelm/SQLite/PluginHost/HTTP/SSE/CLI 子进程 + 受控
 * HerdrTransport（外部协议 fixture，非实现替身）+ faux provider 零真实模型。
 * fixture 记录每次 subscribe（target/第 4 参 options）供动态订阅断言。
 *
 * 诚实性纪律：实现缺陷导致的失败如实 RED，不 skip、不 mock 实现、不改弱断言。
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'

import { createHelm } from '../src/app.js'
import { startHub } from '../src/http/index.js'
import type { HerdrTarget, HerdrTransport, HerdrCallOptions, HerdrEvent } from '../src/builtin-plugins/herdr/contracts.js'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..', '..', '..')
const cliEntry = join(repoRoot, 'packages', 'cli', 'src', 'index.ts')
const require = createRequire(import.meta.url)
const tsxCli = require.resolve('tsx/cli')

const PLUGIN_ID = 'builtin:herdr'
const DOC_NAME = 'overview'
const PASSWORD = 'herdr验收密码八位'

// ---------------------------------------------------------------------------
// 受控 HerdrTransport fixture：真实 createHelm 走完整接线，仅外部协议可编程
// ---------------------------------------------------------------------------

/** 单个受控窗格：fixture 内部状态（快照行 + 可选 AgentInfo）。 */
interface FixturePane {
  paneId: string
  tabId: string
  workspaceId: string
  focused: boolean
  agentStatus: string
  cwd?: string
  label?: string
  agent?: string
  /** 存在即该窗格是 Agent 终端：附 stateChangeSeq/name。 */
  seq?: number
  agentName?: string
}

interface SubscribeRecord {
  target: HerdrTarget
  options?: { paneIds?: string[]; signal?: AbortSignal }
  /** 注入事件入口（订阅存活期间）。 */
  emit: (event: HerdrEvent) => void
  onError: (error: unknown) => void
  release: () => void
  released: () => boolean
}

function pane(
  paneId: string,
  overrides: Partial<FixturePane> = {},
): FixturePane {
  return {
    paneId,
    tabId: `${paneId}-tab`,
    workspaceId: `${paneId}-ws`,
    focused: false,
    agentStatus: 'unknown',
    ...overrides,
  }
}

function herdrFixture(initial: FixturePane[] = []) {
  const state = { panes: new Map<string, FixturePane>(initial.map((p) => [p.paneId, p])) }
  const subscriptions: SubscribeRecord[] = []
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  /** snapshot 调用可编程失败（stale/error 场景）；参数为本次调用的方法名。 */
  let snapshotFailure: Error | undefined
  let beforePaneSubscriptionAck: (() => void) | undefined
  const events = new Set<(e: HerdrEvent) => void>()
  let subscriptionErrors = new Set<(error: unknown) => void>()

  function snapshotResult() {
    return {
      type: 'session_snapshot',
      snapshot: {
        agents: [...state.panes.values()]
          .filter((p) => p.seq !== undefined)
          .map((p) => ({
            pane_id: p.paneId,
            tab_id: p.tabId,
            workspace_id: p.workspaceId,
            ...(p.agent !== undefined ? { agent: p.agent } : {}),
            ...(p.agentName !== undefined ? { name: p.agentName } : {}),
            agent_status: p.agentStatus,
            state_change_seq: p.seq,
            launch_pending: false,
            interactive_ready: p.agentStatus === 'idle',
            focused: p.focused,
            ...(p.cwd !== undefined ? { cwd: p.cwd, foreground_cwd: p.cwd } : {}),
          })),
        panes: [...state.panes.values()].map((p) => ({
          pane_id: p.paneId,
          workspace_id: p.workspaceId,
          tab_id: p.tabId,
          focused: p.focused,
          agent_status: p.agentStatus,
          ...(p.cwd !== undefined ? { cwd: p.cwd, foreground_cwd: p.cwd } : {}),
          ...(p.label !== undefined ? { label: p.label } : {}),
          ...(p.agent !== undefined ? { agent: p.agent } : {}),
        })),
        tabs: [],
        workspaces: [],
      },
    }
  }

  const transport: HerdrTransport = {
    async call(_target: HerdrTarget, method: string, params: Record<string, unknown>, _options?: HerdrCallOptions) {
      calls.push({ method, params })
      if (method === 'session.snapshot') {
        if (snapshotFailure !== undefined) throw snapshotFailure
        return snapshotResult()
      }
      throw new Error(`fixture 未编排方法 ${method}`)
    },
    async readOutput() {
      throw new Error('overview 测试不应读取交接文件')
    },
    async removeOutput() {
      throw new Error('overview 测试不应删除交接文件')
    },
    async runGate() {
      throw new Error('overview 测试不应执行 Gate')
    },
    async subscribe(
      target: HerdrTarget,
      onEvent: (event: HerdrEvent) => void,
      onError: (error: unknown) => void,
      options?: { paneIds?: string[]; signal?: AbortSignal },
    ) {
      options?.signal?.throwIfAborted()
      const deliver = (event: HerdrEvent) => onEvent(event)
      const rec: SubscribeRecord = {
        target: structuredClone(target),
        options,
        emit: (event) => onEvent(event),
        onError: (error) => onError(error),
        release: () => {},
        released: () => false,
      }
      let releasedFlag = false
      rec.release = () => {
        if (releasedFlag) return
        releasedFlag = true
        events.delete(deliver)
        subscriptionErrors.delete(onError)
        options?.signal?.removeEventListener('abort', rec.release)
      }
      rec.released = () => releasedFlag
      subscriptions.push(rec)
      events.add(deliver)
      subscriptionErrors.add(onError)
      options?.signal?.addEventListener('abort', rec.release, { once: true })
      if (options?.paneIds?.length && beforePaneSubscriptionAck) {
        const hook = beforePaneSubscriptionAck
        beforePaneSubscriptionAck = undefined
        hook()
      }
      return () => rec.release()
    },
  }

  return {
    transport,
    state,
    subscriptions,
    calls,
    /** 直接经当前活跃订阅注入事件（模拟真实事件流帧）。 */
    emit(event: HerdrEvent) {
      for (const fn of events) fn(event)
    },
    /** 断开全部活跃订阅（模拟 socket 断开）。 */
    breakSubscriptions() {
      const errs = [...subscriptionErrors]
      subscriptionErrors = new Set()
      events.clear()
      for (const fn of errs) fn(new Error('fixture: 连接断开'))
    },
    setSnapshotFailure(error: Error | undefined) {
      snapshotFailure = error
    },
    beforeNextPaneSubscriptionAck(hook: () => void) {
      beforePaneSubscriptionAck = hook
    },
    snapshotCalls: () => calls.filter((c) => c.method === 'session.snapshot').length,
    /** 最近一次带 paneIds 的订阅（主树接线：窗格集合变化后重建）。 */
    lastPaneIdsSubscription: (): SubscribeRecord | undefined =>
      [...subscriptions].reverse().find((s) => !s.released() && s.options?.paneIds !== undefined),
  }
}

// ---------------------------------------------------------------------------
// 组合环境：真实 createHelm + Hub HTTP + SSE
// ---------------------------------------------------------------------------

interface Env {
  dataDir: string
  app: Awaited<ReturnType<typeof createHelm>>
  hub: Awaited<ReturnType<typeof startHub>>
  base: string
  token: string
  credential: { token: string; dispose(): void }
  close(): Promise<void>
}

async function openEnv(dataDir: string, transport: HerdrTransport): Promise<Env> {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models, herdrTransport: transport, watchdogIntervalMs: 0 })
  const hub = await startHub({ kernel: app.kernel, workflows: app.workflows, port: 0 })
  const setup = await fetch(`${hub.url}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  assert.equal(setup.status, 200, 'auth setup 失败')
  const token = (JSON.parse(await setup.text()) as { token: string }).token
  const credential = app.kernel.auth.createProcessToken()
  return {
    dataDir,
    app,
    hub,
    base: hub.url,
    token,
    credential,
    async close() {
      credential.dispose()
      await hub.close()
      await app.close()
    },
  }
}

function fixtureHttp(base: string, token: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (body !== undefined) headers['content-type'] = 'application/json'
  return fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
}

async function readOverview(base: string, token: string): Promise<{ status: number; value?: OverviewShape }> {
  const res = await fixtureHttp(
    base,
    token,
    'GET',
    `/api/plugins/${encodeURIComponent(PLUGIN_ID)}/docs/${encodeURIComponent(DOC_NAME)}`,
  )
  if (res.status !== 200) return { status: res.status }
  return { status: 200, value: (JSON.parse(await res.text()) as { value: OverviewShape }).value }
}

interface OverviewRowShape {
  nodeId?: string
  paneId: string
  tabId?: string
  workspaceId?: string
  ownedBy: 'helm' | 'human'
  agentStatus: string
  stateChangeSeq?: number
  cwd?: string
  focused?: boolean
  outcome?: string
  pendingAsk?: boolean
}

interface OverviewShape {
  version: number
  updatedAt: number
  stale: boolean
  error?: string
  panes: OverviewRowShape[]
  asks?: Array<{ paneId: string; nodeId: string; seq: number; phase: string }>
}

/** 原子等待 doc 满足条件（轮询真实落库状态；超时失败，不静默兜底）。 */
async function waitForOverview(
  base: string,
  token: string,
  predicate: (doc: OverviewShape) => boolean,
  timeoutMs = 15_000,
): Promise<OverviewShape> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const doc = await readOverview(base, token)
    assert.equal(doc.status, 200, 'overview doc 应为公开可读')
    if (predicate(doc.value!)) return doc.value!
    if (Date.now() > deadline) assert.fail('waitForOverview 超时：条件在限定时间内未成立')
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** SSE 订阅：先等 snapshot 首帧就绪再触发被测行为；返回真实增量帧。 */
function openSse(
  base: string,
  token: string,
  until: (frames: string[]) => boolean,
  timeoutMs = 20_000,
): { frames: Promise<string[]>; ready: Promise<void> } {
  let signalReady!: () => void
  const ready = new Promise<void>((resolve) => (signalReady = resolve))
  const frames = (async () => {
    const controller = new AbortController()
    const collected: string[] = []
    let readyFired = false
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${base}/api/events`, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      assert.equal(response.status, 200)
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        if (until(collected)) break
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index: number
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          collected.push(frame)
          if (!readyFired && frame.startsWith('event: snapshot')) {
            readyFired = true
            signalReady()
          }
        }
      }
      return collected
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return collected
      if (error instanceof TypeError && /abort|terminated|other side closed/i.test(String((error.cause as Error | undefined)?.message ?? error.message))) {
        return collected
      }
      throw error
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  })()
  return { frames, ready }
}

/** 真实 CLI 子进程（tsx loader 直跑源码；--json 输出）。 */
function runCliChild(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 25_000,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli, cliEntry, ...args, '--json'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')))
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: null, out, err })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
  })
}

function cliEnv(env: Env): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HELM_HUB_URL: env.base,
    HELM_DATA_DIR: join(env.dataDir, 'cli'),
    HELM_TOKEN: env.credential.token,
  }
}

/** 启用插件并等待首次 overview doc 投射完成。 */
async function enableAndWait(env: Env, fixture: ReturnType<typeof herdrFixture>): Promise<OverviewShape> {
  const res = await fixtureHttp(env.base, env.token, 'POST', `/api/plugins/${encodeURIComponent(PLUGIN_ID)}/enable`)
  assert.equal(res.status, 200, `enable 失败：${await res.text()}`)
  return waitForOverview(env.base, env.token, (doc) => doc.updatedAt > 0)
}

// ---------------------------------------------------------------------------
// HO1: 启用前已有 human Agent 与普通 shell，全量投射 + HTTP/CLI 同一数据
// ---------------------------------------------------------------------------

test('HO1: 启用即投射全部本机窗格（human Agent 有 seq、shell unknown 无 seq、无 outcome），HTTP 与真实 CLI 读到同一数据', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-ho1-'))
  const fixture = herdrFixture([
    pane('human-agent', { agentStatus: 'working', seq: 7, agentName: 'claude-main', agent: 'claude', cwd: '/home/me/proj', focused: true, label: '人类终端' }),
    pane('plain-shell', { agentStatus: 'unknown', cwd: '/tmp' }),
  ])
  const env = await openEnv(dir, fixture.transport)
  try {
    const doc = await enableAndWait(env, fixture)
    assert.equal(doc.version, 2)
    assert.equal(doc.stale, false)
    assert.equal(doc.error, undefined)
    assert.equal(doc.panes.length, 2, '启用时已有窗格必须全量出现在 overview')

    const agentRow = doc.panes.find((p) => p.paneId === 'human-agent')!
    assert.ok(agentRow, 'human Agent 窗格应在 doc')
    assert.equal(agentRow.ownedBy, 'human', '非 Helm 派生窗格一律 human')
    assert.equal(agentRow.agentStatus, 'working')
    assert.equal(agentRow.stateChangeSeq, 7, 'Agent 终端行携带真实 seq')
    assert.equal(agentRow.cwd, '/home/me/proj')
    assert.equal(agentRow.outcome, undefined, 'human 行不得携带 Helm 任务 outcome')
    assert.equal('pendingAsk' in agentRow, false, 'human 行不得携带管理审批状态')

    const shellRow = doc.panes.find((p) => p.paneId === 'plain-shell')!
    assert.ok(shellRow, '普通 shell 窗格应在 doc')
    assert.equal(shellRow.ownedBy, 'human')
    assert.equal(shellRow.agentStatus, 'unknown', 'shell 状态官方语义为 unknown')
    assert.equal('stateChangeSeq' in shellRow, false, 'shell 无 seq：字段必须省略而非伪造 0')
    assert.equal(shellRow.outcome, undefined)

    // 真实 CLI（子进程）读全局 doc：plugins doc 不支持也不需要 --current
    const cli = await runCliChild(['plugins', 'doc', PLUGIN_ID, DOC_NAME], cliEnv(env))
    assert.equal(cli.code, 0, `CLI 失败：${cli.err}`)
    assert.ok(!(cli.out + cli.err).includes(env.credential.token), 'CLI 输出不得泄漏进程 token')
    const cliDoc = (JSON.parse(cli.out) as { value: OverviewShape }).value
    assert.equal(cliDoc.version, 2)
    assert.deepEqual(
      cliDoc.panes.map((p) => [p.paneId, p.ownedBy, p.agentStatus, p.stateChangeSeq]).sort(),
      doc.panes.map((p) => [p.paneId, p.ownedBy, p.agentStatus, p.stateChangeSeq]).sort(),
      'HTTP doc 与 CLI doc 必须是同一数据',
    )
  } finally {
    await env.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// HO2: SSE 增量：创建/更新/焦点/move/closed + 动态 per-pane 订阅 paneIds
// ---------------------------------------------------------------------------

test('HO2: SSE 先等 snapshot，随后创建/更新/焦点/move/closed 事件反映到 public doc，最新订阅 paneIds 覆盖新窗格', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-ho2-'))
  const fixture = herdrFixture([pane('plain-shell')])
  const env = await openEnv(dir, fixture.transport)
  try {
    await enableAndWait(env, fixture)

    const sse = openSse(
      env.base,
      env.token,
      (fs) =>
        fs.filter((f) => f.includes('event: plugin.doc.updated') && f.includes(PLUGIN_ID) && f.includes(DOC_NAME)).length >= 3,
    )
    await sse.ready

    // 创建新 Agent 窗格（事件驱动重取快照）
    fixture.state.panes.set('new-agent', pane('new-agent', { agentStatus: 'idle', seq: 1, agentName: 'helm-wf-x1', agent: 'pi' }))
    fixture.emit({ type: 'pane.created', paneId: 'new-agent' })
    await waitForOverview(env.base, env.token, (d) => d.panes.some((p) => p.paneId === 'new-agent' && p.agentStatus === 'idle'))
    // 主树动态接线：paneId 集合变化后最新订阅 options.paneIds 必须包含新 ID
    const paneIdsSub = fixture.lastPaneIdsSubscription()
    assert.ok(paneIdsSub, '窗格集合变化后应存在带 paneIds 的订阅')
    assert.ok(
      (paneIdsSub.options?.paneIds ?? []).includes('new-agent'),
      `最新订阅 paneIds 应包含新窗格 new-agent，实际：${JSON.stringify(paneIdsSub.options?.paneIds)}`,
    )

    // 状态专用事件不依赖 pane.updated，且本次不推进 seq。
    fixture.state.panes.get('new-agent')!.agentStatus = 'working'
    fixture.emit({ type: 'pane.agent_status_changed', paneId: 'new-agent' })
    await waitForOverview(env.base, env.token, (d) => d.panes.find((p) => p.paneId === 'new-agent')?.agentStatus === 'working')

    // 焦点切换
    fixture.state.panes.get('new-agent')!.focused = true
    fixture.state.panes.get('plain-shell')!.focused = false
    fixture.emit({ type: 'pane.focused', paneId: 'new-agent' })
    await waitForOverview(env.base, env.token, (d) => d.panes.find((p) => p.paneId === 'new-agent')?.focused === true)

    // move：官方换 pane ID（旧 ID 消失、新 ID 加入）
    fixture.state.panes.delete('new-agent')
    fixture.state.panes.set('moved-agent', pane('moved-agent', { agentStatus: 'working', seq: 1, agentName: 'helm-wf-x1', agent: 'pi', cwd: '/w' }))
    fixture.emit({ type: 'pane.moved', paneId: 'moved-agent' })
    await waitForOverview(env.base, env.token, (d) =>
      d.panes.some((p) => p.paneId === 'moved-agent') && !d.panes.some((p) => p.paneId === 'new-agent'),
    )
    const paneIdsAfterMove = fixture.lastPaneIdsSubscription()?.options?.paneIds ?? []
    assert.ok(paneIdsAfterMove.includes('moved-agent'), 'move 后最新订阅 paneIds 应包含新 ID')
    assert.ok(!paneIdsAfterMove.includes('new-agent'), 'move 后最新订阅 paneIds 不应再含旧 ID')

    // closed：行消失
    fixture.state.panes.delete('plain-shell')
    fixture.emit({ type: 'pane.closed', paneId: 'plain-shell' })
    await waitForOverview(env.base, env.token, (d) => !d.panes.some((p) => p.paneId === 'plain-shell'))

    // 官方关闭整标签页不逐个发 pane.closed；只凭 tab.closed 也必须移除窗格。
    const moved = fixture.state.panes.get('moved-agent')!
    fixture.state.panes.delete('moved-agent')
    fixture.emit({ type: 'tab.closed', tabId: moved.tabId, workspaceId: moved.workspaceId })
    await waitForOverview(env.base, env.token, (d) => d.panes.length === 0)

    const workspaceShell = pane('workspace-shell')
    fixture.state.panes.set(workspaceShell.paneId, workspaceShell)
    fixture.emit({ type: 'pane.created', paneId: workspaceShell.paneId })
    await waitForOverview(env.base, env.token, (d) => d.panes.length === 1)
    fixture.state.panes.delete(workspaceShell.paneId)
    fixture.emit({ type: 'workspace.closed', workspaceId: workspaceShell.workspaceId })
    await waitForOverview(env.base, env.token, (d) => d.panes.length === 0)

    const frames = await sse.frames
    const docFrames = frames.filter((f) => f.includes('event: plugin.doc.updated') && f.includes(PLUGIN_ID) && f.includes(DOC_NAME))
    assert.ok(docFrames.length >= 3, `SSE 应收到 overview doc 增量事件，实际 ${docFrames.length} 帧`)
    assert.ok(docFrames.every((f) => !f.includes(env.token)), 'SSE 帧不得泄漏 token')
  } finally {
    await env.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// HO3: 无事件同 seq cwd 变化经真实 watchdogTick 刷新
// ---------------------------------------------------------------------------

test('HO3: 无事件、同 seq 的 cwd 变化经 kernel.watchdogTick 重取快照后在 doc 可见', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-ho3-'))
  const fixture = herdrFixture([pane('human-agent', { agentStatus: 'working', seq: 5, agentName: 'claude-main', cwd: '/old' })])
  const env = await openEnv(dir, fixture.transport)
  try {
    const doc = await enableAndWait(env, fixture)
    assert.equal(doc.panes.find((p) => p.paneId === 'human-agent')?.cwd, '/old')

    // 官方 cd 不发事件、不推进 seq：仅改 cwd 后直接跑真实 tick
    fixture.state.panes.get('human-agent')!.cwd = '/new/after/cd'
    const before = fixture.snapshotCalls()
    await env.app.kernel.watchdogTick()
    const after = await waitForOverview(env.base, env.token, (d) => d.panes.find((p) => p.paneId === 'human-agent')?.cwd === '/new/after/cd')
    assert.ok(fixture.snapshotCalls() > before, 'watchdogTick 应触发 session.snapshot 重取')
    assert.equal(after.panes.find((p) => p.paneId === 'human-agent')?.stateChangeSeq, 5, 'cwd 变化不推进 seq')
  } finally {
    await env.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// HO4: human 红线——blocked 人类窗格不建 Ask/不发键/不回收；停用不误关 human
// ---------------------------------------------------------------------------

test('HO4: 人类窗格 blocked 只如实投射状态，不产生 Ask、不发送按键、不回收；停用/关停不向 human 窗格发指令', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-ho4-'))
  const fixture = herdrFixture([
    pane('human-blocked', { agentStatus: 'blocked', seq: 3, agentName: 'claude-main', agent: 'claude', cwd: '/p' }),
    pane('human-shell', { agentStatus: 'unknown', cwd: '/p' }),
  ])
  const env = await openEnv(dir, fixture.transport)
  try {
    const doc = await enableAndWait(env, fixture)
    assert.equal(doc.panes.find((p) => p.paneId === 'human-blocked')?.agentStatus, 'blocked', 'blocked 状态如实投射')
    assert.equal(doc.asks?.length ?? 0, 0, 'human 窗格 blocked 绝不产生 Ask')

    // blocked 事件再来一次（事件路径同样不得对 human 建 Ask/发键）
    fixture.emit({ type: 'pane.updated', paneId: 'human-blocked' })
    await waitForOverview(env.base, env.token, (d) => d.panes.some((p) => p.paneId === 'human-blocked'))
    assert.equal((await readOverview(env.base, env.token)).value!.asks?.length ?? 0, 0)

    // 真实 tick：Watchdog 对 human 窗格只读采集
    await env.app.kernel.watchdogTick()
    assert.equal((await readOverview(env.base, env.token)).value!.asks?.length ?? 0, 0, 'watchdogTick 不得对 human 产生 Ask/probe 动作')
    const mutating = fixture.calls.filter((c) => !['session.snapshot', 'agent.get', 'events.subscribe'].includes(c.method))
    assert.deepEqual(mutating, [], 'human 窗格存在时不得出现任何变更类 RPC（send_keys/close 等）')

    // 停用：订阅释放且不对 human 窗格发送任何指令
    const disable = await fixtureHttp(env.base, env.token, 'POST', `/api/plugins/${encodeURIComponent(PLUGIN_ID)}/disable`)
    assert.equal(disable.status, 200, `disable 失败：${await disable.text()}`)
    await new Promise((r) => setTimeout(r, 200))
    const mutatingAfterStop = fixture.calls.filter((c) => !['session.snapshot', 'agent.get', 'events.subscribe'].includes(c.method))
    assert.deepEqual(mutatingAfterStop, [], '停用不得向 human 窗格发送任何按键/关闭指令')
    assert.ok(fixture.subscriptions.length > 0 && fixture.subscriptions.every((s) => s.released()), '停用后全部订阅必须释放')
  } finally {
    await env.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// HO5: 坏快照/订阅断开 → 显式 stale+error 且保留旧数据；恢复清除
// ---------------------------------------------------------------------------

test('HO5: snapshot 读取失败与订阅断开都显式置 stale+error 并保留最后成功数据，恢复成功后清除', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-ho5-'))
  const fixture = herdrFixture([pane('human-agent', { agentStatus: 'idle', seq: 2, agentName: 'claude-main' })])
  const env = await openEnv(dir, fixture.transport)
  try {
    const doc0 = await enableAndWait(env, fixture)
    assert.equal(doc0.stale, false)
    const lastGood = doc0.panes.map((p) => p.paneId)

    // 坏快照：刷新失败 → stale+error，panes 保留最后成功数据
    fixture.setSnapshotFailure(new Error('herdr socket: connection refused'))
    fixture.emit({ type: 'pane.updated', paneId: 'human-agent' })
    const staled = await waitForOverview(env.base, env.token, (d) => d.stale === true && d.error !== undefined && d.error !== '')
    assert.deepEqual(staled.panes.map((p) => p.paneId), lastGood, '错误期间必须保留最后成功 panes 数据')
    assert.ok(staleErrorMentions(staled), `error 应含诊断信息，实际：${staled.error}`)

    // 恢复成功：stale/error 清除
    fixture.setSnapshotFailure(undefined)
    fixture.emit({ type: 'pane.updated', paneId: 'human-agent' })
    await waitForOverview(env.base, env.token, (d) => d.stale === false && d.error === undefined)

    // 订阅断开：同样显式 stale（经通知暴露），恢复路径由重取对齐
    fixture.breakSubscriptions()
    const afterBreak = await waitForOverview(env.base, env.token, (d) => d.stale && Boolean(d.error))
    assert.deepEqual(afterBreak.panes.map((p) => p.paneId), lastGood, '断开后保留最后成功数据，不伪造空表')
    await env.app.kernel.watchdogTick()
    await waitForOverview(env.base, env.token, (d) => !d.stale && d.error === undefined)
  } finally {
    await env.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

function staleErrorMentions(doc: OverviewShape): boolean {
  return typeof doc.error === 'string' && doc.error.length > 0
}

// ---------------------------------------------------------------------------
// HO6: 生命周期——stop 收尾与重新启用无旧回调污染
// ---------------------------------------------------------------------------

test('HO6: 停用后订阅全部释放且不再写旧 doc，重新启用进入新周期数据无旧回调污染', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-ho6-'))
  const fixture = herdrFixture([pane('p1', { agentStatus: 'idle', seq: 1, agentName: 'a1' })])
  const env = await openEnv(dir, fixture.transport)
  try {
    await enableAndWait(env, fixture)

    // 停用：等待在途刷新收尾，之后释放函数不再投递新快照写旧 doc
    const disable = await fixtureHttp(env.base, env.token, 'POST', `/api/plugins/${encodeURIComponent(PLUGIN_ID)}/disable`)
    assert.equal(disable.status, 200)
    await new Promise((r) => setTimeout(r, 200))
    assert.ok(fixture.subscriptions.every((s) => s.released()), '停用后所有订阅释放函数必须被调用')

    // 已释放订阅的迟到事件帧（旧 socket 残留）不得写旧 doc，也不得污染下个周期：
    // ghost 不进入 fixture 快照状态，仅作为事件帧经旧订阅记录投递。
    for (const s of fixture.subscriptions) {
      s.emit({ type: 'pane.created', paneId: 'ghost' })
    }
    const docAfterStop = await readOverview(env.base, env.token)
    assert.equal(docAfterStop.status, 404, '停用后 public doc 不可读（旧周期不得再写）')

    // 重新启用：新周期从当前快照全量投射，不含旧周期残留
    fixture.state.panes.delete('p1')
    fixture.state.panes.set('p2', pane('p2', { agentStatus: 'working', seq: 9, agentName: 'a2' }))
    const enable = await fixtureHttp(env.base, env.token, 'POST', `/api/plugins/${encodeURIComponent(PLUGIN_ID)}/enable`)
    assert.equal(enable.status, 200)
    const doc2 = await waitForOverview(env.base, env.token, (d) => d.panes.some((p) => p.paneId === 'p2'))
    assert.ok(!doc2.panes.some((p) => p.paneId === 'p1'), '新周期不得残留旧窗格 p1')
    assert.ok(!doc2.panes.some((p) => p.paneId === 'ghost'), '停用期间旧订阅的迟到事件不得污染新周期数据')
  } finally {
    await env.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// HO7: 启用竞态——订阅 ACK 与初始 snapshot 交错时数据一致
// ---------------------------------------------------------------------------

test('HO7: 初始快照与逐窗格订阅 ACK 之间的无事件状态变化经重读收敛', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-ho7-'))
  const fixture = herdrFixture([pane('race-1', { agentStatus: 'idle', seq: 4, agentName: 'r1' })])
  const env = await openEnv(dir, fixture.transport)
  try {
    // 第一次带 paneIds 的订阅已经读取旧 snapshot；在 ACK 前修改权威状态，
    // 且不发事件，只有 ACK 后重读才能看到此次状态和新增窗格。
    let changedDuringAck = false
    fixture.beforeNextPaneSubscriptionAck(() => {
      changedDuringAck = true
      fixture.state.panes.get('race-1')!.agentStatus = 'working'
      fixture.state.panes.set('race-2', pane('race-2', { agentStatus: 'working', seq: 1, agentName: 'r2' }))
    })
    const doc = await enableAndWait(env, fixture)
    assert.equal(changedDuringAck, true)
    assert.equal(doc.panes.length, 2)
    assert.equal(doc.panes.find((p) => p.paneId === 'race-1')?.stateChangeSeq, 4)
    assert.equal(doc.panes.find((p) => p.paneId === 'race-1')?.agentStatus, 'working')
    assert.equal(doc.panes.find((p) => p.paneId === 'race-2')?.agentStatus, 'working')
    assert.ok(fixture.lastPaneIdsSubscription()?.options?.paneIds?.includes('race-2'))
  } finally {
    await env.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
