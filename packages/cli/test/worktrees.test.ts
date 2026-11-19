/**
 * Worktrees cleanup CLI tests (dynamic plugin action command for builtin:worktree).
 *
 * Follows the same contract as cli.test.ts: spins up a temporary HTTP server mock Hub
 * (real fetch boundary + GET /api/actions manifest injection) and invokes real CLI dispatch
 * (runCli). Covers mutually exclusive selector flags (--worktree-id / --conversation-id /
 * --path [--node-id]), --current conversation context injection, --delete-branch / --force
 * passthrough, --json output, generic key-value human output (without domain-specific field
 * formatting), rejection of unknown flags / unexpected positionals, and passthrough of server
 * error messages.
 *
 * Runner: node:test; every test sets an explicit timeout: 60_000.
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

const CLEANUP_OK = { worktreeId: 'local:/wt/a', removed: true, path: '/wt/a', branch: 'helmx/spawn-x', nodeId: 'local', branchDeleted: false }

/** Minimal action manifest for builtin:worktree cleanup_worktree. */
const WT_MANIFESTS = [
  {
    pluginId: 'builtin:worktree',
    id: 'cleanup_worktree',
    description: 'Clean up managed Git worktree',
    inputSchema: {
      type: 'object',
      properties: {
        worktreeId: { type: 'string', description: 'Managed worktree registry ID (mutually exclusive with conversationId/path)' },
        conversationId: { type: 'number', description: 'Child conversation ID (mutually exclusive with worktreeId/path)' },
        path: { type: 'string', description: 'Worktree absolute path (optionally qualified by nodeId)' },
        nodeId: { type: 'string', description: 'Target node ID (only valid with path)' },
        deleteBranch: { type: 'boolean', description: 'Also delete helmx/spawn-* branch (kept by default)' },
        mergedInto: { type: 'string', description: 'Target ref for merge check (defaults to registered baseBranch, falling back to main worktree HEAD)' },
        force: { type: 'boolean', description: 'Force cleanup even with uncommitted changes (rejected by default)' },
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
    cli: { command: ['worktrees', 'cleanup'], description: 'Clean up managed Git worktree' },
  },
]

/** Mock Hub serving GET /api/actions + POST /api/actions/builtin:worktree/cleanup_worktree. */
async function startWorktreesHub(
  t: CleanupRegistrar,
  respond: (body: unknown) => MockRouteResult = () => ({ body: CLEANUP_OK }),
): Promise<MockHubHandle> {
  return startMockHub(
    {
      'POST /api/actions/builtin%3Aworktree/cleanup_worktree': (body) => respond(body),
    },
    { defaultActions: WT_MANIFESTS, autoRegisterCleanup: t },
  )
}

/** Extracts the action input payload from request body ({ input, conversationId? }). */
function inputOf(hit: MockHttpHit | undefined): Record<string, unknown> {
  return ((hit?.body as { input?: Record<string, unknown> } | undefined)?.input) ?? {}
}

function contextOf(hit: MockHttpHit | undefined): Record<string, unknown> {
  const body = hit?.body as { conversationId?: unknown } | undefined
  return body !== undefined && body.conversationId !== undefined ? { conversationId: body.conversationId } : {}
}

test('mutually exclusive selectors: --worktree-id / --conversation-id / --path (--node-id) each produce valid input', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-worktrees-cli-')
  const hub = await startWorktreesHub(t)
  const env = makeCliEnv(hub.url, dir)

  const byId = await runCliCaptured(['worktrees', 'cleanup', '--worktree-id', 'wt-abc', '--json'], env)
  assert.equal(byId.code, 0, byId.err)
  assert.deepEqual(inputOf(hub.hits.at(-1)), { worktreeId: 'wt-abc' })

  const byConv = await runCliCaptured(['worktrees', 'cleanup', '--conversation-id', '7', '--json'], env)
  assert.equal(byConv.code, 0, byConv.err)
  assert.deepEqual(inputOf(hub.hits.at(-1)), { conversationId: 7 })

  const byPath = await runCliCaptured(['worktrees', 'cleanup', '--path', '/srv/.helmx-worktrees/r-1', '--json'], env)
  assert.equal(byPath.code, 0, byPath.err)
  assert.deepEqual(inputOf(hub.hits.at(-1)), { path: '/srv/.helmx-worktrees/r-1' })

  const byPathNode = await runCliCaptured(
    ['worktrees', 'cleanup', '--path', '/srv/.helmx-worktrees/r-1', '--node-id', 'build-box', '--json'],
    env,
  )
  assert.equal(byPathNode.code, 0, byPathNode.err)
  assert.deepEqual(inputOf(hub.hits.at(-1)), { path: '/srv/.helmx-worktrees/r-1', nodeId: 'build-box' })
})

test('--current reads HELMX_CONVERSATION_ID and injects action conversationId context', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-worktrees-cli-')
  const hub = await startWorktreesHub(t)
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '9' })

  const cur = await runCliCaptured(['worktrees', 'cleanup', '--current', '--json'], env)
  assert.equal(cur.code, 0, cur.err)
  assert.deepEqual(contextOf(hub.hits.at(-1)), { conversationId: 9 })
  assert.deepEqual(JSON.parse(cur.out), CLEANUP_OK)

  // Missing env var: --current fails with current_conversation_missing
  const missing = await runCliCaptured(['worktrees', 'cleanup', '--current', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'current_conversation_missing')
})

