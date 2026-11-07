/**
 * builtin:superagent 主插件整链验收。
 *
 * 组合纪律：真实 createHelm（真 SQLite + 真 PluginHost + 真 assistant +
 * WorkflowService）+ faux provider；启用插件走 host.enable（真实 service.start
 * 自举）。不 mock app、不 fake host 端口（纯函数单测除外）。
 *
 * 诚实性纪律：所有「模型输出」均来自 faux.setResponses 脚本；断言针对跨模块
 * 契约；失败如实抛出，不 skip、不吞。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁；命令加总超时。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'

import { ROOT_CONVERSATION_ID, HelmError } from '@helm/protocol'
import { createHelm } from '../src/app.js'
import {
  parseMutedSources,
  resolveSuperAgentConfig,
  assertIndexDoc,
  assertSubscriptionsDoc,
  assertRecallDoc,
  updateRecallDoc,
  searchRecallNodes,
  recallHasNode,
  type RecallNodeInput,
} from '../src/builtin-plugins/superagent.js'

// ---------------------------------------------------------------------------
// 基建
// ---------------------------------------------------------------------------

const WORKER_REPORT_MARKER = 'superagent:worker-report'

interface TestEnv {
  dataDir: string
  dbPath: string
  faux: ReturnType<typeof fauxProvider>
  app: Awaited<ReturnType<typeof createHelm>>
  /** 提交输入并等回合真正结算（含 turn_settled 钩子）。 */
  submitAndWait(conversationId: number, text: string, opts?: { origin?: 'human' | 'agent' | 'trigger' }): Promise<void>
  close(): Promise<void>
}

async function makeEnv(): Promise<TestEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-superagent-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models, watchdogIntervalMs: 0 })
  faux.setResponses([])
  const env: TestEnv = {
    dataDir,
    dbPath: join(dataDir, 'state.sqlite'),
    faux,
    app,
    async submitAndWait(conversationId, text, opts) {
      await app.kernel.submitInput(conversationId, text, opts)
      await app.kernel.waitForIdle(conversationId)
    },
    async close() {
      try {
        await app.close()
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
  }
  return env
}

/** 冲刷 doc 持久队列后读取插件公共 doc 原始持久值。 */
async function readDocRaw(env: TestEnv, name: string): Promise<unknown> {
  await env.app.kernel.documentStore.flush()
  const db = new DatabaseSync(join(env.dataDir, 'state.sqlite'), { readOnly: true })
  try {
    const row = db
      .prepare("SELECT value FROM helm_plugin_docs WHERE plugin_id = '__global' AND name = ?")
      .get(`builtin:superagent:${name}`) as { value: string } | undefined
    assert.ok(row, `doc ${name} 应已持久化`)
    return JSON.parse(row.value)
  } finally {
    db.close()
  }
}

async function enableSuperAgent(env: TestEnv): Promise<void> {
  await env.app.kernel.plugins.enable('builtin:superagent')
}

/** 等待谓词成立（轮询，默认 5s 超时）。 */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) assert.fail('waitFor 超时：条件在限定时间内未成立')
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** 取 doc index 中登记的 router/watchdog 会话 ID。 */
async function residentIds(env: TestEnv): Promise<{ router?: number; watchdog?: number }> {
  const doc = (await readDocRaw(env, 'index')) as { routerConversationId?: number; watchdogConversationId?: number }
  return { router: doc.routerConversationId, watchdog: doc.watchdogConversationId }
}

