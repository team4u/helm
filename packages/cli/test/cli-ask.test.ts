/**
 * helm ask 单元测试：临时 HTTP server 模拟 Hub 契约（真实 fetch 边界）。
 * 覆盖：基本链路（创建+等待+输出）、stdin 管道并入、空输入拒绝、创建失败、
 * 生成失败保留会话、--delete-on-success、--timeout 校验与等待超时。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCli } from '../src/index.js'
import type { StdinSource } from '../src/options.js'

interface Hit {
  method: string
  path: string
  body?: unknown
}

type RouteHandler = (body: unknown, req: http.IncomingMessage) => Promise<{ status?: number; body?: unknown }> | { status?: number; body?: unknown }

async function startHub(routes: Record<string, RouteHandler>): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const allRoutes: Record<string, RouteHandler> = { 'GET /api/actions': () => ({ body: [] }), ...routes }
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
      void Promise.resolve(handler(body, req)).then((result) => {
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

interface Captured {
  out: string
  err: string
  code: number
}

async function run(argv: string[], env: NodeJS.ProcessEnv, stdin?: StdinSource): Promise<Captured> {
  let out = ''
  let err = ''
  const code = await runCli(argv, { env, stdout: (t) => (out += t), stderr: (t) => (err += t), stdin })
  return { out, err, code }
}

async function tempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'helm-ask-test-'))
}

/** TTY 替身：readAll 被调用即失败（TTY 下绝不读取管道）。 */
function ttyStdin(): StdinSource {
  return {
    isTTY: true,
    readAll: () => Promise.reject(new Error('TTY 下不应读取 stdin')),
  }
}

function pipedStdin(text: string): StdinSource {
  return { isTTY: false, readAll: () => Promise.resolve(text) }
}

/** 模拟 ConversationInputResult（assistant 文本块在 entry.model）。 */
const waitResult = (answer: string, conversationId = 9) => ({
  conversationId,
  submissionId: 'sub-1',
  text: 'x',
  entry: {
    id: 'e1',
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'text', text: answer }] }],
  },
})

const createdSummary = (id = 9) => ({ id, title: 't', profileId: 'default', tags: [] })

