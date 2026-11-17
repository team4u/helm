/**
 * Baseline regression tests for native spawn resume config (real KernelRuntime + real SDK persistence + faux requests).
 *
 * Pinpoints original bugs: childCwd was recomputed from request/profile/Hub on resume, onResolved reported
 * prematurely, computed model/effort were never applied at runtime, and omitting agentType fell back to
 * default assistant instead of preserving the original conversation's Profile.
 *
 * Coverage:
 * - T1 custom cwd on initial spawn followed by resume without cwd: onResolved, Gate, and actual SDK cwd
 *   all agree (SDK cwd verified via real `bash pwd` tool call inside sub-conversation; Gate via real shell);
 * - T2 resume with explicit cwd/model/effort: applied to real SDK (faux factory records modelId and
 *   reasoning per request), updates mirror/overrides while keeping identity fields (title/tags/createdAt/
 *   parent), and remains consistent between mirror and SDK cwd across restarts;
 * - T3 original conversation Profile inheritance: resuming without agentType never silently swaps back to
 *   assistant (mirror profileId and effective model persist), and cwd stays at the original conversation cwd;
 * - T4 cross-parent resume rejects cleanly with zero sub-conversation config mutation (no SDK config change,
 *   no faux call).
 *
 * Honesty discipline: everything exercises real KernelRuntime.spawnAgent (real pi-durable SDK + SQLite
 * persistence); model output comes from faux scripts (factory captures real request parameters) and SDK cwd
 * is verified via real bash tool execution in the sub-conversation; zero mocked completion.
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

/** Captures per-request model parameters observed in faux factory args 2 and 4. */
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
 * Real KernelRuntime + dual-model faux registry (faux-1/faux-2). Response items may be messages or
 * factories with signature (context, options, state, model), capturing model.id and options.reasoning
 * (real SDK mapping output for thinkingLevel).
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

/** Wraps a faux response so the factory records actual modelId/reasoning before returning the canned message. */
function record(env: TestEnv, message: AssistantMessage) {
  return (_ctx: unknown, options: { reasoning?: string } | undefined, _state: unknown, model: { id: string }) => {
    env.requests.push({ modelId: model.id, reasoning: options?.reasoning })
    return message
  }
}

/** Triggers a real bash pwd tool call inside the sub-conversation (source of truth for SDK cwd, not mirror). */
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

/** Writes a real Profile file (ProfileService reads profiles/<id>/profile.json). */
function writeProfile(dataDir: string, id: string, fields: Record<string, unknown>): void {
  const dir = join(dataDir, 'profiles', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ id, ...fields }, null, 2))
}

// ---------------------------------------------------------------------------
// T1: custom cwd on initial spawn + resume without cwd -- onResolved/Gate/SDK cwd align
// ---------------------------------------------------------------------------