/** 直接从磁盘读 index（跨重启场景：无活动 app 引用）。 */
async function residentIdsRaw(dataDir: string): Promise<{ router?: number; watchdog?: number }> {
  const db = new DatabaseSync(join(dataDir, 'state.sqlite'), { readOnly: true })
  try {
    const row = db
      .prepare("SELECT value FROM helm_plugin_docs WHERE plugin_id = '__global' AND name = 'builtin:superagent:index'")
      .get() as { value: string } | undefined
    assert.ok(row, 'doc index 应已持久化')
    const doc = JSON.parse(row.value) as { routerConversationId?: number; watchdogConversationId?: number }
    return { router: doc.routerConversationId, watchdog: doc.watchdogConversationId }
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// 共享：faux 响应路由与中枢汇报握手
// ---------------------------------------------------------------------------

/** 独立 makeEnv 的 faux 路由工厂：无共享、按用户末条文本精确路由。 */
/** 路由工厂：按用户末条文本精确路由。工具结果回合（末条消息是 toolResult）
 * 短路返回收尾文本，防止同一 user 文本再次命中 toolCall 造成派工循环。 */
const route = (map: Record<string, ReturnType<typeof fauxAssistantMessage>>) => (context: {
  messages: Array<{ role: string; content: unknown }>
}): ReturnType<typeof fauxAssistantMessage> => {
  if (context.messages.at(-1)?.role === 'toolResult') return fauxAssistantMessage('工具结果已知悉，本回合收尾')
  const users = context.messages.filter((m) => m.role === 'user')
  const last = users.at(-1)
  const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
  for (const [needle, resp] of Object.entries(map)) {
    if (text.includes(needle)) return resp
  }
  return fauxAssistantMessage(`（未脚本化：${text.slice(0, 40)}）`)
}

/** 中枢汇报握手：等 Router 收到含 marker 的汇报卡输入（汇报真实落库）。 */
async function waitfoWorkerReport(env: TestEnv, router: number, marker: string): Promise<void> {
  await waitFor(async () => {
    const detail = await env.app.kernel.getConversationDetail(router, { limit: 50 })
    return detail.entries.some((e) => e.kind === 'helm.input' && JSON.stringify(e.data).includes(marker))
  })
}

// ---------------------------------------------------------------------------
// 1. 纯函数与配置校验
// ---------------------------------------------------------------------------

test('superagent1: 配置解析——默认值/精确 mutedSources/非法显式拒绝', { timeout: 60_000 }, () => {
  const def = resolveSuperAgentConfig({})
  assert.equal(def.routerMode, true)
  assert.equal(def.mutedSources, '')
  assert.equal(def.stalledAfterMs, 300_000)
  assert.equal(def.abortAfterMs, 1_800_000)
  assert.equal(def.errorThreshold, 3)

  const custom = resolveSuperAgentConfig({ routerMode: false, mutedSources: 'cron, webhook:1\nnoise', stalledAfterMs: 1000, abortAfterMs: 1000 })
  assert.equal(custom.routerMode, false)
  assert.deepEqual([...parseMutedSources(custom.mutedSources)].sort(), ['cron', 'noise', 'webhook:1'])

  assert.throws(() => resolveSuperAgentConfig({ stalledAfterMs: 0 }), /正有限整数/)
  assert.throws(() => resolveSuperAgentConfig({ stalledAfterMs: 1.5 }), /正有限整数/)
  assert.throws(() => resolveSuperAgentConfig({ stalledAfterMs: Number.POSITIVE_INFINITY }), /正有限整数/)
  assert.throws(() => resolveSuperAgentConfig({ abortAfterMs: 100, stalledAfterMs: 200 }), /大于等于/)
  assert.throws(() => resolveSuperAgentConfig({ routerMode: 'yes' }), /布尔值/)
  assert.throws(() => resolveSuperAgentConfig({ watchdogEnabled: 1 }), /布尔值/)
  assert.throws(() => resolveSuperAgentConfig({ mutedSources: 5 }), /字符串/)
})

/** 与生产写入同形状的完整 RecallNode（弱化 fixture 会被强校验如实拒绝）。 */
const recallNode = (id: string): RecallNodeInput => ({
  id,
  conversationId: Number(id.split(':')[0]),
  profileId: 'assistant',
  completionSeq: Number(id.split(':')[1]),
  outcome: 'completed',
  summary: `任务 ${id}`,
  artifacts: [],
  keywords: ['assistant', 'completed'],
  createdAt: 1,
})

test('superagent2: doc 边界验证与 RecallGraph 去重/检索纯函数', { timeout: 60_000 }, () => {
  assertIndexDoc({ version: 1, workers: [] })
  assert.throws(() => assertIndexDoc({ version: 2, workers: [] }), /结构非法/)
  assert.throws(
    () => assertIndexDoc({ version: 1, workers: [{ conversationId: 'x', parentConversationId: 1, profileId: 'p', createdAt: 1 }] }),
    /非法条目/,
  )
  assertSubscriptionsDoc({ version: 1, subscriptions: [] })
  assert.throws(() => assertSubscriptionsDoc({ version: 1, subscriptions: [{ threadKey: '', workerConversationId: 1, createdAt: 1 }] }), /非法条目/)
  assert.throws(
    () => assertSubscriptionsDoc({ version: 1, subscriptions: [{ threadKey: 'a', workerConversationId: 2, createdAt: 1 }, { threadKey: 'a', workerConversationId: 3, createdAt: 2 }] }),
    /重复订阅/,
  )
  // 常驻 ID：#1 拒绝、非整数拒绝、router=watchdog 拒绝；worker 重复登记拒绝。
  assert.throws(() => assertIndexDoc({ version: 1, routerConversationId: 1, workers: [] }), /routerConversationId/)
  assert.throws(() => assertIndexDoc({ version: 1, routerConversationId: 2.5, workers: [] }), /routerConversationId/)
  assert.throws(() => assertIndexDoc({ version: 1, routerConversationId: 3, watchdogConversationId: 3, workers: [] }), /不得相同/)
  assert.throws(
    () => assertIndexDoc({ version: 1, workers: [{ conversationId: 4, parentConversationId: 2, profileId: 'p', createdAt: 1 }, { conversationId: 4, parentConversationId: 2, profileId: 'p', createdAt: 2 }] }),
    /重复登记/,
  )
  assert.throws(
    () => assertIndexDoc({ version: 1, workers: [{ conversationId: 4, parentConversationId: 2, profileId: 'p', createdAt: Number.NaN }] }),
    /非法条目/,
  )
  assertRecallDoc({ version: 1, nodes: [] })
  assert.throws(() => assertRecallDoc({ version: 1 }), /结构非法/)
  // RecallNode 真实契约：缺字段/非正整数/非法 outcome/重复 id 均显式 corrupt。
  assert.throws(
    () => assertRecallDoc({ version: 1, nodes: [recallNode('5:1'), recallNode('5:1')] }),
    /重复节点/,
  )

  const store = {
    value: { version: 1 as const, nodes: [] as Array<Record<string, unknown>> },
    get() {
      return this.value
    },
    set(v: unknown) {
      this.value = v as typeof this.value
    },
  }
  assert.equal(updateRecallDoc(store, recallNode('5:1')), true)
  // artifacts 破损节点：写入即被 assertRecallDoc 拒绝（真实契约强校验）。
  assert.throws(
    () => updateRecallDoc(store, { ...recallNode('5:9'), artifacts: [{ id: 'a' }] as never }),
    /含非法节点/,
  )
  assert.equal(updateRecallDoc(store, recallNode('5:1')), false) // completionSeq 去重
  assert.equal(updateRecallDoc(store, recallNode('5:2')), true)
  assert.equal(updateRecallDoc(store, recallNode('6:1')), true)
  assert.equal(recallHasNode(store.value, '6:1'), true)
  assert.throws(() => updateRecallDoc(store, { ...recallNode('5:3'), outcome: 'running' }), /completed\|failed\|aborted/)
  const hits = searchRecallNodes(store.value, '任务 5', 10) as Array<{ id: string }>
  assert.equal(hits.length, 2) // 5:1 与 5:2 都含「任务 5」（AND 分词）
  const latest = searchRecallNodes(store.value, '', 2) as Array<{ id: string }>
  assert.deepEqual(latest.map((n) => n.id), ['6:1', '5:2']) // 倒序 + limit
})

// ---------------------------------------------------------------------------
// 2. 默认停用注册 / 启用自举 / 幂等 / 保护释放
// ---------------------------------------------------------------------------

test('superagent3: createHelm 默认停用注册；无 UI、无动作、无会话副作用', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const host = env.app.kernel.plugins
    const before = env.app.kernel.listConversations().length
    const summary = host.list().find((p) => p.id === 'builtin:superagent')
    assert.ok(summary, 'builtin:superagent 应默认注册')
    assert.equal(summary.enabled, false)
    assert.equal(summary.hooks.length, 0)
    assert.equal(summary.actions.length, 0)
    assert.deepEqual(host.listUi().filter((u) => u.pluginId === 'builtin:superagent'), [])
    // 停用注册不产生 Profile/技能/会话/公开 doc
    assert.equal(existsSync(join(env.dataDir, 'profiles', 'superagent')), false)
    assert.equal(existsSync(join(env.dataDir, 'skills', 'watchdog-playbooks')), false)
    assert.equal(env.app.kernel.listConversations().length, before)
    await assert.throws(
      () => host.getPublicDoc('builtin:superagent', 'index'),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'plugin_doc_not_found')
        return true
      },
    )
    const cfg = host.getConfigSchema('builtin:superagent')
    assert.deepEqual(Object.keys(cfg).sort(), ['abortAfterMs', 'errorThreshold', 'mutedSources', 'routerMode', 'stalledAfterMs', 'watchdogEnabled'])
  } finally {
    await env.close()
  }
})

