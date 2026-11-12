/**
 * 模型清单启停端到端持久化测试（真实 createHelm + startHub + faux provider）：
 * - PUT /api/models/filter 设置/清空禁用集（config.json.disabledModels 原子持久化）；
 * - GET /api/models 目录标注 disabled（available 语义不变，凭据可用性独立表达）；
 * - 禁用模型后会话显式选用与提交输入均被拒（409 model_disabled），绝不静默回退；
 * - 原生 spawn 三条模型解析路径（显式 request / profile / 全局默认）创建前拒绝禁用模型；
 * - 原生 spawn resume 既有子会话：绑定模型后来被禁用时提交输入前拒绝（409 model_disabled）；
 * - HTTP POST/PUT /api/profiles 绑定禁用模型在落盘前拒绝；
 * - setDisabledModels 更新后发布 models.changed 事件（已连接 Web 客户端刷新目录）；
 * - 重启语义：同一 dataDir 重新 createHelm 后禁用集仍生效（loadDefaultsFromConfig）；
 * - 校验边界：非法模型 id（空串/含 '/'）、无 provider 携带禁用项 400；非法 config 形状 config_corrupt。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { createHelm } from '../src/app.js'
import { startHub } from '../src/http/index.js'

interface Env {
  dataDir: string
  app: Awaited<ReturnType<typeof createHelm>>
  hubUrl: string
  hubToken?: string
  close(): Promise<void>
}

/** 双模型 faux provider：faux-1（默认启用）/ faux-2（禁用目标）。 */
async function makeEnv(): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-models-filter-'))
  const faux = fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-2' }] })
  faux.setResponses([fauxAssistantMessage('ok')])
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  const hub = await startHub({ kernel: app.kernel, port: 0 })
  const env: Env = {
    dataDir,
    app,
    hubUrl: hub.url,
    async close() {
      await hub.close().catch(() => {})
      await app.close().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
  // setup 鉴权（首次启动无密码则直接建立令牌）。
  const setup = await fetch(`${env.hubUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'fixture-filter-pass' }),
  })
  if (setup.status === 200) {
    env.hubToken = ((await setup.json()) as { token: string }).token
  } else {
    const login = await fetch(`${env.hubUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'fixture-filter-pass' }),
    })
    assert.equal(login.status, 200, 'auth setup/login 应至少一个成功')
    env.hubToken = ((await login.json()) as { token: string }).token
  }
  return env
}

