import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createHerdrTransport, isValidNodeId } from '../src/builtin-plugins/herdr/transport.js'
import { MutableNodeChannel, nodeFixture } from './herdr-node-fixture.js'

async function tempRoot(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'helm-transport-final-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

/** 节点通道 fixture：远端目标经真实 LocalNodeChannel 走受控 UDS 服务器。 */
async function channelFixture(t: TestContext, respond: (request: Record<string, unknown>, socket: Socket) => void) {
  const fixture = await nodeFixture(t, respond)
  const channel = new MutableNodeChannel()
  channel.nodes.set('fixture-node', { online: true, channel: fixture.channel })
  return {
    fixture,
    channel,
    transport: createHerdrTransport({ nodeChannel: channel }),
    target: { nodeId: 'fixture-node', socketPath: fixture.socketPath } as const,
  }
}

test('本机 transport Gate 在传入的 cwd 实际执行', { timeout: 60_000 }, async (t) => {
  const root = await tempRoot(t)
  const result = await createHerdrTransport().runGate({}, 'pwd', root)
  assert.deepEqual(result, { ok: true, output: `${root}\n` })
})

test('无限期 agent.wait 在对端保持半开且不响应时也能被 abort 立即终止', { timeout: 60_000 }, async (t) => {
  const root = await tempRoot(t)
  let received!: () => void
  const ready = new Promise<void>((resolve) => { received = resolve })
  const { transport, target } = await channelFixture(t, () => { received() })
  const controller = new AbortController()
  const pending = transport.call(target, 'agent.wait', { target: 'p1' }, { signal: controller.signal })
  const observed = pending.then(() => undefined, (error: unknown) => error)
  await ready
  controller.abort()
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 1_500) })
  const error = await Promise.race([observed, deadline])
  clearTimeout(timer)
  assert.ok(error, 'abort 必须主动结算，不能等待对端关闭读取方向')
  assert.equal((error as { code?: string }).code, 'herdr_aborted')
})

test('nodeId 校验拒绝注入与非法形态（新契约：单一安全 token，SSH 机器名遗留形态拒绝）', { timeout: 60_000 }, () => {
  for (const nodeId of ['work_host', 'node-1.sub', 'macbook_pro.2', 'local', 'a'.repeat(128)]) {
    assert.equal(isValidNodeId(nodeId), true, `合法节点：${nodeId}`)
  }
  // SSH 机器名遗留形态不再是合法节点 ID；空串显式拒绝（不默默当本机）。
  for (const nodeId of ['', 'user@work_host', '2001:db8::1', '[2001:db8::1]', 'a'.repeat(129), '-oProxyCommand=bad', 'user@host;bad', 'a b', 'x\ny']) {
    assert.equal(isValidNodeId(nodeId), false, `非法节点：${JSON.stringify(nodeId)}`)
  }
})

for (const remote of [false, true]) {
  test(`${remote ? '远端节点' : '本机'}缺少 .helm 目录时读取为缺文件，删除保持幂等`, { timeout: 60_000 }, async (t) => {
    const root = await tempRoot(t)
    const { transport, target } = remote
      ? await channelFixture(t, () => {})
      : { transport: createHerdrTransport(), target: {} as { nodeId?: string; socketPath?: string } }
    const finalTarget = remote ? target : {}
    await assert.rejects(transport.readOutput(finalTarget, root, 'wf-out-missing.md'), { code: 'herdr_output_missing' })
    await transport.removeOutput(finalTarget, root, 'wf-out-missing.md')
  })

  test(`${remote ? '远端节点' : '本机'}RPC 拒绝没有关联 id 的响应`, { timeout: 60_000 }, async (t) => {
    const root = await tempRoot(t)
    const respond = (_request: Record<string, unknown>, socket: Socket) => {
      socket.end(`${JSON.stringify({ result: { type: 'ok' } })}\n`)
    }
    let transport: ReturnType<typeof createHerdrTransport>
    let target: { nodeId?: string; socketPath?: string }
    if (remote) {
      const built = await channelFixture(t, respond)
      transport = built.transport
      target = built.target
    } else {
      const socketPath = await localSocketServer(t, root, respond)
      transport = createHerdrTransport()
      target = { socketPath }
    }
    await assert.rejects(transport.call(target, 'tab.close', { tab_id: 't1' }, { timeoutMs: 3_000 }), { code: 'herdr_protocol' })
  })
}

/** 本机受控 UDS 服务器（本机分支测试用）。 */
async function localSocketServer(t: TestContext, root: string, respond: (request: Record<string, unknown>, socket: Socket) => void) {
  const sockets = new Set<Socket>()
  const socketPath = join(root, 'herdr.sock')
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    let input = ''
    socket.on('data', (chunk) => {
      input += chunk.toString('utf8')
      const newline = input.indexOf('\n')
      if (newline >= 0) respond(JSON.parse(input.slice(0, newline)), socket)
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })
  return socketPath
}

test('订阅 ack 必须携带本次请求 id', { timeout: 60_000 }, async (t) => {
  const root = await tempRoot(t)
  const socketPath = await localSocketServer(t, root, (_request, socket) => {
    socket.write(`${JSON.stringify({ id: 'wrong-subscription', result: { type: 'subscription_started' } })}\n`)
  })
  await assert.rejects(async () => {
    const stop = await createHerdrTransport().subscribe({ socketPath }, () => {}, () => {})
    stop()
  }, { code: 'herdr_protocol' })
})

test('Gate 主进程已退出时 abort 仍清理持有管道的自有子进程', { timeout: 60_000 }, async (t) => {
  const root = await tempRoot(t)
  const controller = new AbortController()
  const pending = createHerdrTransport().runGate({}, 'sleep 300 & printf "%s %s" "$$" "$!" > processes; exit 0', root, controller.signal)
  const observed = pending.then((result) => ({ result }), (error: unknown) => ({ error }))
  let group = 0
  let child = 0
  let timer: NodeJS.Timeout | undefined
  try {
    const deadline = Date.now() + 5_000
    for (;;) {
      try {
        ;[group, child] = (await readFile(join(root, 'processes'), 'utf8')).trim().split(' ').map(Number) as [number, number]
        if (group > 1 && child > 1) {
          try { process.kill(group, 0) } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') break
            throw error
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      assert.ok(Date.now() < deadline, '应先证实 Gate 主进程已退出')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    process.kill(child, 0)
    controller.abort()
    const outcome = await Promise.race([
      observed,
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 1_000) }),
    ])
    assert.ok(outcome, '主进程退出后仍须杀掉自有子进程并结算')
    assert.ok('error' in outcome)
    assert.equal((outcome.error as { code?: string }).code, 'herdr_aborted')
  } finally {
    clearTimeout(timer)
    controller.abort()
    if (group > 1 && child > 1) {
      try { process.kill(-group, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    await observed
  }
})
