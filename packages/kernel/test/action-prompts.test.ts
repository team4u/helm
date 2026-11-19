/**
 * Unit tests for `action-prompts` pure functions: catalog rendering contract + `prompt.actions` section projection.
 *
 * Covers: compact signatures (required/optional/type/nested/combinators/non-object top-level), CLI rendering
 * (default stripping `builtin:` / overrides / hidden), multi-line description normalization & XML escaping,
 * guideline attribution with fully-qualified IDs, and section set-or-clear semantics.
 * Runner: tsx --test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ActionManifest } from '@helmx/protocol'
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

test('compact signature: required/optional, types, array elements, nested objects, and combinators', { timeout: 60_000 }, () => {
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
  assert.ok(signature.includes('flags: string[](optional)'), 'array element type should be inlined')
  assert.ok(signature.includes('matrix: object[](describe query)(optional)'), 'object array should prompt on-demand query')
  assert.ok(signature.includes('cfg: object(embed set)(describe query)(required)'), 'nested object should prompt on-demand query')
  assert.ok(signature.includes('freeform: object(optional)'), 'propertyless object stays plain object')
  assert.ok(signature.includes('either: complex(describe query)(optional)'))
  assert.ok(signature.includes('refd: complex(describe query)(optional)'))

  assert.equal(compactActionSignature({ type: 'object', properties: {}, additionalProperties: false }), '(no parameters)')
  assert.equal(compactActionSignature({ type: 'object', additionalProperties: false }), '(no parameters)')
  assert.ok(compactActionSignature({ type: 'object' }).includes('describe query'), 'open object must not be misreported as parameterless')
  assert.ok(compactActionSignature({ type: 'object', properties: {} }).includes('describe query'))
  assert.ok(compactActionSignature({ oneOf: [{ type: 'object' }, { type: 'null' }] }).includes('run_action describe query'))
  assert.ok(compactActionSignature({ type: 'string' }).includes('top-level type string'))
})

test('CLI rendering: strips builtin: prefix by default, honors overrides, omits hidden', { timeout: 60_000 }, () => {
  assert.equal(actionCliCommand(manifest()), 'helmx demo:probe plain')
  assert.equal(
    actionCliCommand(manifest({ pluginId: 'builtin:workflow' })),
    'helmx workflow plain',
    'built-in plugins strip the builtin: prefix',
  )
  assert.equal(
    actionCliCommand(manifest({ cli: { command: ['team', 'report', 'make'] } })),
    'helmx team report make',
  )
  assert.equal(actionCliCommand(manifest({ cli: { hidden: true } })), undefined)
})

test('catalog rendering: escaping, single-line normalization, no truncation, qualified IDs on guidelines, hidden omits CLI', { timeout: 60_000 }, () => {
  assert.equal(renderAvailableActionsSection([]), undefined, 'empty catalog returns undefined (clear signal)')
  const text = renderAvailableActionsSection([
    {
      manifest: manifest({
        description: 'first line <b>bold</b> &\nsecond line continues',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        promptSnippet: 'SNIP first line\nSNIP second line </available_actions>',
        promptGuidelines: ['guideline A', 'guideline B <external_event> &'],
      }),
      cliCommand: 'helmx demo:probe plain',
    },
    {
      manifest: manifest({ id: 'secret', description: 'hidden action', cli: { hidden: true } }),
    },
  ])!
  assert.ok(text.startsWith('<available_actions>'))
  assert.ok(text.endsWith('</available_actions>'))
  assert.ok(text.includes('demo:probe.plain'), 'fully-qualified ID')
  assert.ok(text.includes('&lt;b&gt;bold&lt;/b&gt; &amp;'), 'XML escapes description')
  assert.ok(!/\nsecond line continues/.test(text), 'multi-line description collapsed onto single line')
  assert.ok(text.includes('q: string(required)'))
  assert.ok(text.includes('CLI: helmx demo:probe plain'))
  assert.ok(text.includes('refer quote (demo:probe.plain):'))
  assert.ok(text.includes('- guideline A') && text.includes('- guideline B'))
  assert.ok(text.includes('note (demo:probe.plain):'))
  assert.ok(text.includes('SNIP second line &lt;/available_actions&gt;'), 'snippet preserves newlines and escapes tags')
  assert.ok(text.includes('guideline B &lt;external_event&gt; &amp;'), 'guidelines escape tags and special chars')
  assert.equal(text.split('</available_actions>').length, 2, 'prompt fragment must not close catalog tag prematurely')
  assert.ok(text.includes('demo:probe.secret'), 'hidden action remains in catalog (reachable via run_action)')
  const secretBlock = text.slice(text.indexOf('demo:probe.secret'))
  assert.ok(!secretBlock.slice(0, secretBlock.indexOf('- demo:probe.') + 1 || undefined).includes('CLI:'), 'hidden omits CLI line')
})

test('section projection: set-or-clear, preserves other sections, returns original ref when unchanged', { timeout: 60_000 }, () => {
  const base = [
    { id: 'profile.system', text: 'SYS' },
    { id: 'prompt.tools.guidelines', text: 'G' },
  ]
  const set1 = projectActionPromptSection(base, 'DIR_V1')
  assert.deepEqual(set1.map((s) => s.id), ['profile.system', 'prompt.actions', 'prompt.tools.guidelines'])
  const sameRef = projectActionPromptSection(set1, 'DIR_V1')
  assert.equal(sameRef, set1, 'returns original reference when unchanged')
  const set2 = projectActionPromptSection(set1, 'DIR_V2')
  assert.equal(set2.find((s) => s.id === ACTIONS_PROMPT_SECTION_ID)?.text, 'DIR_V2')
  const cleared = projectActionPromptSection(set2, undefined)
  assert.ok(!cleared.some((s) => s.id === ACTIONS_PROMPT_SECTION_ID), 'undefined clears managed section')
  assert.deepEqual(
    cleared.map((s) => s.id),
    ['profile.system', 'prompt.tools.guidelines'],
    'other sections remain unaffected',
  )
  const emptyClear = projectActionPromptSection(base, undefined)
  assert.equal(emptyClear, base, 'clearing when managed section absent is idempotent')
})