async function call(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${env.hubUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(env.hubToken !== undefined ? { authorization: `Bearer ${env.hubToken}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let parsed: any = null
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: res.status, body: parsed }
}

function configPath(env: Env): string {
  return join(env.dataDir, 'config.json')
}

test('PUT /api/models/filter 设置禁用集，GET /api/models 标注 disabled 且 config.json 持久化', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // 初始目录：两个模型均可用、无 disabled 标注。
    const before = await call(env, 'GET', '/api/models')
    assert.equal(before.status, 200)
    const fauxEntries = before.body.models.filter((m: any) => m.provider === 'faux')
    assert.equal(fauxEntries.length, 2)
    assert.ok(fauxEntries.every((m: any) => m.disabled === undefined))

    // 设置禁用集：faux provider 禁用 faux-2。
    const put = await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-2'] })
    assert.equal(put.status, 200)
    assert.equal(put.body.ok, true)
    const entry = put.body.catalog.models.find((m: any) => m.provider === 'faux' && m.modelId === 'faux-2')
    assert.equal(entry.disabled, true)
    // available 语义不变（凭据可用性独立表达；faux 无凭据要求仍为可用）。
    assert.equal(entry.available, true)
    const other = put.body.catalog.models.find((m: any) => m.provider === 'faux' && m.modelId === 'faux-1')
    assert.equal(other.disabled, undefined)

    // GET 目录同样标注。
    const after = await call(env, 'GET', '/api/models')
    const afterEntry = after.body.models.find((m: any) => m.provider === 'faux' && m.modelId === 'faux-2')
    assert.equal(afterEntry.disabled, true)

    // config.json 原子持久化。
    const raw = JSON.parse(readFileSync(configPath(env), 'utf8')) as Record<string, unknown>
    assert.deepEqual(raw['disabledModels'], { faux: ['faux-2'] })

    // 清空该 provider 的禁用集：disabledModels 键整体回收。
    const clear = await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: [] })
    assert.equal(clear.status, 200)
    const cleared = clear.body.catalog.models.find((m: any) => m.provider === 'faux' && m.modelId === 'faux-2')
    assert.equal(cleared.disabled, undefined)
    const rawCleared = JSON.parse(readFileSync(configPath(env), 'utf8')) as Record<string, unknown>
    assert.equal('disabledModels' in rawCleared, false)
  } finally {
    await env.close()
  }
})

test('多 provider 禁用集互不干扰；缺省 provider PUT 清空全部', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-models-filter-multi-'))
  const fauxA = fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-2' }] })
  const fauxB = fauxProvider({ provider: 'faux-b', models: [{ id: 'other-1' }] })
  const models = createModels()
  models.setProvider(fauxA.provider)
  models.setProvider(fauxB.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, models })
  const hub = await startHub({ kernel: app.kernel, port: 0 })
  try {
    const env: Env = { dataDir, app, hubUrl: hub.url, async close() { await hub.close().catch(() => {}) } }
    const setup = await fetch(`${env.hubUrl}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'fixture-filter-pass' }),
    })
    assert.equal(setup.status, 200)
    env.hubToken = ((await setup.json()) as { token: string }).token

    await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-2'] })
    await call(env, 'PUT', '/api/models/filter', { provider: 'faux-b', disabledModels: ['other-1'] })
    let catalog = (await call(env, 'GET', '/api/models')).body
    assert.equal(catalog.models.find((m: any) => m.provider === 'faux' && m.modelId === 'faux-2')?.disabled, true)
    assert.equal(catalog.models.find((m: any) => m.provider === 'faux-b' && m.modelId === 'other-1')?.disabled, true)
    // 未涉及的模型不受干扰。
    assert.equal(catalog.models.find((m: any) => m.provider === 'faux' && m.modelId === 'faux-1')?.disabled, undefined)

    // 缺省 provider + 空数组 = 清空全部（config 键回收）。
    const clearAll = await call(env, 'PUT', '/api/models/filter', { disabledModels: [] })
    assert.equal(clearAll.status, 200)
    catalog = clearAll.body.catalog
    assert.ok(catalog.models.every((m: any) => m.disabled !== true))
    const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>
    assert.equal('disabledModels' in raw, false)
  } finally {
    await hub.close().catch(() => {})
    await app.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('校验边界：非法模型 id / 无 provider 携带禁用项 / 未知字段 / 非法 body', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // 空 body 与 {} 均为显式校验错误（缺 disabledModels）。
    const empty = await call(env, 'PUT', '/api/models/filter', {})
    assert.equal(empty.status, 400)
    assert.equal(empty.body.error.code, 'validation_error')

    // 无 provider 携带禁用项。
    const noProvider = await call(env, 'PUT', '/api/models/filter', { disabledModels: ['x'] })
    assert.equal(noProvider.status, 400)

    // 模型 id 含 '/'（不得携带 provider 前缀）。
    const withSlash = await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux/faux-2'] })
    assert.equal(withSlash.status, 400)

    // 空字符串模型 id。
    const emptyId = await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: [''] })
    assert.equal(emptyId.status, 400)

    // 非字符串数组。
    const notStrings = await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: [1] })
    assert.equal(notStrings.status, 400)

    // 未知字段拒绝。
    const unknownKey = await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: [], extra: 1 })
    assert.equal(unknownKey.status, 400)

    // 目录中不存在的模型 id 也被接受（自由字符串存储）。
    const free = await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['not-in-catalog'] })
    assert.equal(free.status, 200)
    const raw = JSON.parse(readFileSync(configPath(env), 'utf8')) as Record<string, unknown>
    assert.deepEqual(raw['disabledModels'], { faux: ['not-in-catalog'] })
  } finally {
    await env.close()
  }
})

