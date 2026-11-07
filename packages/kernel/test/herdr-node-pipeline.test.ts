import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import { createHerdrTransport } from '../src/builtin-plugins/herdr/transport.js'
import type { HerdrNodeChannel } from '../src/builtin-plugins/herdr/contracts.js'
import { MutableNodeChannel, nodeFixture, type NodeFixture } from './herdr-node-fixture.js'

/**
 * 节点通道整链（取代历史 ssh+python3 stdin 通道）：
 * - 远端 call 经真实 LocalNodeChannel UDS NDJSON 协议往返；机密只在 JSON 内部；
 * - readOutput / removeOutput / runGate 在真实节点文件系统与命令环境执行；
 * - .helm 父目录软链逃逸拦截（本机与远端节点同一边界）；
 * - 远端端点纪律：只传显式 socketPath/session，绝不携带 Hub 本机解析结果；
 * - 订阅契约：ipcSubscribe Promise resolve 即就绪，onLine 只有事件帧（无二次 ACK）；
 * - Windows 端点/路径规则：interprocess pathcvt 真实规则（源码推导，未实机验证）。
 */

/** 构造 transport：远端 nodeId 经 MutableNodeChannel 指向 fixture UDS。 */
function transportOf(fixture: NodeFixture, opts: { nodeId?: string; online?: boolean; hubUrl?: string; redact?: (text: string) => string } = {}) {
  const channel = new MutableNodeChannel()
  const nodeId = opts.nodeId ?? 'node-a'
  channel.nodes.set(nodeId, { online: opts.online ?? true, ...(opts.hubUrl !== undefined ? { hubUrl: opts.hubUrl } : {}), channel: asNodeChannel(fixture.channel, nodeId) })
  return {
    channel,
    transport: createHerdrTransport({ redact: opts.redact, nodeChannel: channel }),
    target: { nodeId, socketPath: fixture.socketPath } as const,
  }
}

/**
 * 将真实 LocalNodeChannel（仅承载 'local'）适配为指定远端 nodeId 的同构通道：
 * 协议/文件/执行全部走真实实现，仅 nodeId 换标（目标节点的本机 IPC 同协议）。
 */
function asNodeChannel(local: HerdrNodeChannel, nodeId: string): HerdrNodeChannel {
  return {
    isOnline: (id) => id === nodeId && local.isOnline('local'),
    getNodeHubUrl: () => undefined,
    ipcCall: (id, input, context: Context) => local.ipcCall('local', input, context),
    envFor: (id, cwd) => local.envFor('local', cwd),
  }
}

test('远端节点 call 经通道完成 NDJSON 往返，机密只存在于 JSON 结构内部', { timeout: 60_000 }, async (t) => {
  const fixture = await nodeFixture(t)
  const secret = 'pipeline-secret-only-in-stdin'
  const { transport, target } = transportOf(fixture)
  const result = await transport.call(target, 'tab.create', { env: { PRIVATE_TOKEN: secret } }, { timeoutMs: 3_000 })
  assert.deepEqual(result, { type: 'ok' })
  assert.equal(fixture.requests.length, 1)
  assert.equal(fixture.requests[0]!.id, 'helm-remote-1')
  assert.equal(fixture.requests[0]!.method, 'tab.create')
  assert.deepEqual(fixture.requests[0]!.params.env, { PRIVATE_TOKEN: secret })
})

test('远端端点纪律：显式 socketPath 与 session 原样传递，缺省时不出现在通道入参', { timeout: 60_000 }, async (t) => {
  const fixture = await nodeFixture(t)
  const channel = new MutableNodeChannel()
  const seen: Array<{ endpoint?: string; session?: string }> = []
  const local = fixture.channel
  // 拦截型通道：只记录入参不真连（缺省 endpoint 时真实远端节点会自行解析，
  // 本 fixture 无远端可连，故对缺省分支仅验证入参形状）。
  const recorder: HerdrNodeChannel = {
    isOnline: () => true,
    getNodeHubUrl: () => undefined,
    ipcCall: (id, input, context) => {
      seen.push({ endpoint: input.endpoint, session: input.session })
      return local.ipcCall('local', input, context)
    },
    envFor: (id, cwd) => local.envFor('local', cwd),
  }
  channel.nodes.set('node-a', { online: true, channel: recorder })
  const transport = createHerdrTransport({ nodeChannel: channel })
  // 显式 socketPath + session：两者都传递。
  await transport.call({ nodeId: 'node-a', socketPath: fixture.socketPath, session: 'nightly' }, 'ping', {}, { timeoutMs: 3_000 })
  // 缺省：endpoint/session 均 undefined（目标节点自行解析，绝不携带 Hub 本机路径）。
  await assert.rejects(
    transport.call({ nodeId: 'node-a' }, 'ping', {}, { timeoutMs: 500 }),
    (error: unknown) => {
      // fixture 通道（LocalNodeChannel）要求显式 endpoint——这正是远端缺省
      // 端点由目标节点自解析的镜像：Hub 不再兜底本机路径。
      assert.equal((error as { code?: string }).code, 'herdr_node_error')
      return true
    },
  )
  assert.deepEqual(seen, [
    { endpoint: fixture.socketPath, session: 'nightly' },
    { endpoint: undefined, session: undefined },
  ])
})

