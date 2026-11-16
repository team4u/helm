/**
 * global model config and Profile legacy regression (0507188 behavior lock):
 *
 * model parse chain:options.model > HELM_MODEL > config.json.model(three all without = not config);
 * conversation takes effect chain: conversation override > Profile.model > global;Profile.model is empty string treated as
 * not config (inherit global);assistant  Profile takes precedence at global and after restart keep.
 * explicit error contract (not silently fall back):config.model illegal -> config_corrupt;
 * Profile JSON corrupt -> profile_read_failed(carries profileId); since has conversation reference
 * Profile by delete -> profile_not_found(even if has override also want seek real Profile store in);
 * create explicit profileId missing -> validation_error(no longer back assistant).
 * all use real KernelRuntime + faux provider + temporary dataDir; real request assertion
 * assistant entry model message provider/model and faux invoke counter.
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

/** in dataDir write a profile(profile.json). */
function writeProfile(dataDir: string, id: string, fields: Record<string, unknown>): void {
  const dir = join(dataDir, 'profiles', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ id, ...fields }, null, 2))
}

/** most near a pi.assistant entry(contains model message, supply assertion real request which use model). */
async function lastAssistantEntry(kernel: KernelRuntime, convId: number): Promise<ConversationEntry> {
  const detail = await kernel.getConversationDetail(convId, { limit: 50 })
  const entry = [...detail.entries].reverse().find((e) => e.kind === 'pi.assistant')
  assert.ok(entry, 'should has pi.assistant entry')
  return entry
}

/** assertion real model request provider/modelId(faux clone message when will change write is request model). */
function assertRequestModel(entry: ConversationEntry, provider: string, modelId: string): void {
  const message = (entry.model ?? [])[0] as { provider?: string; model?: string } | undefined
  assert.ok(message, 'assistant entry should keep model message')
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
  // this file explicit manage all model source, isolated external environment variable.
  savedHelmModel = process.env['HELM_MODEL']
  delete process.env['HELM_MODEL']
})

after(async () => {
  if (savedHelmModel !== undefined) process.env['HELM_MODEL'] = savedHelmModel
  await cleanupDir(root)
})

// ---------------------------------------------------------------------------
// 1. config.json.model separate takes effect (real faux request)
// ---------------------------------------------------------------------------

