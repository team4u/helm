/**
 * CLI 核心对齐测试：detail 分页 flag / send --meta/--wait / workflows runs /
 * run --wait / plugins doc / conversations list --profile/--status。
 * 模拟 Hub 契约（同 cli.test.ts 基座），验证路径、query、body 与退出码语义。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCli } from '../src/cli/index.js'

interface Hit {
  method: string
  path: string
  body?: unknown
}

async function startHub(
  routes: Record<string, (body: unknown) => { status?: number; body?: unknown }>,
): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const allRoutes: Record<string, (body: unknown) => { status?: number; body?: unknown }> = {
    'GET /api/actions': () => ({ body: [] }),
    ...routes,
  }
  const hits: Hit[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      let body: unknown
      if (rawBody) {
        try {
          body = JSON.parse(rawBody)
        } catch {
          body = rawBody
        }
      }
      hits.push({ method: req.method!, path: req.url!, body })
      const handler = allRoutes[`${req.method} ${req.url}`]
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'not_found', message: `无路由 ${req.method} ${req.url}` } }))
        return
      }
      const result = handler(body)
      const status = result.status ?? 200
      if (result.body === undefined) {
        res.writeHead(status)
        res.end()
        return
      }
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result.body))
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

function makeEnv(hubUrl: string, dataDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HELM_HUB_URL: hubUrl, HELM_DATA_DIR: dataDir, HELM_TOKEN: 't-test', ...extra }
}

async function run(argv: string[], env: NodeJS.ProcessEnv): Promise<{ out: string; err: string; code: number }> {
  let out = ''
  let err = ''
  const code = await runCli(argv, { env, stdout: (t) => (out += t), stderr: (t) => (err += t) })
  return { out, err, code }
}

async function tempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'helm-cli-align-'))
}

// ---------------------------------------------------------------------------
// conversations get --limit/--cursor/--current
// ---------------------------------------------------------------------------

test('conversations get：--limit/--cursor 映射 query；--current 读 env', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/conversations/7': () => ({
      body: { id: 7, title: 'x', entries: [], nextCursor: '{"a":1}' },
    }),
    'GET /api/conversations/7?limit=10': () => ({ body: { id: 7, entries: [] } }),
    'GET /api/conversations/7?cursor=%7B%22a%22%3A1%7D': () => ({ body: { id: 7, entries: [] } }),
    'GET /api/conversations/7?limit=10&cursor=%7B%22a%22%3A1%7D': () => ({ body: { id: 7, entries: [] } }),
  })
  try {
    const plain = await run(['conversations', 'get', '7', '--json'], makeEnv(hub.url, dir))
    assert.equal(plain.code, 0, plain.err)
    assert.equal(JSON.parse(plain.out).id, 7)

    const limited = await run(['conversations', 'get', '7', '--limit', '10', '--json'], makeEnv(hub.url, dir))
    assert.equal(limited.code, 0, limited.err)
    assert.equal(hub.hits.at(-1)?.path, '/api/conversations/7?limit=10')

    const cursor = await run(['conversations', 'get', '7', '--cursor', '{"a":1}', '--json'], makeEnv(hub.url, dir))
    assert.equal(cursor.code, 0, cursor.err)
    assert.equal(hub.hits.at(-1)?.path, '/api/conversations/7?cursor=%7B%22a%22%3A1%7D')

    const both = await run(['conversations', 'get', '--current', '--limit', '10', '--cursor', '{"a":1}', '--json'], {
      ...makeEnv(hub.url, dir),
      HELM_CONVERSATION_ID: '7',
    })
    assert.equal(both.code, 0, both.err)
    assert.equal(hub.hits.at(-1)?.path, '/api/conversations/7?limit=10&cursor=%7B%22a%22%3A1%7D')

    // 非法 limit 显式报错（不发请求）
    const bad = await run(['conversations', 'get', '7', '--limit', '0', '--json'], makeEnv(hub.url, dir))
    assert.equal(bad.code, 1)
    assert.equal((JSON.parse(bad.err) as { error: { code: string } }).error.code, 'invalid_flag_value')
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// conversations list --profile/--status
// ---------------------------------------------------------------------------

test('conversations list：--profile 映射 profileId、--status 校验枚举后入 query', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/conversations': () => ({ body: [] }),
    'GET /api/conversations?profileId=worker': () => ({ body: [] }),
    'GET /api/conversations?status=idle': () => ({ body: [] }),
    'GET /api/conversations?profileId=worker&status=working': () => ({ body: [] }),
  })
  try {
    const byProfile = await run(['conversations', 'list', '--profile', 'worker', '--json'], makeEnv(hub.url, dir))
    assert.equal(byProfile.code, 0, byProfile.err)
    assert.equal(hub.hits.at(-1)?.path, '/api/conversations?profileId=worker')

    const byStatus = await run(['conversations', 'list', '--status', 'idle', '--json'], makeEnv(hub.url, dir))
    assert.equal(byStatus.code, 0, byStatus.err)
    assert.equal(hub.hits.at(-1)?.path, '/api/conversations?status=idle')

    const both = await run(['conversations', 'list', '--profile', 'worker', '--status', 'working', '--json'], makeEnv(hub.url, dir))
    assert.equal(both.code, 0, both.err)
    assert.equal(hub.hits.at(-1)?.path, '/api/conversations?profileId=worker&status=working')

    const bad = await run(['conversations', 'list', '--status', 'bogus', '--json'], makeEnv(hub.url, dir))
    assert.equal(bad.code, 1)
    assert.equal((JSON.parse(bad.err) as { error: { code: string } }).error.code, 'invalid_flag_value')
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// send --meta / --wait
// ---------------------------------------------------------------------------

test('send --meta：JSON 对象入 body.meta；非对象 JSON 在 CLI 层显式拒绝', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'POST /api/conversations/7/input': () => ({ status: 202, body: { submissionId: 'sub-9' } }),
  })
  const env = makeEnv(hub.url, dir)
  try {
    const ok = await run(['send', '7', '你好', '--meta', '{"source":"cron","n":1}', '--json'], env)
    assert.equal(ok.code, 0, ok.err)
    const hit = hub.hits.find((h) => h.path === '/api/conversations/7/input')!
    assert.deepEqual(hit.body, { text: '你好', meta: { source: 'cron', n: 1 } })

    const asArray = await run(['send', '7', 'x', '--meta', '[1]', '--json'], env)
    assert.equal(asArray.code, 1)
    assert.equal((JSON.parse(asArray.err) as { error: { code: string } }).error.code, 'invalid_flag_value')

    // 不提供 --meta 时 body 不含 meta 键（保留 -- 分隔符文本行为：
    // 全局 --json 在 -- 之前剥离，之后的 --json 作为待发送文本）
    const noMeta = await run(['send', '7', '--json', '--', '--json'], env)
    assert.equal(noMeta.code, 0, noMeta.err)
    assert.deepEqual((hub.hits.at(-1)?.body as { text: string }).text, '--json')
    assert.ok(!('meta' in (hub.hits.at(-1)?.body as Record<string, unknown>)))
  } finally {
    await hub.close()
  }
})

test('send --wait：?wait=1；json 输出完整 result、人类模式直出回答文本', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const result = {
    conversationId: 7,
    submissionId: 'sub-9',
    text: '你好',
    entry: {
      id: 'e1',
      kind: 'pi.assistant',
      model: [{ role: 'assistant', content: [{ type: 'text', text: '回答正文' }] }],
    },
  }
  const hub = await startHub({
    'POST /api/conversations/7/input?wait=1': () => ({ body: result }),
    'POST /api/conversations/7/input': () => ({ status: 202, body: { submissionId: 'sub-9' } }),
  })
  const env = makeEnv(hub.url, dir)
  try {
    const json = await run(['send', '7', '你好', '--wait', '--json'], env)
    assert.equal(json.code, 0, json.err)
    assert.deepEqual(JSON.parse(json.out), result)
    assert.equal(hub.hits.at(-1)?.path, '/api/conversations/7/input?wait=1')

    const human = await run(['send', '7', '你好', '--wait'], env)
    assert.equal(human.code, 0, human.err)
    assert.equal(human.out, '回答正文\n')

    // wait 失败（input_unanswered 409）→ 非零退出 + 错误信封
    const hub2 = await startHub({
      'POST /api/conversations/7/input?wait=1': () => ({
        status: 409,
        body: { error: { code: 'input_unanswered', message: '输入未获回答（aborted）' } },
      }),
    })
    try {
      const failed = await run(['send', '7', 'x', '--wait', '--json'], makeEnv(hub2.url, dir))
      assert.equal(failed.code, 1)
      assert.equal((JSON.parse(failed.err) as { error: { code: string } }).error.code, 'input_unanswered')
    } finally {
      await hub2.close()
    }
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// workflows runs / run --wait
// ---------------------------------------------------------------------------

test('workflows runs：列出全部；--current 过滤 conversationId；多余位置参数拒绝', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/workflows/runs': () => ({
      body: [{ id: 'wf_1', name: 'demo', conversationId: 1, status: 'completed', createdAt: 1, updatedAt: 1 }],
    }),
    'GET /api/workflows/runs?conversationId=7': () => ({ body: [] }),
  })
  const env = makeEnv(hub.url, dir)
  try {
    const all = await run(['workflows', 'runs', '--json'], env)
    assert.equal(all.code, 0, all.err)
    assert.equal(JSON.parse(all.out)[0].id, 'wf_1')
    assert.equal(hub.hits.at(-1)?.path, '/api/workflows/runs')

    const filtered = await run(['workflows', 'runs', '--current', '--json'], { ...env, HELM_CONVERSATION_ID: '7' })
    assert.equal(filtered.code, 0, filtered.err)
    assert.equal(hub.hits.at(-1)?.path, '/api/workflows/runs?conversationId=7')

    const stray = await run(['workflows', 'runs', 'wf_1', '--json'], env)
    assert.equal(stray.code, 1)
    assert.equal((JSON.parse(stray.err) as { error: { code: string } }).error.code, 'unexpected_positional')
  } finally {
    await hub.close()
  }
})

test('workflows run --wait：终态成功输出 summary/result；failed 非零退出', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const doneSummary = {
    id: 'wf_w',
    name: 'demo',
    conversationId: 1,
    status: 'completed',
    createdAt: 1,
    updatedAt: 2,
    result: { answer: 42 },
  }
  const hub = await startHub({
    'POST /api/workflows/run?wait=1': () => ({ body: doneSummary }),
    'POST /api/workflows/run': () => ({
      status: 202,
      body: { id: 'wf_w', name: 'demo', conversationId: 1, status: 'running', createdAt: 1, updatedAt: 1 },
    }),
  })
  const env = makeEnv(hub.url, dir)
  try {
    const json = await run(['workflows', 'run', 'demo', '--wait', '--json'], env)
    assert.equal(json.code, 0, json.err)
    assert.deepEqual(JSON.parse(json.out), doneSummary)
    assert.equal(hub.hits.at(-1)?.path, '/api/workflows/run?wait=1')

    const human = await run(['workflows', 'run', 'demo', '--wait'], env)
    assert.equal(human.code, 0, human.err)
    assert.match(human.out, /run wf_w completed/)
    assert.match(human.out, /42/)

    // 不带 --wait 保持 202 异步语义
    const asyncRun = await run(['workflows', 'run', 'demo', '--json'], env)
    assert.equal(asyncRun.code, 0, asyncRun.err)
    assert.equal(JSON.parse(asyncRun.out).status, 'running')

    // failed 终态：Hub 错误信封 → 非零退出（不把空 result 当成功）
    const hub2 = await startHub({
      'POST /api/workflows/run?wait=1': () => ({
        status: 500,
        body: { error: { code: 'workflow_failed', message: 'boom', details: { runId: 'wf_f', status: 'failed' } } },
      }),
    })
    try {
      const failed = await run(['workflows', 'run', 'demo', '--wait', '--json'], makeEnv(hub2.url, dir))
      assert.equal(failed.code, 1)
      assert.equal((JSON.parse(failed.err) as { error: { code: string } }).error.code, 'workflow_failed')
    } finally {
      await hub2.close()
    }
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// plugins doc
// ---------------------------------------------------------------------------

test('plugins doc：GET /api/plugins/:id/docs/:name；json 全量、人类模式直出值', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/plugins/builtin%3Astatusboard/docs/board': () => ({
      body: { pluginId: 'builtin:statusboard', name: 'board', value: { count: 42 } },
    }),
    'GET /api/plugins/builtin%3Astatusboard/docs/notes': () => ({
      body: { pluginId: 'builtin:statusboard', name: 'notes', value: '纯文本文档' },
    }),
    'GET /api/plugins/builtin%3Astatusboard/docs/secret': () => ({
      status: 404,
      body: { error: { code: 'plugin_doc_not_found', message: '无公共文档' } },
    }),
  })
  const env = makeEnv(hub.url, dir)
  try {
    const json = await run(['plugins', 'doc', 'builtin:statusboard', 'board', '--json'], env)
    assert.equal(json.code, 0, json.err)
    assert.deepEqual(JSON.parse(json.out), { pluginId: 'builtin:statusboard', name: 'board', value: { count: 42 } })

    const human = await run(['plugins', 'doc', 'builtin:statusboard', 'board'], env)
    assert.equal(human.code, 0, human.err)
    assert.match(human.out, /count/)
    assert.match(human.out, /42/)

    const textValue = await run(['plugins', 'doc', 'builtin:statusboard', 'notes'], env)
    assert.equal(textValue.code, 0, textValue.err)
    assert.equal(textValue.out, 'notes\n纯文本文档\n')

    const missing = await run(['plugins', 'doc', 'builtin:statusboard', 'secret', '--json'], env)
    assert.equal(missing.code, 1)
    assert.equal((JSON.parse(missing.err) as { error: { code: string } }).error.code, 'plugin_doc_not_found')

    const noArgs = await run(['plugins', 'doc', 'builtin:statusboard', '--json'], env)
    assert.equal(noArgs.code, 1)
    assert.equal((JSON.parse(noArgs.err) as { error: { code: string } }).error.code, 'missing_id')
  } finally {
    await hub.close()
  }
})