test('同一节点通道完成远端文件读取、删除与 Gate 环境注入', { timeout: 60_000 }, async (t) => {
  const fixture = await nodeFixture(t)
  const root = fixture.root
  await mkdir(join(root, '.helm'), { recursive: true })
  await writeFile(join(root, '.helm', 'wf-out-pipeline.json'), '{"answer":42}')
  const secret = 'pipeline-gate-secret'
  const { transport } = transportOf(fixture, { redact: (text) => text.replaceAll(secret, '[REDACTED]') })
  const target = { nodeId: 'node-a' }
  assert.equal(await transport.readOutput(target, root, 'wf-out-pipeline.json'), '{"answer":42}')
  await transport.removeOutput(target, root, 'wf-out-pipeline.json')
  await assert.rejects(transport.readOutput(target, root, 'wf-out-pipeline.json'), (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'herdr_output_missing')
  const gate = await transport.runGate(target, 'printf "%s" "$PRIVATE_TOKEN"', root, undefined, { PRIVATE_TOKEN: secret })
  // SDK exec 的 stdout 已含换行（printf 不带 \n 但 SDK 输出结尾有行分隔）。
  assert.equal(gate.ok, true)
  assert.equal(gate.output.trim(), '[REDACTED]')
})

test('Gate 不继承宿主环境：HELM_TOKEN 只能经显式 env 注入', { timeout: 60_000 }, async (t) => {
  const fixture = await nodeFixture(t)
  const root = fixture.root
  process.env.HELM_TOKEN = 'host-secret-must-not-leak'
  try {
    const { transport } = transportOf(fixture)
    const gate = await transport.runGate({ nodeId: 'node-a' }, 'if [ -n "$HELM_TOKEN" ]; then echo "HOST:$HELM_TOKEN"; else echo CLEAN; fi', root)
    assert.equal(gate.ok, true)
    assert.equal(gate.output.trim(), 'CLEAN', '宿主 HELM_TOKEN 绝不进入 gate 子进程')
    const gate2 = await transport.runGate({ nodeId: 'node-a' }, 'echo "MANAGED:$HELM_TOKEN"', root, undefined, { HELM_TOKEN: 'managed' })
    assert.equal(gate2.output.trim(), 'MANAGED:managed', '显式 env 提供的 token 正常注入')
  } finally {
    delete process.env.HELM_TOKEN
  }
})

test('本机与远端节点交接文件均拒绝通过 .helm 父目录软链越界', { timeout: 60_000 }, async (t) => {
  const fixture = await nodeFixture(t)
  const root = fixture.root
  const cwd = join(root, 'task')
  const outside = join(root, 'outside')
  await mkdir(cwd)
  await mkdir(outside)
  await writeFile(join(outside, 'wf-out-parent.json'), '{"private":true}')
  await symlink(outside, join(cwd, '.helm'))
  const { transport } = transportOf(fixture)
  for (const target of [{}, { nodeId: 'node-a' }]) {
    await assert.rejects(transport.readOutput(target, cwd, 'wf-out-parent.json'), '读取不得越过工作目录')
    await assert.rejects(transport.removeOutput(target, cwd, 'wf-out-parent.json'), '删除不得越过工作目录')
    assert.equal(await readFile(join(outside, 'wf-out-parent.json'), 'utf8'), '{"private":true}')
  }
})

test('远端节点离线与通道缺失显式报错，绝不静默回退本机', { timeout: 60_000 }, async (t) => {
  const fixture = await nodeFixture(t)
  // 通道存在但节点离线。
  const offline = transportOf(fixture, { nodeId: 'offline-node', online: false })
  await assert.rejects(
    offline.transport.call({ nodeId: 'offline-node', socketPath: fixture.socketPath }, 'ping', {}),
    (error: unknown) => (error as { code?: string }).code === 'herdr_node_offline',
  )
  // 完全没有通道注入（nodeChannel 未提供且 nodeId 非 local）。
  const bare = createHerdrTransport({})
  await assert.rejects(
    bare.call({ nodeId: 'unknown-node' }, 'ping', {}),
    (error: unknown) => (error as { code?: string }).code === 'herdr_node_unavailable',
  )
  await assert.rejects(
    bare.runGate({ nodeId: 'unknown-node' }, 'touch /tmp/pwned', '/tmp'),
    (error: unknown) => (error as { code?: string }).code === 'herdr_node_unavailable',
  )
  await assert.rejects(
    bare.readOutput({ nodeId: 'unknown-node' }, '/tmp', 'wf-out-x.json'),
    (error: unknown) => (error as { code?: string }).code === 'herdr_node_unavailable',
  )
})

test('远端节点 hubUrl 经 getNodeHubUrl 提供时可用于窗格回连注入', { timeout: 60_000 }, async (t) => {
  const fixture = await nodeFixture(t)
  const { channel } = transportOf(fixture, { nodeId: 'node-hub', hubUrl: 'http://10.0.0.9:3202' })
  assert.equal(channel.getNodeHubUrl?.('node-hub'), 'http://10.0.0.9:3202')
  assert.equal(channel.getNodeHubUrl?.('other-node'), undefined)
})

test('远端 call 错误信封经 redact 脱敏后抛出', { timeout: 60_000 }, async (t) => {
  const secret = '{{NODE_ERR_SECRET}}'
  const fixture = await nodeFixture(t, (_req, socket) => {
    socket.end(`${JSON.stringify({ id: 'helm-remote-1', error: { code: 'agent_blocked', message: `blocked with ${secret}` } })}\n`)
  })
  const { transport, target } = transportOf(fixture)
  await assert.rejects(
    transport.call(target, 'agent.prompt', { target: 'w1:p1', text: 'hi' }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'agent_blocked')
      assert.ok(!JSON.stringify(error).includes(secret), '机密不得泄漏')
      return true
    },
  )
})

