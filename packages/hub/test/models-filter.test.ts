/**
 * End-to-end persistence tests for model catalog filtering (`disabledModels`):
 * - `PUT /api/models/filter` sets/clears disabled models (persisted atomically to `config.json.disabledModels`);
 * - `GET /api/models` marks disabled models (`available` semantics stay orthogonal for credentials);
 * - Disabled models are rejected (`409 model_disabled`) on explicit selection and input submission without silent fallback;
 * - Native spawn rejects disabled models across all three resolution paths (explicit request / profile / global default) before creation;
 * - Native spawn resuming an existing child rejects (`409 model_disabled`) before submitting input if its bound model was disabled;
 * - `POST`/`PUT /api/profiles` rejects binding a disabled model upfront;
 * - `setDisabledModels` emits `models.changed` so connected Web clients refresh their catalog;
 * - Restart persistence: reopening `createHelm` with the same `dataDir` preserves disabled sets (`loadDefaultsFromConfig`);
 * - Validation boundaries: invalid model IDs (empty strings), disabled items without `provider` -> 400; malformed config -> `config_corrupt`.
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

/** Multi-model faux provider: `faux-1` (default enabled), `faux-2` (disabled target), `nested/model` (tests slash IDs). */
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
  // Initialize auth (initial launch without a password sets up a token directly).
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
    assert.equal(login.status, 200, 'either auth setup or login should succeed')
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

test('PUT /api/models/filter updates disabled set, GET /api/models flags disabled, config.json persists', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // Initial catalog: all three models are available with `disabled` unset.
    const before = await call(env, 'GET', '/api/models')
    assert.equal(before.status, 200)
    const fauxEntries = before.body.models.filter((m: any) => m.provider === 'faux')
    assert.equal(fauxEntries.length, 3)
    assert.ok(fauxEntries.every((m: any) => m.disabled === undefined))

    // Disable `faux-2` under provider `faux`.
    const put = await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-2'] })
    assert.equal(put.status, 200)
    assert.equal(put.body.ok, true)
    const entry = put.body.catalog.models.find((m: any) => m.provider === 'faux' && m.modelId === 'faux-2')
    assert.equal(entry.disabled, true)
    // `available` semantics are orthogonal (tracks credential availability; faux requires no credentials).
    assert.equal(entry.available, true)
    const other = put.body.catalog.models.find((m: any) => m.provider === 'faux' && m.modelId === 'faux-1')
    assert.equal(other.disabled, undefined)

    // GET catalog reflects the same disabled flag.
    const after = await call(env, 'GET', '/api/models')
    const afterEntry = after.body.models.find((m: any) => m.provider === 'faux' && m.modelId === 'faux-2')
    assert.equal(afterEntry.disabled, true)

    // Atomically persisted to `config.json`.
    const raw = JSON.parse(readFileSync(configPath(env), 'utf8')) as Record<string, unknown>
    assert.deepEqual(raw['disabledModels'], { faux: ['faux-2'] })

    // Clearing the provider's disabled set deletes the empty `disabledModels` key.
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

test('disabled sets are isolated per provider; omitting provider with empty array clears all', { timeout: 60_000 }, async () => {
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
    // Unrelated models stay unaffected.
    assert.equal(catalog.models.find((m: any) => m.provider === 'faux' && m.modelId === 'faux-1')?.disabled, undefined)

    // Omitting `provider` with empty array clears all disabled sets and prunes the config key.
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

test('validation boundary: invalid model ID, missing provider with disabled items, unknown fields, invalid body', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // Empty body or `{}` fails validation (`disabledModels` required).
    const empty = await call(env, 'PUT', '/api/models/filter', {})
    assert.equal(empty.status, 400)
    assert.equal(empty.body.error.code, 'validation_error')

    // Non-empty `disabledModels` without `provider`.
    const noProvider = await call(env, 'PUT', '/api/models/filter', { disabledModels: ['x'] })
    assert.equal(noProvider.status, 400)

    // Model IDs containing `/` are valid (gateway model names may include slashes); only empty/non-strings reject.
    const slashed = await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['nested/model'] })
    assert.equal(slashed.status, 200)
    assert.equal(slashed.body.catalog.models.find((m: { modelId: string }) => m.modelId === 'nested/model')?.disabled, true)

    // Empty string model ID.
    const emptyId = await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: [''] })
    assert.equal(emptyId.status, 400)

    // Non-string array element.
    const notStrings = await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: [1] })
    assert.equal(notStrings.status, 400)

    // Unknown field rejected.
    const unknownKey = await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: [], extra: 1 })
    assert.equal(unknownKey.status, 400)

    // Model IDs absent from the current catalog are still accepted and persisted verbatim.
    const free = await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['not-in-catalog'] })
    assert.equal(free.status, 200)
    const raw = JSON.parse(readFileSync(configPath(env), 'utf8')) as Record<string, unknown>
    assert.deepEqual(raw['disabledModels'], { faux: ['not-in-catalog'] })
  } finally {
    await env.close()
  }
})