test('superagent4: 启用自举——Profile/技能/两常驻会话/公开 doc/管理保护', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await enableSuperAgent(env)
    const kernel = env.app.kernel
    // Profile 资产（逐文件）
    const sys = readFileSync(join(env.dataDir, 'profiles', 'superagent', 'SYSTEM.md'), 'utf8')
    assert.match(sys, /SuperAgent 中枢/)
    assert.match(readFileSync(join(env.dataDir, 'profiles', 'watchdog', 'SYSTEM.md'), 'utf8'), /巡检看门狗/)
    assert.match(readFileSync(join(env.dataDir, 'skills', 'watchdog-playbooks', 'SKILL.md'), 'utf8'), /watchdog-playbooks/)
    assert.ok(existsSync(join(env.dataDir, 'skills', 'watchdog-playbooks', 'references', 'herdr-stalled.md')))
    assert.ok(existsSync(join(env.dataDir, 'skills', 'watchdog-playbooks', 'references', 'ci-failure.md')))
    assert.ok(existsSync(join(env.dataDir, 'profiles', 'superagent', 'MEMORY.md')))
    assert.ok(existsSync(join(env.dataDir, 'profiles', 'watchdog', 'MEMORY.md')))

    // 常驻会话：动态分配 + 持久化 + 无角色 Tag + helm 归属 + 管理保护
    const ids = await residentIds(env)
    assert.ok(Number.isInteger(ids.router) && ids.router! > 1)
    assert.ok(Number.isInteger(ids.watchdog) && ids.watchdog! > 1)
    assert.notEqual(ids.router, ids.watchdog)
    const router = kernel.getConversation(ids.router!)
    assert.equal(router.profileId, 'superagent')
    assert.deepEqual(router.tags, [])
    assert.equal(kernel.getConversationOwnership(ids.router!), 'helm')
    await assert.rejects(
      () => env.app.kernel.deleteConversation(ids.router!),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'conversation_managed_by_plugin')
        return true
      },
    )
    // 根 #1 不受影响
    assert.equal(kernel.getConversation(ROOT_CONVERSATION_ID).profileId, 'assistant')

    // 公开 doc 三件套
    const index = host2(env).getPublicDoc('builtin:superagent', 'index')
    assert.equal((index.value as { workers: unknown[] }).workers.length, 0)
    const subs = host2(env).getPublicDoc('builtin:superagent', 'subscriptions')
    assert.equal((subs.value as { subscriptions: unknown[] }).subscriptions.length, 0)
    const recall = host2(env).getPublicDoc('builtin:superagent', 'recall-graph')
    assert.equal((recall.value as { nodes: unknown[] }).nodes.length, 0)

    // 动作与工具清单
    const summary = host2(env).list().find((p) => p.id === 'builtin:superagent')!
    assert.ok(summary.enabled)
    for (const action of ['dispatch_worker', 'inspect_worker', 'recall_context', 'subscribe_thread', 'archive_worker', 'set_router_mode']) {
      assert.ok(summary.actions.includes(action), `动作 ${action} 应注册`)
    }
    for (const tool of ['dispatch_worker', 'inspect_worker', 'recall_context', 'subscribe_thread']) {
      assert.ok(summary.tools.includes(tool), `工具 ${tool} 应注册`)
    }
    // 工具 scope：仅中枢会话可见
    const routerTools = host2(env).listTools(kernel.getConversation(ids.router!)).map((t) => t.name)
    const rootTools = host2(env).listTools(kernel.getConversation(ROOT_CONVERSATION_ID)).map((t) => t.name)
    assert.ok(routerTools.includes('dispatch_worker'))
    assert.ok(!rootTools.includes('dispatch_worker'))
  } finally {
    await env.close()
  }
})

function host2(env: TestEnv) {
  return env.app.kernel.plugins
}

/** 当前 router 会话 ID（从公开 doc 读取）。 */
async function residentRouter(env: TestEnv): Promise<number> {
  const ids = await residentIds(env)
  assert.ok(ids.router, 'router 会话应已分配')
  return ids.router!
}

test('superagent5: 幂等自举——不覆盖用户文件；partial-start 补齐缺文件', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await enableSuperAgent(env)
    // 用户自定义内容：启用后修改，再次禁用/启用不覆盖
    writeFileSync(join(env.dataDir, 'profiles', 'superagent', 'SYSTEM.md'), '# 我的中枢\n自定义提示词\n')
    writeFileSync(join(env.dataDir, 'skills', 'watchdog-playbooks', 'references', 'ci-failure.md'), '# 我的 CI 手册\n')
    await env.app.kernel.plugins.disable('builtin:superagent')
    await enableSuperAgent(env)
    assert.equal(readFileSync(join(env.dataDir, 'profiles', 'superagent', 'SYSTEM.md'), 'utf8'), '# 我的中枢\n自定义提示词\n')
    assert.equal(readFileSync(join(env.dataDir, 'skills', 'watchdog-playbooks', 'references', 'ci-failure.md'), 'utf8'), '# 我的 CI 手册\n')

    // partial-start：删掉 SYSTEM.md 与 references 文件（保留 profile.json），重启补齐
    rmSync(join(env.dataDir, 'profiles', 'superagent', 'SYSTEM.md'))
    rmSync(join(env.dataDir, 'skills', 'watchdog-playbooks', 'references', 'ci-failure.md'))
    await env.app.kernel.plugins.disable('builtin:superagent')
    await enableSuperAgent(env)
    assert.match(readFileSync(join(env.dataDir, 'profiles', 'superagent', 'SYSTEM.md'), 'utf8'), /SuperAgent 中枢/)
    assert.match(readFileSync(join(env.dataDir, 'skills', 'watchdog-playbooks', 'references', 'ci-failure.md'), 'utf8'), /CI 失败处置/)
    // 用户文件仍原样（watchdog SYSTEM.md 未被删除步骤触及，保持自举默认或用户版本）
    assert.ok(existsSync(join(env.dataDir, 'profiles', 'watchdog', 'MEMORY.md')))
  } finally {
    await env.close()
  }
})

