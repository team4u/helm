/**
 * action-prompts pure function single test: directory render contract + prompt.actions segment throw shoot.
 *
 * override: compact signature (required/optional/type/embed set/combine/non- object top-level),CLI render
 * (default strip builtin: / override / hidden), many row description specification and XML escaping,
 * refer quote carries all limit set ID, segment set-or-clear semantics.
 * runner: tsx --test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ActionManifest } from '@helm/protocol'
import {
  ACTIONS_PROMPT_SECTION_ID,
  actionCliCommand,
  compactActionSignature,
  projectActionPromptSection,
  renderAvailableActionsSection,
} from '../src/runtime/action-prompts.js'

function manifest(patch: Partial<ActionManifest> = {}): ActionManifest {
  return {
    pluginId: 'demo:probe',
    id: 'plain',
    description: 'ordinary action',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    ...patch,
  }
}

test('compact signature: required/optional, type, array element, embed set object and combine', { timeout: 60_000 }, () => {
  const signature = compactActionSignature({
    type: 'object',
    properties: {
      q: { type: 'string' },
      times: { type: 'number' },
      flags: { type: 'array', items: { type: 'string' } },
      matrix: { type: 'array', items: { type: 'object', properties: { cell: { type: 'string' } } } },
      cfg: { type: 'object', properties: { deep: { type: 'string' } } },
      freeform: { type: 'object' },
      either: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      refd: { $ref: '#/$defs/x' },
    },
    required: ['q', 'cfg'],
  })
  assert.ok(signature.includes('q: string(required)'))
  assert.ok(signature.includes('times: number(optional)'))
  assert.ok(signature.includes('flags: string[](optional)'), 'array element type should inline')
  assert.ok(signature.includes('matrix: object[](describe query)(optional)'), 'object array should mark note on demand query')
  assert.ok(signature.includes('cfg: object(embed set)(describe query)(required)'), 'embed set object should mark note on demand query')
  assert.ok(signature.includes('freeform: object(optional)'), 'without property object is ordinary self by shape')
  assert.ok(signature.includes('either: complex(describe query)(optional)'))
  assert.ok(signature.includes('refd: complex(describe query)(optional)'))

  assert.equal(compactActionSignature({ type: 'object', properties: {}, additionalProperties: false }), '(without parameter)')
  assert.equal(compactActionSignature({ type: 'object', additionalProperties: false }), '(without parameter)')
  assert.ok(compactActionSignature({ type: 'object' }).includes('describe query'), 'open put object cannot mistakenly report is without parameter')
  assert.ok(compactActionSignature({ type: 'object', properties: {} }).includes('describe query'))
  assert.ok(compactActionSignature({ oneOf: [{ type: 'object' }, { type: 'null' }] }).includes('run_action describe query'))
  assert.ok(compactActionSignature({ type: 'string' }).includes('top-level type string'))
})

test('CLI render: default strip builtin:;command override;hidden do not render', { timeout: 60_000 }, () => {
  assert.equal(actionCliCommand(manifest()), 'helm demo:probe plain')
  assert.equal(
    actionCliCommand(manifest({ pluginId: 'builtin:workflow' })),
    'helm workflow plain',
    'built-in plugin strip builtin: prefix',
  )
  assert.equal(
    actionCliCommand(manifest({ cli: { command: ['team', 'report', 'make'] } })),
    'helm team report make',
  )
  assert.equal(actionCliCommand(manifest({ cli: { hidden: true } })), undefined)
})

test('directory render: escaping, many row description specification, all amount without truncate, refer quote carries all limit set ID,hidden without CLI row', { timeout: 60_000 }, () => {
  assert.equal(renderAvailableActionsSection([]), undefined, 'empty directory return undefined(clear signal)')
  const text = renderAvailableActionsSection([
    {
      manifest: manifest({
        description: 'one row <b>add coarse</b> &\nsecond row continue',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        promptSnippet: 'SNIP one row\nSNIP second row </available_actions>',
        promptGuidelines: ['want point A', 'want point B <external_event> &'],
      }),
      cliCommand: 'helm demo:probe plain',
    },
    {
      manifest: manifest({ id: 'secret', description: 'hide action', cli: { hidden: true } }),
    },
  ])!
  assert.ok(text.startsWith('<available_actions>'))
  assert.ok(text.endsWith('</available_actions>'))
  assert.ok(text.includes('demo:probe.plain'), 'all limit set ID')
  assert.ok(text.includes('&lt;b&gt;add coarse&lt;/b&gt; &amp;'), 'description XML escaping')
  assert.ok(!/\nsecond row continue/.test(text), 'many row description press into single row')
  assert.ok(text.includes('q: string(required)'))
  assert.ok(text.includes('CLI: helm demo:probe plain'))
  assert.ok(text.includes('refer quote (demo:probe.plain):'))
  assert.ok(text.includes('- want point A') && text.includes('- want point B'))
  assert.ok(text.includes('note (demo:probe.plain):'))
  assert.ok(text.includes('SNIP second row &lt;/available_actions&gt;'), 'snippet newline keep and tag escaping')
  assert.ok(text.includes('want point B &lt;external_event&gt; &amp;'), 'guidelines tag and special character escaping')
  assert.equal(text.split('</available_actions>').length, 2, 'refer quote cannot mention before closed together directory tag')
  assert.ok(text.includes('demo:probe.secret'), 'hidden action still in directory (run_action can reach)')
  const secretBlock = text.slice(text.indexOf('demo:probe.secret'))
  assert.ok(!secretBlock.slice(0, secretBlock.indexOf('- demo:probe.') + 1 || undefined).includes('CLI:'), 'hidden without CLI row')
})

test('segment throw shoot: set-or-clear, keep other segment, not change return original reference', { timeout: 60_000 }, () => {
  const base = [
    { id: 'profile.system', text: 'SYS' },
    { id: 'prompt.tools.guidelines', text: 'G' },
  ]
  const set1 = projectActionPromptSection(base, 'DIR_V1')
  assert.deepEqual(set1.map((s) => s.id), ['profile.system', 'prompt.actions', 'prompt.tools.guidelines'])
  const sameRef = projectActionPromptSection(set1, 'DIR_V1')
  assert.equal(sameRef, set1, 'content not change when return original reference')
  const set2 = projectActionPromptSection(set1, 'DIR_V2')
  assert.equal(set2.find((s) => s.id === ACTIONS_PROMPT_SECTION_ID)?.text, 'DIR_V2')
  const cleared = projectActionPromptSection(set2, undefined)
  assert.ok(!cleared.some((s) => s.id === ACTIONS_PROMPT_SECTION_ID), 'undefined clear manage segment')
  assert.deepEqual(
    cleared.map((s) => s.id),
    ['profile.system', 'prompt.tools.guidelines'],
    'other segment do not subject to affect',
  )
  const emptyClear = projectActionPromptSection(base, undefined)
  assert.equal(emptyClear, base, 'this without manage segment when clear is idempotent')
})