describe('resume config baseline: original conversation cwd', { timeout: 60_000 }, () => {
  it('T1 custom cwd on initial spawn then resume without cwd: onResolved/Gate/SDK actual cwd all match (no fallback to Hub dir)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't1')
    const childDir = join(dir, 'child-work')
    mkdirSync(childDir, { recursive: true })
    const env = await openEnv(dir)
    try {
      // Initial call: explicit non-Hub cwd; sub-conversation replies with plain text.
      env.faux.setResponses([record(env, fauxAssistantMessage('phase one complete'))])
      let childId = 0
      const first = await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'phase one',
        cwd: childDir,
        onResolved: (info) => {
          childId = info.conversationId ?? 0
        },
      })
      assert.equal(first, 'phase one complete')
      assert.ok(childId > 0, 'should spawn sub-conversation')
      assert.equal(env.kernel.getConversation(childId).cwd, childDir, 'initial spawn mirror cwd')

      // Resume omitting cwd -- onResolved and Gate must remain at the original conversation cwd.
      const resolved: string[] = []
      env.faux.setResponses([record(env, pwdToolCall()), record(env, fauxAssistantMessage('resume complete'))])
      const second = await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'resume (verify via bash pwd)',
        resume: String(childId),
        gate: `[ "$(pwd)" = "${childDir}" ]`,
        onResolved: (info) => {
          resolved.push(info.effectiveCwd ?? '')
        },
      })
      assert.equal(second, 'resume complete')
      // onResolved reports original conversation's actual cwd (buggy version fell back to Hub data dir).
      assert.equal(resolved[0], childDir, `onResolved effectiveCwd should be ${childDir}, got ${resolved[0]}`)
      // Gate executes inside the original conversation cwd (buggy pwd != childDir would throw gate_failed).
      // Actual SDK cwd: inspect bash pwd output inside sub-conversation (bash tool uses agent.cwd).
      const detail = await env.kernel.getConversationDetail(childId, { limit: 50 })
      const bashEntry = [...detail.entries]
        .reverse()
        .find((e) => e.kind === 'pi.tool-result' && JSON.stringify(e.model ?? '').includes('bash'))
      assert.ok(bashEntry, 'sub-conversation should have a bash tool result (pwd check)')
      const bashText = JSON.stringify(bashEntry.model ?? '')
      assert.ok(
        bashText.includes(childDir.replace(/\/$/, '')),
        `bash pwd must output original conversation cwd: ${bashText.slice(0, 300)}`,
      )
      // Mirror cwd remains unchanged.
      assert.equal(env.kernel.getConversation(childId).cwd, childDir)
    } finally {
      await env.close()
    }
  })

  it('T3 original conversation Profile inheritance: resume preserves Profile instead of defaulting to assistant, keeping model/cwd', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't3')
    const researchDir = join(dir, 'research-work')
    mkdirSync(researchDir, { recursive: true })
    writeProfile(dir, 'research', { name: 'research', model: 'faux/faux-2' })
    const env = await openEnv(dir)
    try {
      // Initial call: research Profile (model faux-2), explicit cwd.
      env.faux.setResponses([record(env, fauxAssistantMessage('research initial spawn'))])
      let childId = 0
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'research initial spawn',
        agentType: 'research',
        cwd: researchDir,
        onResolved: (info) => {
          childId = info.conversationId ?? 0
        },
      })
      const firstSummary = env.kernel.getConversation(childId)
      assert.equal(firstSummary.profileId, 'research')
      assert.equal(firstSummary.model, 'faux/faux-2', 'inherits Profile model')
      assert.equal(env.requests[0]!.modelId, 'faux-2', 'initial request uses faux-2')

      // Resume omitting agentType -- original conversation keeps Profile research and model faux-2
      // (buggy version resolved via default assistant) without resetting cwd to Hub dir.
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
      assert.equal(after.profileId, 'research', 'resume default must not silently revert to assistant')
      assert.equal(after.model, 'faux/faux-2', 'resume default retains effective model of original conversation')
      assert.equal(env.requests[1]!.modelId, 'faux-2', 'resumed SDK request still uses faux-2')
      assert.equal(resolved[0], researchDir, 'onResolved uses original conversation cwd')
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// T2: explicit cwd/model/effort on resume applied to SDK + mirror + across restarts
// ---------------------------------------------------------------------------

