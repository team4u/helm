/**
 * Global model config and Profile inheritance regression tests (0507188 behavior lock):
 *
 * Model resolution chain: options.model > HELM_MODEL > config.json.model (all unset = unconfigured);
 * Effective conversation chain: conversation override > Profile.model > global; Profile.model='' is treated as
 * unset (inherits global); assistant Profile overrides global and persists across restarts.
 * Explicit error contract (never silently fall back): invalid config.model -> config_corrupt;
 * corrupt Profile JSON -> profile_read_failed (carrying profileId); existing conversation whose referenced
 * Profile was deleted -> profile_not_found (even if an override is set, Profile existence is checked);
 * creating conversation with missing explicit profileId -> validation_error (no fallback to assistant).
 * All tests use real KernelRuntime + faux provider + temp dataDir, asserting assistant entry model message
 * provider/model and faux call counters on actual requests.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { HelmError, type ConversationEntry } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/index.js'
import { cleanupDir, makeFauxModels, makeTempDir } from './helpers.js'

type FauxHandle = ReturnType<typeof makeFauxModels>['faux']
type RuntimeWithFaux = KernelRuntime & { __faux: FauxHandle }

async function openRuntime(
  dir: string,
  opts: { model?: string; ids?: string[] } = {},
): Promise<RuntimeWithFaux> {
  const { models, faux } = makeFauxModels({ models: (opts.ids ?? ['faux-1']).map((id) => ({ id })) })
  const runtime = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    models,
  })
  return Object.assign(runtime, { __faux: faux })
}

/** Writes a profile (profile.json) under dataDir. */
function writeProfile(dataDir: string, id: string, fields: Record<string, unknown>): void {
  const dir = join(dataDir, 'profiles', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ id, ...fields }, null, 2))
}

/** Returns the latest pi.assistant entry (carrying model messages to assert which model handled the real request). */
async function lastAssistantEntry(kernel: KernelRuntime, convId: number): Promise<ConversationEntry> {
  const detail = await kernel.getConversationDetail(convId, { limit: 50 })
  const entry = [...detail.entries].reverse().find((e) => e.kind === 'pi.assistant')
  assert.ok(entry, 'should have a pi.assistant entry')
  return entry
}

/** Asserts provider/modelId on the real model request (faux clones messages with the requested model). */
function assertRequestModel(entry: ConversationEntry, provider: string, modelId: string): void {
  const message = (entry.model ?? [])[0] as { provider?: string; model?: string } | undefined
  assert.ok(message, 'assistant entry should preserve model message')
  assert.equal(message.provider, provider)
  assert.equal(message.model, modelId)
}

function isHelm(code: string): (err: unknown) => boolean {
  return (err) => err instanceof HelmError && err.code === code
}

let root: string
let savedHelmModel: string | undefined

before(async () => {
  root = await makeTempDir('helm-model-cfg-')
  // Manage all model sources explicitly in this file; isolate external env vars.
  savedHelmModel = process.env['HELM_MODEL']
  delete process.env['HELM_MODEL']
})

after(async () => {
  if (savedHelmModel !== undefined) process.env['HELM_MODEL'] = savedHelmModel
  await cleanupDir(root)
})

// ---------------------------------------------------------------------------
// 1. config.json.model alone takes effect (real faux request)
// ---------------------------------------------------------------------------

