/**
 * model manifest start stop end-to-end persist test (real createHelm + startHub + faux provider):
 * - PUT /api/models/filter settings/empty disable collection (config.json.disabledModels atomic persist);
 * - GET /api/models directory mark note disabled(available semantics do not change, credentials availability independent express);
 * - disable model after conversation explicit choose use and commit input all by refuse (409 model_disabled), never static default fall back;
 * - original generate spawn three model parse path (explicit request / profile / global by default) before creation reject disable model;
 * - original generate spawn resume since has sub-conversation: bind set model after come by disable when commit input before reject (409 model_disabled);
 * - HTTP POST/PUT /api/profiles bind set disable model in before reject;
 * - setDisabledModels update after publish models.changed event (connected Web client refresh directory);
 * - restart semantics: the same dataDir re- createHelm after disable collection still takes effect (loadDefaultsFromConfig);
 * - validate boundary: illegal model id(empty string/contains '/'), without provider carry disable items 400; illegal config shape config_corrupt.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { startHub } from '../../kernel/src/http/index.js'
import { createHubTestApp, makeFauxModels, type HubTestApp } from './helpers/hub-test-env.js'

interface Env {
  dataDir: string
  app: HubTestApp
  hubUrl: string
  hubToken?: string
  close(): Promise<void>
}

/** double model faux provider:faux-1(by default enable)/ faux-2(disable target);nested/model verify contains slash model id. */
async function makeEnv(): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-models-filter-'))
  const { app, faux } = await createHubTestApp({
    dataDir,
    cwd: dataDir,
    fauxOptions: { models: [{ id: 'faux-1' }, { id: 'faux-2' }, { id: 'nested/model' }] },
  })
  faux.setResponses([fauxAssistantMessage('ok')])
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
  // setup authentication (first time start without password then directly establish token).
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
    assert.equal(login.status, 200, 'auth setup/login should at least a succeeded')
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

test('PUT /api/models/filter settings disable collection,GET /api/models mark note disabled and config.json persist', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // initial directory: three model all available, without disabled mark note.
    const before = await call(env, 'GET', '/api/models')
    assert.equal(before.status, 200)
    const fauxEntries = before.body.models.filter((m: any) => m.provider === 'faux')
    assert.equal(fauxEntries.length, 3)
    assert.ok(fauxEntries.every((m: any) => m.disabled === undefined))

    // settings disable collection:faux provider disable faux-2.
    const put = await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-2'] })
    assert.equal(put.status, 200)
    assert.equal(put.body.ok, true)
    const entry = put.body.catalog.models.find((m: any) => m.provider === 'faux' && m.modelId === 'faux-2')
    assert.equal(entry.disabled, true)
    // available semantics do not change (credentials availability independent express;faux without credentials want seek still is available).
    assert.equal(entry.available, true)
    const other = put.body.catalog.models.find((m: any) => m.provider === 'faux' && m.modelId === 'faux-1')
    assert.equal(other.disabled, undefined)

    // GET directory same mark note.
    const after = await call(env, 'GET', '/api/models')
    const afterEntry = after.body.models.find((m: any) => m.provider === 'faux' && m.modelId === 'faux-2')
    assert.equal(afterEntry.disabled, true)

    // config.json atomic persist.
    const raw = JSON.parse(readFileSync(configPath(env), 'utf8')) as Record<string, unknown>
    assert.deepEqual(raw['disabledModels'], { faux: ['faux-2'] })

    // empty the provider disable collection:disabledModels key whole reclaim.
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

test('many provider disable collection mutual do not interference; default provider PUT empty all', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-models-filter-multi-'))
  const fauxA = fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-2' }] })
  const fauxB = fauxProvider({ provider: 'faux-b', models: [{ id: 'other-1' }] })
  const { app } = await createHubTestApp({ dataDir, cwd: dataDir, providers: [fauxA.provider, fauxB.provider] })
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
    // not involves model do not subject to interference.
    assert.equal(catalog.models.find((m: any) => m.provider === 'faux' && m.modelId === 'faux-1')?.disabled, undefined)

    // default provider + empty array = empty all (config key reclaim).
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

test('validate boundary: illegal model id / without provider carry disable items / unknown field / illegal body', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // empty body and {} all is explicit validate error (missing disabledModels).
    const empty = await call(env, 'PUT', '/api/models/filter', {})
    assert.equal(empty.status, 400)
    assert.equal(empty.body.error.code, 'validation_error')

    // without provider carry disable items.
    const noProvider = await call(env, 'PUT', '/api/models/filter', { disabledModels: ['x'] })
    assert.equal(noProvider.status, 400)

    // model id contains '/' legal (aggregate gateway model name itself contains slash), only empty string/non- string reject.
    const slashed = await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['nested/model'] })
    assert.equal(slashed.status, 200)
    assert.equal(slashed.body.catalog.models.find((m: { modelId: string }) => m.modelId === 'nested/model')?.disabled, true)

    // empty string model id.
    const emptyId = await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: [''] })
    assert.equal(emptyId.status, 400)

    // non- string array.
    const notStrings = await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: [1] })
    assert.equal(notStrings.status, 400)

    // unknown field reject.
    const unknownKey = await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: [], extra: 1 })
    assert.equal(unknownKey.status, 400)

    // directory in missing model id also by accept (self by string store).
    const free = await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['not-in-catalog'] })
    assert.equal(free.status, 200)
    const raw = JSON.parse(readFileSync(configPath(env), 'utf8')) as Record<string, unknown>
    assert.deepEqual(raw['disabledModels'], { faux: ['not-in-catalog'] })
  } finally {
    await env.close()
  }
})

