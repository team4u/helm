/**
 * worktrees cleanup CLI 测试（POST /api/worktrees/cleanup）。
 *
 * 与 cli.test.ts 同纪律：临时 HTTP server 模拟 Hub 契约（真实 fetch 边界），
 * 真实 CLI 命令分派（runCli）。覆盖：选择器互斥（--id/--conversation/--current/
 * --path）、--node 仅搭配 --path、--delete-branch/--force body 透传、--json
 * 输出、人类模式输出、positive int 与空字符串校验、未知 flag/多余位置参数拒绝、
 * 服务端错误信封透传与 --current 感知 HELM_CONVERSATION_ID。
 *
 * runner: tsx --test；每项显式 timeout: 60_000。
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

const CLEANUP_OK = { removed: true, path: '/wt/a', branch: 'helm/spawn-x', nodeId: 'local', branchDeleted: false }

/** 模拟 Hub：仅映射 POST /api/worktrees/cleanup（核心命令不走 /api/actions）。 */
async function startWorktreesHub(
  respond: (body: unknown) => { status?: number; body?: unknown } = () => ({ body: CLEANUP_OK }),
): Promise<{ url: string; hits: Hit[]; close(): Promise<void> }> {
  const hits: Hit[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
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
      hits.push({ method: req.method!, path: req.url!, body })
      if (req.url === '/api/worktrees/cleanup' && req.method === 'POST') {
        const result = respond(body)
        res.writeHead(result.status ?? 200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result.body ?? {}))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'not_found', message: `无路由 ${req.method} ${req.url}` } }))
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

async function run(argv: string[], env: NodeJS.ProcessEnv): Promise<{ out: string; err: string; code: number }> {
  let out = ''
  let err = ''
  const code = await runCli(argv, { env, stdout: (t) => (out += t), stderr: (t) => (err += t) })
  return { out, err, code }
}

function makeEnv(hubUrl: string, dataDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HELM_HUB_URL: hubUrl, HELM_DATA_DIR: dataDir, HELM_TOKEN: 't-test', ...extra }
}

async function tempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'helm-worktrees-cli-'))
}

test('选择器单选：--id / --conversation / --path(--node) 各自生成正确 body', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startWorktreesHub()
  const env = makeEnv(hub.url, dir)
  try {
    const byId = await run(['worktrees', 'cleanup', '--id', 'wt-abc', '--json'], env)
    assert.equal(byId.code, 0, byId.err)
    assert.deepEqual(hub.hits.at(-1)?.body, { worktreeId: 'wt-abc' })

    const byConv = await run(['worktrees', 'cleanup', '--conversation', '7', '--json'], env)
    assert.equal(byConv.code, 0, byConv.err)
    assert.deepEqual(hub.hits.at(-1)?.body, { conversationId: 7 })

    const byPath = await run(['worktrees', 'cleanup', '--path', '/srv/.helm-worktrees/r-1', '--json'], env)
    assert.equal(byPath.code, 0, byPath.err)
    assert.deepEqual(hub.hits.at(-1)?.body, { path: '/srv/.helm-worktrees/r-1' })

    const byPathNode = await run(
      ['worktrees', 'cleanup', '--path', '/srv/.helm-worktrees/r-1', '--node', 'build-box', '--json'],
      env,
    )
    assert.equal(byPathNode.code, 0, byPathNode.err)
    assert.deepEqual(hub.hits.at(-1)?.body, { path: '/srv/.helm-worktrees/r-1', nodeId: 'build-box' })
  } finally {
    await hub.close()
  }
})

test('--current 感知 HELM_CONVERSATION_ID；缺失时显式报错', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startWorktreesHub()
  try {
    const env = makeEnv(hub.url, dir, { HELM_CONVERSATION_ID: '9' })
    const cur = await run(['worktrees', 'cleanup', '--current', '--json'], env)
    assert.equal(cur.code, 0, cur.err)
    assert.deepEqual(hub.hits.at(-1)?.body, { conversationId: 9 })
    assert.deepEqual(JSON.parse(cur.out), CLEANUP_OK)

    // env 未设置：--current 无法解析，显式 current_conversation_missing
    const missing = await run(['worktrees', 'cleanup', '--current', '--json'], makeEnv(hub.url, dir))
    assert.equal(missing.code, 1)
    assert.equal((JSON.parse(missing.err) as { error: { code: string } }).error.code, 'current_conversation_missing')

    // 非法 env 值：positive int 校验
    const badEnv = await run(['worktrees', 'cleanup', '--current', '--json'], makeEnv(hub.url, dir, { HELM_CONVERSATION_ID: 'x' }))
    assert.equal(badEnv.code, 1)
    assert.equal((JSON.parse(badEnv.err) as { error: { code: string } }).error.code, 'invalid_id')
  } finally {
    await hub.close()
  }
})

