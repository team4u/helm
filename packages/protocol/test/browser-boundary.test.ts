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

test('@helm/protocol/browser：导出声明与根入口纯跨端能力对齐', { timeout: 60_000 }, async () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
    exports?: Record<string, { types?: string; default?: string }>
  }
  assert.deepEqual(pkg.exports?.['./browser'], {
    types: './dist/browser.d.ts',
    default: './dist/browser.js',
  })

  const pkgBrowser = (await import('@helm/protocol/browser')) as Record<string, unknown>

  const requiredRuntimeExports = [
    'HelmError',
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
    'matchesConversationScope',
    'isSkillAvailable',
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
  ] as const

  const browserRecord = browserExports as Record<string, unknown>
  const rootRecord = rootExports as Record<string, unknown>
  assert.deepEqual(Object.keys(browserRecord).sort(), Object.keys(rootRecord).sort())
  for (const key of Object.keys(browserRecord)) {
    assert.equal(browserRecord[key], rootRecord[key], `browser.ts 导出 ${key} 与 index.ts 应保持同源`)
    assert.ok(key in pkgBrowser, `@helm/protocol/browser 包入口缺少导出 ${key}`)
  }
  for (const key of requiredRuntimeExports) {
    assert.ok(key in browserRecord, `browser.ts 缺少运行时导出 ${key}`)
    assert.equal(browserRecord[key], rootRecord[key], `browser.ts 与 index.ts 导出 ${key} 应指向同一实例`)
  }
})

test('parsePluginUiContribution：覆盖全部已知 surface 并正确拒绝非法贡献', { timeout: 60_000 }, () => {
  for (const surface of KNOWN_PLUGIN_UI_SURFACES) {
    const item: PluginUiContribution = {
      pluginId: 'demo:plugin',
      surface,
      spec: { id: `spec-${surface}`, label: surface },
    }
    const parsed = parsePluginUiContribution(item)
    assert.ok(parsed !== undefined, `已知 surface "${surface}" 应通过收窄`)
    assert.equal(parsed.pluginId, 'demo:plugin')
    assert.equal(parsed.surface, surface)
    // 验证判别联合可按 surface 分支收窄
    const narrowed: KnownPluginUiContribution = parsed
    assert.equal(narrowed.spec.id, `spec-${surface}`)
  }

  const invalidCases: Array<{ label: string; value: PluginUiContribution }> = [
    { label: '未知 surface', value: { pluginId: 'demo:plugin', surface: 'unknown.surface', spec: { id: 'x' } } },
    { label: '空 surface', value: { pluginId: 'demo:plugin', surface: '', spec: { id: 'x' } } },
    { label: '原型污染 surface', value: { pluginId: 'demo:plugin', surface: '__proto__', spec: { id: 'x' } } },
    { label: 'null spec', value: { pluginId: 'demo:plugin', surface: 'screen', spec: null } },
    { label: 'undefined spec', value: { pluginId: 'demo:plugin', surface: 'screen', spec: undefined } },
    { label: 'array spec', value: { pluginId: 'demo:plugin', surface: 'screen', spec: [] } },
    { label: 'primitive spec', value: { pluginId: 'demo:plugin', surface: 'screen', spec: 'bad' } },
  ]
  for (const c of invalidCases) {
    assert.equal(parsePluginUiContribution(c.value), undefined, `${c.label} 必须返回 undefined`)
  }
})
