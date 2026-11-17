import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import type { AgentExecutionInfo } from '@helm/protocol'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'

/** Single tool-call faux assistant message (`stopReason: 'toolUse'`). */
function fauxToolCallMessage(name: string, input: Record<string, unknown>): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage([fauxToolCall(name, input as Record<string, never>)], { stopReason: 'toolUse' })
}
import { startHub } from '../../kernel/src/http/index.js'
import { createHerdrTransport } from '../../plugins/src/herdr/transport.js'
import { createNodeDaemon, type NodeDaemon } from '../../node/src/index.js'
import { runCli } from '../../cli/src/index.js'
import type { EnvFabric } from '../../kernel/src/env/index.js'
import type { HerdrNodeChannel } from '../../plugins/src/herdr/contracts.js'
import { createHubTestApp, waitFor } from './helpers/hub-test-env.js'

/**
 * Adapts `EnvFabric` to `HerdrNodeChannel` (the old `createHerdrNodeChannel` export was removed with zero
 * callers; plugins now receive it via `ctx.host.nodeIpc`). This test builds the channel from the same
 * `EnvFabric` IPC ports and verifies production transport reuse of node IPC.
 */
function herdrNodeChannelOf(fabric: EnvFabric): HerdrNodeChannel {
  return {
    isOnline: (id) => fabric.isOnline(id),
    getNodeHubUrl: (id) => fabric.getNodeHubUrl(id),
    envFor: (id, cwd) => fabric.envFor(id, cwd),
    ipcCall: (id, input, signal) => fabric.ipcCall(id, input, signal),
    ipcSubscribe: (id, input, onLine, onClosed, signal) =>
      fabric.ipcSubscribe(id, input, onLine, onClosed, signal),
  }
}