test('远端长 wait 经通道取消立即结算（底层 socket 即刻销毁）', { timeout: 60_000 }, async (t) => {
  const fixture = await nodeFixture(t, () => {
    /* 收到请求后永久静默：模拟无响应的 agent.wait */
  })
  const { transport, target } = transportOf(fixture)
  const controller = new AbortController()
  const pending = transport.call(target, 'agent.wait', { target: 'p1' }, { signal: controller.signal, timeoutMs: undefined })
  const observed = pending.then(() => undefined, (error: unknown) => error)
  await new Promise((resolve) => setTimeout(resolve, 600)) // 让请求真正发出
  controller.abort()
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), 3_000)
  })
  const error = await Promise.race([observed, deadline])
  clearTimeout(timer)
  assert.ok(error, '通道取消后长 wait 必须在限期内结算')
  assert.equal((error as { code?: string }).code, 'herdr_aborted')
})

test('远端节点交接文件超限拒绝（herdr_output_too_large），不静默截断', { timeout: 60_000 }, async (t) => {
  const fixture = await nodeFixture(t)
  const root = fixture.root
  await mkdir(join(root, '.helm'), { recursive: true })
  const big = 'x'.repeat(33 * 1024 * 1024)
  await writeFile(join(root, '.helm', 'wf-out-huge.md'), big)
  const { transport } = transportOf(fixture)
  await assert.rejects(
    transport.readOutput({ nodeId: 'node-a' }, root, 'wf-out-huge.md'),
    (error: unknown) => (error as { code?: string }).code === 'herdr_output_too_large',
  )
})

test('远端节点软链交接文件拒绝（herdr_output_not_file）', { timeout: 60_000 }, async (t) => {
  const fixture = await nodeFixture(t)
  const root = fixture.root
  await mkdir(join(root, '.helm'), { recursive: true })
  const outside = join(root, 'outside.json')
  await writeFile(outside, '{}')
  await symlink(outside, join(root, '.helm', 'wf-out-link.json'))
  const { transport } = transportOf(fixture)
  await assert.rejects(
    transport.readOutput({ nodeId: 'node-a' }, root, 'wf-out-link.json'),
    (error: unknown) => (error as { code?: string }).code === 'herdr_output_not_file',
  )
})

test('LocalNodeChannel 仅承载 local：isOnline 非 local 为 false，ipcCall/envFor 显式拒绝', { timeout: 60_000 }, async () => {
  const { LocalNodeChannel } = await import('../src/builtin-plugins/herdr/local-node-channel.js')
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context')
  const channel = new LocalNodeChannel()
  assert.equal(channel.isOnline('local'), true)
  assert.equal(channel.isOnline('node-a'), false)
  assert.equal(channel.isOnline('build-box'), false)
  const rejected = await channel.ipcCall('node-a', { line: '{"id":"1"}' }, BACKGROUND_CONTEXT)
  assert.equal(rejected.ok, false)
  assert.throws(() => channel.envFor('node-a', '/tmp'))
})

