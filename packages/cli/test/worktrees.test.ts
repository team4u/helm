/**
 * worktrees cleanup CLI test (builtin:workflow plugin action motion state command).
 *
 * and cli.test.ts same discipline: temporary HTTP server simulated Hub contract (real fetch boundary +
 * GET /api/actions manifest inject), real CLI command dispatch (runCli). override:
 * choose flag(--worktree-id/--conversation-id/--path[--node-id]),--current
 * conversation context inject,--delete-branch/--force input pass-through,--json output, person class pattern
 * through use key-value output (zero business field identify), unknown flag/redundant location parameter reject, server side
 * error message seal pass-through.
 *
 * runner: tsx --test; each items explicit timeout: 60_000.
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

/** builtin:workflow cleanup_worktree action manifest(most small contract shape). */
const WT_MANIFESTS = [
  {
    pluginId: 'builtin:workflow',
    id: 'cleanup_worktree',
    description: 'clean up managed Git worktree',
    inputSchema: {
      type: 'object',
      properties: {
        worktreeId: { type: 'string', description: 'managed worktree register ID(and conversationId/path mutual exclusion)' },
        conversationId: { type: 'number', description: 'sub-conversation ID(and worktreeId/path mutual exclusion)' },
        path: { type: 'string', description: 'worktree absolute path (can attach nodeId consume ambiguity)' },
        nodeId: { type: 'string', description: 'target node ID(only can and path pair)' },
        deleteBranch: { type: 'boolean', description: 'also delete helm/spawn-* branch (by default keep)' },
        mergedInto: { type: 'string', description: 'decide not together base allow ref(by default use register baseBranch, again fall back main worktree HEAD)' },
        force: { type: 'boolean', description: 'force clean up (dirty work zone by default reject)' },
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
    cli: { command: ['worktrees', 'cleanup'], description: 'clean up managed Git worktree' },
  },
]

/** simulated Hub:GET /api/actions + POST /api/actions/builtin:workflow/cleanup_worktree. */
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

/** action input extract (body = { input, conversationId? }). */
function inputOf(hit: MockHttpHit | undefined): Record<string, unknown> {
  return ((hit?.body as { input?: Record<string, unknown> } | undefined)?.input) ?? {}
}

function contextOf(hit: MockHttpHit | undefined): Record<string, unknown> {
  const body = hit?.body as { conversationId?: unknown } | undefined
  return body !== undefined && body.conversationId !== undefined ? { conversationId: body.conversationId } : {}
}

test('choose single choose:--worktree-id / --conversation-id / --path(--node-id) each generate correct input', { timeout: 60_000 }, async (t) => {
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

test('--current aware HELM_CONVERSATION_ID(inject action conversationId context)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-worktrees-cli-')
  const hub = await startWorktreesHub(t)
  const env = makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '9' })

  const cur = await runCliCaptured(['worktrees', 'cleanup', '--current', '--json'], env)
  assert.equal(cur.code, 0, cur.err)
  assert.deepEqual(contextOf(hub.hits.at(-1)), { conversationId: 9 })
  assert.deepEqual(JSON.parse(cur.out), CLEANUP_OK)

  // env not settings:--current cannot parse, explicit current_conversation_missing
  const missing = await runCliCaptured(['worktrees', 'cleanup', '--current', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'current_conversation_missing')
})

test('--delete-branch/--force pass-through input;--json original output and person class pattern through use key-value output', { timeout: 60_000 }, async (t) => {
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

  // person class pattern: through use key-value output (zero business field identify, all field visible)
  const human = await runCliCaptured(['worktrees', 'cleanup', '--conversation-id', '7'], env)
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /worktreeId\s+local:\/wt\/a/)
  assert.match(human.out, /removed\s+true/)
  assert.match(human.out, /branchDeleted\s+true/)

  // idempotent result (removed:false) same through use output: value faithful visible, does not pretend to be into another text proposal
  const idemHub = await startWorktreesHub(t, () => ({
    body: { worktreeId: 'local:/wt/a', removed: false, path: '/wt/a', branch: 'helm/spawn-x', nodeId: 'local', branchDeleted: false },
  }))
  const idem = await runCliCaptured(['worktrees', 'cleanup', '--worktree-id', 'w1'], makeCliEnv(idemHub.url, dir))
  assert.equal(idem.code, 0, idem.err)
  assert.match(idem.out, /removed\s+false/)
})