test('superagent6: 重启复用常驻 ID；停用期间被删则重建；Profile 被改则显式诊断', { timeout: 60_000 }, async () => {
  // 6a. 重启复用
  {
    const dataDir = mkdtempSync(join(tmpdir(), 'helm-superagent-restart-'))
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    const first = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models, watchdogIntervalMs: 0 })
    await first.kernel.plugins.enable('builtin:superagent')
    const ids1 = await residentIdsRaw(dataDir)
    await first.close()
    // 第二次启动：持久启停状态沿用（enabled），ID 复用
    const second = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models, watchdogIntervalMs: 0 })
    try {
      const summary = second.kernel.plugins.list().find((p) => p.id === 'builtin:superagent')!
      assert.equal(summary.enabled, true, '重启后应沿用持久化启用状态')
      const ids2 = await residentIdsRaw(dataDir)
      assert.equal(ids2.router, ids1.router)
      assert.equal(ids2.watchdog, ids1.watchdog)
    } finally {
      try {
        await second.close()
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    }
  }
  // 6b. 停用期间删除常驻会话 → 重新启用时重建（不盲目占用）
  {
    const env = await makeEnv()
    try {
      await enableSuperAgent(env)
      const ids = await residentIds(env)
      await env.app.kernel.plugins.disable('builtin:superagent')
      await env.app.kernel.deleteConversation(ids.router!)
      // doc 中仍记录旧 ID，但会话已删；重新启用重建并更新 index
      await enableSuperAgent(env)
      const rebuilt = await residentIds(env)
      assert.ok(rebuilt.router !== ids.router, '被删常驻会话应重建为新 ID')
      assert.equal(env.app.kernel.getConversation(rebuilt.router!).profileId, 'superagent')
    } finally {
      await env.close()
    }
  }
  // 6c. 常驻会话被改成错误 Profile → 显式诊断拒绝启用（不盲目占用）
  {
    const env = await makeEnv()
    try {
      await enableSuperAgent(env)
      const ids = await residentIds(env)
      await env.app.kernel.plugins.disable('builtin:superagent')
      await env.app.kernel.updateConversation(ids.router!, { profileId: 'assistant' })
      await assert.rejects(
        () => enableSuperAgent(env),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'superagent_resident_conversation_conflict')
          assert.match(err.message, /拒绝占用/)
          return true
        },
      )
    } finally {
      await env.close()
    }
  }
})

// ---------------------------------------------------------------------------
// 3. L0 trigger 路由
// ---------------------------------------------------------------------------

test('superagent7: trigger——静默丢弃/threadKey 直投/其余进中枢/失效订阅自愈', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await enableSuperAgent(env)
    const kernel = env.app.kernel
    const ids = await residentIds(env)

    // 静默丢弃：muted source 配置后 handled（不投任何会话）
    await kernel.plugins.setConfig('builtin:superagent', { mutedSources: 'cron' })
    await kernel.dispatchTrigger({ id: 'evt-1', source: 'cron', text: '噪音', createdAt: Date.now() })
    assert.equal(kernel.getConversation(ids.router!).unread, false, '静默事件不得投递中枢')

    // 其余事件进中枢（origin trigger + defang 包裹）
    env.faux.setResponses([
      route({ '构建失败': fauxAssistantMessage('中枢收到'), '请盯住 CI': fauxAssistantMessage('中枢收到') }),
      route({ '构建失败': fauxAssistantMessage('中枢收到'), '请盯住 CI': fauxAssistantMessage('中枢收到') }),
      route({ '构建失败': fauxAssistantMessage('中枢收到'), '请盯住 CI': fauxAssistantMessage('中枢收到') }),
    ])
    await kernel.dispatchTrigger({ id: 'evt-2', source: 'webhook:ci', text: '构建失败', createdAt: Date.now() })
    await kernel.waitForIdle(ids.router!)
    const detail = await kernel.getConversationDetail(ids.router!, { limit: 10 })
    const input = detail.entries.find((e) => e.kind === 'helm.input')
    assert.ok(input, '中枢应收到事件输入')
    assert.match(JSON.stringify(input.data), /external_event/)
    assert.match(JSON.stringify(input.data), /webhook:ci/)

    // threadKey 直投：先派一个 Worker 并订阅（响应工厂按用户末条文本路由，避免 FIFO 竞争）
    const routeByLastUser = route
    const routerScript = routeByLastUser({
      '请盯住 CI': fauxAssistantMessage([fauxToolCall('dispatch_worker', { prompt: '盯住 CI', threadKey: 'ci-watch' })], { stopReason: 'toolUse' }),
      '盯住 CI': fauxAssistantMessage('已派工'),
      'Worker #': fauxAssistantMessage('汇报知悉'),
      '构建失败': fauxAssistantMessage('中枢收到'),
      'CI 恢复': fauxAssistantMessage('回退中枢'),
    })
    env.faux.setResponses([routerScript, routerScript, routerScript, routerScript, routerScript, routerScript])
    await env.submitAndWait(ids.router!, '请盯住 CI')
    // 汇报握手：中枢收到 Worker 汇报卡且消费回合真正结算（此后才动队列）。
    await env.app.kernel.waitForIdle(ids.router!)
    await waitfoWorkerReport(env, ids.router!, '已派工')
    await env.app.kernel.waitForIdle(ids.router!)
    const worker = ((await readDocRaw(env, 'index')) as { workers: Array<{ conversationId: number }> }).workers[0]
    assert.ok(worker, 'dispatch_worker 应真实建会话并登记')
    assert.ok(((await readDocRaw(env, 'subscriptions')) as { subscriptions: unknown[] }).subscriptions.length >= 1)

    // 命中订阅：事件直投 Worker（不进中枢）。worker 侧补两条响应：
    // 一条消化派工汇报后中枢可能拉起的值守回合，一条消化直投回合。
    await kernel.waitForIdle(worker.conversationId)
    const workerScript = routeByLastUser({
      'CI 又失败了': fauxAssistantMessage('Worker 收到直投'),
      '盯住 CI': fauxAssistantMessage('Worker 值守中'),
      'Worker #': fauxAssistantMessage('汇报知悉'),
    })
    env.faux.setResponses(Array.from({ length: 8 }, () => workerScript))
    await kernel.dispatchTrigger({ id: 'evt-3', source: 'webhook:ci', text: 'CI 又失败了', threadKey: 'ci-watch', createdAt: Date.now() })
    // 直投回合结算 + 汇报卡入中枢并消费完毕，再断言「不进中枢」与归档。
    await kernel.waitForIdle(worker.conversationId)
    await waitfoWorkerReport(env, ids.router!, 'Worker 收到直投')
    await kernel.waitForIdle(ids.router!)
    const workerDetail = await kernel.getConversationDetail(worker.conversationId, { limit: 10 })
    const direct = workerDetail.entries.filter((e) => e.kind === 'helm.input').at(-1)
    assert.match(JSON.stringify(direct?.data), /CI 又失败了/)
    const routerInputs = (await kernel.getConversationDetail(ids.router!, { limit: 50 })).entries.filter(
      (e) => e.kind === 'helm.input' && JSON.stringify(e.data).includes('CI 又失败了'),
    )
    assert.equal(routerInputs.length, 0, '直投事件不得进中枢')

    // 失效订阅自愈：归档 Worker 后订阅清空，同 threadKey 事件回退中枢
    env.faux.setResponses(Array.from({ length: 6 }, () => routerScript))
    await kernel.plugins.invokeAction('builtin:superagent', 'archive_worker', { workerConversationId: worker.conversationId })
    assert.equal(((await readDocRaw(env, 'subscriptions')) as { subscriptions: unknown[] }).subscriptions.length, 0)
    await kernel.dispatchTrigger({ id: 'evt-4', source: 'webhook:ci', text: 'CI 恢复', threadKey: 'ci-watch', createdAt: Date.now() })
    await kernel.waitForIdle(ids.router!)
    const detail2 = await kernel.getConversationDetail(ids.router!, { limit: 10 })
    assert.match(JSON.stringify(detail2.entries.filter((e) => e.kind === 'helm.input').at(-1)?.data), /CI 恢复/)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 4. before_turn 收敛 / tool_call 守卫 / 非阻塞派工
// ---------------------------------------------------------------------------

test('superagent8: 中枢剥离重度工具注入 active_workers；tool_call 守卫阻止绕过', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await enableSuperAgent(env)
    const kernel = env.app.kernel
    const ids = await residentIds(env)
    const routerSections: string[] = []
    const rootSections: string[] = []
    env.faux.setResponses([
      (context) => {
        if (routerSections.length === 0) {
          routerSections.push(...context.messages.flatMap((m) => (m.role === 'system' ? Object.keys((m as { sections?: Record<string, string> }).sections ?? {}) : [])))
        }
        return fauxAssistantMessage('中枢秒回')
      },
    ])
    env.faux.appendResponses([
      (context) => {
        if (rootSections.length === 0) {
          rootSections.push(...context.messages.flatMap((m) => (m.role === 'system' ? Object.keys((m as { sections?: Record<string, string> }).sections ?? {}) : [])))
        }
        return fauxAssistantMessage('助理回复')
      },
    ])
    await env.submitAndWait(ids.router!, '你好')
    const routerDetail = await kernel.getConversationDetail(ids.router!, { limit: 5 })
    assert.ok(routerDetail.entries.length > 0, '中枢应完成回合')
    assert.ok(
      routerSections.includes('superagent.active_workers'),
      `中枢请求应含 active_workers section（实际：${routerSections.join(',')}）`,
    )
    await env.submitAndWait(ROOT_CONVERSATION_ID, '你好')
    assert.ok(!rootSections.includes('superagent.active_workers'), '#1 不注入中枢态势')

    // tool_call 守卫：模型在旧上下文残留工具上发起 bash 调用 → 回合级 block（工具错误结果带回模型）
    env.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'printf guard' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('守卫生效后收尾'),
    ])
    await env.submitAndWait(ids.router!, '尝试直接跑 shell')
    const guardDetail = await kernel.getConversationDetail(ids.router!, { limit: 20 })
    const guardJson = JSON.stringify(guardDetail.entries)
    assert.match(guardJson, /中枢路由模式已剥离/, 'bash 调用应被守卫拦截并带回显式原因')
  } finally {
    await env.close()
  }
})