describe('config.json.model global model', { timeout: 60_000 }, () => {
  it('without options/env when config.model takes effect at root and new conversation, and drive real faux request', { timeout: 60_000 }, async () => {
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
      assert.ok(kernel.__faux.state.callCount >= 1, 'should occur real faux request')
    } finally {
      await kernel.close()
    }
  })

  it('config.model illegal type/format when start explicit config_corrupt', { timeout: 60_000 }, async () => {
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
  it('env override config;options override env+config and after restart align since has conversation', { timeout: 60_000 }, async () => {
    const dir = join(root, 'p2')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ model: 'faux/faux-2' }))
    process.env['HELM_MODEL'] = 'faux/faux-1'
    let k1: RuntimeWithFaux | undefined
    try {
      k1 = await openRuntime(dir, { ids: ['faux-1', 'faux-2'] })
      const conv = await k1.createConversation({})
      assert.equal(conv.model, 'faux/faux-1', 'HELM_MODEL should takes precedence at config.json.model')
      k1.__faux.setResponses([fauxAssistantMessage('env answer')])
      await k1.submitInput(conv.id, 'question')
      await k1.waitForIdle(conv.id)
      assertRequestModel(await lastAssistantEntry(k1, conv.id), 'faux', 'faux-1')
      await k1.close()
      k1 = undefined

      // options.model most high takes precedence: environment still points to faux-1, after restart should use explicit faux-2.
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
// 3. Profile and conversation override priority, empty model inherit
// ---------------------------------------------------------------------------

describe('Profile.model and conversation override', { timeout: 60_000 }, () => {
  it('Profile takes precedence at global;override takes precedence at Profile; clear after back chain; empty model inherit global', { timeout: 60_000 }, async () => {
    const dir = join(root, 'p3')
    writeProfile(dir, 'worker', { name: 'W', model: 'faux/faux-2' })
    writeProfile(dir, 'empty', { name: 'E', model: '' })
    const kernel = await openRuntime(dir, { model: 'faux/faux-1', ids: ['faux-1', 'faux-2'] })
    try {
      const conv = await kernel.createConversation({ profileId: 'worker' })
      assert.equal(conv.model, 'faux/faux-2', 'Profile.model should takes precedence at global')
      kernel.__faux.setResponses([fauxAssistantMessage('profile model answer')])
      await kernel.submitInput(conv.id, 'question')
      await kernel.waitForIdle(conv.id)
      assertRequestModel(await lastAssistantEntry(kernel, conv.id), 'faux', 'faux-2')

      const overridden = await kernel.updateConversation(conv.id, { model: 'faux/faux-1' })
      assert.equal(overridden.model, 'faux/faux-1', 'conversation override should takes precedence at Profile')
      const cleared = await kernel.updateConversation(conv.id, { model: '' })
      assert.equal(cleared.model, 'faux/faux-2', 'clear override after fall back Profile.model')

      const inherited = await kernel.createConversation({ profileId: 'empty' })
      assert.equal(inherited.model, 'faux/faux-1', 'Profile.model empty string treated as not config, inherit global')
    } finally {
      await kernel.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. assistant  Profile takes precedence and restart
// ---------------------------------------------------------------------------

describe('assistant  Profile model', { timeout: 60_000 }, () => {
  it(' #1 use assistant Profile.model(takes precedence at global); without global after restart keep and can commit', { timeout: 60_000 }, async () => {
    const dir = join(root, 'p4')
    writeProfile(dir, 'assistant', { name: 'assist', model: 'faux/faux-2' })
    const k1 = await openRuntime(dir, { model: 'faux/faux-1', ids: ['faux-1', 'faux-2'] })
    try {
      assert.equal(k1.getConversation(1).model, 'faux/faux-2', 'conversation should take assistant Profile model')
      k1.__faux.setResponses([fauxAssistantMessage('conversation answer')])
      await k1.submitInput(1, 'question')
      await k1.waitForIdle(1)
      assertRequestModel(await lastAssistantEntry(k1, 1), 'faux', 'faux-2')
      await k1.close()

      // restart and do not provide any global source:root still is assistant Profile model (SDK config durable).
      const k2 = await openRuntime(dir, { ids: ['faux-1', 'faux-2'] })
      try {
        assert.equal(k2.getConversation(1).model, 'faux/faux-2')
        k2.__faux.setResponses([fauxAssistantMessage('after restart answer')])
        await k2.submitInput(1, 'again question')
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
// 5. create explicit profileId: missing reject, create real Profile after bind set
// ---------------------------------------------------------------------------

describe('create explicit profileId validate', { timeout: 60_000 }, () => {
  it('explicit default missing when reject; create real default after by original ID bind set', { timeout: 60_000 }, async () => {
    const dir = join(root, 'p5')
    const kernel = await openRuntime(dir)
    try {
      assert.equal((await kernel.createConversation()).profileId, 'assistant', 'only default when choose assistant')
      await assert.rejects(
        () => kernel.createConversation({ profileId: 'default' }),
        isHelm('validation_error'),
      )
      writeProfile(dir, 'default', { name: 'D', model: 'faux/faux-1' })
      const conv = await kernel.createConversation({ profileId: 'default' })
      assert.equal(conv.profileId, 'default')
      assert.equal(conv.model, 'faux/faux-1')
      // model reference format boundary same explicit reject.
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
// 6. Profile corrupt / by delete: explicit error and faux do not by invoke
// ---------------------------------------------------------------------------

describe('Profile corrupt and missing explicit error', { timeout: 60_000 }, () => {
  it('JSON corrupt -> profile_read_failed; delete -> profile_not_found / validation_error;faux zero invoke', { timeout: 60_000 }, async () => {
    const dir = join(root, 'p6')
    writeProfile(dir, 'worker', { name: 'W', model: 'faux/faux-1' })
    const kernel = await openRuntime(dir)
    try {
      const conv = await kernel.createConversation({ profileId: 'worker' })
      assert.equal(conv.model, 'faux/faux-1')

      // corrupt JSON: read path unify explicit on throw (do not swallow wrong, not silently when not config).
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
      await assert.rejects(() => kernel.submitInput(conv.id, 'issue'), isHelm('profile_read_failed'))
      assert.equal(kernel.__faux.state.callCount, 0, 'Profile corrupt when must not start model request')

      // since has conversation Profile by delete: even if conversation already has takes effect model also want seek real Profile store in.
      await cleanupDir(join(dir, 'profiles', 'worker'))
      await assert.rejects(
        () => kernel.submitInput(conv.id, 'issue'),
        (err: unknown) =>
          err instanceof HelmError &&
          err.code === 'profile_not_found' &&
          (err.details as { profileId?: string })?.profileId === 'worker',
      )
      await assert.rejects(() => kernel.updateConversation(conv.id, { title: 'y' }), isHelm('profile_not_found'))
      await assert.rejects(() => kernel.createConversation({ profileId: 'worker' }), isHelm('validation_error'))
      assert.equal(kernel.__faux.state.callCount, 0, 'Profile missing when must not start model request')
    } finally {
      await kernel.close()
    }
  })
})
