/**
 * 模型目录禁用过滤端到端与持久化回归测试（共享主 Hub 实例减少重复冷启动，保留多 provider / 重启 / 损坏配置独立验证）。
 */
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, afterEach, before, test } from 'node:test'
import {
  createHubTestApp,
  makeFauxModels,
  openHubHttpEnv,
  useTempDir,
  type HubHttpTestEnv,
} from './helpers/hub-test-env.js'

let env: HubHttpTestEnv

before(async () => {
  env = await openHubHttpEnv({
    prefix: 'helm-models-filter-',
    fauxOptions: { models: [{ id: 'faux-1' }, { id: 'faux-2' }, { id: 'nested/model' }] },
  })
})

afterEach(async () => {
  if (env !== undefined) {
    await env.call('PUT', '/api/models/filter', { disabledModels: [] })
  }
})

after(async () => {
  await env?.close()
})

test('PUT /api/models/filter 设置与清空、GET /api/models 标注、config.json 持久化、参数校验与 models.changed 事件广播', { timeout: 60_000 }, async () => {
  const seenEvents: Array<{ providers: unknown }> = []
  const unsub = env.kernel.events.subscribe((frame) => {
    const event = frame.event as { type: string; payload?: unknown }
    if (event.type === 'models.changed') {
      const payload = event.payload as { providers?: unknown }
      if (Array.isArray(payload?.providers) && payload.providers.length === 1 && payload.providers[0] === 'magpie') {
        return
      }
      seenEvents.push(event.payload as { providers: unknown })
    }
  })

  try {
    const beforeCatalog = await env.call('GET', '/api/models')
    assert.equal(beforeCatalog.status, 200)
    const fauxEntries = beforeCatalog.body.models.filter((m: { provider: string }) => m.provider === 'faux')
    assert.equal(fauxEntries.length, 3)
    assert.ok(fauxEntries.every((m: { disabled?: boolean }) => m.disabled === undefined))

    const put = await env.call('PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-2'] })
    assert.equal(put.status, 200)
    const disabledEntry = put.body.catalog.models.find((m: { provider: string; modelId: string }) => m.provider === 'faux' && m.modelId === 'faux-2')
    assert.equal(disabledEntry.disabled, true)
    assert.equal(disabledEntry.available, true)
    assert.equal(
      put.body.catalog.models.find((m: { provider: string; modelId: string }) => m.provider === 'faux' && m.modelId === 'faux-1').disabled,
      undefined,
    )
    assert.equal(
      (await env.call('GET', '/api/models')).body.models.find((m: { provider: string; modelId: string }) => m.provider === 'faux' && m.modelId === 'faux-2').disabled,
      true,
    )
    assert.deepEqual(
      (JSON.parse(readFileSync(join(env.dataDir, 'config.json'), 'utf8')) as Record<string, unknown>)['disabledModels'],
      { faux: ['faux-2'] },
    )

    const clear = await env.call('PUT', '/api/models/filter', { provider: 'faux', disabledModels: [] })
    assert.equal(clear.status, 200)
    assert.equal('disabledModels' in (JSON.parse(readFileSync(join(env.dataDir, 'config.json'), 'utf8')) as Record<string, unknown>), false)

    const clearAll = await env.call('PUT', '/api/models/filter', { disabledModels: [] })
    assert.equal(clearAll.status, 200)
    assert.deepEqual(seenEvents, [{ providers: ['faux'] }, { providers: ['faux'] }, { providers: [] }])

    // 校验边界（含带 '/' 的模型 ID 与自由字符串）
    for (const bad of [
      {},
      { disabledModels: ['x'] },
      { provider: 'faux', disabledModels: [''] },
      { provider: 'faux', disabledModels: [1] },
      { provider: 'faux', disabledModels: [], extra: 1 },
    ]) {
      assert.equal((await env.call('PUT', '/api/models/filter', bad)).status, 400)
    }
    const slashed = await env.call('PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['nested/model'] })
    assert.equal(slashed.status, 200)
    assert.equal(slashed.body.catalog.models.find((m: { modelId: string }) => m.modelId === 'nested/model')?.disabled, true)

    const free = await env.call('PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['not-in-catalog'] })
    assert.equal(free.status, 200)
    assert.deepEqual(
      (JSON.parse(readFileSync(join(env.dataDir, 'config.json'), 'utf8')) as Record<string, unknown>)['disabledModels'],
      { faux: ['not-in-catalog'] },
    )
  } finally {
    unsub()
  }
})

