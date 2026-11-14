/**
 * 模型目录 contextWindow 序列化与 models.changed 迫齐链路（真实 KernelRuntime + HTTP）：
 *
 * 1. GET /api/models（与 kernel.listModels 同源）：真实已知窗口携带 contextWindow，
 *    静态缺省（helmContextWindowKnown:false）与非法窗口（Infinity）必须省略；
 * 2. 动态供应商目录变化（reloadModels -> rebuild -> models.changed）：idle 会话
 *    不发任何新输入，用量缓存经事件定向迫齐 unknown->known / known->移除，
 *    summary 经 conversation.upsert 可达 SSE 且 stateChangeSeq 不变；
 * 3. Magpie 字段解析本身不在此测（magpie-plugin.test 锁定官方字段）；此处模型
 *    形态对齐 builtin:magpie toPiModel 产物：已知窗口无标记、未知携带
 *    helmContextWindowKnown:false + 保守缺省 128k。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Model, Provider } from '@earendil-works/pi-ai'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationSummary } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/index.js'
import { startHub } from '../src/http/index.js'

/** 与 HelmModelSourceMeta / PiMagpieModel 同形态：未知窗口标记随模型对象透传。 */
type WindowedModel = Model<string> & { helmContextWindowKnown?: boolean }

/** 等待指定序号之后出现携带目标窗口的 conversation.upsert（有界轮询，绝不无限等）。 */
async function waitForUpsertWindow(
  upserts: ConversationSummary[],
  conversationId: number,
  afterIndex: number,
  expected: number | undefined,
): Promise<ConversationSummary> {
  const deadline = Date.now() + 8_000
  for (;;) {
    for (let i = afterIndex; i < upserts.length; i += 1) {
      const summary = upserts[i]!
      if (
        summary.id === conversationId &&
        summary.contextUsage !== undefined &&
        summary.contextUsage.contextWindow === expected
      ) {
        return summary
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `8s 内未观察到会话 ${conversationId} 窗口为 ${String(expected)} 的 conversation.upsert` +
          `（upserts=${JSON.stringify(upserts.map((s) => s.contextUsage))}）`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('目录 contextWindow 投影与 models.changed 迫齐：unknown→known→移除，stateChangeSeq 不变', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-models-window-'))
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  let kernel: KernelRuntime | undefined
  try {
    kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
    const upserts: ConversationSummary[] = []
    kernel.events.subscribe((frame) => {
      const event = frame.event as { type?: string; conversation?: ConversationSummary }
      if (event.type === 'conversation.upsert' && event.conversation) upserts.push(event.conversation)
    })

    // 动态供应商（形态对齐 Magpie toPiModel 产物）：目录数组可换 = 模拟目录刷新。
    const faux = fauxProvider({ provider: 'win', models: [{ id: 'm-ctx' }, { id: 'm-bad' }] })
    const unknownModel: WindowedModel = { ...faux.getModel('m-ctx')!, contextWindow: 128_000, helmContextWindowKnown: false }
    const badModel: WindowedModel = { ...faux.getModel('m-bad')!, contextWindow: Number.POSITIVE_INFINITY }
    const knownModel: WindowedModel = { ...faux.getModel('m-ctx')!, contextWindow: 400_000 }
    let current: WindowedModel[] = [unknownModel, badModel]
    const provider = {
      ...faux.provider,
      getModels: () => current,
      getAllModels: () => current,
    } as unknown as Provider
    const unregister = await kernel.registerRuntimeProvider(provider, 'builtin:demo')

    // HTTP 目录回归：与 kernel.listModels 同源。先建鉴权（首次启动建立令牌）。
    hub = await startHub({ kernel, port: 0 })
    const setup = await fetch(`${hub.url}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'fixture-window-pass' }),
    })
    assert.ok(setup.status === 200 || setup.status === 409, `auth setup 意外状态 ${setup.status}`)
    let token = setup.status === 200 ? ((await setup.json()) as { token: string }).token : undefined
    if (token === undefined) {
      const login = await fetch(`${hub.url}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'fixture-window-pass' }),
      })
      assert.equal(login.status, 200, 'setup 已配置时 login 必须成功')
      token = ((await login.json()) as { token: string }).token
    }
    const httpModels = async (): Promise<Array<Record<string, unknown>>> => {
      const response = await fetch(`${hub!.url}/api/models`, { headers: { authorization: `Bearer ${token}` } })
      assert.equal(response.status, 200)
      return ((await response.json()) as { models: Array<Record<string, unknown>> }).models
    }
    const httpEntry = async (modelId: string): Promise<Record<string, unknown> | undefined> =>
      (await httpModels()).find((entry) => entry['provider'] === 'win' && entry['modelId'] === modelId)

    // 初始目录：未知窗口与非法窗口都必须省略 contextWindow。
    assert.equal('contextWindow' in ((await httpEntry('m-ctx')) ?? {}), false, '静态缺省窗口不得出现在 HTTP 目录')
    assert.equal('contextWindow' in ((await httpEntry('m-bad')) ?? {}), false, '非有限窗口不得出现在 HTTP 目录')

    // 会话绑定 m-ctx；详情读填充用量缓存：窗口未知（tokens 估算仍在）。
    const created = await kernel.createConversation({ model: 'win/m-ctx' })
    const id = created.id
    const initialDetail = await kernel.getConversationDetail(id)
    assert.ok(initialDetail.contextUsage, '详情读必须携带用量估算')
    assert.equal(initialDetail.contextUsage?.contextWindow, undefined, '初始目录窗口未知')
    const seqBefore = initialDetail.stateChangeSeq

    // 目录刷新：同模型未知→已知。idle 会话不发新输入，用量经 models.changed 迫齐。
    current = [knownModel, badModel]
    await kernel.reloadModels()
    await waitForUpsertWindow(upserts, id, 0, 400_000)
    const knownDetail = await kernel.getConversationDetail(id)
    assert.equal(knownDetail.contextUsage?.contextWindow, 400_000, '刷新后窗口追齐')
    assert.equal(knownDetail.stateChangeSeq, seqBefore, 'usage-only 不得推进 stateChangeSeq')
    assert.equal((await httpEntry('m-ctx'))!['contextWindow'], 400_000, 'HTTP 目录携带真实已知窗口')

    // 供应商不再供应该模型：窗口恢复未知并可达 SSE。
    const afterKnown = upserts.length
    current = [badModel]
    await kernel.reloadModels()
    await waitForUpsertWindow(upserts, id, afterKnown, undefined)
    assert.equal((await kernel.getConversationDetail(id)).contextUsage?.contextWindow, undefined, '模型移除后窗口恢复未知')

    await unregister()
  } finally {
    await hub?.close().catch(() => {})
    await kernel?.close().catch(() => {})
    await rm(dataDir, { recursive: true, force: true })
  }
})
