import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import type { AgentExecutionInfo } from '@helm/protocol'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'

/** single tool invoke faux message (stopReason: toolUse). */
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
 * EnvFabric → HerdrNodeChannel adapt (old public export createHerdrNodeChannel already
 * follow zero reference plugin remove; plugin now via ctx.host.nodeIpc host port inject. this test direct use
 * EnvFabric the same IPC port construct channel, and produce same link verify transport re- use node IPC).
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

// real combine layer + real WS node; model by SDK official faux provider drive determinism tool turn.
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
            // app.close swallow wrong: inside placement workflow stop chain store in known base seat defect
            //(subject to control stop window inside host.listConversations guard reject), do not mask
            // test assertion; base seat fix after can restore bare await.
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

test('across node background original generate subagent: real WS node allocate worktree, execute gate,CLI clean up original node worktree', { timeout: 60_000 }, async () => {
  const env = await openEnvironment()
  try {
    const setup = await env.cli(['env', 'exec', '--node', 'integration-node', '--cwd', env.remoteCwd, '--json', '--',
      'git init . && git config user.email test@helm.local && git config user.name HelmTest && printf base > base.txt && git add base.txt && git commit -m base'])
    assert.equal(setup.code, 0, setup.err)
    assert.equal(JSON.parse(setup.out).ok, true, setup.out)
    const parent = await env.app.kernel.createConversation({ nodeId: 'integration-node', cwd: env.remoteCwd })
    // background subagent via model tool chain (subagent background:true) - - and real produce path
    // consistent (engine startBackgroundAgent by builtin:workflow plugin internal connect line).
    //
    // faux response is all sharing FIFO queue; this time link shared has 4 model consume point, and except first
    // (parent turn toolCall) outside the rest three (parent tool result turn / background subagent turn /
    // compute gather report trigger parent turn) reach time order in real concurrency under uncertain - - must not assume
    // parent first sub- after. is eliminate time order ambiguity,toolCall after one rule supply to the same good text answer proposal:
    // any consume time order under subagent turn all can obtain to legal answer (run will not because response exhausted false failed,
    // also will not real error catch into complete).
    // old write method first set 4 answer proposal again whole override into [toolCall, parentAnswer](2 ),
    // concurrency under subagent turn may gets empty queue (No more faux responses)→ run real
    // failed; single file luck via only is when order transport air.
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
    // from tool output extract runId and execution(sub-conversation i.e. execute environment).
    const detail = await env.app.kernel.getConversationDetail(parent.id, { limit: 50 })
    const toolText = JSON.stringify(detail)
    const runIdMatch = /runId\\?":\\?"(wf_[0-9a-f]+)/.exec(toolText)
    assert.ok(runIdMatch, `subagent tool output should contains runId:${toolText.slice(0, 400)}`)
    const runId = runIdMatch[1]!
    const child = env.app.kernel.listConversations().find((c) => c.parentConversationId === parent.id)
    assert.ok(child, 'background sub-conversation should already derive')
    assert.equal(child.nodeId, 'integration-node')
    const inspect = await env.app.kernel.plugins.invokeAction('builtin:workflow', 'inspect', { runId }) as { run: { status: string; error?: string; nodes?: Array<{ id: string; status: string; error?: string }> } }
    for (let i = 0; i < 300 && inspect.run.status === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      inspect.run = ((await env.app.kernel.plugins.invokeAction('builtin:workflow', 'inspect', { runId })) as typeof inspect).run
    }
    // on failure carry complete diagnose (run.error + node error): no longer bare status compare,
    // concurrency regression when can direct refer real because.
    assert.equal(
      inspect.run.status,
      'completed',
      `background subagent run should completed(actual ${inspect.run.status}):run.error=${JSON.stringify(inspect.run.error)} nodes=${JSON.stringify(inspect.run.nodes?.map((n) => ({ id: n.id, status: n.status, error: n.error })))}`,
    )
    // sub-conversation bind set managed isolated tree: new contract under WorktreeAllocator belongs to builtin:workflow
    //(KernelRuntime without worktrees port); managed id from tool output worktreeId handle
    // extract, path = execution.effectiveCwd / sub-conversation cwd.
    const toolEntry = JSON.stringify(
      (await env.app.kernel.getConversationDetail(parent.id, { limit: 50 })).entries
        .filter((e) => e.kind === 'pi.tool-result')
        .map((e) => e.model),
    )
    const wtIdMatch = /worktreeId=\\+"([^"\\\n]+)/.exec(toolEntry)
    assert.ok(wtIdMatch, `tool output should contains managed worktreeId handle:${toolEntry.slice(0, 400)}`)
    const wtId = wtIdMatch[1]!
    assert.ok(wtId.startsWith('integration-node:'), `managed id should be nodeId:path form (remote node):${wtId}`)
    const wtPath = wtId.slice('integration-node:'.length)
    assert.equal(child.cwd, wtPath, 'sub-conversation cwd should be remote isolated tree')
    assert.equal(await readFile(join(wtPath, 'remote-proof.txt'), 'utf8'), 'remote-executor', 'gate must read node dedicated belong environment, cannot back Hub execute')
    // clean up via builtin:workflow action mapping motion state CLI command (helm worktrees cleanup).
    const preserved = await env.cli(['worktrees', 'cleanup', '--worktree-id', wtId, '--json'])
    assert.notEqual(preserved.code, 0, 'remote uncommitted artifact by default keep')
    assert.equal(JSON.parse(preserved.err).error.code, 'worktree_dirty')
    const cleanup = await env.cli(['worktrees', 'cleanup', '--worktree-id', wtId, '--force', '--json'])
    assert.equal(cleanup.code, 0, cleanup.err)
    assert.equal(JSON.parse(cleanup.out).nodeId, 'integration-node')
    assert.equal(JSON.parse(cleanup.out).removed, true)
    await assert.rejects(access(wtPath), { code: 'ENOENT' })
  } finally { await env.close() }
})

