/**
 * CLI 插件文档命令测试：plugins doc --conversation/--current/--watch。
 * 模拟 Hub HTTP 契约（真实 fetch 边界 + 真实 SSE 响应），验证：
 * - 路径/查询参数拼装与 --json 同权；
 * - --conversation 与 --current 互斥；
 * - --current 读 HELM_CONVERSATION_ID；
 * - --watch 消费专用 SSE（snapshot + 增量帧）；
 * - 404 结构化错误原样透出。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  makeCliEnv,
  parseCliError,
  runCliCaptured,
  startMockHub,
  useTempDir,
} from './helpers/cli-harness.js'

test('plugins doc --conversation：拼装 conversationId 查询串且 --json 原样输出', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-sd-')
  const docBody = { pluginId: 'p:sd', name: 'metrics', conversationId: 7, value: { n: 3 } }
  const hub = await startMockHub(
    {
      'GET /api/plugins/p%3Asd/docs/metrics?conversationId=7': () => ({ body: docBody }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['plugins', 'doc', 'p:sd', 'metrics', '--conversation', '7', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(r.out), docBody)
  assert.equal(hub.hits.length, 1)
  assert.equal(hub.hits[0]!.path, '/api/plugins/p%3Asd/docs/metrics?conversationId=7')
  assert.equal(hub.hits[0]!.authorization, 'Bearer t-test')
})

test('plugins doc --current：读 HELM_CONVERSATION_ID；与 --conversation 互斥报错', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-sd-')
  const docBody = { pluginId: 'p:sd', name: 'metrics', conversationId: 42, value: 'text-value' }
  const hub = await startMockHub(
    {
      'GET /api/plugins/p%3Asd/docs/metrics?conversationId=42': () => ({ body: docBody }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '42' })
  const res = await runCliCaptured(['plugins', 'doc', 'p:sd', 'metrics', '--current', '--json'], env)
  assert.equal(res.code, 0, res.err)
  assert.deepEqual(JSON.parse(res.out), docBody)
  assert.equal(hub.hits[0]!.path, '/api/plugins/p%3Asd/docs/metrics?conversationId=42')

  // 互斥：显式非零退出码
  const conflict = await runCliCaptured(
    ['plugins', 'doc', 'p:sd', 'metrics', '--conversation', '7', '--current', '--json'],
    env,
  )
  assert.notEqual(conflict.code, 0)
  assert.equal(parseCliError(conflict).code, 'conflicting_flags')
  assert.equal(hub.hits.length, 1, '互斥失败不产生额外请求')
})

test('plugins doc --watch：订阅专用 SSE，snapshot 与增量帧均输出（NDJSON）', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-sd-')
  const snapshot = { seq: 1, doc: { pluginId: 'p:sd', name: 'metrics', conversationId: 1, value: { n: 1 } } }
  const delta = { seq: 2, event: { type: 'plugin.session_doc.updated', doc: { pluginId: 'p:sd', name: 'metrics', conversationId: 1, value: { n: 2 } } } }
  const hub = await startMockHub(
    {
      'GET /api/plugins/p%3Asd/docs/metrics/events?conversationId=1': () => ({
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\nevent: plugin.session_doc.updated\ndata: ${JSON.stringify(delta)}\n\n`,
      }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '1' })
  const r = await runCliCaptured(['plugins', 'doc', 'p:sd', 'metrics', '--current', '--watch', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.equal(hub.hits.length, 1)
  assert.equal(hub.hits[0]!.path, '/api/plugins/p%3Asd/docs/metrics/events?conversationId=1')
  assert.match(r.out, /"event":"snapshot"|"seq":1/)
  assert.match(r.out, /plugin\.session_doc\.updated/)
  assert.match(r.out, /"n":2/)
})

test('plugins doc --watch 缺会话目标：显式报错不建连', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-sd-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const r = await runCliCaptured(['plugins', 'doc', 'p:sd', 'metrics', '--watch', '--json'], makeCliEnv(hub.url, dir))
  assert.notEqual(r.code, 0)
  assert.equal(parseCliError(r).code, 'missing_conversation_target')
  assert.equal(hub.hits.length, 0)
})

test('plugins doc 404 结构化错误透出（插件停用/会话删除：CLI 停止重试依据）', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-sd-')
  const hub = await startMockHub(
    {
      'GET /api/plugins/p%3Asd/docs/metrics?conversationId=9': () => ({
        status: 404,
        body: { error: { code: 'plugin_doc_not_found', message: '插件 p:sd 无公共会话文档 metrics' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['plugins', 'doc', 'p:sd', 'metrics', '--conversation', '9', '--json'], makeCliEnv(hub.url, dir))
  assert.notEqual(r.code, 0)
  assert.equal(parseCliError(r).code, 'plugin_doc_not_found')
  assert.equal(hub.hits.length, 1)
})