test('--delete-branch/--force pass through input; --json outputs raw JSON and human mode prints generic key-value pairs', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-worktrees-cli-')
  const hub = await startWorktreesHub(t, () => ({
    body: { worktreeId: 'local:/wt/a', removed: true, path: '/wt/a', branch: 'helmx/spawn-x', nodeId: 'local', branchDeleted: true },
  }))
  const env = makeCliEnv(hub.url, dir)

  const r = await runCliCaptured(
    ['worktrees', 'cleanup', '--conversation-id', '7', '--delete-branch', '--force', '--json'],
    env,
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(inputOf(hub.hits.at(-1)), { conversationId: 7, deleteBranch: true, force: true })
  assert.deepEqual(JSON.parse(r.out), { worktreeId: 'local:/wt/a', removed: true, path: '/wt/a', branch: 'helmx/spawn-x', nodeId: 'local', branchDeleted: true })

  // Human mode: generic key-value formatting (all fields shown without domain customization)
  const human = await runCliCaptured(['worktrees', 'cleanup', '--conversation-id', '7'], env)
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /worktreeId\s+local:\/wt\/a/)
  assert.match(human.out, /removed\s+true/)
  assert.match(human.out, /branchDeleted\s+true/)

  // Idempotent result (removed: false) prints faithfully without rewriting into custom prose
  const idemHub = await startWorktreesHub(t, () => ({
    body: { worktreeId: 'local:/wt/a', removed: false, path: '/wt/a', branch: 'helmx/spawn-x', nodeId: 'local', branchDeleted: false },
  }))
  const idem = await runCliCaptured(['worktrees', 'cleanup', '--worktree-id', 'w1'], makeCliEnv(idemHub.url, dir))
  assert.equal(idem.code, 0, idem.err)
  assert.match(idem.out, /removed\s+false/)
})

test('--merged-into passes mergedInto ref; omits key when unset (server uses baseBranch precedence)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-worktrees-cli-')
  const hub = await startWorktreesHub(t)
  const env = makeCliEnv(hub.url, dir)

  const r = await runCliCaptured(['worktrees', 'cleanup', '--conversation-id', '7', '--merged-into', 'dev', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(inputOf(hub.hits.at(-1)), { conversationId: 7, mergedInto: 'dev' })
  assert.deepEqual(JSON.parse(r.out), CLEANUP_OK)

  // Flag omitted: omit mergedInto key (server resolves mergedInto > baseBranch > main worktree HEAD)
  const bare = await runCliCaptured(['worktrees', 'cleanup', '--conversation-id', '7', '--json'], env)
  assert.equal(bare.code, 0, bare.err)
  assert.deepEqual(inputOf(hub.hits.at(-1)), { conversationId: 7 })
})

test('unknown flags, unexpected positionals, and --input conflicts reject before contacting Hub', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-worktrees-cli-')
  const hub = await startWorktreesHub(t)
  const env = makeCliEnv(hub.url, dir)
  const expectError = async (argv: string[], code: string): Promise<void> => {
    const r = await runCliCaptured(argv, env)
    assert.equal(r.code, 1, `${argv.join(' ')} should fail: ${r.out}${r.err}`)
    assert.equal(parseCliError(r).code, code)
    // Error happens client-side: only GET /api/actions reaches the Hub
    assert.equal(hub.hits.filter((h) => h.path !== '/api/actions').length, 0)
  }
  await expectError(['worktrees', 'cleanup', '--bogus', '--json'], 'unknown_flag')
  await expectError(['worktrees', 'cleanup', 'stray', '--json'], 'unexpected_positional')
  await expectError(['worktrees', 'cleanup', '--input', '{"path":"/p"}', '--force', '--json'], 'conflicting_flags')
  // Invalid numeric flag value (conversationId must be a number)
  await expectError(['worktrees', 'cleanup', '--conversation-id', 'abc', '--json'], 'invalid_flag_value')
})

test('passes through server error messages (dirty worktree 409) and lists dynamic action in help', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-worktrees-cli-')
  const hub = await startWorktreesHub(t, () => ({
    status: 409,
    body: {
      error: {
        code: 'worktree_dirty',
        message: "worktree '/wt/a' (branch: helmx/spawn-x) has uncommitted changes or unmerged commits",
        details: { path: '/wt/a', branch: 'helmx/spawn-x', dirtyFiles: ['src/x.ts'], unmergedCommits: 0 },
      },
    },
  }))
  const env = makeCliEnv(hub.url, dir)

  const r = await runCliCaptured(['worktrees', 'cleanup', '--conversation-id', '7', '--json'], env)
  assert.equal(r.code, 1)
  const err = parseCliError(r)
  assert.equal(err.code, 'worktree_dirty')
  assert.match(err.message, /uncommitted changes/)
  assert.notEqual(err.details, undefined)

  // Human mode prints the error message and exits non-zero (never fabricates success)
  const human = await runCliCaptured(['worktrees', 'cleanup', '--conversation-id', '7'], env)
  assert.equal(human.code, 1)
  assert.match(human.err, /uncommitted changes/)

  // Help lists the dynamic action command and flags
  const help = await runCliCaptured(['--help'], env)
  assert.equal(help.code, 0)
  assert.match(help.out, /worktrees cleanup/)
  assert.match(help.out, /--delete-branch/)
  assert.match(help.out, /--merged-into/)
  assert.match(help.out, /--node-id/)
})
