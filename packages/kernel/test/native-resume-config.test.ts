/**
 * original generate spawn resume config baseline regression (real KernelRuntime + real SDK persist + faux request).
 *
 * main proxy locate real defect:resume when childCwd each time from request/profile/Hub heavy compute,
 * onResolved mention before back report,model/effort compute after never real configure, not to agentType
 * when back by default assistant while non- atomic conversation Profile.
 *
 * override:
 * - T1 first tune self define cwd again resume without cwd:onResolved/Gate/SDK actual cwd three consistent
 *   (SDK cwd via sub-conversation inside real bash pwd tool invoke take verify;Gate via real shell);
 * - T2 resume explicit cwd/model/effort: real enter SDK(faux work vendor one by one request record
 *   modelId and reasoning), mirror/override update, identity field (title/tags/createdAt/
 *   parent) keep, after restart mirror and SDK cwd consistent;
 * - T3 atomic conversation Profile inherit:resume default do not stealthily stealthily swap assistant(mirror profileId
 *   and takes effect model keep),cwd still is atomic conversation cwd;
 * - T4 across parent resume reject and sub-conversation config zero change (without SDK configure, without faux invoke).
 *
 * honest discipline: all away real KernelRuntime.spawnAgent(real pi-durable SDK + SQLite
 * persist), model output from faux script (work vendor record real request parameter),SDK cwd use sub-conversation inside
 * bash tool real execute take verify; never mock complete.
 */

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { HelmError } from '@helm/protocol'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KernelRuntime } from '../src/runtime/index.js'
import { cleanupDir, makeFauxModels, makeTempDir } from './helpers.js'

/** each time real model request take verify record (faux work vendor 2/4 parameter). */
interface RequestRecord {
  modelId: string
  reasoning?: string
}

interface TestEnv {
  kernel: KernelRuntime
  faux: ReturnType<typeof makeFauxModels>['faux']
  requests: RequestRecord[]
  dataDir: string
  close(): Promise<void>
}

/**
 * real KernelRuntime + double model faux directory (faux-1/faux-2). response queue items can is
 * message or work vendor: work vendor signature (context, options, state, model), record model.id and
 * options.reasoning(SDK thinkingLevel real mapping artifact).
 */
async function openEnv(dataDir: string): Promise<TestEnv> {
  const { models, faux } = makeFauxModels({
    models: [
      { id: 'faux-1', name: 'faux-1' },
      { id: 'faux-2', name: 'faux-2' },
    ],
  })
  const requests: RequestRecord[] = []
  const kernel = await KernelRuntime.open({
    dataDir,
    cwd: dataDir,
    model: 'faux/faux-1',
    models: models as never,
  })
  return {
    kernel,
    faux,
    requests,
    dataDir,
    async close() {
      await kernel.close()
    },
  }
}

/** wrap faux response: work vendor record this time real request modelId/reasoning after return pre- placement message. */
function record(env: TestEnv, message: AssistantMessage) {
  return (_ctx: unknown, options: { reasoning?: string } | undefined, _state: unknown, model: { id: string }) => {
    env.requests.push({ modelId: model.id, reasoning: options?.reasoning })
    return message
  }
}

/** sub-conversation inside real bash pwd take verify (SDK actual cwd fact source, non- mirror). */
function pwdToolCall() {
  return fauxAssistantMessage([fauxToolCall('bash', { command: 'pwd' })], { stopReason: 'toolUse' })
}

let rootDir: string

before(async () => {
  rootDir = await makeTempDir('helm-native-resume-')
})

after(async () => {
  await cleanupDir(rootDir)
})

/** write real Profile file (ProfileService read profiles/<id>/profile.json). */
function writeProfile(dataDir: string, id: string, fields: Record<string, unknown>): void {
  const dir = join(dataDir, 'profiles', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ id, ...fields }, null, 2))
}

// ---------------------------------------------------------------------------
// T1: first tune self define cwd + resume without cwd - - onResolved/Gate/SDK cwd three consistent
// ---------------------------------------------------------------------------

