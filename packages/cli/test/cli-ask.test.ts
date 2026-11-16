/**
 * helm ask unit test: temporary HTTP server simulated Hub contract (real fetch boundary).
 * override: basically link (create+wait for+output),stdin pipeline and, empty input reject, failed to create,
 * generate failed keep conversation,--delete-on-success,--timeout validate and wait timed out,
 * wait response strong validate (malformed do not delete conversation, empty text legal).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ConversationInputResult } from '@helm/protocol'
import type { StdinSource } from '../src/options.js'
import {
  makeCliEnv,
  parseCliError,
  runCliCaptured,
  startMockHub,
  useTempDir,
} from './helpers/cli-harness.js'

/** TTY replace body:readAll by invoke i.e. failed (TTY under never read pipeline). */
function ttyStdin(): StdinSource {
  return {
    isTTY: true,
    readAll: () => Promise.reject(new Error('TTY under must not read stdin')),
  }
}

function pipedStdin(text: string): StdinSource {
  return { isTTY: false, readAll: () => Promise.resolve(text) }
}

/** simulated ConversationInputResult:text is protocol right threat answer (kernel stash.redact after return). */
const waitResult = (answer: string, conversationId = 9): ConversationInputResult => ({
  conversationId,
  submissionId: 'sub-1',
  text: answer,
  entry: {
    id: 'e1',
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'text', text: answer }] }],
  },
})

const createdSummary = (id = 9) => ({ id, title: 't', profileId: 'default', tags: [] })