test('superagent9: dispatch_worker 非阻塞——立即返回、worker 标签/parent/归属、并发同 threadKey 冲突', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await enableSuperAgent(env)
    const kernel = env.app.kernel
    const ids = await residentIds(env)
    const router = ids.router!

    // 动作路径（人工无会话上下文）——返回 { workerConversationId }
    const dispatched = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
      prompt: '整理季度报表',
      profileId: 'assistant',
    })) as { workerConversationId: number }
    assert.ok(Number.isInteger(dispatched.workerConversationId))
    const workerSummary = kernel.getConversation(dispatched.workerConversationId)
    assert.deepEqual(workerSummary.tags, ['worker'])
    assert.equal(workerSummary.parentConversationId, router)
    assert.equal(kernel.getConversationOwnership(dispatched.workerConversationId), 'helm')
    assert.equal(((await readDocRaw(env, 'index')) as { workers: unknown[] }).workers.length, 1)

    // 禁止派生中枢/看门狗（自激防护）；Profile 不存在显式拒绝
    await assert.rejects(
      () => kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: 'x', profileId: 'superagent' }),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && /自激/.test(err.message),
    )
    await assert.rejects(
      () => kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: 'x', profileId: 'no-such-profile' }),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && /不存在/.test(err.message),
    )

    // 先等首个 Worker 回合结束，再等其汇报卡在中枢真实落库并结算（faux 队列确定性消耗）。
    await kernel.waitForIdle(dispatched.workerConversationId)
    await waitfoWorkerReport(env, router, 'Worker #' + String(dispatched.workerConversationId))
    await kernel.waitForIdle(router)
    await waitFor(async () => env.faux.getPendingResponseCount() === 0)
    // 工具路径：中枢模型经 dispatch_worker 派工（真实工具执行链；响应按用户末条文本路由）
    env.faux.setResponses([
      route({
        '帮我盯住流水线': fauxAssistantMessage([fauxToolCall('dispatch_worker', { prompt: '盯住流水线', threadKey: 'ci-main' })], { stopReason: 'toolUse' }),
        '盯住流水线': fauxAssistantMessage('派工完成'),
      }),
    ])
    await env.submitAndWait(router, '帮我盯住流水线')
    // 新 Worker 汇报握手：订阅断言前先等汇报落库（汇报卡 markers 含 Worker 摘要首词）。
    await waitfoWorkerReport(env, router, '盯住流水线')
    await kernel.waitForIdle(router)
    await waitFor(async () => env.faux.getPendingResponseCount() === 0)
    const subs = (await readDocRaw(env, 'subscriptions')) as { subscriptions: Array<{ threadKey: string; workerConversationId: number }> }
    assert.equal(subs.subscriptions.length, 1)
    assert.equal(subs.subscriptions[0]!.threadKey, 'ci-main')

    // 并发同 threadKey：第二个必须显式冲突（不能都成功产生有效订阅）
    const [first, second] = await Promise.allSettled([
      kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: '任务A', threadKey: 'same-key' }),
      kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: '任务B', threadKey: 'same-key' }),
    ])
    const outcomes = [first, second]
    const fulfilled = outcomes.filter((r) => r.status === 'fulfilled')
    const rejected = outcomes.filter((r) => r.status === 'rejected')
    assert.equal(fulfilled.length, 1, '并发同 threadKey 恰好一个成功')
    assert.equal(rejected.length, 1)
    const reason = rejected[0] as PromiseRejectedResult
    assert.ok(reason.reason instanceof HelmError)
    assert.equal(reason.reason.code, 'superagent_thread_key_conflict')
    const after = (await readDocRaw(env, 'subscriptions')) as { subscriptions: Array<{ threadKey: string }> }
    assert.equal(after.subscriptions.filter((s) => s.threadKey === 'same-key').length, 1)

    // subscribe_thread 冲突不抢占 + 幂等重订
    const okWorker = (fulfilled[0] as PromiseFulfilledResult<{ workerConversationId: number }>).value.workerConversationId
    await assert.rejects(
      () => kernel.plugins.invokeAction('builtin:superagent', 'subscribe_thread', { threadKey: 'same-key', workerConversationId: dispatched.workerConversationId }),
      (err: unknown) => err instanceof HelmError && err.code === 'superagent_thread_key_conflict',
    )
    const rebind = await kernel.plugins.invokeAction('builtin:superagent', 'subscribe_thread', {
      threadKey: 'same-key',
      workerConversationId: okWorker,
    })
    assert.deepEqual(rebind, { threadKey: 'same-key', workerConversationId: okWorker })
  } finally {
    await env.close()
  }
})

