import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runCli } from '../src/index.js'

async function consume(frames: unknown[], options: { raw?: string; mime?: string } = {}) {
  let out = ''
  let err = ''
  const response = options.raw ?? frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n'
  const code = await runCli(['env', 'exec', '--stream', '--json', '--', 'build'], {
    env: { HELM_HUB_URL: 'http://127.0.0.1:3202', HELM_TOKEN: 'test-http-client-token' },
    stdout: (text) => { out += text },
    stderr: (text) => { err += text },
    fetch: async () => new Response(response, { headers: { 'content-type': options.mime ?? 'application/x-ndjson' } }),
  })
  return { code, out, error: err ? JSON.parse(err).error : undefined }
}

test('核心命令帮助不访问 Hub 或动态插件清单', { timeout: 60_000 }, async () => {
  let out = ''
  const code = await runCli(['nodes', 'list', '--help'], {
    env: {}, stdout: (text) => { out += text }, stderr: (text) => assert.fail(text),
    fetch: async () => { assert.fail('静态帮助不得请求 Hub') },
  })
  assert.equal(code, 0)
  assert.match(out, /nodes list/)
})

test('NDJSON 首个输出到达时即可消费，终态无需先到达', { timeout: 60_000 }, async () => {
  const encoder = new TextEncoder()
  let streamController: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
      controller.enqueue(encoder.encode(JSON.stringify({ type: 'output', stream: 'stdout', text: 'ready' }) + '\n'))
    },
  })
  let consumed = false
  const code = await runCli(['env', 'exec', '--stream', '--json', '--', 'build'], {
    env: { HELM_HUB_URL: 'http://127.0.0.1:3202', HELM_TOKEN: 'stream-test-token' },
    fetch: async () => new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } }),
    stderr: (text) => assert.fail(text),
    stdout: (text) => {
      if (JSON.parse(text).type !== 'output') return
      consumed = true
      streamController.enqueue(encoder.encode(JSON.stringify({ type: 'exit', ok: true, exitCode: 0, timedOut: false }) + '\n'))
      streamController.close()
    },
  })
  assert.equal(consumed, true)
  assert.equal(code, 0)
})

test('NDJSON 提前结束不得把未知结果当成功', { timeout: 60_000 }, async () => {
  const result = await consume([{ type: 'output', stream: 'stdout', text: 'started' }])
  assert.equal(result.code, 1)
  assert.equal(result.error.code, 'stream_incomplete')
})

test('NDJSON 错误帧保留原始错误码、消息与详情', { timeout: 60_000 }, async () => {
  const result = await consume([{ type: 'error', error: { code: 'node_offline', message: 'node disconnected', details: { nodeId: 'build-box' } } }])
  assert.equal(result.code, 1)
  assert.equal(result.error.code, 'node_offline')
  assert.equal(result.error.message, 'node disconnected')
  assert.deepEqual(result.error.details, { nodeId: 'build-box' })
})

test('NDJSON 拒绝损坏帧、旧终态与终态后继续输出', { timeout: 60_000 }, async () => {
  const cases = [
    [{ type: 'output', text: 'missing stream' }],
    [{ type: 'exit', ok: true, exitCode: '0', timedOut: false }],
    [{ type: 'done', result: { ok: true, exitCode: 0, timedOut: false } }],
    [{ type: 'exit', ok: true, exitCode: 0, timedOut: false }, { type: 'output', stream: 'stdout', text: 'late' }],
  ]
  for (const frames of cases) {
    const result = await consume(frames)
    assert.equal(result.code, 1)
    assert.equal(result.error.code, 'invalid_response')
  }
  const malformed = await consume([], { raw: '{broken}\n' })
  assert.equal(malformed.error.code, 'invalid_response')
  const wrongMime = await consume([], { mime: 'application/json', raw: '{}' })
  assert.equal(wrongMime.error.code, 'invalid_response')
})

test('NDJSON 允许无换行的 UTF-8 尾帧，JSON 输出保留终态类型和失败退出码', { timeout: 60_000 }, async () => {
  const success = await consume([], { raw: JSON.stringify({ type: 'exit', ok: true, exitCode: 0, timedOut: false }) })
  assert.equal(success.code, 0)
  assert.equal(JSON.parse(success.out).type, 'exit')
  const failure = await consume([{ type: 'exit', ok: false, exitCode: 7, timedOut: false }])
  assert.equal(failure.code, 7)
  assert.equal(failure.error.code, 'env_exec_failed')
})
