/**
 * Action discovery runtime integration verification (`createHelm` real composition + faux provider final model requests).
 *
 * Covers (all assertions on real provider request payloads, without mocking runtime):
 * - Normal plugin action (no `exposeAsTool`): appears in `<available_actions>` catalog (`prompt.actions` section)
 *   upon enablement and disappears on the next turn after disablement (no phantom residue);
 * - Scope: non-matching conversations (`tags`/`modelProviders`) omit scoped actions from the catalog;
 *   `exposeAsTool` tool declarations never leak into out-of-scope requests (request-level trimming), while working inside scope;
 * - Catalog clears when `run_action` is stripped by `before_turn`; stripped direct-tool actions never re-enter via catalog;
 * - Guidance (`promptSnippet`/`promptGuidelines`) injects only once per path (`exposeAsTool` via `prompt.tools.*`, others via `prompt.actions`);
 * - CLI overrides / hidden rendering; description/metadata updates leave no stale prompt residue;
 * - `describe` mode via real tool calls: returns full Schema without executing `handler`, rejects when disabled or out of scope.
 *
 * Runner: `tsx --test`; every test declares `{ timeout: 60_000 }` against deadlocks.
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

/** Captured final model request (collapsed view after system prompt folding). */
interface CapturedRequest {
  toolNames: string[]
  /** Collapsed view of all system message sections (same folding path as kernel `systemSectionsOf`). */
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
  /** Serialized model contents of all `pi.tool-result` entries in the conversation timeline. */
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

/** Action catalog section text (`undefined` when absent). */
function actionsSection(request: CapturedRequest): string | null | undefined {
  return request.sectionsById['prompt.actions']
}

// ---------------------------------------------------------------------------
// 1. Plain external plugin action: appears in catalog on enable, vanishes next turn on disable
// ---------------------------------------------------------------------------

test('action catalog: plain ctx.action plugin appears on enable and vanishes cleanly next turn after disable', { timeout: 60_000 }, async () => {
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
    assert.ok(section, 'final model request after enabling should include prompt.actions catalog section')
    assert.ok(section.includes('<available_actions>'), 'catalog should be wrapped in XML tags')
    assert.ok(section.includes('demo:plain.greet'), 'catalog should contain qualified action ID')
    // Multi-line description normalized to single line + XML-escaped.
    assert.ok(!section.includes('\nsecond row'), 'multi-line description should collapse to a single line')
    assert.ok(section.includes('&lt;xml&gt;'), 'XML angle brackets in description should be escaped')
    assert.ok(section.includes('&amp;'), 'ampersands in description should be escaped')
    // Compact signature: required/optional + type + nested marker.
    assert.ok(section.includes('name: string(required)'))
    assert.ok(section.includes('times: number(optional)'))
    assert.ok(section.includes('config: object(embed set)(describe query)(optional)'), 'nested objects should indicate on-demand describe query')
    assert.ok(section.includes('tags: string[](optional)'))
    // Default CLI: `helm <pluginId without builtin:> <actionId>`.
    assert.ok(section.includes('CLI: helm demo:plain greet'))
    // Catalog references `describe` and `helm actions list`.
    assert.ok(section.includes('describe: true'))
    assert.ok(section.includes('helm actions list --json'))

    // Disable: next turn's catalog drops this plugin's actions (built-in actions stay);
    // no stale text or phantom prompt.actions sections pointing to the disabled action.
    await host.disable('demo:plain')
    env.requests.length = 0
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, 'second turn')
    const second = env.requests[0]!
    const secondSection = actionsSection(second) ?? ''
    assert.ok(!secondSection.includes('demo:plain'), 'catalog must not retain demo:plain after disable')
    for (const [id, text] of Object.entries(second.sectionsById)) {
      if (id === 'prompt.actions') continue
      assert.ok(!((text ?? '')).includes('demo:plain.greet'), `other section ${id} must not retain disabled action text`)
    }
    // Run one more turn: confirm old escaped description does not resurface via system prompt folding.
    env.requests.length = 0
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, 'third turn')
    const third = env.requests[0]!
    assert.ok(!((actionsSection(third) ?? '')).includes('&lt;xml&gt;'), 'old catalog text must not resurface via folding')
  } finally {
    await env.close()
  }
})

