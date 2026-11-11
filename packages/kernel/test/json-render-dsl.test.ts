/**
 * builtin:json-render 插件 DSL 纯函数测试（evaluator / spec-normalize / spec-action）。
 * 自 packages/web/test 迁入（声明式渲染已整体移出 Web 核心）。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { evaluateSpecValue, type EvalScope } from '../src/builtin-plugins/json-render/client/evaluator.js'
import {
  formatSpecText,
  isFlatSpec,
  normalizeSpec,
  resolveKeyValueItems,
} from '../src/builtin-plugins/json-render/client/spec-normalize.js'
import { parseSendTarget, resolveSpecAction } from '../src/builtin-plugins/json-render/client/spec-action.js'

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

// ---------------------------------------------------------------------------
// 回归 1：Table rowActions 必须保留原始模板至行级 scope 点击时再求值
// ---------------------------------------------------------------------------

test('Table rowActions 回归: 外层 scope 不预求值，行级点击时 $row 注入后正确求值', { timeout: 60_000 }, () => {
  const tableScope: EvalScope = {
    $docs: {
      workers: [
        { conversationId: 12, profileId: 'coder' },
        { conversationId: 15, profileId: 'researcher' },
      ],
    },
  }

  // superagent 派工卡真实写法：rowActions 模板内含 {$row.xxx}
  const rowActionsTemplate = [
    {
      label: '查看',
      action: { type: 'helm:open', target: 'conversation:{$row.conversationId}' },
    },
    {
      label: '归档',
      action: {
        type: 'helm:action',
        actionId: 'archive_worker',
        input: { workerConversationId: '{$row.conversationId}' },
      },
    },
  ]

  // 修复后的行为：rowActions 保留原始模板（不 evalIn），外层 scope 求值仅用于 rows
  const rows = evaluateSpecValue<Array<Record<string, unknown>>>('{$docs.workers}', tableScope)
  assert.ok(Array.isArray(rows))

  // 模拟点击第 2 行「查看」：此刻才构造行级 scope 并对原始模板求值
  const rowScope: EvalScope = { ...tableScope, $row: rows[1]! }
  const open = resolveSpecAction(rowActionsTemplate[0]!['action'], rowScope)
  assert.equal(open.kind, 'open')
  if (open.kind === 'open') {
    assert.equal(open.target, 'conversation:15')
  }

  // 模拟点击第 2 行「归档」：input 保持 number 类型
  const archive = resolveSpecAction(rowActionsTemplate[1]!['action'], rowScope)
  assert.equal(archive.kind, 'action')
  if (archive.kind === 'action') {
    assert.equal(archive.input['workerConversationId'], 15)
    assert.equal(typeof archive.input['workerConversationId'], 'number')
  }
})

test('Table rowActions 回归: 若在外层 scope 预求值，target 会变成坏值 conversation:（旧 bug 机制）', { timeout: 60_000 }, () => {
  // 旧 bug 机制复现：外层无 $row 的 scope 下预求值 target 模板，$row 字段被吞成空串
  const premature = evaluateSpecValue<string>('conversation:{$row.conversationId}', { $docs: {} })
  assert.equal(premature, 'conversation:')
  // 修复后 TableImpl 保留原始模板至行级 scope 点击时才求值，
  // 行级求值结果始终携带真实 id（见上一个回归测试），坏值不再可能产生。
  // 此外 helm:send 对坏 target 显式拒绝（不静默降级）：
  assert.equal(resolveSpecAction({ type: 'helm:send', target: premature, text: 'x' }, {}).kind, 'invalid')
})

// ---------------------------------------------------------------------------
// 回归 2：KeyValueList 渲染路径（未经 evalIn 预求值的原始 items）
// ---------------------------------------------------------------------------

test('KeyValueList 回归: 原始 pointer key 模板直接传入渲染 helper 也能求值（不再显示破折号）', { timeout: 60_000 }, () => {
  // 修复后的 KeyValueListImpl 不再 evalIn(items)，直接把原始 items 交给本 helper
  // （这正是真实渲染所走的路径）
  const rawItems = [
    { key: '/$docs/index/routerConversationId', label: '中枢会话' },
    { key: '/$docs/index/watchdogConversationId', label: '看门狗会话' },
    { key: '/$docs/crons/jobs/length', label: 'Cron 任务数' },
  ]
  const resolved = resolveKeyValueItems(rawItems, (expr) => evaluateSpecValue(expr, kvScope))
  assert.deepEqual(resolved, [
    { label: '中枢会话', value: '2' },
    { label: '看门狗会话', value: '3' },
    { label: 'Cron 任务数', value: '2' },
  ])
})

test('KeyValueList 回归: 旧 bug 场景——key 被预求值成数字也能正常展示', { timeout: 60_000 }, () => {
  // 旧 bug 机制：若 items 被预求值，pointer key 变成 number，旧 helper 识别不出而显示破折号；
  // 修复后 helper 对已求值的具体值（非绑定表达式字符串）直接作展示值
  const preEvaluated = evaluateSpecValue<Array<Record<string, unknown>>>(
    [{ key: '/$docs/index/routerConversationId', label: '中枢会话' }],
    kvScope,
  )
  // 预求值产物：key 变成了 number 2
  assert.equal(typeof preEvaluated[0]!['key'], 'number')
  const resolved = resolveKeyValueItems(preEvaluated, (expr) => evaluateSpecValue(expr, kvScope))
  assert.deepEqual(resolved, [{ label: '中枢会话', value: '2' }])
})

test('KeyValueList 回归: 普通 key、label+value、pointer key 三种写法混用', { timeout: 60_000 }, () => {
  const rawItems = [
    { key: 'plainKey' },
    { label: '名称', value: '直接值' },
    { key: '{$docs.index.routerConversationId}', label: '花括号写法' },
    { key: '/$docs/missing/path', label: '缺失路径' },
  ]
  const resolved = resolveKeyValueItems(rawItems, (expr) => evaluateSpecValue(expr, kvScope))
  assert.deepEqual(resolved, [
    { label: 'plainKey', value: 'plainKey' },
    { label: '名称', value: '直接值' },
    { label: '花括号写法', value: '2' },
    { label: '缺失路径', value: '—' },
  ])
})

// ---------------------------------------------------------------------------
// 回归 3：求值器安全加固
// ---------------------------------------------------------------------------

test('evaluator 回归: 普通文本 JSON 示例不被吃掉（非 $ 开头不识别为绑定）', { timeout: 60_000 }, () => {
  const scope: EvalScope = { $docs: {} }
  // 整串花括号内非 $ 开头：原样保留
  assert.equal(evaluateSpecValue('{"enabled":true}', scope), '{"enabled":true}')
  // 嵌入长文本的 JSON 示例：花括号内容原样保留
  assert.equal(
    evaluateSpecValue('配置示例 {"enabled":true} 与 {"mode":"auto"}，请参考', scope),
    '配置示例 {"enabled":true} 与 {"mode":"auto"}，请参考',
  )
  // 但真正的绑定表达式仍然生效（三种合法语法不变）
  assert.equal(evaluateSpecValue('conversation:{$row.id}', { $row: { id: 7 } }), 'conversation:7')
  assert.equal(evaluateSpecValue('{$docs.index.routerConversationId}', kvScope), 2)
  assert.equal(evaluateSpecValue('/$docs/index/routerConversationId', kvScope), 2)
  assert.deepEqual(evaluateSpecValue('{$docs["recall-graph"]}', { $docs: { 'recall-graph': { n: 1 } } }), { n: 1 })
})

test('evaluator 回归: number/bool 类型保持不变', { timeout: 60_000 }, () => {
  const scope: EvalScope = { $value: false, $row: { n: 12, b: true } }
  assert.equal(evaluateSpecValue('{$value}', scope), false)
  assert.equal(typeof evaluateSpecValue('{$value}', scope), 'boolean')
  assert.equal(evaluateSpecValue('{$row.n}', scope), 12)
  assert.equal(typeof evaluateSpecValue('{$row.n}', scope), 'number')
  assert.equal(evaluateSpecValue('{$row.b}', scope), true)
  assert.equal(typeof evaluateSpecValue('{$row.b}', scope), 'boolean')
})

test('evaluator 回归: 原型链逃逸被阻断（只读 own property）', { timeout: 60_000 }, () => {
  const scope: EvalScope = { $docs: {} }
  // __proto__ / constructor / prototype 都不是普通对象的 own property：一律 undefined
  assert.equal(evaluateSpecValue('{$docs.__proto__}', scope), undefined)
  assert.equal(evaluateSpecValue('{$docs.constructor}', scope), undefined)
  assert.equal(evaluateSpecValue('{$docs.constructor.name}', scope), undefined)
  assert.equal(evaluateSpecValue('{$docs.__proto__.polluted}', scope), undefined)
  assert.equal(evaluateSpecValue('{$docs.toString}', scope), undefined)
  // 正常 own property 访问不受影响
  assert.equal(evaluateSpecValue('{$docs.index.routerConversationId}', kvScope), 2)
  // own property 上同名键仍可读（只读 own 语义不误伤合法数据）
  const withOwn = evaluateSpecValue('{$docs.constructor}', { $docs: { constructor: 'safe' } })
  assert.equal(withOwn, 'safe')
})

// ---------------------------------------------------------------------------
// ScreenHost 路由契约：零业务特判，所有 screen 统一 PluginUiView 渲染
// ---------------------------------------------------------------------------