test('superagent10: 工具执行会话二次校验——同 Profile 人类直聊不能调中枢工具', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await enableSuperAgent(env)
    const kernel = env.app.kernel
    // 人类开一个 superagent Profile 直聊会话（模拟同 Profile 滥用路径）
    const humanChat = await kernel.createConversation({ title: '人类直聊', profileId: 'superagent' })
    await assert.rejects(
      () =>
        kernel.plugins.executeTool(
          'dispatch_worker',
          { prompt: 'x' },
          { conversationId: humanChat.id },
        ),
      (err: unknown) => err instanceof HelmError && (err.code === 'conversation_scope_violation' || /不是中枢/.test(err.message)),
    )
    // 中枢真实会话可以（先派一个真 worker 再检视）
    const ids = await residentIds(env)
    const dispatched = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: '检视样本' })) as {
      workerConversationId: number
    }
    await kernel.waitForIdle(dispatched.workerConversationId)
    const result = (await kernel.plugins.executeTool('inspect_worker', { workerConversationId: dispatched.workerConversationId }, { conversationId: ids.router! })) as {
      conversationId: number
      status: string
    }
    assert.equal(result.conversationId, dispatched.workerConversationId)
    assert.ok(typeof result.status === 'string')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 5. turn_settled：origin 汇报与 RecallGraph
// ---------------------------------------------------------------------------

test('superagent11: 含 agent/trigger 输入的回合向中枢汇报；纯 human 回合仅写 RecallGraph', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await enableSuperAgent(env)
    const kernel = env.app.kernel
    const ids = await residentIds(env)
    const router = ids.router!

    // dispatch 初始提交用路由工厂（汇报回合按汇报卡文本路由，不再依赖队列顺序）。
    env.faux.setResponses([
      route({
        '对账任务': fauxAssistantMessage('对账任务已启动'),
        '回合失败': fauxAssistantMessage('汇报知悉'),
        '回合完成': fauxAssistantMessage('汇报知悉'),
        '回合被中止': fauxAssistantMessage('汇报知悉'),
      }),
    ])
    const dispatched = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
      prompt: '对账任务',
    })) as { workerConversationId: number }
    const workerId = dispatched.workerConversationId
    // 初始回合 + 其汇报回合在中枢完全结算后再排下一阶段。
    await kernel.waitForIdle(workerId)
    await kernel.waitForIdle(router)
    await waitFor(async () => env.faux.getPendingResponseCount() === 0)

    // agent 回合：Worker 完成（faux 脚本回答）→ 汇报卡入中枢
    env.faux.setResponses([
      route({
        '对账任务': fauxAssistantMessage('对账完成：共 12 笔，全部平账'),
        '对账完成': fauxAssistantMessage('汇报知悉'),
      }),
    ])
    await env.submitAndWait(workerId, '对账任务', { origin: 'agent' })
    await kernel.waitForIdle(workerId)
    // 中枢汇报握手：等汇报卡真实落库且中枢消费回合结算（不依赖 sleep）。
    await waitfoWorkerReport(env, router, '对账完成')
    await kernel.waitForIdle(router)
    await waitFor(async () => env.faux.getPendingResponseCount() === 0)
    await waitFor(async () => {
      const doc = (await readDocRaw(env, 'recall-graph')) as { nodes: Array<{ conversationId: number; summary: string }> }
      return doc.nodes.some((n) => n.conversationId === workerId && n.summary.includes('对账完成'))
    })
    const recall = (await readDocRaw(env, 'recall-graph')) as { nodes: Array<{ id: string; summary: string; outcome: string; profileId: string; conversationId: number }> }
    const node = recall.nodes.find((n) => n.conversationId === workerId && n.summary.includes('对账完成'))!
    assert.equal(node.outcome, 'completed')
    assert.equal(node.profileId, 'assistant')
    // 汇报卡：中枢收到 origin=agent 输入 + renderer meta（等其真实落库）
    let report: { kind: string; data?: unknown } | undefined
    await waitFor(async () => {
      const routerDetail = await kernel.getConversationDetail(router, { limit: 50 })
      report = routerDetail.entries.find(
        (e) => e.kind === 'helm.input' && JSON.stringify(e.data).includes(WORKER_REPORT_MARKER) && JSON.stringify(e.data).includes('对账完成'),
      )
      return report !== undefined
    })
    assert.ok(report, '中枢应收到带 renderer meta 的汇报卡')
    const reportData = report.data as { meta?: { workerId?: number; summary?: string; renderer?: string } }
    assert.equal(reportData.meta!.workerId, workerId)
    assert.match(reportData.meta!.summary!, /对账完成/)

    // 纯 human 回合：只写 RecallGraph，不投中枢汇报卡（等上一轮汇报完全落地后再计数）
    await waitFor(async () => {
      const detail = await kernel.getConversationDetail(router, { limit: 50 })
      return detail.entries.some((e) => e.kind === 'helm.input' && JSON.stringify(e.data).includes('对账完成'))
    })
    const reportsBefore = (await kernel.getConversationDetail(router, { limit: 50 })).entries.filter(
      (e) => e.kind === 'helm.input' && JSON.stringify(e.data).includes(WORKER_REPORT_MARKER),
    ).length
    const nodesBefore = ((await readDocRaw(env, 'recall-graph')) as { nodes: unknown[] }).nodes.length
    env.faux.setResponses([fauxAssistantMessage('人类介入的补充说明')])
    await env.submitAndWait(workerId, '人工补充一点上下文', { origin: 'human' })
    await waitFor(async () => ((await readDocRaw(env, 'recall-graph')) as { nodes: unknown[] }).nodes.length > nodesBefore)
    const recallAfter = (await readDocRaw(env, 'recall-graph')) as { nodes: unknown[] }
    const reportsAfter = (await kernel.getConversationDetail(router, { limit: 50 })).entries.filter(
      (e) => e.kind === 'helm.input' && JSON.stringify(e.data).includes(WORKER_REPORT_MARKER),
    ).length
    assert.equal(reportsAfter, reportsBefore, '纯 human 回合不得向中枢投递汇报卡')
    assert.ok(recallAfter.nodes.length > nodesBefore, '纯 human 回合仍写 RecallGraph')

    // completionSeq 去重：同 ID 节点不重复
    const idsInGraph = ((await readDocRaw(env, 'recall-graph')) as { nodes: Array<{ id: string }> }).nodes.map((n) => n.id)
    assert.equal(new Set(idsInGraph).size, idsInGraph.length, 'RecallGraph 节点 ID 不得重复')
  } finally {
    await env.close()
  }
})

