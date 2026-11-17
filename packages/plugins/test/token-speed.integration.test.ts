/**
 * builtin:token-speed 真实组合层集成测试（真 createHelm + 真 PluginHost /
 * Kernel / 瞬态内存 sessionDoc + faux provider 按真实时间节流流式，~500ms 生成）。
 *
 * 覆盖生命周期全景：
 * 1. 默认停用：无 UI 贡献（COMPOSER_STATUS_SLOT 无注册）；
 * 2. 启用：UI 插槽注册 + client 模块（index.tsx）真实编译产物；
 * 3. 生成结束前：speed sessionDoc 已有非零实时 TPS（decoding 流式观测），且 HTTP / SSE 实时可达；
 * 4. 终态：provider usage 对账（outputTokens = 最终 usage.output，source 翻转），且零 SQLite 落盘；
 * 5. reset（pi.reset marker）与 conversation.deleted：上一回合 settled 文档彻底清空；
 * 6. 停用：文档读取 404、UI 贡献消失；重启用：瞬态内存已清空，绝不把旧实时态冒充当前；
 * 7. PluginSummary.publicConfig 实时投影与 secret 脱敏过滤 + external client.tsx 编译使用 usePluginConfig。
 *
 * 纪律：仅测试数据目录（tmpdir），不访问用户 ~/.helm；不起固定端口（纯
 * kernel API / Web Standard handler）；不 kill 任何非本测试拥有的进程。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { createHubHandler } from '@helm/kernel'
import { COMPOSER_STATUS_SLOT, HelmError, type PluginSummary } from '@helm/protocol'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { createHelm } from '../../hub/src/app.js'
import { openHelmDatabase } from '../../kernel/src/runtime/sqlite.js'
import { TOKEN_SPEED_DOC, TOKEN_SPEED_PLUGIN_ID, type TokenSpeedStatus } from '../src/token-speed/contracts.js'
import { cleanupDir, makeFauxModels, makeTempDir, type FauxProviderHandle } from './helpers/plugin-test-env.js'

/** 480 字符 ≈ 120 tokens，tokensPerSecond=240 → 约 500ms 真实流式生成（跨越采样窗口）。 */
const STREAM_TEXT = 'x'.repeat(480)
const STREAM_TOKENS = 120

interface Env {
  dataDir: string
  faux: FauxProviderHandle
  app: Awaited<ReturnType<typeof createHelm>>
  close(): Promise<void>
}

async function makeEnv(): Promise<Env> {
  const dataDir = await makeTempDir('helm-token-speed-it-')
  const { models, faux } = makeFauxModels({ tokensPerSecond: 240 })
  const app = await createHelm({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    cwd: dataDir,
    model: 'faux/faux-1',
    models,
  })
  return {
    dataDir,
    faux,
    app,
    async close() {
      await app.close().catch(() => {})
      await cleanupDir(dataDir)
    },
  }
}

