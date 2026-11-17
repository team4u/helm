/**
 * 跨节点真实守护进程（createNodeDaemon + startHub + createHelm）端到端集成测试（共享单套 Hub/Node 环境减少冷启动）。
 */
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import assert from 'node:assert/strict'
import { access, mkdir, readFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { runCli } from '../../cli/src/index.js'
import { createNodeDaemon, type NodeDaemon } from '../../node/src/index.js'
import { createHerdrTransport } from '../../plugins/src/herdr/transport.js'
import {
  cleanupDir,
  makeTempDir,
  openHubHttpEnv,
  waitFor,
  type HubHttpTestEnv,
} from './helpers/hub-test-env.js'

function fauxToolCallMessage(name: string, input: Record<string, unknown>): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage([fauxToolCall(name, input as Record<string, never>)], { stopReason: 'toolUse' })
}

interface EnvAppFixture {
  root: string
  hubDir: string
  nodeDir: string
  remoteCwd: string
  hubEnv: HubHttpTestEnv
  nodeToken: string
  daemon: NodeDaemon
  connect(): Promise<NodeDaemon>
  cli(args: string[]): Promise<{ code: number; out: string; err: string }>
  request(path: string, body?: unknown, signal?: AbortSignal): Promise<Response>
  close(): Promise<void>
}

let env: EnvAppFixture

async function eventually(check: () => Promise<boolean> | boolean, description: string): Promise<void> {
  await waitFor(check, { timeoutMs: 5_000, intervalMs: 20, message: description })
}