test('disabled models reject explicit selection and input submission (409 model_disabled), recovering once re-enabled', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-2'] })

    // Explicit selection when creating a conversation is rejected.
    const created = await call(env, 'POST', '/api/conversations', { model: 'faux/faux-2' })
    assert.equal(created.status, 409)
    assert.equal(created.body.error.code, 'model_disabled')

    // Patching an existing conversation to a disabled model is rejected.
    const conv = env.app.kernel.listConversations().find((c) => c.profileId === 'assistant')
    assert.ok(conv)
    const patched = await call(env, 'PATCH', `/api/conversations/${conv.id}`, { model: 'faux/faux-2' })
    assert.equal(patched.status, 409)
    assert.equal(patched.body.error.code, 'model_disabled')

    // Submitting input when the effective model is later disabled rejects without falling back to another model.
    await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-1'] })
    const submitted = await call(env, 'POST', `/api/conversations/${conv.id}/input`, { text: 'hello' })
    assert.equal(submitted.status, 409)
    assert.equal(submitted.body.error.code, 'model_disabled')

    // Setting global default or global compaction model to a disabled model is likewise rejected.
    const defaultRejected = await call(env, 'PUT', '/api/models/default', { model: 'faux/faux-1' })
    assert.equal(defaultRejected.status, 409)
    assert.equal(defaultRejected.body.error.code, 'model_disabled')
    const compactionRejected = await call(env, 'PUT', '/api/models/default', { compactionModel: 'faux/faux-1' })
    assert.equal(compactionRejected.status, 409)
    assert.equal(compactionRejected.body.error.code, 'model_disabled')

    // Re-enabling restores input submission (faux already has a scripted response).
    await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: [] })
    const ok = await call(env, 'POST', `/api/conversations/${conv.id}/input`, { text: 'hello again' })
    assert.equal(ok.status, 202)
  } finally {
    await env.close()
  }
})

