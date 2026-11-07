/**
 * builtin:superagent 跨模块整链验收测试（本文件独占；只写测试不改实现）。
 *
 * 被测对象：createHelm 组合层应注册的 builtin:superagent 插件（默认停用）。
 * 启用后应自举两个专属常驻会话——「SuperAgent 中枢」（profileId: 'superagent'）
 * 与「巡检看门狗」（profileId: 'watchdog'），动态 ID 持久化于 SuperAgentIndexDoc，
 * 不打角色 tags。公开 Doc 名称：index / subscriptions / recall-graph。
 *
 * 契约来源（已与主代理/实现同事确认的最终口径）：
 * - 动作（ctx.action，HTTP/CLI/Agent Tool 五端复用）：
 *   dispatch_worker { prompt, profileId?, title?, threadKey?, cwd? } -> { workerConversationId }；
 *   archive_worker { workerConversationId }（busy 拒绝；完成后解绑订阅 + tags
 *   'worker' -> 'worker-archived'，历史保留）；
 *   set_router_mode { enabled: boolean } -> 经 deps.setRouterMode 写真实
 *   plugins.setConfig（配置单一来源，持久化）。
 * - 模型精确短名（ctx.tool，scope 仅真实中枢 profileIds: ['superagent']）：
 *   dispatch_worker / inspect_worker / recall_context / subscribe_thread。
 * - Watchdog 动作/同短名工具：watchdog_inspect / watchdog_recover /
 *   watchdog_abort；target 输入 conversationId 正整数；mutation 对
 *   ownedBy: 'human' 会话 403（归属权红线）。
 * - 插件配置：routerMode / mutedSources / watchdogEnabled / stalledAfterMs /
 *   abortAfterMs / errorThreshold（经 plugins config 读写）。
 * - dispatch 为非阻塞驻留会话原语：Worker 带 tags ['worker']、ownedBy 'helm'、
 *   parentConversationId 指向中枢；agent/trigger 回合结束后写 RecallGraph 并向
 *   中枢投递 meta.renderer=superagent:worker-report；纯 human 回合只写图。
 *
 * 诚实性纪律：
 * - 实现未合入本 worktree 时，断言 builtin:superagent 注册项缺失即如实失败
 *   （RED），不 skip、不 mock 实现、不伪造 stub 冒充通过。
 * - 所有模型输出来自 faux provider 脚本；阻塞用 FauxResponseFactory 内的显式
 *   Promise gate 握手（函数工厂形态——Promise 本体会被当 AssistantMessage），
 *   不用 sleep 猜时序；跨回合偶发顺序用 waitFor 轮询真实落库状态。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import { test } from 'node:test'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'

import { ROOT_CONVERSATION_ID, HelmError } from '@helm/protocol'
import { createHelm } from '../src/app.js'
import { startHub } from '../src/http/index.js'

import assert from 'node:assert/strict'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..', '..', '..')
const cliEntry = join(repoRoot, 'packages', 'node', 'src', 'cli', 'index.ts')
const require = createRequire(import.meta.url)
const tsxCli = require.resolve('tsx/cli')

const SUPERAGENT_ID = 'builtin:superagent'
const DOC_INDEX = 'index'
const DOC_SUBSCRIPTIONS = 'subscriptions'
const DOC_RECALL = 'recall-graph'
const RENDERER_WORKER_REPORT = 'superagent:worker-report'
const PASSWORD = 'superagent验收密码八位'

/** 手写 deferred（gate 握手，不用 sleep 对齐并发时序）。 */
interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  isSettled(): boolean
}

function deferred<T>(): Deferred<T> {
  let settled = false
  let resolveFn!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolveFn = (value) => {
      if (settled) return
      settled = true
      res(value)
    }
  })
  return { promise, resolve: resolveFn, isSettled: () => settled }
}

/** 原子等待真实落库/状态条件（超时即失败，不静默兜底）。 */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) assert.fail('waitFor 超时：条件在限定时间内未成立')
    await new Promise((r) => setTimeout(r, 25))
  }
}

// ---------------------------------------------------------------------------
// 基建：真实 createHelm 组合环境（真 SQLite + 真 PluginHost + faux provider）
// ---------------------------------------------------------------------------

interface SuperAgentEnv {
  dataDir: string
  faux: ReturnType<typeof fauxProvider>
  app: Awaited<ReturnType<typeof createHelm>>
  /** 每次模型请求捕获（工具声明回放 + system sections + user 文本）。 */
  requests: Array<{ toolNames: string[]; sections: string[]; userTexts: string[] }>
  close(): Promise<void>
}

async function makeEnv(dataDir?: string): Promise<SuperAgentEnv> {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'helm-superagent-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)

  const app = await createHelm({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models, watchdogIntervalMs: 0 })

  const requests: SuperAgentEnv['requests'] = []
  faux.setResponses([])

  return {
    dataDir: dir,
    faux,
    app,
    requests,
    async close() {
      // 不吞 close 错误（诚实性纪律）：挂起任务/释放失败必须暴露
      await app.close()
      if (dataDir === undefined) rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 捕获型 faux 响应工厂：记录工具声明与 sections，返回固定回答。 */
function captureStep(env: SuperAgentEnv, answer: string): FauxResponseStep {
  return (context) => {
    const messages = context.messages as unknown as Array<Record<string, unknown>>
    const tools = getCurrentTools(messages as never)
    const sections: string[] = []
    const userTexts: string[] = []
    for (const message of messages) {
      if (message['role'] === 'system' && typeof message['sections'] === 'object' && message['sections'] !== null) {
        for (const text of Object.values(message['sections'] as Record<string, unknown>)) {
          if (typeof text === 'string') sections.push(text)
        }
      }
      if (message['role'] === 'user') {
        const content = message['content']
        if (typeof content === 'string') userTexts.push(content)
        else if (Array.isArray(content)) {
          for (const block of content as Array<{ type?: string; text?: string }>) {
            if (block.type === 'text' && typeof block.text === 'string') userTexts.push(block.text)
          }
        }
      }
    }
    env.requests.push({ toolNames: tools.map((tool) => tool.name), sections, userTexts })
    return fauxAssistantMessage(answer)
  }
}

/** 固定回答池（覆盖 dispatch 首回合 + 向中枢的汇报回合，避免空队列假失败）。 */
function okPool(n: number): FauxResponseStep[] {
  return Array.from({ length: n }, () => fauxAssistantMessage('ok'))
}

/** 阻塞型响应工厂：gate resolve 前该回合绝不结算（函数形态，Promise 本体不是合法 step）。 */
function gatedStep(gate: Deferred<void>, answer: string): FauxResponseStep {
  return () => gate.promise.then(() => fauxAssistantMessage(answer))
}

/** 提交并等待空闲（含本会话 turn_settled 钩子完成）。 */
async function submitAndWait(
  env: SuperAgentEnv,
  conversationId: number,
  text: string,
  opts?: { origin?: 'human' | 'agent' | 'trigger'; meta?: Record<string, unknown> },
): Promise<void> {
  await env.app.kernel.submitInput(conversationId, text, opts)
  await env.app.kernel.waitForIdle(conversationId)
}

// ---- Doc 形状（contracts.ts 公开结构的最小子集） ---------------------------

interface IndexDocShape {
  version?: number
  routerConversationId?: number
  watchdogConversationId?: number
  workers?: Array<{ conversationId: number; parentConversationId: number; profileId: string; createdAt: number }>
}

interface SubscriptionsDocShape {
  version?: number
  subscriptions?: Array<{ threadKey: string; workerConversationId: number; createdAt: number }>
}

interface RecallDocShape {
  version?: number
  nodes?: Array<{
    id: string
    conversationId: number
    profileId: string
    completionSeq: number
    outcome: string
    summary: string
    keywords?: string[]
    createdAt: number
  }>
}

async function readPublicDoc<T>(base: string, token: string, name: string): Promise<{ status: number; value?: T }> {
  const res = await fetch(
    `${base}/api/plugins/${encodeURIComponent(SUPERAGENT_ID)}/docs/${encodeURIComponent(name)}`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  if (res.status !== 200) return { status: res.status }
  return { status: 200, value: (JSON.parse(await res.text()) as { value: T }).value }
}

/** HTTP helper。 */
async function httpCall(
  base: string,
  method: string,
  path: string,
  opts?: { body?: unknown; token?: string },
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {}
  if (opts?.body !== undefined) headers['content-type'] = 'application/json'
  if (opts?.token !== undefined) headers.authorization = `Bearer ${opts.token}`
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
  return { status: response.status, body: await response.text() }
}

/** 异步子进程真 CLI（tsx loader 直跑源码；绝不 spawnSync 阻塞父进程事件循环）。 */
function runCliChild(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 25_000,
): Promise<{ code: number | null; out: string; err: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli, cliEntry, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')))
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: null, out, err, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err, timedOut })
    })
  })
}