test('superagent12: 三终态覆盖——failed/aborted 同样汇报且 outcome 如实', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await enableSuperAgent(env)
    const kernel = env.app.kernel
    const ids = await residentIds(env)

    // failed：初始提交消耗 '启动'；汇报回合（failed 卡片）由路由工厂消化。
    env.faux.setResponses([
      route({
        '失败任务': fauxAssistantMessage('启动'),
        '回合失败': fauxAssistantMessage('汇报知悉'),
      }),
    ])
    const w1 = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: '失败任务' })) as {
      workerConversationId: number
    }
    await kernel.waitForIdle(w1.workerConversationId)
    await waitFor(async () => env.faux.getPendingResponseCount() === 0)
    env.faux.setResponses([
      route({
        '失败任务': fauxAssistantMessage('boom', { stopReason: 'error' }),
        '回合失败': fauxAssistantMessage('汇报知悉'),
      }),
    ])
    await env.submitAndWait(w1.workerConversationId, '失败任务', { origin: 'agent' })
    // failed 节点落图 + 中枢汇报回合结算（握手而非 sleep）。
    await waitFor(async () => {
      const doc = (await readDocRaw(env, 'recall-graph')) as { nodes: Array<{ conversationId: number; outcome: string }> }
      return doc.nodes.some((n) => n.conversationId === w1.workerConversationId && n.outcome === 'failed')
    })
    await waitfoWorkerReport(env, ids.router!, `Worker #${w1.workerConversationId}`)
    await kernel.waitForIdle(ids.router!)
    await waitFor(async () => env.faux.getPendingResponseCount() === 0)

    // aborted：工具在途时中止（真实 bash sleep，确定性观察到 working 后中止）
    env.faux.setResponses([
      route({
        '中止任务': fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5 && echo done' })], { stopReason: 'toolUse' }),
        '回合被中止': fauxAssistantMessage('汇报知悉'),
      }),
    ])
    const w2 = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: '中止任务' })) as {
      workerConversationId: number
    }
    await waitFor(() => kernel.getConversation(w2.workerConversationId).status === 'working')
    await kernel.abortConversation(w2.workerConversationId)
    await kernel.waitForIdle(w2.workerConversationId).catch(() => {})
    await waitFor(async () => {
      const doc = (await readDocRaw(env, 'recall-graph')) as { nodes: Array<{ conversationId: number; outcome: string }> }
      return doc.nodes.some((n) => n.conversationId === w2.workerConversationId && n.outcome === 'aborted')
    })
    await waitfoWorkerReport(env, ids.router!, `Worker #${w2.workerConversationId}`)
    await kernel.waitForIdle(ids.router!)
    await waitFor(async () => env.faux.getPendingResponseCount() === 0)
    // 两个 worker 的汇报都入了中枢（renderer 卡片；握手已确保先后落库）
    const routerDetail = await kernel.getConversationDetail(ids.router!, { limit: 50 })
    const reports = routerDetail.entries.filter((e) => e.kind === 'helm.input' && JSON.stringify(e.data).includes('superagent:worker-report'))
    assert.equal(
      reports.filter((e) => JSON.stringify(e.data).includes(`"workerId":${w1.workerConversationId}`) && JSON.stringify(e.data).includes('"outcome":"failed"')).length,
      1,
      'failed 汇报卡恰好一张',
    )
    assert.equal(
      reports.filter((e) => JSON.stringify(e.data).includes(`"workerId":${w2.workerConversationId}`) && JSON.stringify(e.data).includes('"outcome":"aborted"')).length,
      1,
      'aborted 汇报卡恰好一张',
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 6. archive_worker / liveTasks / 停用释放 / 关停不再唤醒
// ---------------------------------------------------------------------------

test('superagent13: archive_worker——现读校验、busy 拒绝、标签替换、订阅解绑、伪 worker 拒绝', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await enableSuperAgent(env)
    const kernel = env.app.kernel

    // 初始提交即进入长工具（真实 bash sleep）：dispatch 返回时 Worker 仍在途 → busy 拒绝
    env.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 5 && echo done' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('不该需要第二答'),
    ])
    const dispatched = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
      prompt: '归档验证',
      threadKey: 'tk-13',
    })) as { workerConversationId: number }
    const workerId = dispatched.workerConversationId
    await waitFor(() => kernel.getConversation(workerId).status === 'working')
    await assert.rejects(
      () => kernel.plugins.invokeAction('builtin:superagent', 'archive_worker', { workerConversationId: workerId }),
      (err: unknown) => err instanceof HelmError && err.code === 'superagent_worker_busy',
    )
    await kernel.abortConversation(workerId)
    await kernel.waitForIdle(workerId).catch(() => {})
    // aborted 回合也会结算汇报；给中枢一条响应消化汇报回合
    env.faux.setResponses([fauxAssistantMessage('中枢收到中止汇报')])
    await kernel.waitForIdle(await residentRouter(env))

    // 空闲后归档：worker → worker-archived，index 移除，订阅解绑
    const archived = (await kernel.plugins.invokeAction('builtin:superagent', 'archive_worker', { workerConversationId: workerId })) as {
      archived: boolean
    }
    assert.equal(archived.archived, true)
    assert.deepEqual(kernel.getConversation(workerId).tags, ['worker-archived'])
    assert.equal(((await readDocRaw(env, 'index')) as { workers: unknown[] }).workers.length, 0)
    assert.equal(((await readDocRaw(env, 'subscriptions')) as { subscriptions: unknown[] }).subscriptions.length, 0)
    // 已归档会话不在活跃 index：再次归档显式 404（不静默成功）
    await assert.rejects(
      () => kernel.plugins.invokeAction('builtin:superagent', 'archive_worker', { workerConversationId: workerId }),
      (err: unknown) => err instanceof HelmError && err.code === 'not_found',
    )

    // 伪 worker：人类自建 worker 标签会话不得被归档（未登记 index）
    const fake = await kernel.createConversation({ title: '伪 worker', profileId: 'assistant', tags: ['worker'] })
    await assert.rejects(
      () => kernel.plugins.invokeAction('builtin:superagent', 'archive_worker', { workerConversationId: fake.id }),
      (err: unknown) => err instanceof HelmError && err.code === 'not_found',
    )
    // 归档后的会话再派工同名 threadKey 可复用（订阅已解绑）
    env.faux.setResponses([fauxAssistantMessage('再来一次启动')])
    const redispatch = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
      prompt: '再来一次',
      threadKey: 'tk-13',
    })) as { workerConversationId: number }
    assert.notEqual(redispatch.workerConversationId, workerId)
  } finally {
    await env.close()
  }
})