before(async () => {
  const root = await makeTempDir('helm-node-app-')
  const hubDir = join(root, 'hub')
  const nodeDir = join(root, 'node')
  const remoteCwd = join(root, 'remote-workspace')
  await Promise.all([mkdir(hubDir, { recursive: true }), mkdir(nodeDir, { recursive: true }), mkdir(remoteCwd, { recursive: true })])

  const hubEnv = await openHubHttpEnv({ dataDir: hubDir, cwd: hubDir, swallowCloseError: true })
  const cliEnv = { HELM_HUB_URL: hubEnv.hubUrl, HELM_TOKEN: hubEnv.token, HELM_DATA_DIR: join(root, 'client') }

  async function cli(args: string[]) {
    let out = ''
    let err = ''
    const code = await runCli(args, { env: cliEnv, stdout: (t) => { out += t }, stderr: (t) => { err += t } })
    return { code, out, err }
  }

  const issued = await cli(['nodes', 'issue', 'integration-node', '--json'])
  assert.equal(issued.code, 0, issued.err)
  const { token: nodeToken } = JSON.parse(issued.out) as { token: string }
  assert.ok(nodeToken.startsWith('integration-node:'))

  let daemon: NodeDaemon | undefined
  const connect = async () => {
    daemon = await createNodeDaemon({
      hubUrl: hubEnv.hubUrl,
      identity: { nodeId: 'integration-node', token: nodeToken },
      dataDir: nodeDir,
      envServer: { shellEnv: { HELM_NODE_TEST_ORIGIN: 'remote-executor' } },
      reconnectBaseDelayMs: 50,
      log: () => undefined,
    })
    assert.equal(await daemon.waitUntilRegistered(5_000), true)
    return daemon
  }
  await connect()

  env = {
    root,
    hubDir,
    nodeDir,
    remoteCwd,
    hubEnv,
    nodeToken,
    get daemon() { return daemon! },
    connect,
    cli,
    request(path, body, signal) {
      return fetch(`${hubEnv.hubUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${hubEnv.token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      })
    },
    async close() {
      try {
        await daemon?.close()
      } finally {
        try {
          await hubEnv.close()
        } finally {
          await cleanupDir(root)
        }
      }
    },
  }
}, { timeout: 60_000 })

after(async () => {
  await env?.close()
}, { timeout: 60_000 })

test('跨节点后台原生 subagent：真实 WS 节点分配 worktree、执行远端 gate、CLI 清理受管 worktree', { timeout: 60_000 }, async () => {
  const repoDir = join(env.remoteCwd, 'wt-repo')
  await mkdir(repoDir, { recursive: true })
  const setup = await env.cli([
    'env', 'exec', '--node', 'integration-node', '--cwd', repoDir, '--json', '--',
    'git init . && git config user.email test@helm.local && git config user.name HelmTest && printf base > base.txt && git add base.txt && git commit -m base',
  ])
  assert.equal(setup.code, 0, setup.err)
  assert.equal(JSON.parse(setup.out).ok, true, setup.out)

  const parent = await env.hubEnv.kernel.createConversation({ nodeId: 'integration-node', cwd: repoDir })
  env.hubEnv.faux.setResponses([
    fauxToolCallMessage('subagent', {
      prompt: 'execute remote verify',
      background: true,
      isolation: 'worktree',
      gate: 'test "$HELM_NODE_TEST_ORIGIN" = remote-executor && printf "$HELM_NODE_TEST_ORIGIN" > remote-proof.txt',
    }),
    ...Array.from({ length: 4 }, () => fauxAssistantMessage('remote task result')),
  ])
  await env.hubEnv.kernel.submitInput(parent.id, 'dispatch background isolated subagent')
  await env.hubEnv.kernel.waitForIdle(parent.id)

  const detail = await env.hubEnv.kernel.getConversationDetail(parent.id, { limit: 50 })
  const runIdMatch = /runId\\?":\\?"(wf_[0-9a-f]+)/.exec(JSON.stringify(detail))
  assert.ok(runIdMatch)
  const runId = runIdMatch[1]!

  const child = env.hubEnv.kernel.listConversations().find((c) => c.parentConversationId === parent.id)
  assert.ok(child)
  assert.equal(child.nodeId, 'integration-node')

  const inspect = await env.hubEnv.kernel.plugins.invokeAction('builtin:workflow', 'inspect', { runId }) as {
    run: { status: string; error?: string; nodes?: Array<{ id: string; status: string; error?: string }> }
  }
  for (let i = 0; i < 300 && inspect.run.status === 'running'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    inspect.run = ((await env.hubEnv.kernel.plugins.invokeAction('builtin:workflow', 'inspect', { runId })) as typeof inspect).run
  }
  assert.equal(inspect.run.status, 'completed')

  const toolMessages = (await env.hubEnv.kernel.getConversationDetail(parent.id, { limit: 50 })).entries
    .filter((e) => e.kind === 'pi.tool-result')
    .flatMap((e) => (Array.isArray(e.model) ? e.model : []) as Array<{
      toolName?: string
      content?: Array<{ text?: string }>
      details?: { execution?: { worktree?: { id?: string } } }
    }>)
  const subagentMsg = toolMessages.find((m) => m.toolName === 'subagent')
  const parsedOutput = JSON.parse(subagentMsg?.content?.[0]?.text ?? '{}') as {
    execution?: { worktree?: { id?: string } }
  }
  const wtId = parsedOutput.execution?.worktree?.id
  assert.ok(wtId && wtId.startsWith('integration-node:'))
  assert.equal(subagentMsg?.details?.execution?.worktree?.id, wtId)
  const wtPath = wtId.slice('integration-node:'.length)
  assert.equal(child.cwd, wtPath)
  assert.equal(await readFile(join(wtPath, 'remote-proof.txt'), 'utf8'), 'remote-executor')

  const preserved = await env.cli(['worktrees', 'cleanup', '--worktree-id', wtId, '--json'])
  assert.notEqual(preserved.code, 0)
  assert.equal(JSON.parse(preserved.err).error.code, 'worktree_dirty')
  const cleanup = await env.cli(['worktrees', 'cleanup', '--worktree-id', wtId, '--force', '--json'])
  assert.equal(cleanup.code, 0, cleanup.err)
  assert.equal(JSON.parse(cleanup.out).nodeId, 'integration-node')
  assert.equal(JSON.parse(cleanup.out).removed, true)
  await assert.rejects(access(wtPath), { code: 'ENOENT' })
})

test('HTTP /api/env/exec 参数边界校验与本机受管 Shell helm 包装器入口', { timeout: 60_000 }, async () => {
  for (const body of [
    { command: [] },
    { command: '   ' },
    { command: 'true', nodeId: '--bad' },
    { command: 'true', timeoutMs: 600_001 },
    { command: 'true', env: { 'BAD-NAME': 'value' } },
  ]) {
    const response = await env.request('/api/env/exec', body)
    assert.equal(response.status, 400)
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'validation_error')
  }

  const wrapper = await readFile(join(env.hubDir, 'bin', 'helm'), 'utf8')
  assert.match(wrapper, /packages[\\/]cli[\\/]src[\\/]index\.ts/)
  const response = await env.request('/api/env/exec', {
    nodeId: 'local',
    cwd: env.hubDir,
    conversationId: 1,
    command: 'helm status --json',
  })
  assert.equal(response.status, 200)
  const result = await response.json() as { ok: boolean; output: string }
  assert.equal(result.ok, true, result.output)
  assert.equal(JSON.parse(result.output).authenticated, true)
})

test('节点全链路贯通：Herdr 停用时 CLI、真实模型工具、Gate 与 Profile 子代理均在绑定节点执行', { timeout: 60_000 }, async () => {
  const wsDir = join(env.remoteCwd, 'tools-ws')
  await mkdir(wsDir, { recursive: true })
  const kernel = env.hubEnv.kernel

  assert.equal(kernel.plugins.list().find((p) => p.id === 'builtin:herdr')?.enabled, false)
  const listed = await env.cli(['nodes', 'list', '--json'])
  assert.equal(listed.code, 0, listed.err)
  assert.ok(JSON.parse(listed.out).some((n: { id: string; online: boolean }) => n.id === 'integration-node' && n.online))

  const snapshot = kernel.events.currentSnapshot()
  assert.ok(snapshot.nodes?.some((node) => node.id === 'integration-node' && node.online))
  assert.equal(JSON.stringify(snapshot).includes(env.nodeToken), false)

  const nodeFrames: unknown[] = []
  const releaseEvents = kernel.events.subscribe((frame) => {
    if (frame.event.type === 'node.changed') nodeFrames.push(frame)
  })
  await env.daemon.close()
  await eventually(() => nodeFrames.length > 0, 'node disconnection must publish node.changed')
  await env.connect()
  await eventually(() => nodeFrames.length >= 2, 're-register must publish node.changed')
  releaseEvents()
  assert.equal(JSON.stringify(nodeFrames).includes(env.nodeToken), false)

  const conversation = await kernel.createConversation({ nodeId: 'integration-node', cwd: wsDir })
  env.hubEnv.faux.setResponses([
    fauxAssistantMessage([fauxToolCall('write', { path: 'proof.txt', content: 'first' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('edit', { path: 'proof.txt', oldText: 'first', newText: 'second' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('read', { path: 'proof.txt' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('bash', { command: 'helm status --json' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('node tool turn complete'),
  ])
  await kernel.submitInput(conversation.id, 'execute file edit and query Hub state')
  await kernel.waitForIdle(conversation.id)
  assert.equal(await readFile(join(wsDir, 'proof.txt'), 'utf8'), 'second')

  const detail = await kernel.getConversationDetail(conversation.id)
  assert.equal(JSON.stringify(detail).includes(env.nodeToken), false)
  const toolResults = JSON.stringify(detail.entries.filter((entry) => entry.kind === 'pi.tool-result'))
  assert.doesNotMatch(toolResults, /"isError":true/)
  assert.match(toolResults, /authenticated/)

  const gate = await kernel.runGate('test "$HELM_NODE_TEST_ORIGIN" = remote-executor', {
    conversationId: conversation.id,
    cwd: wsDir,
  })
  assert.equal(gate.ok, true, gate.output)

  const executed = await env.cli([
    'env', 'exec', '--node', 'integration-node', '--cwd', wsDir, '--json', '--',
    process.execPath, '-e', 'process.stdout.write(JSON.stringify({origin:process.env.HELM_NODE_TEST_ORIGIN,dataDir:process.env.HELM_DATA_DIR,hubUrl:process.env.HELM_HUB_URL}))',
  ])
  assert.equal(executed.code, 0, executed.err)
  const remoteEnvironment = JSON.parse(JSON.parse(executed.out).output)
  assert.equal(remoteEnvironment.origin, 'remote-executor')
  assert.equal(remoteEnvironment.dataDir, env.nodeDir)
  assert.equal(remoteEnvironment.hubUrl, env.hubEnv.hubUrl)

  await kernel.profiles.save({ id: 'node-expert', nodeId: 'integration-node', cwd: wsDir })
  const profileConversation = await kernel.createConversation({ profileId: 'node-expert' })
  assert.equal(profileConversation.nodeId, 'integration-node')
  assert.equal(profileConversation.cwd, wsDir)

  env.hubEnv.faux.setResponses([fauxAssistantMessage('node dedicated household complete')])
  let childId: number | undefined
  await kernel.spawnAgent({
    parentConversationId: 1,
    agentType: 'node-expert',
    prompt: 'execute node dedicated household task',
    gate: 'test "$HELM_NODE_TEST_ORIGIN" = remote-executor && printf gate >> native-gate',
    onResolved: (info) => { childId = info.conversationId },
  })
  assert.ok(childId)
  assert.equal(kernel.getConversation(childId).nodeId, 'integration-node')
  assert.equal(await readFile(join(wsDir, 'native-gate'), 'utf8'), 'gate')
})

test('流式执行与跨节点取消：实时输出、跨 chunk 机密脱敏、会话隔离及 HTTP abort 终止远端子进程树', { timeout: 60_000 }, async () => {
  const streamDir = join(env.remoteCwd, 'stream-ws')
  await mkdir(streamDir, { recursive: true })
  const kernel = env.hubEnv.kernel

  // 1. 命令结束前实时送达输出，取消 reader 关闭远端执行
  const liveRes = await env.request('/api/env/exec', {
    nodeId: 'integration-node',
    cwd: streamDir,
    stream: true,
    command: [process.execPath, '-e', 'process.stdout.write("progress\\n"); setTimeout(() => process.stdout.write("finished"), 5000)'],
  })
  const reader = liveRes.body!.getReader()
  const firstChunk = new TextDecoder().decode((await reader.read()).value)
  assert.match(firstChunk, /progress/)
  assert.doesNotMatch(firstChunk, /finished|"type":"exit"/)
  await reader.cancel()

  // 2. 跨 chunk 机密脱敏、会话隔离与 NDJSON 终态
  const conv = await kernel.createConversation({ nodeId: 'integration-node', cwd: streamDir })
  const other = await kernel.createConversation({ nodeId: 'integration-node', cwd: streamDir })
  const secret = 'node-secret-across-chunks-7b0139'
  kernel.stash.put(conv.id, 'NODE_TEST_SECRET', secret)
  const redactedRes = await env.request('/api/env/exec', {
    conversationId: conv.id,
    stream: true,
    command: [
      process.execPath, '-e',
      'process.stdout.write(process.env.NODE_TEST_SECRET.slice(0, 13)); setTimeout(() => process.stdout.write(process.env.NODE_TEST_SECRET.slice(13)), 50)',
    ],
  })
  assert.equal(redactedRes.status, 200)
  assert.match(redactedRes.headers.get('content-type') ?? '', /application\/x-ndjson/)
  const frames = (await redactedRes.text()).trim().split('\n').map((line) => JSON.parse(line))
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
  assert.equal((await isolated.json() as { output: string }).output, 'absent')
  const stored = await readFile(join(env.hubDir, 'state.sqlite'))
  assert.equal(stored.includes(Buffer.from(secret)), false)
  assert.equal(stored.includes(Buffer.from(env.nodeToken)), false)

  // 3. HTTP abort 传播到节点并终止后代进程写入
  const controller = new AbortController()
  const childProgram = 'setInterval(() => require("node:fs").appendFileSync("child-heartbeat", "x"), 20)'
  const program = `const cp = require('node:child_process'); cp.spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}], { stdio: ['ignore', 'inherit', 'inherit'] }); setInterval(() => {}, 1000)`
  const pending = env.request('/api/env/exec', {
    nodeId: 'integration-node',
    cwd: streamDir,
    command: [process.execPath, '-e', program],
  }, controller.signal)
  const completed = pending.then(() => 'completed', (error: unknown) => error)
  const heartbeatPath = join(streamDir, 'child-heartbeat')
  await eventually(async () => readFile(heartbeatPath, 'utf8').then((t) => t.length >= 3, () => false), '子孙进程启动')
  controller.abort()
  const outcome = await completed
  assert.ok(outcome instanceof Error && outcome.name === 'AbortError')
  await new Promise((resolve) => setTimeout(resolve, 150))
  const beforeLen = await readFile(heartbeatPath, 'utf8')
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(await readFile(heartbeatPath, 'utf8'), beforeLen)
})

test('Herdr 传输复用真实节点 IPC，订阅 ACK 只消费一次且断线/取消正确传播', { timeout: 60_000 }, async () => {
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
    const transport = createHerdrTransport({ nodeChannel: env.hubEnv.kernel.envFabric })
    assert.deepEqual(await transport.call({ nodeId: 'integration-node', socketPath }, 'session.snapshot', {}), { source: 'remote-node-ipc' })
    const events: unknown[] = []
    const errors: unknown[] = []
    release = await transport.subscribe({ nodeId: 'integration-node', socketPath }, (event) => events.push(event), (error) => errors.push(error))
    await eventually(() => events.length === 1, '节点消费 ACK 后 Herdr 收到首帧事件')
    assert.deepEqual(events, [{ type: 'pane.created', paneId: 'remote-pane' }])
    assert.deepEqual(errors, [])
    assert.deepEqual(calls, ['session.snapshot', 'events.subscribe'])
    for (const socket of sockets) socket.end()
    await eventually(() => errors.length === 1, '节点 IPC 断开传播到订阅')
    release()
    release = undefined
    await eventually(() => sockets.size === 0, '取消订阅关闭节点 IPC socket')
  } finally {
    release?.()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => ipc.close(() => resolve()))
  }
})

test('节点断线与撤销：在途命令结果 unknown、重连绝不重放、移除后离线拒绝且不回落本机执行', { timeout: 60_000 }, async () => {
  const discDir = join(env.remoteCwd, 'disc-ws')
  await mkdir(discDir, { recursive: true })
  const countPath = join(discDir, 'executions.txt')

  const pending = env.request('/api/env/exec', {
    nodeId: 'integration-node',
    cwd: discDir,
    command: [process.execPath, '-e', 'require("node:fs").appendFileSync("executions.txt", "once\\n"); setInterval(() => {}, 1000)'],
  })
  await eventually(async () => readFile(countPath, 'utf8').then((t) => t === 'once\n', () => false), '远端命令真实启动')
  await env.daemon.close()
  const body = await (await pending).json() as { ok?: boolean }
  assert.equal(body.ok === true, false)
  assert.match(JSON.stringify(body), /unknown/)

  await env.connect()
  assert.equal(await readFile(countPath, 'utf8'), 'once\n')

  const removed = await env.cli(['nodes', 'remove', 'integration-node', '--json'])
  assert.equal(removed.code, 0, removed.err)
  await eventually(() => !env.daemon.isConnected(), '删除节点关闭既有 WS')

  const offline = await env.request('/api/env/exec', {
    nodeId: 'integration-node',
    cwd: env.hubDir,
    command: [process.execPath, '-e', 'require("node:fs").writeFileSync("must-not-run", "bad")'],
  })
  assert.equal(offline.ok, false)
  assert.match(JSON.stringify(await offline.json()), /node_offline|node_not_found/)
  await assert.rejects(readFile(join(env.hubDir, 'must-not-run')), { code: 'ENOENT' })
})