/**
 * SSE 订阅：先等 snapshot 首帧就绪（订阅确已建立）再触发被测行为；
 * 断言读到的必须是真实增量事件，绝不用空数组兜底糊过。
 */
function openSseSubscription(
  base: string,
  token: string,
  until: (frames: string[]) => boolean,
  timeoutMs = 25_000,
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
      // 超时 abort 触发的网络异常不能掩盖真实断言：返回已收集帧，
      // 由调用方的帧断言如实失败（不静默豁免）。仅吞 abort 族网络错误。
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

/** SSE data JSON 提取（帧形态 `event: <type>\ndata: {seq, event: {...}}`，取 event 信封内层）。 */
function sseDataJson<T>(frame: string): T | undefined {
  const match = /data: (\{[\s\S]*\})/.exec(frame)
  if (!match) return undefined
  const parsed = JSON.parse(match[1]!) as { event?: unknown }
  if (parsed.event !== undefined && typeof parsed.event === 'object' && parsed.event !== null) {
    return parsed.event as T
  }
  return parsed as T
}

/** 前置：builtin:superagent 已注册且启用后取动态 ID。 */
async function enableAndGetIds(env: SuperAgentEnv): Promise<{ routerId: number; watchdogId: number }> {
  const host = env.app.kernel.plugins
  const registered = host.list().find((p) => p.id === SUPERAGENT_ID)
  assert.ok(registered, `${SUPERAGENT_ID} 应经 createHelm 注册（默认停用）`)
  if (!registered.enabled) await host.enable(SUPERAGENT_ID)
  const doc = host.getPublicDoc(SUPERAGENT_ID, DOC_INDEX) as { value: IndexDocShape }
  const routerId = doc.value.routerConversationId
  const watchdogId = doc.value.watchdogConversationId
  assert.ok(typeof routerId === 'number' && routerId > 1, 'index doc 应含动态 routerConversationId')
  assert.ok(typeof watchdogId === 'number' && watchdogId > 1, 'index doc 应含动态 watchdogConversationId')
  return { routerId, watchdogId }
}

/** 声明一个专家 Profile（profiles/<id>/profile.json，dispatch 点将用）。 */
function writeProfile(dataDir: string, id: string): void {
  const dir = join(dataDir, 'profiles', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ id, name: id }))
  writeFileSync(join(dir, 'SYSTEM.md'), `你是 ${id} 专家。\n`)
  writeFileSync(join(dir, 'MEMORY.md'), '# Memory\n')
}

/** 会话的 helm.input entries（data.text / data.origin / data.meta）。 */
interface InputEntryData {
  id?: string
  text?: string
  origin?: string
  meta?: Record<string, unknown>
}

async function inputEntriesOf(
  kernel: SuperAgentEnv['app']['kernel'],
  conversationId: number,
): Promise<InputEntryData[]> {
  const detail = await kernel.getConversationDetail(conversationId, { limit: 200 })
  return detail.entries
    .filter((e) => e.kind === 'helm.input')
    .map((e) => (e.data ?? {}) as InputEntryData)
}

/** 中枢收到的指定 Worker 汇报卡数量（meta.renderer + meta.workerId 双匹配）。 */
async function workerReportCount(
  kernel: SuperAgentEnv['app']['kernel'],
  routerId: number,
  workerId: number,
): Promise<number> {
  const inputs = await inputEntriesOf(kernel, routerId)
  return inputs.filter(
    (d) => d.meta?.['renderer'] === RENDERER_WORKER_REPORT && d.meta?.['workerId'] === workerId,
  ).length
}

// ---------------------------------------------------------------------------
// 验收 1：默认停用零业务资产；启用后自举、动态 ID、删除保护、重启持久、停用释放
// ---------------------------------------------------------------------------

