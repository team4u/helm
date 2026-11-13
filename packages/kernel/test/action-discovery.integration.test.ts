/**
 * 动作发现运行时集成验收（createHelm 真实组合 + faux provider 最终模型请求）。
 *
 * 覆盖（全部断言在真实 provider 请求载荷上，不 mock runtime）：
 * - 普通插件动作（无 exposeAsTool）：启用后 <available_actions> 目录（prompt.actions 段）
 *   进入最终模型请求；停用后下一回合消失（无幻影残留）；
 * - scope：不匹配会话（tags/modelProviders）不进目录；exposeAsTool 派生工具声明
 *   不泄露进 scope 外会话请求（请求级裁剪），scope 内会话正常可用；
 * - run_action 被 before_turn 钩子剥离时目录清除；直接动作工具被钩子剥离时不经目录复活；
 * - 两条调用路径指引只注入一次（exposeAsTool 走 prompt.tools.*，非直投走 prompt.actions）；
 * - CLI 覆写 / hidden 渲染；描述/元数据更新不留旧提示；
 * - describe 模式真实工具调用：完整 Schema 返回、handler 不执行、停用与 scope 外拒绝。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import type { ConversationEntry, ConversationSummary, PluginDefinition } from '@helm/protocol'
import { createHelm } from '../src/app.js'
import assert from 'node:assert/strict'

/** 捕获的单次最终模型请求（回放语义折叠后的视图）。 */
interface CapturedRequest {
  toolNames: string[]
  /** 全部 system 消息 sections 的折叠视图（与内核 systemSectionsOf 同口径）。 */
  sectionsById: Record<string, string | null>
}

interface TestEnv {
  dataDir: string
  faux: ReturnType<typeof fauxProvider>
  app: Awaited<ReturnType<typeof createHelm>>
  requests: CapturedRequest[]
  initialConvId: number
  capture(): FauxResponseStep
  toolCallStep(name: string, input: Record<string, unknown>): FauxResponseStep
  submitAndWait(convId: number, text: string): Promise<void>
  createTaggedConversation(tags: string[]): Promise<ConversationSummary>
  /** 会话时间线全部工具结果文本（pi.tool-result 的 model 内容序列化）。 */
  toolResultTexts(entries: ConversationEntry[]): string
  close(): Promise<void>
}

