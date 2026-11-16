/**
 * CLI new command test:artifacts put / send --attach / conversations reset|compact|fork.
 * real HTTP server simulated Hub contract (cli.test.ts same style pattern): verify path, method,
 * request head (x-artifact-filename URL encode,x-artifact-mime-type), two enter system body
 * byte consistent,--json output and error message seal.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  makeCliEnv,
  runCliCaptured,
  startMockHub,
  useTempDir,
} from './helpers/cli-harness.js'

// ---------------------------------------------------------------------------
// artifacts put
// ---------------------------------------------------------------------------

test('artifacts put: two enter system stream upload (octet-stream + encode filename + byte consistent)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const file = path.join(dir, 'data report.md')
  const content = Buffer.from('# title\ncontent row', 'utf8')
  await fsp.writeFile(file, content)
  const hub = await startMockHub(
    {
      'POST /api/conversations/3/artifacts': () => ({
        status: 201,
        body: { id: 'art-1', conversationId: 3, kind: 'upload', name: 'data report.md', size: content.byteLength, mimeType: 'text/markdown', createdAt: 1 },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['artifacts', 'put', file, '3', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  assert.equal(JSON.parse(r.out).id, 'art-1')
  const hit = hub.recorded.hits.at(-1)!
  assert.equal(hit.method, 'POST')
  assert.equal(hit.path, '/api/conversations/3/artifacts')
  assert.equal(hit.headers['content-type'], 'application/octet-stream')
  assert.equal(hit.headers['x-artifact-filename'], encodeURIComponent('data report.md'))
  // two enter system body byte consistent.
  assert.ok(hit.rawBody !== undefined)
  assert.deepEqual([...hit.rawBody!], [...content])
})

test('artifacts put: person class pattern output append [Artifact] id=<id> name=<name> align frontend timeline detect', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const file = path.join(dir, 'output.png')
  await fsp.writeFile(file, 'image-binary')
  const hub = await startMockHub(
    {
      'POST /api/conversations/3/artifacts': () => ({
        status: 201,
        body: { id: 'art-img-99', conversationId: 3, kind: 'upload', name: 'output.png', size: 12, mimeType: 'image/png', createdAt: 1 },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['artifacts', 'put', file, '3'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  assert.ok(r.out.includes('[Artifact] id=art-img-99 name=output.png\n'))
})

test('artifacts put:--name and --mime-type override;--current target conversation', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const file = path.join(dir, 'plain.txt')
  await fsp.writeFile(file, 'abc')
  const hub = await startMockHub(
    {
      'POST /api/conversations/7/artifacts': () => ({
        status: 201,
        body: { id: 'x', conversationId: 7, kind: 'upload', name: 'renamed.bin', path: 'artifacts/7/renamed.bin', mimeType: 'application/x-thing', size: 3, createdAt: 1 },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(
    ['artifacts', 'put', file, '--current', '--name', 'renamed.bin', '--mime-type', 'application/x-thing', '--json'],
    makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '7' }),
  )
  assert.equal(r.code, 0, r.err)
  const hit = hub.recorded.hits.at(-1)!
  assert.equal(hit.path, '/api/conversations/7/artifacts')
  assert.equal(hit.headers['x-artifact-filename'], 'renamed.bin')
  assert.equal(hit.headers['x-artifact-mime-type'], 'application/x-thing')
})

test('artifacts put: file missing read_failed; directory read_failed; redundant location parameter errors', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const missing = await runCliCaptured(['artifacts', 'put', path.join(dir, 'nope.bin'), '1'], env)
  assert.equal(missing.code, 1)
  assert.ok(missing.err.includes('read upload file failed'), `stderr should contains failed to read diagnose:${missing.err}`)
  const dirTarget = await runCliCaptured(['artifacts', 'put', dir, '1'], env)
  assert.equal(dirTarget.code, 1)
  assert.ok(dirTarget.err.includes('is not common rule file'))
  const file = path.join(dir, 'ok.txt')
  await fsp.writeFile(file, 'x')
  const extra = await runCliCaptured(['artifacts', 'put', file, '1', 'junk'], env)
  assert.equal(extra.code, 1)
  assert.ok(extra.err.includes('redundant location parameter'))
})

test('artifacts put:Hub 413 artifact_too_large error message seal rotate CLI non-zero exit', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const file = path.join(dir, 'big.bin')
  await fsp.writeFile(file, Buffer.alloc(1024))
  const hub = await startMockHub(
    {
      'POST /api/conversations/1/artifacts': () => ({
        status: 413,
        body: { error: { code: 'artifact_too_large', message: 'artifact large small exceeds 15 MiB cap' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['artifacts', 'put', file, '1'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 1)
  assert.ok(r.err.includes('artifact large small exceeds 15 MiB cap'), `stderr should contains Hub error message:${r.err}`)
})

// ---------------------------------------------------------------------------
// send --attach
// ---------------------------------------------------------------------------

test('send --attach: comma isolate artifact ID enter body.attachments; null value ignore', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const hub = await startMockHub(
    {
      'POST /api/conversations/5/input': () => ({ status: 202, body: { submissionId: 's-1' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const r = await runCliCaptured(['send', '5', 'inspect', '--attach', 'art-a, art-b ,,art-c', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const hit = hub.recorded.hits.at(-1)!
  assert.deepEqual(hit.body, { text: 'inspect', attachments: ['art-a', 'art-b', 'art-c'] })

  // --attach empty string: produces no attachments field.
  const r2 = await runCliCaptured(['send', '5', 'without attachment', '--attach', ' , ,', '--json'], env)
  assert.equal(r2.code, 0, r2.err)
  const hit2 = hub.recorded.hits.at(-1)!
  assert.deepEqual(hit2.body, { text: 'without attachment' })
})

// ---------------------------------------------------------------------------
// send --replace-from / conversations withdraw
// ---------------------------------------------------------------------------

test('send --replace-from: positive integer enter body.replaceFromEntryId; illegal value errors; default does not carry', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const hub = await startMockHub(
    {
      'POST /api/conversations/5/input': () => ({ status: 202, body: { submissionId: 's-1' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const r = await runCliCaptured(['send', '5', 'override heavy', '--replace-from', '12', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const hit = hub.recorded.hits.at(-1)!
  assert.deepEqual(hit.body, { text: 'override heavy', replaceFromEntryId: 12 })

  // default: does not carry replaceFromEntryId.
  const r2 = await runCliCaptured(['send', '5', 'ordinary commit', '--json'], env)
  assert.equal(r2.code, 0, r2.err)
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, { text: 'ordinary commit' })

  // illegal:0 / negative number / decimal.
  for (const bad of ['0', '-4', '2.5']) {
    const r3 = await runCliCaptured(['send', '5', 'x', '--replace-from', bad], env)
    assert.equal(r3.code, 1, `--replace-from ${bad} should non-zero exit`)
    assert.ok(r3.err.includes('--replace-from must be a positive integer'), `stderr should contains diagnose:${r3.err}`)
  }
})

test('conversations withdraw:--submission-id required enter body;--current; illegal value errors', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const hub = await startMockHub(
    {
      'POST /api/conversations/6/withdraw': () => ({ body: { status: 'withdrawn' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const r = await runCliCaptured(['conversations', 'withdraw', '6', '--submission-id', '33', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.equal(JSON.parse(r.out).status, 'withdrawn')
  const hit = hub.recorded.hits.at(-1)!
  assert.equal(hit.method, 'POST')
  assert.equal(hit.path, '/api/conversations/6/withdraw')
  assert.deepEqual(hit.body, { submissionId: 33 })

  // --current target conversation.
  const r2 = await runCliCaptured(
    ['conversations', 'withdraw', '--current', '--submission-id', '8', '--json'],
    makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '6' }),
  )
  assert.equal(r2.code, 0, r2.err)
  assert.equal(hub.recorded.hits.at(-1)!.path, '/api/conversations/6/withdraw')
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, { submissionId: 8 })

  // missing --submission-id: required validate.
  const r3 = await runCliCaptured(['conversations', 'withdraw', '6'], env)
  assert.equal(r3.code, 1)
  assert.ok(r3.err.includes('missing required option --submission-id'))

  // illegal value:0 / decimal.
  for (const bad of ['0', '1.5', '-2']) {
    const r4 = await runCliCaptured(['conversations', 'withdraw', '6', '--submission-id', bad], env)
    assert.equal(r4.code, 1, `--submission-id ${bad} should non-zero exit`)
    assert.ok(r4.err.includes('--submission-id must be a positive integer'), `stderr should contains diagnose:${r4.err}`)
  }
})

// ---------------------------------------------------------------------------
// conversations reset / compact / fork
// ---------------------------------------------------------------------------

test('conversations reset:handoff enter body;--current; empty body legal', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const hub = await startMockHub(
    {
      'POST /api/conversations/9/reset': () => ({ body: { id: 9, status: 'idle' } }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['conversations', 'reset', '9', '--handoff', 'handover text', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, { handoff: 'handover text' })

  const r2 = await runCliCaptured(
    ['conversations', 'reset', '--current', '--json'],
    makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '9' }),
  )
  assert.equal(r2.code, 0, r2.err)
  assert.equal(hub.recorded.hits.at(-1)!.path, '/api/conversations/9/reset')
  // without handoff:body is empty object.
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, {})
})

test('conversations compact:instructions enter body;--current', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const hub = await startMockHub(
    {
      'POST /api/conversations/12/compact': () => ({ status: 202, body: { taskId: 77, conversation: { id: 12 } } }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(
    ['conversations', 'compact', '12', '--instructions', 'keep decide policy', '--json'],
    makeCliEnv(hub.url, dir),
  )
  assert.equal(r.code, 0, r.err)
  assert.equal(JSON.parse(r.out).taskId, 77)
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, { instructions: 'keep decide policy' })

  const r2 = await runCliCaptured(
    ['conversations', 'compact', '--current', '--json'],
    makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '12' }),
  )
  assert.equal(r2.code, 0, r2.err)
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, {})
})

test('conversations fork:--entry-id required enter body;--title optional;--current', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const hub = await startMockHub(
    {
      'POST /api/conversations/4/fork': () => ({ status: 201, body: { id: 44, title: 't (fork)' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const r = await runCliCaptured(['conversations', 'fork', '4', '--entry-id', '33', '--title', 'new fork', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, { entryId: 33, title: 'new fork' })

  const r2 = await runCliCaptured(
    ['conversations', 'fork', '--current', '--entry-id', '8', '--json'],
    makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '4' }),
  )
  assert.equal(r2.code, 0, r2.err)
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, { entryId: 8 })

  // missing --entry-id: required validate.
  const r3 = await runCliCaptured(['conversations', 'fork', '4'], env)
  assert.equal(r3.code, 1)
  assert.ok(r3.err.includes('missing required option --entry-id'))
})