test('disabled models reject all three native spawn resolution paths before creation (409 model_disabled)', { timeout: 60_000 }, async () => {
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

    // Path 1: explicit `request.model`.
    await app.kernel.setDisabledModels('faux', ['faux-2'])
    await assert.rejects(
      () => app.kernel.spawnAgent({ parentConversationId: parent.id, prompt: 'x', model: 'faux/faux-2' }),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'model_disabled',
    )

    // Path 2: `profile.model` (spawnable profile binds a disabled model; request omits explicit model).
    await app.kernel.profiles.save({ id: 'spawnable', name: 'S', model: 'faux/faux-2' })
    await assert.rejects(
      () => app.kernel.spawnAgent({ parentConversationId: parent.id, prompt: 'x', agentType: 'spawnable' }),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'model_disabled',
    )

    // Path 3: global default model is disabled (neither request nor profile specifies a model).
    await app.kernel.setDisabledModels('faux', ['faux-1', 'faux-2'])
    await assert.rejects(
      () => app.kernel.spawnAgent({ parentConversationId: parent.id, prompt: 'x' }),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'model_disabled',
    )

    // Rejection occurs before creation: no orphaned child conversations should be left behind.
    assert.equal(
      app.kernel.listConversations().filter((c) => c.parentConversationId === parent.id).length,
      0,
      'rejected spawn must not create a child conversation',
    )

    // Spawning succeeds again once re-enabled (global default faux-1).
    await app.kernel.setDisabledModels('faux', [])
    const result = await app.kernel.spawnAgent({ parentConversationId: parent.id, prompt: 'dry' })
    assert.equal(result, 'ok')
  } finally {
    await app.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('resuming an existing child rejects with 409 model_disabled before submitting input when its bound model is disabled', { timeout: 60_000 }, async () => {
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

    // First spawn: explicitly binds enabled `faux-2` and completes turn.
    const first = await app.kernel.spawnAgent({ parentConversationId: parent.id, prompt: 'x', model: 'faux/faux-2' })
    assert.equal(first, 'ok')
    const child = app.kernel.listConversations().find((c) => c.parentConversationId === parent.id)
    assert.ok(child)
    assert.equal(child.model, 'faux/faux-2')

    // Disable the bound model afterwards: resume must reject before submitting input.
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
    assert.equal(faux.state.callCount, callsBefore, 'rejected resume must not submit input or invoke the model')

    // Re-enabling allows resuming the same child conversation without creating a new one.
    await app.kernel.setDisabledModels('faux', [])
    faux.setResponses([fauxAssistantMessage('resumed ok')])
    const resumed = await app.kernel.spawnAgent({ parentConversationId: parent.id, resume: String(child.id), prompt: 'continue' })
    assert.equal(resumed, 'resumed ok')
    const children = app.kernel.listConversations().filter((c) => c.parentConversationId === parent.id)
    assert.equal(children.length, 1, 'resume must not create a new child conversation')
  } finally {
    await app.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('HTTP POST/PUT /api/profiles rejects binding a disabled model upfront (409 model_disabled)', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-2'] })

    // POST create: binding a disabled model rejects without saving.
    const created = await call(env, 'POST', '/api/profiles', {
      id: 'disabled-bind',
      name: 'bind set disable model',
      model: 'faux/faux-2',
    })
    assert.equal(created.status, 409)
    assert.equal(created.body.error.code, 'model_disabled')
    assert.equal(await env.app.kernel.profiles.get('disabled-bind'), undefined)

    // PUT update existing profile: switching to a disabled model rejects without mutating stored model.
    await env.app.kernel.profiles.save({ id: 'put-target', name: 'existing profile', model: 'faux/faux-1' })
    const putRejected = await call(env, 'PUT', '/api/profiles/put-target', {
      name: 'switch to disabled model',
      model: 'faux/faux-2',
    })
    assert.equal(putRejected.status, 409)
    assert.equal(putRejected.body.error.code, 'model_disabled')
    assert.equal((await env.app.kernel.profiles.get('put-target'))?.model, 'faux/faux-1')

    // Valid enabled model still saves.
    const ok = await call(env, 'PUT', '/api/profiles/put-target', {
      name: 'switch to available model',
      model: 'faux/faux-1',
    })
    assert.equal(ok.status, 200)
  } finally {
    await env.close()
  }
})

test('setDisabledModels emits models.changed event (Web client refreshes catalog)', { timeout: 60_000 }, async () => {
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
    assert.equal(seen.length, 1, 'setting disabled models emits models.changed once')
    assert.deepEqual(seen[0], { providers: ['faux'] })

    await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: [] })
    assert.equal(seen.length, 2, 'clearing a provider also emits models.changed')
    assert.deepEqual(seen[1], { providers: ['faux'] })

    await call(env, 'PUT', '/api/models/filter', { disabledModels: [] })
    assert.equal(seen.length, 3, 'clearing all without provider also emits models.changed')
    assert.deepEqual(seen[2], { providers: [] })
  } finally {
    await env.close()
  }
})

test('restart persistence: reopening createHelm on the same dataDir preserves disabledModels', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  await call(env, 'PUT', '/api/models/filter', { provider: 'faux', disabledModels: ['faux-2'] })
  // env.close() deletes the temp dir; snapshot config.json and recreate a fresh dir to test restart loading.
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
      // Selecting the disabled model is still rejected (config-driven snapshot takes effect).
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

test('config.json.disabledModels malformed shape fails startup with config_corrupt instead of silently discarding', { timeout: 60_000 }, async () => {
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
