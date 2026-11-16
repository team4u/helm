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
import {
  makeCliEnv,
  parseCliError,
  runCliCaptured,
  startMockHub,
  useTempDir,
  type CleanupRegistrar,
  type MockHttpHit,
  type MockHubHandle,
  type MockRouteResult,
} from './helpers/cli-harness.js'

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
        mergedInto: { type: 'string', description: '判定未合入的基准 ref（默认用登记 baseBranch，再回退主工作树 HEAD）' },
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
  t: CleanupRegistrar,
  respond: (body: unknown) => MockRouteResult = () => ({ body: CLEANUP_OK }),
): Promise<MockHubHandle> {
  return startMockHub(
    {
      'POST /api/actions/builtin%3Aworkflow/cleanup_worktree': (body) => respond(body),
    },
    { defaultActions: WT_MANIFESTS, autoRegisterCleanup: t },
  )
}

/** 动作 input 提取（body = { input, conversationId? }）。 */
function inputOf(hit: MockHttpHit | undefined): Record<string, unknown> {
  return ((hit?.body as { input?: Record<string, unknown> } | undefined)?.input) ?? {}
}

function contextOf(hit: MockHttpHit | undefined): Record<string, unknown> {
  const body = hit?.body as { conversationId?: unknown } | undefined
  return body !== undefined && body.conversationId !== undefined ? { conversationId: body.conversationId } : {}
}

test('选择器单选：--worktree-id / --conversation-id / --path(--node-id) 各自生成正确 input', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-worktrees-cli-')
  const hub = await startWorktreesHub(t)
  const env = makeCliEnv(hub.url, dir)

  const byId = await runCliCaptured(['worktrees', 'cleanup', '--worktree-id', 'wt-abc', '--json'], env)
  assert.equal(byId.code, 0, byId.err)
  assert.deepEqual(inputOf(hub.hits.at(-1)), { worktreeId: 'wt-abc' })

  const byConv = await runCliCaptured(['worktrees', 'cleanup', '--conversation-id', '7', '--json'], env)
  assert.equal(byConv.code, 0, byConv.err)
  assert.deepEqual(inputOf(hub.hits.at(-1)), { conversationId: 7 })

  const byPath = await runCliCaptured(['worktrees', 'cleanup', '--path', '/srv/.helm-worktrees/r-1', '--json'], env)
  assert.equal(byPath.code, 0, byPath.err)
  assert.deepEqual(inputOf(hub.hits.at(-1)), { path: '/srv/.helm-worktrees/r-1' })

  const byPathNode = await runCliCaptured(
    ['worktrees', 'cleanup', '--path', '/srv/.helm-worktrees/r-1', '--node-id', 'build-box', '--json'],
    env,
  )
  assert.equal(byPathNode.code, 0, byPathNode.err)
  assert.deepEqual(inputOf(hub.hits.at(-1)), { path: '/srv/.helm-worktrees/r-1', nodeId: 'build-box' })
})

test('--current 感知 HELM_CONVERSATION_ID（注入动作 conversationId 上下文）', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-worktrees-cli-')
  const hub = await startWorktreesHub(t)
  const env = makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '9' })

  const cur = await runCliCaptured(['worktrees', 'cleanup', '--current', '--json'], env)
  assert.equal(cur.code, 0, cur.err)
  assert.deepEqual(contextOf(hub.hits.at(-1)), { conversationId: 9 })
  assert.deepEqual(JSON.parse(cur.out), CLEANUP_OK)

  // env 未设置：--current 无法解析，显式 current_conversation_missing
  const missing = await runCliCaptured(['worktrees', 'cleanup', '--current', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'current_conversation_missing')
})

test('--delete-branch/--force 透传 input；--json 原样输出与人类模式通用 key-value 输出', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-worktrees-cli-')
  const hub = await startWorktreesHub(t, () => ({
    body: { worktreeId: 'local:/wt/a', removed: true, path: '/wt/a', branch: 'helm/spawn-x', nodeId: 'local', branchDeleted: true },
  }))
  const env = makeCliEnv(hub.url, dir)

  const r = await runCliCaptured(
    ['worktrees', 'cleanup', '--conversation-id', '7', '--delete-branch', '--force', '--json'],
    env,
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(inputOf(hub.hits.at(-1)), { conversationId: 7, deleteBranch: true, force: true })
  assert.deepEqual(JSON.parse(r.out), { worktreeId: 'local:/wt/a', removed: true, path: '/wt/a', branch: 'helm/spawn-x', nodeId: 'local', branchDeleted: true })

  // 人类模式：通用 key-value 输出（零业务字段识别，全部字段可见）
  const human = await runCliCaptured(['worktrees', 'cleanup', '--conversation-id', '7'], env)
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /worktreeId\s+local:\/wt\/a/)
  assert.match(human.out, /removed\s+true/)
  assert.match(human.out, /branchDeleted\s+true/)

  // 幂等结果（removed:false）同样通用输出：值忠实可见，不伪装成另一种文案
  const idemHub = await startWorktreesHub(t, () => ({
    body: { worktreeId: 'local:/wt/a', removed: false, path: '/wt/a', branch: 'helm/spawn-x', nodeId: 'local', branchDeleted: false },
  }))
  const idem = await runCliCaptured(['worktrees', 'cleanup', '--worktree-id', 'w1'], makeCliEnv(idemHub.url, dir))
  assert.equal(idem.code, 0, idem.err)
  assert.match(idem.out, /removed\s+false/)
})