test('disable model after conversation explicit choose use and commit input by refuse (409 model_disabled), re- enable after restore', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-2'] })

    // create conversation when explicit choose use by refuse.
    const created = await call(env, 'POST', '/api/conversations', { model: 'faux/faux-2' })
    assert.equal(created.status, 409)
    assert.equal(created.body.error.code, 'model_disabled')

    // update since has conversation model is disable model by refuse.
    const conv = env.app.kernel.listConversations().find((c) => c.profileId === 'assistant')
    assert.ok(conv)
    const patched = await call(env, 'PATCH', `/api/conversations/${conv.id}`, { model: 'faux/faux-2' })
    assert.equal(patched.status, 409)
    assert.equal(patched.body.error.code, 'model_disabled')

    // takes effect model by disable (by default model matter after by forbid) when commit input by refuse, never static default fall back other model.
    await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-1'] })
    const submitted = await call(env, 'POST', `/api/conversations/${conv.id}/input`, { text: 'hello' })
    assert.equal(submitted.status, 409)
    assert.equal(submitted.body.error.code, 'model_disabled')

    // settings global by default model is disable model same by refuse.
    const defaultRejected = await call(env, 'PUT', '/api/models/default', { model: 'faux/faux-1' })
    assert.equal(defaultRejected.status, 409)
    assert.equal(defaultRejected.body.error.code, 'model_disabled')

    // re- enable after commit restore succeeded (faux already script a response).
    await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: [] })
    const ok = await call(env, 'POST', `/api/conversations/${conv.id}/input`, { text: 'hello again' })
    assert.equal(ok.status, 202)
  } finally {
    await env.close()
  }
})