test('disk external plugin: hidden after rescan, discovered on enable, cleaned up on disable', { timeout: 60_000 }, async () => {
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
    assert.ok(rescanned.registered.includes('external-notice'), 'must register via real external loader')
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
// 2. Scope: request-level filtering for catalog and exposeAsTool declarations
// ---------------------------------------------------------------------------

test('action catalog scope: excludes non-matching conversations; exposeAsTool declarations do not leak outside scope', { timeout: 60_000 }, async () => {
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

    // Out of scope (untagged): catalog omits plugin actions; direct tool declaration does not leak.
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, 'scope outside conversation')
    const outside = env.requests[0]!
    const outsideSection = actionsSection(outside)
    assert.ok(outsideSection === undefined || !(outsideSection ?? '').includes('demo:scoped'), 'out-of-scope catalog must omit scoped actions')
    const leakedDirect = outside.toolNames.find((name) => name.includes('direct_scoped'))
    assert.equal(leakedDirect, undefined, 'out-of-scope request must not leak exposeAsTool tool declarations')
    assert.ok(outside.toolNames.includes('run_action'), 'kernel tools are unaffected by scope trimming')

    // In scope (`alpha` tag): catalog includes `plain_scoped`; direct tool declaration is present.
    env.requests.length = 0
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(alphaConv.id, 'scope inside conversation')
    const inside = env.requests[0]!
    const insideSection = actionsSection(inside)
    assert.ok(insideSection, 'in-scope conversation should include catalog section')
    assert.ok(insideSection!.includes('demo:scoped.plain_scoped'), 'catalog should include matching scoped plain action')
    assert.ok(!insideSection!.includes('demo:scoped.direct_scoped'), 'exposeAsTool action does not enter run_action catalog')
    assert.ok(
      inside.toolNames.some((name) => name.includes('direct_scoped')),
      'in-scope exposeAsTool tool declaration should be present',
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 3. Stripping run_action clears catalog; stripped direct-tool actions do not re-enter via catalog
// ---------------------------------------------------------------------------

test('action catalog reachability: stripping run_action in before_turn clears catalog; stripped direct tools stay absent', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const host = env.app.kernel.plugins!
    // Register plain + direct-tool plugin first.
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

    // Register stripping hook plugin (higher priority than default).
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
    assert.equal(actionsSection(request), undefined, 'catalog must clear once run_action is stripped')
    assert.ok(!request.toolNames.includes('run_action'), 'run_action should be stripped')
    assert.ok(
      !request.toolNames.some((name) => name.includes('direct_one')),
      'direct action tool should be stripped',
    )
    // Stripped direct actions must not sneak back through the catalog.
    const allSectionText = Object.values(request.sectionsById).join('\n')
    assert.ok(!allSectionText.includes('demo:reach.direct_one'), 'stripped direct action must not re-enter via catalog')

    // Disable stripper: `run_action` and catalog recover, direct tool returns to tool list.
    await host.disable('demo:stripper')
    env.requests.length = 0
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, 'restore turn')
    const restored = env.requests[0]!
    assert.ok(restored.toolNames.includes('run_action'))
    assert.ok(actionsSection(restored)?.includes('demo:reach.probe'), 'catalog restores once run_action is restored')
    assert.ok(
      restored.toolNames.some((name) => name.includes('direct_one')),
      'direct action tool declaration restores',
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 4. Guidance injected once: exposeAsTool via prompt.tools.*, others via prompt.actions
// ---------------------------------------------------------------------------

test('prompt guidance single injection: exposeAsTool uses tool channel; plain actions use catalog with qualified ID', { timeout: 60_000 }, async () => {
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
    assert.ok(section, 'catalog section should exist')

    // Direct-tool guidance: goes exclusively through `prompt.tools.*`, never into the catalog.
    const directToolSection = Object.entries(request.sectionsById)
      .filter(([id]) => id.startsWith('prompt.tools.'))
      .map(([, text]) => text ?? '')
      .join('\n')
    assert.ok(directToolSection.includes('DIRECT_SNIPPET_MARKER'), 'direct promptSnippet should inject via tool channel')
    assert.ok(directToolSection.includes('DIRECT_GUIDELINE_MARKER'), 'direct promptGuidelines should inject via tool channel')
    assert.ok(!section!.includes('DIRECT_SNIPPET_MARKER'), 'direct promptSnippet must not duplicate into catalog')
    assert.ok(!section!.includes('DIRECT_GUIDELINE_MARKER'), 'direct promptGuidelines must not duplicate into catalog')

    // Plain action guidance: stays exclusively in the catalog with qualified action ID labels.
    assert.ok(section!.includes('PLAIN_SNIPPET_MARKER'), 'plain action promptSnippet should appear in catalog')
    assert.ok(section!.includes('PLAIN_GUIDELINE_MARKER'), 'plain action promptGuidelines should appear in catalog')
    assert.ok(section!.includes('refer quote (demo:guide.plain_guided)'), 'catalog snippet heading should include qualified ID')
    assert.ok(section!.includes('note (demo:guide.plain_guided)'), 'catalog guideline heading should include qualified ID')
    assert.ok(!directToolSection.includes('PLAIN_SNIPPET_MARKER'), 'plain action guidance must not enter tool channel')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 5. CLI rendering: command override applies; hidden omits CLI line
// ---------------------------------------------------------------------------

test('CLI rendering: cli.command override renders custom command; cli.hidden omits CLI line', { timeout: 60_000 }, async () => {
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
    assert.ok(section.includes('CLI: helm team report make'), 'cli.command override should render custom command')
    // Hidden: action still appears in catalog (reachable via run_action), without a CLI line.
    assert.ok(section.includes('demo:cli.secret_cmd'), 'hidden action still appears in catalog for run_action')
    const secretIdx = section.indexOf('demo:cli.secret_cmd')
    const nextEntry = section.indexOf('- demo:cli.', secretIdx + 1)
    const secretBlock = section.slice(secretIdx, nextEntry === -1 ? section.length : nextEntry)
    assert.ok(!secretBlock.includes('CLI:'), 'hidden action must not render a CLI line')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 6. Metadata updates: reload refreshes catalog without stale text
// ---------------------------------------------------------------------------

test('metadata update: plugin reload renders new description in catalog with no stale residue', { timeout: 60_000 }, async () => {
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
    assert.ok(actionsSection(env.requests[0]!)!.includes('OLD_DESC_MARKER'), 'catalog before update contains old description')

    // Hot update: disable -> unregister -> re-register (persisted disabled state takes precedence, so enable explicitly).
    description = 'new description text NEW_DESC_MARKER'
    await host.disable('demo:refresh')
    await host.unregister('demo:refresh')
    await host.register(def())
    await host.enable('demo:refresh')

    env.requests.length = 0
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(env.initialConvId, 'update after turn')
    const section = actionsSection(env.requests[0]!)!
    assert.ok(section.includes('NEW_DESC_MARKER'), 'catalog after update contains new description')
    assert.ok(!section.includes('OLD_DESC_MARKER'), 'old description must not remain')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 7. describe mode: real tool call returns full Schema without executing handler; rejects out of scope/disabled
// ---------------------------------------------------------------------------

test('describe mode: real run_action call returns full Schema without running handler; rejects disabled/out-of-scope', { timeout: 60_000 }, async () => {
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

    // Real `describe` invocation via faux `run_action` tool call.
    env.faux.setResponses([
      env.toolCallStep('run_action', { actionId: 'demo:describe.nested', describe: true }),
      env.capture(),
    ])
    await env.submitAndWait(env.initialConvId, 'query embed set Schema')
    assert.equal(handlerRuns, 0, 'describe mode must never execute handler')

    // Tool result persisted in timeline: `pi.tool-result` model content holds the full manifest.
    const detail = await env.app.kernel.getConversationDetail(env.initialConvId)
    const describeTexts = env.toolResultTexts(detail.entries)
    assert.ok(describeTexts.includes('demo:describe') && describeTexts.includes('nested'), 'describe result should include manifest identifiers')
    // Full nested Schema is readable (nested fields and outputSchema included).
    assert.ok(describeTexts.includes('payload'), 'top-level Schema field should be readable')
    assert.ok(describeTexts.includes('deep'), 'nested Schema field should be readable')
    assert.ok(describeTexts.includes('outputSchema'), 'outputSchema should be readable')

    // Default behavior unchanged: omitting `describe` executes the handler.
    env.requests.length = 0
    env.faux.setResponses([
      env.toolCallStep('run_action', { actionId: 'demo:describe.nested', input: { payload: { deep: 'x' } } }),
      env.capture(),
    ])
    await env.submitAndWait(env.initialConvId, 'real execute')
    assert.equal(handlerRuns, 1, 'normal invocation should execute handler once')

    // Out-of-scope describe rejects with scope violation without leaking Schema.
    env.requests.length = 0
    env.faux.setResponses([
      env.toolCallStep('run_action', { actionId: 'demo:describe.alpha_only', describe: true }),
      env.capture(),
    ])
    await env.submitAndWait(env.initialConvId, 'scope outside query')
    const scopedDetail = await env.app.kernel.getConversationDetail(env.initialConvId)
    const scopedText = env.toolResultTexts(scopedDetail.entries)
    assert.ok(scopedText.includes('scope'), 'out-of-scope describe should reject explicitly')

    // Disabled plugin describe rejects.
    await host.disable('demo:describe')
    env.requests.length = 0
    env.faux.setResponses([
      env.toolCallStep('run_action', { actionId: 'demo:describe.nested', describe: true }),
      env.capture(),
    ])
    await env.submitAndWait(env.initialConvId, 'deactivate after query')
    const disabledDetail = await env.app.kernel.getConversationDetail(env.initialConvId)
    const disabledText = env.toolResultTexts(disabledDetail.entries)
    assert.ok(disabledText.includes('does not declare action'), 'disabled plugin describe should reject explicitly (unknown_action)')
  } finally {
    await env.close()
  }
})