async function makeEnv(): Promise<TestEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-action-discovery-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  const initialConv = app.kernel
    .listConversations()
    .find((c) => c.profileId === 'assistant' && c.parentConversationId === undefined)
  if (initialConv === undefined) throw new Error('初始会话缺失')

  const requests: CapturedRequest[] = []
  const fold = (context: { messages: unknown[] }): CapturedRequest => {
    const sectionsById: Record<string, string | null> = {}
    for (const message of context.messages as unknown as Array<Record<string, unknown>>) {
      if (message['role'] !== 'system') continue
      const sections = message['sections'] as Record<string, string | null> | undefined
      if (sections === undefined) continue
      for (const [key, value] of Object.entries(sections)) sectionsById[key] = value
    }
    return {
      toolNames: getCurrentTools(context.messages as never).map((tool) => tool.name),
      sectionsById,
    }
  }
  const capture = (): FauxResponseStep => (context) => {
    requests.push(fold(context))
    return fauxAssistantMessage('已捕获请求')
  }

  const env: TestEnv = {
    dataDir,
    faux,
    app,
    requests,
    initialConvId: initialConv.id,
    capture,
    toolCallStep(name, input) {
      return () => fauxAssistantMessage([fauxToolCall(name, input as Record<string, never>)], { stopReason: 'toolUse' })
    },
    async submitAndWait(convId, text) {
      await app.kernel.submitInput(convId, text)
      await app.kernel.waitForIdle(convId)
    },
    async createTaggedConversation(tags) {
      return app.kernel.createConversation({ title: 'tagged', tags })
    },
    toolResultTexts(entries) {
      return entries
        .filter((entry) => entry.kind === 'pi.tool-result')
        .flatMap((entry) => (entry.model ?? []) as Array<Record<string, unknown>>)
        .map((message) => JSON.stringify(message))
        .join('\n')
    },
    async close() {
      try {
        await app.close()
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
  }
  return env
}

/** 目录段文本（不存在时 undefined）。 */
function actionsSection(request: CapturedRequest): string | null | undefined {
  return request.sectionsById['prompt.actions']
}

// ---------------------------------------------------------------------------
// 1. 普通外部插件动作：启用即入目录、目录内容契约、停用后下一回合消失
// ---------------------------------------------------------------------------

test('动作目录: 仅 ctx.action 的普通插件——启用即出现在最终请求，停用后下一回合清除且无残留', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const host = env.app.kernel.plugins!
    const def: PluginDefinition = {
      id: 'demo:plain',
      definePlugin: (ctx) => {
        ctx.action({
          id: 'greet',
          description: '多行描述第一行\n第二行包含 <xml> 与 & 符号',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              times: { type: 'number' },
              config: { type: 'object', properties: { deep: { type: 'string' } } },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['name'],
          },
          outputSchema: { type: 'object' },
          handler: () => ({ ok: true }),
        })
      },
    }
    await host.register(def, { enabled: true })

    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, '第一回合')
    const first = env.requests[0]!
    const section = actionsSection(first)
    assert.ok(section, '启用后最终模型请求应含 prompt.actions 目录段')
    assert.ok(section.includes('<available_actions>'), '目录应有 XML 围栏')
    assert.ok(section.includes('demo:plain.greet'), '目录应含全限定动作 ID')
    // 多行描述规范化为一行 + XML 转义
    assert.ok(!section.includes('\n第二行'), '多行描述应压成单行')
    assert.ok(section.includes('&lt;xml&gt;'), '描述中的 XML 应转义')
    assert.ok(section.includes('&amp;'), '描述中的 & 应转义')
    // 紧凑签名：必填/可选 + 类型 + 嵌套标注
    assert.ok(section.includes('name: string（必填）'))
    assert.ok(section.includes('times: number（可选）'))
    assert.ok(section.includes('config: object（嵌套）（describe 查询）（可选）'), '嵌套对象应标注按需查询')
    assert.ok(section.includes('tags: string[]（可选）'))
    // 缺省 CLI：helm <pluginId 剥 builtin:> <actionId>
    assert.ok(section.includes('CLI: helm demo:plain greet'))
    // 目录引导 describe 与 helm actions list
    assert.ok(section.includes('describe: true'))
    assert.ok(section.includes('helm actions list --json'))

    // 停用：下一回合目录不再含该插件动作（内置插件动作仍在目录属正常）；
    // 段内无旧文本残留，也不存在指向已停用动作的任何 prompt.actions 幻影段
    await host.disable('demo:plain')
    env.requests.length = 0
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, '第二回合')
    const second = env.requests[0]!
    const secondSection = actionsSection(second) ?? ''
    assert.ok(!secondSection.includes('demo:plain'), '停用后目录不得残留 demo:plain 动作')
    for (const [id, text] of Object.entries(second.sectionsById)) {
      if (id === 'prompt.actions') continue
      assert.ok(!((text ?? '')).includes('demo:plain.greet'), `其他段 ${id} 不得残留已停用动作文本`)
    }
    // 再补一回合：确认田旧目录（含转义后的描述）不会经回放复活
    env.requests.length = 0
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, '第三回合')
    const third = env.requests[0]!
    assert.ok(!((actionsSection(third) ?? '')).includes('&lt;xml&gt;'), '旧目录文本不得经回放复活')
  } finally {
    await env.close()
  }
})