function speedDocOf(env: Env, conversationId: number): TokenSpeedStatus | null {
  const doc = env.app.kernel.plugins.getPublicSessionDoc(TOKEN_SPEED_PLUGIN_ID, TOKEN_SPEED_DOC, conversationId)
  return (doc.value as TokenSpeedStatus | null) ?? null
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** 轮询会话文档直到谓词命中（deadline 毫秒后显式失败，绝不静默跳过断言）。 */
async function pollSpeedDoc(
  env: Env,
  conversationId: number,
  predicate: (status: TokenSpeedStatus | null) => boolean,
  what: string,
  deadlineMs = 10_000,
): Promise<TokenSpeedStatus | null> {
  const start = Date.now()
  for (;;) {
    const status = speedDocOf(env, conversationId)
    if (predicate(status)) return status
    if (Date.now() - start > deadlineMs) {
      throw new Error(`等待 speed sessionDoc ${what} 超时（最后值：${JSON.stringify(status)}）`)
    }
    await sleep(15)
  }
}

test('token-speed 集成：默认停用无 UI → 启用全链路流式测量与零 SQLite 写入 → SSE/publicConfig → reset → 停用/重启用', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  let closedByTest = false
  try {
    // ---- 1. 默认停用：无 UI 贡献，且 publicConfig 已按 configSchema 投影默认值 ----
    const summary = env.app.kernel.plugins.list().find((item) => item.id === TOKEN_SPEED_PLUGIN_ID)
    assert.ok(summary, '组合根必须注册 builtin:token-speed')
    assert.equal(summary.enabled, false, '默认停用')
    assert.deepEqual(summary.publicConfig, { slidingWindowMs: 1_000 }, 'PluginSummary.publicConfig 必须投影非机密默认配置')
    assert.ok(
      !env.app.kernel.plugins.listUi().some((item) => item.pluginId === TOKEN_SPEED_PLUGIN_ID),
      '停用时零 UI 贡献',
    )

    // ---- 2. 启用：COMPOSER_STATUS_SLOT 注册 + client 模块真实编译 ---------
    await env.app.kernel.plugins.enable(TOKEN_SPEED_PLUGIN_ID)
    const slot = env.app.kernel.plugins
      .listUi()
      .find((item) => item.pluginId === TOKEN_SPEED_PLUGIN_ID && (item.spec as { target?: string }).target === COMPOSER_STATUS_SLOT)
    assert.ok(slot, '启用后必须向 COMPOSER_STATUS_SLOT 注册徽标贡献')
    const client = await env.app.kernel.plugins.getClientModule(TOKEN_SPEED_PLUGIN_ID, 'index.tsx')
    assert.ok(client.code.length > 0, 'client 模块编译产出非空')
    assert.match(client.code, /TokenSpeedStatusBadge/, '编译产物包含徽标组件')

    // ---- 3/4. 真实流式回合：生成中非零实时 TPS，终态 provider 对账 ----------
    env.faux.setResponses([fauxAssistantMessage(STREAM_TEXT)])
    const conv = await env.app.kernel.createConversation({ title: 'token-speed 集成测速' })
    await env.app.kernel.submitInput(conv.id, '请流式生成测速文本')
    // 生成结束前必须观测到非零实时 TPS（waitForIdle 之前的 decoding 态）。
    const live = await pollSpeedDoc(
      env,
      conv.id,
      (status) => status !== null && status.phase === 'decoding' && typeof status.tps === 'number' && status.tps > 0,
      '生成中非零实时 TPS',
    )
    assert.ok(live!.outputTokens > 0, '实时累计输出 tokens > 0')
    assert.ok(live!.decodeMs >= 0)
    await env.app.kernel.waitForIdle(conv.id)
    // 终态：最终 usage.output 对账覆盖流式估算，source 翻转为 provider。
    const settled = await pollSpeedDoc(
      env,
      conv.id,
      (status) => status !== null && status.phase === 'settled',
      '终态 settled',
      5_000,
    )
    assert.equal(settled!.outputTokens, STREAM_TOKENS, '终态 tokens = 最终 usage.output（faux 按内容计 token）')
    assert.equal(settled!.source, 'provider', '终态对账后口径为 provider')
    assert.ok(settled!.tps! > 0, '终态对账速率 > 0')
    assert.ok(settled!.decodeMs > 0, '真实流式时长在观测粒度内可测')

    // ---- 4b. HTTP GET + 专用 SSE 通道可正常读取/订阅瞬态会话文档 ----------------
    const handler = createHubHandler(env.app.kernel)
    const { token } = await env.app.kernel.auth.setup('token-speed-integration-pass')
    const docGet = await handler(
      new Request(`http://127.0.0.1:3202/api/plugins/${encodeURIComponent(TOKEN_SPEED_PLUGIN_ID)}/docs/${TOKEN_SPEED_DOC}?conversationId=${conv.id}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    )
    assert.equal(docGet.status, 200)
    const docPayload = (await docGet.json()) as { value: TokenSpeedStatus | null }
    assert.equal(docPayload.value?.phase, 'settled')
    assert.equal(docPayload.value?.outputTokens, STREAM_TOKENS)

    const sseRes = await handler(
      new Request(`http://127.0.0.1:3202/api/plugins/${encodeURIComponent(TOKEN_SPEED_PLUGIN_ID)}/docs/${TOKEN_SPEED_DOC}/events?conversationId=${conv.id}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    )
    assert.equal(sseRes.status, 200)
    const reader = sseRes.body!.getReader()
    try {
      const firstChunk = await reader.read()
      const sseText = new TextDecoder().decode(firstChunk.value)
      assert.match(sseText, /event: snapshot/)
      assert.match(sseText, /"phase":"settled"/)
    } finally {
      await reader.cancel()
    }

    // ---- 4c. setConfig 实时驱动 plugin.changed 的 publicConfig 更新 -------------
    const changedEvents: PluginSummary[] = []
    const unsubscribe = env.app.kernel.onEvent('plugin.changed', (payload) => {
      const event = payload as { plugin?: PluginSummary }
      if (event.plugin?.id === TOKEN_SPEED_PLUGIN_ID) {
        changedEvents.push(event.plugin)
      }
    })
    try {
      await env.app.kernel.plugins.setConfig(TOKEN_SPEED_PLUGIN_ID, { slidingWindowMs: 2_500 })
      assert.deepEqual(env.app.kernel.plugins.get(TOKEN_SPEED_PLUGIN_ID)?.publicConfig, { slidingWindowMs: 2_500 })
      assert.deepEqual(changedEvents.at(-1)?.publicConfig, { slidingWindowMs: 2_500 })
    } finally {
      unsubscribe()
    }

    // ---- 5. reset：pi.reset marker 清空上一回合 settled 文档 ----------------
    await env.app.kernel.resetConversation(conv.id, { handoff: 'token-speed 集成交接' })
    assert.equal(speedDocOf(env, conv.id), null, 'reset 后不回退显示旧 TPS')
    // reset 后新回合从零重建（证明清空是「宁空不假」而非永久损坏）。
    env.faux.setResponses([fauxAssistantMessage('y'.repeat(160))])
    await env.app.kernel.submitInput(conv.id, 'reset 后再测一轮')
    await env.app.kernel.waitForIdle(conv.id)
    const rebuilt = await pollSpeedDoc(
      env,
      conv.id,
      (status) => status !== null && status.phase === 'settled',
      'reset 后重建终态',
      5_000,
    )
    assert.equal(rebuilt!.outputTokens, 40, '新回合测量从零累计')

    // ---- 6. 停用：文档 404、UI 消失；重启用：瞬态内存已清空，无残留 ----------
    await env.app.kernel.plugins.disable(TOKEN_SPEED_PLUGIN_ID)
    assert.ok(
      !env.app.kernel.plugins.listUi().some((item) => item.pluginId === TOKEN_SPEED_PLUGIN_ID),
      '停用后 UI 贡献即时消失',
    )
    assert.throws(
      () => env.app.kernel.plugins.getPublicSessionDoc(TOKEN_SPEED_PLUGIN_ID, TOKEN_SPEED_DOC, conv.id),
      (error: unknown) => error instanceof HelmError && error.status === 404,
      '停用后公共会话文档读取 404',
    )
    await env.app.kernel.plugins.enable(TOKEN_SPEED_PLUGIN_ID)
    assert.equal(
      speedDocOf(env, conv.id),
      null,
      '重启用立即读不到上周期 settled 状态（瞬态内存已清空，绝不冒充当前实时）',
    )
    assert.ok(
      env.app.kernel.plugins
        .listUi()
        .some((item) => item.pluginId === TOKEN_SPEED_PLUGIN_ID && (item.spec as { target?: string }).target === COMPOSER_STATUS_SLOT),
      '重启用后 UI 插槽恢复',
    )

    // 关闭前刷新插件存储并检查 SQLite helm_plugin_session_docs：必须严格零写入！
    await env.app.close()
    closedByTest = true
    const db = await openHelmDatabase(env.dataDir)
    try {
      const rows = await db.db.all<{ conversation_id: number }>(
        'SELECT conversation_id FROM helm_plugin_session_docs WHERE plugin_id = ? AND name = ?',
        TOKEN_SPEED_PLUGIN_ID,
        TOKEN_SPEED_DOC,
      )
      assert.equal(rows.length, 0, 'durable: false 全程零 SQLite helm_plugin_session_docs 写入')
    } finally {
      await db.close()
    }
  } finally {
    if (!closedByTest) await env.close()
    else await cleanupDir(env.dataDir)
  }
})

test('token-speed 集成：多工具轮——工具执行期保持有效 TPS 且不计入解码净耗时，终态正确对账', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  let toolEnteredResolve!: () => void
  const toolEntered = new Promise<void>((resolve) => {
    toolEnteredResolve = resolve
  })
  let releaseTool!: () => void
  const toolGate = new Promise<void>((resolve) => {
    releaseTool = resolve
  })
  try {
    await env.app.kernel.plugins.register({
      id: 'test:speed-tool-probe',
      name: 'speed tool probe',
      definePlugin(ctx) {
        ctx.tool({
          name: 'slow_speed_probe',
          description: '阻塞等待以观测工具执行期 TPS 显示',
          inputSchema: {
            type: 'object',
            properties: { payload: { type: 'string' } },
            additionalProperties: false,
          },
          async execute() {
            toolEnteredResolve()
            await toolGate
            return { output: [{ type: 'text', text: 'probe ok' }] }
          },
        })
      },
    })
    await env.app.kernel.plugins.enable(TOKEN_SPEED_PLUGIN_ID)

    env.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('slow_speed_probe', { payload: 'p'.repeat(240) })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('z'.repeat(320)),
    ])

    const conv = await env.app.kernel.createConversation({ title: 'token-speed 多工具轮集成测速' })
    await env.app.kernel.submitInput(conv.id, '请执行工具后再回答')

    await toolEntered
    // 真实阻塞约 150ms，并在 tools 阶段轮询 speed sessionDoc：必须始终保有非零 TPS
    await sleep(150)
    const duringTools = await pollSpeedDoc(
      env,
      conv.id,
      (status) => status !== null && status.phase === 'tools' && typeof status.tps === 'number' && status.tps > 0,
      '工具执行期保持有效 TPS',
    )
    assert.ok(duringTools!.tps! > 0, '工具执行期绝不清空 TPS')
    assert.ok(duringTools!.outputTokens > 0, '工具调用参数计数保留')

    releaseTool()
    await env.app.kernel.waitForIdle(conv.id)

    const settled = await pollSpeedDoc(
      env,
      conv.id,
      (status) => status !== null && status.phase === 'settled',
      '多工具轮终态 settled',
      5_000,
    )
    assert.ok(settled!.outputTokens >= 100, '汇总多轮输出 tokens')
    assert.equal(settled!.source, 'provider', '终态经 provider usage 对账')
    assert.ok(settled!.tps! > 0, '多工具轮终态对账速率 > 0')
    assert.ok(settled!.decodeMs > 0, '多工具轮净解码时长可测')
  } finally {
    releaseTool()
    await env.close()
  }
})