describe('config.json.model global model', { timeout: 60_000 }, () => {
  it('without options/env, config.model applies to root and new conversations and drives real faux requests', { timeout: 60_000 }, async () => {
    const dir = join(root, 'c1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ model: 'faux/faux-1' }))
    const kernel = await openRuntime(dir)
    try {
      assert.equal(kernel.getConversation(1).model, 'faux/faux-1')
      const conv = await kernel.createConversation({})
      assert.equal(conv.model, 'faux/faux-1')
      kernel.__faux.setResponses([fauxAssistantMessage('config model answer')])
      await kernel.submitInput(1, 'question')
      await kernel.waitForIdle(1)
      assertRequestModel(await lastAssistantEntry(kernel, 1), 'faux', 'faux-1')
      assert.ok(kernel.__faux.state.callCount >= 1, 'should make a real faux request')
    } finally {
      await kernel.close()
    }
  })

  it('throws config_corrupt explicitly on startup when config.model has invalid type/format', { timeout: 60_000 }, async () => {
    const dirNum = join(root, 'c2')
    mkdirSync(dirNum, { recursive: true })
    writeFileSync(join(dirNum, 'config.json'), JSON.stringify({ model: 123 }))
    await assert.rejects(() => openRuntime(dirNum), isHelm('config_corrupt'))

    const dirBad = join(root, 'c3')
    mkdirSync(dirBad, { recursive: true })
    writeFileSync(join(dirBad, 'config.json'), JSON.stringify({ model: 'faux-1' }))
    await assert.rejects(() => openRuntime(dirBad), isHelm('config_corrupt'))
  })
})

// ---------------------------------------------------------------------------
// 2. options.model > HELM_MODEL > config.json.model
// ---------------------------------------------------------------------------

describe('global model source priority', { timeout: 60_000 }, () => {
  it('env overrides config; options overrides env+config and aligns existing conversations after restart', { timeout: 60_000 }, async () => {
    const dir = join(root, 'p2')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ model: 'faux/faux-2' }))
    process.env['HELM_MODEL'] = 'faux/faux-1'
    let k1: RuntimeWithFaux | undefined
    try {
      k1 = await openRuntime(dir, { ids: ['faux-1', 'faux-2'] })
      const conv = await k1.createConversation({})
      assert.equal(conv.model, 'faux/faux-1', 'HELM_MODEL should take precedence over config.json.model')
      k1.__faux.setResponses([fauxAssistantMessage('env answer')])
      await k1.submitInput(conv.id, 'question')
      await k1.waitForIdle(conv.id)
      assertRequestModel(await lastAssistantEntry(k1, conv.id), 'faux', 'faux-1')
      await k1.close()
      k1 = undefined

      // options.model has highest priority: env still points to faux-1, yet post-restart uses explicit faux-2.
      const k2 = await openRuntime(dir, { model: 'faux/faux-2', ids: ['faux-1', 'faux-2'] })
      try {
        assert.equal(k2.getConversation(conv.id).model, 'faux/faux-2')
        k2.__faux.setResponses([fauxAssistantMessage('options answer')])
        await k2.submitInput(conv.id, 'question')
        await k2.waitForIdle(conv.id)
        assertRequestModel(await lastAssistantEntry(k2, conv.id), 'faux', 'faux-2')
      } finally {
        await k2.close()
      }
    } finally {
      if (k1) await k1.close().catch(() => {})
      delete process.env['HELM_MODEL']
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Profile and conversation override priority; empty model inherits
// ---------------------------------------------------------------------------

describe('Profile.model and conversation override', { timeout: 60_000 }, () => {
  it('Profile overrides global; override overrides Profile; clearing falls back along chain; empty model inherits global', { timeout: 60_000 }, async () => {
    const dir = join(root, 'p3')
    writeProfile(dir, 'worker', { name: 'W', model: 'faux/faux-2' })
    writeProfile(dir, 'empty', { name: 'E', model: '' })
    const kernel = await openRuntime(dir, { model: 'faux/faux-1', ids: ['faux-1', 'faux-2'] })
    try {
      const conv = await kernel.createConversation({ profileId: 'worker' })
      assert.equal(conv.model, 'faux/faux-2', 'Profile.model should take precedence over global')
      kernel.__faux.setResponses([fauxAssistantMessage('profile model answer')])
      await kernel.submitInput(conv.id, 'question')
      await kernel.waitForIdle(conv.id)
      assertRequestModel(await lastAssistantEntry(kernel, conv.id), 'faux', 'faux-2')

      const overridden = await kernel.updateConversation(conv.id, { model: 'faux/faux-1' })
      assert.equal(overridden.model, 'faux/faux-1', 'conversation override should take precedence over Profile')
      const cleared = await kernel.updateConversation(conv.id, { model: '' })
      assert.equal(cleared.model, 'faux/faux-2', 'clearing override should fall back to Profile.model')

      const inherited = await kernel.createConversation({ profileId: 'empty' })
      assert.equal(inherited.model, 'faux/faux-1', 'empty Profile.model string is treated as unset and inherits global')
    } finally {
      await kernel.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. assistant Profile precedence and restart persistence
// ---------------------------------------------------------------------------

describe('assistant Profile model', { timeout: 60_000 }, () => {
  it('conversation #1 uses assistant Profile.model (above global); persists and submits after restart without global config', { timeout: 60_000 }, async () => {
    const dir = join(root, 'p4')
    writeProfile(dir, 'assistant', { name: 'assist', model: 'faux/faux-2' })
    const k1 = await openRuntime(dir, { model: 'faux/faux-1', ids: ['faux-1', 'faux-2'] })
    try {
      assert.equal(k1.getConversation(1).model, 'faux/faux-2', 'conversation should use assistant Profile model')
      k1.__faux.setResponses([fauxAssistantMessage('conversation answer')])
      await k1.submitInput(1, 'question')
      await k1.waitForIdle(1)
      assertRequestModel(await lastAssistantEntry(k1, 1), 'faux', 'faux-2')
      await k1.close()

      // Restart without any global model source: root still keeps assistant Profile model (SDK config durable).
      const k2 = await openRuntime(dir, { ids: ['faux-1', 'faux-2'] })
      try {
        assert.equal(k2.getConversation(1).model, 'faux/faux-2')
        k2.__faux.setResponses([fauxAssistantMessage('after restart answer')])
        await k2.submitInput(1, 'next question')
        await k2.waitForIdle(1)
        assertRequestModel(await lastAssistantEntry(k2, 1), 'faux', 'faux-2')
      } finally {
        await k2.close()
      }
    } catch (error) {
      await k1.close().catch(() => {})
      throw error
    }
  })
})

// ---------------------------------------------------------------------------
// 5. Creating conversation with explicit profileId: missing rejects; bound after creating real Profile
// ---------------------------------------------------------------------------

describe('createConversation explicit profileId validation', { timeout: 60_000 }, () => {
  it('rejects when explicit default profile is missing; binds original ID after creating real default', { timeout: 60_000 }, async () => {
    const dir = join(root, 'p5')
    const kernel = await openRuntime(dir)
    try {
      assert.equal((await kernel.createConversation()).profileId, 'assistant', 'omitted profileId defaults to assistant')
      await assert.rejects(
        () => kernel.createConversation({ profileId: 'default' }),
        isHelm('validation_error'),
      )
      writeProfile(dir, 'default', { name: 'D', model: 'faux/faux-1' })
      const conv = await kernel.createConversation({ profileId: 'default' })
      assert.equal(conv.profileId, 'default')
      assert.equal(conv.model, 'faux/faux-1')
      // Invalid model reference format also rejects explicitly.
      await assert.rejects(
        () => kernel.createConversation({ model: 'no-slash' }),
        isHelm('validation_error'),
      )
    } finally {
      await kernel.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 6. Corrupt / deleted Profile: explicit error without invoking faux provider
// ---------------------------------------------------------------------------

describe('corrupt and missing Profile explicit errors', { timeout: 60_000 }, () => {
  it('corrupt JSON -> profile_read_failed; deleted -> profile_not_found / validation_error; zero faux calls', { timeout: 60_000 }, async () => {
    const dir = join(root, 'p6')
    writeProfile(dir, 'worker', { name: 'W', model: 'faux/faux-1' })
    const kernel = await openRuntime(dir)
    try {
      const conv = await kernel.createConversation({ profileId: 'worker' })
      assert.equal(conv.model, 'faux/faux-1')

      // Corrupt JSON: read paths consistently throw explicitly (never swallowed or treated as unset).
      writeFileSync(join(dir, 'profiles', 'worker', 'profile.json'), '{ broken json')
      await assert.rejects(
        () => kernel.createConversation({ profileId: 'worker' }),
        (err: unknown) =>
          err instanceof HelmError &&
          err.code === 'profile_read_failed' &&
          (err.details as { profileId?: string })?.profileId === 'worker',
      )
      await assert.rejects(
        () => kernel.updateConversation(conv.id, { title: 'x' }),
        isHelm('profile_read_failed'),
      )
      await assert.rejects(() => kernel.submitInput(conv.id, 'question'), isHelm('profile_read_failed'))
      assert.equal(kernel.__faux.state.callCount, 0, 'must not start model request when Profile is corrupt')

      // Existing conversation whose Profile is deleted: must still require the real Profile to exist.
      await cleanupDir(join(dir, 'profiles', 'worker'))
      await assert.rejects(
        () => kernel.submitInput(conv.id, 'question'),
        (err: unknown) =>
          err instanceof HelmError &&
          err.code === 'profile_not_found' &&
          (err.details as { profileId?: string })?.profileId === 'worker',
      )
      await assert.rejects(() => kernel.updateConversation(conv.id, { title: 'y' }), isHelm('profile_not_found'))
      await assert.rejects(() => kernel.createConversation({ profileId: 'worker' }), isHelm('validation_error'))
      assert.equal(kernel.__faux.state.callCount, 0, 'must not start model request when Profile is missing')
    } finally {
      await kernel.close()
    }
  })
})
