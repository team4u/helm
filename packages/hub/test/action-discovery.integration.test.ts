/**
 * action discover runtime collection into verify (createHelm real combine + faux provider eventually model request).
 *
 * override (all assertion in real provider request payload on, do not mock runtime):
 * - ordinary plugin action (without exposeAsTool): enable after <available_actions> directory (prompt.actions segment)
 *   enter eventually model request; deactivate after under one turn disappear (without phantom leftover);
 * - scope: does not match conversation (tags/modelProviders) does not enter directory;exposeAsTool derive tool declaration
 *   do not leak enter scope outside conversation request (request level trim),scope inside conversation normal available;
 * - run_action by before_turn hook strip when directory clear; directly action tool by hook strip when do not via directory re-;
 * - two invoke path refer quote only inject once (exposeAsTool away prompt.tools.*, non- direct throw away prompt.actions);
 * - CLI override / hidden render; description/metadata update do not old hint;
 * - describe pattern real tool invoke: complete Schema return,handler do not execute, deactivate and scope outside reject.
 *
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock.
 */
import { test } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import type { ConversationEntry, ConversationSummary, PluginDefinition } from '@helm/protocol'
import { openHubTestEnv, type FauxProviderHandle, type HubTestApp } from './helpers/hub-test-env.js'
import assert from 'node:assert/strict'

/** catch single time eventually model request (back put semantics collapse after view). */
interface CapturedRequest {
  toolNames: string[]
  /** all system message sections collapse view (and kernel systemSectionsOf same opening path). */
  sectionsById: Record<string, string | null>
}

interface TestEnv {
  dataDir: string
  faux: FauxProviderHandle
  app: HubTestApp
  requests: CapturedRequest[]
  initialConvId: number
  capture(): FauxResponseStep
  toolCallStep(name: string, input: Record<string, unknown>): FauxResponseStep
  submitAndWait(convId: number, text: string): Promise<void>
  createTaggedConversation(tags: string[]): Promise<ConversationSummary>
  /** conversation timeline all tool result text (pi.tool-result  model content serialization). */
  toolResultTexts(entries: ConversationEntry[]): string
  close(): Promise<void>
}

async function makeEnv(): Promise<TestEnv> {
  const { dataDir, faux, app, close } = await openHubTestEnv({ prefix: 'helm-action-discovery-' })
  const initialConv = app.kernel
    .listConversations()
    .find((c) => c.profileId === 'assistant' && c.parentConversationId === undefined)
  if (initialConv === undefined) throw new Error('initial conversation missing')

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
    return fauxAssistantMessage('already catch request')
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
    close,
  }
  return env
}

/** directory segment text (missing when undefined). */
function actionsSection(request: CapturedRequest): string | null | undefined {
  return request.sectionsById['prompt.actions']
}

// ---------------------------------------------------------------------------
// 1. ordinary external plugin action: enable i.e. directory, directory content contract, deactivate after under one turn disappear
// ---------------------------------------------------------------------------

