/**
 * worktrees cleanup CLI 测试（builtin:workflow 插件动作动态命令）。
 *
 * 与 cli.test.ts 同纪律：临时 HTTP server 模拟 Hub 契约（真实 fetch 边界 +
 * GET /api/actions manifest 注入），真实 CLI 命令分派（runCli）。覆盖：
 * 选择器 flag（--worktree-id/--conversation-id/--path[--node-id]）、--current
 * 会话上下文注入、--delete-branch/--force input 透传、--json 输出、人类模式
 * 通用 key-value 输出（零业务字段识别）、未知 flag/多余位置参数拒绝、服务端
 * 错误信封透传。
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

const CLEANUP_OK = { worktreeId: 'local:/wt/a', removed: true, path: '/wt/a', branch: 'helm/spawn-x', nodeId: 'local', branchDeleted: false }

/** builtin:workflow cleanup_worktree 动作 manifest（最小契约形状）。 */
const WT_MANIFESTS = [
  {
    pluginId: 'builtin:workflow',
    id: 'cleanup_worktree',
    description: '清理受管 Git 工作树',
    inputSchema: {
      type: 'object',
      properties: {
        worktreeId: { type: 'string', description: '受管 worktree 登记 ID（与 conversationId/path 互斥）' },
        conversationId: { type: 'number', description: '子会话 ID（与 worktreeId/path 互斥）' },
        path: { type: 'string', description: 'worktree 绝对路径（可附 nodeId 消歧）' },
        nodeId: { type: 'string', description: '目标节点 ID（仅可与 path 搭配）' },
        deleteBranch: { type: 'boolean', description: '同时删除 helm/spawn-* 分支（默认保留）' },
        force: { type: 'boolean', description: '强制清理（脏工作区默认拒绝）' },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        removed: { type: 'boolean' },
        worktreeId: { type: 'string' },
        path: { type: 'string' },
        branch: { type: 'string' },
        nodeId: { type: 'string' },
        branchDeleted: { type: 'boolean' },
      },
      required: ['removed', 'worktreeId', 'path', 'branch', 'nodeId', 'branchDeleted'],
      additionalProperties: false,
    },
    cli: { command: ['worktrees', 'cleanup'], description: '清理受管 Git 工作树' },
  },
]

/** 模拟 Hub：GET /api/actions + POST /api/actions/builtin:workflow/cleanup_worktree。 */
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
      if (req.url === '/api/actions' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(WT_MANIFESTS))
        return
      }
      if (req.url === '/api/actions/builtin%3Aworkflow/cleanup_worktree' && req.method === 'POST') {
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

/** 动作 input 提取（body = { input, conversationId? }）。 */
function inputOf(hit: Hit | undefined): Record<string, unknown> {
  return ((hit?.body as { input?: Record<string, unknown> } | undefined)?.input) ?? {}
}

function contextOf(hit: Hit | undefined): Record<string, unknown> {
  const body = hit?.body as { conversationId?: unknown } | undefined
  return body !== undefined && body.conversationId !== undefined ? { conversationId: body.conversationId } : {}
}

test('选择器单选：--worktree-id / --conversation-id / --path(--node-id) 各自生成正确 input', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startWorktreesHub()
  const env = makeEnv(hub.url, dir)
  try {
    const byId = await run(['worktrees', 'cleanup', '--worktree-id', 'wt-abc', '--json'], env)
    assert.equal(byId.code, 0, byId.err)
    assert.deepEqual(inputOf(hub.hits.at(-1)), { worktreeId: 'wt-abc' })

    const byConv = await run(['worktrees', 'cleanup', '--conversation-id', '7', '--json'], env)
    assert.equal(byConv.code, 0, byConv.err)
    assert.deepEqual(inputOf(hub.hits.at(-1)), { conversationId: 7 })

    const byPath = await run(['worktrees', 'cleanup', '--path', '/srv/.helm-worktrees/r-1', '--json'], env)
    assert.equal(byPath.code, 0, byPath.err)
    assert.deepEqual(inputOf(hub.hits.at(-1)), { path: '/srv/.helm-worktrees/r-1' })

    const byPathNode = await run(
      ['worktrees', 'cleanup', '--path', '/srv/.helm-worktrees/r-1', '--node-id', 'build-box', '--json'],
      env,
    )
    assert.equal(byPathNode.code, 0, byPathNode.err)
    assert.deepEqual(inputOf(hub.hits.at(-1)), { path: '/srv/.helm-worktrees/r-1', nodeId: 'build-box' })
  } finally {
    await hub.close()
  }
})

