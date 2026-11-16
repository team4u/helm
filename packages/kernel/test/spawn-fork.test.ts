/**
 * subagent context fork contract and end-to-end test:
 * - selectCleanForkAnchorEntryId pure function boundary (empty history, only system,reset without/has handoff,
 *   many round complete, parallel part toolCall suspended truncate, illegal ID reject);
 * - KernelRuntime.spawnAgent({ fork: true }) real SDK + faux provider collection into:
 *   1. mid-turn fork and parallel double fork inherit parent completed context, without not closed together toolCall or missing_result;
 *   2. same Profile and across Profile  model / effort / cwd inherit priority and explicit override;
 *   3. structure output extend by subagent explicit declaration isolated (parent has schema while sub- without schema when strip);
 *   4. SecretStash secret do not follow fork leak to subagent history or environment variable;
 *   5. disable model (409 model_disabled), empty parent history (409 fork_empty_history),
 *      fork+resume(400 validation_error),herdr:* and profile.runtime(400 unsupported_runtime)
 *      all in agent_spawn hook before pre- reject.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai/providers/faux'
import { createNodeDaemon } from '@helm/node'
import { type HelmHostApi } from '@helm/protocol'
import { startHub } from '../src/http/index.js'
import { KernelRuntime } from '../src/runtime/index.js'
import { selectCleanForkAnchorEntryId } from '../src/runtime/spawn-fork.js'
import { assertRejectsCode, makeFauxModels } from './helpers.js'

let savedHelmModel: string | undefined
let tmpRoot: string

before(() => {
  savedHelmModel = process.env['HELM_MODEL']
  delete process.env['HELM_MODEL']
  tmpRoot = mkdtempSync(join(tmpdir(), 'helm-spawn-fork-'))
})

after(() => {
  if (savedHelmModel === undefined) delete process.env['HELM_MODEL']
  else process.env['HELM_MODEL'] = savedHelmModel
  rmSync(tmpRoot, { recursive: true, force: true })
})

function assertNoDanglingToolCalls(
  messages: ReadonlyArray<{ role?: string; content?: unknown; toolCallId?: string }>,
): void {
  const callIds = new Set<string>()
  const resolvedIds = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'toolCall') {
          const id = (block as { id?: unknown }).id
          if (typeof id === 'string') callIds.add(id)
        }
      }
    } else if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      resolvedIds.add(message.toolCallId)
    }
  }
  for (const id of callIds) {
    assert.ok(resolvedIds.has(id), `fork context in must not store in not closed together toolCall(${id})`)
  }
}

function userMessageTexts(
  messages: ReadonlyArray<{ role?: string; content?: unknown }>,
): string[] {
  const texts: string[] = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    if (typeof message.content === 'string') {
      texts.push(message.content)
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
          texts.push((block as { text: string }).text)
        }
      }
    }
  }
  return texts
}

describe('selectCleanForkAnchorEntryId pure function boundary', { timeout: 60_000 }, () => {
  it('empty history and only contains system message all return undefined', { timeout: 60_000 }, () => {
    assert.equal(selectCleanForkAnchorEntryId({ entries: [], contributions: [] }), undefined)
    assert.equal(
      selectCleanForkAnchorEntryId({
        entries: [{ id: 1 }, { id: 2 }],
        contributions: [[{ role: 'system' }], [{ role: 'system' }]],
      }),
      undefined,
    )
  })

  it('reset without handover return undefined;reset contains user handoff return handover entryId', { timeout: 60_000 }, () => {
    assert.equal(
      selectCleanForkAnchorEntryId({
        entries: [{ id: 5 }],
        contributions: [[]],
      }),
      undefined,
    )
    assert.equal(
      selectCleanForkAnchorEntryId({
        entries: [{ id: 5 }, { id: 6 }],
        contributions: [[], [{ role: 'user', content: 'handover summary' }]],
      }),
      6,
    )
  })

  it('complete many round conversation return tail entryId; already exclude aborted after still by valid anchor return', { timeout: 60_000 }, () => {
    assert.equal(
      selectCleanForkAnchorEntryId({
        entries: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }],
        contributions: [
          [{ role: 'user', content: 'hi' }],
          [{ role: 'assistant', content: [{ type: 'toolCall', id: 'tc-1' }] }],
          [{ role: 'toolResult', toolCallId: 'tc-1' }],
          [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
        ],
      }),
      4,
    )
    // SDK exclude aborted item after, tail can security truncate to on a completed user item
    assert.equal(
      selectCleanForkAnchorEntryId({
        entries: [{ id: 10 }, { id: 11 }],
        contributions: [[{ role: 'user', content: 'committed' }], []],
      }),
      11,
    )
  })

  it('parallel toolCall part complete and still has suspended when fall back to not closed ring assistant before', { timeout: 60_000 }, () => {
    const view = {
      entries: [{ id: 1 }, { id: 2 }, { id: 3 }],
      contributions: [
        [{ role: 'user', content: 'start' }],
        [
          {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'tc-done' },
              { type: 'toolCall', id: 'tc-pending' },
            ],
          },
        ],
        [{ role: 'toolResult', toolCallId: 'tc-done' }],
      ],
    }
    assert.equal(selectCleanForkAnchorEntryId(view), 1)

    // all toolCall all has for should toolResult when return finally item
    const settled = {
      entries: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      contributions: [
        ...view.contributions,
        [{ role: 'toolResult', toolCallId: 'tc-pending' }],
      ],
    }
    assert.equal(selectCleanForkAnchorEntryId(settled), 4)
  })

  it('the same contributions[i] inside contains [assistant(toolCall), toolResult] when correct identify already closed ring and not closed ring', { timeout: 60_000 }, () => {
    // the same item inside complete closed together:[assistant(tc-1), toolResult(tc-1)] should keep when before item
    assert.equal(
      selectCleanForkAnchorEntryId({
        entries: [{ id: 1 }, { id: 2 }],
        contributions: [
          [{ role: 'user', content: 'start' }],
          [
            { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-1' }] },
            { role: 'toolResult', toolCallId: 'tc-1' },
          ],
        ],
      }),
      2,
    )

    // the same item inside only part closed together: should whole truncate and fall back to before a completed item
    assert.equal(
      selectCleanForkAnchorEntryId({
        entries: [{ id: 1 }, { id: 2 }],
        contributions: [
          [{ role: 'user', content: 'start' }],
          [
            {
              role: 'assistant',
              content: [
                { type: 'toolCall', id: 'tc-1' },
                { type: 'toolCall', id: 'tc-2' },
              ],
            },
            { role: 'toolResult', toolCallId: 'tc-1' },
          ],
        ],
      }),
      1,
    )

    // before a item same item inside already closed ring, under a item again suspended: truncate to before a item
    assert.equal(
      selectCleanForkAnchorEntryId({
        entries: [{ id: 1 }, { id: 2 }, { id: 3 }],
        contributions: [
          [{ role: 'user', content: 'start' }],
          [
            { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-1' }] },
            { role: 'toolResult', toolCallId: 'tc-1' },
          ],
          [{ role: 'assistant', content: [{ type: 'toolCall', id: 'tc-2' }] }],
        ],
      }),
      2,
    )
  })

  it('system message after tight connect not closed ring assistant truncate after without non- system message then return undefined; illegal ID return undefined', { timeout: 60_000 }, () => {
    assert.equal(
      selectCleanForkAnchorEntryId({
        entries: [{ id: 1 }, { id: 2 }],
        contributions: [
          [{ role: 'system' }],
          [{ role: 'assistant', content: [{ type: 'toolCall', id: 'tc-1' }] }],
        ],
      }),
      undefined,
    )
    for (const badId of [0, -1, 1.5, '0', '-2', 'abc']) {
      assert.equal(
        selectCleanForkAnchorEntryId({
          entries: [{ id: badId }],
          contributions: [[{ role: 'user', content: 'ok' }]],
        }),
        undefined,
      )
    }
  })
})

describe('KernelRuntime.spawnAgent({ fork: true }) collection into contract', { timeout: 60_000 }, () => {
  it('mid-turn fork and parallel double fork inherit completed context, without not closed together toolCall or missing_result', { timeout: 60_000 }, async () => {
    const dir = join(tmpRoot, 'mid-turn-parallel')
    const { models, faux } = makeFauxModels({ models: [{ id: 'faux-1', reasoning: true }] })

    const childSnapshots: Array<{ tag: string; messages: unknown[]; users: string[] }> = []
    const step: FauxResponseFactory = (context) => {
      const msgs = context.messages as Array<{ role?: string; content?: unknown; toolCallId?: string }>
      const users = userMessageTexts(msgs)
      const lastMsg = msgs.at(-1)
      if (lastMsg?.role === 'user' && users.at(-1) === 'line index one: ALPHA_SEED') {
        return fauxAssistantMessage('already record ALPHA_SEED')
      }
      if (lastMsg?.role === 'user' && users.at(-1) === 'line index two: BETA_SEED') {
        return fauxAssistantMessage(
          [
            fauxToolCall('fork_spawn', { prompt: 'sub- A core inspect', fork: true }, { id: 'call-child-a' }),
            fauxToolCall('fork_spawn', { prompt: 'sub- B core inspect', fork: true }, { id: 'call-child-b' }),
            fauxToolCall('sibling_noop', {}, { id: 'call-sibling' }),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'user' && (users.at(-1) === 'sub- A core inspect' || users.at(-1) === 'sub- B core inspect')) {
        const tag = users.at(-1)!
        childSnapshots.push({ tag, messages: msgs, users })
        assertNoDanglingToolCalls(msgs)
        assert.ok(!JSON.stringify(msgs).includes('missing_result'), 'must not appear missing_result together into patch')
        assert.ok(users.some((t) => t.includes('ALPHA_SEED')), `${tag} must inherit 1 round line index`)
        assert.ok(users.some((t) => t.includes('BETA_SEED')), `${tag} must inherit when before round user input`)
        return fauxAssistantMessage(`complete:${tag}`)
      }
      if (lastMsg?.role === 'toolResult') {
        return fauxAssistantMessage('parent conversation aggregate done')
      }
      throw new Error(`not pre- phase faux invoke: ${JSON.stringify(msgs)}`)
    }
    faux.setResponses(Array.from({ length: 16 }, () => step))

    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      models,
      model: 'faux/faux-1',
    })
    try {
      await kernel.plugins.register({
        id: 'test:fork-spawner',
        definePlugin(ctx) {
          ctx.tool({
            name: 'fork_spawn',
            description: 'trigger host spawnAgent',
            inputSchema: {
              type: 'object',
              properties: {
                prompt: { type: 'string' },
                fork: { type: 'boolean' },
              },
              required: ['prompt'],
            },
            execute: async (args, context) => {
              const a = args as { prompt: string; fork?: boolean }
              const res = await ctx.host.spawnAgent({
                parentConversationId: context.conversationId!,
                prompt: a.prompt,
                ...(a.fork !== undefined ? { fork: a.fork } : {}),
              })
              return { result: res }
            },
          })
          ctx.tool({
            name: 'sibling_noop',
            description: 'same round brother occupy tool',
            inputSchema: { type: 'object' },
            execute: () => ({ ok: true }),
          })
        },
      }, { enabled: true })

      await kernel.submitInput(1, 'line index one: ALPHA_SEED')
      await kernel.waitForIdle(1)
      await kernel.submitInput(1, 'line index two: BETA_SEED')
      await kernel.waitForIdle(1)

      assert.equal(childSnapshots.length, 2)
      assert.deepEqual(childSnapshots.map((s) => s.tag).sort(), ['sub- A core inspect', 'sub- B core inspect'])
      assert.equal(await kernel.getLastAssistantText(1), 'parent conversation aggregate done')
    } finally {
      await kernel.close()
    }
  })

  it('same Profile and across Profile  model / effort / cwd inherit priority and explicit override', { timeout: 60_000 }, async () => {
    const dir = join(tmpRoot, 'inheritance-priority')
    const profileDir = join(dir, 'profile-cwd')
    const parentDir = join(dir, 'parent-cwd')
    const explicitDir = join(dir, 'explicit-cwd')
    const crossDir = join(dir, 'cross-cwd')

    const { models, faux } = makeFauxModels({
      models: [
        { id: 'faux-default', reasoning: true },
        { id: 'faux-parent', reasoning: true },
        { id: 'faux-profile', reasoning: true },
        { id: 'faux-explicit', reasoning: true },
      ],
    })
    faux.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage('OK')))

    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      models,
      model: 'faux/faux-default',
    })
    try {
      await kernel.services.profiles.save({
        id: 'custom-same',
        name: 'same role',
        model: 'faux/faux-profile',
        thinkingLevel: 'low',
        cwd: profileDir,
      })
      await kernel.services.profiles.save({
        id: 'cross-target',
        name: 'across role target',
        model: 'faux/faux-profile',
        thinkingLevel: 'low',
        cwd: crossDir,
      })
      await kernel.services.profiles.save({
        id: 'bare-target',
        name: 'without override target',
      })

      const parent = await kernel.createConversation({
        profileId: 'custom-same',
        cwd: parentDir,
        model: 'faux/faux-parent',
      })
      await kernel.updateConversation(parent.id, { thinkingLevel: 'high' })
      await kernel.submitInput(parent.id, 'establish parent conversation history')
      await kernel.waitForIdle(parent.id)

      const beforeIds = new Set(kernel.listConversations({ parentConversationId: parent.id }).map((c) => c.id))
      const pickNewChild = () => {
        const added = kernel.listConversations({ parentConversationId: parent.id }).filter((c) => !beforeIds.has(c.id))
        assert.equal(added.length, 1)
        beforeIds.add(added[0]!.id)
        return added[0]!
      }

      // 1. same Profile by default inherit: omit agentType/cwd/model/effort, inherit parent conversation override (optimal at Profile)
      await kernel.spawnAgent({
        parentConversationId: parent.id,
        fork: true,
        prompt: 'sameProfileinherit',
      })
      const sameDefaultChild = pickNewChild()
      assert.equal(sameDefaultChild.profileId, 'custom-same')
      assert.equal(sameDefaultChild.cwd, parentDir)
      assert.equal(sameDefaultChild.model, 'faux/faux-parent')
      assert.equal(sameDefaultChild.thinkingLevel, 'high')
      assert.equal(sameDefaultChild.thinkingLevelOverride, 'high')

      // 2. same Profile explicit override
      await kernel.spawnAgent({
        parentConversationId: parent.id,
        fork: true,
        prompt: 'sameProfileexplicit override',
        model: 'faux/faux-explicit',
        effort: 'medium',
        cwd: explicitDir,
      })
      const sameExplicitChild = pickNewChild()
      assert.equal(sameExplicitChild.profileId, 'custom-same')
      assert.equal(sameExplicitChild.cwd, explicitDir)
      assert.equal(sameExplicitChild.model, 'faux/faux-explicit')
      assert.equal(sameExplicitChild.thinkingLevel, 'medium')
      assert.equal(sameExplicitChild.thinkingLevelOverride, 'medium')

      // 3. across Profile: target Profile field takes precedence at parent conversation
      await kernel.spawnAgent({
        parentConversationId: parent.id,
        agentType: 'cross-target',
        fork: true,
        prompt: 'acrossProfiletakes precedence target',
      })
      const crossTargetChild = pickNewChild()
      assert.equal(crossTargetChild.profileId, 'cross-target')
      assert.equal(crossTargetChild.cwd, crossDir)
      assert.equal(crossTargetChild.model, 'faux/faux-profile')
      assert.equal(crossTargetChild.thinkingLevel, 'low')

      // 4. across Profile and target Profile not config when fall back to parent conversation override
      await kernel.spawnAgent({
        parentConversationId: parent.id,
        agentType: 'bare-target',
        fork: true,
        prompt: 'acrossProfilefall back parent conversation',
      })
      const crossFallbackChild = pickNewChild()
      assert.equal(crossFallbackChild.profileId, 'bare-target')
      assert.equal(crossFallbackChild.cwd, parentDir)
      assert.equal(crossFallbackChild.model, 'faux/faux-parent')
      assert.equal(crossFallbackChild.thinkingLevel, 'high')
    } finally {
      await kernel.close()
    }
  })

  it('structure output isolated,SecretStash do not leak and pre- reject (without hook leak leak)', { timeout: 60_000 }, async () => {
    const dir = join(tmpRoot, 'isolation-and-rejects')
    const { models, faux } = makeFauxModels({
      models: [
        { id: 'faux-1', reasoning: true },
        { id: 'faux-disabled', reasoning: true },
      ],
    })

    let plainForkDeclaredStructuredTool: boolean | undefined
    let plainForkToolRejected: boolean | undefined
    let schemaForkDeclaredStructuredTool: boolean | undefined
    let plainForkMessages: ReadonlyArray<{ role?: string; content?: unknown }> | undefined
    let secretForkMessages: unknown[] | undefined

    const replayActiveTools = (
      messages: ReadonlyArray<{
        role?: string
        toolsAdded?: ReadonlyArray<{ name: string }>
        toolsRemoved?: ReadonlyArray<{ name: string }>
      }>,
    ): Set<string> => {
      const active = new Set<string>()
      for (const m of messages) {
        if (m.role !== 'system') continue
        for (const t of m.toolsAdded ?? []) active.add(t.name)
        for (const t of m.toolsRemoved ?? []) active.delete(t.name)
      }
      return active
    }

    const step: FauxResponseFactory = (context) => {
      const msgs = context.messages as Array<{
        role?: string
        content?: unknown
        toolName?: string
        isError?: boolean
        toolsAdded?: ReadonlyArray<{ name: string }>
        toolsRemoved?: ReadonlyArray<{ name: string }>
      }>
      const users = userMessageTexts(msgs)
      const lastUser = users.at(-1) ?? ''
      const lastMsg = [...msgs].reverse().find((m) => m.role !== 'system')
      const hasStructuredToolDecl = replayActiveTools(msgs).has('register_structured_output')

      if (lastMsg?.role === 'user' && lastUser.includes('withoutschemasubagent')) {
        plainForkDeclaredStructuredTool = hasStructuredToolDecl
        plainForkMessages = msgs
        // actively attempt invoke not registered register_structured_output, double heavy verify run phase tool list also already strip it.
        return fauxAssistantMessage(
          [fauxToolCall('register_structured_output', { output: { leak: true } })],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'toolResult' && lastMsg.toolName === 'register_structured_output' && lastUser.includes('withoutschemasubagent')) {
        plainForkToolRejected = lastMsg.isError === true
        return fauxAssistantMessage('withoutschemaback re-')
      }
      if (lastMsg?.role === 'user' && lastUser.includes('hasschemasubagent')) {
        schemaForkDeclaredStructuredTool = hasStructuredToolDecl
        return fauxAssistantMessage(
          [fauxToolCall('register_structured_output', { output: { tag: 'FORK_OK' } })],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'user' && lastUser.includes('parent proxy carriesschematest')) {
        assert.equal(hasStructuredToolDecl, true)
        return fauxAssistantMessage(
          [
            fauxToolCall('fork_spawn', { prompt: 'withoutschemasubagent' }, { id: 'fc-plain' }),
            fauxToolCall(
              'fork_spawn',
              {
                prompt: 'hasschemasubagent',
                schema: {
                  type: 'object',
                  properties: { tag: { const: 'FORK_OK' } },
                  required: ['tag'],
                  additionalProperties: false,
                },
              },
              { id: 'fc-schema' },
            ),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'toolResult' && lastMsg.toolName === 'register_structured_output') {
        return fauxAssistantMessage('structure wrap-up complete')
      }
      if (lastMsg?.role === 'toolResult' && lastMsg.toolName === 'fork_spawn') {
        return fauxAssistantMessage(
          [fauxToolCall('register_structured_output', { output: { ok: true } })],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'user' && lastUser.includes('check secret is otherwise leak')) {
        secretForkMessages = msgs
        return fauxAssistantMessage('without secret')
      }
      return fauxAssistantMessage('by default back re-')
    }
    faux.setResponses(Array.from({ length: 24 }, () => step))

    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      models,
      model: 'faux/faux-1',
    })
    try {
      let agentSpawnHookHits = 0
      await kernel.plugins.register({
        id: 'test:fork-gate',
        definePlugin(ctx) {
          ctx.hook.onAgentSpawn(() => {
            agentSpawnHookHits += 1
            return { action: 'continue' }
          })
          ctx.tool({
            name: 'fork_spawn',
            description: 'derive fork sub-conversation',
            inputSchema: {
              type: 'object',
              properties: {
                prompt: { type: 'string' },
                schema: { type: 'object' },
              },
              required: ['prompt'],
            },
            execute: async (args, context) => {
              const a = args as { prompt: string; schema?: Record<string, unknown> }
              return await ctx.host.spawnAgent({
                parentConversationId: context.conversationId!,
                prompt: a.prompt,
                fork: true,
                ...(a.schema !== undefined ? { schema: a.schema } : {}),
              })
            },
          })
        },
      }, { enabled: true })

      // 1. structure output isolated: parent carries schema run phase fork without schema subagent must not inherit register_structured_output
      const parentRes = await kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'parent proxy carriesschematest',
        schema: {
          type: 'object',
          properties: { ok: { const: true } },
          required: ['ok'],
          additionalProperties: false,
        },
      })
      assert.deepEqual(parentRes, { ok: true })
      assert.equal(plainForkDeclaredStructuredTool, false, 'not declaration schema  fork subagent system message in must not appear register_structured_output')
      assert.equal(plainForkToolRejected, true, 'not declaration schema  fork subagent runtime invoke register_structured_output should by reject')
      assert.equal(schemaForkDeclaredStructuredTool, true, 'explicit declaration schema  fork subagent should normal own register_structured_output')
      assert.ok(plainForkMessages && userMessageTexts(plainForkMessages).some((t) => t.includes('parent proxy carriesschematest')))

      // 2. SecretStash secret do not penetrate to fork subagent
      const secretParent = await kernel.createConversation({ cwd: dir })
      kernel.stash.put(secretParent.id, 'SECRET_API_KEY', 'sk-fork-secret-998877')
      await kernel.submitInput(secretParent.id, 'record secret sk-fork-secret-998877')
      await kernel.waitForIdle(secretParent.id)

      await kernel.spawnAgent({
        parentConversationId: secretParent.id,
        fork: true,
        prompt: 'check secret is otherwise leak',
      })
      assert.ok(secretForkMessages)
      const serialized = JSON.stringify(secretForkMessages)
      assert.ok(!serialized.includes('sk-fork-secret-998877'), 'fork subagent history must not contains plaintext secret')
      assert.ok(serialized.includes('[REDACTED:stash:'), 'fork subagent history should keep redaction placeholder')
      const secretChildren = kernel.listConversations({ parentConversationId: secretParent.id })
      assert.equal(secretChildren.length, 1)
      assert.deepEqual(kernel.stash.envFor(secretChildren[0]!.id), {})
      assert.equal(kernel.buildSpawnEnv(secretChildren[0]!.id, dir)['SECRET_API_KEY'], undefined)

      // 3. pre- reject all must in agent_spawn hook before trigger
      const hitsBeforeRejects = agentSpawnHookHits
      const emptyParent = await kernel.createConversation({ cwd: dir })
      await assertRejectsCode(
        () => kernel.spawnAgent({ parentConversationId: emptyParent.id, fork: true, prompt: 'empty history' }),
        'fork_empty_history',
        409,
      )
      await assertRejectsCode(
        () => kernel.spawnAgent({ parentConversationId: secretParent.id, fork: 'yes' as never, prompt: 'illegalfork' }),
        'validation_error',
        400,
      )
      await assertRejectsCode(
        () => kernel.spawnAgent({ parentConversationId: secretParent.id, fork: true, resume: 'child-1', prompt: 'mutual exclusion' }),
        'validation_error',
        400,
      )
      await assertRejectsCode(
        () => kernel.spawnAgent({ parentConversationId: secretParent.id, agentType: 'herdr:agy', fork: true, prompt: 'external runtime' }),
        'unsupported_runtime',
        400,
      )
      await kernel.services.profiles.save({
        id: 'herdr-profile',
        name: 'external proxy',
        runtime: { kind: 'herdr', agent: 'agy' },
      })
      await assertRejectsCode(
        () => kernel.spawnAgent({ parentConversationId: secretParent.id, agentType: 'herdr-profile', fork: true, prompt: 'externalProfile' }),
        'unsupported_runtime',
        400,
      )
      assert.equal(agentSpawnHookHits, hitsBeforeRejects, 'pre- reject never obtain enter agent_spawn hook chain')

      // 4. disable model return 409 model_disabled
      await kernel.services.profiles.save({
        id: 'disabled-target',
        name: 'disable model role',
        model: 'faux/faux-disabled',
      })
      await kernel.setDisabledModels('faux', ['faux-disabled'])
      await assertRejectsCode(
        () => kernel.spawnAgent({ parentConversationId: secretParent.id, agentType: 'disabled-target', fork: true, prompt: 'disable model' }),
        'model_disabled',
        409,
      )
    } finally {
      await kernel.close()
    }
  })

  it('nodeId inherit priority and resolveSpawnTarget({ fork: true })(real online remote node)', { timeout: 60_000 }, async () => {
    const dir = join(tmpRoot, 'remote-node-priority')
    const parentCwd = join(dir, 'parent-cwd')
    const profileCwd = join(dir, 'profile-cwd')
    const crossCwd = join(dir, 'cross-cwd')
    const daemonParentDir = join(dir, 'daemon-parent')
    const daemonProfileDir = join(dir, 'daemon-profile')
    for (const d of [dir, parentCwd, profileCwd, crossCwd, daemonParentDir, daemonProfileDir]) {
      mkdirSync(d, { recursive: true })
    }

    const { models, faux } = makeFauxModels({ models: [{ id: 'faux-1', reasoning: true }] })
    faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage('remote back re-')))

    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      models,
      model: 'faux/faux-1',
    })
    let hub: Awaited<ReturnType<typeof startHub>> | undefined
    let daemonParent: Awaited<ReturnType<typeof createNodeDaemon>> | undefined
    let daemonProfile: Awaited<ReturnType<typeof createNodeDaemon>> | undefined

    try {
      hub = await startHub({ kernel: kernel as never, port: 0 })
      const issuedParent = await kernel.issueNodeToken('node-parent')
      const issuedProfile = await kernel.issueNodeToken('node-profile')
      daemonParent = await createNodeDaemon({
        hubUrl: hub.url,
        identity: { nodeId: 'node-parent', token: issuedParent.token },
        dataDir: daemonParentDir,
        reconnectBaseDelayMs: 50,
        reconnectMaxDelayMs: 200,
        log: () => undefined,
      })
      daemonProfile = await createNodeDaemon({
        hubUrl: hub.url,
        identity: { nodeId: 'node-profile', token: issuedProfile.token },
        dataDir: daemonProfileDir,
        reconnectBaseDelayMs: 50,
        reconnectMaxDelayMs: 200,
        log: () => undefined,
      })
      assert.ok(await daemonParent.waitUntilRegistered(), 'node-parent should succeeded enable')
      assert.ok(await daemonProfile.waitUntilRegistered(), 'node-profile should succeeded enable')

      let hostApi!: HelmHostApi
      await kernel.plugins.register({
        id: 'test:remote-resolve-target',
        definePlugin(ctx) {
          hostApi = ctx.host
        },
      }, { enabled: true })

      await kernel.services.profiles.save({
        id: 'same-remote',
        name: 'same role remote',
        nodeId: 'node-profile',
        cwd: profileCwd,
      })
      await kernel.services.profiles.save({
        id: 'cross-remote',
        name: 'across role remote',
        nodeId: 'node-profile',
        cwd: crossCwd,
      })

      const parent = await kernel.createConversation({
        profileId: 'same-remote',
        nodeId: 'node-parent',
        cwd: parentCwd,
      })
      await kernel.submitInput(parent.id, 'establish remote parent conversation context')
      await kernel.waitForIdle(parent.id)

      // 1. same role fork:parentNodeId > profileNodeId,parentCwd > profileCwd
      const sameTarget = await hostApi.resolveSpawnTarget({
        parentConversationId: parent.id,
        fork: true,
      })
      assert.equal(sameTarget.nodeId, 'node-parent')
      assert.equal(sameTarget.sourceCwd, parentCwd)
      assert.equal(sameTarget.parentCwd, parentCwd)

      // 2. across role fork:profileNodeId > parentNodeId,profileCwd > parentCwd
      const crossTarget = await hostApi.resolveSpawnTarget({
        parentConversationId: parent.id,
        profileId: 'cross-remote',
        fork: true,
      })
      assert.equal(crossTarget.nodeId, 'node-profile')
      assert.equal(crossTarget.sourceCwd, crossCwd)

      // 3. non- fork: even if same Profile, still takes precedence profileNodeId
      const nonForkTarget = await hostApi.resolveSpawnTarget({
        parentConversationId: parent.id,
        profileId: 'same-remote',
      })
      assert.equal(nonForkTarget.nodeId, 'node-profile')
      assert.equal(nonForkTarget.sourceCwd, profileCwd)

      // 4. real spawnAgent({ fork: true })  nodeId and cwd and on state parse consistent
      const beforeIds = new Set(kernel.listConversations({ parentConversationId: parent.id }).map((c) => c.id))
      await kernel.spawnAgent({
        parentConversationId: parent.id,
        fork: true,
        prompt: 'same role remote fork',
      })
      const sameChild = kernel.listConversations({ parentConversationId: parent.id }).find((c) => !beforeIds.has(c.id))!
      assert.equal(sameChild.nodeId, 'node-parent')
      assert.equal(sameChild.cwd, parentCwd)
      beforeIds.add(sameChild.id)

      await kernel.spawnAgent({
        parentConversationId: parent.id,
        agentType: 'cross-remote',
        fork: true,
        prompt: 'across role remote fork',
      })
      const crossChild = kernel.listConversations({ parentConversationId: parent.id }).find((c) => !beforeIds.has(c.id))!
      assert.equal(crossChild.nodeId, 'node-profile')
      assert.equal(crossChild.cwd, crossCwd)
    } finally {
      await daemonParent?.close().catch(() => {})
      await daemonProfile?.close().catch(() => {})
      await hub?.close().catch(() => {})
      await kernel.close()
    }
  })

  it('helm.rewind (replaceFromEntryId) after fork: only inherit heavy write after clean history, excludes by wipe except turn', { timeout: 60_000 }, async () => {
    const dir = join(tmpRoot, 'rewind-then-fork')
    const { models, faux } = makeFauxModels({ models: [{ id: 'faux-1', reasoning: true }] })

    let forkedMessages: unknown[] | undefined
    const step: FauxResponseFactory = (context) => {
      const msgs = context.messages as Array<{ role?: string; content?: unknown }>
      const lastUser = userMessageTexts(msgs).at(-1) ?? ''
      if (lastUser.includes('KEEP_ME_111')) return fauxAssistantMessage('already record KEEP_ME_111')
      if (lastUser.includes('ERASE_ME_222')) return fauxAssistantMessage('i.e. wipe except answer ERASE_ME_222')
      if (lastUser.includes('REWRITTEN_333')) return fauxAssistantMessage('heavy write after answer REWRITTEN_333')
      if (lastUser.includes('core inspect rewind after fork history')) {
        forkedMessages = msgs
        return fauxAssistantMessage('core inspect done')
      }
      throw new Error(`not pre- phase faux request: ${lastUser}`)
    }
    faux.setResponses(Array.from({ length: 8 }, () => step))

    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      models,
      model: 'faux/faux-1',
    })
    try {
      await kernel.submitInput(1, 'one round keep information KEEP_ME_111')
      await kernel.waitForIdle(1)
      await kernel.submitInput(1, 'second round await fall back information ERASE_ME_222')
      await kernel.waitForIdle(1)

      const detail = await kernel.getConversationDetail(1, { limit: 50 })
      const eraseEntry = detail.entries.find(
        (e) => e.kind === 'helm.input' && JSON.stringify(e.data).includes('ERASE_ME_222'),
      )
      assert.ok(eraseEntry, 'must found await rewind  helm.input item')

      await kernel.submitInput(1, 'second round heavy write after information REWRITTEN_333', {
        replaceFromEntryId: Number(eraseEntry!.id),
      })
      await kernel.waitForIdle(1)

      await kernel.spawnAgent({
        parentConversationId: 1,
        fork: true,
        prompt: 'core inspect rewind after fork history',
      })
      assert.ok(forkedMessages)
      const serialized = JSON.stringify(forkedMessages)
      assert.ok(serialized.includes('KEEP_ME_111'), 'rewind before keep round must inherit')
      assert.ok(serialized.includes('REWRITTEN_333'), 'rewind heavy write after round must inherit')
      assert.ok(!serialized.includes('ERASE_ME_222'), 'by rewind wipe except question answer never can appear in fork context in')
    } finally {
      await kernel.close()
    }
  })

  it('agent_spawn hook transform fall back: illegal fork immediately invalid_hook_result, translate rotate fork:true or swap target in final inspect intercept and without model invoke', { timeout: 60_000 }, async () => {
    const dir = join(tmpRoot, 'hook-transform-guard')
    const { models, faux } = makeFauxModels({ models: [{ id: 'faux-1', reasoning: true }] })
    faux.setResponses([fauxAssistantMessage('establish valid parent history')])

    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      models,
      model: 'faux/faux-1',
    })
    try {
      await kernel.submitInput(1, 'establish parent conversation valid history')
      await kernel.waitForIdle(1)
      const emptyConv = await kernel.createConversation({ cwd: dir })
      await kernel.services.profiles.save({
        id: 'herdr-prof',
        name: 'external runtime',
        runtime: { kind: 'herdr', agent: 'agy' },
      })

      let mode: 'bad-type' | 'flip-to-empty' | 'flip-to-herdr-prof' | 'retarget-empty-parent' = 'bad-type'
      let downstreamHits = 0
      await kernel.plugins.register({
        id: 'test:transform-upstream',
        definePlugin(ctx) {
          ctx.hook.onAgentSpawn(
            (req) => {
              if (mode === 'bad-type') {
                return { action: 'transform', value: { ...req, fork: 'yes' as never } }
              }
              if (mode === 'flip-to-empty') {
                return { action: 'transform', value: { ...req, fork: true } }
              }
              if (mode === 'flip-to-herdr-prof') {
                return { action: 'transform', value: { ...req, fork: true, agentType: 'herdr-prof' } }
              }
              return { action: 'transform', value: { ...req, parentConversationId: emptyConv.id } }
            },
            { priority: 250 },
          )
          ctx.hook.onAgentSpawn(
            () => {
              downstreamHits += 1
              return { action: 'continue' }
            },
            { priority: 100 },
          )
        },
      }, { enabled: true })

      const callsBefore = faux.state.callCount

      mode = 'bad-type'
      await assertRejectsCode(
        () => kernel.spawnAgent({ parentConversationId: 1, prompt: 'non- boolean inject' }),
        'invalid_hook_result',
      )
      assert.equal(downstreamHits, 0, 'payload validation failed should in hook pipeline inside i.e. moment block assert, do not arrive downstream hook')

      mode = 'flip-to-empty'
      await assertRejectsCode(
        () => kernel.spawnAgent({ parentConversationId: emptyConv.id, prompt: 'non-forktranslate rotate' }),
        'fork_empty_history',
        409,
      )

      mode = 'flip-to-herdr-prof'
      await assertRejectsCode(
        () => kernel.spawnAgent({ parentConversationId: 1, prompt: 'non-forkchange write is externalProfile' }),
        'unsupported_runtime',
        400,
      )

      mode = 'retarget-empty-parent'
      await assertRejectsCode(
        () => kernel.spawnAgent({ parentConversationId: 1, fork: true, prompt: 'more swap is empty parent conversation' }),
        'fork_empty_history',
        409,
      )

      assert.equal(faux.state.callCount, callsBefore, 'all by final inspect intercept derive all must not start any model invoke')
    } finally {
      await kernel.close()
    }
  })
})