test('action directory: only ctx.action ordinary plugin - - enable i.e. appear in eventually request, deactivate after under one turn clear and no residue', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const host = env.app.kernel.plugins!
    const def: PluginDefinition = {
      id: 'demo:plain',
      definePlugin: (ctx) => {
        ctx.action({
          id: 'greet',
          description: 'many row description one row\nsecond row contains <xml> and & symbol',
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
    await env.submitAndWait(env.initialConvId, 'one turn')
    const first = env.requests[0]!
    const section = actionsSection(first)
    assert.ok(section, 'enable after eventually model request should contains prompt.actions directory segment')
    assert.ok(section.includes('<available_actions>'), 'directory should has XML surround column')
    assert.ok(section.includes('demo:plain.greet'), 'directory should contains all limit set action ID')
    // many row description specification is one row + XML escaping
    assert.ok(!section.includes('\nsecond row'), 'many row description should press into single row')
    assert.ok(section.includes('&lt;xml&gt;'), 'description in XML should escaping')
    assert.ok(section.includes('&amp;'), 'description in & should escaping')
    // compact signature: required/optional + type + embed set mark note
    assert.ok(section.includes('name: string(required)'))
    assert.ok(section.includes('times: number(optional)'))
    assert.ok(section.includes('config: object(embed set)(describe query)(optional)'), 'embed set object should mark note on demand query')
    assert.ok(section.includes('tags: string[](optional)'))
    // default CLI:helm <pluginId strip builtin:> <actionId>
    assert.ok(section.includes('CLI: helm demo:plain greet'))
    // directory quote lead describe and helm actions list
    assert.ok(section.includes('describe: true'))
    assert.ok(section.includes('helm actions list --json'))

    // deactivate: under one turn directory no longer contains the plugin action (built-in plugin action still in directory belong normal);
    // segment inside without old text leftover, also missing points to deactivated action any prompt.actions phantom segment
    await host.disable('demo:plain')
    env.requests.length = 0
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, 'second turn')
    const second = env.requests[0]!
    const secondSection = actionsSection(second) ?? ''
    assert.ok(!secondSection.includes('demo:plain'), 'deactivate after directory must not leftover demo:plain action')
    for (const [id, text] of Object.entries(second.sectionsById)) {
      if (id === 'prompt.actions') continue
      assert.ok(!((text ?? '')).includes('demo:plain.greet'), `other segment ${id} must not leftover deactivated action text`)
    }
    // again patch one turn: confirm refresh old directory (contains escaping after description) will not via back put re-
    env.requests.length = 0
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, 'third turn')
    const third = env.requests[0]!
    assert.ok(!((actionsSection(third) ?? '')).includes('&lt;xml&gt;'), 'old directory text must not via back put re-')
  } finally {
    await env.close()
  }
})

test('disk external plugin: rescan after by default hide, enable i.e. automatically discover, deactivate i.e. clean up', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const host = env.app.kernel.plugins!
    const pluginDir = join(env.dataDir, 'plugins', 'external-notice')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({
      id: 'external-notice', name: 'external notify', version: '1.0.0', main: 'index.mjs',
    }))
    writeFileSync(join(pluginDir, 'index.mjs'), `export default {
      id: 'external-notice',
      definePlugin(ctx) {
        ctx.action({
          id: 'send', description: 'from disk external plugin notify action',
          promptGuidelines: ['EXTERNAL_NOTICE_GUIDE core for piece person and notify content'],
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
          outputSchema: { type: 'object', properties: { delivered: { type: 'boolean' } }, required: ['delivered'] },
          handler() { return { delivered: true } },
        })
      },
    }`)
    const rescanned = await host.rescanExternalPlugins()
    assert.ok(rescanned.registered.includes('external-notice'), 'must via real external load register')
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, 'external plugin enable before')
    assert.ok(!actionsSection(env.requests.at(-1)!)?.includes('external-notice'))

    await host.enable('external-notice')
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, 'external plugin enable after')
    const section = actionsSection(env.requests.at(-1)!)!
    assert.ok(section.includes('external-notice.send'))
    assert.ok(section.includes('EXTERNAL_NOTICE_GUIDE'))
    assert.ok(section.includes('CLI: helm external-notice send'))

    await host.disable('external-notice')
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, 'external plugin deactivate after')
    assert.ok(!actionsSection(env.requests.at(-1)!)?.includes('external-notice'))
    assert.ok(!JSON.stringify(env.requests.at(-1)!.sectionsById).includes('EXTERNAL_NOTICE_GUIDE'))
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 2. scope: directory and exposeAsTool tool declaration request level filter
// ---------------------------------------------------------------------------

