import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateSpecValue, parseExpressionSegments, type EvalScope } from '../src/builtin-plugins/json-render/client/evaluator.js'

const sampleScope: EvalScope = {
  $docs: {
    index: {
      routerConversationId: 2,
      watchdogConversationId: 3,
      workers: [
        { conversationId: 12, profileId: 'coder' },
        { conversationId: 15, profileId: 'researcher' },
      ],
    },
    routing: {
      routerMode: true,
    },
    subscriptions: {
      subscriptions: [{ threadKey: 'pr:101', workerConversationId: 12 }],
    },
    'recall-graph': {
      nodes: [{ id: 'n1', conversationId: 12, profileId: 'coder', outcome: 'completed', summary: '完成修复' }],
    },
  },
  $row: {
    conversationId: 12,
    profileId: 'coder',
  },
  $data: {
    entry: {
      data: {
        meta: {
          workerId: 12,
          summary: '修复已完成',
        },
      },
    },
  },
  $value: false,
}

test('evaluator: 支持点路径、带连字符方括号路径与 JSON Pointer 三种语法', { timeout: 60_000 }, () => {
  assert.deepEqual(parseExpressionSegments('$docs.index.workers'), ['$docs', 'index', 'workers'])
  assert.deepEqual(parseExpressionSegments('$docs["recall-graph"].nodes'), ['$docs', 'recall-graph', 'nodes'])
  assert.deepEqual(parseExpressionSegments('/$docs/index/routerConversationId'), [
    '$docs',
    'index',
    'routerConversationId',
  ])
})

test('evaluator: 整串单表达式严格保持原始 JS 类型（Array / boolean / number）', { timeout: 60_000 }, () => {
  const workers = evaluateSpecValue('{$docs.index.workers}', sampleScope)
  assert.ok(Array.isArray(workers))
  assert.equal((workers as unknown[]).length, 2)

  const recallNodes = evaluateSpecValue('{$docs["recall-graph"].nodes}', sampleScope)
  assert.ok(Array.isArray(recallNodes))
  assert.equal((recallNodes as Array<{ summary: string }>)[0]?.summary, '完成修复')

  const routerMode = evaluateSpecValue('{$docs.routing.routerMode}', sampleScope)
  assert.strictEqual(routerMode, true)

  const pointerVal = evaluateSpecValue('/$docs/index/routerConversationId', sampleScope)
  assert.strictEqual(pointerVal, 2)

  const actionInput = evaluateSpecValue(
    { workerConversationId: '{$row.conversationId}', enabled: '{$value}' },
    sampleScope,
  )
  assert.deepEqual(actionInput, { workerConversationId: 12, enabled: false })
})

test('evaluator: 内嵌模板字符串执行插值拼接并支持 .length', { timeout: 60_000 }, () => {
  const statusText = evaluateSpecValue<string>(
    '活跃 Worker {$docs.index.workers.length} 个；事件订阅 {$docs.subscriptions.subscriptions.length} 条。',
    sampleScope,
  )
  assert.equal(statusText, '活跃 Worker 2 个；事件订阅 1 条。')

  const target = evaluateSpecValue<string>('conversation:{$row.conversationId}', sampleScope)
  assert.equal(target, 'conversation:12')

  const reportSummary = evaluateSpecValue<string>('{$data.entry.data.meta.summary}', sampleScope)
  assert.equal(reportSummary, '修复已完成')
})
