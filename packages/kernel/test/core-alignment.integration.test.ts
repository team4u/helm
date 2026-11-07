/**
 * 核心对齐第一版整链验收测试（只测不改生产）。
 *
 * 与 core.integration.test.ts / app-workflow.integration.test.ts 的分工：
 * 本文件专注 /tmp/helm-core-contract-spec.md 新版契约的跨模块闭环验收，共 6 组：
 *  1. 受管进程 token：受管 bash 内 CLI 磁盘无关登录，token 全链只以脱敏形态
 *     流转（CLI 输出、模型请求、SSE、SQLite 全表扫描）。
 *  2. 受管 bash 工具内真实执行 CLI：env 注入受管 token、exit 0 标记与 CLI 详情
 *     特征真实回传模型上下文，原始 token 不回显。
 *  3. 输入 meta 全链（CLI --meta → helm.input entry → turn_settled）+ 详情分页
 *     首尾无丢 + conversation.entry/live 真实增量事件 + snapshot 扩展
 *     （ui/workflowRuns）+ plugin.changed 携带 ui + 纯脚本 workflow run --wait
 *     与 workflow.updated 完成增量。
 *  4. 插件 doc 公私边界（私有 404 / 公共脱敏 marker / plugin.doc.updated 事件
 *     脱敏）、manageConversation 托管保护、scope 双过滤与 run_action 强制会话。
 *  5. 外部 agent_spawn handled 后端：onResolved/onGateResult 真回传、gate 恰一次、
 *     onWorkflowSettled 阻塞期间 wait() 不返回、resume 重放不重跑 gate、缺 gate
 *     回报显式 failed（gate_result_missing）且不在宿主目录补跑。
 *  6. 双 Profile 独立 SYSTEM/MEMORY 注入、PATCH 切换/清覆盖、重启保留。
 *
 * 诚实性纪律：
 * - 所有模型输出均来自 faux provider 脚本，不代表真实外网模型能力；
 * - SSE 订阅一律先等 snapshot 首帧（onReady）再触发被测行为，断言读到的
 *   必须是真实增量事件，绝不用空数组兜底糊过；
 * - CLI 一律真实子进程（异步 spawn + tsx loader），不用 spawnSync。
 *
 * runner: tsx --test；每项显式 timeout: 60_000。
 */
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'

import { ROOT_CONVERSATION_ID, HelmError, type PluginDefinition } from '@helm/protocol'
import { createHelm } from '../src/app.js'
import { startHub } from '../src/http/index.js'

import assert from 'node:assert/strict'

const testDir = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(testDir, '..', '..', '..')
const cliEntry = join(repoRoot, 'packages', 'cli', 'src', 'index.ts')
const require = createRequire(import.meta.url)
const tsxCli = require.resolve('tsx/cli')

// ---------------------------------------------------------------------------
// 公共基座：真实 createHelm + 临时 dataDir + faux provider
// ---------------------------------------------------------------------------

interface CoreEnv {
  dataDir: string
  dbPath: string
  faux: ReturnType<typeof fauxProvider>
  app: Awaited<ReturnType<typeof createHelm>>
  close(): Promise<void>
}

async function makeCoreEnv(): Promise<CoreEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-align-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  return {
    dataDir,
    dbPath: join(dataDir, 'state.sqlite'),
    faux,
    app,
    async close() {
      await app.close().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** sqlite 全表扫描：包含 needle 的表名集合。 */
function sqliteTablesContaining(dbPath: string, needle: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const hits: string[] = []
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    for (const { name } of tables) {
      const rows = db.prepare(`SELECT * FROM "${name}"`).all() as unknown[]
      if (rows.map((r) => JSON.stringify(r)).join('\n').includes(needle)) hits.push(name)
    }
    return hits
  } finally {
    db.close()
  }
}

/** 异步子进程真 CLI（tsx loader 直跑源码；绝不 spawnSync 阻塞父进程）。 */
interface CliRunResult {
  code: number | null
  out: string
  err: string
  timedOut: boolean
}

function runCliChild(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 25_000,
): Promise<CliRunResult> {
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

/** 与既有集成基座一致：原子等待条件（SSE 帧收集等）。 */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) assert.fail('waitFor 超时')
    await new Promise((r) => setTimeout(r, 25))
  }
}

/**
 * SSE 帧收集器：读到 N 帧或超时返回已有帧。
 * 可选 onReady 在实际读到首帧 snapshot（订阅确已建立并开始接收）后恰好触发
 * 一次——调用方用 Promise 等待它，替代「猜测连接已建立」的竞态写法。
 */
async function collectSse(
  base: string,
  token: string,
  until: (frames: string[]) => boolean,
  timeoutMs = 15_000,
  onReady?: () => void,
): Promise<string[]> {
  const controller = new AbortController()
  const frames: string[] = []
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
      if (until(frames)) break
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        frames.push(frame)
        if (!readyFired && frame.startsWith('event: snapshot')) {
          readyFired = true
          onReady?.()
        }
      }
    }
    return frames
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/** 开一条 SSE 订阅并等 snapshot 首帧就绪；返回 { frames, ready }。 */
function openSseSubscription(
  base: string,
  token: string,
  until: (frames: string[]) => boolean,
  timeoutMs = 25_000,
): { frames: Promise<string[]>; ready: Promise<void> } {
  let signalReady!: () => void
  const ready = new Promise<void>((resolve) => (signalReady = resolve))
  const frames = collectSse(base, token, until, timeoutMs, signalReady)
  return { frames, ready }
}

/** Profile 落盘（profiles/<id>/profile.json + SYSTEM.md + MEMORY.md）。 */
function writeProfile(
  dataDir: string,
  id: string,
  files: { system?: string; memory?: string; model?: string },
): void {
  const dir = join(dataDir, 'profiles', id)
  mkdirSync(dir, { recursive: true })
  const profile: Record<string, unknown> = { id, name: id }
  if (files.model !== undefined) profile.model = files.model
  writeFileSync(join(dir, 'profile.json'), JSON.stringify(profile))
  if (files.system !== undefined) writeFileSync(join(dir, 'SYSTEM.md'), files.system)
  if (files.memory !== undefined) writeFileSync(join(dir, 'MEMORY.md'), files.memory)
}