test('禁用模型执行门禁：会话创建/更新/提交、默认模型、Profile 创建/更新、原生 spawn 三路径与 resume 均 409 model_disabled，重启用后恢复', { timeout: 60_000 }, async () => {
  await env.call('PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-2'] })

  // 1. 会话与默认模型 HTTP 门禁
  const created = await env.call('POST', '/api/conversations', { model: 'faux/faux-2' })
  assert.equal(created.status, 409)
  assert.equal(created.body.error.code, 'model_disabled')

  const conv = await env.kernel.createConversation({ title: 'filter-guard' })
  assert.equal((await env.call('PATCH', `/api/conversations/${conv.id}`, { model: 'faux/faux-2' })).status, 409)

  await env.call('PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-1'] })
  assert.equal((await env.call('POST', `/api/conversations/${conv.id}/input`, { text: 'hello' })).status, 409)
  assert.equal((await env.call('PUT', '/api/models/default', { model: 'faux/faux-1' })).status, 409)

  await env.call('PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-2'] })
  env.faux.setResponses([fauxAssistantMessage('ok')])
  assert.equal((await env.call('POST', `/api/conversations/${conv.id}/input`, { text: 'hello again' })).status, 202)
  await env.kernel.waitForIdle(conv.id)

  // 2. Profile POST / PUT 门禁
  const profCreated = await env.call('POST', '/api/profiles', { id: 'disabled-bind', name: 'disabled', model: 'faux/faux-2' })
  assert.equal(profCreated.status, 409)
  assert.equal(await env.kernel.profiles.get('disabled-bind'), undefined)

  await env.kernel.profiles.save({ id: 'put-target', name: 'existing', model: 'faux/faux-1' })
  assert.equal((await env.call('PUT', '/api/profiles/put-target', { name: 'rebind', model: 'faux/faux-2' })).status, 409)
  assert.equal((await env.kernel.profiles.get('put-target'))?.model, 'faux/faux-1')
  assert.equal((await env.call('PUT', '/api/profiles/put-target', { name: 'ok', model: 'faux/faux-1' })).status, 200)

  // 3. 原生 spawn 三条模型解析路径（显式 / profile / 全局默认）创建前拒绝且零孤儿子会话
  const spawnParent = await env.kernel.createConversation({ title: 'spawn-parent' })
  await assert.rejects(
    () => env.kernel.spawnAgent({ parentConversationId: spawnParent.id, prompt: 'x', model: 'faux/faux-2' }),
    { code: 'model_disabled' },
  )
  await env.kernel.profiles.save({ id: 'spawnable', name: 'S', model: 'faux/faux-2' })
  await assert.rejects(
    () => env.kernel.spawnAgent({ parentConversationId: spawnParent.id, prompt: 'x', agentType: 'spawnable' }),
    { code: 'model_disabled' },
  )
  await env.kernel.setDisabledModels('faux', ['faux-1', 'faux-2'])
  await assert.rejects(
    () => env.kernel.spawnAgent({ parentConversationId: spawnParent.id, prompt: 'x' }),
    { code: 'model_disabled' },
  )
  assert.equal(env.kernel.listConversations().filter((c) => c.parentConversationId === spawnParent.id).length, 0)

  // 4. 重启用后 spawn 与子会话 resume 事后禁用/恢复契约
  await env.kernel.setDisabledModels('faux', [])
  env.faux.setResponses([fauxAssistantMessage('child-first')])
  assert.equal(
    await env.kernel.spawnAgent({ parentConversationId: spawnParent.id, prompt: 'x', model: 'faux/faux-2' }),
    'child-first',
  )
  const child = env.kernel.listConversations().find((c) => c.parentConversationId === spawnParent.id)!
  assert.equal(child.model, 'faux/faux-2')

  await env.kernel.setDisabledModels('faux', ['faux-2'])
  const callsBefore = env.faux.state.callCount
  await assert.rejects(
    () => env.kernel.spawnAgent({ parentConversationId: spawnParent.id, resume: String(child.id), prompt: 'continue' }),
    (err: unknown) => err instanceof Error && (err as { code?: string; status?: number }).code === 'model_disabled' && (err as { status?: number }).status === 409,
  )
  assert.equal(env.faux.state.callCount, callsBefore)

  await env.kernel.setDisabledModels('faux', [])
  env.faux.setResponses([fauxAssistantMessage('resumed ok')])
  assert.equal(
    await env.kernel.spawnAgent({ parentConversationId: spawnParent.id, resume: String(child.id), prompt: 'continue' }),
    'resumed ok',
  )
  assert.equal(env.kernel.listConversations().filter((c) => c.parentConversationId === spawnParent.id).length, 1)
})