test('--merged-into pass-through mergedInto base allow ref; not pass when do not inject the key (default away server side baseBranch priority)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-worktrees-cli-')
  const hub = await startWorktreesHub(t)
  const env = makeCliEnv(hub.url, dir)

  const r = await runCliCaptured(['worktrees', 'cleanup', '--conversation-id', '7', '--merged-into', 'dev', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(inputOf(hub.hits.at(-1)), { conversationId: 7, mergedInto: 'dev' })
  assert.deepEqual(JSON.parse(r.out), CLEANUP_OK)

  // not pass flag: do not inject mergedInto key (base allow by server side by mergedInto > baseBranch > main warehouse HEAD decide)
  const bare = await runCliCaptured(['worktrees', 'cleanup', '--conversation-id', '7', '--json'], env)
  assert.equal(bare.code, 0, bare.err)
  assert.deepEqual(inputOf(hub.hits.at(-1)), { conversationId: 7 })
})

test('unknown flag / redundant location parameter / --input mutual exclusion reject; failed do not trigger reach Hub action end point', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-worktrees-cli-')
  const hub = await startWorktreesHub(t)
  const env = makeCliEnv(hub.url, dir)
  const expectError = async (argv: string[], code: string): Promise<void> => {
    const r = await runCliCaptured(argv, env)
    assert.equal(r.code, 1, `${argv.join(' ')} should failed:${r.out}${r.err}`)
    assert.equal(parseCliError(r).code, code)
    // failed occur in request before: only manifest pull trigger reach Hub
    assert.equal(hub.hits.filter((h) => h.path !== '/api/actions').length, 0)
  }
  await expectError(['worktrees', 'cleanup', '--bogus', '--json'], 'unknown_flag')
  await expectError(['worktrees', 'cleanup', 'stray', '--json'], 'unexpected_positional')
  await expectError(['worktrees', 'cleanup', '--input', '{"path":"/p"}', '--force', '--json'], 'conflicting_flags')
  // number type flag value illegal (conversationId must number)
  await expectError(['worktrees', 'cleanup', '--conversation-id', 'abc', '--json'], 'invalid_flag_value')
})

test('server side error message seal original pass-through (dirty work zone 409); help column out motion state command', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-worktrees-cli-')
  const hub = await startWorktreesHub(t, () => ({
    status: 409,
    body: {
      error: {
        code: 'worktree_dirty',
        message: "worktree '/wt/a' (branch: helm/spawn-x) contains uncommitted modify or not together commit",
        details: { path: '/wt/a', branch: 'helm/spawn-x', dirtyFiles: ['src/x.ts'], unmergedCommits: 0 },
      },
    },
  }))
  const env = makeCliEnv(hub.url, dir)

  const r = await runCliCaptured(['worktrees', 'cleanup', '--conversation-id', '7', '--json'], env)
  assert.equal(r.code, 1)
  const err = parseCliError(r)
  assert.equal(err.code, 'worktree_dirty')
  assert.match(err.message, /uncommitted modify/)
  assert.notEqual(err.details, undefined)

  // person class pattern same is error text + non-zero exit (do not fabricate succeeded)
  const human = await runCliCaptured(['worktrees', 'cleanup', '--conversation-id', '7'], env)
  assert.equal(human.code, 1)
  assert.match(human.err, /uncommitted modify/)

  // help column out motion state command and flag
  const help = await runCliCaptured(['--help'], env)
  assert.equal(help.code, 0)
  assert.match(help.out, /worktrees cleanup/)
  assert.match(help.out, /--delete-branch/)
  assert.match(help.out, /--merged-into/)
  assert.match(help.out, /--node-id/)
})