test('across node execute invalid input in HTTP boundary return explicit 400', { timeout: 60_000 }, async () => {
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

test('local machine managed Shell  helm wrap entry can access real Hub', { timeout: 60_000 }, async () => {
  const env = await openEnvironment()
  try {
    const wrapper = await readFile(join(env.hubDir, 'bin', 'helm'), 'utf8')
    assert.match(wrapper, /packages[\\/]cli[\\/]src[\\/]index\.ts/, 'source code kernel generate managed entry must use source code CLI, even if old dist still store in')
    const response = await env.request('/api/env/exec', { nodeId: 'local', cwd: env.hubDir, conversationId: 1, command: 'helm status --json' })
    assert.equal(response.status, 200)
    const result = await response.json() as { ok: boolean; output: string }
    assert.equal(result.ok, true, result.output)
    assert.equal(JSON.parse(result.output).authenticated, true)
  } finally { await env.close() }
})

test('node throughout through:Herdr deactivate when CLI, real model tool and gate all in conversation bind set node execute', { timeout: 60_000 }, async () => {
  const env = await openEnvironment()
  try {
    assert.equal(env.app.kernel.plugins.list().find((p) => p.id === 'builtin:herdr')?.enabled, false)
    const listed = await env.cli(['nodes', 'list', '--json'])
    assert.equal(listed.code, 0, listed.err)
    assert.ok(JSON.parse(listed.out).some((n: { id: string; online: boolean }) => n.id === 'integration-node' && n.online))
    const snapshot = env.app.kernel.events.currentSnapshot()
    assert.ok(snapshot.nodes?.some((node) => node.id === 'integration-node' && node.online), 'SSE snapshot should and node manage API consistent')
    assert.equal(JSON.stringify(snapshot).includes(env.token), false)
    const nodeFrames: unknown[] = []
    const releaseEvents = env.app.kernel.events.subscribe((frame) => {
      if (frame.event.type === 'node.changed') nodeFrames.push(frame)
    })
    await env.daemon.close()
    await eventually(() => nodeFrames.length > 0, 'node disconnection must publish node.changed')
    await env.connect()
    await eventually(() => nodeFrames.length >= 2, 're- register must publish node.changed')
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
    assert.equal(profileConversation.cwd, env.remoteCwd, 'ordinary conversation and original generate dedicated household all use Profile node and directory')
    env.faux.setResponses([fauxAssistantMessage('node dedicated household complete')])
    let childId: number | undefined
    await env.app.kernel.spawnAgent({
      parentConversationId: 1, agentType: 'node-expert', prompt: 'execute node dedicated household task',
      gate: 'test "$HELM_NODE_TEST_ORIGIN" = remote-executor && printf gate >> native-gate',
      onResolved: (info) => { childId = info.conversationId },
    })
    assert.ok(childId)
    assert.equal(env.app.kernel.getConversation(childId).nodeId, 'integration-node')
    assert.equal(await readFile(join(env.remoteCwd, 'native-gate'), 'utf8'), 'gate', 'original generate subagent gate in target node exactly execute once')
  } finally { await env.close() }
})

test('real HTTP stream in command end before deliver output, cancel response close remote execute', { timeout: 60_000 }, async () => {
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

test('node stream output: across chunk secret redaction, conversation isolated and real NDJSON terminal state', { timeout: 60_000 }, async () => {
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

test('node disconnection and undo: in-flight command result unknown, reconnect do not replay, offline do not execute local machine', { timeout: 60_000 }, async () => {
  const env = await openEnvironment()
  try {
    const countPath = join(env.remoteCwd, 'executions.txt')
    const pending = env.request('/api/env/exec', {
      nodeId: 'integration-node', cwd: env.remoteCwd,
      command: [process.execPath, '-e',
        'require("node:fs").appendFileSync("executions.txt", "once\\n"); setInterval(() => {}, 1000)'],
    })
    await eventually(async () => readFile(countPath, 'utf8').then((text) => text === 'once\n', () => false), 'remote command should real start')
    await env.daemon.close()
    const result = await pending
    const body = await result.json() as { ok?: boolean; output?: string; error?: { code: string; message: string } }
    assert.equal(body.ok === true, false)
    assert.match(JSON.stringify(body), /unknown|unknown/)
    await env.connect()
    assert.equal(await readFile(countPath, 'utf8'), 'once\n', 'new connect cannot replay side effect command')
    const removed = await env.cli(['nodes', 'remove', 'integration-node', '--json'])
    assert.equal(removed.code, 0, removed.err)
    await eventually(() => !env.daemon.isConnected(), 'delete node must close its existing WS')
    const offline = await env.request('/api/env/exec', {
      nodeId: 'integration-node', cwd: env.hubDir,
      command: [process.execPath, '-e', 'require("node:fs").writeFileSync("must-not-run", "bad")'],
    })
    assert.equal(offline.ok, false)
    assert.match(JSON.stringify(await offline.json()), /node_offline|node_not_found/)
    await assert.rejects(readFile(join(env.hubDir, 'must-not-run')), { code: 'ENOENT' })
  } finally { await env.close() }
})

test('across node cancel:HTTP abort pass broadcast to node and stop descendant process write', { timeout: 60_000 }, async () => {
  const env = await openEnvironment()
  try {
    const controller = new AbortController()
    const childProgram = 'setInterval(() => require("node:fs").appendFileSync("child-heartbeat", "x"), 20)'
    const program = `const cp = require('node:child_process'); cp.spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}], { stdio: ['ignore', 'inherit', 'inherit'] }); setInterval(() => {}, 1000)`
    const pending = env.request('/api/env/exec', {
      nodeId: 'integration-node', cwd: env.remoteCwd,
      command: [process.execPath, '-e', program],
    }, controller.signal)
    // first consume rejection, avoid cancel after test read file during appear not handle reject.
    const completed = pending.then(() => 'completed', (error: unknown) => error)
    const heartbeatPath = join(env.remoteCwd, 'child-heartbeat')
    await eventually(async () => readFile(heartbeatPath, 'utf8').then((text) => text.length >= 3, () => false), 'descendant process must actual run after again cancel')
    controller.abort()
    const outcome = await completed
    assert.ok(outcome instanceof Error && outcome.name === 'AbortError')
    await new Promise((resolve) => setTimeout(resolve, 200))
    const before = await readFile(heartbeatPath, 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(await readFile(heartbeatPath, 'utf8'), before, 'cancel must stop process tree, cannot only reject Hub Promise')
  } finally { await env.close() }
})

test('Herdr transfer re- use real node IPC, subscribe ACK only consume once', { timeout: 60_000 }, async () => {
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
    // EnvFabric and HerdrNodeChannel structure same construct (ipcCall/ipcSubscribe/envFor/isOnline/
    // getNodeHubUrl all is signal signature): real node IPC produce path direct connect, without adapt layer.
    const transport = createHerdrTransport({ nodeChannel: env.app.kernel.envFabric })
    assert.deepEqual(await transport.call({ nodeId: 'integration-node', socketPath }, 'session.snapshot', {}), { source: 'remote-node-ipc' })
    const events: unknown[] = []
    const errors: unknown[] = []
    release = await transport.subscribe({ nodeId: 'integration-node', socketPath }, (event) => events.push(event), (error) => errors.push(error))
    await eventually(() => events.length === 1, 'node already consume ACK after,Herdr still should receive first real event')
    assert.deepEqual(events, [{ type: 'pane.created', paneId: 'remote-pane' }])
    assert.deepEqual(errors, [])
    assert.deepEqual(calls, ['session.snapshot', 'events.subscribe'])
    for (const socket of sockets) socket.end()
    await eventually(() => errors.length === 1, 'node IPC actual disconnect must pass reach Herdr subscribe')
    assert.match(String(errors[0]), /subscription|disconnect|close|disconnect/)
    release()
    release = undefined
    await eventually(() => sockets.size === 0, 'cancel subscribe must truly close node IPC socket')
  } finally {
    release?.()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => ipc.close(() => resolve()))
    await env.close()
  }
})