test('ask 基本链路：创建会话 + ?wait=1 等待；--json 结构化、人类模式只出回答文本', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'POST /api/conversations': (body) => ({ status: 201, body: createdSummary(9) }),
    'POST /api/conversations/9/input?wait=1': (body) => ({ body: waitResult('回答正文', 9) }),
  })
  try {
    const env = makeEnv(hub.url, dir)
    const json = await run(
      ['ask', '你好', '--profile', 'dev', '--cwd', '/tmp/x', '--model', 'openai/gpt', '--title', 'T', '--tags', 'a,b', '--json'],
      env,
      ttyStdin(),
    )
    assert.equal(json.code, 0, json.err)
    assert.deepEqual(JSON.parse(json.out), {
      conversationId: 9,
      submissionId: 'sub-1',
      entryId: 'e1',
      answer: '回答正文',
      deleted: false,
    })
    const createHit = hub.hits.find((h) => h.path === '/api/conversations')!
    assert.deepEqual(createHit.body, { title: 'T', profileId: 'dev', cwd: '/tmp/x', model: 'openai/gpt', tags: ['a', 'b'] })
    const waitHit = hub.hits.find((h) => h.path === '/api/conversations/9/input?wait=1')!
    assert.deepEqual(waitHit.body, { text: '你好', whenBusy: 'reject' })

    const human = await run(['ask', '你好'], env, ttyStdin())
    assert.equal(human.code, 0, human.err)
    assert.equal(human.out, '回答正文\n')

    // --help 不触碰 Hub
    const help = await run(['ask', '--help'], env, ttyStdin())
    assert.equal(help.code, 0, help.err)
    assert.ok(help.out.includes('一次性问答'), help.out)
    assert.equal(hub.hits.length, 4)
  } finally {
    await hub.close()
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('ask stdin 管道：与位置参数空行拼接、可独立成 prompt；TTY 不读取', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'POST /api/conversations': () => ({ status: 201, body: createdSummary() }),
    'POST /api/conversations/9/input?wait=1': () => ({ body: waitResult('ok') }),
  })
  try {
    const env = makeEnv(hub.url, dir)
    await run(['ask', '解释以下内容'], env, pipedStdin('文件内容'))
    const combined = hub.hits.find((h) => h.path === '/api/conversations/9/input?wait=1')!
    assert.deepEqual(combined.body, { text: '解释以下内容\n\n文件内容', whenBusy: 'reject' })

    await run(['ask'], env, pipedStdin('仅 stdin'))
    const stdinOnly = hub.hits.filter((h) => h.path === '/api/conversations/9/input?wait=1').at(-1)!
    assert.deepEqual(stdinOnly.body, { text: '仅 stdin', whenBusy: 'reject' })
  } finally {
    await hub.close()
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('ask 空输入与多余位置参数显式拒绝（不触碰 Hub）', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({})
  try {
    const env = makeEnv(hub.url, dir)
    const noText = await run(['ask', '--json'], env, ttyStdin())
    assert.equal(noText.code, 1)
    assert.equal((JSON.parse(noText.err) as { error: { code: string } }).error.code, 'empty_input')

    const emptyPipe = await run(['ask', '--json'], env, pipedStdin(''))
    assert.equal(emptyPipe.code, 1)
    assert.equal((JSON.parse(emptyPipe.err) as { error: { code: string } }).error.code, 'empty_input')

    const blankBoth = await run(['ask', '   ', '--json'], env, pipedStdin(' \n '))
    assert.equal(blankBoth.code, 1)
    assert.equal((JSON.parse(blankBoth.err) as { error: { code: string } }).error.code, 'empty_input')

    const extra = await run(['ask', 'a', 'b', '--json'], env, ttyStdin())
    assert.equal(extra.code, 1)
    assert.equal((JSON.parse(extra.err) as { error: { code: string } }).error.code, 'unexpected_positional')
    assert.equal(hub.hits.length, 0)
  } finally {
    await hub.close()
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('ask 创建失败：原样上抛错误信封（无会话可指）', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'POST /api/conversations': () => ({
      status: 400,
      body: { error: { code: 'validation_error', message: 'cwd 需为绝对路径' } },
    }),
  })
  try {
    const res = await run(['ask', 'hi', '--cwd', 'relative/path', '--json'], makeEnv(hub.url, dir), ttyStdin())
    assert.equal(res.code, 1)
    const envelope = JSON.parse(res.err) as { error: { code: string; message: string } }
    assert.equal(envelope.error.code, 'validation_error')
    assert.equal(envelope.error.message, 'cwd 需为绝对路径')
    assert.equal(res.out, '')
  } finally {
    await hub.close()
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('ask 生成失败：保留会话，错误含可查 ID 与 details.conversationId', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'POST /api/conversations': () => ({ status: 201, body: createdSummary(9) }),
    'POST /api/conversations/9/input?wait=1': () => ({
      status: 502,
      body: { error: { code: 'turn_failed', message: '会话 9 本轮未获回答（provider_error：余额不足）', details: { conversationId: 9, reason: 'provider_error' } } },
    }),
  })
  try {
    const res = await run(['ask', 'hi', '--json'], makeEnv(hub.url, dir), ttyStdin())
    assert.equal(res.code, 1)
    const envelope = JSON.parse(res.err) as { error: { code: string; message: string; details: { conversationId: number; reason: string } } }
    assert.equal(envelope.error.code, 'turn_failed')
    assert.ok(envelope.error.message.includes('provider_error'), envelope.error.message)
    assert.ok(envelope.error.message.includes('#9'), envelope.error.message)
    assert.ok(envelope.error.message.includes('helm conversations get 9'), envelope.error.message)
    assert.equal(envelope.error.details.conversationId, 9)
    assert.equal(envelope.error.details.reason, 'provider_error')
    assert.equal(res.out, '')
  } finally {
    await hub.close()
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('ask --delete-on-success：成功后删除；删除失败保留会话并显式报错', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const okHub = await startHub({
    'POST /api/conversations': () => ({ status: 201, body: createdSummary(9) }),
    'POST /api/conversations/9/input?wait=1': () => ({ body: waitResult('答') }),
    'DELETE /api/conversations/9': () => ({ status: 204 }),
  })
  try {
    const env = makeEnv(okHub.url, dir)
    const res = await run(['ask', 'hi', '--delete-on-success', '--json'], env, ttyStdin())
    assert.equal(res.code, 0, res.err)
    assert.equal(JSON.parse(res.out).deleted, true)
    assert.ok(okHub.hits.some((h) => h.method === 'DELETE' && h.path === '/api/conversations/9'))
  } finally {
    await okHub.close()
  }

  const failHub = await startHub({
    'POST /api/conversations': () => ({ status: 201, body: createdSummary(9) }),
    'POST /api/conversations/9/input?wait=1': () => ({ body: waitResult('答') }),
    'DELETE /api/conversations/9': () => ({
      status: 409,
      body: { error: { code: 'conversation_managed_by_plugin', message: '会话由已启用插件托管，禁止删除' } },
    }),
  })
  try {
    const res = await run(['ask', 'hi', '--delete-on-success', '--json'], makeEnv(failHub.url, dir), ttyStdin())
    assert.equal(res.code, 1)
    const envelope = JSON.parse(res.err) as { error: { code: string; message: string; details: { conversationId: number } } }
    assert.equal(envelope.error.code, 'conversation_managed_by_plugin')
    assert.ok(envelope.error.message.includes('回答已取得'), envelope.error.message)
    assert.ok(envelope.error.message.includes('#9'), envelope.error.message)
    assert.equal(envelope.error.details.conversationId, 9)
    assert.equal(res.out, '')
  } finally {
    await failHub.close()
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('ask --timeout：非法值拒绝；等待超时后会话保留并给出 ID', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'POST /api/conversations': () => ({ status: 201, body: createdSummary(9) }),
    'POST /api/conversations/9/input?wait=1': async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
      return { body: waitResult('迟到的回答') }
    },
  })
  try {
    const env = makeEnv(hub.url, dir)
    const zero = await run(['ask', 'hi', '--timeout', '0', '--json'], env, ttyStdin())
    assert.equal(zero.code, 1)
    assert.equal((JSON.parse(zero.err) as { error: { code: string } }).error.code, 'invalid_flag_value')
    assert.equal(hub.hits.length, 0)

    const negative = await run(['ask', 'hi', '--timeout', '-5', '--json'], env, ttyStdin())
    assert.equal(negative.code, 1)
    assert.equal((JSON.parse(negative.err) as { error: { code: string } }).error.code, 'invalid_flag_value')

    const timed = await run(['ask', 'hi', '--timeout', '80', '--json'], env, ttyStdin())
    assert.equal(timed.code, 1)
    const envelope = JSON.parse(timed.err) as { error: { code: string; message: string; details: { conversationId: number } } }
    assert.equal(envelope.error.code, 'timeout')
    assert.ok(envelope.error.message.includes('#9'), envelope.error.message)
    assert.ok(envelope.error.message.includes('helm conversations get 9'), envelope.error.message)
    assert.equal(envelope.error.details.conversationId, 9)
    assert.equal(timed.out, '')
  } finally {
    await hub.close()
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