test('Windows 端点规则：pathcvt 只拼接前缀，不替换冒号/斜杠（interprocess 2.4.2 源码推导）', { timeout: 60_000 }, async () => {
  const { windowsPipeNameOf, connectHerdrEndpoint } = await import('../src/builtin-plugins/herdr/local-node-channel.js')
  // 依据 interprocess src/os/windows/path_conversion.rs pathcvt（L126-137）：
  // namespaced 名 = '\\.\pipe\' + 原始 name 逐段拼接；不替换冒号/斜杠。
  const marker = 'C:\\Users\\a\\AppData\\Roaming\\herdr\\herdr.sock'
  const pipe = windowsPipeNameOf(marker)
  assert.equal(pipe, '\\\\.\\pipe\\' + marker, '按真实规则：前缀 + 原始 marker 路径，冒号原样保留')
  assert.ok(pipe.includes(':'), '冒号不替换（旧实现替换为下划线是伪造规则）')
  // 正斜杠统一为反斜杠（NPFS 路径分隔）。
  assert.equal(windowsPipeNameOf('C:/Users/a/herdr.sock'), '\\\\.\\pipe\\C:\\Users\\a\\herdr.sock')
  // 已是完整 pipe 路径（\\HOST\pipe\NAME，interprocess is_pipefs 通过形态）原样返回。
  assert.equal(windowsPipeNameOf('\\\\.\\pipe\\herdr-sock'), '\\\\.\\pipe\\herdr-sock')
  assert.equal(windowsPipeNameOf('\\\\CHARA\\pipe\\remote-pipe'), '\\\\CHARA\\pipe\\remote-pipe')
  // connectHerdrEndpoint 按 kind 分派：named-pipe 走 pipe 名换算，unix 走原路径。
  const socket = connectHerdrEndpoint('C:\\Users\\a\\herdr.sock', 'named-pipe')
  socket.destroy()
})

test('跨平台路径纯规则：Windows 形状选 win32，根目录 containment 不多加分隔', { timeout: 60_000 }, async () => {
  const { pathContains, isWindowsShapedPath, isAbsoluteAnyPath } = await import('../src/builtin-plugins/herdr/transport.js')
  assert.equal(isWindowsShapedPath('C:\\a'), true)
  assert.equal(isWindowsShapedPath('C:/a'), true)
  assert.equal(isWindowsShapedPath('\\\\srv\\share'), true)
  assert.equal(isWindowsShapedPath('/posix'), false)
  // 盘符绝对与 UNC 绝对；C:relative（无分隔）拒绝。
  assert.equal(isAbsoluteAnyPath('C:\\work'), true)
  assert.equal(isAbsoluteAnyPath('C:relative'), false)
  assert.equal(isAbsoluteAnyPath('\\\\srv\\share\\w'), true)
  assert.equal(isAbsoluteAnyPath('/work'), true)
  assert.equal(isAbsoluteAnyPath('rel'), false)
  // containment：根目录 '/' 时 '/foo' 合法包含（旧实现拼 '//foo' 会误拒）。
  assert.equal(pathContains('/', '/foo'), true)
  assert.equal(pathContains('/work', '/work/.helm'), true)
  assert.equal(pathContains('/work', '/workshop'), false, '前缀相同但非子路径不得包含')
  // Windows 形状同样按 win32 分隔判断。
  assert.equal(pathContains('C:\\work', 'C:\\work\\.helm'), true)
  assert.equal(pathContains('C:\\work', 'C:\\workshop'), false)
  assert.equal(pathContains('\\\\srv\\share', '\\\\srv\\share\\helm'), true)
})