test('磁盘外部插件: rescan 后默认隐藏，启用即自动发现，停用即清理', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const host = env.app.kernel.plugins!
    const pluginDir = join(env.dataDir, 'plugins', 'external-notice')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({
      id: 'external-notice', name: '外部通知', version: '1.0.0', main: 'index.mjs',
    }))
    writeFileSync(join(pluginDir, 'index.mjs'), `export default {
      id: 'external-notice',
      definePlugin(ctx) {
        ctx.action({
          id: 'send', description: '来自磁盘外部插件的通知动作',
          promptGuidelines: ['EXTERNAL_NOTICE_GUIDE 核对收件人与通知内容'],
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
          outputSchema: { type: 'object', properties: { delivered: { type: 'boolean' } }, required: ['delivered'] },
          handler() { return { delivered: true } },
        })
      },
    }`)
    const rescanned = await host.rescanExternalPlugins()
    assert.ok(rescanned.registered.includes('external-notice'), '必须经真实外部加载器注册')
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, '外部插件启用前')
    assert.ok(!actionsSection(env.requests.at(-1)!)?.includes('external-notice'))

    await host.enable('external-notice')
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, '外部插件启用后')
    const section = actionsSection(env.requests.at(-1)!)!
    assert.ok(section.includes('external-notice.send'))
    assert.ok(section.includes('EXTERNAL_NOTICE_GUIDE'))
    assert.ok(section.includes('CLI: helm external-notice send'))

    await host.disable('external-notice')
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, '外部插件停用后')
    assert.ok(!actionsSection(env.requests.at(-1)!)?.includes('external-notice'))
    assert.ok(!JSON.stringify(env.requests.at(-1)!.sectionsById).includes('EXTERNAL_NOTICE_GUIDE'))
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 2. scope：目录与 exposeAsTool 工具声明的请求级过滤
// ---------------------------------------------------------------------------