test('禁用模型后会话显式选用与提交输入被拒（409 model_disabled），重新启用后恢复', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-2'] })

    // 创建会话时显式选用被拒。
    const created = await call(env, 'POST', '/api/conversations', { model: 'faux/faux-2' })
    assert.equal(created.status, 409)
    assert.equal(created.body.error.code, 'model_disabled')

    // 更新既有会话模型为禁用模型被拒。
    const conv = env.app.kernel.listConversations().find((c) => c.profileId === 'assistant')
    assert.ok(conv)
    const patched = await call(env, 'PATCH', `/api/conversations/${conv.id}`, { model: 'faux/faux-2' })
    assert.equal(patched.status, 409)
    assert.equal(patched.body.error.code, 'model_disabled')

    // 生效模型被禁用（默认模型事后被禁）时提交输入被拒，绝不静默回退其它模型。
    await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-1'] })
    const submitted = await call(env, 'POST', `/api/conversations/${conv.id}/input`, { text: 'hello' })
    assert.equal(submitted.status, 409)
    assert.equal(submitted.body.error.code, 'model_disabled')

    // 设置全局默认模型为禁用模型同样被拒。
    const defaultRejected = await call(env, 'PUT', '/api/models/default', { model: 'faux/faux-1' })
    assert.equal(defaultRejected.status, 409)
    assert.equal(defaultRejected.body.error.code, 'model_disabled')

    // 重新启用后提交恢复成功（faux 已脚本化一条响应）。
    await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: [] })
    const ok = await call(env, 'POST', `/api/conversations/${conv.id}/input`, { text: 'hello again' })
    assert.equal(ok.status, 202)
  } finally {
    await env.close()
  }
})

test('禁用模型后原生 spawn 三条解析路径均在创建前拒绝（409 model_disabled），重新启用后恢复', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-models-filter-spawn-'))
  const faux = fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-2' }] })
  faux.setResponses([fauxAssistantMessage('ok')])
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  try {
    const parent = app.kernel.listConversations().find((c) => c.profileId === 'assistant')
    assert.ok(parent)

    // 路径 1：显式 request.model。
    await app.kernel.setDisabledModels('faux', ['faux-2'])
    await assert.rejects(
      () => app.kernel.spawnAgent({ parentConversationId: parent.id, prompt: 'x', model: 'faux/faux-2' }),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'model_disabled',
    )

    // 路径 2：profile.model（spawnable profile 绑定禁用模型，请求不带显式 model）。
    await app.kernel.profiles.save({ id: 'spawnable', name: 'S', model: 'faux/faux-2' })
    await assert.rejects(
      () => app.kernel.spawnAgent({ parentConversationId: parent.id, prompt: 'x', agentType: 'spawnable' }),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'model_disabled',
    )

    // 路径 3：全局默认模型被禁用（无显式 model、无 profile.model）。
    await app.kernel.setDisabledModels('faux', ['faux-1', 'faux-2'])
    await assert.rejects(
      () => app.kernel.spawnAgent({ parentConversationId: parent.id, prompt: 'x' }),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'model_disabled',
    )

    // 拒绝发生在创建之前：不得残留子会话（父会话仍是唯一 assistant 会话）。
    assert.equal(
      app.kernel.listConversations().filter((c) => c.parentConversationId === parent.id).length,
      0,
      'spawn 被拒时不得创建子会话',
    )

    // 重新启用后 spawn 恢复（全局默认 faux-1）。
    await app.kernel.setDisabledModels('faux', [])
    const result = await app.kernel.spawnAgent({ parentConversationId: parent.id, prompt: '干活' })
    assert.equal(result, 'ok')
  } finally {
    await app.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('resume 既有子会话：绑定模型后来被禁用时 409 model_disabled 且不提交输入', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-models-filter-resume-'))
  const faux = fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-2' }] })
  faux.setResponses([fauxAssistantMessage('ok')])
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  try {
    const parent = app.kernel.listConversations().find((c) => c.profileId === 'assistant')
    assert.ok(parent)

    // 首次 spawn：显式绑定 faux-2（此时启用）成功创建子会话并完成回合。
    const first = await app.kernel.spawnAgent({ parentConversationId: parent.id, prompt: 'x', model: 'faux/faux-2' })
    assert.equal(first, 'ok')
    const child = app.kernel.listConversations().find((c) => c.parentConversationId === parent.id)
    assert.ok(child)
    assert.equal(child.model, 'faux/faux-2')

    // 绑定模型事后被禁用：resume 在提交输入前拒绝，不绕过禁用策略。
    await app.kernel.setDisabledModels('faux', ['faux-2'])
    const callsBefore = faux.state.callCount
    await assert.rejects(
      () => app.kernel.spawnAgent({ parentConversationId: parent.id, resume: String(child.id), prompt: '继续' }),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.equal((err as { code?: string }).code, 'model_disabled')
        assert.equal((err as { status?: number }).status, 409)
        return true
      },
    )
    assert.equal(faux.state.callCount, callsBefore, 'resume 被拒时不得提交输入（无新增模型请求）')

    // 重新启用后 resume 恢复（走同一子会话续接，不新建）。
    await app.kernel.setDisabledModels('faux', [])
    faux.setResponses([fauxAssistantMessage('resumed ok')])
    const resumed = await app.kernel.spawnAgent({ parentConversationId: parent.id, resume: String(child.id), prompt: '继续' })
    assert.equal(resumed, 'resumed ok')
    const children = app.kernel.listConversations().filter((c) => c.parentConversationId === parent.id)
    assert.equal(children.length, 1, 'resume 不得新建子会话')
  } finally {
    await app.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('禁用模型后 HTTP POST/PUT /api/profiles 绑定禁用模型在落盘前拒绝（409 model_disabled）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-2'] })

    // POST 创建：绑定禁用模型拒绝且不落盘。
    const created = await call(env, 'POST', '/api/profiles', {
      id: 'disabled-bind',
      name: '绑定禁用模型',
      model: 'faux/faux-2',
    })
    assert.equal(created.status, 409)
    assert.equal(created.body.error.code, 'model_disabled')
    assert.equal(await env.app.kernel.profiles.get('disabled-bind'), undefined)

    // PUT 更新既有 profile：改绑禁用模型拒绝，原值不变。
    await env.app.kernel.profiles.save({ id: 'put-target', name: '既有角色', model: 'faux/faux-1' })
    const putRejected = await call(env, 'PUT', '/api/profiles/put-target', {
      name: '改绑禁用模型',
      model: 'faux/faux-2',
    })
    assert.equal(putRejected.status, 409)
    assert.equal(putRejected.body.error.code, 'model_disabled')
    assert.equal((await env.app.kernel.profiles.get('put-target'))?.model, 'faux/faux-1')

    // 合法模型仍可保存。
    const ok = await call(env, 'PUT', '/api/profiles/put-target', {
      name: '改绑可用模型',
      model: 'faux/faux-1',
    })
    assert.equal(ok.status, 200)
  } finally {
    await env.close()
  }
})