test('远端节点订阅：ipcSubscribe resolve 即就绪，onLine 只有事件帧（无二次 ACK）', { timeout: 60_000 }, async (t) => {
  const fixture = await nodeFixture(t)
  const released: string[] = []
  // 真实契约 fixture：ipcSubscribe 在验证服务端 ACK（subscription_started）后
  // resolve；此后 onLine 只转发事件帧。事件在 resolve 前到达时缓冲后按序分发。
  const outerChannel = {
    isOnline: () => true,
    getNodeHubUrl: () => undefined,
    ipcCall: (nodeId: string, input: { endpoint?: string; session?: string; line: string; timeoutMs?: number }, context: import('@earendil-works/chord/context').Context) =>
      fixture.channel.ipcCall(nodeId, input, context),
    envFor: (nodeId: string, cwd: string) => fixture.channel.envFor(nodeId, cwd),
    async ipcSubscribe(
      nodeId: string,
      input: { endpoint?: string; session?: string; line: string },
      onLine: (line: string) => void,
      onClosed: (error?: string) => void,
      _context: import('@earendil-works/chord/context').Context,
    ) {
      assert.equal(nodeId, 'node-sub')
      const request = JSON.parse(input.line) as { id: string; method: string; params: { subscriptions: unknown[] } }
      assert.equal(request.method, 'events.subscribe')
      assert.equal(request.params.subscriptions.length, 8)
      // 事件帧在 resolve（ACK 消费）之前到达：必须被缓冲不丢弃。
      onLine(JSON.stringify({ event: 'pane_updated', data: { pane: { pane_id: 'w1:p0' } } }))
      // ACK 由通道层消费验证（不经 onLine 回传）——真实 NodeRPC ipcSubscribe 契约。
      await new Promise((resolve) => setTimeout(resolve, 20))
      // 模拟：订阅请求已被服务端确认（ACK 验证通过），流就绪。
      const early = [{ type: 'pane.updated', paneId: 'w1:p0' }]
      void early
      return () => {
        released.push(nodeId)
      }
    },
  }
  const transport = createHerdrTransport({ nodeChannel: outerChannel })
  const errors: unknown[] = []
  const received: { type: string; paneId?: string }[] = []
  const stop = await transport.subscribe(
    { nodeId: 'node-sub', socketPath: fixture.socketPath },
    (event) => {
      if ('paneId' in event) received.push({ type: event.type, paneId: event.paneId })
    },
    (error) => errors.push(error),
  )
  await new Promise((resolve) => setTimeout(resolve, 100))
  // resolve 前缓冲的事件按序分发。
  assert.deepEqual(received.map((e) => [e.type, e.paneId]), [['pane.updated', 'w1:p0']])
  // resolve 后的事件帧正常分发；id 帧（ACK/响应）到达则通道违约显式报错。
  const emit = (outerChannel as unknown as {
    ipcSubscribe: (n: string, i: unknown, onLine: (l: string) => void, onClosed: (e?: string) => void, c: unknown) => Promise<() => void>
  })
  void emit
  assert.equal(errors.length, 0)
  stop()
  assert.deepEqual(released, ['node-sub'], '停止订阅释放远端流')
})

test('远端订阅后续帧经 onLine 分发；id 帧到达显式报错（ACK 已在通道层消费）', { timeout: 60_000 }, async () => {
  // 受控通道：resolve 后推送事件帧序列与一个迟到 id 帧，验证分发与违约终结。
  let pushLine: ((line: string) => void) | undefined
  const channel = {
    isOnline: () => true,
    getNodeHubUrl: () => undefined,
    ipcCall: async () => ({ ok: false as const, error: { code: 'unknown' as const, message: 'fixture 不承载 call' } }),
    envFor: () => { throw new Error('fixture 不承载 env') },
    async ipcSubscribe(
      _nodeId: string,
      input: { line: string },
      onLine: (line: string) => void,
      _onClosed: (error?: string) => void,
      _context: unknown,
    ) {
      const request = JSON.parse(input.line) as { method: string }
      assert.equal(request.method, 'events.subscribe')
      pushLine = onLine
      return () => {
        pushLine = undefined
      }
    },
  }
  const transport = createHerdrTransport({ nodeChannel: channel as never })
  const errors: unknown[] = []
  const received: string[] = []
  const stop = await transport.subscribe(
    { nodeId: 'node-ev' },
    (event) => {
      if ('paneId' in event) received.push(`${event.type}:${event.paneId}`)
    },
    (error) => errors.push(error),
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  pushLine!(JSON.stringify({ event: 'pane_closed', data: { pane_id: 'w1:p3' } }))
  pushLine!(JSON.stringify({ event: 'pane_focused', data: { pane_id: 'w1:p4' } }))
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(received, ['pane.closed:w1:p3', 'pane.focused:w1:p4'])
  assert.equal(errors.length, 0)
  // 迟到 id 帧：ACK 已在通道层消费，此处属通道违约，显式报错并终结（回调只一次）。
  pushLine!(JSON.stringify({ id: 'sub', result: { type: 'subscription_started' } }))
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(errors.length, 1)
  assert.equal((errors[0] as { code?: string }).code, 'herdr_protocol')
  stop()
})