test('动作目录 scope: 不匹配会话不进目录；exposeAsTool 派生工具声明不泄露进 scope 外会话请求', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const host = env.app.kernel.plugins!
    const def: PluginDefinition = {
      id: 'demo:scoped',
      definePlugin: (ctx) => {
        ctx.action({
          id: 'plain_scoped',
          description: '仅 alpha 会话可用',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          scope: { tags: ['alpha'] },
          handler: () => ({ ok: true }),
        })
        ctx.action({
          id: 'direct_scoped',
          description: '仅 alpha 会话可用的直投动作',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          exposeAsTool: true,
          scope: { tags: ['alpha'] },
          handler: () => ({ ok: true }),
        })
      },
    }
    await host.register(def, { enabled: true })
    const alphaConv = await env.createTaggedConversation(['alpha'])

    // scope 外（无 tag）会话：目录不含该插件动作；直投工具声明不泄露
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, 'scope 外会话')
    const outside = env.requests[0]!
    const outsideSection = actionsSection(outside)
    assert.ok(outsideSection === undefined || !(outsideSection ?? '').includes('demo:scoped'), 'scope 外目录不得含 scoped 动作')
    const leakedDirect = outside.toolNames.find((name) => name.includes('direct_scoped'))
    assert.equal(leakedDirect, undefined, 'scope 外请求不得泄露 exposeAsTool 派生工具声明')
    assert.ok(outside.toolNames.includes('run_action'), '内核工具不受 scope 裁剪影响')

    // scope 内（alpha tag）会话：目录含 plain_scoped；直投工具声明存在
    env.requests.length = 0
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(alphaConv.id, 'scope 内会话')
    const inside = env.requests[0]!
    const insideSection = actionsSection(inside)
    assert.ok(insideSection, 'scope 内会话应有目录段')
    assert.ok(insideSection!.includes('demo:scoped.plain_scoped'), '目录应含 scope 命中的普通动作')
    assert.ok(!insideSection!.includes('demo:scoped.direct_scoped'), 'exposeAsTool 直投动作不进 run_action 目录')
    assert.ok(
      inside.toolNames.some((name) => name.includes('direct_scoped')),
      'scope 内 exposeAsTool 派生工具声明应存在',
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 3. run_action 被钩子剥离：目录清除；直投动作工具被剥离：不经目录复活
// ---------------------------------------------------------------------------

test('动作目录可达性: before_turn 剥离 run_action 时目录清除；直投工具剥离后不经目录复活', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const host = env.app.kernel.plugins!
    // 先注册普通动作插件（目录存在）
    const plainDef: PluginDefinition = {
      id: 'demo:reach',
      definePlugin: (ctx) => {
        ctx.action({
          id: 'probe',
          description: '探测动作',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          handler: () => ({ ok: true }),
        })
        ctx.action({
          id: 'direct_one',
          description: '直投动作',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          exposeAsTool: true,
          handler: () => ({ ok: true }),
        })
      },
    }
    await host.register(plainDef, { enabled: true })

    // 再注册剥离钩子插件（priority 高于默认，后注册先执行由 priority 决定）
    const stripDef: PluginDefinition = {
      id: 'demo:stripper',
      definePlugin: (ctx) => {
        ctx.hook.onBeforeTurn((turn) => {
          const names = new Set(turn.tools.map((tool) => tool.name))
          const targets = ['run_action', ...turn.tools.map((t) => t.name).filter((n) => n.includes('direct_one'))]
          if (targets.every((name) => names.has(name))) {
            return {
              action: 'transform',
              value: {
                ...turn,
                tools: turn.tools.filter((tool) => !targets.includes(tool.name)),
              },
            }
          }
          return { action: 'continue' }
        }, { priority: 100 })
      },
    }
    await host.register(stripDef, { enabled: true })

    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, '剥离回合')
    const request = env.requests[0]!
    assert.equal(actionsSection(request), undefined, 'run_action 被剥离后目录必须清除')
    assert.ok(!request.toolNames.includes('run_action'), 'run_action 应被剥离')
    assert.ok(
      !request.toolNames.some((name) => name.includes('direct_one')),
      '直投动作工具应被剥离',
    )
    // 直投动作不得借目录复活（目录整体已清；即便未来按动作判断也不得出现 direct_one）
    const allSectionText = Object.values(request.sectionsById).join('\n')
    assert.ok(!allSectionText.includes('demo:reach.direct_one'), '被剥离的直投动作不得经目录复活')

    // 移除剥离钩子（停用 stripper）：run_action 恢复 → 目录恢复，直投动作回工具通道
    await host.disable('demo:stripper')
    env.requests.length = 0
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, '恢复回合')
    const restored = env.requests[0]!
    assert.ok(restored.toolNames.includes('run_action'))
    assert.ok(actionsSection(restored)?.includes('demo:reach.probe'), 'run_action 恢复后目录恢复')
    assert.ok(
      restored.toolNames.some((name) => name.includes('direct_one')),
      '直投动作工具恢复声明',
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 4. 指引只注入一次：exposeAsTool 走 prompt.tools.*，非直投走 prompt.actions
// ---------------------------------------------------------------------------

test('指引单次注入: exposeAsTool 动作指引走工具管道；非直投动作指引只出现在目录且带全限定 ID', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const host = env.app.kernel.plugins!
    const def: PluginDefinition = {
      id: 'demo:guide',
      definePlugin: (ctx) => {
        ctx.action({
          id: 'direct_guided',
          description: '直投带指引',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          exposeAsTool: true,
          promptSnippet: 'DIRECT_SNIPPET_MARKER 直投专属段落',
          promptGuidelines: ['DIRECT_GUIDELINE_MARKER 直投要点'],
          handler: () => ({ ok: true }),
        })
        ctx.action({
          id: 'plain_guided',
          description: '普通动作带指引',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          promptSnippet: 'PLAIN_SNIPPET_MARKER 普通动作段落\n第二行',
          promptGuidelines: ['PLAIN_GUIDELINE_MARKER 普通动作要点'],
          handler: () => ({ ok: true }),
        })
      },
    }
    await host.register(def, { enabled: true })

    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, '指引回合')
    const request = env.requests[0]!
    const section = actionsSection(request)
    assert.ok(section, '目录段应存在')

    // 直投指引：只经 prompt.tools.* 工具管道，不进目录
    const directToolSection = Object.entries(request.sectionsById)
      .filter(([id]) => id.startsWith('prompt.tools.'))
      .map(([, text]) => text ?? '')
      .join('\n')
    assert.ok(directToolSection.includes('DIRECT_SNIPPET_MARKER'), '直投 promptSnippet 应经工具管道注入')
    assert.ok(directToolSection.includes('DIRECT_GUIDELINE_MARKER'), '直投 promptGuidelines 应经工具管道注入')
    assert.ok(!section!.includes('DIRECT_SNIPPET_MARKER'), '直投指引不得重复进目录')
    assert.ok(!section!.includes('DIRECT_GUIDELINE_MARKER'), '直投要点不得重复进目录')

    // 非直投指引：只在目录段，带全限定 ID 标注
    assert.ok(section!.includes('PLAIN_SNIPPET_MARKER'), '普通动作 promptSnippet 应进目录')
    assert.ok(section!.includes('PLAIN_GUIDELINE_MARKER'), '普通动作 promptGuidelines 应进目录')
    assert.ok(section!.includes('指引（demo:guide.plain_guided）'), '目录指引应带全限定 ID 标注')
    assert.ok(section!.includes('说明（demo:guide.plain_guided）'), '目录说明应带全限定 ID 标注')
    assert.ok(!directToolSection.includes('PLAIN_SNIPPET_MARKER'), '普通动作指引不得进工具管道')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 5. CLI 渲染：command 覆写生效；hidden 不展示 CLI
// ---------------------------------------------------------------------------

test('CLI 渲染: cli.command 覆写展示真实命令；cli.hidden 不展示 CLI', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const host = env.app.kernel.plugins!
    const def: PluginDefinition = {
      id: 'demo:cli',
      definePlugin: (ctx) => {
        ctx.action({
          id: 'custom_path',
          description: '覆写命令路径',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          cli: { command: ['team', 'report', 'make'] },
          handler: () => ({ ok: true }),
        })
        ctx.action({
          id: 'secret_cmd',
          description: '隐藏 CLI 动作',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          cli: { hidden: true },
          handler: () => ({ ok: true }),
        })
      },
    }
    await host.register(def, { enabled: true })

    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, 'CLI 渲染回合')
    const section = actionsSection(env.requests[0]!)!
    assert.ok(section.includes('CLI: helm team report make'), 'cli.command 覆写应展示真实命令')
    // hidden：动作仍在目录（run_action 可达），但不展示不存在的 CLI
    assert.ok(section.includes('demo:cli.secret_cmd'), 'hidden 动作仍在目录（run_action 可达）')
    const secretIdx = section.indexOf('demo:cli.secret_cmd')
    const nextEntry = section.indexOf('- demo:cli.', secretIdx + 1)
    const secretBlock = section.slice(secretIdx, nextEntry === -1 ? section.length : nextEntry)
    assert.ok(!secretBlock.includes('CLI:'), 'hidden 动作不得展示 CLI 行')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 6. 元数据更新：reload 后目录按新元数据渲染，不留旧提示
// ---------------------------------------------------------------------------

test('元数据更新: 插件 reload 后目录按新描述渲染，旧文本不残留', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const host = env.app.kernel.plugins!
    let description = '旧描述文本 OLD_DESC_MARKER'
    const def = (): PluginDefinition => ({
      id: 'demo:refresh',
      definePlugin: (ctx) => {
        ctx.action({
          id: 'evolve',
          description,
          inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
          outputSchema: { type: 'object' },
          handler: () => ({ ok: true }),
        })
      },
    })
    await host.register(def(), { enabled: true })

    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, '更新前回合')
    assert.ok(actionsSection(env.requests[0]!)!.includes('OLD_DESC_MARKER'), '更新前目录含旧描述')

    // 热更新：停用→注销→重注册（持久化停用状态优先，需显式 enable；真实能力变化路径）
    description = '新描述文本 NEW_DESC_MARKER'
    await host.disable('demo:refresh')
    await host.unregister('demo:refresh')
    await host.register(def())
    await host.enable('demo:refresh')

    env.requests.length = 0
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, '更新后回合')
    const section = actionsSection(env.requests[0]!)!
    assert.ok(section.includes('NEW_DESC_MARKER'), '更新后目录含新描述')
    assert.ok(!section.includes('OLD_DESC_MARKER'), '旧描述不得残留')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 7. describe 模式：真实工具调用返回完整 Schema、不执行 handler、边界拒绝