test('多 provider 隔离与清空全部、重启恢复生效及 config.json 坏形状显式 config_corrupt', { timeout: 60_000 }, async (t) => {
  // 1. 多 provider 互不干扰 + 缺省 provider 空数组清空全部
  const multiDir = join(useTempDir(t, 'helm-models-multi-'), 'hub')
  const fauxA = fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-2' }] })
  const fauxB = fauxProvider({ provider: 'faux-b', models: [{ id: 'other-1' }] })
  const multiEnv = await openHubHttpEnv({ dataDir: multiDir, cwd: multiDir, providers: [fauxA.provider, fauxB.provider] })
  try {
    await multiEnv.call('PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-2'] })
    await multiEnv.call('PUT', '/api/models/filter', { provider: 'faux-b', disabledModels: ['other-1'] })
    const cat = (await multiEnv.call('GET', '/api/models')).body
    assert.equal(cat.models.find((m: { provider: string; modelId: string }) => m.provider === 'faux' && m.modelId === 'faux-2')?.disabled, true)
    assert.equal(cat.models.find((m: { provider: string; modelId: string }) => m.provider === 'faux-b' && m.modelId === 'other-1')?.disabled, true)
    assert.equal(cat.models.find((m: { provider: string; modelId: string }) => m.provider === 'faux' && m.modelId === 'faux-1')?.disabled, undefined)

    // 保留 faux 禁用集供重启验证前，先验证清空全部再重设
    const clearAll = await multiEnv.call('PUT', '/api/models/filter', { disabledModels: [] })
    assert.ok(clearAll.body.catalog.models.every((m: { disabled?: boolean }) => m.disabled !== true))
    await multiEnv.call('PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-2'] })
  } finally {
    await multiEnv.close()
  }

  // 2. 同一 dataDir 重启后禁用集持续生效
  const restarted = await createHubTestApp({
    dataDir: multiDir,
    cwd: multiDir,
    fauxOptions: { models: [{ id: 'faux-1' }, { id: 'faux-2' }] },
  })
  try {
    const catalog = await restarted.kernel.listModels()
    assert.equal(catalog.models.find((m) => m.provider === 'faux' && m.modelId === 'faux-2')?.disabled, true)
    await assert.rejects(
      () => restarted.kernel.createConversation({ model: 'faux/faux-2' }),
      { code: 'model_disabled' },
    )
  } finally {
    await restarted.app.close().catch(() => {})
  }

  // 3. config.json.disabledModels 坏形状启动显式 config_corrupt
  const corruptDir = useTempDir(t, 'helm-models-corrupt-')
  writeFileSync(join(corruptDir, 'config.json'), JSON.stringify({ disabledModels: { faux: 'not-an-array' } }))
  await assert.rejects(
    () => createHubTestApp({ dataDir: corruptDir, cwd: corruptDir }),
    { code: 'config_corrupt' },
  )
  assert.equal(existsSync(join(corruptDir, 'config.json')), true)
})

test('KernelRuntimeOptions.providers coexists with builtin:magpie and rejects simultaneous models', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-models-providers-mutex-')
  const { models, faux } = makeFauxModels()
  await assert.rejects(
    () => createHubTestApp({ dataDir: dir, cwd: dir, models, providers: [faux.provider] }),
    (err: unknown) =>
      err instanceof Error &&
      (err as { code?: string; status?: number }).code === 'validation_error' &&
      (err as { status?: number }).status === 400,
  )

  const { app } = await createHubTestApp({ dataDir: dir, cwd: dir })
  try {
    const ids = app.kernel.listModelProviders().map((p) => p.id)
    assert.ok(ids.includes('faux'), 'providers option registers faux runtime provider')
    assert.ok(ids.includes('magpie'), 'default-enabled builtin:magpie coexists with providers option')
  } finally {
    await app.close()
  }
})