describe('resume explicit configuration changes', { timeout: 60_000 }, () => {
  it('T2 resume explicit cwd/model/effort: applied (verified via faux requests) + mirror updated + identity kept + consistent after restart', { timeout: 60_000 }, async () => {
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
      // Initial call: default assistant (faux-1), explicit firstDir. Factory records initial request.
      env.faux.setResponses([record(env, fauxAssistantMessage('initial spawn'))])
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'initial spawn',
        cwd: firstDir,
        onResolved: (info) => {
          childId = info.conversationId ?? 0
        },
      })
      assert.equal(env.requests[0]!.modelId, 'faux-1')
      identityBefore = (({ title, tags, createdAt, parentConversationId }) => ({ title, tags, createdAt, parentConversationId }))(
        env.kernel.getConversation(childId),
      )

      // Resume with explicit cwd/model/effort -- all three must genuinely take effect.
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
      // Real SDK request: model switched to faux-2, thinkingLevel=high mapped to reasoning.
      assert.equal(env.requests[1]!.modelId, 'faux-2', 'explicit resume model must reach SDK request')
      assert.equal(env.requests[1]!.reasoning, 'high', 'explicit resume effort must reach SDK request')
      assert.equal(env.requests[2]!.modelId, 'faux-2')
      // Real SDK cwd switched to movedDir (verified via bash pwd).
      const detail = await env.kernel.getConversationDetail(childId, { limit: 50 })
      const bashEntry = [...detail.entries]
        .reverse()
        .find((e) => e.kind === 'pi.tool-result' && JSON.stringify(e.model ?? '').includes('bash'))
      assert.ok(bashEntry, 'should have bash pwd tool check')
      assert.ok(
        JSON.stringify(bashEntry.model ?? '').includes(movedDir),
        `bash pwd must output new cwd: ${JSON.stringify(bashEntry.model ?? '').slice(0, 300)}`,
      )
      // Mirror: cwd/model updated while identity fields preserved.
      const after = env.kernel.getConversation(childId)
      assert.equal(after.cwd, movedDir)
      assert.equal(after.model, 'faux/faux-2')
      assert.equal(after.title, identityBefore!.title, 'title preserved')
      assert.deepEqual(after.tags, identityBefore!.tags, 'tags preserved')
      assert.equal(after.createdAt, identityBefore!.createdAt, 'createdAt preserved')
      assert.equal(after.parentConversationId, 1, 'parent preserved')
    } finally {
      await env.close()
    }

    // Restart consistency: reopening same dataDir keeps mirror and SDK cwd aligned (SDK config persisted).
    const env2 = await openEnv(dir)
    try {
      const after = env2.kernel.getConversation(childId)
      assert.equal(after.cwd, movedDir, 'mirror cwd persists across restart')
      assert.equal(after.model, 'faux/faux-2', 'mirror model persists across restart')
      assert.equal(after.profileId, 'assistant')
      // SDK persistence check: resuming after restart still outputs movedDir from bash pwd.
      env2.faux.setResponses([record(env2, pwdToolCall()), record(env2, fauxAssistantMessage('post-restart resume'))])
      await env2.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'post-restart resume',
        resume: String(childId),
      })
      const detail = await env2.kernel.getConversationDetail(childId, { limit: 50 })
      const bashEntry = [...detail.entries]
        .reverse()
        .find((e) => e.kind === 'pi.tool-result' && JSON.stringify(e.model ?? '').includes('bash'))
      assert.ok(bashEntry, 'post-restart bash pwd check should exist')
      assert.ok(
        JSON.stringify(bashEntry.model ?? '').includes(movedDir),
        'SDK cwd persists across restart',
      )
    } finally {
      await env2.close()
    }
  })
})

// ---------------------------------------------------------------------------
// T4: cross-parent resume rejection with zero config mutation
// ---------------------------------------------------------------------------

describe('cross-parent guard', { timeout: 60_000 }, () => {
  it('T4 cross-parent resume rejects with not_found, leaves sub-conversation config untouched, and makes zero SDK requests', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't4')
    const childDir = join(dir, 'child')
    mkdirSync(childDir, { recursive: true })
    const env = await openEnv(dir)
    try {
      env.faux.setResponses([fauxAssistantMessage('initial spawn')])
      let childId = 0
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'initial spawn',
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
      assert.equal(after.cwd, childDir, 'rejected path must not overwrite cwd')
      assert.equal(after.model, before.model, 'rejected path must not overwrite model')
      assert.equal(after.profileId, before.profileId)
      assert.equal(after.stateChangeSeq, before.stateChangeSeq, 'rejected path must not advance stateChangeSeq')
      assert.equal(env.faux.state.callCount, callsBefore, 'rejected path must not invoke any SDK model request')
    } finally {
      await env.close()
    }
  })
})