describe('resume config baseline: atomic conversation cwd', { timeout: 60_000 }, () => {
  it('T1 first tune self define cwd again resume without cwd:onResolved/Gate/SDK actual cwd consistent (do not back Hub directory)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't1')
    const childDir = join(dir, 'child-work')
    mkdirSync(childDir, { recursive: true })
    const env = await openEnv(dir)
    try {
      // first tune: explicit non- Hub cwd; sub-conversation answer pure text.
      env.faux.setResponses([record(env, fauxAssistantMessage('one segment complete'))])
      let childId = 0
      const first = await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'one segment',
        cwd: childDir,
        onResolved: (info) => {
          childId = info.conversationId ?? 0
        },
      })
      assert.equal(first, 'one segment complete')
      assert.ok(childId > 0, 'should derive sub-conversation')
      assert.equal(env.kernel.getConversation(childId).cwd, childDir, 'first tune mirror cwd')

      // resume: do not carries cwd - - onResolved and Gate must still in atomic conversation cwd.
      const resolved: string[] = []
      env.faux.setResponses([record(env, pwdToolCall()), record(env, fauxAssistantMessage('resume complete'))])
      const second = await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'resume (bash pwd take verify)',
        resume: String(childId),
        gate: `[ "$(pwd)" = "${childDir}" ]`,
        onResolved: (info) => {
          resolved.push(info.effectiveCwd ?? '')
        },
      })
      assert.equal(second, 'resume complete')
      // onResolved back report atomic conversation actual cwd(defect under will back Hub data directory).
      assert.equal(resolved[0], childDir, `onResolved effectiveCwd should be ${childDir}, got ${resolved[0]}`)
      // Gate in atomic conversation cwd real execute via (defect under pwd != childDir,gate_failed will throw, test in this failed).
      // SDK actual cwd: sub-conversation inside bash pwd output (bash tool use agent.cwd).
      const detail = await env.kernel.getConversationDetail(childId, { limit: 50 })
      const bashEntry = [...detail.entries]
        .reverse()
        .find((e) => e.kind === 'pi.tool-result' && JSON.stringify(e.model ?? '').includes('bash'))
      assert.ok(bashEntry, 'sub-conversation should has bash tool result (pwd take verify)')
      const bashText = JSON.stringify(bashEntry.model ?? '')
      assert.ok(
        bashText.includes(childDir.replace(/\/$/, '')),
        `bash pwd should output atomic conversation cwd:${bashText.slice(0, 300)}`,
      )
      // mirror cwd do not change.
      assert.equal(env.kernel.getConversation(childId).cwd, childDir)
    } finally {
      await env.close()
    }
  })

  it('T3 atomic conversation Profile inherit:resume default do not stealthily stealthily swap assistant, model/cwd keep', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't3')
    const researchDir = join(dir, 'research-work')
    mkdirSync(researchDir, { recursive: true })
    writeProfile(dir, 'research', { name: 'research', model: 'faux/faux-2' })
    const env = await openEnv(dir)
    try {
      // first tune:research Profile(model faux-2), explicit cwd.
      env.faux.setResponses([record(env, fauxAssistantMessage('research first tune'))])
      let childId = 0
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'research first tune',
        agentType: 'research',
        cwd: researchDir,
        onResolved: (info) => {
          childId = info.conversationId ?? 0
        },
      })
      const firstSummary = env.kernel.getConversation(childId)
      assert.equal(firstSummary.profileId, 'research')
      assert.equal(firstSummary.model, 'faux/faux-2', 'Profile model inherit')
      assert.equal(env.requests[0]!.modelId, 'faux-2', 'first tune real request use faux-2')

      // resume: does not give agentType - - atomic conversation Profile keep research, model keep
      // faux-2(defect under by by default assistant parse),cwd do not back Hub directory.
      const resolved: string[] = []
      env.faux.setResponses([record(env, fauxAssistantMessage('research resume'))])
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'research resume',
        resume: String(childId),
        onResolved: (info) => {
          resolved.push(info.effectiveCwd ?? '')
        },
      })
      const after = env.kernel.getConversation(childId)
      assert.equal(after.profileId, 'research', 'resume default must not stealthily stealthily swap assistant')
      assert.equal(after.model, 'faux/faux-2', 'resume default keep atomic conversation takes effect model')
      assert.equal(env.requests[1]!.modelId, 'faux-2', 'resume real request still use faux-2')
      assert.equal(resolved[0], researchDir, 'onResolved use atomic conversation cwd')
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// T2:resume explicit cwd/model/effort real enter SDK + mirror + restart consistent
// ---------------------------------------------------------------------------

