import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateSpecValue, type EvalScope } from '../src/ui/evaluator.js'
import {
  formatSpecText,
  isFlatSpec,
  normalizeSpec,
  resolveKeyValueItems,
} from '../src/ui/spec-normalize.js'
import { parseSendTarget, resolveSpecAction } from '../src/ui/spec-action.js'

// ---------------------------------------------------------------------------
// 双形态归一化
// ---------------------------------------------------------------------------

test('spec-normalize: 形态 A（树状简写）归一化为 NormalizedSpecNode 树', { timeout: 60_000 }, () => {
  // superagent.ts settingsPanel 真实写法
  const spec = {
    component: 'Stack',
    children: [
      { component: 'Text', variant: 'title', text: 'SuperAgent 中枢' },
      {
        component: 'KeyValueList',
        items: [{ key: '/$docs/index/routerConversationId', label: '中枢会话' }],
      },
      { component: 'Text', variant: 'muted', text: '说明文字' },
    ],
  }
  const result = normalizeSpec(spec)
  assert.equal(result.degraded, false)
  assert.ok(result.root)
  assert.equal(result.root!.component, 'Stack')
  assert.equal(result.root!.children.length, 3)
  assert.equal(result.root!.children[0]!.component, 'Text')
  assert.deepEqual(result.root!.children[0]!.props, { variant: 'title', text: 'SuperAgent 中枢' })
  // children 不应泄漏进 props
  assert.equal('children' in result.root!.props, false)
  assert.equal('component' in result.root!.props, false)
})

test('spec-normalize: 形态 B（扁平 @json-render）归一化并保留 props', { timeout: 60_000 }, () => {
  const spec = {
    root: 'r',
    elements: {
      r: { type: 'Card', props: { title: '卡片' }, children: ['t1'] },
      t1: { type: 'Text', props: { text: '内容' } },
    },
  }
  assert.equal(isFlatSpec(spec), true)
  const result = normalizeSpec(spec)
  assert.equal(result.degraded, false)
  assert.equal(result.root!.component, 'Card')
  assert.deepEqual(result.root!.props, { title: '卡片' })
  assert.equal(result.root!.children.length, 1)
  assert.equal(result.root!.children[0]!.component, 'Text')
  assert.equal(result.root!.children[0]!.props['text'], '内容')
})

test('spec-normalize: 非法输入降级并携带原因（不静默）', { timeout: 60_000 }, () => {
  assert.equal(normalizeSpec(null).degraded, true)
  assert.equal(normalizeSpec('text').degraded, true)
  assert.equal(normalizeSpec({}).degraded, true)
  assert.equal(normalizeSpec({ foo: 1 }).degraded, true)
  // 扁平形态根缺失
  const bad = normalizeSpec({ root: 'missing', elements: {} })
  assert.equal(bad.degraded, true)
  assert.ok(bad.reason!.includes('missing'))
})

test('spec-normalize: 循环引用不致死循环', { timeout: 60_000 }, () => {
  const spec = {
    root: 'a',
    elements: {
      a: { type: 'Stack', children: ['b'] },
      b: { type: 'Card', children: ['a'] },
    },
  }
  const result = normalizeSpec(spec)
  // 整体不降级（根合法），循环子节点成为局部降级节点
  assert.equal(result.degraded, false)
  const cycleChild = result.root!.children[0]!.children[0]!
  assert.ok(String(cycleChild.props['reason']).includes('循环'))
})

// ---------------------------------------------------------------------------
// KeyValueList 两种写法
// ---------------------------------------------------------------------------

const kvScope: EvalScope = {
  $docs: {
    index: {
      routerConversationId: 2,
      watchdogConversationId: 3,
    },
    crons: { jobs: [{ id: 'j1' }, { id: 'j2' }] },
    webhooks: { webhooks: [{ id: 'w1' }] },
  },
}

test('KeyValueList: JSON Pointer key 写法求值作为展示值（superagent 真实写法）', { timeout: 60_000 }, () => {
  const items = [
    { key: '/$docs/index/routerConversationId', label: '中枢会话' },
    { key: '/$docs/index/watchdogConversationId', label: '看门狗会话' },
  ]
  const resolved = resolveKeyValueItems(items, (expr) => evaluateSpecValue(expr, kvScope))
  assert.deepEqual(resolved, [
    { label: '中枢会话', value: '2' },
    { label: '看门狗会话', value: '3' },
  ])
})

test('KeyValueList: .length 求值（triggers settingsPanel 真实写法）', { timeout: 60_000 }, () => {
  const items = [
    { key: '/$docs/crons/jobs/length', label: 'Cron 任务数' },
    { key: '/$docs/webhooks/webhooks/length', label: 'Webhook 端点数' },
  ]
  const resolved = resolveKeyValueItems(items, (expr) => evaluateSpecValue(expr, kvScope))
  assert.deepEqual(resolved, [
    { label: 'Cron 任务数', value: '2' },
    { label: 'Webhook 端点数', value: '1' },
  ])
})

