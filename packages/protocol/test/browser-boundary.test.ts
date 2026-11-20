import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import * as browserExports from '../src/browser.js'
import * as rootExports from '../src/index.js'
import {
  KNOWN_PLUGIN_UI_SURFACES,
  parsePluginUiContribution,
  type KnownPluginUiContribution,
  type PluginUiContribution,
} from '../src/browser.js'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('@helmx/protocol/browser: export declarations aligned with the root entry\'s pure cross-runtime surface', { timeout: 60_000 }, async () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
    exports?: Record<string, { types?: string; default?: string }>
  }
  assert.deepEqual(pkg.exports?.['./browser'], {
    types: './dist/browser.d.ts',
    default: './dist/browser.js',
  })

  const pkgBrowser = (await import('@helmx/protocol/browser')) as Record<string, unknown>

  const requiredRuntimeExports = [
    'HelmxError',
    'PLUGIN_HOOK_NAMES',
    'PLUGIN_CLIENT_SHARED_EXPORTS',
    'PLUGIN_UI_METHOD_NAMES',
    'KNOWN_PLUGIN_UI_SURFACES',
    'parsePluginUiContribution',
    'RESERVED_SLASH_COMMANDS',
    'PLUGIN_CLIENT_CSS_EXPORT',
    'PROFILE_DETAIL_SECTION_SLOT',
    'NODE_DETAIL_SECTION_SLOT',
    'COMPOSER_STATUS_SLOT',
    'COMPOSER_DOCK_SLOT',
    'OVERVIEW_CARD_META_SLOT',
    'matchesConversationScope',
    'isSkillAvailable',
    'assertSchemaCompilable',
    'validateOrThrow',
    'isAbsoluteAgentPath',
    'sanitizeAgentExecutionInfo',
    'sanitizeAgentGateResult',
    'agentGateResultMissingError',
    'isAbsoluteTargetPath',
    'safeResultText',
    'redactJsonValue',
    'isArtifactKind',
    'ARTIFACT_KINDS',
    'compareStrictSemver',
    'HELMX_LOCALES',
    'DEFAULT_HELMX_LOCALE',
    'isHelmxLocale',
    'normalizeLocaleTag',
    'parseLocalizedText',
    'resolveLocalizedText',
    'createLocaleTranslator',
    'encodeSessionDocSubParam',
    'parseSessionDocSubParam',
  ] as const

  const browserRecord = browserExports as Record<string, unknown>
  const rootRecord = rootExports as Record<string, unknown>
  assert.deepEqual(Object.keys(browserRecord).sort(), Object.keys(rootRecord).sort())
  for (const key of Object.keys(browserRecord)) {
    assert.equal(browserRecord[key], rootRecord[key], `browser.ts export ${key} must stay identical to index.ts`)
    assert.ok(key in pkgBrowser, `@helmx/protocol/browser package entry is missing export ${key}`)
  }
  for (const key of requiredRuntimeExports) {
    assert.ok(key in browserRecord, `browser.ts is missing runtime export ${key}`)
    assert.equal(browserRecord[key], rootRecord[key], `browser.ts and index.ts export ${key} must point to the same instance`)
  }
})

test('parsePluginUiContribution: covers every known surface and rejects invalid contributions correctly', { timeout: 60_000 }, () => {
  for (const surface of KNOWN_PLUGIN_UI_SURFACES) {
    const item: PluginUiContribution = {
      pluginId: 'demo:plugin',
      surface,
      spec: { id: `spec-${surface}`, label: surface },
    }
    const parsed = parsePluginUiContribution(item)
    assert.ok(parsed !== undefined, `known surface "${surface}" should narrow successfully`)
    assert.equal(parsed.pluginId, 'demo:plugin')
    assert.equal(parsed.surface, surface)
    // Verify the discriminated union narrows by surface
    const narrowed: KnownPluginUiContribution = parsed
    assert.equal(narrowed.spec.id, `spec-${surface}`)
  }

  const invalidCases: Array<{ label: string; value: PluginUiContribution }> = [
    { label: 'unknown surface', value: { pluginId: 'demo:plugin', surface: 'unknown.surface', spec: { id: 'x' } } },
    { label: 'empty surface', value: { pluginId: 'demo:plugin', surface: '', spec: { id: 'x' } } },
    { label: 'prototype-pollution surface', value: { pluginId: 'demo:plugin', surface: '__proto__', spec: { id: 'x' } } },
    { label: 'null spec', value: { pluginId: 'demo:plugin', surface: 'screen', spec: null } },
    { label: 'undefined spec', value: { pluginId: 'demo:plugin', surface: 'screen', spec: undefined } },
    { label: 'array spec', value: { pluginId: 'demo:plugin', surface: 'screen', spec: [] } },
    { label: 'primitive spec', value: { pluginId: 'demo:plugin', surface: 'screen', spec: 'bad' } },
  ]
  for (const c of invalidCases) {
    assert.equal(parsePluginUiContribution(c.value), undefined, `${c.label} must return undefined`)
  }
})