describe('resume explicit config change', { timeout: 60_000 }, () => {
  it('T2 resume explicit cwd/model/effort: real configure(faux request take verify)+ mirror + identity keep + restart consistent', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't2')
    const firstDir = join(dir, 'first')
    const movedDir = join(dir, 'moved')
    mkdirSync(firstDir, { recursive: true })
    mkdirSync(movedDir, { recursive: true })
    writeProfile(dir, 'research', { name: 'research', model: 'faux/faux-2' })
    const env = await openEnv(dir)
    let childId = 0
    let identityBefore: { title: string; tags: string[]; createdAt: number; parentConversationId?: number } | undefined
    try {
      // first tune: by default assistant(faux-1), explicit firstDir. work vendor record first tune request.
      env.faux.setResponses([record(env, fauxAssistantMessage('first tune'))])
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'first tune',
        cwd: firstDir,
        onResolved: (info) => {
          childId = info.conversationId ?? 0
        },
      })
      assert.equal(env.requests[0]!.modelId, 'faux-1')
      identityBefore = (({ title, tags, createdAt, parentConversationId }) => ({ title, tags, createdAt, parentConversationId }))(
        env.kernel.getConversation(childId),
      )

      // resume: explicit cwd/model/effort - - three must real takes effect.
      env.faux.setResponses([
        record(env, pwdToolCall()),
        record(env, fauxAssistantMessage('resume complete')),
      ])
      const second = await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'resume (explicit config)',
        resume: String(childId),
        cwd: movedDir,
        model: 'faux/faux-2',
        effort: 'high',
      })
      assert.equal(second, 'resume complete')
      // SDK real request: model already cut faux-2,thinkingLevel high already mapping reasoning.
      assert.equal(env.requests[1]!.modelId, 'faux-2', 'resume explicit model must real enter SDK request')
      assert.equal(env.requests[1]!.reasoning, 'high', 'resume explicit effort must real enter SDK request')
      assert.equal(env.requests[2]!.modelId, 'faux-2')
      // SDK actual cwd already cut movedDir(bash pwd take verify).
      const detail = await env.kernel.getConversationDetail(childId, { limit: 50 })
      const bashEntry = [...detail.entries]
        .reverse()
        .find((e) => e.kind === 'pi.tool-result' && JSON.stringify(e.model ?? '').includes('bash'))
      assert.ok(bashEntry, 'should has bash pwd take verify')
      assert.ok(
        JSON.stringify(bashEntry.model ?? '').includes(movedDir),
        `bash pwd should output new cwd:${JSON.stringify(bashEntry.model ?? '').slice(0, 300)}`,
      )
      // mirror:cwd/model update, identity field keep.
      const after = env.kernel.getConversation(childId)
      assert.equal(after.cwd, movedDir)
      assert.equal(after.model, 'faux/faux-2')
      assert.equal(after.title, identityBefore!.title, 'title keep')
      assert.deepEqual(after.tags, identityBefore!.tags, 'tags keep')
      assert.equal(after.createdAt, identityBefore!.createdAt, 'createdAt keep')
      assert.equal(after.parentConversationId, 1, 'parent keep')
    } finally {
      await env.close()
    }

    // restart consistency: same dataDir heavy open, mirror and SDK cwd all keep (SDK configure persisted).
    const env2 = await openEnv(dir)
    try {
      const after = env2.kernel.getConversation(childId)
      assert.equal(after.cwd, movedDir, 'after restart mirror cwd consistent')
      assert.equal(after.model, 'faux/faux-2', 'after restart mirror model consistent')
      assert.equal(after.profileId, 'assistant')
      // SDK persist take verify: after restart again resume one round,bash pwd still output movedDir.
      env2.faux.setResponses([record(env2, pwdToolCall()), record(env2, fauxAssistantMessage('after restart resume'))])
      await env2.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'after restart resume',
        resume: String(childId),
      })
      const detail = await env2.kernel.getConversationDetail(childId, { limit: 50 })
      const bashEntry = [...detail.entries]
        .reverse()
        .find((e) => e.kind === 'pi.tool-result' && JSON.stringify(e.model ?? '').includes('bash'))
      assert.ok(bashEntry, 'after restart should has bash pwd take verify')
      assert.ok(
        JSON.stringify(bashEntry.model ?? '').includes(movedDir),
        'after restart SDK cwd keep (configure persist)',
      )
    } finally {
      await env2.close()
    }
  })
})

// ---------------------------------------------------------------------------
// T4: across parent resume reject and config zero change
// ---------------------------------------------------------------------------

describe('across parent protect', { timeout: 60_000 }, () => {
  it('T4 across parent resume reject:not_found and sub-conversation config zero change, without SDK request', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't4')
    const childDir = join(dir, 'child')
    mkdirSync(childDir, { recursive: true })
    const env = await openEnv(dir)
    try {
      env.faux.setResponses([fauxAssistantMessage('first tune')])
      let childId = 0
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'first tune',
        cwd: childDir,
        onResolved: (info) => {
          childId = info.conversationId ?? 0
        },
      })
      const before = env.kernel.getConversation(childId)
      const callsBefore = env.faux.state.callCount

      await assert.rejects(
        () =>
          env.kernel.spawnAgent({
            parentConversationId: 999,
            prompt: 'hijack',
            resume: String(childId),
            cwd: '/tmp/hijack',
            model: 'faux/faux-2',
          }),
        (err: unknown) => err instanceof HelmError && err.code === 'not_found',
      )
      const after = env.kernel.getConversation(childId)
      assert.equal(after.cwd, childDir, 'reject path must not change write cwd')
      assert.equal(after.model, before.model, 'reject path must not change write model')
      assert.equal(after.profileId, before.profileId)
      assert.equal(after.stateChangeSeq, before.stateChangeSeq, 'reject path must not push enter stateChangeSeq')
      assert.equal(env.faux.state.callCount, callsBefore, 'reject path must not start any SDK model request')
    } finally {
      await env.close()
    }
  })
})