test('SA1: 默认停用不建业务会话/Profile/Doc；HTTP 启用后 #1 不变、动态 ID 可读、常驻删除 409、重启同 ID、停用释放保护', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-sa1-'))
  const first = await makeEnv(dataDir)
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  try {
    const host = first.app.kernel.plugins

    // 默认停用：注册项存在、enabled false、无业务会话/Profile
    const summary = host.list().find((p) => p.id === SUPERAGENT_ID)
    assert.ok(summary, `${SUPERAGENT_ID} 应注册（createHelm 内置声明）`)
    assert.equal(summary.enabled, false, '默认应停用注册')
    assert.equal(summary.actions.length, 0, '停用时不应暴露动作')
    const profiledBefore = first.app.kernel
      .listConversations()
      .filter((c) => c.profileId === 'superagent' || c.profileId === 'watchdog')
    assert.deepEqual(profiledBefore, [], '默认停用不得创建 superagent/watchdog 会话')
    assert.equal(existsSync(join(dataDir, 'profiles', 'superagent')), false, '默认停用不得自举 superagent Profile')
    assert.equal(existsSync(join(dataDir, 'profiles', 'watchdog')), false, '默认停用不得自举 watchdog Profile')

    // HTTP Hub + 鉴权
    hub = await startHub({ kernel: first.app.kernel as never, workflows: first.app.workflows as never, port: 0 })
    const base = hub.url
    const setup = await httpCall(base, 'POST', '/api/auth/setup', { body: { password: PASSWORD } })
    const token = (JSON.parse(setup.body) as { token: string }).token

    // 停用态：公开 Doc 404（无业务资产）
    for (const name of [DOC_INDEX, DOC_SUBSCRIPTIONS, DOC_RECALL]) {
      const doc = await readPublicDoc<unknown>(base, token, name)
      assert.equal(doc.status, 404, `停用时公共 Doc ${name} 应 404`)
    }
    // 停用态：动作显式拒绝（plugin_disabled 族，非 404 伪装）
    const disabledAction = await httpCall(base, 'POST', `/api/actions/${SUPERAGENT_ID}/set_router_mode`, {
      token,
      body: { input: { enabled: true } },
    })
    assert.ok(disabledAction.status === 409 || disabledAction.status === 404, '停用插件动作应显式拒绝')

    // HTTP enable
    const enableRes = await httpCall(base, 'POST', `/api/plugins/${encodeURIComponent(SUPERAGENT_ID)}/enable`, { token })
    assert.equal(enableRes.status, 200, `启用失败：${enableRes.body}`)
    const afterEnable = JSON.parse(enableRes.body) as Array<{ id: string; enabled: boolean }>
    assert.equal(afterEnable.find((p) => p.id === SUPERAGENT_ID)?.enabled, true)

    // #1 不变（仍是 assistant 个人助理主入口）
    const root = first.app.kernel.getConversation(ROOT_CONVERSATION_ID)
    assert.equal(root.profileId, 'assistant', '根会话 #1 的 profileId 不得被 superagent 改写')

    // 动态 ID 可读 + Profile 正确 + 不打角色 tags + Profile 自举
    const indexDoc = await readPublicDoc<IndexDocShape>(base, token, DOC_INDEX)
    assert.equal(indexDoc.status, 200)
    const routerId = indexDoc.value!.routerConversationId
    const watchdogId = indexDoc.value!.watchdogConversationId
    assert.ok(typeof routerId === 'number' && routerId > 1, 'routerConversationId 应为动态分配的正整数')
    assert.ok(typeof watchdogId === 'number' && watchdogId > 1, 'watchdogConversationId 应为动态分配的正整数')
    assert.notEqual(routerId, watchdogId)
    const router = first.app.kernel.getConversation(routerId)
    const watchdog = first.app.kernel.getConversation(watchdogId)
    assert.equal(router.profileId, 'superagent')
    assert.equal(watchdog.profileId, 'watchdog')
    assert.equal(router.tags.includes('superagent'), false, '中枢不打角色 tag')
    assert.equal(watchdog.tags.includes('watchdog'), false, '看门狗不打角色 tag')
    assert.ok(existsSync(join(dataDir, 'profiles', 'superagent')), '启用应幂等自举 superagent Profile')
    assert.ok(existsSync(join(dataDir, 'profiles', 'watchdog')), '启用应幂等自举 watchdog Profile')

    // 常驻删除保护 409 conversation_managed_by_plugin
    for (const id of [routerId, watchdogId]) {
      const del = await httpCall(base, 'DELETE', `/api/conversations/${id}`, { token })
      assert.equal(del.status, 409, `受管常驻会话删除应 409：${del.body}`)
      assert.equal(JSON.parse(del.body).error.code, 'conversation_managed_by_plugin')
    }
    // #1 仍不可删（403），且与插件保护不混
    const delRoot = await httpCall(base, 'DELETE', `/api/conversations/${ROOT_CONVERSATION_ID}`, { token })
    assert.equal(delRoot.status, 403)
    assert.equal(JSON.parse(delRoot.body).error.code, 'root_conversation_protected')

    // --- 重启：同 dataDir 重建，开关持久 + 同 ID + Profile 保留
    await hub.close()
    hub = undefined
    await first.app.close()

    const second = await makeEnv(dataDir)
    try {
      const listAfter = second.app.kernel.listConversations()
      const persisted = listAfter.find((c) => c.id === routerId)
      assert.ok(persisted, '重启后中枢会话应保留')
      assert.equal(persisted.profileId, 'superagent')
      assert.equal(listAfter.find((c) => c.id === watchdogId)?.profileId, 'watchdog')

      // 启停状态持久恢复（曾持久化 enable=true，重启不回落声明缺省）
      const summary2 = second.app.kernel.plugins.list().find((p) => p.id === SUPERAGENT_ID)
      assert.ok(summary2)
      assert.equal(summary2.enabled, true, '启用状态应跨重启持久恢复')

      // Doc 值同 ID（同一持久层）
      const host2 = second.app.kernel.plugins
      const doc2 = host2.getPublicDoc(SUPERAGENT_ID, DOC_INDEX) as { value: IndexDocShape }
      assert.equal(doc2.value.routerConversationId, routerId, '重启后 routerConversationId 不变')
      assert.equal(doc2.value.watchdogConversationId, watchdogId, '重启后 watchdogConversationId 不变')

      // --- 停用释放保护：disable 后 DELETE 常驻会话应可行
      await host2.disable(SUPERAGENT_ID)
      await second.app.kernel.deleteConversation(routerId)
      // 停用后公共 Doc 404（同步抛出，async 包装以满足 assert.rejects 签名）
      await assert.rejects(
        async () => host2.getPublicDoc(SUPERAGENT_ID, DOC_INDEX),
        (err: unknown) => err instanceof HelmError && err.code === 'plugin_doc_not_found',
        '停用后公共 Doc 应 404',
      )
    } finally {
      await second.app.close()
    }
  } finally {
    if (hub) await hub.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 验收 2：中枢模型请求工具收敛；#1 完整；Watchdog 白名单与执行守卫
// ---------------------------------------------------------------------------

test('SA2: 中枢模型请求剥离 bash/subagent 等并保留派工短名；#1 保持完整工具集；watchdog 白名单且 mutation 对 human 403', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const { routerId, watchdogId } = await enableAndGetIds(env)
    const host = env.app.kernel.plugins
    const kernel = env.app.kernel

    // ---- 插件工具可见性（listTools 按会话 scope 筛选；内核工具不在此列）
    const routerTools = host.listTools(kernel.getConversation(routerId)).map((t) => t.name)
    const watchdogTools = host.listTools(kernel.getConversation(watchdogId)).map((t) => t.name)
    const rootTools = host.listTools(kernel.getConversation(ROOT_CONVERSATION_ID)).map((t) => t.name)

    // 中枢精确短名（ctx.tool，scope 仅真实中枢）
    for (const name of ['dispatch_worker', 'inspect_worker', 'recall_context', 'subscribe_thread']) {
      assert.ok(routerTools.includes(name), `中枢工具集应含精确短名 ${name}（实际：${routerTools.join(',')}）`)
    }
    // scope 只真实中枢：#1 与 watchdog 不得见派工工具
    assert.equal(rootTools.includes('dispatch_worker'), false, '#1 不得见 dispatch_worker（scope 未命中）')
    assert.equal(watchdogTools.includes('dispatch_worker'), false, 'watchdog 不得见 dispatch_worker')
    // Watchdog 短名仅 watchdog 可见
    for (const name of ['watchdog_inspect', 'watchdog_recover', 'watchdog_abort']) {
      assert.ok(watchdogTools.includes(name), `Watchdog 工具集应含 ${name}（实际：${watchdogTools.join(',')}）`)
      assert.equal(rootTools.includes(name), false, `#1 不得见 ${name}`)
      assert.equal(routerTools.includes(name), false, `中枢不得见 ${name}`)
    }

    // ---- 真实模型请求级（getCurrentTools 回放）：before_turn 收敛真进请求
    const HEAVY = ['bash', 'edit', 'write', 'subagent', 'SubagentWorkflow']

    // 中枢回合
    env.requests.length = 0
    env.faux.setResponses([captureStep(env, '中枢就绪'), captureStep(env, '中枢就绪'), captureStep(env, '中枢就绪')])
    await submitAndWait(env, routerId, '中枢自检')
    assert.ok(env.requests.length >= 1, '中枢回合应发生模型请求')
    for (const req of env.requests) {
      for (const name of ['dispatch_worker', 'inspect_worker', 'recall_context', 'subscribe_thread']) {
        assert.ok(req.toolNames.includes(name), `中枢模型请求应含 ${name}（实际：${req.toolNames.join(',')}）`)
      }
      for (const banned of HEAVY) {
        assert.equal(req.toolNames.includes(banned), false, `中枢模型请求不得含重度工具 ${banned}（实际：${req.toolNames.join(',')}）`)
      }
    }

    // #1 回合：完整工具集（内核工具 bash/subagent/SubagentWorkflow/run_action 保留）
    env.requests.length = 0
    env.faux.setResponses([captureStep(env, '根会话完整'), captureStep(env, '根会话完整')])
    await submitAndWait(env, ROOT_CONVERSATION_ID, '根会话自检')
    assert.ok(env.requests.length >= 1)
    for (const req of env.requests) {
      for (const required of ['bash', 'read', 'subagent', 'SubagentWorkflow', 'run_action']) {
        assert.ok(req.toolNames.includes(required), `#1 模型请求应保留完整工具 ${required}（实际：${req.toolNames.join(',')}）`)
      }
    }

    // Watchdog 回合：白名单进入模型请求，无 bash / run_action 越界面
    env.requests.length = 0
    env.faux.setResponses([captureStep(env, '看门狗就绪'), captureStep(env, '看门狗就绪')])
    await submitAndWait(env, watchdogId, '看门狗自检')
    assert.ok(env.requests.length >= 1)
    for (const req of env.requests) {
      for (const name of ['watchdog_inspect', 'watchdog_recover', 'watchdog_abort']) {
        assert.ok(req.toolNames.includes(name), `Watchdog 模型请求应含 ${name}（实际：${req.toolNames.join(',')}）`)
      }
      for (const banned of [...HEAVY, 'run_action']) {
        assert.equal(req.toolNames.includes(banned), false, `Watchdog 模型请求不得含 ${banned}（实际：${req.toolNames.join(',')}）`)
      }
    }

    // ---- 执行守卫：mutation 对 human 会话 403；inspect 只读可用；Schema 拒绝非法 target
    const humanConv = await kernel.createConversation({ title: '人类直连', profileId: 'assistant' })
    await assert.rejects(
      () => host.invokeAction(SUPERAGENT_ID, 'watchdog_abort', { conversationId: humanConv.id }),
      (err: unknown) => err instanceof HelmError && err.status === 403,
      'watchdog_abort 对 ownedBy human 会话必须 403（归属权红线）',
    )
    await assert.rejects(
      () => host.invokeAction(SUPERAGENT_ID, 'watchdog_recover', { conversationId: humanConv.id, hint: '尝试恢复' }),
      (err: unknown) => err instanceof HelmError && err.status === 403,
      'watchdog_recover 对 ownedBy human 会话必须 403',
    )
    // 只读诊断不受红线限制
    const inspect = await host.invokeAction(SUPERAGENT_ID, 'watchdog_inspect', { conversationId: humanConv.id })
    assert.ok(inspect !== undefined, 'watchdog_inspect 只读应可用')

    // 非法 target：conversationId 非正整数被 Schema 拒绝（validation_error / 400）
    for (const bad of [0, -1, 1.5, 'three', null]) {
      await assert.rejects(
        () => host.invokeAction(SUPERAGENT_ID, 'watchdog_abort', { conversationId: bad }),
        (err: unknown) => err instanceof HelmError && (err.code === 'validation_error' || err.status === 400),
        `watchdog 非法 conversationId ${JSON.stringify(bad)} 应被 Schema 拒绝`,
      )
    }
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 验收 3：dispatch 非阻塞（gate 握手）+ busy disable 409 + origin 汇报 + 终态覆盖
// ---------------------------------------------------------------------------

test('SA3: dispatch 在 Worker 完成前返回（gate 握手非 sleep）；busy 期 disable 409；agent 回合写 RecallGraph 并投 worker-report；纯 human 只写图；failed/aborted 不遗漏', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    writeProfile(env.dataDir, 'finance')
    const { routerId } = await enableAndGetIds(env)
    const host = env.app.kernel.plugins
    const kernel = env.app.kernel

    // ---- gate：Worker 首回合模型响应在 release 前绝不产生
    const workerGate = deferred<void>()
    // 队列：[Worker 首回合 gate, 中枢汇报回合 ok]
    env.faux.setResponses([gatedStep(workerGate, '对账完成：全部核平'), fauxAssistantMessage('中枢已记录')])

    // dispatch：非阻塞——在 Worker 尚未完成前返回 { workerConversationId }
    const dispatchResult = (await host.invokeAction(SUPERAGENT_ID, 'dispatch_worker', {
      prompt: '对账：核对上月流水',
      profileId: 'finance',
      title: '财务对账',
    })) as { workerConversationId: number }
    const workerId = dispatchResult.workerConversationId
    assert.ok(Number.isInteger(workerId) && workerId > 0, 'dispatch 应返回 workerConversationId')

    // Worker 会话形态：tags ['worker']、parent 指向中枢、profile 点将生效
    const worker = kernel.getConversation(workerId)
    assert.ok(worker.tags.includes('worker'), 'Worker 应带 worker tag')
    assert.equal(worker.parentConversationId, routerId, 'Worker 的 parentConversationId 应为中枢')
    assert.equal(worker.profileId, 'finance')

    // dispatch 返回时 Worker 回合尚未结算（gate 未释放，物理不可能完成；只依赖单调基准，不硬编码绝对值）
    const completionSeqAtDispatch = kernel.getConversation(workerId).completionSeq
    assert.equal(kernel.getConversation(workerId).status, 'working', 'dispatch 返回时 Worker 回合应在运行中')

    // busy 期间 disable 409（Worker 在途是插件活任务）
    await assert.rejects(
      () => host.disable(SUPERAGENT_ID),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_has_live_tasks',
      'Worker 在途时 disable superagent 应 409 plugin_has_live_tasks',
    )

    // ---- 释放 Worker：真实完成路径驱动 turn_settled -> RecallGraph + 汇报
    workerGate.resolve()
    await waitFor(() => {
      const doc = host.getPublicDoc(SUPERAGENT_ID, DOC_RECALL) as { value: RecallDocShape }
      return (doc.value.nodes ?? []).some((n) => n.conversationId === workerId && n.outcome === 'completed')
    })
    await kernel.waitForIdle(workerId)
    // 结算单调推进（不硬编码绝对 seq；只验证确实前进了一次）
    assert.ok(
      kernel.getConversation(workerId).completionSeq > completionSeqAtDispatch,
      'Worker 首回合结算后 completionSeq 应单调推进',
    )
    // 汇报卡真实落到中枢时间线（轮询真实落库，不猜异步完成时刻）
    await waitFor(() => workerReportCount(kernel, routerId, workerId).then((n) => n >= 1))

    const reportInputs = (await inputEntriesOf(kernel, routerId)).filter(
      (d) => d.meta?.['renderer'] === RENDERER_WORKER_REPORT && d.meta?.['workerId'] === workerId,
    )
    assert.equal(reportInputs.length, 1, 'agent 回合结束应恰好投递一张汇报卡')
    assert.equal(typeof reportInputs[0]!.meta?.['summary'], 'string', '汇报 meta.summary 应为字符串')
    assert.equal(reportInputs[0]!.origin, 'agent', '汇报卡输入来源应为 agent')

    // RecallGraph 节点真实产物
    const recallDoc = host.getPublicDoc(SUPERAGENT_ID, DOC_RECALL) as { value: RecallDocShape }
    const node = (recallDoc.value.nodes ?? []).find((n) => n.conversationId === workerId)
    assert.ok(node, 'RecallGraph 应含 Worker 节点')
    assert.equal(node!.outcome, 'completed')
    assert.equal(node!.profileId, 'finance')
    assert.ok(typeof node!.summary === 'string' && node!.summary.length > 0, 'RecallGraph 节点应有摘要')

    // ---- 纯 human 回合：先等中枢汇报回合结算，再给 Worker 下一条响应。
    await kernel.waitForIdle(routerId)
    env.faux.setResponses([fauxAssistantMessage('人类直连回答')])
    await submitAndWait(env, workerId, '人类分屏介入提问', { origin: 'human' })
    await waitFor(() => {
      const doc = host.getPublicDoc(SUPERAGENT_ID, DOC_RECALL) as { value: RecallDocShape }
      return (doc.value.nodes ?? []).filter((n) => n.conversationId === workerId).length >= 2
    })
    assert.equal(
      await workerReportCount(kernel, routerId, workerId),
      1,
      '纯 human 回合不得向中枢投递汇报（仅静默更新 RecallGraph）',
    )

    // ---- failed 终态：错误响应由本次 Worker 请求消费，随后才是中枢汇报响应。
    env.faux.setResponses([
      fauxAssistantMessage('x', { errorMessage: 'boom', stopReason: 'error' }),
      fauxAssistantMessage('中枢记录失败汇报'),
    ])
    await kernel.submitInput(workerId, '会失败的回合', { origin: 'agent' })
    await kernel.waitForIdle(workerId).catch(() => {})
    await waitFor(() => {
      const doc = host.getPublicDoc(SUPERAGENT_ID, DOC_RECALL) as { value: RecallDocShape }
      return (doc.value.nodes ?? []).some((n) => n.conversationId === workerId && n.outcome === 'failed')
    })
    await waitFor(() => workerReportCount(kernel, routerId, workerId).then((n) => n >= 2))
    const failedNode = (host.getPublicDoc(SUPERAGENT_ID, DOC_RECALL) as { value: RecallDocShape }).value
      .nodes!.find((n) => n.conversationId === workerId && n.outcome === 'failed')
    assert.ok(failedNode, 'failed 终态必须进 RecallGraph')

    // ---- aborted 终态：真实工具在途时中止，随后才投递中枢汇报。
    await kernel.waitForIdle(routerId)
    env.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('中枢记录中止汇报'),
    ])
    await kernel.submitInput(workerId, '会被中止的回合', { origin: 'agent' })
    await waitFor(() => kernel.getConversation(workerId).status === 'working', 10_000)
    await kernel.abortConversation(workerId)
    await kernel.waitForIdle(workerId).catch(() => {})
    await waitFor(() => {
      const doc = host.getPublicDoc(SUPERAGENT_ID, DOC_RECALL) as { value: RecallDocShape }
      return (doc.value.nodes ?? []).some((n) => n.conversationId === workerId && n.outcome === 'aborted')
    })
    await waitFor(() => workerReportCount(kernel, routerId, workerId).then((n) => n >= 3))
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 验收 4：threadKey 直投 Worker、归档生命周期、deleted 订阅清理、去重
// ---------------------------------------------------------------------------

test('SA4: threadKey 事件直投 Worker 不经 router；归档拒绝 busy、解绑订阅换 tag、历史可读；deleted 订阅清理回 router；结算不重复汇报', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    writeProfile(env.dataDir, 'coder')
    writeProfile(env.dataDir, 'writer')
    const { routerId } = await enableAndGetIds(env)
    const host = env.app.kernel.plugins
    const kernel = env.app.kernel

    // 响应池：覆盖 dispatch 首回合与向中枢的汇报回合（本验收断言不依赖回答内容）
    env.faux.setResponses(okPool(8))

    // ---- dispatch 带 threadKey -> 订阅登记
    const THREAD_KEY = 'ci-main-alerts'
    const dispatched = (await host.invokeAction(SUPERAGENT_ID, 'dispatch_worker', {
      prompt: '值守 CI 通知',
      profileId: 'coder',
      threadKey: THREAD_KEY,
    })) as { workerConversationId: number }
    const workerId = dispatched.workerConversationId

    await waitFor(() => {
      const doc = host.getPublicDoc(SUPERAGENT_ID, DOC_SUBSCRIPTIONS) as { value: SubscriptionsDocShape }
      return (doc.value.subscriptions ?? []).some((s) => s.threadKey === THREAD_KEY)
    })
    const subDoc = host.getPublicDoc(SUPERAGENT_ID, DOC_SUBSCRIPTIONS) as { value: SubscriptionsDocShape }
    const sub = (subDoc.value.subscriptions ?? []).find((s) => s.threadKey === THREAD_KEY)
    assert.equal(sub!.workerConversationId, workerId, '订阅应指向 Worker')

    // Worker 首回合 + 向中枢的汇报回合都真实结算后再触发事件（时序确定）
    await kernel.waitForIdle(workerId)
    await waitFor(() => workerReportCount(kernel, routerId, workerId).then((n) => n >= 1))
    await kernel.waitForIdle(routerId)

    // ---- threadKey 事件直投：Worker 收到 origin=trigger 输入；router 无 origin=trigger
    env.faux.appendResponses(okPool(2))
    await kernel.dispatchTrigger({
      id: 'evt-ci-1',
      source: 'webhook:ci',
      text: 'CI 失败：main 分支测试未过',
      threadKey: THREAD_KEY,
      createdAt: Date.now(),
    })
    await waitFor(async () => {
      const workerInputs = await inputEntriesOf(kernel, workerId)
      return workerInputs.some((d) => d.origin === 'trigger' && (d.text ?? '').includes('CI 失败'))
    })
    // 直投不经过 router：router 此刻没有任何 origin=trigger 输入
    const routerInputsAtDirect = await inputEntriesOf(kernel, routerId)
    assert.equal(
      routerInputsAtDirect.some((d) => d.origin === 'trigger'),
      false,
      '命中订阅的 threadKey 事件不得投递 router（0ms 直通 Worker）',
    )
    // Worker 消费完事件回合
    await kernel.waitForIdle(workerId)
    await waitFor(() => workerReportCount(kernel, routerId, workerId).then((n) => n >= 2))
    await kernel.waitForIdle(routerId)

    // ---- 归档 busy 拒绝：gate 制造真实在途 Worker
    const busyGate = deferred<void>()
    env.faux.setResponses([gatedStep(busyGate, '值守完成')])
    const busyDispatch = (await host.invokeAction(SUPERAGENT_ID, 'dispatch_worker', {
      prompt: '值守任务',
      profileId: 'writer',
    })) as { workerConversationId: number }
    const busyWorkerId = busyDispatch.workerConversationId
    await waitFor(() => kernel.getConversation(busyWorkerId).status === 'working', 10_000)
    await assert.rejects(
      () => host.invokeAction(SUPERAGENT_ID, 'archive_worker', { workerConversationId: busyWorkerId }),
      (err: unknown) => err instanceof HelmError && (err.code === 'worker_busy' || err.status === 409),
      '归档 busy Worker 应显式拒绝（409 族）',
    )
    busyGate.resolve()
    await kernel.waitForIdle(busyWorkerId)
    await waitFor(() => workerReportCount(kernel, routerId, busyWorkerId).then((n) => n >= 1))
    await kernel.waitForIdle(routerId)

    // ---- 归档完成 Worker：解绑订阅 + 换 tag + 历史可读
    await host.invokeAction(SUPERAGENT_ID, 'archive_worker', { workerConversationId: workerId })
    const workerAfter = kernel.getConversation(workerId)
    assert.equal(workerAfter.tags.includes('worker'), false, '归档后应移除 worker tag')
    assert.equal(workerAfter.tags.includes('worker-archived'), true, '归档后应带 worker-archived tag')
    await waitFor(() => {
      const doc = host.getPublicDoc(SUPERAGENT_ID, DOC_SUBSCRIPTIONS) as { value: SubscriptionsDocShape }
      return !(doc.value.subscriptions ?? []).some((s) => s.threadKey === THREAD_KEY)
    })
    const historyDetail = await kernel.getConversationDetail(workerId, { limit: 200 })
    assert.ok(Array.isArray(historyDetail.entries) && historyDetail.entries.length > 0, '归档 Worker 历史应可读')

    // ---- deleted 订阅清理：同 threadKey 的下一事件到达时清理并回退中枢。
    env.faux.setResponses(okPool(4))
    const dispatched2 = (await host.invokeAction(SUPERAGENT_ID, 'dispatch_worker', {
      prompt: '值守二号',
      profileId: 'coder',
      threadKey: 'ops-alert-1',
    })) as { workerConversationId: number }
    const worker2 = dispatched2.workerConversationId
    await kernel.waitForIdle(worker2)
    await waitFor(() => workerReportCount(kernel, routerId, worker2).then((n) => n >= 1))
    await kernel.waitForIdle(routerId)

    await kernel.deleteConversation(worker2)
    // 回退投递至 router（origin=trigger + 事件文本）
    await kernel.dispatchTrigger({
      id: 'evt-ops-1',
      source: 'webhook:ops',
      text: '磁盘告警：data 卷超过90%',
      threadKey: 'ops-alert-1',
      createdAt: Date.now(),
    })
    const cleaned = host.getPublicDoc(SUPERAGENT_ID, DOC_SUBSCRIPTIONS) as { value: SubscriptionsDocShape }
    assert.equal(cleaned.value.subscriptions?.some((s) => s.threadKey === 'ops-alert-1'), false)
    await waitFor(async () => {
      const inputs = await inputEntriesOf(kernel, routerId)
      return inputs.some((d) => d.origin === 'trigger' && (d.text ?? '').includes('磁盘告警'))
    })
    await kernel.waitForIdle(routerId)

    // ---- 去重：每次结算恰好一个节点（id = conversationId:completionSeq 稳定）
    const recallAll = host.getPublicDoc(SUPERAGENT_ID, DOC_RECALL) as { value: RecallDocShape }
    const nodes = recallAll.value.nodes ?? []
    assert.ok(nodes.length > 0, 'RecallGraph 应有节点')
    const ids = nodes.map((n) => n.id)
    assert.equal(new Set(ids).size, ids.length, '同一结算不得产生重复 RecallGraph 节点（id 稳定唯一）')
    // workerId 两次 completed 结算（首回合 + trigger 回合）各自成节点
    const workerCompleted = nodes.filter((n) => n.conversationId === workerId && n.outcome === 'completed')
    assert.equal(workerCompleted.length, 2, '两次独立结算应有两个 completed 节点')
    const seqs = workerCompleted.map((n) => n.completionSeq)
    assert.equal(new Set(seqs).size, seqs.length, '不同结算的 completionSeq 不得重复')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 验收 5：HTTP 动作 + 真实 CLI 子进程同结果；Schema 拒绝；router mode 持久
// ---------------------------------------------------------------------------

test('SA5: HTTP 动作与真实 CLI 子进程 --json 见同一结果；非法参数 Schema 拒绝；set_router_mode 经 plugins config 持久生效', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-sa5-'))
  const env = await makeEnv(dataDir)
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  const cliDataDir = mkdtempSync(join(tmpdir(), 'helm-sa5-cli-'))
  try {
    writeProfile(env.dataDir, 'finance')
    const kernel = env.app.kernel

    hub = await startHub({ kernel: kernel as never, workflows: env.app.workflows as never, port: 0 })
    const base = hub.url
    const setup = await httpCall(base, 'POST', '/api/auth/setup', { body: { password: PASSWORD } })
    const token = (JSON.parse(setup.body) as { token: string }).token
    const cliEnv = {
      ...process.env,
      HELM_HUB_URL: base,
      HELM_DATA_DIR: cliDataDir,
      HELM_TOKEN: token,
    }

    // 启用（HTTP）
    await httpCall(base, 'POST', `/api/plugins/${encodeURIComponent(SUPERAGENT_ID)}/enable`, { token })

    // 配置面：六字段 schema 存在
    const configRes = await httpCall(base, 'GET', `/api/plugins/${encodeURIComponent(SUPERAGENT_ID)}/config`, { token })
    assert.equal(configRes.status, 200)
    const config = JSON.parse(configRes.body) as {
      values: Record<string, unknown>
      schema: Record<string, { default?: unknown }>
    }
    for (const field of ['routerMode', 'mutedSources', 'watchdogEnabled', 'stalledAfterMs', 'abortAfterMs', 'errorThreshold']) {
      assert.ok(field in config.schema, `config schema 应含 ${field}`)
      assert.ok(
        field in config.values || config.schema[field]?.default !== undefined,
        `config 值应含 ${field}（或 schema 提供默认）`,
      )
    }

    // ---- HTTP dispatch_worker（响应池覆盖 Worker 回合 + 汇报回合）
    env.faux.setResponses(okPool(4))
    const httpDispatch = await httpCall(base, 'POST', `/api/actions/${SUPERAGENT_ID}/dispatch_worker`, {
      token,
      body: { input: { prompt: 'HTTP 派工对账', profileId: 'finance', title: 'HTTP 对账' } },
    })
    assert.equal(httpDispatch.status, 200, `HTTP dispatch 失败：${httpDispatch.body}`)
    const workerId = (JSON.parse(httpDispatch.body) as { workerConversationId: number }).workerConversationId
    assert.ok(Number.isInteger(workerId) && workerId > 0)
    await kernel.waitForIdle(workerId)

    // ---- 真实 CLI 子进程：动态动作命令（默认路径 helm superagent <action>）同结果
    const cliInspect = await runCliChild([
      'superagent', 'inspect_worker',
      '--input', JSON.stringify({ workerConversationId: workerId }),
      '--json',
    ], cliEnv)
    assert.equal(cliInspect.timedOut, false, 'CLI 子进程不得挂起')
    if (cliInspect.code !== 0) {
      assert.fail(`CLI inspect_worker 失败：${cliInspect.err}`)
    }
    assert.ok(
      cliInspect.out.includes(String(workerId)),
      `CLI inspect_worker --json 应看到同一 Worker（${workerId}）：${cliInspect.out}`,
    )

    // CLI plugins doc 读 index（--json）
    const cliDoc = await runCliChild(['plugins', 'doc', SUPERAGENT_ID, DOC_INDEX, '--json'], cliEnv)
    assert.equal(cliDoc.timedOut, false)
    if (cliDoc.code !== 0) assert.fail(`CLI plugins doc 失败：${cliDoc.err}`)
    const docOut = JSON.parse(cliDoc.out) as { value: IndexDocShape }
    assert.ok(typeof docOut.value.routerConversationId === 'number', 'CLI doc 应读出 routerConversationId')

    // ---- Schema 拒绝（HTTP 与 CLI 同一校验器）
    const badHttp = await httpCall(base, 'POST', `/api/actions/${SUPERAGENT_ID}/dispatch_worker`, {
      token,
      body: { input: {} },
    })
    assert.equal(badHttp.status, 400)
    assert.equal(JSON.parse(badHttp.body).error.code, 'validation_error', '缺 prompt 应 validation_error')

    const badHttp2 = await httpCall(base, 'POST', `/api/actions/${SUPERAGENT_ID}/dispatch_worker`, {
      token,
      body: { input: { prompt: 123 } },
    })
    assert.equal(badHttp2.status, 400, 'prompt 类型错误应 400')

    const badCli = await runCliChild([
      'superagent', 'dispatch_worker', '--input', '{"prompt":42}', '--json',
    ], cliEnv)
    assert.equal(badCli.timedOut, false)
    assert.notEqual(badCli.code, 0, 'CLI 非法入参必须非零退出')
    assert.equal((JSON.parse(badCli.err) as { error: { code: string } }).error.code, 'validation_error')

    // ---- set_router_mode：经真实 plugins.setConfig 持久化（配置单一来源）
    const offRes = await httpCall(base, 'POST', `/api/actions/${SUPERAGENT_ID}/set_router_mode`, {
      token,
      body: { input: { enabled: false } },
    })
    assert.equal(offRes.status, 200, `set_router_mode(false) 失败：${offRes.body}`)
    const configAfter = await httpCall(base, 'GET', `/api/plugins/${encodeURIComponent(SUPERAGENT_ID)}/config`, { token })
    assert.equal(
      (JSON.parse(configAfter.body) as { values: Record<string, unknown> }).values.routerMode,
      false,
      'set_router_mode(false) 应写入 plugins config（单一来源）',
    )

    // CLI 同权（布尔 flag 无值形态：--enabled）
    const cliMode = await runCliChild(['superagent', 'set_router_mode', '--enabled', '--json'], cliEnv)
    assert.equal(cliMode.timedOut, false)
    if (cliMode.code !== 0) assert.fail(`CLI set_router_mode 失败：${cliMode.err}`)
    const configFinal = await httpCall(base, 'GET', `/api/plugins/${encodeURIComponent(SUPERAGENT_ID)}/config`, { token })
    assert.equal(
      (JSON.parse(configFinal.body) as { values: Record<string, unknown> }).values.routerMode,
      true,
      'CLI set_router_mode 应同权写 config',
    )

    // ---- 持久：重启后 config 保留 routerMode=true（曾显式写 true）
    await hub.close()
    hub = undefined
    await env.close()

    const second = await makeEnv(dataDir)
    try {
      const host2 = second.app.kernel.plugins
      assert.equal(host2.getConfig(SUPERAGENT_ID).routerMode, true, 'routerMode 应跨重启持久')
      const doc2 = host2.getPublicDoc(SUPERAGENT_ID, DOC_INDEX) as { value: IndexDocShape }
      assert.ok(doc2.value.routerConversationId, '重启后 index doc 仍有 router ID')
    } finally {
      await second.app.close()
    }
  } finally {
    if (hub) await hub.close()
    rmSync(cliDataDir, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 验收 6：SSE 等 snapshot 后操作——UI 贡献、publicDoc 增量、停用清空
// ---------------------------------------------------------------------------

test('SA6: SSE 先等 snapshot 首帧——启用后 UI 贡献与 publicDoc 增量真实到达；停用后 UI 清空（ui:[] 帧）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  try {
    const host = env.app.kernel.plugins
    const kernel = env.app.kernel

    hub = await startHub({ kernel: kernel as never, workflows: env.app.workflows as never, port: 0 })
    const base = hub.url
    const setup = await httpCall(base, 'POST', '/api/auth/setup', { body: { password: PASSWORD } })
    const token = (JSON.parse(setup.body) as { token: string }).token

    // 停用态 snapshot：无 superagent UI 贡献
    const idleSub = openSseSubscription(base, token, (fs) => fs.some((f) => f.startsWith('event: snapshot')))
    const idleFrames = await idleSub.frames
    const idleSnap = idleFrames.find((f) => f.startsWith('event: snapshot'))!
    const idleUi = sseDataJson<{ ui?: Array<{ pluginId: string }> }>(idleSnap)?.ui ?? []
    assert.equal(idleUi.some((u) => u.pluginId === SUPERAGENT_ID), false, '停用时 snapshot ui 不含 superagent')

    // 订阅 plugin.changed（等 snapshot 就绪后再触发启停）
    const changeSub = openSseSubscription(
      base,
      token,
      (fs) => fs.some((f) => f.includes('event: plugin.changed') && f.includes(SUPERAGENT_ID)),
    )
    await changeSub.ready

    // ---- 启用：ui 贡献帧（enable 先验证成功，失败即根因诊断而非 SSE 超时表象）
    const enableRes = await httpCall(base, 'POST', `/api/plugins/${encodeURIComponent(SUPERAGENT_ID)}/enable`, { token })
    assert.equal(enableRes.status, 200, `启用失败：${enableRes.body}`)
    const enabledFrames = await changeSub.frames
    const enabledFrame = enabledFrames.find(
      (f) => f.includes('event: plugin.changed') && f.includes(SUPERAGENT_ID) && f.includes('"enabled":true'),
    )
    assert.ok(enabledFrame, '启用后应收到 plugin.changed（enabled true）')
    const enabledUi =
      sseDataJson<{ ui?: Array<{ pluginId: string; surface: string; spec: Record<string, unknown> }> }>(enabledFrame!)?.ui ?? []
    assert.ok(enabledUi.length > 0, '启用帧应携带 UI 贡献')
    assert.ok(enabledUi.every((u) => u.pluginId === SUPERAGENT_ID), '帧内 ui 应仅为 superagent 贡献')
    const surfaces = new Set(enabledUi.map((u) => u.surface))
    for (const expected of ['sidebar.item', 'sidebar.section', 'screen', 'tool.view', 'timeline.renderer']) {
      assert.ok(surfaces.has(expected), `UI 贡献应含 ${expected}（实际：${[...surfaces].join(',')}）`)
    }
    // 关键 spec：tool.view 接管 dispatch_worker；timeline.renderer 匹配汇报卡
    const toolView = enabledUi.find((u) => u.surface === 'tool.view')
    assert.ok(
      Array.isArray(toolView?.spec.toolNames) && (toolView!.spec.toolNames as string[]).includes('dispatch_worker'),
      'tool.view 应接管 dispatch_worker',
    )
    const timelineRenderer = enabledUi.find((u) => u.surface === 'timeline.renderer')
    assert.equal(
      (timelineRenderer?.spec.matchMeta as { renderer?: string } | undefined)?.renderer,
      RENDERER_WORKER_REPORT,
      'timeline.renderer 应匹配 superagent:worker-report',
    )
    const sidebarTargets = enabledUi
      .filter((u) => u.surface === 'sidebar.item')
      .map((u) => (u.spec as { target?: string }).target)
    assert.ok(sidebarTargets.includes('conversation:profile:superagent'), 'sidebar 应含中枢入口（profile 寻址）')
    assert.ok(sidebarTargets.includes('conversation:profile:watchdog'), 'sidebar 应含看门狗入口')
    assert.ok(sidebarTargets.includes(`screen:${SUPERAGENT_ID}/recall-graph`), 'sidebar 应含记忆图谱入口')

    // ---- publicDoc 增量：订阅 ready 后 dispatch 触发新写入
    const docSub = openSseSubscription(
      base,
      token,
      (fs) => fs.some((f) => f.includes('event: plugin.doc.updated') && f.includes(SUPERAGENT_ID)),
    )
    await docSub.ready

    writeProfile(env.dataDir, 'finance')
    env.faux.setResponses(okPool(4))
    const dispatched = (await host.invokeAction(SUPERAGENT_ID, 'dispatch_worker', {
      prompt: 'SSE 增量验证',
      profileId: 'finance',
    })) as { workerConversationId: number }
    await kernel.waitForIdle(dispatched.workerConversationId)
    // 握手：等汇报 entry 真实落库 + router 自己的模型回合结算 + 无在途任务，
    // 再 disable（否则 plugin_has_live_tasks 如实 409，不靠 sleep 猜）。
    const routerIdNum = (host.getPublicDoc(SUPERAGENT_ID, DOC_INDEX) as { value: IndexDocShape }).value.routerConversationId
    await waitFor(async () => {
      const inputs = await inputEntriesOf(kernel, routerIdNum!)
      return inputs.some((d) => d.meta?.['renderer'] === RENDERER_WORKER_REPORT && d.meta?.['workerId'] === dispatched.workerConversationId)
    })
    await kernel.waitForIdle(routerIdNum!)

    const docFrames = await docSub.frames
    const docFrame = docFrames.find((f) => f.includes('event: plugin.doc.updated') && f.includes(SUPERAGENT_ID))
    assert.ok(docFrame, 'dispatch 后应收到 plugin.doc.updated 增量')
    assert.ok(docFrame!.includes(DOC_INDEX) || docFrame!.includes(DOC_RECALL), '增量应为 index 或 recall-graph')

    // ---- 停用：先建立订阅并等待 snapshot，再触发停用增量。
    const disableSub = openSseSubscription(
      base,
      token,
      (fs) => fs.some((f) => f.includes('event: plugin.changed') && f.includes(SUPERAGENT_ID) && f.includes('"enabled":false')),
    )
    await disableSub.ready
    await host.disable(SUPERAGENT_ID)
    const disableFrames = await disableSub.frames
    const disabledFrame = disableFrames.find(
      (f) => f.includes('event: plugin.changed') && f.includes(SUPERAGENT_ID) && f.includes('"enabled":false'),
    )
    assert.ok(disabledFrame, '停用后应收到 plugin.changed（enabled false）')
    assert.match(disabledFrame!, /"ui":\s*\[\]/, '停用帧 ui 必须为空数组（前端据此清空）')
  } finally {
    if (hub) await hub.close()
    await env.close()
  }
})