test('setDisabledModels 更新后发布 models.changed 事件（Web 客户端刷新目录）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const seen: Array<{ providers: unknown }> = []
    env.app.kernel.events.subscribe((frame) => {
      const event = frame.event as { type: string; payload?: unknown }
      if (event.type === 'models.changed') {
        seen.push(event.payload as { providers: unknown })
      }
    })
    await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-2'] })
    assert.equal(seen.length, 1, '设置禁用集恰发布一次 models.changed')
    assert.deepEqual(seen[0], { providers: ['faux'] })

    await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: [] })
    assert.equal(seen.length, 2, '清空同样发布')
    assert.deepEqual(seen[1], { providers: ['faux'] })

    await call(env, 'PUT', '/api/models/filter', { disabledModels: [] })
    assert.equal(seen.length, 3, '缺省 provider 清空全部也发布')
    assert.deepEqual(seen[2], { providers: [] })
  } finally {
    await env.close()
  }
})

test('重启持久化：同一 dataDir 重新 createHelm 后禁用集仍生效', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-2'] })
  // env.close 会清理临时目录，先读取 config 内容再重建目录验证重启语义。
  const raw = readFileSync(configPath(env), 'utf8')
  await env.close()

  const freshDir = mkdtempSync(join(tmpdir(), 'helm-models-filter-restart-'))
  try {
    writeFileSync(join(freshDir, 'config.json'), raw)
    const faux = fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-2' }] })
    const models = createModels()
    models.setProvider(faux.provider)
    const app = await createHelm({ dataDir: freshDir, cwd: freshDir, models })
    try {
      const catalog = await app.kernel.listModels()
      const entry = catalog.models.find((m) => m.provider === 'faux' && m.modelId === 'faux-2')
      assert.equal(entry?.disabled, true)
      // 会话选用仍被拒（config 驱动的内存快照生效）。
      await assert.rejects(
        () => app.kernel.createConversation({ model: 'faux/faux-2' }),
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.equal((err as { code?: string }).code, 'model_disabled')
          return true
        },
      )
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(freshDir, { recursive: true, force: true })
  }
})

test('config.json.disabledModels 非法形状：启动显式 config_corrupt，绝不静默丢弃', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-models-filter-corrupt-'))
  try {
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ disabledModels: { faux: 'not-an-array' } }))
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    await assert.rejects(
      () => createHelm({ dataDir, cwd: dataDir, models }),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.equal((err as { code?: string }).code, 'config_corrupt')
        return true
      },
    )
    assert.equal(existsSync(join(dataDir, 'config.json')), true)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