test('ask basically link: create conversation + ?wait=1 wait for;--json structure, person class pattern only out answer text', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-ask-test-')
  const hub = await startMockHub(
    {
      'POST /api/conversations': () => ({ status: 201, body: createdSummary(9) }),
      'POST /api/conversations/9/input?wait=1': () => ({ body: waitResult('answer body text', 9) }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const json = await runCliCaptured(
    ['ask', '你好', '--profile', 'dev', '--cwd', '/tmp/x', '--model', 'openai/gpt', '--title', 'T', '--tags', 'a,b', '--json'],
    env,
    { stdin: ttyStdin() },
  )
  assert.equal(json.code, 0, json.err)
  assert.deepEqual(JSON.parse(json.out), {
    conversationId: 9,
    submissionId: 'sub-1',
    entryId: 'e1',
    answer: 'answer body text',
    deleted: false,
  })
  const createHit = hub.hits.find((h) => h.path === '/api/conversations')!
  assert.deepEqual(createHit.body, { title: 'T', profileId: 'dev', cwd: '/tmp/x', model: 'openai/gpt', tags: ['a', 'b'] })
  const waitHit = hub.hits.find((h) => h.path === '/api/conversations/9/input?wait=1')!
  assert.deepEqual(waitHit.body, { text: '你好', whenBusy: 'reject' })

  const human = await runCliCaptured(['ask', '你好'], env, { stdin: ttyStdin() })
  assert.equal(human.code, 0, human.err)
  assert.equal(human.out, 'answer body text\n')

  // --help do not trigger touch Hub
  const help = await runCliCaptured(['ask', '--help'], env, { stdin: ttyStdin() })
  assert.equal(help.code, 0, help.err)
  assert.ok(help.out.includes('once question answer'), help.out)
  assert.equal(hub.hits.length, 4)
})

test('ask stdin pipeline: and location parameter empty row concatenate, can independent into prompt;TTY do not read', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-ask-test-')
  const hub = await startMockHub(
    {
      'POST /api/conversations': () => ({ status: 201, body: createdSummary() }),
      'POST /api/conversations/9/input?wait=1': () => ({ body: waitResult('ok') }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  await runCliCaptured(['ask', 'explain or fewer content'], env, { stdin: pipedStdin('file content') })
  const combined = hub.hits.find((h) => h.path === '/api/conversations/9/input?wait=1')!
  assert.deepEqual(combined.body, { text: 'explain or fewer content\n\nfile content', whenBusy: 'reject' })

  await runCliCaptured(['ask'], env, { stdin: pipedStdin('only stdin') })
  const stdinOnly = hub.hits.filter((h) => h.path === '/api/conversations/9/input?wait=1').at(-1)!
  assert.deepEqual(stdinOnly.body, { text: 'only stdin', whenBusy: 'reject' })
})

test('ask empty input and redundant location parameter explicit reject (do not trigger touch Hub)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-ask-test-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const noText = await runCliCaptured(['ask', '--json'], env, { stdin: ttyStdin() })
  assert.equal(noText.code, 1)
  assert.equal(parseCliError(noText).code, 'empty_input')

  const emptyPipe = await runCliCaptured(['ask', '--json'], env, { stdin: pipedStdin('') })
  assert.equal(emptyPipe.code, 1)
  assert.equal(parseCliError(emptyPipe).code, 'empty_input')

  const blankBoth = await runCliCaptured(['ask', '   ', '--json'], env, { stdin: pipedStdin(' \n ') })
  assert.equal(blankBoth.code, 1)
  assert.equal(parseCliError(blankBoth).code, 'empty_input')

  const extra = await runCliCaptured(['ask', 'a', 'b', '--json'], env, { stdin: ttyStdin() })
  assert.equal(extra.code, 1)
  assert.equal(parseCliError(extra).code, 'unexpected_positional')
  assert.equal(hub.hits.length, 0)
})

test('ask failed to create: original on throws mistakenly message seal (without conversation can refer)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-ask-test-')
  const hub = await startMockHub(
    {
      'POST /api/conversations': () => ({
        status: 400,
        body: { error: { code: 'validation_error', message: 'cwd must be absolute path' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const res = await runCliCaptured(['ask', 'hi', '--cwd', 'relative/path', '--json'], makeCliEnv(hub.url, dir), { stdin: ttyStdin() })
  assert.equal(res.code, 1)
  const err = parseCliError(res)
  assert.equal(err.code, 'validation_error')
  assert.equal(err.message, 'cwd must be absolute path')
  assert.equal(res.out, '')
})

test('ask generate failed: keep conversation, error contains can inspect ID and details.conversationId', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-ask-test-')
  const hub = await startMockHub(
    {
      'POST /api/conversations': () => ({ status: 201, body: createdSummary(9) }),
      'POST /api/conversations/9/input?wait=1': () => ({
        status: 502,
        body: { error: { code: 'turn_failed', message: 'conversation 9 this round not obtain answer (provider_error: remaining quota do not enough)', details: { conversationId: 9, reason: 'provider_error' } } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const res = await runCliCaptured(['ask', 'hi', '--json'], makeCliEnv(hub.url, dir), { stdin: ttyStdin() })
  assert.equal(res.code, 1)
  const err = parseCliError<{ conversationId: number; reason: string }>(res)
  assert.equal(err.code, 'turn_failed')
  assert.ok(err.message.includes('provider_error'), err.message)
  assert.ok(err.message.includes('#9'), err.message)
  assert.ok(err.message.includes('helm conversations get 9'), err.message)
  assert.equal(err.details?.conversationId, 9)
  assert.equal(err.details?.reason, 'provider_error')
  assert.equal(res.out, '')
})

test('ask --delete-on-success: after success delete; failed to delete keep conversation and explicit errors', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-ask-test-')
  const okHub = await startMockHub(
    {
      'POST /api/conversations': () => ({ status: 201, body: createdSummary(9) }),
      'POST /api/conversations/9/input?wait=1': () => ({ body: waitResult('answer') }),
      'DELETE /api/conversations/9': () => ({ status: 204 }),
    },
    { autoRegisterCleanup: t },
  )
  const res = await runCliCaptured(['ask', 'hi', '--delete-on-success', '--json'], makeCliEnv(okHub.url, dir), { stdin: ttyStdin() })
  assert.equal(res.code, 0, res.err)
  assert.equal(JSON.parse(res.out).deleted, true)
  assert.ok(okHub.hits.some((h) => h.method === 'DELETE' && h.path === '/api/conversations/9'))
  await okHub.close()

  const failHub = await startMockHub(
    {
      'POST /api/conversations': () => ({ status: 201, body: createdSummary(9) }),
      'POST /api/conversations/9/input?wait=1': () => ({ body: waitResult('answer') }),
      'DELETE /api/conversations/9': () => ({
        status: 409,
        body: { error: { code: 'conversation_managed_by_plugin', message: 'conversation by enabled plugin hosting, forbidden delete' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const failRes = await runCliCaptured(['ask', 'hi', '--delete-on-success', '--json'], makeCliEnv(failHub.url, dir), { stdin: ttyStdin() })
  assert.equal(failRes.code, 1)
  const err = parseCliError<{ conversationId: number }>(failRes)
  assert.equal(err.code, 'conversation_managed_by_plugin')
  assert.ok(err.message.includes('answer already acquire'), err.message)
  assert.ok(err.message.includes('#9'), err.message)
  assert.equal(err.details?.conversationId, 9)
  assert.equal(failRes.out, '')
})

test('ask wait response strong validate:malformed/null/conversation do not symbol explicit invalid_response and never delete;text empty string legal', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-ask-test-')
  const badCases: Array<{ name: string; body: unknown }> = [
    { name: 'empty object', body: {} },
    { name: 'null', body: null },
    { name: 'conversationId do not symbol', body: { ...waitResult('answer'), conversationId: 8 } },
    { name: 'submissionId empty string', body: { ...waitResult('answer'), submissionId: '' } },
    { name: 'text non- string', body: { ...waitResult('answer'), text: 42 } },
    { name: 'entry missing', body: { conversationId: 9, submissionId: 'sub-1', text: 'answer' } },
    { name: 'entry.id empty string', body: { ...waitResult('answer'), entry: { id: '', kind: 'pi.assistant' } } },
    { name: 'entry.kind missing', body: { ...waitResult('answer'), entry: { id: 'e1' } } },
  ]
  for (const { name, body } of badCases) {
    const hub = await startMockHub({
      'POST /api/conversations': () => ({ status: 201, body: createdSummary(9) }),
      'POST /api/conversations/9/input?wait=1': () => ({ body }),
      'DELETE /api/conversations/9': () => ({ status: 204 }),
    })
    try {
      const res = await runCliCaptured(['ask', 'hi', '--delete-on-success', '--json'], makeCliEnv(hub.url, dir), { stdin: ttyStdin() })
      assert.equal(res.code, 1, `${name} should failed, got stdout:${res.out}`)
      const err = parseCliError<{ conversationId: number }>(res)
      assert.equal(err.code, 'invalid_response', `${name}:${err.message}`)
      assert.ok(err.message.includes('#9'), `${name}:${err.message}`)
      assert.ok(err.message.includes('helm conversations get 9'), `${name}:${err.message}`)
      assert.equal(err.details?.conversationId, 9, name)
      assert.equal(res.out, '', name)
      // validation failed never delete conversation (contains --delete-on-success)
      assert.ok(!hub.hits.some((h) => h.method === 'DELETE'), `${name}: must not DELETE`)
    } finally {
      await hub.close()
    }
  }

  // text empty string is legal answer: succeeded delete,stdout without fabricate content
  const emptyHub = await startMockHub(
    {
      'POST /api/conversations': () => ({ status: 201, body: createdSummary(9) }),
      'POST /api/conversations/9/input?wait=1': () => ({ body: waitResult('') }),
      'DELETE /api/conversations/9': () => ({ status: 204 }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(emptyHub.url, dir)
  const json = await runCliCaptured(['ask', 'hi', '--delete-on-success', '--json'], env, { stdin: ttyStdin() })
  assert.equal(json.code, 0, json.err)
  assert.deepEqual(JSON.parse(json.out), {
    conversationId: 9,
    submissionId: 'sub-1',
    entryId: 'e1',
    answer: '',
    deleted: true,
  })
  assert.ok(emptyHub.hits.some((h) => h.method === 'DELETE' && h.path === '/api/conversations/9'))

  const human = await runCliCaptured(['ask', 'hi'], env, { stdin: ttyStdin() })
  assert.equal(human.code, 0, human.err)
  assert.equal(human.out, '')
})

test('ask --timeout: illegal value reject; wait timed out after conversation keep and to out ID', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-ask-test-')
  const hub = await startMockHub(
    {
      'POST /api/conversations': () => ({ status: 201, body: createdSummary(9) }),
      'POST /api/conversations/9/input?wait=1': async (_body, _req, res) => {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 400)
          res.on('close', () => {
            clearTimeout(timer)
            resolve()
          })
        })
        return { body: waitResult('late to answer') }
      },
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const zero = await runCliCaptured(['ask', 'hi', '--timeout', '0', '--json'], env, { stdin: ttyStdin() })
  assert.equal(zero.code, 1)
  assert.equal(parseCliError(zero).code, 'invalid_flag_value')
  assert.equal(hub.hits.length, 0)

  const negative = await runCliCaptured(['ask', 'hi', '--timeout', '-5', '--json'], env, { stdin: ttyStdin() })
  assert.equal(negative.code, 1)
  assert.equal(parseCliError(negative).code, 'invalid_flag_value')

  const timed = await runCliCaptured(['ask', 'hi', '--timeout', '80', '--json'], env, { stdin: ttyStdin() })
  assert.equal(timed.code, 1)
  const err = parseCliError<{ conversationId: number }>(timed)
  assert.equal(err.code, 'timeout')
  assert.ok(err.message.includes('#9'), err.message)
  assert.ok(err.message.includes('helm conversations get 9'), err.message)
  assert.equal(err.details?.conversationId, 9)
  assert.equal(timed.out, '')
})
