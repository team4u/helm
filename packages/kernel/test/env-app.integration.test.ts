import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import type { AgentExecutionInfo } from '@helm/protocol'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'

/** 单工具调用 faux 消息（stopReason: toolUse）。 */
function fauxToolCallMessage(name: string, input: Record<string, unknown>): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage([fauxToolCall(name, input as Record<string, never>)], { stopReason: 'toolUse' })
}
import { createHelm, createHerdrNodeChannel } from '../src/app.js'
import { startHub } from '../src/http/index.js'
import { createHerdrTransport } from '../src/builtin-plugins/herdr/transport.js'
import { createNodeDaemon, type NodeDaemon } from '../../node/src/index.js'
import { runCli } from '../../cli/src/index.js'

// 真实组合层 + 真实 WS 节点；模型由 SDK 官方 faux provider 驱动确定性工具回合。
async function openEnvironment() {
  const root = await mkdtemp(join(tmpdir(), 'helm-node-app-'))
  const hubDir = join(root, 'hub')
  const nodeDir = join(root, 'node')
  const remoteCwd = join(root, 'remote-workspace')
  await Promise.all([mkdir(hubDir), mkdir(nodeDir), mkdir(remoteCwd)])
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir: hubDir, cwd: hubDir, model: 'faux/faux-1', models })
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
            try { await app.close() } finally { auth.dispose(); await rm(root, { recursive: true, force: true }) }
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
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(description)
}

test('跨节点后台原生子代理：真实 WS 节点分配 worktree、执行 gate、CLI 清理原节点工作树', { timeout: 60_000 }, async () => {
  const env = await openEnvironment()
  try {
    const setup = await env.cli(['env', 'exec', '--node', 'integration-node', '--cwd', env.remoteCwd, '--json', '--',
      'git init . && git config user.email test@helm.local && git config user.name HelmTest && printf base > base.txt && git add base.txt && git commit -m base'])
    assert.equal(setup.code, 0, setup.err)
    assert.equal(JSON.parse(setup.out).ok, true, setup.out)
    const parent = await env.app.kernel.createConversation({ nodeId: 'integration-node', cwd: env.remoteCwd })
    env.faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage('远端任务结果')))
    // 后台子代理经模型工具链（subagent background:true）——与真实生产路径
    // 一致（引擎 startBackgroundAgent 由 builtin:workflow 插件内部接线）。
    env.faux.setResponses([
      fauxToolCallMessage('subagent', {
        prompt: '执行远端验收',
        background: true,
        isolation: 'worktree',
        gate: 'test "$HELM_NODE_TEST_ORIGIN" = remote-executor && printf "$HELM_NODE_TEST_ORIGIN" > remote-proof.txt',
      }),
      fauxAssistantMessage('后台任务已派出'),
    ])
    await env.app.kernel.submitInput(parent.id, '派后台隔离子代理')
    await env.app.kernel.waitForIdle(parent.id)
    // 从工具输出提取 runId 与 execution（子会话即执行环境）。
    const detail = await env.app.kernel.getConversationDetail(parent.id, { limit: 50 })
    const toolText = JSON.stringify(detail)
    const runIdMatch = /runId\\?":\\?"(wf_[0-9a-f]+)/.exec(toolText)
    assert.ok(runIdMatch, `subagent 工具输出应含 runId：${toolText.slice(0, 400)}`)
    const runId = runIdMatch[1]!
    const child = env.app.kernel.listConversations().find((c) => c.parentConversationId === parent.id)
    assert.ok(child, '后台子会话应已派生')
    assert.equal(child.nodeId, 'integration-node')
    const inspect = await env.app.kernel.plugins.invokeAction('builtin:workflow', 'inspect', { runId }) as { run: { status: string } }
    for (let i = 0; i < 300 && inspect.run.status === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      inspect.run = ((await env.app.kernel.plugins.invokeAction('builtin:workflow', 'inspect', { runId })) as { run: { status: string } }).run
    }
    assert.equal(inspect.run.status, 'completed')
    // 子会话绑定的受管隔离树（后台 spawn 由 run 记录登记 conversationId）。
    const record = env.app.kernel.worktrees.getForConversation(child.id)
    assert.ok(record?.id, '后台子会话应绑定受管 worktree 记录')
    assert.equal(await readFile(join(record!.path, 'remote-proof.txt'), 'utf8'), 'remote-executor', 'gate 必须读取节点专属环境，不能落回 Hub 执行')
    const preserved = await env.cli(['worktrees', 'cleanup', '--worktree-id', record!.id, '--json'])
    assert.notEqual(preserved.code, 0, '远端未提交产物默认保留')
    assert.equal(JSON.parse(preserved.err).error.code, 'worktree_dirty')
    const cleanup = await env.cli(['worktrees', 'cleanup', '--worktree-id', record!.id, '--force', '--delete-branch', '--json'])
    assert.equal(cleanup.code, 0, cleanup.err)
    assert.equal(JSON.parse(cleanup.out).nodeId, 'integration-node')
    assert.equal(JSON.parse(cleanup.out).removed, true)
    await assert.rejects(access(record!.path), { code: 'ENOENT' })
  } finally { await env.close() }
})