test('token-speed 集成：PluginSummary.publicConfig 剥离 secret 字段且 external client.tsx 可编译消费 usePluginConfig', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const clientRoot = join(env.dataDir, 'external-config-client')
    await mkdir(clientRoot, { recursive: true })
    await writeFile(
      join(clientRoot, 'client.tsx'),
      `import { usePluginConfig } from '@helm/plugin-client'

export function ConfigPanel() {
  const config = usePluginConfig<{ slidingWindowMs?: number; apiKey?: string; label?: string }>()
  return \`\${String(config.label ?? 'default')}:\${String(config.slidingWindowMs ?? 0)}:\${String(config.apiKey ?? 'none')}\`
}
`,
    )
    await env.app.kernel.plugins.register(
      {
        id: 'test:public-config-client',
        name: 'Public Config Client',
        clientRoot,
        definePlugin(ctx) {
          ctx.configSchema({
            slidingWindowMs: { type: 'number', default: 1_500 },
            label: { type: 'string', default: 'alpha' },
            apiKey: { type: 'string', secret: true, default: 'default-secret' },
          })
          ctx.ui.screen({
            id: 'panel',
            label: '配置面板',
            client: { module: 'client.tsx', export: 'ConfigPanel' },
          })
        },
      },
      { enabled: true },
    )
    await env.app.kernel.plugins.setConfig('test:public-config-client', {
      apiKey: 'sk-live-secret-token',
      slidingWindowMs: 2_200,
    })
    const registered = env.app.kernel.plugins.get('test:public-config-client')!
    assert.deepEqual(registered.publicConfig, { slidingWindowMs: 2_200, label: 'alpha' })
    assert.equal('apiKey' in (registered.publicConfig ?? {}), false, 'publicConfig 严禁包含 secret 字段')

    const compiled = await env.app.kernel.plugins.getClientModule('test:public-config-client', 'client.tsx')
    assert.ok(compiled.code.length > 0, '使用 usePluginConfig 的外部 client.tsx 编译成功')
    assert.match(compiled.code, /usePluginConfig/)

    // 验证 setConfig 经 HTTP API 变更配置后，publicConfig 更新且 secret 依旧不可见
    const handler = createHubHandler(env.app.kernel)
    const { token } = await env.app.kernel.auth.setup('public-config-pass-123')
    const changedEvents: PluginSummary[] = []
    const off = env.app.kernel.onEvent('plugin.changed', (payload) => {
      const event = payload as { plugin?: PluginSummary }
      if (event.plugin?.id === 'test:public-config-client') {
        changedEvents.push(event.plugin)
      }
    })
    try {
      const res = await handler(
        new Request('http://127.0.0.1:3202/api/plugins/test%3Apublic-config-client/config', {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            values: { slidingWindowMs: 3_000, label: 'beta', apiKey: 'sk-updated-secret' },
          }),
        }),
      )
      assert.equal(res.status, 200)
      const listRes = await handler(
        new Request('http://127.0.0.1:3202/api/plugins', {
          headers: { authorization: `Bearer ${token}` },
        }),
      )
      assert.equal(listRes.status, 200)
      const listBody = (await listRes.json()) as PluginSummary[]
      const listed = listBody.find((p) => p.id === 'test:public-config-client')
      assert.deepEqual(listed?.publicConfig, { slidingWindowMs: 3_000, label: 'beta' })
      assert.equal('apiKey' in (listed?.publicConfig ?? {}), false)
      assert.deepEqual(changedEvents.at(-1)?.publicConfig, { slidingWindowMs: 3_000, label: 'beta' })
      assert.equal('apiKey' in (changedEvents.at(-1)?.publicConfig ?? {}), false)
    } finally {
      off()
    }
  } finally {
    await env.close()
  }
})