test('--delete-branch/--force 透传 body；--json 原样输出与人类模式输出', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startWorktreesHub(() => ({
    body: { removed: true, path: '/wt/a', branch: 'helm/spawn-x', nodeId: 'local', branchDeleted: true },
  }))
  const env = makeEnv(hub.url, dir)
  try {
    const r = await run(
      ['worktrees', 'cleanup', '--conversation', '7', '--delete-branch', '--force', '--json'],
      env,
    )
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(hub.hits.at(-1)?.body, { conversationId: 7, deleteBranch: true, force: true })
    assert.deepEqual(JSON.parse(r.out), { removed: true, path: '/wt/a', branch: 'helm/spawn-x', nodeId: 'local', branchDeleted: true })

    const human = await run(['worktrees', 'cleanup', '--conversation', '7'], env)
    assert.equal(human.code, 0, human.err)
    assert.match(human.out, /已移除受管 worktree \/wt\/a/)
    assert.match(human.out, /分支已删除/)

    // 幂等结果的人类输出（removed:false）
    const idemHub = await startWorktreesHub(() => ({
      body: { removed: false, path: '/wt/a', branch: 'helm/spawn-x', nodeId: 'local', branchDeleted: false },
    }))
    try {
      const idem = await run(['worktrees', 'cleanup', '--id', 'w1'], makeEnv(idemHub.url, dir))
      assert.equal(idem.code, 0, idem.err)
      assert.match(idem.out, /此前已清理/)
    } finally {
      await idemHub.close()
    }
  } finally {
    await hub.close()
  }
})

test('互斥与校验：缺选择器/多选择器/--node 无 --path/非正整数/空字符串/未知 flag/位置参数', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startWorktreesHub()
  const env = makeEnv(hub.url, dir)
  const expectError = async (argv: string[], code: string): Promise<void> => {
    const r = await run(argv, env)
    assert.equal(r.code, 1, `${argv.join(' ')} 应失败：${r.out}${r.err}`)
    assert.equal((JSON.parse(r.err) as { error: { code: string } }).error.code, code)
    // 失败发生在请求前：不触达 Hub
    assert.equal(hub.hits.length, 0)
  }
  try {
    await expectError(['worktrees', 'cleanup', '--json'], 'conflicting_flags')
    await expectError(['worktrees', 'cleanup', '--id', 'a', '--conversation', '7', '--json'], 'conflicting_flags')
    await expectError(['worktrees', 'cleanup', '--conversation', '7', '--path', '/p', '--json'], 'conflicting_flags')
    await expectError(['worktrees', 'cleanup', '--id', 'a', '--current', '--json'], 'conflicting_flags')
    await expectError(['worktrees', 'cleanup', '--conversation', '7', '--current', '--json'], 'conflicting_flags')
    await expectError(['worktrees', 'cleanup', '--node', 'n1', '--json'], 'conflicting_flags')
    await expectError(['worktrees', 'cleanup', '--conversation', '0', '--json'], 'invalid_flag_value')
    await expectError(['worktrees', 'cleanup', '--conversation', '-3', '--json'], 'invalid_flag_value') // 负数作为 flag 值被 positive int 拒绝
    await expectError(['worktrees', 'cleanup', '--conversation', 'abc', '--json'], 'invalid_flag_value')
    await expectError(['worktrees', 'cleanup', '--id', '  ', '--json'], 'invalid_flag_value')
    await expectError(['worktrees', 'cleanup', '--path', ' ', '--json'], 'invalid_flag_value')
    await expectError(['worktrees', 'cleanup', '--path', '/p', '--node', ' ', '--json'], 'invalid_flag_value')
    await expectError(['worktrees', 'cleanup', '--id', 'a', '--bogus', '--json'], 'unknown_flag')
    await expectError(['worktrees', 'cleanup', 'stray', '--id', 'a', '--json'], 'unexpected_positional')
  } finally {
    await hub.close()
  }
})

test('服务端错误信封原样透传（脏工作区 409 / 未登记 404）', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startWorktreesHub(() => ({
    status: 409,
    body: {
      error: {
        code: 'worktree_dirty',
        message: "worktree '/wt/a' (branch: helm/spawn-x) 含未提交修改或未合入提交",
        details: { path: '/wt/a', branch: 'helm/spawn-x', dirtyFiles: ['src/x.ts'], unmergedCommits: 0 },
      },
    },
  }))
  const env = makeEnv(hub.url, dir)
  try {
    const r = await run(['worktrees', 'cleanup', '--conversation', '7', '--json'], env)
    assert.equal(r.code, 1)
    const parsed = JSON.parse(r.err) as { error: { code: string; message: string; details?: unknown } }
    assert.equal(parsed.error.code, 'worktree_dirty')
    assert.match(parsed.error.message, /未提交修改/)
    assert.notEqual(parsed.error.details, undefined)

    // 人类模式同样是错误文本 + 非零退出（不伪造成功）
    const human = await run(['worktrees', 'cleanup', '--conversation', '7'], env)
    assert.equal(human.code, 1)
    assert.match(human.err, /未提交修改/)
  } finally {
    await hub.close()
  }
})

test('帮助列出 worktrees cleanup；Hub 响应形状异常显式拒绝', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startWorktreesHub(() => ({ body: { removed: 'yes' } }))
  try {
    const help = await run(['worktrees', 'cleanup', '--help'], makeEnv(hub.url, dir))
    assert.equal(help.code, 0)
    assert.match(help.out, /worktrees cleanup/)
    assert.match(help.out, /--delete-branch/)
    assert.match(help.out, /--node/)

    const bad = await run(['worktrees', 'cleanup', '--id', 'a', '--json'], makeEnv(hub.url, dir))
    assert.equal(bad.code, 1)
    assert.equal((JSON.parse(bad.err) as { error: { code: string } }).error.code, 'invalid_response')
  } finally {
    await hub.close()
  }
})