test('superagent14: liveTasks 阻止停用；空闲 Worker 不算在途；停用释放管理保护', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await enableSuperAgent(env)
    const kernel = env.app.kernel
    const ids = await residentIds(env)

    // 空闲 Worker（值守会话）不算在途：可正常停用（队列两条：初始提交 + 汇报回合）
    const dispatched = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: '值守' })) as {
      workerConversationId: number
    }
    await kernel.waitForIdle(dispatched.workerConversationId)

    // 初始提交消耗一条；本回合再消耗一条
    env.faux.setResponses([fauxAssistantMessage('值守启动'), fauxAssistantMessage('完成了一回合')])
    await kernel.submitInput(dispatched.workerConversationId, '汇报验证', { origin: 'agent' }).catch(() => {})
    // 等待结算完成后再停用必须成功（空闲值守不阻塞）
    await kernel.waitForIdle(dispatched.workerConversationId)
    await waitFor(async () => ((await readDocRaw(env, 'recall-graph')) as { nodes: unknown[] }).nodes.length >= 1)
    // 宿主把 hook 执行计入在途任务：等中枢汇报回合与全部 hook 在途结束再停用
    await kernel.waitForIdle(ids.router!)
    await waitFor(() => env.app.kernel.plugins.activeTaskCount('builtin:superagent') === 0)
    await kernel.plugins.disable('builtin:superagent')

    // 停用后：管理保护释放（可删除常驻会话）、UI 撤下、动作不可用
    await kernel.deleteConversation(ids.router!)
    assert.deepEqual(kernel.plugins.listUi().filter((u) => u.pluginId === 'builtin:superagent'), [])
    await assert.rejects(
      () => kernel.plugins.invokeAction('builtin:superagent', 'archive_worker', { workerConversationId: 1 }),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_disabled',
    )
  } finally {
    await env.close()
  }
})

test('superagent15: set_router_mode 持久写配置；routerMode=off 不剥离工具', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await enableSuperAgent(env)
    const kernel = env.app.kernel
    const ids = await residentIds(env)

    const result = (await kernel.plugins.invokeAction('builtin:superagent', 'set_router_mode', { enabled: false })) as {
      routerMode: boolean
    }
    assert.equal(result.routerMode, false)
    // 配置真实持久化（config.json plugins 键）
    const config = JSON.parse(readFileSync(join(env.dataDir, 'config.json'), 'utf8')) as {
      plugins?: Record<string, Record<string, unknown>>
    }
    assert.equal(config.plugins!['builtin:superagent']!.routerMode, false)

    // off 后中枢可真实执行 bash（模型发起工具调用，结果带回）
    env.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'printf router-ok' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('bash 已执行'),
    ])
    await kernel.submitInput(ids.router!, '请跑一下 shell').catch(() => {})
    await kernel.waitForIdle(ids.router!).catch(() => {})
    const offDetail = await kernel.getConversationDetail(ids.router!, { limit: 30 })
    const offJson = JSON.stringify(offDetail.entries)
    assert.match(offJson, /router-ok/, 'routerMode=off 时 bash 应真实执行')

    // 恢复 on：守卫再次生效（模型发起 bash → 回合级 block 带回显式原因）
    await kernel.plugins.invokeAction('builtin:superagent', 'set_router_mode', { enabled: true })
    env.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'printf x' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('收尾'),
    ])
    await env.submitAndWait(ids.router!, '再跑一次 shell')
    const onDetail = await kernel.getConversationDetail(ids.router!, { limit: 30 })
    assert.match(JSON.stringify(onDetail.entries), /中枢路由模式已剥离/, 'routerMode=on 时 bash 应再次被守卫拦截')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 7. UI 声明
// ---------------------------------------------------------------------------

test('superagent16: UI 贡献——侧栏/分组/胶囊挂件/工具卡/时间线渲染器/全屏视图/设置', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await enableSuperAgent(env)
    const ui = env.app.kernel.plugins.listUi().filter((u) => u.pluginId === 'builtin:superagent')
    const surfaces = ui.map((u) => u.surface)
    for (const expected of ['sidebar.item', 'sidebar.section', 'composer.widget', 'composer.pill', 'tool.view', 'timeline.renderer', 'screen', 'settings.panel']) {
      assert.ok(surfaces.includes(expected as never), `应声明 ${expected}`)
    }
    // 侧栏三项 + Worker 分组
    const items = ui.filter((u) => u.surface === 'sidebar.item').map((u) => (u.spec as { id: string }).id)
    assert.deepEqual(items.sort(), ['superagent-recall', 'superagent-router', 'superagent-watchdog'])
    const section = ui.find((u) => u.surface === 'sidebar.section')!.spec as { filterTag: string }
    assert.equal(section.filterTag, 'worker')
    // 时间线渲染器精确匹配 renderer
    const renderer = ui.find((u) => u.surface === 'timeline.renderer')!.spec as { matchMeta: { renderer: string } }
    assert.equal(renderer.matchMeta.renderer, 'superagent:worker-report')
    // 工具卡
    const toolView = ui.find((u) => u.surface === 'tool.view')!.spec as { toolNames: string[] }
    assert.deepEqual(toolView.toolNames, ['dispatch_worker'])
    // composer 贡献 scope 限定中枢
    const pill = ui.find((u) => u.surface === 'composer.pill')!.spec as { scope?: { profileIds: string[] } }
    assert.deepEqual(pill.scope!.profileIds, ['superagent'])
    // screen 目标可寻址 + docs 订阅真实公开 doc
    const screen = ui.find((u) => u.surface === 'screen')!.spec as { id: string; docs?: string[] }
    assert.equal(screen.id, 'recall-graph')
    assert.deepEqual(screen.docs!.sort(), ['recall-graph', 'subscriptions'])
    // 无 Emoji（设计规范）
    const serialized = JSON.stringify(ui)
    assert.doesNotMatch(serialized, /\p{Extended_Pictographic}/u, 'UI 文案不得包含 Emoji')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 8. doc 损坏显式拒绝
// ---------------------------------------------------------------------------

test('superagent17: 持久 doc 损坏时启用显式失败（不静默重建）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-superagent-corrupt-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const first = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models, watchdogIntervalMs: 0 })
  try {
    await first.kernel.plugins.enable('builtin:superagent')
    // 经真实写路径写入坏值（模拟持久损坏）并落盘
    first.kernel.documentStore.set('builtin:superagent:index', { version: 9 })
    await first.kernel.documentStore.flush()
  } finally {
    await first.close()
  }
  // 重启：持久启停为 true → 注册期 service.start 读入坏 doc，启动显式失败
  // （createHelm 如实 reject，不静默重建、不吞错）。
  try {
    await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models, watchdogIntervalMs: 0 }).then(
      () => assert.fail('损坏 doc 下启动应显式失败'),
      (err: unknown) => {
        assert.ok(err instanceof HelmError, `应为 HelmError，实际 ${String(err)}`)
        assert.equal(err.code, 'superagent_doc_corrupt')
      },
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
