/**
 * action-prompts 纯函数单测：目录渲染契约 + prompt.actions 段投射。
 *
 * 覆盖：紧凑签名（必填/可选/类型/嵌套/组合器/非对象顶层）、CLI 渲染
 * （缺省剥 builtin: / 覆写 / hidden）、多行描述规范化与 XML 转义、
 * 指引带全限定 ID、段落 set-or-clear 语义。
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
    description: '普通动作',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    ...patch,
  }
}

test('紧凑签名: 必填/可选、类型、数组元素、嵌套对象与组合器', { timeout: 60_000 }, () => {
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
  assert.ok(signature.includes('q: string（必填）'))
  assert.ok(signature.includes('times: number（可选）'))
  assert.ok(signature.includes('flags: string[]（可选）'), '数组元素类型应内联')
  assert.ok(signature.includes('matrix: object[]（describe 查询）（可选）'), '对象数组应标注按需查询')
  assert.ok(signature.includes('cfg: object（嵌套）（describe 查询）（必填）'), '嵌套对象应标注按需查询')
  assert.ok(signature.includes('freeform: object（可选）'), '无属性对象为普通自由形')
  assert.ok(signature.includes('either: 复杂（describe 查询）（可选）'))
  assert.ok(signature.includes('refd: 复杂（describe 查询）（可选）'))

  assert.equal(compactActionSignature({ type: 'object', properties: {} }), '（无参数）')
  assert.equal(compactActionSignature({ type: 'object' }), '（无参数）')
  assert.ok(compactActionSignature({ oneOf: [{ type: 'object' }, { type: 'null' }] }).includes('run_action describe 查询'))
  assert.ok(compactActionSignature({ type: 'string' }).includes('顶层类型 string'))
})

test('CLI 渲染: 缺省剥 builtin:；command 覆写；hidden 不展示', { timeout: 60_000 }, () => {
  assert.equal(actionCliCommand(manifest()), 'helm demo:probe plain')
  assert.equal(
    actionCliCommand(manifest({ pluginId: 'builtin:workflow' })),
    'helm workflow plain',
    '内置插件剥 builtin: 前缀',
  )
  assert.equal(
    actionCliCommand(manifest({ cli: { command: ['team', 'report', 'make'] } })),
    'helm team report make',
  )
  assert.equal(actionCliCommand(manifest({ cli: { hidden: true } })), undefined)
})

test('目录渲染: 转义、多行描述规范化、全量无截断、指引带全限定 ID、hidden 无 CLI 行', { timeout: 60_000 }, () => {
  assert.equal(renderAvailableActionsSection([]), undefined, '空目录返回 undefined（清除信号）')
  const text = renderAvailableActionsSection([
    {
      manifest: manifest({
        description: '第一行 <b>加粗</b> &\n第二行续',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        promptSnippet: 'SNIP 第一行\nSNIP 第二行',
        promptGuidelines: ['要点 A', '要点 B'],
      }),
      cliCommand: 'helm demo:probe plain',
    },
    {
      manifest: manifest({ id: 'secret', description: '隐藏动作', cli: { hidden: true } }),
    },
  ])!
  assert.ok(text.startsWith('<available_actions>'))
  assert.ok(text.endsWith('</available_actions>'))
  assert.ok(text.includes('demo:probe.plain'), '全限定 ID')
  assert.ok(text.includes('&lt;b&gt;加粗&lt;/b&gt; &amp;'), '描述 XML 转义')
  assert.ok(!/\n第二行续/.test(text), '多行描述压成单行')
  assert.ok(text.includes('q: string（必填）'))
  assert.ok(text.includes('CLI: helm demo:probe plain'))
  assert.ok(text.includes('指引（demo:probe.plain）:'))
  assert.ok(text.includes('- 要点 A') && text.includes('- 要点 B'))
  assert.ok(text.includes('说明（demo:probe.plain）:'))
  assert.ok(text.includes('SNIP 第二行'), 'snippet 多行原样保留')
  assert.ok(text.includes('demo:probe.secret'), 'hidden 动作仍在目录（run_action 可达）')
  const secretBlock = text.slice(text.indexOf('demo:probe.secret'))
  assert.ok(!secretBlock.slice(0, secretBlock.indexOf('- demo:probe.') + 1 || undefined).includes('CLI:'), 'hidden 无 CLI 行')
})

test('段落投射: set-or-clear、保留他段、未变化返回原引用', { timeout: 60_000 }, () => {
  const base = [
    { id: 'profile.system', text: 'SYS' },
    { id: 'prompt.tools.guidelines', text: 'G' },
  ]
  const set1 = projectActionPromptSection(base, 'DIR_V1')
  assert.deepEqual(set1.map((s) => s.id), ['profile.system', 'prompt.actions', 'prompt.tools.guidelines'])
  const sameRef = projectActionPromptSection(set1, 'DIR_V1')
  assert.equal(sameRef, set1, '内容未变化时返回原引用')
  const set2 = projectActionPromptSection(set1, 'DIR_V2')
  assert.equal(set2.find((s) => s.id === ACTIONS_PROMPT_SECTION_ID)?.text, 'DIR_V2')
  const cleared = projectActionPromptSection(set2, undefined)
  assert.ok(!cleared.some((s) => s.id === ACTIONS_PROMPT_SECTION_ID), 'undefined 清除管理段')
  assert.deepEqual(
    cleared.map((s) => s.id),
    ['profile.system', 'prompt.tools.guidelines'],
    '其他段不受影响',
  )
  const emptyClear = projectActionPromptSection(base, undefined)
  assert.equal(emptyClear, base, '本无管理段时清除为幂等')
})
