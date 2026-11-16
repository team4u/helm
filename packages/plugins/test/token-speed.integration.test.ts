/**
 * builtin:token-speed 真实组合层集成测试（真 createHelm + 真 PluginHost /
 * Kernel / sessionDoc 持久层 + faux provider 按真实时间节流流式，~500ms 生成）。
 *
 * 覆盖生命周期全景：
 * 1. 默认停用：无 UI 贡献（COMPOSER_STATUS_SLOT 无注册）；
 * 2. 启用：UI 插槽注册 + client 模块（index.tsx）真实编译产物；
 * 3. 生成结束前：speed sessionDoc 已有非零实时 TPS（decoding 流式观测）；
 * 4. 终态：provider usage 对账（outputTokens = 最终 usage.output，source 翻转）；
 * 5. reset（pi.reset marker）：上一回合 settled 文档彻底清空；
 * 6. 停用：文档读取 404、UI 贡献消失；重启用：上周期持久行被 prepare 清空，
 *    绝不把旧实时态冒充当前（宁显示空，由新流量重建）。
 *
 * 纪律：仅测试数据目录（tmpdir），不访问用户 ~/.helm；不起固定端口（纯
 * kernel API，无 HTTP）；不 kill 任何非本测试拥有的进程。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { COMPOSER_STATUS_SLOT, HelmError } from '@helm/protocol'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { createHelm } from '../../hub/src/app.js'
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

test('token-speed 集成：默认停用无 UI → 启用全链路流式测量 → reset 清空 → 停用/重启用无过期实时态', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // ---- 1. 默认停用：无 UI 贡献 -----------------------------------------
    const summary = env.app.kernel.plugins.list().find((item) => item.id === TOKEN_SPEED_PLUGIN_ID)
    assert.ok(summary, '组合根必须注册 builtin:token-speed')
    assert.equal(summary.enabled, false, '默认停用')
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

    // ---- 6. 停用：文档 404、UI 消失；重启用：prepare 清上周期持久行 --------
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
      '重启用立即读不到上周期 settled 行（prepare 已清，绝不冒充当前实时）',
    )
    assert.ok(
      env.app.kernel.plugins
        .listUi()
        .some((item) => item.pluginId === TOKEN_SPEED_PLUGIN_ID && (item.spec as { target?: string }).target === COMPOSER_STATUS_SLOT),
      '重启用后 UI 插槽恢复',
    )
  } finally {
    await env.close()
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