test('--current 感知 HELM_CONVERSATION_ID（注入动作 conversationId 上下文）', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startWorktreesHub()
  try {
    const env = makeEnv(hub.url, dir, { HELM_CONVERSATION_ID: '9' })
    const cur = await run(['worktrees', 'cleanup', '--current', '--json'], env)
    assert.equal(cur.code, 0, cur.err)
    assert.deepEqual(contextOf(hub.hits.at(-1)), { conversationId: 9 })
    assert.deepEqual(JSON.parse(cur.out), CLEANUP_OK)

    // env 未设置：--current 无法解析，显式 current_conversation_missing
    const missing = await run(['worktrees', 'cleanup', '--current', '--json'], makeEnv(hub.url, dir))
    assert.equal(missing.code, 1)
    assert.equal((JSON.parse(missing.err) as { error: { code: string } }).error.code, 'current_conversation_missing')
  } finally {
    await hub.close()
  }
})

test('--delete-branch/--force 透传 input；--json 原样输出与人类模式通用 key-value 输出', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startWorktreesHub(() => ({
    body: { worktreeId: 'local:/wt/a', removed: true, path: '/wt/a', branch: 'helm/spawn-x', nodeId: 'local', branchDeleted: true },
  }))
  const env = makeEnv(hub.url, dir)
  try {
    const r = await run(
      ['worktrees', 'cleanup', '--conversation-id', '7', '--delete-branch', '--force', '--json'],
      env,
    )
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(inputOf(hub.hits.at(-1)), { conversationId: 7, deleteBranch: true, force: true })
    assert.deepEqual(JSON.parse(r.out), { worktreeId: 'local:/wt/a', removed: true, path: '/wt/a', branch: 'helm/spawn-x', nodeId: 'local', branchDeleted: true })

    // 人类模式：通用 key-value 输出（零业务字段识别，全部字段可见）
    const human = await run(['worktrees', 'cleanup', '--conversation-id', '7'], env)
    assert.equal(human.code, 0, human.err)
    assert.match(human.out, /worktreeId\s+local:\/wt\/a/)
    assert.match(human.out, /removed\s+true/)
    assert.match(human.out, /branchDeleted\s+true/)

    // 幂等结果（removed:false）同样通用输出：值忠实可见，不伪装成另一种文案
    const idemHub = await startWorktreesHub(() => ({
      body: { worktreeId: 'local:/wt/a', removed: false, path: '/wt/a', branch: 'helm/spawn-x', nodeId: 'local', branchDeleted: false },
    }))
    try {
      const idem = await run(['worktrees', 'cleanup', '--worktree-id', 'w1'], makeEnv(idemHub.url, dir))
      assert.equal(idem.code, 0, idem.err)
      assert.match(idem.out, /removed\s+false/)
    } finally {
      await idemHub.close()
    }
  } finally {
    await hub.close()
  }
})

test('未知 flag / 多余位置参数 / --input 互斥拒绝；失败不触达 Hub 动作端点', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startWorktreesHub()
  const env = makeEnv(hub.url, dir)
  const expectError = async (argv: string[], code: string): Promise<void> => {
    const r = await run(argv, env)
    assert.equal(r.code, 1, `${argv.join(' ')} 应失败：${r.out}${r.err}`)
    assert.equal((JSON.parse(r.err) as { error: { code: string } }).error.code, code)
    // 失败发生在请求前：仅 manifest 拉取触达 Hub
    assert.equal(hub.hits.filter((h) => h.path !== '/api/actions').length, 0)
  }
  try {
    await expectError(['worktrees', 'cleanup', '--bogus', '--json'], 'unknown_flag')
    await expectError(['worktrees', 'cleanup', 'stray', '--json'], 'unexpected_positional')
    await expectError(['worktrees', 'cleanup', '--input', '{"path":"/p"}', '--force', '--json'], 'conflicting_flags')
    // 数字类型 flag 值非法（conversationId 需数字）
    await expectError(['worktrees', 'cleanup', '--conversation-id', 'abc', '--json'], 'invalid_flag_value')
  } finally {
    await hub.close()
  }
})

test('服务端错误信封原样透传（脏工作区 409）；帮助列出动态命令', { timeout: 60_000 }, async () => {
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
    const r = await run(['worktrees', 'cleanup', '--conversation-id', '7', '--json'], env)
    assert.equal(r.code, 1)
    const parsed = JSON.parse(r.err) as { error: { code: string; message: string; details?: unknown } }
    assert.equal(parsed.error.code, 'worktree_dirty')
    assert.match(parsed.error.message, /未提交修改/)
    assert.notEqual(parsed.error.details, undefined)

    // 人类模式同样是错误文本 + 非零退出（不伪造成功）
    const human = await run(['worktrees', 'cleanup', '--conversation-id', '7'], env)
    assert.equal(human.code, 1)
    assert.match(human.err, /未提交修改/)

    // 帮助列出动态命令与 flag
    const help = await run(['--help'], env)
    assert.equal(help.code, 0)
    assert.match(help.out, /worktrees cleanup/)
    assert.match(help.out, /--delete-branch/)
    assert.match(help.out, /--node-id/)
  } finally {
    await hub.close()
  }
})
