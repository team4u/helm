/**
 * helm ask 单元测试：临时 HTTP server 模拟 Hub 契约（真实 fetch 边界）。
 * 覆盖：基本链路（创建+等待+输出）、stdin 管道并入、空输入拒绝、创建失败、
 * 生成失败保留会话、--delete-on-success、--timeout 校验与等待超时、
 * wait 响应强校验（malformed 不删会话、空 text 合法）。
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

/** 模拟 ConversationInputResult：text 是协议权威回答（kernel stash.redact 后返回）。 */
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

test('ask 基本链路：创建会话 + ?wait=1 等待；--json 结构化、人类模式只出回答文本', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-ask-test-')
  const hub = await startMockHub(
    {
      'POST /api/conversations': () => ({ status: 201, body: createdSummary(9) }),
      'POST /api/conversations/9/input?wait=1': () => ({ body: waitResult('回答正文', 9) }),
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
    answer: '回答正文',
    deleted: false,
  })
  const createHit = hub.hits.find((h) => h.path === '/api/conversations')!
  assert.deepEqual(createHit.body, { title: 'T', profileId: 'dev', cwd: '/tmp/x', model: 'openai/gpt', tags: ['a', 'b'] })
  const waitHit = hub.hits.find((h) => h.path === '/api/conversations/9/input?wait=1')!
  assert.deepEqual(waitHit.body, { text: '你好', whenBusy: 'reject' })

  const human = await runCliCaptured(['ask', '你好'], env, { stdin: ttyStdin() })
  assert.equal(human.code, 0, human.err)
  assert.equal(human.out, '回答正文\n')

  // --help 不触碰 Hub
  const help = await runCliCaptured(['ask', '--help'], env, { stdin: ttyStdin() })
  assert.equal(help.code, 0, help.err)
  assert.ok(help.out.includes('一次性问答'), help.out)
  assert.equal(hub.hits.length, 4)
})

