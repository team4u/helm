/**
 * CLI 新命令测试：artifacts put / send --attach / conversations reset|compact|fork。
 * 真实 HTTP server 模拟 Hub 契约（cli.test.ts 同款模式）：验证路径、方法、
 * 请求头（x-artifact-filename URL 编码、x-artifact-mime-type）、二进制 body
 * 字节一致、--json 输出与错误信封。
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
  headers: Record<string, string | string[] | undefined>
  body?: unknown
  rawBody?: Buffer
  authorization?: string | string[] | undefined
}

async function startHub(
  routes: Record<string, (body: unknown, req: http.IncomingMessage) => { status?: number; body?: unknown }>,
): Promise<{ url: string; recorded: { hits: Hit[] }; close: () => Promise<void> }> {
  const allRoutes: Record<string, (body: unknown, req: http.IncomingMessage) => { status?: number; body?: unknown }> = {
    'GET /api/actions': () => ({ body: [] }),
    ...routes,
  }
  const hits: Hit[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks)
      let body: unknown
      if (rawBody.length > 0) {
        try {
          body = JSON.parse(rawBody.toString('utf8'))
        } catch {
          body = undefined
        }
      }
      const full = `${req.method} ${req.url}`
      const capturedHeaders: Record<string, string | string[] | undefined> = { ...req.headers }
      hits.push({
        method: req.method!,
        path: req.url!,
        headers: capturedHeaders,
        authorization: capturedHeaders['authorization'],
        body,
        ...(rawBody.length > 0 ? { rawBody } : {}),
      })
      const handler = allRoutes[full]
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'not_found', message: `无路由 ${full}` } }))
        return
      }
      const result = handler(body, req)
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
    recorded: { hits },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

interface Captured {
  out: string
  err: string
  code: number
}

async function run(argv: string[], env: NodeJS.ProcessEnv): Promise<Captured> {
  let out = ''
  let err = ''
  const code = await runCli(argv, { env, stdout: (t) => (out += t), stderr: (t) => (err += t) })
  return { out, err, code }
}

async function tempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'helm-cli-attach-'))
}

function makeEnv(hubUrl: string, dataDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HELM_HUB_URL: hubUrl, HELM_DATA_DIR: dataDir, HELM_TOKEN: 't-test', ...extra }
}

// ---------------------------------------------------------------------------
// artifacts put
// ---------------------------------------------------------------------------

test('artifacts put：二进制流上传（octet-stream + 编码文件名 + 字节一致）', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const file = path.join(dir, '数据 报告.md')
  const content = Buffer.from('# 标题\n内容行', 'utf8')
  await fsp.writeFile(file, content)
  const hub = await startHub({
    'POST /api/conversations/3/artifacts': () => ({
      status: 201,
      body: { id: 'art-1', conversationId: 3, name: '数据 报告.md', size: content.byteLength, mimeType: 'text/markdown', createdAt: 1 },
    }),
  })
  try {
    const r = await run(['artifacts', 'put', file, '3', '--json'], makeEnv(hub.url, dir))
    assert.equal(r.code, 0, r.err)
    assert.equal(JSON.parse(r.out).id, 'art-1')
    const hit = hub.recorded.hits.at(-1)!
    assert.equal(hit.method, 'POST')
    assert.equal(hit.path, '/api/conversations/3/artifacts')
    assert.equal(hit.headers['content-type'], 'application/octet-stream')
    assert.equal(hit.headers['x-artifact-filename'], encodeURIComponent('数据 报告.md'))
    // 二进制 body 字节一致。
    assert.ok(hit.rawBody !== undefined)
    assert.deepEqual([...hit.rawBody!], [...content])
  } finally {
    await hub.close()
  }
})

test('artifacts put：--name 与 --mime-type 覆盖；--current 目标会话', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const file = path.join(dir, 'plain.txt')
  await fsp.writeFile(file, 'abc')
  const hub = await startHub({
    'POST /api/conversations/7/artifacts': () => ({ status: 201, body: { id: 'x' } }),
  })
  try {
    const r = await run(
      ['artifacts', 'put', file, '--current', '--name', 'renamed.bin', '--mime-type', 'application/x-thing', '--json'],
      makeEnv(hub.url, dir, { HELM_CONVERSATION_ID: '7' }),
    )
    assert.equal(r.code, 0, r.err)
    const hit = hub.recorded.hits.at(-1)!
    assert.equal(hit.path, '/api/conversations/7/artifacts')
    assert.equal(hit.headers['x-artifact-filename'], 'renamed.bin')
    assert.equal(hit.headers['x-artifact-mime-type'], 'application/x-thing')
  } finally {
    await hub.close()
  }
})

test('artifacts put：文件缺失 read_failed；目录 read_failed；多余位置参数报错', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({})
  try {
    const missing = await run(['artifacts', 'put', path.join(dir, 'nope.bin'), '1'], makeEnv(hub.url, dir))
    assert.equal(missing.code, 1)
    assert.ok(missing.err.includes('读取上传文件失败'), `stderr 应含读取失败诊断：${missing.err}`)
    const dirTarget = await run(['artifacts', 'put', dir, '1'], makeEnv(hub.url, dir))
    assert.equal(dirTarget.code, 1)
    assert.ok(dirTarget.err.includes('不是常规文件'))
    const file = path.join(dir, 'ok.txt')
    await fsp.writeFile(file, 'x')
    const extra = await run(['artifacts', 'put', file, '1', 'junk'], makeEnv(hub.url, dir))
    assert.equal(extra.code, 1)
    assert.ok(extra.err.includes('多余位置参数'))
  } finally {
    await hub.close()
  }
})

test('artifacts put：Hub 413 artifact_too_large 错误信封转 CLI 非零退出', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const file = path.join(dir, 'big.bin')
  await fsp.writeFile(file, Buffer.alloc(1024))
  const hub = await startHub({
    'POST /api/conversations/1/artifacts': () => ({
      status: 413,
      body: { error: { code: 'artifact_too_large', message: '产物大小超过 15 MiB 上限' } },
    }),
  })
  try {
    const r = await run(['artifacts', 'put', file, '1'], makeEnv(hub.url, dir))
    assert.equal(r.code, 1)
    assert.ok(r.err.includes('产物大小超过 15 MiB 上限'), `stderr 应含 Hub 错误消息：${r.err}`)
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// send --attach
// ---------------------------------------------------------------------------

test('send --attach：逗号分隔产物 ID 进入 body.attachments；空值忽略', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'POST /api/conversations/5/input': () => ({ status: 202, body: { submissionId: 's-1' } }),
  })
  try {
    const r = await run(
      ['send', '5', '查收', '--attach', 'art-a, art-b ,,art-c', '--json'],
      makeEnv(hub.url, dir),
    )
    assert.equal(r.code, 0, r.err)
    const hit = hub.recorded.hits.at(-1)!
    assert.deepEqual(hit.body, { text: '查收', attachments: ['art-a', 'art-b', 'art-c'] })

    // --attach 空串：不产生 attachments 字段。
    const r2 = await run(['send', '5', '无附件', '--attach', ' , ,', '--json'], makeEnv(hub.url, dir))
    assert.equal(r2.code, 0, r2.err)
    const hit2 = hub.recorded.hits.at(-1)!
    assert.deepEqual(hit2.body, { text: '无附件' })
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// conversations reset / compact / fork
// ---------------------------------------------------------------------------

test('conversations reset：handoff 进 body；--current；空 body 合法', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'POST /api/conversations/9/reset': () => ({ body: { id: 9, status: 'idle' } }),
  })
  try {
    const r = await run(
      ['conversations', 'reset', '9', '--handoff', '交接文本', '--json'],
      makeEnv(hub.url, dir),
    )
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(hub.recorded.hits.at(-1)!.body, { handoff: '交接文本' })

    const r2 = await run(['conversations', 'reset', '--current', '--json'], makeEnv(hub.url, dir, { HELM_CONVERSATION_ID: '9' }))
    assert.equal(r2.code, 0, r2.err)
    assert.equal(hub.recorded.hits.at(-1)!.path, '/api/conversations/9/reset')
    // 无 handoff：body 为空对象。
    assert.deepEqual(hub.recorded.hits.at(-1)!.body, {})
  } finally {
    await hub.close()
  }
})

test('conversations compact：instructions 进 body；--current', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'POST /api/conversations/12/compact': () => ({ status: 202, body: { taskId: 77, conversation: { id: 12 } } }),
  })
  try {
    const r = await run(
      ['conversations', 'compact', '12', '--instructions', '保留决策', '--json'],
      makeEnv(hub.url, dir),
    )
    assert.equal(r.code, 0, r.err)
    assert.equal(JSON.parse(r.out).taskId, 77)
    assert.deepEqual(hub.recorded.hits.at(-1)!.body, { instructions: '保留决策' })

    const r2 = await run(['conversations', 'compact', '--current', '--json'], makeEnv(hub.url, dir, { HELM_CONVERSATION_ID: '12' }))
    assert.equal(r2.code, 0, r2.err)
    assert.deepEqual(hub.recorded.hits.at(-1)!.body, {})
  } finally {
    await hub.close()
  }
})

test('conversations fork：--entry-id 必填进 body；--title 可选；--current', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'POST /api/conversations/4/fork': () => ({ status: 201, body: { id: 44, title: 't (分叉)' } }),
  })
  try {
    const r = await run(
      ['conversations', 'fork', '4', '--entry-id', '33', '--title', '新分叉', '--json'],
      makeEnv(hub.url, dir),
    )
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(hub.recorded.hits.at(-1)!.body, { entryId: 33, title: '新分叉' })

    const r2 = await run(['conversations', 'fork', '--current', '--entry-id', '8', '--json'], makeEnv(hub.url, dir, { HELM_CONVERSATION_ID: '4' }))
    assert.equal(r2.code, 0, r2.err)
    assert.deepEqual(hub.recorded.hits.at(-1)!.body, { entryId: 8 })

    // 缺 --entry-id：必填校验。
    const r3 = await run(['conversations', 'fork', '4'], makeEnv(hub.url, dir))
    assert.equal(r3.code, 1)
    assert.ok(r3.err.includes('缺少必填选项 --entry-id'))
  } finally {
    await hub.close()
  }
})
