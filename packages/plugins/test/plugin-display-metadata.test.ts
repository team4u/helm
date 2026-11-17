/**
 * 内置插件显示元数据 LocalizedText 契约测试：
 * - 定义层（PluginDefinition.name/description）、UI 扩展点（label/title/
 *   description）与 configSchema（label/description）必须声明为
 *   `{ en, 'zh-CN' }` 双语资源且各语文案非空（本地化铺开的登记不变量）；
 * - 注册期执行文案（action/tool 的 description、promptSnippet/
 *   promptGuidelines、cli.description 与 input/outputSchema 内全部
 *   description 机器描述）固定英文：类型为纯 string（不得变 LocalizedText）
 *   且不含中文字符；
 * - 采集方式：对 11 个内置插件工厂以全透传录制 ctx 执行 definePlugin，
 *   只读登记事实，不 mock 行为（getConfig 返回空对象触发缺省路径）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseNonEmptyLocalizedText, type LocalizedText, type PluginDefinition } from '@helm/protocol'

import { createProfilePlugin } from '../src/profile.js'
import { createWorkflowPlugin } from '../src/workflow.js'
import { createMemoryPlugin } from '../src/memory.js'
import { createAppsPlugin } from '../src/apps.js'
import { createJsonRenderPlugin } from '../src/json-render.js'
import { createMermaidPlugin } from '../src/mermaid.js'
import { createTriggersPlugin } from '../src/triggers.js'
import { createHerdrPlugin } from '../src/herdr.js'
import { createSuperAgentPlugin } from '../src/superagent.js'
import { createMagpiePlugin } from '../src/magpie.js'
import { createTokenSpeedPlugin } from '../src/token-speed.js'

const timeout = { timeout: 60_000 } as const

/** 全部内置插件工厂（与 @helm/hub 注册清单一一对应）。 */
const FACTORIES: ReadonlyArray<() => PluginDefinition> = [
  createProfilePlugin,
  createWorkflowPlugin,
  createMemoryPlugin,
  createAppsPlugin,
  createJsonRenderPlugin,
  createMermaidPlugin,
  createTriggersPlugin,
  createHerdrPlugin,
  createSuperAgentPlugin,
  createMagpiePlugin,
  createTokenSpeedPlugin,
]

interface RecordedAction {
  id?: string
  description?: unknown
  promptSnippet?: unknown
  promptGuidelines?: unknown
  cli?: { description?: unknown } | undefined
  inputSchema?: unknown
  outputSchema?: unknown
}

interface RecordedTool {
  name?: string
  description?: unknown
  promptSnippet?: unknown
  promptGuidelines?: unknown
  inputSchema?: unknown
}

interface Registration {
  definition: PluginDefinition
  ui: Array<{ surface: string; spec: Record<string, unknown> }>
  actions: RecordedAction[]
  tools: RecordedTool[]
  configSchema: Record<string, Record<string, unknown>>[]
}

/**
 * 录制型 ctx：ui/action/tool/configSchema 四个声明面精确捕获，其余任何
 * 属性/调用（host、doc、service、hook……）经全透传 Proxy 吸收，保证
 * definePlugin 注册路径完整走通且不触发真实副作用。
 */
function makeRecordingContext(sink: Registration): Record<string, unknown> {
  const makeAllPurposeProxy = (): object =>
    new Proxy(passthrough, {
      get(target, prop) {
        if (prop === Symbol.toPrimitive) return () => '[recording-passthrough]'
        if (prop === 'then') return undefined
        return makeAllPurposeProxy()
      },
      apply: () => makeAllPurposeProxy(),
      construct: () => makeAllPurposeProxy(),
    })
  const passthrough = (..._args: unknown[]): unknown => makeAllPurposeProxy()
  const uiSurface = (surface: string) => (spec: Record<string, unknown>) => sink.ui.push({ surface, spec })
  return new Proxy(
    {
      getConfig: () => ({}),
      ui: new Proxy(
        {},
        {
          get: (_t, surface) => {
            assert.ok(typeof surface === 'string' && surface.length > 0, 'ctx.ui 扩展面名必须可记录')
            return uiSurface(surface)
          },
        },
      ),
      action: (spec: RecordedAction) => sink.actions.push(spec),
      tool: (spec: RecordedTool) => sink.tools.push(spec),
      configSchema: (schema: Record<string, Record<string, unknown>>) => sink.configSchema.push(schema),
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop as keyof typeof target]
        return makeAllPurposeProxy()
      },
    },
  )
}

function recordAllPlugins(): Registration[] {
  return FACTORIES.map((factory) => {
    const sink: Registration = { definition: factory(), ui: [], actions: [], tools: [], configSchema: [] }
    sink.definition.definePlugin(makeRecordingContext(sink) as never)
    return sink
  })
}