test('ask stdin 管道：与位置参数空行拼接、可独立成 prompt；TTY 不读取', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-ask-test-')
  const hub = await startMockHub(
    {
      'POST /api/conversations': () => ({ status: 201, body: createdSummary() }),
      'POST /api/conversations/9/input?wait=1': () => ({ body: waitResult('ok') }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  await runCliCaptured(['ask', '解释以下内容'], env, { stdin: pipedStdin('文件内容') })
  const combined = hub.hits.find((h) => h.path === '/api/conversations/9/input?wait=1')!
  assert.deepEqual(combined.body, { text: '解释以下内容\n\n文件内容', whenBusy: 'reject' })

  await runCliCaptured(['ask'], env, { stdin: pipedStdin('仅 stdin') })
  const stdinOnly = hub.hits.filter((h) => h.path === '/api/conversations/9/input?wait=1').at(-1)!
  assert.deepEqual(stdinOnly.body, { text: '仅 stdin', whenBusy: 'reject' })
})

test('ask 空输入与多余位置参数显式拒绝（不触碰 Hub）', { timeout: 60_000 }, async (t) => {
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

test('ask 创建失败：原样上抛错误信封（无会话可指）', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-ask-test-')
  const hub = await startMockHub(
    {
      'POST /api/conversations': () => ({
        status: 400,
        body: { error: { code: 'validation_error', message: 'cwd 需为绝对路径' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const res = await runCliCaptured(['ask', 'hi', '--cwd', 'relative/path', '--json'], makeCliEnv(hub.url, dir), { stdin: ttyStdin() })
  assert.equal(res.code, 1)
  const err = parseCliError(res)
  assert.equal(err.code, 'validation_error')
  assert.equal(err.message, 'cwd 需为绝对路径')
  assert.equal(res.out, '')
})

test('ask 生成失败：保留会话，错误含可查 ID 与 details.conversationId', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-ask-test-')
  const hub = await startMockHub(
    {
      'POST /api/conversations': () => ({ status: 201, body: createdSummary(9) }),
      'POST /api/conversations/9/input?wait=1': () => ({
        status: 502,
        body: { error: { code: 'turn_failed', message: '会话 9 本轮未获回答（provider_error：余额不足）', details: { conversationId: 9, reason: 'provider_error' } } },
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

test('ask --delete-on-success：成功后删除；删除失败保留会话并显式报错', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-ask-test-')
  const okHub = await startMockHub(
    {
      'POST /api/conversations': () => ({ status: 201, body: createdSummary(9) }),
      'POST /api/conversations/9/input?wait=1': () => ({ body: waitResult('答') }),
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
      'POST /api/conversations/9/input?wait=1': () => ({ body: waitResult('答') }),
      'DELETE /api/conversations/9': () => ({
        status: 409,
        body: { error: { code: 'conversation_managed_by_plugin', message: '会话由已启用插件托管，禁止删除' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const failRes = await runCliCaptured(['ask', 'hi', '--delete-on-success', '--json'], makeCliEnv(failHub.url, dir), { stdin: ttyStdin() })
  assert.equal(failRes.code, 1)
  const err = parseCliError<{ conversationId: number }>(failRes)
  assert.equal(err.code, 'conversation_managed_by_plugin')
  assert.ok(err.message.includes('回答已取得'), err.message)
  assert.ok(err.message.includes('#9'), err.message)
  assert.equal(err.details?.conversationId, 9)
  assert.equal(failRes.out, '')
})

test('ask wait 响应强校验：malformed/null/会话不符显式 invalid_response 且绝不删除；text 空串合法', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-ask-test-')
  const badCases: Array<{ name: string; body: unknown }> = [
    { name: '空对象', body: {} },
    { name: 'null', body: null },
    { name: 'conversationId 不符', body: { ...waitResult('回答'), conversationId: 8 } },
    { name: 'submissionId 空串', body: { ...waitResult('回答'), submissionId: '' } },
    { name: 'text 非字符串', body: { ...waitResult('回答'), text: 42 } },
    { name: 'entry 缺失', body: { conversationId: 9, submissionId: 'sub-1', text: '回答' } },
    { name: 'entry.id 空串', body: { ...waitResult('回答'), entry: { id: '', kind: 'pi.assistant' } } },
    { name: 'entry.kind 缺失', body: { ...waitResult('回答'), entry: { id: 'e1' } } },
  ]
  for (const { name, body } of badCases) {
    const hub = await startMockHub({
      'POST /api/conversations': () => ({ status: 201, body: createdSummary(9) }),
      'POST /api/conversations/9/input?wait=1': () => ({ body }),
      'DELETE /api/conversations/9': () => ({ status: 204 }),
    })
    try {
      const res = await runCliCaptured(['ask', 'hi', '--delete-on-success', '--json'], makeCliEnv(hub.url, dir), { stdin: ttyStdin() })
      assert.equal(res.code, 1, `${name} 应失败，实得 stdout：${res.out}`)
      const err = parseCliError<{ conversationId: number }>(res)
      assert.equal(err.code, 'invalid_response', `${name}：${err.message}`)
      assert.ok(err.message.includes('#9'), `${name}：${err.message}`)
      assert.ok(err.message.includes('helm conversations get 9'), `${name}：${err.message}`)
      assert.equal(err.details?.conversationId, 9, name)
      assert.equal(res.out, '', name)
      // 校验失败绝不删除会话（含 --delete-on-success）
      assert.ok(!hub.hits.some((h) => h.method === 'DELETE'), `${name}：不应发 DELETE`)
    } finally {
      await hub.close()
    }
  }

  // text 空串是合法回答：成功删除、stdout 无伪造内容
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

test('ask --timeout：非法值拒绝；等待超时后会话保留并给出 ID', { timeout: 60_000 }, async (t) => {
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
        return { body: waitResult('迟到的回答') }
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