test('跨节点执行的非法输入在 HTTP 边界返回明确的 400', { timeout: 60_000 }, async () => {
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

test('本机受管 Shell 的 helm 包装入口能访问真实 Hub', { timeout: 60_000 }, async () => {
  const env = await openEnvironment()
  try {
    const response = await env.request('/api/env/exec', { nodeId: 'local', cwd: env.hubDir, conversationId: 1, command: 'helm status --json' })
    assert.equal(response.status, 200)
    const result = await response.json() as { ok: boolean; output: string }
    assert.equal(result.ok, true, result.output)
    assert.equal(JSON.parse(result.output).authenticated, true)
  } finally { await env.close() }
})

test('节点贯通：Herdr 停用时 CLI、真实模型工具与 gate 均在会话绑定节点执行', { timeout: 60_000 }, async () => {
  const env = await openEnvironment()
  try {
    assert.equal(env.app.kernel.plugins.list().find((p) => p.id === 'builtin:herdr')?.enabled, false)
    const listed = await env.cli(['nodes', 'list', '--json'])
    assert.equal(listed.code, 0, listed.err)
    assert.ok(JSON.parse(listed.out).some((n: { id: string; online: boolean }) => n.id === 'integration-node' && n.online))
    const snapshot = env.app.kernel.events.currentSnapshot()
    assert.ok(snapshot.nodes?.some((node) => node.id === 'integration-node' && node.online), 'SSE 快照应与节点管理 API 一致')
    assert.equal(JSON.stringify(snapshot).includes(env.token), false)
    const nodeFrames: unknown[] = []
    const releaseEvents = env.app.kernel.events.subscribe((frame) => {
      if (frame.event.type === 'node.changed') nodeFrames.push(frame)
    })
    await env.daemon.close()
    await eventually(() => nodeFrames.length > 0, '节点断线必须发布 node.changed')
    await env.connect()
    await eventually(() => nodeFrames.length >= 2, '重新注册必须发布 node.changed')
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
      fauxAssistantMessage('节点工具回合完成'),
    ])
    await env.app.kernel.submitInput(conversation.id, '执行文件编辑并查询 Hub 状态')
    await env.app.kernel.waitForIdle(conversation.id)
    assert.equal(await readFile(join(env.remoteCwd, 'proof.txt'), 'utf8'), 'second')
    const detail = await env.app.kernel.getConversationDetail(conversation.id)
    const serialized = JSON.stringify(detail)
    assert.equal(serialized.includes(env.token), false)
    assert.match(serialized, /second/)
    const toolResults = JSON.stringify(detail.entries.filter((entry) => entry.kind === 'pi.tool-result'))
    assert.doesNotMatch(toolResults, /command not found|not recognized|未配置 Token|hub_unreachable/)
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
    assert.equal(profileConversation.cwd, env.remoteCwd, '普通会话与原生专家都使用 Profile 的节点和目录')
    env.faux.setResponses([fauxAssistantMessage('节点专家完成')])
    let childId: number | undefined
    await env.app.kernel.spawnAgent({
      parentConversationId: 1, agentType: 'node-expert', prompt: '执行节点专家任务',
      gate: 'test "$HELM_NODE_TEST_ORIGIN" = remote-executor && printf gate >> native-gate',
      onResolved: (info) => { childId = info.conversationId },
    })
    assert.ok(childId)
    assert.equal(env.app.kernel.getConversation(childId).nodeId, 'integration-node')
    assert.equal(await readFile(join(env.remoteCwd, 'native-gate'), 'utf8'), 'gate', '原生子代理门禁在目标节点恰好执行一次')
  } finally { await env.close() }
})

