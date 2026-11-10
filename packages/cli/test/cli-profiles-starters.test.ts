/**
 * helm profiles --starters 语义化 flag 测试：
 * - create/update 携带 starters 数组、update 合并不丢其他字段；
 * - [] 清空语义（显式写入空数组，非删键）；
 * - 非法值（非数组/形状错误/超限）在发 HTTP 前本地拒绝（hub 无命中）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCli } from '../src/index.js'

interface Hit {
  method: string
  path: string
  body?: unknown
}

async function startHub(
  routes: Record<string, (body: unknown) => { status?: number; body?: unknown } | null>,
): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown
      if (raw) {
        try {
          body = JSON.parse(raw)
        } catch {
          body = raw
        }
      }
      const full = `${req.method} ${req.url}`
      hits.push({ method: req.method!, path: req.url!, body })
      const handler = routes[full]
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'not_found', message: `无路由 ${full}` } }))
        return
      }
      const result = handler(body)
      if (result === null) return
      const status = result.status ?? 200
      const payload = result.body === undefined ? {} : result.body
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address !== null && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function makeEnv(hubUrl: string, dataDir: string): NodeJS.ProcessEnv {
  return { HELM_HUB_URL: hubUrl, HELM_DATA_DIR: dataDir, HELM_TOKEN: 't-test' }
}

async function run(argv: string[], env: NodeJS.ProcessEnv): Promise<{ out: string; err: string; code: number }> {
  let out = ''
  let err = ''
  const code = await runCli(argv, { env, stdout: (t) => (out += t), stderr: (t) => (err += t) })
  return { out, err, code }
}

async function tempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'helm-cli-starters-'))
}

test('profiles create --starters：数组进 body；--json 同权输出', { timeout: 60_000 }, async () => {
  const hub = await startHub({
    'POST /api/profiles': (body) => ({ body }),
  })
  const env = makeEnv(hub.url, await tempDir())
  try {
    const r = await run(
      [
        'profiles', 'create', 'helper', '--name', '助手',
        '--starters', '[{"label":"写日报","prompt":"请生成今日日报"}]',
        '--json',
      ],
      env,
    )
    assert.equal(r.code, 0, r.err)
    const posted = hub.hits.find((h) => h.method === 'POST')?.body as Record<string, unknown>
    assert.deepEqual(posted.starters, [{ label: '写日报', prompt: '请生成今日日报' }])
    assert.equal(posted.name, '助手')
  } finally {
    await hub.close()
  }
})

test('profiles update --starters：先 GET 合并，未触及字段（runtime/nodeId/tags）不丢，[] 显式清空', { timeout: 60_000 }, async () => {
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
  const hub = await startHub({
    'GET /api/profiles/worker': () => ({ body: existing }),
    'PUT /api/profiles/worker': (body) => ({ body }),
  })
  const env = makeEnv(hub.url, await tempDir())
  try {
    // 语义化 flag 路径：GET 合并后 PUT，starters 替换、runtime/nodeId/tags 保留
    const r = await run(
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
    const clear = await run(['profiles', 'update', 'worker', '--starters', '[]', '--json'], env)
    assert.equal(clear.code, 0, clear.err)
    const putClear = hub.hits.find((h) => h.method === 'PUT')?.body as Record<string, unknown>
    assert.deepEqual(putClear.starters, [])
    assert.deepEqual(putClear.runtime, existing.runtime)

    // 其他 flag 不丢 starters：GET 基底合并保留
    hub.hits.length = 0
    const rename = await run(['profiles', 'update', 'worker', '--name', '新名', '--json'], env)
    assert.equal(rename.code, 0, rename.err)
    const putRename = hub.hits.find((h) => h.method === 'PUT')?.body as Record<string, unknown>
    assert.deepEqual(putRename.starters, [{ label: '旧引导', prompt: '旧提示' }])
    assert.equal(putRename.name, '新名')
  } finally {
    await hub.close()
  }
})

test('profiles --starters：非法值在发 HTTP 前拒绝（无 hub 命中）', { timeout: 60_000 }, async () => {
  const hub = await startHub({
    'GET /api/profiles/worker': () => ({ body: { id: 'worker' } }),
    'PUT /api/profiles/worker': (body) => ({ body }),
    'POST /api/profiles': (body) => ({ body }),
  })
  const env = makeEnv(hub.url, await tempDir())
  try {
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
      const r = await run(argv, env)
      assert.notEqual(r.code, 0, `应非零退出: ${argv.join(' ')}`)
      assert.match(r.err, pattern)
    }
    // 校验失败发生在 HTTP 之前：hub 零命中
    assert.equal(hub.hits.length, 0, `校验应发生在 HTTP 前，实际命中 ${JSON.stringify(hub.hits)}`)
  } finally {
    await hub.close()
  }
})
