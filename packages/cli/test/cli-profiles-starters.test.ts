/**
 * helm profiles --starters 语义化 flag 测试：
 * - create/update 携带 starters 数组、update 合并不丢其他字段；
 * - [] 清空语义（显式写入空数组，非删键）；
 * - 非法值（非数组/形状错误/超限）在发 HTTP 前本地拒绝（hub 无命中）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  makeCliEnv,
  runCliCaptured,
  startMockHub,
  useTempDir,
} from './helpers/cli-harness.js'

test('profiles create --starters：数组进 body；--json 同权输出', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-starters-')
  const hub = await startMockHub({ 'POST /api/profiles': (body) => ({ body }) }, { autoRegisterCleanup: t })
  const r = await runCliCaptured(
    [
      'profiles', 'create', 'helper', '--name', '助手',
      '--starters', '[{"label":"写日报","prompt":"请生成今日日报"}]',
      '--json',
    ],
    makeCliEnv(hub.url, dir),
  )
  assert.equal(r.code, 0, r.err)
  const posted = hub.hits.find((h) => h.method === 'POST')?.body as Record<string, unknown>
  assert.deepEqual(posted.starters, [{ label: '写日报', prompt: '请生成今日日报' }])
  assert.equal(posted.name, '助手')
})

test('profiles update --starters：先 GET 合并，未触及字段（runtime/nodeId/tags）不丢，[] 显式清空', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-starters-')
  const existing = {
    id: 'worker',
    name: '工人',
    model: 'openai/gpt-4o',
    nodeId: 'gpu-box',
    cwd: '/workspace',
    tags: ['worker'],
    runtime: { kind: 'herdr', agent: 'agy' },
    starters: [{ label: '旧引导', prompt: '旧提示' }],
  }
  const hub = await startMockHub(
    {
      'GET /api/profiles/worker': () => ({ body: existing }),
      'PUT /api/profiles/worker': (body) => ({ body }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  // 语义化 flag 路径：GET 合并后 PUT，starters 替换、runtime/nodeId/tags 保留
  const r = await runCliCaptured(
    ['profiles', 'update', 'worker', '--starters', '[{"label":"新引导","prompt":"新提示"}]', '--json'],
    env,
  )
  assert.equal(r.code, 0, r.err)
  const put = hub.hits.find((h) => h.method === 'PUT')?.body as Record<string, unknown>
  assert.deepEqual(put.starters, [{ label: '新引导', prompt: '新提示' }])
  assert.deepEqual(put.runtime, existing.runtime)
  assert.equal(put.nodeId, 'gpu-box')
  assert.deepEqual(put.tags, ['worker'])

  // [] 清空：显式写空数组（不是删键、不是恢复旧值）
  hub.hits.length = 0
  const clear = await runCliCaptured(['profiles', 'update', 'worker', '--starters', '[]', '--json'], env)
  assert.equal(clear.code, 0, clear.err)
  const putClear = hub.hits.find((h) => h.method === 'PUT')?.body as Record<string, unknown>
  assert.deepEqual(putClear.starters, [])
  assert.deepEqual(putClear.runtime, existing.runtime)

  // 其他 flag 不丢 starters：GET 基底合并保留
  hub.hits.length = 0
  const rename = await runCliCaptured(['profiles', 'update', 'worker', '--name', '新名', '--json'], env)
  assert.equal(rename.code, 0, rename.err)
  const putRename = hub.hits.find((h) => h.method === 'PUT')?.body as Record<string, unknown>
  assert.deepEqual(putRename.starters, [{ label: '旧引导', prompt: '旧提示' }])
  assert.equal(putRename.name, '新名')
})

test('profiles --starters：非法值在发 HTTP 前拒绝（无 hub 命中）', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-starters-')
  const hub = await startMockHub(
    {
      'GET /api/profiles/worker': () => ({ body: { id: 'worker' } }),
      'PUT /api/profiles/worker': (body) => ({ body }),
      'POST /api/profiles': (body) => ({ body }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const bad: Array<[string[], RegExp]> = [
    [['profiles', 'create', 'w', '--starters', '{"label":"x","prompt":"y"}'], /--starters 需为 JSON 数组/],
    [['profiles', 'create', 'w', '--starters', '[{"label":"x"}]'], /prompt 需为字符串/],
    [['profiles', 'create', 'w', '--starters', '[{"label":" ","prompt":"y"}]'], /label 去除首尾空白后不能为空/],
    [['profiles', 'create', 'w', '--starters', '[{"label":"x","prompt":""}]'], /prompt 不能是纯空白/],
    [
      ['profiles', 'create', 'w', '--starters', JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ label: `s${i}`, prompt: 'p' })))],
      /--starters 最多 6 项/,
    ],
    [['profiles', 'update', 'w', '--starters', '[{"label":"x","prompt":"y","extra":1}]'], /仅接受 label 与 prompt 字段/],
  ]
  for (const [argv, pattern] of bad) {
    const r = await runCliCaptured(argv, env)
    assert.notEqual(r.code, 0, `应非零退出: ${argv.join(' ')}`)
    assert.match(r.err, pattern)
  }
  // 校验失败发生在 HTTP 之前：hub 零命中
  assert.equal(hub.hits.length, 0, `校验应发生在 HTTP 前，实际命中 ${JSON.stringify(hub.hits)}`)
})