// Real composition root + real WS node; model turns driven deterministically via official faux provider.
async function openEnvironment() {
  const root = await mkdtemp(join(tmpdir(), 'helm-node-app-'))
  const hubDir = join(root, 'hub')
  const nodeDir = join(root, 'node')
  const remoteCwd = join(root, 'remote-workspace')
  await Promise.all([mkdir(hubDir), mkdir(nodeDir), mkdir(remoteCwd)])
  const { app, faux } = await createHubTestApp({ dataDir: hubDir, cwd: hubDir })
  const hub = await startHub({ kernel: app.kernel, port: 0 })
  const auth = app.kernel.auth.createProcessToken()
  let daemon: NodeDaemon | undefined
  const env = { HELM_HUB_URL: hub.url, HELM_TOKEN: auth.token, HELM_DATA_DIR: join(root, 'client') }
  async function cli(args: string[]) {
    let out = ''
    let err = ''
    const code = await runCli(args, { env, stdout: (text) => { out += text }, stderr: (text) => { err += text } })
    return { code, out, err }
  }
  async function request(path: string, body?: unknown, signal?: AbortSignal) {
    return fetch(`${hub.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    })
  }
  try {
    const issued = await cli(['nodes', 'issue', 'integration-node', '--json'])
    assert.equal(issued.code, 0, issued.err)
    const { token } = JSON.parse(issued.out) as { token: string }
    assert.ok(token.startsWith('integration-node:'))
    const connect = async () => {
      daemon = await createNodeDaemon({
        hubUrl: hub.url,
        identity: { nodeId: 'integration-node', token },
        dataDir: nodeDir,
        envServer: { shellEnv: { HELM_NODE_TEST_ORIGIN: 'remote-executor' } },
        reconnectBaseDelayMs: 50,
        log: () => undefined,
      })
      assert.equal(await daemon.waitUntilRegistered(5_000), true)
      return daemon
    }
    await connect()
    return {
      root, hubDir, nodeDir, remoteCwd, faux, app, hub, token, cli, request, connect,
      get daemon() { return daemon! },
      async close() {
        try { await daemon?.close() } finally {
          try { await hub.close() } finally {
            // Swallow teardown error: built-in workflow stop chain has a known stop-window guard issue
            // (`host.listConversations` rejected inside stop window); avoid masking test assertions here.
            try { await app.close().catch(() => {}) } finally { auth.dispose(); await rm(root, { recursive: true, force: true }) }
          }
        }
      },
    }
  } catch (error) {
    await daemon?.close()
    await hub.close()
    await app.close()
    auth.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function eventually(check: () => Promise<boolean> | boolean, description: string): Promise<void> {
  await waitFor(check, { timeoutMs: 5_000, intervalMs: 20, message: description })
}

test('cross-node background native subagent: real WS node allocates worktree, runs gate, CLI cleans up remote worktree', { timeout: 60_000 }, async () => {
  const env = await openEnvironment()
  try {
    const setup = await env.cli(['env', 'exec', '--node', 'integration-node', '--cwd', env.remoteCwd, '--json', '--',
      'git init . && git config user.email test@helm.local && git config user.name HelmTest && printf base > base.txt && git add base.txt && git commit -m base'])
    assert.equal(setup.code, 0, setup.err)
    assert.equal(JSON.parse(setup.out).ok, true, setup.out)
    const parent = await env.app.kernel.createConversation({ nodeId: 'integration-node', cwd: env.remoteCwd })
    // Background subagent via model tool (`subagent background: true`), matching the production path
    // (wired internally by `builtin:workflow`'s `startBackgroundAgent`).
    //
    // Faux responses share a FIFO queue; this flow consumes 4 model steps, and the final three
    // (parent tool-result turn, background subagent turn, and completion callback turn) arrive in
    // non-deterministic order under real concurrency. Provide uniform text responses after `toolCall`
    // so every ordering receives a valid reply without spurious queue-exhaustion failures.
    env.faux.setResponses([
      fauxToolCallMessage('subagent', {
        prompt: 'execute remote verify',
        background: true,
        isolation: 'worktree',
        gate: 'test "$HELM_NODE_TEST_ORIGIN" = remote-executor && printf "$HELM_NODE_TEST_ORIGIN" > remote-proof.txt',
      }),
      ...Array.from({ length: 4 }, () => fauxAssistantMessage('remote task result')),
    ])
    await env.app.kernel.submitInput(parent.id, 'dispatch background isolated subagent')
    await env.app.kernel.waitForIdle(parent.id)
    // Extract `runId` and execution handle from tool output.
    const detail = await env.app.kernel.getConversationDetail(parent.id, { limit: 50 })
    const toolText = JSON.stringify(detail)
    const runIdMatch = /runId\\?":\\?"(wf_[0-9a-f]+)/.exec(toolText)
    assert.ok(runIdMatch, `subagent tool output should contain runId: ${toolText.slice(0, 400)}`)
    const runId = runIdMatch[1]!
    const child = env.app.kernel.listConversations().find((c) => c.parentConversationId === parent.id)
    assert.ok(child, 'background child conversation should be spawned')
    assert.equal(child.nodeId, 'integration-node')
    const inspect = await env.app.kernel.plugins.invokeAction('builtin:workflow', 'inspect', { runId }) as { run: { status: string; error?: string; nodes?: Array<{ id: string; status: string; error?: string }> } }
    for (let i = 0; i < 300 && inspect.run.status === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      inspect.run = ((await env.app.kernel.plugins.invokeAction('builtin:workflow', 'inspect', { runId })) as typeof inspect).run
    }
    // Include full diagnostics (`run.error` + node errors) on failure so concurrency regressions are self-explanatory.
    assert.equal(
      inspect.run.status,
      'completed',
      `background subagent run should complete (actual ${inspect.run.status}): run.error=${JSON.stringify(inspect.run.error)} nodes=${JSON.stringify(inspect.run.nodes?.map((n) => ({ id: n.id, status: n.status, error: n.error })))}`,
    )
    // Child conversation is bound to a managed worktree owned by `builtin:workflow`;
    // extract `worktreeId` from tool output and check it matches child `cwd`.
    const toolEntry = JSON.stringify(
      (await env.app.kernel.getConversationDetail(parent.id, { limit: 50 })).entries
        .filter((e) => e.kind === 'pi.tool-result')
        .map((e) => e.model),
    )
    const wtIdMatch = /worktreeId=\\+"([^"\\\n]+)/.exec(toolEntry)
    assert.ok(wtIdMatch, `tool output should contain managed worktreeId handle: ${toolEntry.slice(0, 400)}`)
    const wtId = wtIdMatch[1]!
    assert.ok(wtId.startsWith('integration-node:'), `managed id should use nodeId:path format for remote nodes: ${wtId}`)
    const wtPath = wtId.slice('integration-node:'.length)
    assert.equal(child.cwd, wtPath, 'child conversation cwd should point to the remote worktree')
    assert.equal(await readFile(join(wtPath, 'remote-proof.txt'), 'utf8'), 'remote-executor', 'gate must run in the node environment, never falling back to Hub')
    // Cleanup via CLI command auto-mapped from `builtin:workflow` action (`helm worktrees cleanup`).
    const preserved = await env.cli(['worktrees', 'cleanup', '--worktree-id', wtId, '--json'])
    assert.notEqual(preserved.code, 0, 'remote uncommitted artifacts should be preserved by default')
    assert.equal(JSON.parse(preserved.err).error.code, 'worktree_dirty')
    const cleanup = await env.cli(['worktrees', 'cleanup', '--worktree-id', wtId, '--force', '--json'])
    assert.equal(cleanup.code, 0, cleanup.err)
    assert.equal(JSON.parse(cleanup.out).nodeId, 'integration-node')
    assert.equal(JSON.parse(cleanup.out).removed, true)
    await assert.rejects(access(wtPath), { code: 'ENOENT' })
  } finally { await env.close() }
})

test('cross-node execution rejects invalid input with explicit 400 at HTTP boundary', { timeout: 60_000 }, async () => {
  const env = await openEnvironment()
  try {
    for (const body of [
      { command: [] }, { command: '   ' },
      { command: 'true', nodeId: '--bad' },
      { command: 'true', timeoutMs: 600_001 },
      { command: 'true', env: { 'BAD-NAME': 'value' } },
    ]) {
      const response = await env.request('/api/env/exec', body)
      assert.equal(response.status, 400)
      assert.equal((await response.json() as { error: { code: string } }).error.code, 'validation_error')
    }
  } finally { await env.close() }
})

test('local managed shell helm wrapper accesses the real Hub', { timeout: 60_000 }, async () => {
  const env = await openEnvironment()
  try {
    const wrapper = await readFile(join(env.hubDir, 'bin', 'helm'), 'utf8')
    assert.match(wrapper, /packages[\\/]cli[\\/]src[\\/]index\.ts/, 'source-mode kernel must point managed wrapper to source CLI even if dist exists')
    const response = await env.request('/api/env/exec', { nodeId: 'local', cwd: env.hubDir, conversationId: 1, command: 'helm status --json' })
    assert.equal(response.status, 200)
    const result = await response.json() as { ok: boolean; output: string }
    assert.equal(result.ok, true, result.output)
    assert.equal(JSON.parse(result.output).authenticated, true)
  } finally { await env.close() }
})

test('node end-to-end with Herdr disabled: CLI, real model tools, and gates execute on conversation-bound node', { timeout: 60_000 }, async () => {
  const env = await openEnvironment()
  try {
    assert.equal(env.app.kernel.plugins.list().find((p) => p.id === 'builtin:herdr')?.enabled, false)
    const listed = await env.cli(['nodes', 'list', '--json'])
    assert.equal(listed.code, 0, listed.err)
    assert.ok(JSON.parse(listed.out).some((n: { id: string; online: boolean }) => n.id === 'integration-node' && n.online))
    const snapshot = env.app.kernel.events.currentSnapshot()
    assert.ok(snapshot.nodes?.some((node) => node.id === 'integration-node' && node.online), 'SSE snapshot should match node management API')
    assert.equal(JSON.stringify(snapshot).includes(env.token), false)
    const nodeFrames: unknown[] = []
    const releaseEvents = env.app.kernel.events.subscribe((frame) => {
      if (frame.event.type === 'node.changed') nodeFrames.push(frame)
    })
    await env.daemon.close()
    await eventually(() => nodeFrames.length > 0, 'node disconnect must emit node.changed')
    await env.connect()
    await eventually(() => nodeFrames.length >= 2, 're-registration must emit node.changed')
    releaseEvents()
    assert.equal(JSON.stringify(nodeFrames).includes(env.token), false)
    const conversation = await env.app.kernel.createConversation({ nodeId: 'integration-node', cwd: env.remoteCwd })
    assert.equal(conversation.nodeId, 'integration-node')
    env.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write', { path: 'proof.txt', content: 'first' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('edit', { path: 'proof.txt', oldText: 'first', newText: 'second' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('read', { path: 'proof.txt' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('bash', {
        command: 'helm status --json',
      })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('node tool turn complete'),
    ])
    await env.app.kernel.submitInput(conversation.id, 'execute file edit and query Hub state')
    await env.app.kernel.waitForIdle(conversation.id)
    assert.equal(await readFile(join(env.remoteCwd, 'proof.txt'), 'utf8'), 'second')
    const detail = await env.app.kernel.getConversationDetail(conversation.id)
    const serialized = JSON.stringify(detail)
    assert.equal(serialized.includes(env.token), false)
    assert.match(serialized, /second/)
    const toolResults = JSON.stringify(detail.entries.filter((entry) => entry.kind === 'pi.tool-result'))
    assert.doesNotMatch(toolResults, /command not found|not recognized|not config Token|hub_unreachable/)
    assert.doesNotMatch(toolResults, /"isError":true/)
    assert.match(toolResults, /authenticated/)
    const gate = await env.app.kernel.runGate('test "$HELM_NODE_TEST_ORIGIN" = remote-executor', {
      conversationId: conversation.id,
      cwd: env.remoteCwd,
    })
    assert.equal(gate.ok, true, gate.output)
    const executed = await env.cli(['env', 'exec', '--node', 'integration-node', '--cwd', env.remoteCwd, '--json', '--',
      process.execPath, '-e', 'process.stdout.write(JSON.stringify({origin:process.env.HELM_NODE_TEST_ORIGIN,dataDir:process.env.HELM_DATA_DIR,hubUrl:process.env.HELM_HUB_URL}))'])
    assert.equal(executed.code, 0, executed.err)
    const remoteEnvironment = JSON.parse(JSON.parse(executed.out).output)
    assert.equal(remoteEnvironment.origin, 'remote-executor')
    assert.equal(remoteEnvironment.dataDir, env.nodeDir)
    assert.equal(remoteEnvironment.hubUrl, env.hub.url)
    await env.app.kernel.profiles.save({ id: 'node-expert', nodeId: 'integration-node', cwd: env.remoteCwd })
    const profileConversation = await env.app.kernel.createConversation({ profileId: 'node-expert' })
    assert.equal(profileConversation.nodeId, 'integration-node')
    assert.equal(profileConversation.cwd, env.remoteCwd, 'both normal conversations and native subagents use Profile node and cwd')
    env.faux.setResponses([fauxAssistantMessage('node expert complete')])
    let childId: number | undefined
    await env.app.kernel.spawnAgent({
      parentConversationId: 1, agentType: 'node-expert', prompt: 'execute node expert task',
      gate: 'test "$HELM_NODE_TEST_ORIGIN" = remote-executor && printf gate >> native-gate',
      onResolved: (info) => { childId = info.conversationId },
    })
    assert.ok(childId)
    assert.equal(env.app.kernel.getConversation(childId).nodeId, 'integration-node')
    assert.equal(await readFile(join(env.remoteCwd, 'native-gate'), 'utf8'), 'gate', 'native subagent gate must execute once on target node')
  } finally { await env.close() }
})

test('real HTTP stream delivers output before command exit and cancelling response stops remote execution', { timeout: 60_000 }, async () => {
  const env = await openEnvironment()
  try {
    const response = await env.request('/api/env/exec', {
      nodeId: 'integration-node', cwd: env.remoteCwd, stream: true,
      command: [process.execPath, '-e', 'process.stdout.write("progress\\n"); setTimeout(() => process.stdout.write("finished"), 5000)'],
    })
    const reader = response.body!.getReader()
    const first = await reader.read()
    const text = new TextDecoder().decode(first.value)
    assert.match(text, /progress/)
    assert.doesNotMatch(text, /finished|"type":"exit"/)
    await reader.cancel()
  } finally { await env.close() }
})

test('node stream output: cross-chunk secret redaction, conversation isolation, and real NDJSON exit status', { timeout: 60_000 }, async () => {
  const env = await openEnvironment()
  try {
    const conversation = await env.app.kernel.createConversation({ nodeId: 'integration-node', cwd: env.remoteCwd })
    const other = await env.app.kernel.createConversation({ nodeId: 'integration-node', cwd: env.remoteCwd })
    const secret = 'node-secret-across-chunks-7b0139'
    env.app.kernel.stash.put(conversation.id, 'NODE_TEST_SECRET', secret)
    const response = await env.request('/api/env/exec', {
      conversationId: conversation.id,
      stream: true,
      command: [process.execPath, '-e',
        'process.stdout.write(process.env.NODE_TEST_SECRET.slice(0, 13)); setTimeout(() => process.stdout.write(process.env.NODE_TEST_SECRET.slice(13)), 100)'],
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /application\/x-ndjson/)
    const frames = (await response.text()).trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(frames.at(-1).type, 'exit')
    assert.equal(frames.at(-1).ok, true)
    const text = frames.filter((frame) => frame.type === 'output').map((frame) => frame.text).join('')
    assert.equal(text.includes(secret), false)
    assert.equal(text.includes(secret.slice(0, 13)), false)
    assert.match(text, /REDACTED/)
    const isolated = await env.request('/api/env/exec', {
      conversationId: other.id,
      command: [process.execPath, '-e', 'process.stdout.write(process.env.NODE_TEST_SECRET ?? "absent")'],
    })
    assert.equal(isolated.status, 200)
    assert.equal((await isolated.json() as { output: string }).output, 'absent')
    const stored = await readFile(join(env.hubDir, 'state.sqlite'))
    assert.equal(stored.includes(Buffer.from(secret)), false)
    assert.equal(stored.includes(Buffer.from(env.token)), false)
  } finally { await env.close() }
})

test('node disconnect and removal: in-flight command fails as unknown, reconnect does not replay, offline never runs locally', { timeout: 60_000 }, async () => {
  const env = await openEnvironment()
  try {
    const countPath = join(env.remoteCwd, 'executions.txt')
    const pending = env.request('/api/env/exec', {
      nodeId: 'integration-node', cwd: env.remoteCwd,
      command: [process.execPath, '-e',
        'require("node:fs").appendFileSync("executions.txt", "once\\n"); setInterval(() => {}, 1000)'],
    })
    await eventually(async () => readFile(countPath, 'utf8').then((text) => text === 'once\n', () => false), 'remote command should actually start')
    await env.daemon.close()
    const result = await pending
    const body = await result.json() as { ok?: boolean; output?: string; error?: { code: string; message: string } }
    assert.equal(body.ok === true, false)
    assert.match(JSON.stringify(body), /unknown/)
    await env.connect()
    assert.equal(await readFile(countPath, 'utf8'), 'once\n', 'reconnect must not replay side-effecting command')
    const removed = await env.cli(['nodes', 'remove', 'integration-node', '--json'])
    assert.equal(removed.code, 0, removed.err)
    await eventually(() => !env.daemon.isConnected(), 'removing node must close its active WS')
    const offline = await env.request('/api/env/exec', {
      nodeId: 'integration-node', cwd: env.hubDir,
      command: [process.execPath, '-e', 'require("node:fs").writeFileSync("must-not-run", "bad")'],
    })
    assert.equal(offline.ok, false)
    assert.match(JSON.stringify(await offline.json()), /node_offline|node_not_found/)
    await assert.rejects(readFile(join(env.hubDir, 'must-not-run')), { code: 'ENOENT' })
  } finally { await env.close() }
})

test('cross-node abort: HTTP abort propagates to node and terminates descendant processes', { timeout: 60_000 }, async () => {
  const env = await openEnvironment()
  try {
    const controller = new AbortController()
    const childProgram = 'setInterval(() => require("node:fs").appendFileSync("child-heartbeat", "x"), 20)'
    const program = `const cp = require('node:child_process'); cp.spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}], { stdio: ['ignore', 'inherit', 'inherit'] }); setInterval(() => {}, 1000)`
    const pending = env.request('/api/env/exec', {
      nodeId: 'integration-node', cwd: env.remoteCwd,
      command: [process.execPath, '-e', program],
    }, controller.signal)
    // Consume rejection upfront so abort does not trigger an unhandled rejection while polling.
    const completed = pending.then(() => 'completed', (error: unknown) => error)
    const heartbeatPath = join(env.remoteCwd, 'child-heartbeat')
    await eventually(async () => readFile(heartbeatPath, 'utf8').then((text) => text.length >= 3, () => false), 'descendant process must actually run before abort')
    controller.abort()
    const outcome = await completed
    assert.ok(outcome instanceof Error && outcome.name === 'AbortError')
    await new Promise((resolve) => setTimeout(resolve, 200))
    const before = await readFile(heartbeatPath, 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(await readFile(heartbeatPath, 'utf8'), before, 'abort must kill process tree, not just reject the Hub promise')
  } finally { await env.close() }
})

test('Herdr transport reuses real node IPC and consumes subscription ACK only once', { timeout: 60_000 }, async () => {
  const env = await openEnvironment()
  const sockets = new Set<Socket>()
  const socketPath = join(env.nodeDir, 'herdr.sock')
  const calls: string[] = []
  const ipc = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let bytes = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk])
      const newline = bytes.indexOf(10)
      if (newline < 0) return
      const request = JSON.parse(bytes.subarray(0, newline).toString('utf8'))
      bytes = bytes.subarray(newline + 1)
      calls.push(request.method)
      if (request.method === 'events.subscribe') {
        socket.write(JSON.stringify({ id: request.id, result: { type: 'subscription_started' } }) + '\n')
        socket.write(JSON.stringify({ event: 'pane_created', data: { pane_id: 'remote-pane' } }) + '\n')
      } else {
        socket.end(JSON.stringify({ id: request.id, result: { source: 'remote-node-ipc' } }) + '\n')
      }
    })
  })
  let release: (() => void) | undefined
  try {
    await new Promise<void>((resolve, reject) => { ipc.once('error', reject); ipc.listen(socketPath, resolve) })
    // EnvFabric and HerdrNodeChannel are structurally compatible (same signatures on ipcCall/ipcSubscribe/envFor/isOnline/getNodeHubUrl).
    const transport = createHerdrTransport({ nodeChannel: env.app.kernel.envFabric })
    assert.deepEqual(await transport.call({ nodeId: 'integration-node', socketPath }, 'session.snapshot', {}), { source: 'remote-node-ipc' })
    const events: unknown[] = []
    const errors: unknown[] = []
    release = await transport.subscribe({ nodeId: 'integration-node', socketPath }, (event) => events.push(event), (error) => errors.push(error))
    await eventually(() => events.length === 1, 'Herdr should receive first real event after node consumes ACK')
    assert.deepEqual(events, [{ type: 'pane.created', paneId: 'remote-pane' }])
    assert.deepEqual(errors, [])
    assert.deepEqual(calls, ['session.snapshot', 'events.subscribe'])
    for (const socket of sockets) socket.end()
    await eventually(() => errors.length === 1, 'actual node IPC disconnect must propagate to Herdr subscriber')
    assert.match(String(errors[0]), /subscription|disconnect|close/)
    release()
    release = undefined
    await eventually(() => sockets.size === 0, 'unsubscribing must close the node IPC socket')
  } finally {
    release?.()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => ipc.close(() => resolve()))
    await env.close()
  }
})
