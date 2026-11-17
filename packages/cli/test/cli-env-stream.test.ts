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

test('core command help does not access Hub or dynamic plugin manifests', { timeout: 60_000 }, async () => {
  let out = ''
  const code = await runCli(['nodes', 'list', '--help'], {
    env: {}, stdout: (text) => { out += text }, stderr: (text) => assert.fail(text),
    fetch: async () => { assert.fail('static help must not call Hub') },
  })
  assert.equal(code, 0)
  assert.match(out, /nodes list/)
})

test('NDJSON consumes first output chunk immediately without waiting for terminal frame', { timeout: 60_000 }, async () => {
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

test('NDJSON premature stream end never treats unknown result as success', { timeout: 60_000 }, async () => {
  const result = await consume([{ type: 'output', stream: 'stdout', text: 'started' }])
  assert.equal(result.code, 1)
  assert.equal(result.error.code, 'stream_incomplete')
})

test('NDJSON error frame preserves original error code, message, and details', { timeout: 60_000 }, async () => {
  const result = await consume([{ type: 'error', error: { code: 'node_offline', message: 'node disconnected', details: { nodeId: 'build-box' } } }])
  assert.equal(result.code, 1)
  assert.equal(result.error.code, 'node_offline')
  assert.equal(result.error.message, 'node disconnected')
  assert.deepEqual(result.error.details, { nodeId: 'build-box' })
})

test('NDJSON rejects malformed frames, legacy exit frames, and trailing frames after exit', { timeout: 60_000 }, async () => {
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

test('NDJSON handles UTF-8 trailing frame without newline; JSON output preserves exit type and failure exit code', { timeout: 60_000 }, async () => {
  const success = await consume([], { raw: JSON.stringify({ type: 'exit', ok: true, exitCode: 0, timedOut: false }) })
  assert.equal(success.code, 0)
  assert.equal(JSON.parse(success.out).type, 'exit')
  const failure = await consume([{ type: 'exit', ok: false, exitCode: 7, timedOut: false }])
  assert.equal(failure.code, 7)
  assert.equal(failure.error.code, 'env_exec_failed')
})