test('真实 HTTP 流在命令结束前交付输出，取消响应关闭远端执行', { timeout: 60_000 }, async () => {
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

test('节点流输出：跨块秘密脱敏、会话隔离与真实 NDJSON 终态', { timeout: 60_000 }, async () => {
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

test('节点断线与撤销：在途命令结果未知、重连不重放、离线不执行本机', { timeout: 60_000 }, async () => {
  const env = await openEnvironment()
  try {
    const countPath = join(env.remoteCwd, 'executions.txt')
    const pending = env.request('/api/env/exec', {
      nodeId: 'integration-node', cwd: env.remoteCwd,
      command: [process.execPath, '-e',
        'require("node:fs").appendFileSync("executions.txt", "once\\n"); setInterval(() => {}, 1000)'],
    })
    await eventually(async () => readFile(countPath, 'utf8').then((text) => text === 'once\n', () => false), '远端命令应真实开始')
    await env.daemon.close()
    const result = await pending
    const body = await result.json() as { ok?: boolean; output?: string; error?: { code: string; message: string } }
    assert.equal(body.ok === true, false)
    assert.match(JSON.stringify(body), /unknown|未知/)
    await env.connect()
    assert.equal(await readFile(countPath, 'utf8'), 'once\n', '新连接不能重放副作用命令')
    const removed = await env.cli(['nodes', 'remove', 'integration-node', '--json'])
    assert.equal(removed.code, 0, removed.err)
    await eventually(() => !env.daemon.isConnected(), '删除节点必须关闭其现有 WS')
    const offline = await env.request('/api/env/exec', {
      nodeId: 'integration-node', cwd: env.hubDir,
      command: [process.execPath, '-e', 'require("node:fs").writeFileSync("must-not-run", "bad")'],
    })
    assert.equal(offline.ok, false)
    assert.match(JSON.stringify(await offline.json()), /node_offline|node_not_found/)
    await assert.rejects(readFile(join(env.hubDir, 'must-not-run')), { code: 'ENOENT' })
  } finally { await env.close() }
})

test('跨节点取消：HTTP 中止传播到节点并停止孙进程写入', { timeout: 60_000 }, async () => {
  const env = await openEnvironment()
  try {
    const controller = new AbortController()
    const childProgram = 'setInterval(() => require("node:fs").appendFileSync("child-heartbeat", "x"), 20)'
    const program = `const cp = require('node:child_process'); cp.spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}], { stdio: ['ignore', 'inherit', 'inherit'] }); setInterval(() => {}, 1000)`
    const pending = env.request('/api/env/exec', {
      nodeId: 'integration-node', cwd: env.remoteCwd,
      command: [process.execPath, '-e', program],
    }, controller.signal)
    // 先消费 rejection，避免取消后测试读取文件期间出现未处理拒绝。
    const completed = pending.then(() => 'completed', (error: unknown) => error)
    const heartbeatPath = join(env.remoteCwd, 'child-heartbeat')
    await eventually(async () => readFile(heartbeatPath, 'utf8').then((text) => text.length >= 3, () => false), '孙进程必须实际运行后再取消')
    controller.abort()
    const outcome = await completed
    assert.ok(outcome instanceof Error && outcome.name === 'AbortError')
    await new Promise((resolve) => setTimeout(resolve, 200))
    const before = await readFile(heartbeatPath, 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(await readFile(heartbeatPath, 'utf8'), before, '取消必须停止进程树，不能只拒绝 Hub Promise')
  } finally { await env.close() }
})

test('Herdr 传输复用真实节点 IPC，订阅 ACK 只消费一次', { timeout: 60_000 }, async () => {
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
    const transport = createHerdrTransport({ nodeChannel: createHerdrNodeChannel(env.app.kernel.envFabric) })
    assert.deepEqual(await transport.call({ nodeId: 'integration-node', socketPath }, 'session.snapshot', {}), { source: 'remote-node-ipc' })
    const events: unknown[] = []
    const errors: unknown[] = []
    release = await transport.subscribe({ nodeId: 'integration-node', socketPath }, (event) => events.push(event), (error) => errors.push(error))
    await eventually(() => events.length === 1, '节点已消费 ACK 后，Herdr 仍应接收首个真实事件')
    assert.deepEqual(events, [{ type: 'pane.created', paneId: 'remote-pane' }])
    assert.deepEqual(errors, [])
    assert.deepEqual(calls, ['session.snapshot', 'events.subscribe'])
    for (const socket of sockets) socket.end()
    await eventually(() => errors.length === 1, '节点 IPC 实际断开必须传达到 Herdr 订阅者')
    assert.match(String(errors[0]), /subscription|disconnect|关闭|断开/)
    release()
    release = undefined
    await eventually(() => sockets.size === 0, '取消订阅必须真正关闭节点 IPC socket')
  } finally {
    release?.()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => ipc.close(() => resolve()))
    await env.close()
  }
})