// ---------------------------------------------------------------------------
// 闭环 1：受管 Token —— 受管 bash 中 CLI 完全不依赖磁盘登录
// ---------------------------------------------------------------------------

test('对齐1: 受管 bash 内 CLI conversations get --current 不依赖磁盘登录，HELM_TOKEN 只以脱敏形态流转', { timeout: 60_000 }, async () => {
  const env = await makeCoreEnv()
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  try {
    hub = await startHub({ kernel: env.app.kernel as never, workflows: env.app.workflows as never, port: 0 })
    const base = hub.url
    const setupRes = await httpCall(base, 'POST', '/api/auth/setup', { body: { password: '对齐测试密码至少八位' } })
    const userToken = (JSON.parse(setupRes.body) as { token: string }).token

    const runtime = env.app.kernel as unknown as { setHubUrl?: (url: string) => void }
    assert.equal(typeof runtime.setHubUrl, 'function', 'KernelRuntime.setHubUrl 应存在')
    runtime.setHubUrl!(base)

    const tokenGetter = (env.app.kernel as unknown as {
      toolDeps?: { processToken?: () => string }
    }).toolDeps?.processToken
    assert.equal(typeof tokenGetter, 'function', 'toolDeps.processToken 应存在')
    const managedToken = tokenGetter!()

    // CLI 在新临时 dataDir（无 cli-token 磁盘文件）下以 HELM_TOKEN env 直连。
    const cliDataDir = mkdtempSync(join(tmpdir(), 'helm-align-cli-'))
    const cliEnvBase = {
      ...process.env,
      HELM_HUB_URL: base,
      HELM_DATA_DIR: cliDataDir,
      HELM_TOKEN: managedToken,
    }
    try {
      assert.equal(existsSync(join(cliDataDir, 'cli-token')), false, '初始无磁盘登录')

      const got = await runCliChild(
        ['conversations', 'get', '--current', '--json'],
        { ...cliEnvBase, HELM_CONVERSATION_ID: String(ROOT_CONVERSATION_ID) },
      )
      assert.equal(got.timedOut, false, 'CLI 子进程不得挂起')
      assert.equal(got.code, 0, `受管 token CLI 应成功：${got.err}`)
      const summary = JSON.parse(got.out) as { id: number; model?: unknown; entries?: unknown[] }
      assert.equal(summary.id, ROOT_CONVERSATION_ID)
      assert.ok(Array.isArray(summary.entries), 'CLI get 应返回详情（entries 时间线）')
      assert.ok(!got.out.includes(managedToken) && !got.err.includes(managedToken), 'CLI 输出不得回显原始 Token')

      // marker 形态：全局脱敏登记后，任何出口出现的是 [REDACTED] 占位符。
      const marker = env.app.kernel.services.stash.redact(managedToken)
      assert.notEqual(marker, managedToken, '受管 token 必须已被全局脱敏登记')

      // 先订阅并等 snapshot 首帧（证明订阅就绪），再提交含 token 的输入；
      // 收集条件同时要求 entry 与 upsert（upsert 在回合结算时才发布，只在
      // 首个 entry 就退出会漏掉结算帧）。
      const sub = openSseSubscription(
        base,
        userToken,
        (fs) =>
          fs.some((f) => f.includes('event: conversation.entry')) &&
          fs.some((f) => f.includes('event: conversation.upsert')),
      )
      await sub.ready

      const requests: string[] = []
      env.faux.setResponses([
        (ctx) => {
          requests.push(JSON.stringify(ctx.messages))
          return fauxAssistantMessage('收到')
        },
      ])
      await env.app.kernel.submitInput(ROOT_CONVERSATION_ID, `凭据是 ${managedToken} 请保密`)
      await env.app.kernel.waitForIdle(ROOT_CONVERSATION_ID)
      assert.ok(requests.length > 0, '应捕获模型请求')
      assert.ok(!requests[0]!.includes(managedToken), '模型请求不得含原始受管 Token')

      // SSE 增量（conversation.entry / upsert）不含原始 token。
      const frames = await sub.frames
      const joined = frames.join('\n')
      assert.ok(joined.includes('event: conversation.entry'), '应收到 conversation.entry 增量事件')
      assert.ok(joined.includes('event: conversation.upsert'), '应收到 conversation.upsert 增量事件')
      assert.ok(!joined.includes(managedToken), 'SSE 帧不得含原始受管 Token')

      assert.deepEqual(
        sqliteTablesContaining(env.dbPath, managedToken),
        [],
        'state.sqlite 任何表不得含原始受管 Token',
      )
    } finally {
      rmSync(cliDataDir, { recursive: true, force: true })
    }
  } finally {
    await hub?.close()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 闭环 2：受管 bash 中真实执行 CLI（bash 工具子进程 env 携带受管 token）
// ---------------------------------------------------------------------------

test('对齐2: 受管 bash 工具内执行 helm conversations get —— env 注入、exit 0 标记、详情特征回传且 Token 不回显', { timeout: 60_000 }, async () => {
  const env = await makeCoreEnv()
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  try {
    hub = await startHub({ kernel: env.app.kernel as never, workflows: env.app.workflows as never, port: 0 })
    const base = hub.url
    const setupRes = await httpCall(base, 'POST', '/api/auth/setup', { body: { password: '对齐测试密码至少八位' } })
    void setupRes

    const runtime = env.app.kernel as unknown as { setHubUrl?: (url: string) => void }
    runtime.setHubUrl!(base)

    const cliDataDir = join(env.dataDir, 'cli-isolated')
    // 尾部 && echo CLI_OK：CLI exit 0 才会输出该标记（&& 链短路）。
    const cmd = [
      `export HELM_DATA_DIR="${cliDataDir}"`,
      `export HELM_CONVERSATION_ID=${ROOT_CONVERSATION_ID}`,
      `"${process.execPath}" "${tsxCli}" "${cliEntry}" conversations get --current --json`,
      'echo CLI_OK',
    ].join(' && ')

    // faux 第 1 响应发起 bash 工具调用；capture 放在工具后的第 2 响应——
    // 固定终答不会携带工具结果上下文，永远无法捕获。
    const toolResults: string[] = []
    env.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: cmd })], { stopReason: 'toolUse' }),
      (ctx) => {
        toolResults.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('done')
      },
    ])

    await env.app.kernel.submitInput(ROOT_CONVERSATION_ID, '请在受管 shell 中执行 helm conversations get --current --json')
    await env.app.kernel.waitForIdle(ROOT_CONVERSATION_ID)

    assert.ok(toolResults.length > 0, '应捕获工具后模型请求')
    const toolCtx = toolResults[0]!
    const managedToken = (env.app.kernel as unknown as { toolDeps?: { processToken?: () => string } }).toolDeps?.processToken?.()
    assert.ok(managedToken, 'toolDeps.processToken 应存在')
    assert.ok(!toolCtx.includes(managedToken!), '工具结果回传模型不得含原始受管 Token')
    // CLI 真实成功的证据链：exit 0 标记 + detail 的 entries 时间线 + helm.input
    // entry + 根会话标题——不能只见数字 1 就算通过。
    assert.ok(toolCtx.includes('CLI_OK'), '工具输出应含 CLI exit 0 标记 CLI_OK')
    assert.ok(toolCtx.includes('helm.input'), 'CLI 详情应含 helm.input entry（本回合输入已落时间线）')
    assert.ok(toolCtx.includes('个人助理'), 'CLI 详情应含根会话标题')
    assert.ok(toolCtx.includes('entries'), 'CLI 详情应含 entries 时间线字段')
    // toolCtx 是消息数组的 JSON.stringify，CLI 输出内嵌时引号被转义（\"id\": 1）
    assert.ok(/id\\?"?\s*:\s*1\b/.test(toolCtx), 'CLI 详情应含会话 id')
  } finally {
    await hub?.close()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 闭环 3：输入 meta 全链 + 详情分页 + 事件 + snapshot 扩展 + workflow 增量
// ---------------------------------------------------------------------------

test('对齐3: CLI send --meta → helm.input entry → turn_settled 全链；分页首尾无丢；entry/live/plugin.changed/workflow.updated 真实增量', { timeout: 60_000 }, async () => {
  const env = await makeCoreEnv()
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  try {
    hub = await startHub({ kernel: env.app.kernel as never, workflows: env.app.workflows as never, port: 0 })
    const base = hub.url
    const setupRes = await httpCall(base, 'POST', '/api/auth/setup', { body: { password: '对齐测试密码至少八位' } })
    const userToken = (JSON.parse(setupRes.body) as { token: string }).token

    // 插件：收集 turn_settled inputs（meta 应原样到达）
    const settledInputs: Array<{ origins: string[]; metas: Array<Record<string, unknown> | undefined> }> = []
    await env.app.kernel.plugins.register({
      id: 'test:meta-probe',
      name: 'meta 探针',
      definePlugin(ctx) {
        ctx.hook.onTurnSettled((payload) => {
          settledInputs.push({
            origins: payload.inputs.map((i) => i.origin),
            metas: payload.inputs.map((i) => i.meta),
          })
        })
      },
    } satisfies PluginDefinition)

    // 三条订阅全部等 snapshot 首帧就绪后再触发被测行为：
    // A: CLI send 回合的 conversation.entry / conversation.live 增量；
    // B: plugin.changed 启/停两帧；
    // C: 纯脚本 workflow run 的 workflow.updated 完成增量。
    const subA = openSseSubscription(
      base,
      userToken,
      (fs) =>
        fs.some((f) => f.includes('event: conversation.entry')) &&
        fs.some((f) => f.includes('event: conversation.live')),
    )
    const subB = openSseSubscription(
      base,
      userToken,
      (fs) => fs.filter((f) => f.includes('event: plugin.changed')).length >= 2,
    )
    const subC = openSseSubscription(
      base,
      userToken,
      (fs) =>
        fs.some((f) => f.includes('event: workflow.updated') && f.includes('"status":"completed"')),
    )
    await Promise.all([subA.ready, subB.ready, subC.ready])

    // CLI send --meta + --wait
    const meta = { renderer: 'test.render', ticket: 7, nested: { ok: true } }
    const cliDataDir = mkdtempSync(join(tmpdir(), 'helm-align-cli-'))
    try {
      env.faux.setResponses([fauxAssistantMessage('meta 回合完成')])
      const sent = await runCliChild(
        ['send', String(ROOT_CONVERSATION_ID), '带元数据的输入', '--meta', JSON.stringify(meta), '--wait', '--json'],
        { ...process.env, HELM_HUB_URL: base, HELM_DATA_DIR: cliDataDir, HELM_TOKEN: userToken },
      )
      assert.equal(sent.timedOut, false)
      if (sent.code !== 0) {
        assert.fail(`send --meta --wait 失败：${sent.err}`)
      }
      // send --wait 返回 ConversationInputResult：text 即本次回答，entry 为回答条目
      const waitResult = JSON.parse(sent.out) as { text: string; entry?: { id: string } }
      assert.equal(waitResult.text, 'meta 回合完成', 'send --wait 应返回本次回答文本')
      assert.ok(waitResult.entry?.id, 'send --wait 应返回本次回答 entry id')
    } finally {
      rmSync(cliDataDir, { recursive: true, force: true })
    }

    // turn_settled：meta 全链到达
    await waitFor(() => settledInputs.length > 0)
    assert.equal(settledInputs[0]!.metas.length, 1)
    assert.deepEqual(settledInputs[0]!.metas[0], meta, 'meta 应从 CLI 原样到达 turn_settled')

    // 详情：GET /api/conversations/1 含 helm.input entry 的 data.meta
    const detailRes = await httpCall(base, 'GET', '/api/conversations/1', { token: userToken })
    assert.equal(detailRes.status, 200)
    const detail = JSON.parse(detailRes.body) as {
      entries: Array<{ kind: string; data?: { meta?: Record<string, unknown>; text?: string }; model?: unknown[] }>
    }
    const inputEntry = detail.entries.find((e) => e.kind === 'helm.input')
    assert.ok(inputEntry, 'detail 应含 helm.input entry')
    assert.deepEqual(inputEntry!.data?.meta, meta, 'helm.input entry 应携带 meta')

    // assistant 文本在 entry.model（不在 data）——detail 不丢模型消息
    const assistantEntry = detail.entries.find((e) => e.kind === 'pi.assistant')
    if (assistantEntry) {
      assert.ok(
        JSON.stringify(assistantEntry.model ?? '').includes('meta 回合完成'),
        'assistant 文本应在 entry.model（模型上下文消息）',
      )
    }

    // SSE：conversation.entry 与 conversation.live 真实增量到达（订阅先于回合建立）
    const frames = await subA.frames
    const joined = frames.join('\n')
    assert.ok(joined.includes('event: conversation.entry'), '应收到 conversation.entry 事件')
    assert.ok(joined.includes('event: conversation.live'), '应收到 conversation.live 事件')
    const inputFrame = frames.find((f) => f.includes('event: conversation.entry') && f.includes('test.render'))
    assert.ok(inputFrame, 'conversation.entry 增量应携带 helm.input 的 meta')

    // 首帧 snapshot 扩展：ui 与 workflowRuns 必填
    const snapFrame = frames.find((f) => f.startsWith('event: snapshot'))
    assert.ok(snapFrame, '订阅应收到首帧 snapshot')
    assert.ok(snapFrame!.includes('"ui"'), 'snapshot 应含 ui（插件 UI 贡献）')
    assert.ok(snapFrame!.includes('"workflowRuns"'), 'snapshot 应含 workflowRuns')

    // 分页：limit=1 首页 + cursor 翻页到尾，聚合无丢失无重复
    const firstPageRes = await httpCall(base, 'GET', '/api/conversations/1?limit=1', { token: userToken })
    assert.equal(firstPageRes.status, 200)
    const firstPage = JSON.parse(firstPageRes.body) as { entries: Array<{ id: string }>; nextCursor?: string }
    assert.equal(firstPage.entries.length, 1)
    assert.ok(firstPage.nextCursor, '应有下一页 cursor')
    const collected = [...firstPage.entries.map((e) => e.id)]
    let cursor: string | undefined = firstPage.nextCursor
    let guard = 0
    while (cursor !== undefined && guard++ < 50) {
      const pageRes = await httpCall(base, 'GET', `/api/conversations/1?limit=2&cursor=${encodeURIComponent(cursor)}`, { token: userToken })
      assert.equal(pageRes.status, 200, `cursor 翻页失败：${pageRes.body}`)
      const page = JSON.parse(pageRes.body) as { entries: Array<{ id: string }>; nextCursor?: string }
      collected.push(...page.entries.map((e) => e.id))
      cursor = page.nextCursor
    }
    assert.equal(new Set(collected).size, collected.length, '分页不得重复 entry')
    const fullRes = await httpCall(base, 'GET', '/api/conversations/1', { token: userToken })
    const full = JSON.parse(fullRes.body) as { entries: Array<{ id: string }> }
    assert.deepEqual(
      [...collected].sort(),
      full.entries.map((e) => e.id).sort(),
      '分页聚合必须与全量一致（首尾无丢）',
    )

    // plugin.changed 携带 ui：订阅 ready 后启/停带 UI 贡献的探针插件，
    // 同连接依次收到 ui 非空与 ui 空数组两帧，不靠重连重新拉 snapshot。
    await env.app.kernel.plugins.register({
      id: 'test:ui-probe',
      name: 'UI 探针',
      definePlugin(ctx) {
        ctx.ui.sidebarItem({ id: 'ui-probe', label: '对齐探针', target: 'conversation:1' })
      },
    } satisfies PluginDefinition)
    await env.app.kernel.plugins.disable('test:ui-probe')
    const changeFrames = await subB.frames
    const changed = changeFrames.filter((f) => f.includes('event: plugin.changed'))
    assert.ok(changed.length >= 2, `同连接应收到启/停两次 plugin.changed（实际 ${changed.length}）`)
    const withUi = changed.find((f) => f.includes('"ui"') && f.includes('sidebar.item'))
    assert.ok(withUi, '启用事件应携带 ui 贡献（含 surface）')
    const disabledEmptyUi = changed.find((f) => f.includes('"enabled":false') && /"ui":\s*\[\]/.test(f))
    assert.ok(disabledEmptyUi, '停用事件 ui 应为空数组（客户端据此替换贡献）')

    // 纯脚本 workflow：订阅 ready 后经 CLI run --wait 真实执行，
    // 校验 CLI 终态输出与 workflow.updated 完成增量两路证据。
    const cliDataDir2 = mkdtempSync(join(tmpdir(), 'helm-align-cli-'))
    const wfScriptPath = join(cliDataDir2, 'align-wait.workflow.js')
    writeFileSync(
      wfScriptPath,
      'export const meta = { name: "align-wait", description: "t" }\nreturn args.x * 2\n',
    )
    try {
      const wf = await runCliChild(
        [
          'workflows', 'run',
          wfScriptPath,
          '--args', JSON.stringify({ x: 21 }),
          '--wait', '--json',
        ],
        { ...process.env, HELM_HUB_URL: base, HELM_DATA_DIR: cliDataDir2, HELM_TOKEN: userToken },
      )
      assert.equal(wf.timedOut, false)
      if (wf.code !== 0) {
        assert.fail(`workflows run --wait 失败：${wf.err}`)
      }
      const runSummary = JSON.parse(wf.out) as { id: string; status: string; result?: unknown }
      assert.equal(runSummary.status, 'completed')
      assert.equal(runSummary.result, 42)
      const wfFrames = await subC.frames
      const completedFrame = wfFrames.find(
        (f) => f.includes('event: workflow.updated') && f.includes(runSummary.id) && f.includes('"status":"completed"'),
      )
      assert.ok(completedFrame, '同连接应收到该 run 的 workflow.updated 完成增量')
    } finally {
      rmSync(cliDataDir2, { recursive: true, force: true })
    }
  } finally {
    await hub?.close()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 闭环 4：插件 doc 公私 / manageConversation / scope
// ---------------------------------------------------------------------------

test('对齐4: ctx.doc 公私边界、plugin.doc.updated 脱敏增量、manageConversation 托管保护、scope 工具可见与 run_action 强制会话', { timeout: 60_000 }, async () => {
  const env = await makeCoreEnv()
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  // busy gate 释放函数：try 外声明（finally 兕底可调），resolve 幂等，重复调用无害
  let releaseBusy: () => void = () => {}
  try {
    const kernel = env.app.kernel
    const host = kernel.plugins

    // 公共 doc 值含秘密形态：公共事件必须脱敏（占位符），私有 404。
    const SECRET = 'align-doc-secret-蓝色'
    const placeholder = kernel.services.stash.put(ROOT_CONVERSATION_ID, 'DOC_SECRET', SECRET)

    const busyGate = new Promise<void>((r) => (releaseBusy = r))
    const eventsSeen: string[] = []

    // 公共 doc 更新闭包：订阅 ready 后由测试显式触发，事件才是真实增量
    // （注册期更新发生在订阅之前，永远等不到帧——不猜、不糊）。
    type PubDoc = { note: string; secret: string }
    let updatePubDoc!: (fn: (v: PubDoc) => PubDoc) => void

    const conv = await kernel.createConversation({ title: '托管会话', profileId: 'assistant' })

    await host.register({
      id: 'test:guard',
      name: '守护探针',
      definePlugin(ctx) {
        const pub = ctx.doc('status', { note: 'init', secret: SECRET }, { public: true })
        const priv = ctx.doc('inner', { count: 0 })
        updatePubDoc = (fn) => pub.update(fn)
        ctx.action<Record<string, never>, { ok: boolean }>({
          id: 'blocked_out',
          description: 'scope 外不可经会话路径调用',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          outputSchema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false,
          },
          scope: { conversationIds: [conv.id] },
          handler: () => ({ ok: true }),
        })
        ctx.tool<{ text: string }>({
          name: 'guard_scoped',
          description: 'scope 限定工具',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
          scope: { profileIds: ['assistant'] },
          execute: (input) => ({ echoed: input.text }),
        })
        ctx.action<Record<string, never>, { done: boolean }>({
          id: 'busy',
          description: '占住在途任务',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          outputSchema: {
            type: 'object',
            properties: { done: { type: 'boolean' } },
            required: ['done'],
            additionalProperties: false,
          },
          handler: async () => {
            await busyGate
            return { done: true }
          },
        })
        ctx.hook.onTurnSettled(() => {
          eventsSeen.push('settled')
        })
        // 托管：本插件管理 conv
        ctx.host.manageConversation(conv.id)
        // 私有 doc 更新不发事件（仅公共 doc 是事件出口）
        priv.update((v) => ({ count: v.count + 1 }))
      },
    } satisfies PluginDefinition)

    hub = await startHub({ kernel: kernel as never, workflows: env.app.workflows as never, port: 0 })
    const base = hub.url
    const setupRes = await httpCall(base, 'POST', '/api/auth/setup', { body: { password: '对齐测试密码至少八位' } })
    const userToken = (JSON.parse(setupRes.body) as { token: string }).token

    // --- 私有 doc：HTTP 404；公共 doc 可读且秘密以 stash marker 呈现
    const privateDoc = await httpCall(base, 'GET', `/api/plugins/test:guard/docs/inner`, { token: userToken })
    assert.equal(privateDoc.status, 404, `私有 doc 必须 404：${privateDoc.status}`)
    const publicDoc = await httpCall(base, 'GET', `/api/plugins/test:guard/docs/status`, { token: userToken })
    if (publicDoc.status !== 200) {
      assert.fail(`公共 doc 应可读（插件 doc HTTP）：${publicDoc.status}`)
    }
    assert.ok(!publicDoc.body.includes(SECRET), '公共 doc 出站不得含秘密明文')
    assert.ok(publicDoc.body.includes(placeholder), '公共 doc 秘密字段应以 stash marker 呈现')

    // --- plugin.doc.updated 真实增量：订阅 ready 后实际更新并校验事件脱敏
    // （原写法订阅发生在更新之后、超时后 catch([])，根本没验证事件）。
    const docSub = openSseSubscription(
      base,
      userToken,
      (fs) => fs.some((f) => f.includes('event: plugin.doc.updated') && f.includes('after-subscribe')),
    )
    await docSub.ready
    updatePubDoc((v) => ({ ...v, note: 'after-subscribe' }))
    const docFrames = await docSub.frames
    const docFrame = docFrames.find((f) => f.includes('event: plugin.doc.updated'))
    assert.ok(docFrame, '应收到 plugin.doc.updated 增量事件')
    assert.ok(!docFrame!.includes(SECRET), 'plugin.doc.updated 不得含秘密明文')
    assert.ok(docFrame!.includes(placeholder), 'plugin.doc.updated 秘密应以 stash marker 呈现')
    assert.ok(docFrame!.includes('after-subscribe'), '事件应携带更新后的 marker 值')
    // 公共 doc 读值同步为更新后内容（marker 仍脱敏）
    const publicDoc2 = await httpCall(base, 'GET', `/api/plugins/test:guard/docs/status`, { token: userToken })
    assert.equal(publicDoc2.status, 200)
    assert.ok(publicDoc2.body.includes('after-subscribe'), '公共 doc 应反映更新后的值')
    assert.ok(!publicDoc2.body.includes(SECRET), '更新后公共 doc 仍不得含秘密明文')

    // --- 托管保护：DELETE 受管会话 409 conversation_managed_by_plugin
    const delManaged = await httpCall(base, 'DELETE', `/api/conversations/${conv.id}`, { token: userToken })
    assert.equal(delManaged.status, 409)
    assert.equal(JSON.parse(delManaged.body).error.code, 'conversation_managed_by_plugin')
    // 保护生效期间不产生 abort 副作用：会话仍存在
    assert.equal(kernel.getConversation(conv.id).id, conv.id)

    // --- scope：listTools(conversation) 按会话筛选
    const listToolsFn = host as unknown as {
      listTools?: (conversation?: { id: number; profileId: string; tags: string[] }) => Array<{ name: string }>
    }
    if (typeof listToolsFn.listTools !== 'function') {
      assert.fail('PluginHost.listTools(conversation) scope 筛选应存在')
    }
    const assistantTools = listToolsFn.listTools!({
      id: ROOT_CONVERSATION_ID,
      profileId: 'assistant',
      tags: [],
    })!.map((t) => t.name)
    const otherTools = listToolsFn.listTools!({ id: 999, profileId: 'other', tags: [] })!.map((t) => t.name)
    assert.ok(assistantTools.includes('guard_scoped'), 'assistant 会话应见 guard_scoped')
    assert.ok(!otherTools.includes('guard_scoped'), '其他 profile 会话不得见 guard_scoped')

    // invokeAction 带 conversationId 必须命中 scope；未命中显式拒绝
    const okCall = await host.invokeAction('test:guard', 'blocked_out', {}, { conversationId: conv.id })
    assert.deepEqual(okCall, { ok: true })
    await assert.rejects(
      () => host.invokeAction('test:guard', 'blocked_out', {}, { conversationId: ROOT_CONVERSATION_ID }),
      (err: unknown) => err instanceof HelmError && /scope|作用域/.test(err.message),
      'scope 外 conversationId 调用应显式拒绝',
    )
    // 无 conversationId 的人工 HTTP 调用不受限（会话策略而非用户鉴权）
    const httpNoCtx = await httpCall(base, 'POST', '/api/actions/test:guard/blocked_out', { token: userToken, body: { input: {} } })
    assert.equal(httpNoCtx.status, 200)

    // run_action 元工具强制携带 conversationId：绕过 scope 的调用被拒。
    const runActionOutputs: string[] = []
    env.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('run_action', { actionId: 'test:guard.blocked_out', input: {} })],
        { stopReason: 'toolUse' },
      ),
      (ctx) => {
        runActionOutputs.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('结束')
      },
    ])
    // 根会话 #1 不在 scope（conversationIds 仅含 conv.id）→ 工具结果应显式拒绝
    await kernel.submitInput(ROOT_CONVERSATION_ID, '调用 run_action test:guard.blocked_out')
    await kernel.waitForIdle(ROOT_CONVERSATION_ID)
    assert.ok(
      runActionOutputs.some((o) => /scope|作用域|拒绝/.test(o)),
      'run_action 在 scope 外会话应被显式拒绝（错误可见于工具结果）',
    )

    // --- 在途任务期间 disable 拒绝（409 plugin_has_live_tasks）；释放后 disable 成功并解除托管
    const busy = host.invokeAction('test:guard', 'busy', {})
    await assert.rejects(
      () => host.disable('test:guard'),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_has_live_tasks',
    )
    releaseBusy()
    assert.deepEqual(await busy, { done: true })
    await host.disable('test:guard')

    // disable 后托管释放：DELETE 现在应成功（停用自动释放）
    const delAfter = await httpCall(base, 'DELETE', `/api/conversations/${conv.id}`, { token: userToken })
    assert.equal(delAfter.status, 200, `disable 后托管应释放：${delAfter.body}`)
    void eventsSeen
  } finally {
    // 失败路径兕底：释放 busy gate，避免 cleanup 挂住（resolve 幂等）
    releaseBusy?.()
    await hub?.close()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 闭环 5：外部后端 onAgentSpawn handled —— onResolved/onGateResult 真回传
// ---------------------------------------------------------------------------

test('对齐5: 测试插件 agent_spawn handled 外部后端——onResolved 真实元数据、onGateResult 真实 kernel.runGate、Gate 恰一次、结算顺序与缺 gate 显式失败', { timeout: 60_000 }, async () => {
  const env = await makeCoreEnv()
  // settle gate 释放函数：try 外声明（finally 兕底可调），resolve 幂等，重复调用无害
  let releaseSettle: () => void = () => {}
  try {
    const kernel = env.app.kernel
    const { workflows } = env.app

    // 外部执行环境（真实临时目录，不猜宿主目录）
    const execDir = join(env.dataDir, 'external-exec')
    mkdirSync(execDir, { recursive: true })
    const gateDir = join(env.dataDir, 'gate-files')
    const execId = `ext-${Date.now()}`

    const spawns: Array<{ prompt: string; gate?: string; schema?: unknown }> = []
    const gates: Array<{ command: string; cwd?: string }> = []
    let settleCount = 0
    let settleEntered = false
    const settleGate = new Promise<void>((r) => (releaseSettle = r))

    await kernel.plugins.register({
      id: 'test:ext-backend',
      name: '外部后端',
      definePlugin(ctx) {
        ctx.hook.onAgentSpawn(async (request) => {
          spawns.push({
            prompt: request.prompt,
            gate: request.gate,
            schema: request.schema,
          })
          if (request.onResolved === undefined || request.onGateResult === undefined) {
            throw new HelmError('test_backend_contract', '外部后端必须收到 onResolved/onGateResult 回调', 500)
          }
          // 回传真实执行元数据（真实临时目录 + executionId + worktree）
          request.onResolved({
            executionId: execId,
            effectiveCwd: execDir,
            worktree: { path: execDir, branch: 'align-wt' },
          })
          // gate 在外部执行环境内真实执行（kernel.runGate 真实 shell 于 execDir）
          if (request.gate !== undefined) {
            const result = await kernel.runGate(request.gate, { cwd: execDir, conversationId: request.parentConversationId })
            gates.push({ command: request.gate, cwd: execDir })
            request.onGateResult(result)
          }
          // Schema 业务数据（handled result；source 如实声明进 schema）
          return { action: 'handled', result: { answer: 42, source: 'external' } }
        })
        ctx.host.onWorkflowSettled(async () => {
          settleEntered = true
          settleCount += 1
          await settleGate
        })
      },
    } satisfies PluginDefinition)

    // gate 计数文件（真实 shell 副作用，恰一次）
    const gateCmd = `mkdir -p "${gateDir}" && printf x >> "${join(gateDir, 'count')}" && test -f "${join(execDir, 'marker')}" || (touch "${join(execDir, 'marker')}"; true)`

    // schema 如实声明 source：additionalProperties:false 下 handled 返回的
    // {answer, source} 必须全部入 schema，绝不靠削弱校验换通过。
    const script =
      'export const meta = { name: "align-ext", description: "external backend" }\n' +
      'const v = await agent("外部提取", { schema: ' +
      JSON.stringify({
        type: 'object',
        properties: {
          answer: { type: 'number' },
          source: { type: 'string' },
        },
        required: ['answer'],
        additionalProperties: false,
      }) +
      ', gate: ' + JSON.stringify(gateCmd) + ' })\n' +
      'return v'

    const started = await workflows.run({ script, conversationId: ROOT_CONVERSATION_ID })

    // 结算顺序死锁验证：先拿 wait promise，等 onWorkflowSettled 确已进入，
    // 断言 wait 尚未返回（settleGate 未释放），再 release 并取真实结果。
    let waitDone = false
    const waitPromise = workflows.wait(started.id).then((r) => {
      waitDone = true
      return r
    })
    await waitFor(() => settleEntered === true)
    assert.equal(waitDone, false, 'onWorkflowSettled 未完成前 workflows.wait 不得返回')
    releaseSettle()
    const result = (await waitPromise) as { answer: number; source?: string }
    assert.deepEqual(result, { answer: 42, source: 'external' }, '外部后端 handled 结果应回传脚本')

    // 节点元数据保留：executionId / effectiveCwd / worktree / gate
    const summary = workflows.getRun(started.id)
    const node = summary.nodes?.find((n) => n.kind === 'agent')
    assert.ok(node, '应含 agent 节点')
    assert.equal(node!.executionId, execId, '节点应保留外部 executionId')
    assert.equal(node!.effectiveCwd, execDir, '节点应保留外部 effectiveCwd')
    assert.deepEqual(node!.worktree, { path: execDir, branch: 'align-wt' })
    assert.ok(node!.gate?.ok === true, '节点应含 gate 执行结果')

    // Gate 文件恰一次（onGateResult 回报使引擎跳过第二次执行）
    await waitFor(() => existsSync(join(gateDir, 'count')))
    assert.equal(readFileSync(join(gateDir, 'count'), 'utf8'), 'x', 'gate 恰好执行一次')
    assert.equal(settleCount, 1, 'onWorkflowSettled 应恰好触发一次')

    // resume 重放不再 gate、不再执行外部后端
    const gatesBefore = gates.length
    const resumed = await workflows.run({ resumeFromRunId: started.id, conversationId: ROOT_CONVERSATION_ID })
    const resumedResult = (await workflows.wait(resumed.id)) as { answer: number; source?: string }
    assert.equal(resumedResult.answer, 42)
    assert.equal(gates.length, gatesBefore, 'resume 重放不得再执行 gate')
    assert.equal(readFileSync(join(gateDir, 'count'), 'utf8'), 'x', 'gate 副作用不重复')

    // 停用第一个 handled 后端，避免它截获后续缺 gate 场景的 spawn
    await kernel.plugins.disable('test:ext-backend')

    // --- 缺 Gate 回报：显式 failed，不在宿主猜目录执行
    await kernel.plugins.register({
      id: 'test:ext-nogate',
      name: '缺 gate 回报后端',
      definePlugin(ctx) {
        ctx.hook.onAgentSpawn((request) => {
          request.onResolved?.({ executionId: `${execId}-nogate`, effectiveCwd: execDir })
          // 故意不回报 onGateResult
          return { action: 'handled', result: { answer: 1 } }
        })
      },
    } satisfies PluginDefinition)

    // agent() 失败按引擎契约返回 null（不 throw）；脚本必须在 null 时显式
    // throw 才能让整个 run 断言为 failed。
    const badScript =
      'export const meta = { name: "align-nogate", description: "gate result missing" }\n' +
      'const v = await agent("缺 gate 回报", { gate: ' + JSON.stringify(gateCmd) + ' })\n' +
      'if (v === null || v === undefined) throw new Error("agent 未返回结果")\n' +
      'return v'
    const bad = await workflows.run({ script: badScript, conversationId: ROOT_CONVERSATION_ID })
    await workflows.wait(bad.id)
    const badSummary = workflows.getRun(bad.id)
    assert.equal(badSummary.status, 'failed', '缺 gate 回报应显式 failed')
    const badNode = badSummary.nodes?.find((n) => n.kind === 'agent')
    assert.ok(badNode, '应含 agent 节点')
    assert.ok(badNode!.status === 'failed')
    // 只认节点真实诊断（gate_result_missing 由引擎写入 node.error）；
    // ?? summary.error 回退会命中脚本自行 throw 的字样，是假通过路径，禁用。
    assert.ok(
      typeof badNode!.error === 'string' && badNode!.error.includes('gate_result_missing'),
      `agent 节点 error 应含真实诊断 gate_result_missing：${String(badNode!.error)}`,
    )
    // 不在宿主猜目录执行：gate 计数不因该 run 增加（真实副作用而非编造消息）
    assert.equal(readFileSync(join(gateDir, 'count'), 'utf8'), 'x', '缺回报 run 不得在宿主目录执行 gate')
    assert.equal(gates.length, gatesBefore, '缺回报 run 不得经后端执行 gate')
  } finally {
    // 失败路径兕底：释放 settle gate，避免 workflows.close() 经未完成的
    // onWorkflowSettled 监听永久挂住（resolve 幂等）。
    releaseSettle()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 闭环 6：两个 Profile 独立 SYSTEM/MEMORY 与模型 + HTTP PATCH 切换 + 重启保留
// ---------------------------------------------------------------------------

test('对齐6: 双 Profile 独立 SYSTEM/MEMORY/模型，PATCH 切换与清覆盖后请求一致，重启保留', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-align-profile-'))

  writeProfile(dataDir, 'researcher', {
    system: '# Researcher System\n你是研究员。唯一标记 ALIGN-SYS-RESEARCHER。',
    memory: 'RESEARCHER-MEM: 偏好引文',
  })
  writeProfile(dataDir, 'coder', {
    system: '# Coder System\n你是程序员。唯一标记 ALIGN-SYS-CODER。',
    memory: 'CODER-MEM: 偏好测试',
  })

  const build = async () => {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
    return { faux, app }
  }

  const requests: string[] = []
  const first = await build()
  try {
    // 两个 profile 各自会话
    const r1 = await first.app.kernel.createConversation({ title: '研究员', profileId: 'researcher' })
    const c1 = await first.app.kernel.createConversation({ title: '程序员', profileId: 'coder' })

    // researcher 回合：faux 捕获 system sections
    first.faux.setResponses([
      (ctx) => {
        requests.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('r')
      },
    ])
    await first.app.kernel.submitInput(r1.id, ' researcher 你是谁')
    await first.app.kernel.waitForIdle(r1.id)

    // coder 回合
    first.faux.setResponses([
      (ctx) => {
        requests.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('c')
      },
    ])
    await first.app.kernel.submitInput(c1.id, ' coder 你是谁')
    await first.app.kernel.waitForIdle(c1.id)

    assert.ok(requests.length >= 2)
    assert.ok(requests[0]!.includes('ALIGN-SYS-RESEARCHER'), 'researcher 回合应注入其 SYSTEM')
    assert.ok(!requests[0]!.includes('ALIGN-SYS-CODER'), 'researcher 回合不得串入 coder SYSTEM')
    assert.ok(requests[0]!.includes('RESEARCHER-MEM'), 'researcher 回合应注入其 MEMORY')
    assert.ok(requests[1]!.includes('ALIGN-SYS-CODER'), 'coder 回合应注入其 SYSTEM')
    assert.ok(requests[1]!.includes('CODER-MEM'), 'coder 回合应注入其 MEMORY')
    assert.ok(!requests[1]!.includes('ALIGN-SYS-RESEARCHER'), 'coder 回合不得串入 researcher SYSTEM')
  } finally {
    await first.app.close()
  }

  // 重启：profile 绑定与注入保留
  const second = await build()
  try {
    const convs = second.app.kernel.listConversations()
    const r1 = convs.find((c) => c.title === '研究员')
    const c1 = convs.find((c) => c.title === '程序员')
    assert.ok(r1 && c1, '重启后会话保留')

    const requests2: string[] = []
    second.faux.setResponses([
      (ctx) => {
        requests2.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('r2')
      },
    ])
    await second.app.kernel.submitInput(r1!.id, '再问一次')
    await second.app.kernel.waitForIdle(r1!.id)
    assert.ok(requests2[0]!.includes('ALIGN-SYS-RESEARCHER'), '重启后 SYSTEM 注入保留')

    // HTTP PATCH 换 Profile：注入随之切换
    let hub: Awaited<ReturnType<typeof startHub>> | undefined
    try {
      hub = await startHub({ kernel: second.app.kernel as never, workflows: second.app.workflows as never, port: 0 })
      const base = hub.url
      const setupRes = await httpCall(base, 'POST', '/api/auth/setup', { body: { password: '对齐测试密码至少八位' } })
      const token = (JSON.parse(setupRes.body) as { token: string }).token

      const patched = await httpCall(base, 'PATCH', `/api/conversations/${r1!.id}`, {
        token,
        body: { profileId: 'coder' },
      })
      assert.equal(patched.status, 200, `PATCH profile 失败：${patched.body}`)

      const requests3: string[] = []
      second.faux.setResponses([
        (ctx) => {
          requests3.push(JSON.stringify(ctx.messages))
          return fauxAssistantMessage('c2')
        },
      ])
      await second.app.kernel.submitInput(r1!.id, '换 profile 后再问')
      await second.app.kernel.waitForIdle(r1!.id)
      assert.ok(requests3[0]!.includes('ALIGN-SYS-CODER'), 'PATCH 换 Profile 后注入应切换')
      assert.ok(!requests3[0]!.includes('ALIGN-SYS-RESEARCHER'), '不得残留旧 Profile SYSTEM')

      // 显式模型覆盖 + 清覆盖：summary 与真实请求一致
      const override = await httpCall(base, 'PATCH', `/api/conversations/${r1!.id}`, {
        token,
        body: { model: 'faux/faux-1' },
      })
      assert.equal(override.status, 200)
      const cleared = await httpCall(base, 'PATCH', `/api/conversations/${r1!.id}`, {
        token,
        body: { model: '' },
      })
      assert.equal(cleared.status, 200, "PATCH model:'' 清覆盖应被接受")
      const afterClear = JSON.parse(cleared.body) as { model: string }
      assert.ok(typeof afterClear.model === 'string' && afterClear.model !== '', '清覆盖后生效模型回落 Profile/全局且非空')
    } finally {
      await hub?.close()
    }
  } finally {
    await second.app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