// ---------------------------------------------------------------------------

test('describe 模式: 真实 run_action 调用返回完整 Schema 且不执行 handler；停用/scope 外拒绝', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const host = env.app.kernel.plugins!
    let handlerRuns = 0
    const def: PluginDefinition = {
      id: 'demo:describe',
      definePlugin: (ctx) => {
        ctx.action({
          id: 'nested',
          description: '嵌套 Schema 动作',
          inputSchema: {
            type: 'object',
            properties: {
              payload: { type: 'object', properties: { deep: { type: 'string' }, list: { type: 'array', items: { type: 'number' } } } },
            },
            required: ['payload'],
          },
          outputSchema: { type: 'object', properties: { echoed: { type: 'boolean' } } },
          handler: () => {
            handlerRuns += 1
            return { echoed: true }
          },
        })
        ctx.action({
          id: 'alpha_only',
          description: '仅 alpha 会话',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          scope: { tags: ['alpha'] },
          handler: () => ({ ok: true }),
        })
      },
    }
    await host.register(def, { enabled: true })

    // describe 真实调用：经 faux 发起 run_action 工具调用
    env.faux.setResponses([
      env.toolCallStep('run_action', { actionId: 'demo:describe.nested', describe: true }),
      env.capture(),
    ])
    await env.submitAndWait(env.initialConvId, '查询嵌套 Schema')
    assert.equal(handlerRuns, 0, 'describe 模式绝不执行 handler')

    // 工具结果已入时间线：pi.tool-result 的 model 内容携带完整 manifest
    const detail = await env.app.kernel.getConversationDetail(env.initialConvId)
    const describeTexts = env.toolResultTexts(detail.entries)
    assert.ok(describeTexts.includes('demo:describe') && describeTexts.includes('nested'), 'describe 结果应真实落盘（manifest 字段）')
    // 完整 Schema 可读（嵌套字段与 outputSchema 均在结果中）
    assert.ok(describeTexts.includes('payload'), '顶层 Schema 字段应完整可读')
    assert.ok(describeTexts.includes('deep'), '嵌套 Schema 字段应完整可读')
    assert.ok(describeTexts.includes('outputSchema'), 'outputSchema 应完整可读')

    // 默认行为不变：不带 describe 真实执行 handler
    env.requests.length = 0
    env.faux.setResponses([
      env.toolCallStep('run_action', { actionId: 'demo:describe.nested', input: { payload: { deep: 'x' } } }),
      env.capture(),
    ])
    await env.submitAndWait(env.initialConvId, '真实执行')
    assert.equal(handlerRuns, 1, '默认调用应执行 handler 一次')

    // scope 外 describe 拒绝：结果文本含 scope 违规、不含 Schema 内容
    env.requests.length = 0
    env.faux.setResponses([
      env.toolCallStep('run_action', { actionId: 'demo:describe.alpha_only', describe: true }),
      env.capture(),
    ])
    await env.submitAndWait(env.initialConvId, 'scope 外查询')
    const scopedDetail = await env.app.kernel.getConversationDetail(env.initialConvId)
    const scopedText = env.toolResultTexts(scopedDetail.entries)
    assert.ok(scopedText.includes('scope'), 'scope 外 describe 应显式拒绝')

    // 停用后 describe 拒绝
    await host.disable('demo:describe')
    env.requests.length = 0
    env.faux.setResponses([
      env.toolCallStep('run_action', { actionId: 'demo:describe.nested', describe: true }),
      env.capture(),
    ])
    await env.submitAndWait(env.initialConvId, '停用后查询')
    const disabledDetail = await env.app.kernel.getConversationDetail(env.initialConvId)
    const disabledText = env.toolResultTexts(disabledDetail.entries)
    assert.ok(disabledText.includes('未声明动作'), '停用后 describe 应显式拒绝（unknown_action）')
  } finally {
    await env.close()
  }
})