test('disable model after original generate spawn three parse path all in before creation reject (409 model_disabled), re- enable after restore', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-models-filter-spawn-'))
  const { app, faux } = await createHubTestApp({
    dataDir,
    cwd: dataDir,
    fauxOptions: { models: [{ id: 'faux-1' }, { id: 'faux-2' }] },
  })
  faux.setResponses([fauxAssistantMessage('ok')])
  try {
    const parent = app.kernel.listConversations().find((c) => c.profileId === 'assistant')
    assert.ok(parent)

    // path 1: explicit request.model.
    await app.kernel.setDisabledModels('faux', ['faux-2'])
    await assert.rejects(
      () => app.kernel.spawnAgent({ parentConversationId: parent.id, prompt: 'x', model: 'faux/faux-2' }),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'model_disabled',
    )

    // path 2:profile.model(spawnable profile bind set disable model, request do not carries explicit model).
    await app.kernel.profiles.save({ id: 'spawnable', name: 'S', model: 'faux/faux-2' })
    await assert.rejects(
      () => app.kernel.spawnAgent({ parentConversationId: parent.id, prompt: 'x', agentType: 'spawnable' }),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'model_disabled',
    )

    // path 3: global by default model by disable (without explicit model, without profile.model).
    await app.kernel.setDisabledModels('faux', ['faux-1', 'faux-2'])
    await assert.rejects(
      () => app.kernel.spawnAgent({ parentConversationId: parent.id, prompt: 'x' }),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'model_disabled',
    )

    // reject occur in create before: must not leftover sub-conversation (parent conversation still is unique assistant conversation).
    assert.equal(
      app.kernel.listConversations().filter((c) => c.parentConversationId === parent.id).length,
      0,
      'spawn by refuse when must not create sub-conversation',
    )

    // re- enable after spawn restore (global by default faux-1).
    await app.kernel.setDisabledModels('faux', [])
    const result = await app.kernel.spawnAgent({ parentConversationId: parent.id, prompt: 'dry' })
    assert.equal(result, 'ok')
  } finally {
    await app.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('resume since has sub-conversation: bind set model after come by disable when 409 model_disabled and do not commit input', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-models-filter-resume-'))
  const { app, faux } = await createHubTestApp({
    dataDir,
    cwd: dataDir,
    fauxOptions: { models: [{ id: 'faux-1' }, { id: 'faux-2' }] },
  })
  faux.setResponses([fauxAssistantMessage('ok')])
  try {
    const parent = app.kernel.listConversations().find((c) => c.profileId === 'assistant')
    assert.ok(parent)

    // first time spawn: explicit bind set faux-2(now enable) succeeded create sub-conversation and complete turn.
    const first = await app.kernel.spawnAgent({ parentConversationId: parent.id, prompt: 'x', model: 'faux/faux-2' })
    assert.equal(first, 'ok')
    const child = app.kernel.listConversations().find((c) => c.parentConversationId === parent.id)
    assert.ok(child)
    assert.equal(child.model, 'faux/faux-2')

    // bind set model matter after by disable:resume in commit input before reject, do not bypass disable policy.
    await app.kernel.setDisabledModels('faux', ['faux-2'])
    const callsBefore = faux.state.callCount
    await assert.rejects(
      () => app.kernel.spawnAgent({ parentConversationId: parent.id, resume: String(child.id), prompt: 'continue' }),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.equal((err as { code?: string }).code, 'model_disabled')
        assert.equal((err as { status?: number }).status, 409)
        return true
      },
    )
    assert.equal(faux.state.callCount, callsBefore, 'resume by refuse when must not commit input (without new increase model request)')

    // re- enable after resume restore (away the same sub-conversation resume, do not creates new).
    await app.kernel.setDisabledModels('faux', [])
    faux.setResponses([fauxAssistantMessage('resumed ok')])
    const resumed = await app.kernel.spawnAgent({ parentConversationId: parent.id, resume: String(child.id), prompt: 'continue' })
    assert.equal(resumed, 'resumed ok')
    const children = app.kernel.listConversations().filter((c) => c.parentConversationId === parent.id)
    assert.equal(children.length, 1, 'resume must not creates new sub-conversation')
  } finally {
    await app.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('disable model after HTTP POST/PUT /api/profiles bind set disable model in before reject (409 model_disabled)', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-2'] })

    // POST create: bind set disable model reject and do not.
    const created = await call(env, 'POST', '/api/profiles', {
      id: 'disabled-bind',
      name: 'bind set disable model',
      model: 'faux/faux-2',
    })
    assert.equal(created.status, 409)
    assert.equal(created.body.error.code, 'model_disabled')
    assert.equal(await env.app.kernel.profiles.get('disabled-bind'), undefined)

    // PUT update since has profile: change bind disable model reject, original value do not change.
    await env.app.kernel.profiles.save({ id: 'put-target', name: 'since has role', model: 'faux/faux-1' })
    const putRejected = await call(env, 'PUT', '/api/profiles/put-target', {
      name: 'change bind disable model',
      model: 'faux/faux-2',
    })
    assert.equal(putRejected.status, 409)
    assert.equal(putRejected.body.error.code, 'model_disabled')
    assert.equal((await env.app.kernel.profiles.get('put-target'))?.model, 'faux/faux-1')

    // legal model still can save.
    const ok = await call(env, 'PUT', '/api/profiles/put-target', {
      name: 'change bind available model',
      model: 'faux/faux-1',
    })
    assert.equal(ok.status, 200)
  } finally {
    await env.close()
  }
})

test('setDisabledModels update after publish models.changed event (Web client refresh directory)', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const seen: Array<{ providers: unknown }> = []
    env.app.kernel.events.subscribe((frame) => {
      const event = frame.event as { type: string; payload?: unknown }
      if (event.type === 'models.changed') {
        const payload = event.payload as { providers?: unknown }
        // Ignore asynchronous background refresh events emitted by default-enabled builtin:magpie at startup.
        if (Array.isArray(payload?.providers) && payload.providers.length === 1 && payload.providers[0] === 'magpie') {
          return
        }
        seen.push(event.payload as { providers: unknown })
      }
    })
    await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-2'] })
    assert.equal(seen.length, 1, 'settings disable collection exactly publish once models.changed')
    assert.deepEqual(seen[0], { providers: ['faux'] })

    await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: [] })
    assert.equal(seen.length, 2, 'empty same publish')
    assert.deepEqual(seen[1], { providers: ['faux'] })

    await call(env, 'PUT', '/api/models/filter', { disabledModels: [] })
    assert.equal(seen.length, 3, 'default provider empty all also publish')
    assert.deepEqual(seen[2], { providers: [] })
  } finally {
    await env.close()
  }
})

