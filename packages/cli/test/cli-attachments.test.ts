/**
 * CLI 新命令测试：artifacts put / send --attach / conversations reset|compact|fork。
 * 真实 HTTP server 模拟 Hub 契约（cli.test.ts 同款模式）：验证路径、方法、
 * 请求头（x-artifact-filename URL 编码、x-artifact-mime-type）、二进制 body
 * 字节一致、--json 输出与错误信封。
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

test('artifacts put：二进制流上传（octet-stream + 编码文件名 + 字节一致）', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const file = path.join(dir, '数据 报告.md')
  const content = Buffer.from('# 标题\n内容行', 'utf8')
  await fsp.writeFile(file, content)
  const hub = await startMockHub(
    {
      'POST /api/conversations/3/artifacts': () => ({
        status: 201,
        body: { id: 'art-1', conversationId: 3, kind: 'upload', name: '数据 报告.md', size: content.byteLength, mimeType: 'text/markdown', createdAt: 1 },
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
  assert.equal(hit.headers['x-artifact-filename'], encodeURIComponent('数据 报告.md'))
  // 二进制 body 字节一致。
  assert.ok(hit.rawBody !== undefined)
  assert.deepEqual([...hit.rawBody!], [...content])
})

test('artifacts put：人类模式输出追加 [Artifact] id=<id> name=<name> 对齐前端时间线检测', { timeout: 60_000 }, async (t) => {
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

test('artifacts put：--name 与 --mime-type 覆盖；--current 目标会话', { timeout: 60_000 }, async (t) => {
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

test('artifacts put：文件缺失 read_failed；目录 read_failed；多余位置参数报错', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const missing = await runCliCaptured(['artifacts', 'put', path.join(dir, 'nope.bin'), '1'], env)
  assert.equal(missing.code, 1)
  assert.ok(missing.err.includes('读取上传文件失败'), `stderr 应含读取失败诊断：${missing.err}`)
  const dirTarget = await runCliCaptured(['artifacts', 'put', dir, '1'], env)
  assert.equal(dirTarget.code, 1)
  assert.ok(dirTarget.err.includes('不是常规文件'))
  const file = path.join(dir, 'ok.txt')
  await fsp.writeFile(file, 'x')
  const extra = await runCliCaptured(['artifacts', 'put', file, '1', 'junk'], env)
  assert.equal(extra.code, 1)
  assert.ok(extra.err.includes('多余位置参数'))
})

test('artifacts put：Hub 413 artifact_too_large 错误信封转 CLI 非零退出', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const file = path.join(dir, 'big.bin')
  await fsp.writeFile(file, Buffer.alloc(1024))
  const hub = await startMockHub(
    {
      'POST /api/conversations/1/artifacts': () => ({
        status: 413,
        body: { error: { code: 'artifact_too_large', message: '产物大小超过 15 MiB 上限' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['artifacts', 'put', file, '1'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 1)
  assert.ok(r.err.includes('产物大小超过 15 MiB 上限'), `stderr 应含 Hub 错误消息：${r.err}`)
})

// ---------------------------------------------------------------------------
// send --attach
// ---------------------------------------------------------------------------

test('send --attach：逗号分隔产物 ID 进入 body.attachments；空值忽略', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const hub = await startMockHub(
    {
      'POST /api/conversations/5/input': () => ({ status: 202, body: { submissionId: 's-1' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const r = await runCliCaptured(['send', '5', '查收', '--attach', 'art-a, art-b ,,art-c', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const hit = hub.recorded.hits.at(-1)!
  assert.deepEqual(hit.body, { text: '查收', attachments: ['art-a', 'art-b', 'art-c'] })

  // --attach 空串：不产生 attachments 字段。
  const r2 = await runCliCaptured(['send', '5', '无附件', '--attach', ' , ,', '--json'], env)
  assert.equal(r2.code, 0, r2.err)
  const hit2 = hub.recorded.hits.at(-1)!
  assert.deepEqual(hit2.body, { text: '无附件' })
})

// ---------------------------------------------------------------------------
// send --replace-from / conversations withdraw
// ---------------------------------------------------------------------------

test('send --replace-from：正整数进 body.replaceFromEntryId；非法值报错；缺省不携带', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const hub = await startMockHub(
    {
      'POST /api/conversations/5/input': () => ({ status: 202, body: { submissionId: 's-1' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const r = await runCliCaptured(['send', '5', '覆盖重发', '--replace-from', '12', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const hit = hub.recorded.hits.at(-1)!
  assert.deepEqual(hit.body, { text: '覆盖重发', replaceFromEntryId: 12 })

  // 缺省：不携带 replaceFromEntryId。
  const r2 = await runCliCaptured(['send', '5', '普通提交', '--json'], env)
  assert.equal(r2.code, 0, r2.err)
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, { text: '普通提交' })

  // 非法：0 / 负数 / 小数。
  for (const bad of ['0', '-4', '2.5']) {
    const r3 = await runCliCaptured(['send', '5', 'x', '--replace-from', bad], env)
    assert.equal(r3.code, 1, `--replace-from ${bad} 应非零退出`)
    assert.ok(r3.err.includes('--replace-from 需为正整数'), `stderr 应含诊断：${r3.err}`)
  }
})

test('conversations withdraw：--submission-id 必填进 body；--current；非法值报错', { timeout: 60_000 }, async (t) => {
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

  // --current 目标会话。
  const r2 = await runCliCaptured(
    ['conversations', 'withdraw', '--current', '--submission-id', '8', '--json'],
    makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '6' }),
  )
  assert.equal(r2.code, 0, r2.err)
  assert.equal(hub.recorded.hits.at(-1)!.path, '/api/conversations/6/withdraw')
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, { submissionId: 8 })

  // 缺 --submission-id：必填校验。
  const r3 = await runCliCaptured(['conversations', 'withdraw', '6'], env)
  assert.equal(r3.code, 1)
  assert.ok(r3.err.includes('缺少必填选项 --submission-id'))

  // 非法值：0 / 小数。
  for (const bad of ['0', '1.5', '-2']) {
    const r4 = await runCliCaptured(['conversations', 'withdraw', '6', '--submission-id', bad], env)
    assert.equal(r4.code, 1, `--submission-id ${bad} 应非零退出`)
    assert.ok(r4.err.includes('--submission-id 需为正整数'), `stderr 应含诊断：${r4.err}`)
  }
})

// ---------------------------------------------------------------------------
// conversations reset / compact / fork
// ---------------------------------------------------------------------------

test('conversations reset：handoff 进 body；--current；空 body 合法', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const hub = await startMockHub(
    {
      'POST /api/conversations/9/reset': () => ({ body: { id: 9, status: 'idle' } }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['conversations', 'reset', '9', '--handoff', '交接文本', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, { handoff: '交接文本' })

  const r2 = await runCliCaptured(
    ['conversations', 'reset', '--current', '--json'],
    makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '9' }),
  )
  assert.equal(r2.code, 0, r2.err)
  assert.equal(hub.recorded.hits.at(-1)!.path, '/api/conversations/9/reset')
  // 无 handoff：body 为空对象。
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, {})
})

test('conversations compact：instructions 进 body；--current', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const hub = await startMockHub(
    {
      'POST /api/conversations/12/compact': () => ({ status: 202, body: { taskId: 77, conversation: { id: 12 } } }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(
    ['conversations', 'compact', '12', '--instructions', '保留决策', '--json'],
    makeCliEnv(hub.url, dir),
  )
  assert.equal(r.code, 0, r.err)
  assert.equal(JSON.parse(r.out).taskId, 77)
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, { instructions: '保留决策' })

  const r2 = await runCliCaptured(
    ['conversations', 'compact', '--current', '--json'],
    makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '12' }),
  )
  assert.equal(r2.code, 0, r2.err)
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, {})
})

test('conversations fork：--entry-id 必填进 body；--title 可选；--current', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-attach-')
  const hub = await startMockHub(
    {
      'POST /api/conversations/4/fork': () => ({ status: 201, body: { id: 44, title: 't (分叉)' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const r = await runCliCaptured(['conversations', 'fork', '4', '--entry-id', '33', '--title', '新分叉', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, { entryId: 33, title: '新分叉' })

  const r2 = await runCliCaptured(
    ['conversations', 'fork', '--current', '--entry-id', '8', '--json'],
    makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '4' }),
  )
  assert.equal(r2.code, 0, r2.err)
  assert.deepEqual(hub.recorded.hits.at(-1)!.body, { entryId: 8 })

  // 缺 --entry-id：必填校验。
  const r3 = await runCliCaptured(['conversations', 'fork', '4'], env)
  assert.equal(r3.code, 1)
  assert.ok(r3.err.includes('缺少必填选项 --entry-id'))
})