/** 双语资源断言：必须是 { en, 'zh-CN' } 形态且两种语文案 trim 后非空。 */
function assertFullyLocalized(where: string, value: unknown): void {
  assert.ok(typeof value === 'object' && value !== null, `${where} 必须声明为 { en, 'zh-CN' } 双语资源（当前：${JSON.stringify(value)}）`)
  assert.notEqual(parseNonEmptyLocalizedText(value as LocalizedText), undefined, `${where} 必须通过 parseNonEmptyLocalizedText 边界校验`)
  const map = value as Record<string, unknown>
  for (const locale of ['en', 'zh-CN'] as const) {
    const text = map[locale]
    assert.ok(typeof text === 'string' && text.trim().length > 0, `${where} 缺少非空 ${locale} 文案`)
  }
}

const HAN = /[\u4e00-\u9fff]/

/** 深走 JSON Schema（input/outputSchema）：全部 description 机器描述固定英文。 */
function assertEnglishSchemaDescriptions(where: string, node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => assertEnglishSchemaDescriptions(`${where}[${i}]`, child))
    return
  }
  if (node === null || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'description' && typeof value === 'string') {
      assert.equal(HAN.test(value), false, `${where}.description 执行文案必须固定英文（不得中文/不得 LocalizedText）`)
      continue
    }
    assertEnglishSchemaDescriptions(`${where}.${key}`, value)
  }
}

test('显示元数据：全部内置插件 name/description 与 UI/configSchema 文案为 en+zh-CN 双语资源', timeout, () => {
  const registrations = recordAllPlugins()
  assert.equal(registrations.length, 11, '内置插件工厂数量')
  for (const { definition, ui, configSchema } of registrations) {
    assertFullyLocalized(`${definition.id} definition.name`, definition.name)
    assertFullyLocalized(`${definition.id} definition.description`, definition.description)
    for (const { surface, spec } of ui) {
      const where = `${definition.id} ${surface}#${String(spec['id'])}`
      for (const field of ['label', 'title', 'description'] as const) {
        if (spec[field] !== undefined) assertFullyLocalized(`${where}.${field}`, spec[field])
      }
    }
    for (const schema of configSchema) {
      for (const [key, field] of Object.entries(schema)) {
        assert.ok(field && typeof field === 'object', `${definition.id} config.${key} 必须是对象`)
        const record = field as Record<string, unknown>
        assertFullyLocalized(`${definition.id} config.${key}.label`, record['label'])
        if (record['description'] !== undefined) {
          assertFullyLocalized(`${definition.id} config.${key}.description`, record['description'])
        }
      }
    }
  }
})

test('执行文案：action/tool 注册描述固定英文纯 string（不本地化、无中文）', timeout, () => {
  const registrations = recordAllPlugins()
  for (const { definition, actions, tools } of registrations) {
    for (const action of actions) {
      const where = `${definition.id} action#${String(action.id)}`
      assert.ok(typeof action.description === 'string' && action.description.length > 0, `${where}.description 必须是非空纯 string`)
      assert.equal(HAN.test(action.description), false, `${where}.description 必须固定英文`)
      const cliDescription = action.cli?.description
      if (cliDescription !== undefined) {
        assert.ok(typeof cliDescription === 'string', `${where} cli.description 必须是纯 string`)
        assert.equal(HAN.test(cliDescription as string), false, `${where} cli.description 必须固定英文`)
      }
      for (const field of ['promptSnippet', 'promptGuidelines'] as const) {
        const value = action[field as keyof RecordedAction]
        if (value === undefined) continue
        assert.equal(HAN.test(JSON.stringify(value)), false, `${where}.${field} 必须固定英文`)
      }
      assertEnglishSchemaDescriptions(`${where}.inputSchema`, action.inputSchema)
      assertEnglishSchemaDescriptions(`${where}.outputSchema`, action.outputSchema)
    }
    for (const tool of tools) {
      const where = `${definition.id} tool#${String(tool.name)}`
      assert.ok(typeof tool.description === 'string' && tool.description.length > 0, `${where}.description 必须是非空纯 string`)
      assert.equal(HAN.test(tool.description), false, `${where}.description 必须固定英文`)
      for (const field of ['promptSnippet', 'promptGuidelines'] as const) {
        const value = tool[field as keyof RecordedTool]
        if (value === undefined) continue
        assert.equal(HAN.test(JSON.stringify(value)), false, `${where}.${field} 必须固定英文`)
      }
      assertEnglishSchemaDescriptions(`${where}.inputSchema`, tool.inputSchema)
    }
  }
})