test('restart persist: the same dataDir re- createHelm after disable collection still takes effect', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-2'] })
  // env.close will clean up temp directory, first read config content again rebuild directory verify restart semantics.
  const raw = readFileSync(configPath(env), 'utf8')
  await env.close()

  const freshDir = mkdtempSync(join(tmpdir(), 'helm-models-filter-restart-'))
  try {
    writeFileSync(join(freshDir, 'config.json'), raw)
    const { app } = await createHubTestApp({
      dataDir: freshDir,
      cwd: freshDir,
      fauxOptions: { models: [{ id: 'faux-1' }, { id: 'faux-2' }] },
    })
    try {
      const catalog = await app.kernel.listModels()
      const entry = catalog.models.find((m) => m.provider === 'faux' && m.modelId === 'faux-2')
      assert.equal(entry?.disabled, true)
      // conversation choose use still by refuse (config drive memory snapshot takes effect).
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

test('config.json.disabledModels illegal shape: start explicit config_corrupt, never static default discard', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-models-filter-corrupt-'))
  try {
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ disabledModels: { faux: 'not-an-array' } }))
    await assert.rejects(
      () => createHubTestApp({ dataDir, cwd: dataDir }),
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

test('KernelRuntimeOptions.providers coexists with builtin:magpie and rejects simultaneous models', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-models-providers-mutex-'))
  try {
    const { models, faux } = makeFauxModels()
    await assert.rejects(
      () => createHubTestApp({ dataDir, cwd: dataDir, models, providers: [faux.provider] }),
      (err: unknown) =>
        err instanceof Error &&
        (err as { code?: string; status?: number }).code === 'validation_error' &&
        (err as { status?: number }).status === 400,
    )

    const { app } = await createHubTestApp({ dataDir, cwd: dataDir })
    try {
      const ids = app.kernel.listModelProviders().map((p) => p.id)
      assert.ok(ids.includes('faux'), 'providers option registers faux runtime provider')
      assert.ok(ids.includes('magpie'), 'default-enabled builtin:magpie coexists with providers option')
    } finally {
      await app.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