test('--merged-into 透传 mergedInto 基准 ref；未传时不注入该键（缺省走服务端 baseBranch 优先级）', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-worktrees-cli-')
  const hub = await startWorktreesHub(t)
  const env = makeCliEnv(hub.url, dir)

  const r = await runCliCaptured(['worktrees', 'cleanup', '--conversation-id', '7', '--merged-into', 'dev', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(inputOf(hub.hits.at(-1)), { conversationId: 7, mergedInto: 'dev' })
  assert.deepEqual(JSON.parse(r.out), CLEANUP_OK)

  // 未传 flag：不注入 mergedInto 键（基准由服务端按 mergedInto > baseBranch > 主仓 HEAD 决定）
  const bare = await runCliCaptured(['worktrees', 'cleanup', '--conversation-id', '7', '--json'], env)
  assert.equal(bare.code, 0, bare.err)
  assert.deepEqual(inputOf(hub.hits.at(-1)), { conversationId: 7 })
})

test('未知 flag / 多余位置参数 / --input 互斥拒绝；失败不触达 Hub 动作端点', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-worktrees-cli-')
  const hub = await startWorktreesHub(t)
  const env = makeCliEnv(hub.url, dir)
  const expectError = async (argv: string[], code: string): Promise<void> => {
    const r = await runCliCaptured(argv, env)
    assert.equal(r.code, 1, `${argv.join(' ')} 应失败：${r.out}${r.err}`)
    assert.equal(parseCliError(r).code, code)
    // 失败发生在请求前：仅 manifest 拉取触达 Hub
    assert.equal(hub.hits.filter((h) => h.path !== '/api/actions').length, 0)
  }
  await expectError(['worktrees', 'cleanup', '--bogus', '--json'], 'unknown_flag')
  await expectError(['worktrees', 'cleanup', 'stray', '--json'], 'unexpected_positional')
  await expectError(['worktrees', 'cleanup', '--input', '{"path":"/p"}', '--force', '--json'], 'conflicting_flags')
  // 数字类型 flag 值非法（conversationId 需数字）
  await expectError(['worktrees', 'cleanup', '--conversation-id', 'abc', '--json'], 'invalid_flag_value')
})

test('服务端错误信封原样透传（脏工作区 409）；帮助列出动态命令', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-worktrees-cli-')
  const hub = await startWorktreesHub(t, () => ({
    status: 409,
    body: {
      error: {
        code: 'worktree_dirty',
        message: "worktree '/wt/a' (branch: helm/spawn-x) 含未提交修改或未合入提交",
        details: { path: '/wt/a', branch: 'helm/spawn-x', dirtyFiles: ['src/x.ts'], unmergedCommits: 0 },
      },
    },
  }))
  const env = makeCliEnv(hub.url, dir)

  const r = await runCliCaptured(['worktrees', 'cleanup', '--conversation-id', '7', '--json'], env)
  assert.equal(r.code, 1)
  const err = parseCliError(r)
  assert.equal(err.code, 'worktree_dirty')
  assert.match(err.message, /未提交修改/)
  assert.notEqual(err.details, undefined)

  // 人类模式同样是错误文本 + 非零退出（不伪造成功）
  const human = await runCliCaptured(['worktrees', 'cleanup', '--conversation-id', '7'], env)
  assert.equal(human.code, 1)
  assert.match(human.err, /未提交修改/)

  // 帮助列出动态命令与 flag
  const help = await runCliCaptured(['--help'], env)
  assert.equal(help.code, 0)
  assert.match(help.out, /worktrees cleanup/)
  assert.match(help.out, /--delete-branch/)
  assert.match(help.out, /--merged-into/)
  assert.match(help.out, /--node-id/)
})