test('KeyValueList: label+value 写法与已求值 value 直通', { timeout: 60_000 }, () => {
  // value 由 evaluateSpecValue 先行求值（整串单表达式保持原始类型）
  const evaluated = evaluateSpecValue<Array<Record<string, unknown>>>(
    [{ label: '名称', value: '{$docs.index.routerConversationId}' }],
    kvScope,
  )
  const resolved = resolveKeyValueItems(evaluated, () => undefined)
  assert.deepEqual(resolved, [{ label: '名称', value: '2' }])
})

// ---------------------------------------------------------------------------
// Table 行动作 $row 求值
// ---------------------------------------------------------------------------

test('Table rowActions: $row 注入后 input 保持数字类型、target 插值为字符串', { timeout: 60_000 }, () => {
  const scope: EvalScope = {
    $docs: {
      index: {
        workers: [
          { conversationId: 12, profileId: 'coder' },
          { conversationId: 15, profileId: 'researcher' },
        ],
      },
    },
  }
  const rows = evaluateSpecValue<unknown[]>('{$docs.index.workers}', scope)
  assert.ok(Array.isArray(rows))

  // 每一行模拟 Table 内部逻辑：row 注入 $row 后对 rowAction 求值
  const row = rows![0]! as Record<string, unknown>
  const rowScope: EvalScope = { ...scope, $row: row }

  const archiveAction = resolveSpecAction(
    { type: 'helm:action', actionId: 'archive_worker', input: { workerConversationId: '{$row.conversationId}' } },
    rowScope,
  )
  assert.equal(archiveAction.kind, 'action')
  if (archiveAction.kind === 'action') {
    assert.equal(archiveAction.actionId, 'archive_worker')
    assert.equal(typeof archiveAction.input['workerConversationId'], 'number')
    assert.equal(archiveAction.input['workerConversationId'], 12)
  }

  const openAction = resolveSpecAction(
    { type: 'helm:open', target: 'conversation:{$row.conversationId}' },
    rowScope,
  )
  assert.equal(openAction.kind, 'open')
  if (openAction.kind === 'open') {
    assert.equal(openAction.target, 'conversation:12')
    assert.equal(openAction.split, false)
  }
})

test('Table rowActions: split 打开（superagent timelineRenderer 真实写法）', { timeout: 60_000 }, () => {
  const scope: EvalScope = {
    $data: { entry: { data: { meta: { workerId: 12 } } } },
  }
  const action = resolveSpecAction(
    { type: 'helm:open', target: 'conversation:{$data.entry.data.meta.workerId}', split: true },
    scope,
  )
  assert.equal(action.kind, 'open')
  if (action.kind === 'open') {
    assert.equal(action.target, 'conversation:12')
    assert.equal(action.split, true)
  }
})

// ---------------------------------------------------------------------------
// Switch $value 布尔注入与三指令边界
// ---------------------------------------------------------------------------

test('Switch: 新布尔值注入 $value 后 action input 保持 boolean', { timeout: 60_000 }, () => {
  const scope: EvalScope = { $docs: { routing: { routerMode: true } }, $value: false }
  const action = resolveSpecAction(
    { type: 'helm:action', actionId: 'set_router_mode', input: { enabled: '{$value}' } },
    scope,
  )
  assert.equal(action.kind, 'action')
  if (action.kind === 'action') {
    assert.equal(typeof action.input['enabled'], 'boolean')
    assert.equal(action.input['enabled'], false)
  }
})

test('spec-action: helm:send 目标解析与非法载荷显式拒绝', { timeout: 60_000 }, () => {
  assert.equal(parseSendTarget('conversation:42'), 42)
  assert.equal(parseSendTarget('42'), 42)
  assert.equal(parseSendTarget('conversation:abc'), null)

  const send = resolveSpecAction({ type: 'helm:send', target: 'conversation:7', text: '开始巡检' }, {})
  assert.equal(send.kind, 'send')
  if (send.kind === 'send') {
    assert.equal(send.conversationId, 7)
    assert.equal(send.text, '开始巡检')
  }

  assert.equal(resolveSpecAction(null, {}).kind, 'invalid')
  assert.equal(resolveSpecAction({ type: 'unknown' }, {}).kind, 'invalid')
  assert.equal(resolveSpecAction({ type: 'helm:open', target: '' }, {}).kind, 'invalid')
})

// ---------------------------------------------------------------------------
// 格式化辅助
// ---------------------------------------------------------------------------

test('formatSpecText: undefined/null/数组/对象的展示格式', { timeout: 60_000 }, () => {
  assert.equal(formatSpecText(undefined), '—')
  assert.equal(formatSpecText(null), 'null')
  assert.equal(formatSpecText(true), 'true')
  assert.equal(formatSpecText(12), '12')
  assert.equal(formatSpecText('文本'), '文本')
  assert.equal(formatSpecText([1, 2]), '[1,2]')
  assert.equal(formatSpecText({ a: 1 }), '{"a":1}')
})