test('action directory scope: does not match conversation does not enter directory;exposeAsTool derive tool declaration do not leak enter scope outside conversation request', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const host = env.app.kernel.plugins!
    const def: PluginDefinition = {
      id: 'demo:scoped',
      definePlugin: (ctx) => {
        ctx.action({
          id: 'plain_scoped',
          description: 'only alpha conversation available',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          scope: { tags: ['alpha'] },
          handler: () => ({ ok: true }),
        })
        ctx.action({
          id: 'direct_scoped',
          description: 'only alpha conversation available direct throw action',
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

    // scope outside (without tag) conversation: directory excludes the plugin action; direct throw tool declaration do not leak
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, 'scope outside conversation')
    const outside = env.requests[0]!
    const outsideSection = actionsSection(outside)
    assert.ok(outsideSection === undefined || !(outsideSection ?? '').includes('demo:scoped'), 'scope outside directory must not contains scoped action')
    const leakedDirect = outside.toolNames.find((name) => name.includes('direct_scoped'))
    assert.equal(leakedDirect, undefined, 'scope outside request must not leak exposeAsTool derive tool declaration')
    assert.ok(outside.toolNames.includes('run_action'), 'kernel tool do not subject to scope trim affect')

    // scope inside (alpha tag) conversation: directory contains plain_scoped; direct throw tool declaration store in
    env.requests.length = 0
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(alphaConv.id, 'scope inside conversation')
    const inside = env.requests[0]!
    const insideSection = actionsSection(inside)
    assert.ok(insideSection, 'scope inside conversation should has directory segment')
    assert.ok(insideSection!.includes('demo:scoped.plain_scoped'), 'directory should contains scope hit ordinary action')
    assert.ok(!insideSection!.includes('demo:scoped.direct_scoped'), 'exposeAsTool direct throw action does not enter run_action directory')
    assert.ok(
      inside.toolNames.some((name) => name.includes('direct_scoped')),
      'scope inside exposeAsTool derive tool declaration should store in',
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 3. run_action by hook strip: directory clear; direct throw action tool by strip: do not via directory re-
// ---------------------------------------------------------------------------

test('action directory can reach: before_turn strip run_action when directory clear; direct throw tool strip after do not via directory re-', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const host = env.app.kernel.plugins!
    // first register ordinary action plugin (directory store in)
    const plainDef: PluginDefinition = {
      id: 'demo:reach',
      definePlugin: (ctx) => {
        ctx.action({
          id: 'probe',
          description: 'probe action',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          handler: () => ({ ok: true }),
        })
        ctx.action({
          id: 'direct_one',
          description: 'direct throw action',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          exposeAsTool: true,
          handler: () => ({ ok: true }),
        })
      },
    }
    await host.register(plainDef, { enabled: true })

    // again register strip hook plugin (priority high at by default, after register first execute by priority decide)
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
    await env.submitAndWait(env.initialConvId, 'strip turn')
    const request = env.requests[0]!
    assert.equal(actionsSection(request), undefined, 'run_action by strip after directory must clear')
    assert.ok(!request.toolNames.includes('run_action'), 'run_action should by strip')
    assert.ok(
      !request.toolNames.some((name) => name.includes('direct_one')),
      'direct throw action tool should by strip',
    )
    // direct throw action must not borrow directory re- (directory whole already clean; i.e. convenient not come by action decide also must not appear direct_one)
    const allSectionText = Object.values(request.sectionsById).join('\n')
    assert.ok(!allSectionText.includes('demo:reach.direct_one'), 'by strip direct throw action must not via directory re-')

    // remove strip hook (deactivate stripper):run_action restore → directory restore, direct throw action back tool channel
    await host.disable('demo:stripper')
    env.requests.length = 0
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, 'restore turn')
    const restored = env.requests[0]!
    assert.ok(restored.toolNames.includes('run_action'))
    assert.ok(actionsSection(restored)?.includes('demo:reach.probe'), 'run_action restore after directory restore')
    assert.ok(
      restored.toolNames.some((name) => name.includes('direct_one')),
      'direct throw action tool restore declaration',
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 4. refer quote only inject once:exposeAsTool away prompt.tools.*, non- direct throw away prompt.actions
// ---------------------------------------------------------------------------

test('refer quote single time inject: exposeAsTool action refer quote away tool pipeline; non- direct throw action refer quote only appear in directory and carries all limit set ID', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const host = env.app.kernel.plugins!
    const def: PluginDefinition = {
      id: 'demo:guide',
      definePlugin: (ctx) => {
        ctx.action({
          id: 'direct_guided',
          description: 'direct throw carries refer quote',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          exposeAsTool: true,
          promptSnippet: 'DIRECT_SNIPPET_MARKER direct throw dedicated belong segment',
          promptGuidelines: ['DIRECT_GUIDELINE_MARKER direct throw want point'],
          handler: () => ({ ok: true }),
        })
        ctx.action({
          id: 'plain_guided',
          description: 'ordinary action carries refer quote',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          promptSnippet: 'PLAIN_SNIPPET_MARKER ordinary action segment\nsecond row',
          promptGuidelines: ['PLAIN_GUIDELINE_MARKER ordinary action want point'],
          handler: () => ({ ok: true }),
        })
      },
    }
    await host.register(def, { enabled: true })

    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, 'refer quote turn')
    const request = env.requests[0]!
    const section = actionsSection(request)
    assert.ok(section, 'directory segment should store in')

    // direct throw refer quote: only via prompt.tools.* tool pipeline, does not enter directory
    const directToolSection = Object.entries(request.sectionsById)
      .filter(([id]) => id.startsWith('prompt.tools.'))
      .map(([, text]) => text ?? '')
      .join('\n')
    assert.ok(directToolSection.includes('DIRECT_SNIPPET_MARKER'), 'direct throw promptSnippet should via tool pipeline inject')
    assert.ok(directToolSection.includes('DIRECT_GUIDELINE_MARKER'), 'direct throw promptGuidelines should via tool pipeline inject')
    assert.ok(!section!.includes('DIRECT_SNIPPET_MARKER'), 'direct throw refer quote must not duplicate enter directory')
    assert.ok(!section!.includes('DIRECT_GUIDELINE_MARKER'), 'direct throw want point must not duplicate enter directory')

    // non- direct throw refer quote: only in directory segment, carries all limit set ID mark note
    assert.ok(section!.includes('PLAIN_SNIPPET_MARKER'), 'ordinary action promptSnippet should enter directory')
    assert.ok(section!.includes('PLAIN_GUIDELINE_MARKER'), 'ordinary action promptGuidelines should enter directory')
    assert.ok(section!.includes('refer quote (demo:guide.plain_guided)'), 'directory refer quote should carries all limit set ID mark note')
    assert.ok(section!.includes('note (demo:guide.plain_guided)'), 'directory note should carries all limit set ID mark note')
    assert.ok(!directToolSection.includes('PLAIN_SNIPPET_MARKER'), 'ordinary action refer quote must not enter tool pipeline')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 5. CLI render:command override takes effect;hidden do not render CLI
// ---------------------------------------------------------------------------

test('CLI render: cli.command override render real command;cli.hidden do not render CLI', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const host = env.app.kernel.plugins!
    const def: PluginDefinition = {
      id: 'demo:cli',
      definePlugin: (ctx) => {
        ctx.action({
          id: 'custom_path',
          description: 'override command path',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          cli: { command: ['team', 'report', 'make'] },
          handler: () => ({ ok: true }),
        })
        ctx.action({
          id: 'secret_cmd',
          description: 'hide CLI action',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          cli: { hidden: true },
          handler: () => ({ ok: true }),
        })
      },
    }
    await host.register(def, { enabled: true })

    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, 'CLI render turn')
    const section = actionsSection(env.requests[0]!)!
    assert.ok(section.includes('CLI: helm team report make'), 'cli.command override should render real command')
    // hidden: action still in directory (run_action can reach), but do not render missing CLI
    assert.ok(section.includes('demo:cli.secret_cmd'), 'hidden action still in directory (run_action can reach)')
    const secretIdx = section.indexOf('demo:cli.secret_cmd')
    const nextEntry = section.indexOf('- demo:cli.', secretIdx + 1)
    const secretBlock = section.slice(secretIdx, nextEntry === -1 ? section.length : nextEntry)
    assert.ok(!secretBlock.includes('CLI:'), 'hidden action must not render CLI row')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 6. metadata update:reload after directory by new metadata render, do not old hint
// ---------------------------------------------------------------------------

test('metadata update: plugin reload after directory by new description render, old text leaves no residue', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const host = env.app.kernel.plugins!
    let description = 'old description text OLD_DESC_MARKER'
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
    await env.submitAndWait(env.initialConvId, 'update before turn')
    assert.ok(actionsSection(env.requests[0]!)!.includes('OLD_DESC_MARKER'), 'update before directory contains old description')

    // hot update: deactivate→deregister→heavy register (persist deactivate state takes precedence, must explicit enable; real capability change path)
    description = 'new description text NEW_DESC_MARKER'
    await host.disable('demo:refresh')
    await host.unregister('demo:refresh')
    await host.register(def())
    await host.enable('demo:refresh')

    env.requests.length = 0
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, 'update after turn')
    const section = actionsSection(env.requests[0]!)!
    assert.ok(section.includes('NEW_DESC_MARKER'), 'update after directory contains new description')
    assert.ok(!section.includes('OLD_DESC_MARKER'), 'old description must not leftover')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 7. describe pattern: real tool invoke return complete Schema, do not execute handler, boundary reject
// ---------------------------------------------------------------------------

test('describe pattern: real run_action invoke return complete Schema and do not execute handler; deactivate/scope outside reject', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const host = env.app.kernel.plugins!
    let handlerRuns = 0
    const def: PluginDefinition = {
      id: 'demo:describe',
      definePlugin: (ctx) => {
        ctx.action({
          id: 'nested',
          description: 'embed set Schema action',
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
          description: 'only alpha conversation',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          scope: { tags: ['alpha'] },
          handler: () => ({ ok: true }),
        })
      },
    }
    await host.register(def, { enabled: true })

    // describe real invoke: via faux start run_action tool invoke
    env.faux.setResponses([
      env.toolCallStep('run_action', { actionId: 'demo:describe.nested', describe: true }),
      env.capture(),
    ])
    await env.submitAndWait(env.initialConvId, 'query embed set Schema')
    assert.equal(handlerRuns, 0, 'describe pattern never execute handler')

    // tool result already timeline:pi.tool-result  model content carry complete manifest
    const detail = await env.app.kernel.getConversationDetail(env.initialConvId)
    const describeTexts = env.toolResultTexts(detail.entries)
    assert.ok(describeTexts.includes('demo:describe') && describeTexts.includes('nested'), 'describe result should real (manifest field)')
    // complete Schema can read (embed set field and outputSchema all in result in)
    assert.ok(describeTexts.includes('payload'), 'top-level Schema field should complete can read')
    assert.ok(describeTexts.includes('deep'), 'embed set Schema field should complete can read')
    assert.ok(describeTexts.includes('outputSchema'), 'outputSchema should complete can read')

    // by default behavior do not change: do not carries describe real execute handler
    env.requests.length = 0
    env.faux.setResponses([
      env.toolCallStep('run_action', { actionId: 'demo:describe.nested', input: { payload: { deep: 'x' } } }),
      env.capture(),
    ])
    await env.submitAndWait(env.initialConvId, 'real execute')
    assert.equal(handlerRuns, 1, 'by default invoke should execute handler once')

    // scope outside describe reject: result text contains scope violate rule, excludes Schema content
    env.requests.length = 0
    env.faux.setResponses([
      env.toolCallStep('run_action', { actionId: 'demo:describe.alpha_only', describe: true }),
      env.capture(),
    ])
    await env.submitAndWait(env.initialConvId, 'scope outside query')
    const scopedDetail = await env.app.kernel.getConversationDetail(env.initialConvId)
    const scopedText = env.toolResultTexts(scopedDetail.entries)
    assert.ok(scopedText.includes('scope'), 'scope outside describe should explicit reject')

    // deactivate after describe reject
    await host.disable('demo:describe')
    env.requests.length = 0
    env.faux.setResponses([
      env.toolCallStep('run_action', { actionId: 'demo:describe.nested', describe: true }),
      env.capture(),
    ])
    await env.submitAndWait(env.initialConvId, 'deactivate after query')
    const disabledDetail = await env.app.kernel.getConversationDetail(env.initialConvId)
    const disabledText = env.toolResultTexts(disabledDetail.entries)
    assert.ok(disabledText.includes('not declaration action'), 'deactivate after describe should explicit reject (unknown_action)')
  } finally {
    await env.close()
  }
})
