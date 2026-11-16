/**
 * subagent context fork 契约与端到端测试：
 * - selectCleanForkAnchorEntryId 纯函数边界（空历史、仅 system、reset 无/有 handoff、
 *   多轮完整、并行部分 toolCall 挂起截断、非法 ID 拒绝）；
 * - KernelRuntime.spawnAgent({ fork: true }) 真实 SDK + faux provider 集成：
 *   1. mid-turn 分叉与并行双分叉继承父已完成上下文，无未闭合 toolCall 或 missing_result；
 *   2. 同 Profile 与跨 Profile 的 model / effort / cwd 继承优先级与显式覆盖；
 *   3. 结构化输出扩展按子代理显式声明隔离（父有 schema 而子无 schema 时剥离）；
 *   4. SecretStash 机密不随分叉泄露到子代理历史或环境变量；
 *   5. 禁用模型（409 model_disabled）、空父历史（409 fork_empty_history）、
 *      fork+resume（400 validation_error）、herdr:* 与 profile.runtime（400 unsupported_runtime）
 *      全部在 agent_spawn 钩子前前置拒绝。
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
    assert.ok(resolvedIds.has(id), `fork 上下文中不得存在未闭合 toolCall(${id})`)
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

describe('selectCleanForkAnchorEntryId 纯函数边界', { timeout: 60_000 }, () => {
  it('空历史与仅含 system 消息均返回 undefined', { timeout: 60_000 }, () => {
    assert.equal(selectCleanForkAnchorEntryId({ entries: [], contributions: [] }), undefined)
    assert.equal(
      selectCleanForkAnchorEntryId({
        entries: [{ id: 1 }, { id: 2 }],
        contributions: [[{ role: 'system' }], [{ role: 'system' }]],
      }),
      undefined,
    )
  })

  it('reset 无交接返回 undefined；reset 含 user handoff 返回交接 entryId', { timeout: 60_000 }, () => {
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
        contributions: [[], [{ role: 'user', content: '交接摘要' }]],
      }),
      6,
    )
  })

  it('完整多轮会话返回末尾 entryId；已排除 aborted 后仍按有效锚点返回', { timeout: 60_000 }, () => {
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
    // SDK 排除 aborted 条目后，末尾可安全截断到上一条已完成 user 条目
    assert.equal(
      selectCleanForkAnchorEntryId({
        entries: [{ id: 10 }, { id: 11 }],
        contributions: [[{ role: 'user', content: '已提交' }], []],
      }),
      11,
    )
  })

  it('并行 toolCall 部分完成且仍有挂起时回退到未闭环 assistant 之前', { timeout: 60_000 }, () => {
    const view = {
      entries: [{ id: 1 }, { id: 2 }, { id: 3 }],
      contributions: [
        [{ role: 'user', content: '开始' }],
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

    // 全部 toolCall 均有对应 toolResult 时返回最后条目
    const settled = {
      entries: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      contributions: [
        ...view.contributions,
        [{ role: 'toolResult', toolCallId: 'tc-pending' }],
      ],
    }
    assert.equal(selectCleanForkAnchorEntryId(settled), 4)
  })

  it('同一 contributions[i] 内含 [assistant(toolCall), toolResult] 时正确识别已闭环与未闭环', { timeout: 60_000 }, () => {
    // 同一条目内完成闭合：[assistant(tc-1), toolResult(tc-1)] 应保留当前条目
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

    // 同一条目内仅部分闭合：应整条截断并回退到前一条已完成条目
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

    // 前一条目同条目内已闭环、下一条目再次挂起：截断到前一条目
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

  it('系统消息后紧接未闭环 assistant 截断后无非 system 消息则返回 undefined；非法 ID 返回 undefined', { timeout: 60_000 }, () => {
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

describe('KernelRuntime.spawnAgent({ fork: true }) 集成契约', { timeout: 60_000 }, () => {
  it('mid-turn 分叉与并行双分叉继承已完成上下文、无未闭合 toolCall 或 missing_result', { timeout: 60_000 }, async () => {
    const dir = join(tmpRoot, 'mid-turn-parallel')
    const { models, faux } = makeFauxModels({ models: [{ id: 'faux-1', reasoning: true }] })

    const childSnapshots: Array<{ tag: string; messages: unknown[]; users: string[] }> = []
    const step: FauxResponseFactory = (context) => {
      const msgs = context.messages as Array<{ role?: string; content?: unknown; toolCallId?: string }>
      const users = userMessageTexts(msgs)
      const lastMsg = msgs.at(-1)
      if (lastMsg?.role === 'user' && users.at(-1) === '线索一: ALPHA_SEED') {
        return fauxAssistantMessage('已记录 ALPHA_SEED')
      }
      if (lastMsg?.role === 'user' && users.at(-1) === '线索二: BETA_SEED') {
        return fauxAssistantMessage(
          [
            fauxToolCall('fork_spawn', { prompt: '子甲核查', fork: true }, { id: 'call-child-a' }),
            fauxToolCall('fork_spawn', { prompt: '子乙核查', fork: true }, { id: 'call-child-b' }),
            fauxToolCall('sibling_noop', {}, { id: 'call-sibling' }),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'user' && (users.at(-1) === '子甲核查' || users.at(-1) === '子乙核查')) {
        const tag = users.at(-1)!
        childSnapshots.push({ tag, messages: msgs, users })
        assertNoDanglingToolCalls(msgs)
        assert.ok(!JSON.stringify(msgs).includes('missing_result'), '不得出现 missing_result 合成补丁')
        assert.ok(users.some((t) => t.includes('ALPHA_SEED')), `${tag} 必须继承第 1 轮线索`)
        assert.ok(users.some((t) => t.includes('BETA_SEED')), `${tag} 必须继承当前轮用户输入`)
        return fauxAssistantMessage(`完成:${tag}`)
      }
      if (lastMsg?.role === 'toolResult') {
        return fauxAssistantMessage('父会话汇总完毕')
      }
      throw new Error(`未预期的 faux 调用: ${JSON.stringify(msgs)}`)
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
            description: '触发宿主 spawnAgent',
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
            description: '同轮兄弟占位工具',
            inputSchema: { type: 'object' },
            execute: () => ({ ok: true }),
          })
        },
      }, { enabled: true })

      await kernel.submitInput(1, '线索一: ALPHA_SEED')
      await kernel.waitForIdle(1)
      await kernel.submitInput(1, '线索二: BETA_SEED')
      await kernel.waitForIdle(1)

      assert.equal(childSnapshots.length, 2)
      assert.deepEqual(childSnapshots.map((s) => s.tag).sort(), ['子乙核查', '子甲核查'])
      assert.equal(await kernel.getLastAssistantText(1), '父会话汇总完毕')
    } finally {
      await kernel.close()
    }
  })

  it('同 Profile 与跨 Profile 的 model / effort / cwd 继承优先级与显式覆盖', { timeout: 60_000 }, async () => {
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
        name: '同角色',
        model: 'faux/faux-profile',
        thinkingLevel: 'low',
        cwd: profileDir,
      })
      await kernel.services.profiles.save({
        id: 'cross-target',
        name: '跨角色目标',
        model: 'faux/faux-profile',
        thinkingLevel: 'low',
        cwd: crossDir,
      })
      await kernel.services.profiles.save({
        id: 'bare-target',
        name: '无覆盖目标',
      })

      const parent = await kernel.createConversation({
        profileId: 'custom-same',
        cwd: parentDir,
        model: 'faux/faux-parent',
      })
      await kernel.updateConversation(parent.id, { thinkingLevel: 'high' })
      await kernel.submitInput(parent.id, '建立父会话历史')
      await kernel.waitForIdle(parent.id)

      const beforeIds = new Set(kernel.listConversations({ parentConversationId: parent.id }).map((c) => c.id))
      const pickNewChild = () => {
        const added = kernel.listConversations({ parentConversationId: parent.id }).filter((c) => !beforeIds.has(c.id))
        assert.equal(added.length, 1)
        beforeIds.add(added[0]!.id)
        return added[0]!
      }

      // 1. 同 Profile 默认继承：省略 agentType/cwd/model/effort，继承父会话覆盖（优于 Profile）
      await kernel.spawnAgent({
        parentConversationId: parent.id,
        fork: true,
        prompt: '同Profile继承',
      })
      const sameDefaultChild = pickNewChild()
      assert.equal(sameDefaultChild.profileId, 'custom-same')
      assert.equal(sameDefaultChild.cwd, parentDir)
      assert.equal(sameDefaultChild.model, 'faux/faux-parent')
      assert.equal(sameDefaultChild.thinkingLevel, 'high')
      assert.equal(sameDefaultChild.thinkingLevelOverride, 'high')

      // 2. 同 Profile 显式覆盖
      await kernel.spawnAgent({
        parentConversationId: parent.id,
        fork: true,
        prompt: '同Profile显式覆盖',
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

      // 3. 跨 Profile：目标 Profile 字段优先于父会话
      await kernel.spawnAgent({
        parentConversationId: parent.id,
        agentType: 'cross-target',
        fork: true,
        prompt: '跨Profile优先目标',
      })
      const crossTargetChild = pickNewChild()
      assert.equal(crossTargetChild.profileId, 'cross-target')
      assert.equal(crossTargetChild.cwd, crossDir)
      assert.equal(crossTargetChild.model, 'faux/faux-profile')
      assert.equal(crossTargetChild.thinkingLevel, 'low')

      // 4. 跨 Profile 且目标 Profile 未配置时回退到父会话覆盖
      await kernel.spawnAgent({
        parentConversationId: parent.id,
        agentType: 'bare-target',
        fork: true,
        prompt: '跨Profile回退父会话',
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

  it('结构化输出隔离、SecretStash 不泄露与前置拒绝（无钩子泄漏）', { timeout: 60_000 }, async () => {
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

      if (lastMsg?.role === 'user' && lastUser.includes('无schema子代理')) {
        plainForkDeclaredStructuredTool = hasStructuredToolDecl
        plainForkMessages = msgs
        // 主动尝试调用未注册的 register_structured_output，双重验证运行期工具列表也已剥离它。
        return fauxAssistantMessage(
          [fauxToolCall('register_structured_output', { output: { leak: true } })],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'toolResult' && lastMsg.toolName === 'register_structured_output' && lastUser.includes('无schema子代理')) {
        plainForkToolRejected = lastMsg.isError === true
        return fauxAssistantMessage('无schema回复')
      }
      if (lastMsg?.role === 'user' && lastUser.includes('有schema子代理')) {
        schemaForkDeclaredStructuredTool = hasStructuredToolDecl
        return fauxAssistantMessage(
          [fauxToolCall('register_structured_output', { output: { tag: 'FORK_OK' } })],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'user' && lastUser.includes('父代理带schema测试')) {
        assert.equal(hasStructuredToolDecl, true)
        return fauxAssistantMessage(
          [
            fauxToolCall('fork_spawn', { prompt: '无schema子代理' }, { id: 'fc-plain' }),
            fauxToolCall(
              'fork_spawn',
              {
                prompt: '有schema子代理',
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
        return fauxAssistantMessage('结构化收尾完成')
      }
      if (lastMsg?.role === 'toolResult' && lastMsg.toolName === 'fork_spawn') {
        return fauxAssistantMessage(
          [fauxToolCall('register_structured_output', { output: { ok: true } })],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'user' && lastUser.includes('检查秘密是否泄露')) {
        secretForkMessages = msgs
        return fauxAssistantMessage('无秘密')
      }
      return fauxAssistantMessage('默认回复')
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
            description: '派生 fork 子会话',
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

      // 1. 结构化输出隔离：父带 schema 的运行期 fork 无 schema 子代理不得继承 register_structured_output
      const parentRes = await kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '父代理带schema测试',
        schema: {
          type: 'object',
          properties: { ok: { const: true } },
          required: ['ok'],
          additionalProperties: false,
        },
      })
      assert.deepEqual(parentRes, { ok: true })
      assert.equal(plainForkDeclaredStructuredTool, false, '未声明 schema 的 fork 子代理系统消息中不得出现 register_structured_output')
      assert.equal(plainForkToolRejected, true, '未声明 schema 的 fork 子代理运行时调用 register_structured_output 应被拒绝')
      assert.equal(schemaForkDeclaredStructuredTool, true, '显式声明 schema 的 fork 子代理应正常拥有 register_structured_output')
      assert.ok(plainForkMessages && userMessageTexts(plainForkMessages).some((t) => t.includes('父代理带schema测试')))

      // 2. SecretStash 机密不穿透到 fork 子代理
      const secretParent = await kernel.createConversation({ cwd: dir })
      kernel.stash.put(secretParent.id, 'SECRET_API_KEY', 'sk-fork-secret-998877')
      await kernel.submitInput(secretParent.id, '记录机密 sk-fork-secret-998877')
      await kernel.waitForIdle(secretParent.id)

      await kernel.spawnAgent({
        parentConversationId: secretParent.id,
        fork: true,
        prompt: '检查秘密是否泄露',
      })
      assert.ok(secretForkMessages)
      const serialized = JSON.stringify(secretForkMessages)
      assert.ok(!serialized.includes('sk-fork-secret-998877'), 'fork 子代理历史不得包含明文秘密')
      assert.ok(serialized.includes('[REDACTED:stash:'), 'fork 子代理历史应保留脱敏占位符')
      const secretChildren = kernel.listConversations({ parentConversationId: secretParent.id })
      assert.equal(secretChildren.length, 1)
      assert.deepEqual(kernel.stash.envFor(secretChildren[0]!.id), {})
      assert.equal(kernel.buildSpawnEnv(secretChildren[0]!.id, dir)['SECRET_API_KEY'], undefined)

      // 3. 前置拒绝均必须在 agent_spawn 钩子前触发
      const hitsBeforeRejects = agentSpawnHookHits
      const emptyParent = await kernel.createConversation({ cwd: dir })
      await assertRejectsCode(
        () => kernel.spawnAgent({ parentConversationId: emptyParent.id, fork: true, prompt: '空历史' }),
        'fork_empty_history',
        409,
      )
      await assertRejectsCode(
        () => kernel.spawnAgent({ parentConversationId: secretParent.id, fork: 'yes' as never, prompt: '非法fork' }),
        'validation_error',
        400,
      )
      await assertRejectsCode(
        () => kernel.spawnAgent({ parentConversationId: secretParent.id, fork: true, resume: 'child-1', prompt: '互斥' }),
        'validation_error',
        400,
      )
      await assertRejectsCode(
        () => kernel.spawnAgent({ parentConversationId: secretParent.id, agentType: 'herdr:agy', fork: true, prompt: '外部运行时' }),
        'unsupported_runtime',
        400,
      )
      await kernel.services.profiles.save({
        id: 'herdr-profile',
        name: '外部代理',
        runtime: { kind: 'herdr', agent: 'agy' },
      })
      await assertRejectsCode(
        () => kernel.spawnAgent({ parentConversationId: secretParent.id, agentType: 'herdr-profile', fork: true, prompt: '外部Profile' }),
        'unsupported_runtime',
        400,
      )
      assert.equal(agentSpawnHookHits, hitsBeforeRejects, '前置拒绝绝不得进入 agent_spawn 钩子链')

      // 4. 禁用模型返回 409 model_disabled
      await kernel.services.profiles.save({
        id: 'disabled-target',
        name: '禁用模型角色',
        model: 'faux/faux-disabled',
      })
      await kernel.setDisabledModels('faux', ['faux-disabled'])
      await assertRejectsCode(
        () => kernel.spawnAgent({ parentConversationId: secretParent.id, agentType: 'disabled-target', fork: true, prompt: '禁用模型' }),
        'model_disabled',
        409,
      )
    } finally {
      await kernel.close()
    }
  })

  it('nodeId 继承优先级与 resolveSpawnTarget({ fork: true })（真实在线远端节点）', { timeout: 60_000 }, async () => {
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
    faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage('远端回复')))

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
      assert.ok(await daemonParent.waitUntilRegistered(), 'node-parent 应成功上线')
      assert.ok(await daemonProfile.waitUntilRegistered(), 'node-profile 应成功上线')

      let hostApi!: HelmHostApi
      await kernel.plugins.register({
        id: 'test:remote-resolve-target',
        definePlugin(ctx) {
          hostApi = ctx.host
        },
      }, { enabled: true })

      await kernel.services.profiles.save({
        id: 'same-remote',
        name: '同角色远端',
        nodeId: 'node-profile',
        cwd: profileCwd,
      })
      await kernel.services.profiles.save({
        id: 'cross-remote',
        name: '跨角色远端',
        nodeId: 'node-profile',
        cwd: crossCwd,
      })

      const parent = await kernel.createConversation({
        profileId: 'same-remote',
        nodeId: 'node-parent',
        cwd: parentCwd,
      })
      await kernel.submitInput(parent.id, '建立远端父会话上下文')
      await kernel.waitForIdle(parent.id)

      // 1. 同角色 fork：parentNodeId > profileNodeId，parentCwd > profileCwd
      const sameTarget = await hostApi.resolveSpawnTarget({
        parentConversationId: parent.id,
        fork: true,
      })
      assert.equal(sameTarget.nodeId, 'node-parent')
      assert.equal(sameTarget.sourceCwd, parentCwd)
      assert.equal(sameTarget.parentCwd, parentCwd)

      // 2. 跨角色 fork：profileNodeId > parentNodeId，profileCwd > parentCwd
      const crossTarget = await hostApi.resolveSpawnTarget({
        parentConversationId: parent.id,
        profileId: 'cross-remote',
        fork: true,
      })
      assert.equal(crossTarget.nodeId, 'node-profile')
      assert.equal(crossTarget.sourceCwd, crossCwd)

      // 3. 非 fork：即使同 Profile，仍优先 profileNodeId
      const nonForkTarget = await hostApi.resolveSpawnTarget({
        parentConversationId: parent.id,
        profileId: 'same-remote',
      })
      assert.equal(nonForkTarget.nodeId, 'node-profile')
      assert.equal(nonForkTarget.sourceCwd, profileCwd)

      // 4. 真实 spawnAgent({ fork: true }) 落盘的 nodeId 与 cwd 与上述解析一致
      const beforeIds = new Set(kernel.listConversations({ parentConversationId: parent.id }).map((c) => c.id))
      await kernel.spawnAgent({
        parentConversationId: parent.id,
        fork: true,
        prompt: '同角色远端分叉',
      })
      const sameChild = kernel.listConversations({ parentConversationId: parent.id }).find((c) => !beforeIds.has(c.id))!
      assert.equal(sameChild.nodeId, 'node-parent')
      assert.equal(sameChild.cwd, parentCwd)
      beforeIds.add(sameChild.id)

      await kernel.spawnAgent({
        parentConversationId: parent.id,
        agentType: 'cross-remote',
        fork: true,
        prompt: '跨角色远端分叉',
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

  it('helm.rewind (replaceFromEntryId) 后 fork：仅继承重写后干净历史，不含被抹除回合', { timeout: 60_000 }, async () => {
    const dir = join(tmpRoot, 'rewind-then-fork')
    const { models, faux } = makeFauxModels({ models: [{ id: 'faux-1', reasoning: true }] })

    let forkedMessages: unknown[] | undefined
    const step: FauxResponseFactory = (context) => {
      const msgs = context.messages as Array<{ role?: string; content?: unknown }>
      const lastUser = userMessageTexts(msgs).at(-1) ?? ''
      if (lastUser.includes('KEEP_ME_111')) return fauxAssistantMessage('已记住 KEEP_ME_111')
      if (lastUser.includes('ERASE_ME_222')) return fauxAssistantMessage('即将抹除的回答 ERASE_ME_222')
      if (lastUser.includes('REWRITTEN_333')) return fauxAssistantMessage('重写后的回答 REWRITTEN_333')
      if (lastUser.includes('核查 rewind 后分叉历史')) {
        forkedMessages = msgs
        return fauxAssistantMessage('核查完毕')
      }
      throw new Error(`未预期的 faux 请求: ${lastUser}`)
    }
    faux.setResponses(Array.from({ length: 8 }, () => step))

    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      models,
      model: 'faux/faux-1',
    })
    try {
      await kernel.submitInput(1, '第一轮保留信息 KEEP_ME_111')
      await kernel.waitForIdle(1)
      await kernel.submitInput(1, '第二轮待回退信息 ERASE_ME_222')
      await kernel.waitForIdle(1)

      const detail = await kernel.getConversationDetail(1, { limit: 50 })
      const eraseEntry = detail.entries.find(
        (e) => e.kind === 'helm.input' && JSON.stringify(e.data).includes('ERASE_ME_222'),
      )
      assert.ok(eraseEntry, '必须找到待 rewind 的 helm.input 条目')

      await kernel.submitInput(1, '第二轮重写后信息 REWRITTEN_333', {
        replaceFromEntryId: Number(eraseEntry!.id),
      })
      await kernel.waitForIdle(1)

      await kernel.spawnAgent({
        parentConversationId: 1,
        fork: true,
        prompt: '核查 rewind 后分叉历史',
      })
      assert.ok(forkedMessages)
      const serialized = JSON.stringify(forkedMessages)
      assert.ok(serialized.includes('KEEP_ME_111'), 'rewind 之前保留轮次必须继承')
      assert.ok(serialized.includes('REWRITTEN_333'), 'rewind 重写后轮次必须继承')
      assert.ok(!serialized.includes('ERASE_ME_222'), '被 rewind 抹除的问答绝不能出现在 fork 上下文中')
    } finally {
      await kernel.close()
    }
  })

  it('agent_spawn 钩子 transform 兜底：非法 fork 立即 invalid_hook_result，翻转 fork:true 或换目标在终检拦截且无模型调用', { timeout: 60_000 }, async () => {
    const dir = join(tmpRoot, 'hook-transform-guard')
    const { models, faux } = makeFauxModels({ models: [{ id: 'faux-1', reasoning: true }] })
    faux.setResponses([fauxAssistantMessage('建立有效父历史')])

    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      models,
      model: 'faux/faux-1',
    })
    try {
      await kernel.submitInput(1, '建立父会话有效历史')
      await kernel.waitForIdle(1)
      const emptyConv = await kernel.createConversation({ cwd: dir })
      await kernel.services.profiles.save({
        id: 'herdr-prof',
        name: '外部运行时',
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
        () => kernel.spawnAgent({ parentConversationId: 1, prompt: '非布尔注入' }),
        'invalid_hook_result',
      )
      assert.equal(downstreamHits, 0, '载荷校验失败应在钩子管道内即刻阻断，不抵达下游钩子')

      mode = 'flip-to-empty'
      await assertRejectsCode(
        () => kernel.spawnAgent({ parentConversationId: emptyConv.id, prompt: '非fork翻转' }),
        'fork_empty_history',
        409,
      )

      mode = 'flip-to-herdr-prof'
      await assertRejectsCode(
        () => kernel.spawnAgent({ parentConversationId: 1, prompt: '非fork改写为外部Profile' }),
        'unsupported_runtime',
        400,
      )

      mode = 'retarget-empty-parent'
      await assertRejectsCode(
        () => kernel.spawnAgent({ parentConversationId: 1, fork: true, prompt: '更换为空父会话' }),
        'fork_empty_history',
        409,
      )

      assert.equal(faux.state.callCount, callsBefore, '所有被终检拦截的派生均不得发起任何模型调用')
    } finally {
      await kernel.close()
    }
  })
})
