import { after, before, describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import { HelmError } from '@helm/protocol'

import {
  HERDR_CALL_TIMEOUT_MS,
  HerdrTransportError,
  LineAssembler,
  createHerdrTransport,
  isValidNodeId,
  isValidSessionName,
} from '../src/builtin-plugins/herdr/transport.js'
import { MutableNodeChannel, nodeFixture } from './herdr-node-fixture.js'

/**
 * 传输层边界测试：用真实临时 Unix socket 验证 NDJSON wire、订阅流、错误信封、
 * abort 与文件安全边界；用节点通道 fixture（真实 LocalNodeChannel + 受控 UDS）
 * 验证远端分派与「机密只在 JSON 结构内部」。这不伪称真实远端 E2E。
 */

function secret(): string {
  return 'sk-secret-DO-NOT-LEAK-9f1b2c'
}

function makeServer(onLine: (line: string, socket: Socket, write: (s: string) => void) => void) {
  const server = createServer((socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        onLine(line, socket, (text) => socket.write(`${text}\n`))
      }
    })
  })
  return server
}

function withTimeout<T>(promise: Promise<T>, ms = 8000): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('test timeout')), ms).unref())])
}

async function tempRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'helm-transport-'))
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

/** 本机受控 UDS 服务器（本机分支测试用）。 */
async function localSocketServer(t: TestContext, root: string, respond: (request: Record<string, unknown>, socket: Socket) => void): Promise<string> {
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

describe('LineAssembler 字节级确定性', () => {
  it('逐字节喂入不破坏跨 chunk UTF-8 与多帧累计', { timeout: 60_000 }, () => {
    const frames = [
      JSON.stringify({ event: 'pane_updated', data: { pane: { pane_id: 'w1:p1', title: '中文标题-β与emoji占位' } } }),
      JSON.stringify({ id: '2', result: { type: 'agent_info', agent: { name: '名称二' } } }),
      JSON.stringify({ event: 'pane_closed', data: { pane_id: 'w2:p3' } }),
    ]
    const stream = Buffer.from(`${frames.join('\n')}\n`, 'utf8')
    const assembler = new LineAssembler()
    const collected: string[] = []
    for (let i = 0; i < stream.length; i += 1) {
      collected.push(...assembler.push(stream.subarray(i, i + 1)))
    }
    collected.push(...assembler.flush())
    assert.deepEqual(
      collected.map((line) => JSON.parse(line)),
      frames.map((line) => JSON.parse(line)),
    )
  })

  it('坏 UTF-8 序列显式报协议错误', { timeout: 60_000 }, () => {
    const assembler = new LineAssembler()
    const invalid = Buffer.concat([Buffer.from([0x22, 0xe4, 0xbd]), Buffer.from([0x0a])])
    assert.throws(() => assembler.push(invalid), (err: unknown) => err instanceof HerdrTransportError && err.code === 'herdr_protocol')
  })

  it('单帧超限显式报错，且限额按帧不按连接累计', { timeout: 60_000 }, () => {
    const assembler = new LineAssembler()
    // 两帧各 100 字节：均低于 256 限额，累计也不触发（连接级累计会误杀）。
    const okFrame = Buffer.concat([Buffer.alloc(100, 0x61), Buffer.from([0x0a])])
    assert.equal(assembler.push(okFrame, 256).length, 1)
    assert.equal(assembler.push(okFrame, 256).length, 1)
    // 单帧超限必须拒绝。
    const bigFrame = Buffer.concat([Buffer.alloc(300, 0x62), Buffer.from([0x0a])])
    assert.throws(
      () => assembler.push(bigFrame, 256),
      (err: unknown) => err instanceof HerdrTransportError && err.code === 'herdr_frame_too_large',
    )
  })

  it('NUL 字节显式拒绝', { timeout: 60_000 }, () => {
    const assembler = new LineAssembler()
    assert.throws(
      () => assembler.push(Buffer.from([0x61, 0x00, 0x0a])),
      (err: unknown) => err instanceof HerdrTransportError && err.code === 'herdr_protocol',
    )
  })
})

describe('herdr transport wire', () => {
  let socketDir: string
  let socketPath: string
  let counter = 0

  before(async () => {
    socketDir = await mkdtemp(join(tmpdir(), 'herdr-transport-'))
  })

  after(async () => {
    await rm(socketDir, { recursive: true, force: true })
  })

  async function listen(server: Server): Promise<string> {
    counter += 1
    const path = join(socketDir, `herdr-${counter}.sock`)
    await new Promise<void>((resolve) => server.listen(path, resolve))
    return path
  }

  async function close(server: Server): Promise<void> {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  it('call 发送单行请求并解包 result', { timeout: 60_000 }, async () => {
    const server = makeServer((line, _socket, write) => {
      const req = JSON.parse(line)
      assert.equal(req.method, 'tab.create')
      assert.equal(req.params.cwd, '/tmp/demo')
      assert.equal(req.params.env['HELM_TOKEN'], secret())
      write(JSON.stringify({ id: req.id, result: { type: 'tab_created', tab: { tab_id: 'w1:t2' }, root_pane: { pane_id: 'w1:p9' } } }))
    })
    socketPath = await listen(server)
    const transport = createHerdrTransport()
    const result = (await withTimeout(
      transport.call({ socketPath }, 'tab.create', { cwd: '/tmp/demo', env: { HELM_TOKEN: secret() } }),
    )) as Record<string, unknown>
    assert.equal(result['type'], 'tab_created')
    await close(server)
  })

  it('call 对 error 信封抛出 code+message 并经 redact 脱敏', { timeout: 60_000 }, async () => {
    const server = makeServer((line, _socket, write) => {
      const req = JSON.parse(line)
      write(JSON.stringify({ id: req.id, error: { code: 'agent_blocked', message: `blocked with ${secret()}` } }))
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    const transport = createHerdrTransport({ redact: (text) => text.replaceAll(secret(), '[REDACTED]') })
    await assert.rejects(
      transport.call({ socketPath }, 'agent.prompt', { target: 'w1:p1', text: 'hi' }),
      (err: unknown) => {
        assert.ok(err instanceof HerdrTransportError)
        assert.equal(err.code, 'agent_blocked')
        assert.ok(!err.message.includes(secret()), 'error message must be redacted')
        assert.ok(err.message.includes('[REDACTED]'))
        return true
      },
    )
    await close(server)
  })

  it('连接不存在时显式报 socket 错误', { timeout: 60_000 }, async () => {
    const transport = createHerdrTransport()
    await assert.rejects(
      transport.call({ socketPath: join(socketDir, 'missing.sock') }, 'ping', {}),
      (err: unknown) => err instanceof HerdrTransportError && err.code === 'herdr_socket',
    )
  })

  it('服务端提前关闭时显式报错，不静默', { timeout: 60_000 }, async () => {
    const server = createServer((socket) => socket.destroy())
    socketPath = await listen(server)
    const transport = createHerdrTransport()
    await assert.rejects(
      transport.call({ socketPath }, 'ping', {}),
      (err: unknown) => err instanceof HerdrTransportError && (err.code === 'herdr_disconnected' || err.code === 'herdr_socket'),
    )
    await close(server)
  })

  it('abort 触发后 call 显式失败', { timeout: 60_000 }, async () => {
    const server = makeServer(() => {
      /* 故意不响应 */
    })
    socketPath = await listen(server)
    const transport = createHerdrTransport()
    const controller = new AbortController()
    const pending = transport.call({ socketPath }, 'agent.wait', { target: 'w1:p1' }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    // abort 主动结算并销毁本方 socket，不依赖对端关闭；语义即 herdr_aborted。
    await assert.rejects(pending, (err: unknown) => err instanceof HerdrTransportError && err.code === 'herdr_aborted')
    await close(server)
  })

  it('跨 chunk 的 UTF-8 与分帧能正确重组', { timeout: 60_000 }, async () => {
    const payload = { id: '1', result: { type: 'agent_info', agent: { name: '中文代理-β' } } }
    const encoded = JSON.stringify(payload)
    const server = createServer((socket) => {
      socket.on('data', () => {
        // 每次只发 3 个字节，拆散 UTF-8 序列与 JSON 结构
        const bytes = Buffer.from(`${encoded}\n`, 'utf8')
        let offset = 0
        const tick = setInterval(() => {
          const next = Math.min(offset + 3, bytes.length)
          socket.write(bytes.subarray(offset, next))
          offset = next
          if (offset >= bytes.length) clearInterval(tick)
        }, 1)
      })
    })
    socketPath = await listen(server)
    const transport = createHerdrTransport()
    const result = (await withTimeout(transport.call({ socketPath }, 'agent.get', { target: 'w1:p1' }))) as {
      agent?: { name?: string }
    }
    assert.equal(result.agent?.name, '中文代理-β')
    await close(server)
  })

  it('agent.prompt 无显式超时不套客户端死线', { timeout: 60_000 }, async () => {
    // 服务端延迟 700ms 才回；若误套 120s 内的短死线或立即判超时会失败。
    // 同时验证 wait 类方法在无 timeoutMs 时不会被 herdr_timeout 抢先 reject。
    const server = makeServer((line, _socket, write) => {
      const req = JSON.parse(line)
      setTimeout(() => {
        write(JSON.stringify({ id: req.id, result: { type: 'agent_info', agent: { pane_id: 'w1:p1', agent_status: 'done' } } }))
      }, 700)
    })
    socketPath = await listen(server)
    const transport = createHerdrTransport()
    const result = (await withTimeout(
      transport.call({ socketPath }, 'agent.prompt', { target: 'w1:p1', text: 'task', wait: { until: ['done'] } }),
      5000,
    )) as Record<string, unknown>
    assert.equal(result['type'], 'agent_info')
    await close(server)
  })

  it('普通 RPC 缺省 120s 死线，agent.start 覆盖 timeout_ms+余量', { timeout: 60_000 }, async () => {
    // ping 类方法应接受缺省死线：服务端慢 300ms 仍成功。
    const server = makeServer((line, _socket, write) => {
      const req = JSON.parse(line)
      assert.equal(req.params.timeout_ms, 30000)
      setTimeout(() => write(JSON.stringify({ id: req.id, result: { type: 'agent_started', agent: {} } })), 300)
    })
    socketPath = await listen(server)
    const transport = createHerdrTransport()
    const result = await withTimeout(
      transport.call({ socketPath }, 'agent.start', { name: 'helm-wf-1', kind: 'agy', pane_id: 'w1:p1', timeout_ms: 30000 }),
      5000,
    )
    assert.equal((result as Record<string, unknown>)['type'], 'agent_started')
    await close(server)
  })

  it('call 完成后销毁连接（一连接一请求）', { timeout: 60_000 }, async () => {
    let connections = 0
    let closed = 0
    const server = createServer((socket) => {
      connections += 1
      socket.on('close', () => {
        closed += 1
      })
      socket.on('data', (chunk) => {
        const req = JSON.parse(chunk.toString('utf8').trim())
        socket.end(`${JSON.stringify({ id: req.id, result: { type: 'pong', version: 'x' } })}\n`)
      })
    })
    socketPath = await listen(server)
    const transport = createHerdrTransport()
    await transport.call({ socketPath }, 'ping', {})
    await transport.call({ socketPath }, 'ping', {})
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(connections, 2)
    assert.equal(closed, 2)
    await close(server)
  })

  it('target.socketPath 覆盖继承的 HERDR_SOCKET_PATH（禁止 env -u 凑绿）', { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'herdr-prio-'))
    const explicitSocket = join(dir, 'explicit.sock')
    const envSocket = join(dir, 'env.sock')
    const seen: string[] = []
    const server = createServer((socket) => {
      socket.on('data', (chunk) => {
        const req = JSON.parse(chunk.toString('utf8').trim())
        seen.push(req.method)
        socket.end(`${JSON.stringify({ id: req.id, result: { type: 'pong', via: 'explicit' } })}\n`)
      })
    })
    await new Promise<void>((resolve) => server.listen(explicitSocket, resolve))
    process.env.HERDR_SOCKET_PATH = envSocket // 故意指向不存在的路径
    try {
      const transport = createHerdrTransport({ subscribeAckTimeoutMs: 250 })
      const result = (await transport.call({ socketPath: explicitSocket }, 'ping', {})) as Record<string, unknown>
      assert.equal(result['via'], 'explicit')
      assert.deepEqual(seen, ['ping'])
    } finally {
      delete process.env.HERDR_SOCKET_PATH
      await rm(dir, { recursive: true, force: true })
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('缺 result 与 error 的响应显式失败', { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'herdr-call-bad-'))
    const path = join(dir, 's.sock')
    const server = createServer((socket) => {
      socket.on('data', (chunk) => {
        const req = JSON.parse(chunk.toString('utf8').trim())
        socket.end(`${JSON.stringify({ id: req.id })}\n`) // 只有 id
      })
    })
    await new Promise<void>((resolve) => server.listen(path, resolve))
    const transport = createHerdrTransport({ subscribeAckTimeoutMs: 250 })
    await assert.rejects(
      transport.call({ socketPath: path }, 'ping', {}),
      (err: unknown) => err instanceof HerdrTransportError && err.code === 'herdr_protocol',
    )
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('响应 id 不匹配显式失败', { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'herdr-call-id-'))
    const path = join(dir, 's.sock')
    const server = createServer((socket) => {
      socket.on('data', () => {
        socket.end(`${JSON.stringify({ id: 'other', result: { type: 'pong' } })}\n`)
      })
    })
    await new Promise<void>((resolve) => server.listen(path, resolve))
    const transport = createHerdrTransport({ subscribeAckTimeoutMs: 250 })
    await assert.rejects(
      transport.call({ socketPath: path }, 'ping', {}),
      (err: unknown) => err instanceof HerdrTransportError && err.code === 'herdr_protocol',
    )
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  for (const remote of [false, true]) {
    it(`${remote ? '远端节点' : '本机'}RPC 拒绝没有关联 id 的响应`, { timeout: 60_000 }, async (t) => {
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
})

describe('herdr transport subscribe', () => {
  let socketDir: string
  let socketPath: string
  let counter = 0

  before(async () => {
    socketDir = await mkdtemp(join(tmpdir(), 'herdr-subscribe-'))
  })

  after(async () => {
    await rm(socketDir, { recursive: true, force: true })
  })

  async function listen(server: Server): Promise<string> {
    counter += 1
    const path = join(socketDir, `herdr-${counter}.sock`)
    await new Promise<void>((resolve) => server.listen(path, resolve))
    return path
  }

  async function close(server: Server): Promise<void> {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  it('先 ack 后事件帧，规范化窗格与关闭拓扑事件', { timeout: 60_000 }, async () => {
    let client: Socket | undefined
    const received: { type: string; paneId?: string; tabId?: string; workspaceId?: string }[] = []
    const server = makeServer((line, socket) => {
      const req = JSON.parse(line)
      assert.equal(req.method, 'events.subscribe')
      const types = (req.params.subscriptions as { type: string }[]).map((s) => s.type)
      assert.deepEqual(types, [
        'pane.created',
        'pane.updated',
        'pane.closed',
        'pane.exited',
        'pane.focused',
        'pane.moved',
        'tab.closed',
        'workspace.closed',
      ])
      client = socket
      socket.write(`${JSON.stringify({ id: req.id, result: { type: 'subscription_started' } })}\n`)
    })
    socketPath = await listen(server)
    const transport = createHerdrTransport()
    const errors: unknown[] = []
    const stop = await withTimeout(
      transport.subscribe(
        { socketPath },
        (event) => received.push(event),
        (err) => errors.push(err),
      ),
    )
    assert.equal(received.length, 0)
    client!.write(`${JSON.stringify({ event: 'pane_updated', data: { pane: { pane_id: 'w1:p3' } } })}\n`)
    client!.write(`${JSON.stringify({ event: 'pane_closed', data: { pane_id: 'w2:p1' } })}\n`)
    client!.write(`${JSON.stringify({ event: 'tab.focused', data: { tab_id: 'w1:t1' } })}\n`)
    client!.write(`${JSON.stringify({ event: 'pane_created', data: { pane: { pane_id: 'w1:p4' } } })}\n`)
    client!.write(`${JSON.stringify({ event: 'pane_exited', data: { pane_id: 'w1:p4' } })}\n`)
    client!.write(`${JSON.stringify({ event: 'pane_focused', data: { pane_id: 'w1:p3', workspace_id: 'w1' } })}\n`)
    client!.write(`${JSON.stringify({ event: 'pane_moved', data: { previous_pane_id: 'w1:p3', previous_workspace_id: 'w1', previous_tab_id: 'w1:t1', pane: { pane_id: 'w2:p9', workspace_id: 'w2', tab_id: 'w2:t2' } } })}\n`)
    client!.write(`${JSON.stringify({ event: 'tab_closed', data: { tab_id: 'w2:t2', workspace_id: 'w2' } })}\n`)
    client!.write(`${JSON.stringify({ event: 'workspace_closed', data: { workspace_id: 'w2' } })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.deepEqual(received.map((e) => [e.type, e.paneId]), [
      ['pane.updated', 'w1:p3'],
      ['pane.closed', 'w2:p1'],
      ['pane.created', 'w1:p4'],
      ['pane.exited', 'w1:p4'],
      ['pane.focused', 'w1:p3'],
      // moved 取新 pane ID；旧 ID 由总览快照重取对齐。
      ['pane.moved', 'w2:p9'],
      ['tab.closed', undefined],
      ['workspace.closed', undefined],
    ])
    assert.equal(received.at(-2)?.tabId, 'w2:t2')
    assert.equal(received.at(-1)?.workspaceId, 'w2')
    assert.equal(errors.length, 0)
    stop()
    await close(server)
  })

  it('ack 与事件同 chunk 到达时全部处理，不丢事件', { timeout: 60_000 }, async () => {
    const server = makeServer((line, socket) => {
      const request = JSON.parse(line) as { id: string; method: string }
      assert.equal(request.method, 'events.subscribe')
      const ack = JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })
      const e1 = JSON.stringify({ event: 'pane_updated', data: { pane_id: 'w1:p2' } })
      const e2 = JSON.stringify({ event: 'pane_closed', data: { pane_id: 'w1:p3' } })
      // 三帧合并成一个 chunk 写出
      socket.write(`${ack}\n${e1}\n${e2}\n`)
    })
    socketPath = await listen(server)
    const transport = createHerdrTransport({ subscribeAckTimeoutMs: 250 })
    const events: { type: string; paneId?: string }[] = []
    const stop = await transport.subscribe({ socketPath }, (event) => events.push(event), () => assert.fail('不应有错误'))
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.deepEqual(events.map((e) => [e.type, e.paneId]), [
      ['pane.updated', 'w1:p2'],
      ['pane.closed', 'w1:p3'],
    ])
    stop()
    await close(server)
  })

  it('坏 JSON 帧显式报错且只报一次', { timeout: 60_000 }, async () => {
    const server = makeServer((line, socket) => {
      const request = JSON.parse(line) as { id: string }
      socket.write(`${JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })}\n`)
      socket.write('{"event": "pane_updated", "data": \n') // 坏 JSON
      socket.write('同样一行坏 JSON\n')
    })
    socketPath = await listen(server)
    const transport = createHerdrTransport({ subscribeAckTimeoutMs: 250 })
    const errors: unknown[] = []
    const stop = await transport.subscribe({ socketPath }, () => {}, (err) => errors.push(err))
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(errors.length, 1)
    assert.ok(errors[0] instanceof HerdrTransportError)
    stop()
    await close(server)
  })

  it('事件帧缺 pane 身份显式报错并停止', { timeout: 60_000 }, async () => {
    const server = makeServer((line, socket) => {
      const request = JSON.parse(line) as { id: string }
      socket.write(`${JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })}\n`)
      socket.write(`${JSON.stringify({ event: 'pane_updated', data: { pane: {} } })}\n`)
    })
    socketPath = await listen(server)
    const transport = createHerdrTransport({ subscribeAckTimeoutMs: 250 })
    const errors: unknown[] = []
    const stop = await transport.subscribe({ socketPath }, () => {}, (err) => errors.push(err))
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(errors.length, 1)
    assert.ok(errors[0] instanceof HerdrTransportError && errors[0].code === 'herdr_protocol')
    stop()
    await close(server)
  })

  it('服务端永不 ack 时在期限内显式失败，不永久挂起', { timeout: 60_000 }, async () => {
    const server = makeServer(() => {
      /* 静默 */
    })
    socketPath = await listen(server)
    const transport = createHerdrTransport({ subscribeAckTimeoutMs: 250 })
    await assert.rejects(
      transport.subscribe({ socketPath }, () => {}, () => {}),
      (err: unknown) => err instanceof HerdrTransportError && err.code === 'herdr_timeout',
    )
    await close(server)
    // ack promise 已被 race 拒绝终结；短暂等待确认无二次上报即可。
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  it('stop() 主动关闭不误报错误', { timeout: 60_000 }, async () => {
    const server = makeServer((line, socket) => {
      const request = JSON.parse(line) as { id: string }
      socket.write(`${JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })}\n`)
    })
    socketPath = await listen(server)
    const transport = createHerdrTransport({ subscribeAckTimeoutMs: 250 })
    const errors: unknown[] = []
    const stop = await transport.subscribe({ socketPath }, () => {}, (err) => errors.push(err))
    stop()
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(errors.length, 0)
    await close(server)
  })

  it('订阅 ack 必须携带本次请求 id', { timeout: 60_000 }, async (t) => {
    const root = await tempRoot(t)
    const path = await localSocketServer(t, root, (_request, socket) => {
      socket.write(`${JSON.stringify({ id: 'wrong-subscription', result: { type: 'subscription_started' } })}\n`)
    })
    await assert.rejects(async () => {
      const stop = await createHerdrTransport().subscribe({ socketPath: path }, () => {}, () => {})
      stop()
    }, { code: 'herdr_protocol' })
  })

  it('ack 前服务端报错则 subscribe 显式失败', { timeout: 60_000 }, async () => {
    const server = makeServer((line, _socket, write) => {
      const req = JSON.parse(line)
      write(JSON.stringify({ id: req.id, error: { code: 'invalid_request', message: 'bad subscription' } }))
    })
    socketPath = await listen(server)
    const transport = createHerdrTransport()
    try {
      await withTimeout(transport.subscribe({ socketPath }, () => {}, () => {}))
      assert.fail('subscribe should reject on pre-ack error')
    } catch (err) {
      assert.ok(err instanceof HerdrTransportError)
      assert.equal(err.code, 'invalid_request')
    }
    await close(server)
  })

  it('ack 后断线必须上报 onError，不静默', { timeout: 60_000 }, async () => {
    let client: Socket | undefined
    const server = makeServer((line, socket) => {
      client = socket
      // 收到订阅请求即回 ack，后续由测试主动断线
      const req = JSON.parse(line)
      socket.write(`${JSON.stringify({ id: req.id, result: { type: 'subscription_started' } })}\n`)
    })
    socketPath = await listen(server)
    const transport = createHerdrTransport()
    const errors: unknown[] = []
    const stop = await withTimeout(transport.subscribe({ socketPath }, () => {}, (err) => errors.push(err)))
    assert.ok(client, 'server should hold the client socket')
    client!.destroy()
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(errors.length, 1)
    assert.ok(errors[0] instanceof HerdrTransportError)
    assert.equal((errors[0] as HerdrTransportError).code, 'herdr_disconnected')
    stop()
    await close(server)
  })

  it('远端 subscribe 在通道不支持事件流时显式拒绝，不静默降级', { timeout: 60_000 }, async () => {
    const transport = createHerdrTransport({ nodeChannel: new MutableNodeChannel() })
    await assert.rejects(
      transport.subscribe({ nodeId: 'build-box' }, () => {}, () => {}),
      (err: unknown) => err instanceof HerdrTransportError && (err.code === 'herdr_subscribe_unsupported' || err.code === 'herdr_node_offline'),
    )
  })

  it('paneIds 追加逐窗格状态过滤订阅且去重，status_changed 从 data.pane_id 规范化', { timeout: 60_000 }, async () => {
    let client: Socket | undefined
    const received: { type: string; paneId?: string }[] = []
    const server = makeServer((line, socket) => {
      const req = JSON.parse(line)
      assert.equal(req.method, 'events.subscribe')
      // 精确断言：八类全局 + 两个独立窗格的状态过滤（重复 w1:p1 已去重）。
      assert.deepEqual(req.params.subscriptions, [
        { type: 'pane.created' },
        { type: 'pane.updated' },
        { type: 'pane.closed' },
        { type: 'pane.exited' },
        { type: 'pane.focused' },
        { type: 'pane.moved' },
        { type: 'tab.closed' },
        { type: 'workspace.closed' },
        { type: 'pane.agent_status_changed', pane_id: 'w1:p1' },
        { type: 'pane.agent_status_changed', pane_id: 'w2:p2' },
      ])
      client = socket
      socket.write(`${JSON.stringify({ id: req.id, result: { type: 'subscription_started' } })}\n`)
    })
    socketPath = await listen(server)
    const transport = createHerdrTransport()
    const errors: unknown[] = []
    const stop = await withTimeout(
      transport.subscribe(
        { socketPath },
        (event) => received.push(event),
        (err) => errors.push(err),
        { paneIds: ['w1:p1', 'w2:p2', 'w1:p1'] },
      ),
    )
    // 官方 PaneAgentStatusChangedEvent 形状：pane_id/agent_status 在 data 顶层。
    client!.write(`${JSON.stringify({ event: 'pane.agent_status_changed', data: { pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'blocked' } })}\n`)
    client!.write(`${JSON.stringify({ event: 'pane.agent_status_changed', data: { pane_id: 'w2:p2', workspace_id: 'w2', agent_status: 'done', agent: 'pi' } })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.deepEqual(received.map((e) => [e.type, e.paneId]), [
      ['pane.agent_status_changed', 'w1:p1'],
      ['pane.agent_status_changed', 'w2:p2'],
    ])
    assert.equal(errors.length, 0)
    stop()
    await close(server)
  })

  it('不传 paneIds 时仅订阅八类全局事件', { timeout: 60_000 }, async () => {
    const server = makeServer((line, _socket, write) => {
      const req = JSON.parse(line)
      const types = (req.params.subscriptions as { type: string }[]).map((s) => s.type)
      assert.ok(!types.includes('pane.agent_status_changed'))
      assert.equal(types.length, 8)
      write(JSON.stringify({ id: req.id, result: { type: 'subscription_started' } }))
    })
    socketPath = await listen(server)
    const transport = createHerdrTransport()
    const stop = await withTimeout(transport.subscribe({ socketPath }, () => {}, () => {}))
    stop()
    await close(server)
  })

  it('已 abort 的 signal 直接拒绝且不连 socket', { timeout: 60_000 }, async () => {
    const server = makeServer(() => {
      assert.fail('server must not receive any connection for pre-aborted signal')
    })
    socketPath = await listen(server)
    const transport = createHerdrTransport()
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      transport.subscribe({ socketPath }, () => {}, () => {}, { signal: controller.signal }),
      (err: unknown) => err instanceof HerdrTransportError && err.code === 'herdr_aborted',
    )
    await close(server)
  })

  it('ack 前 abort：Promise 立即结束且 socket 关闭', { timeout: 60_000 }, async () => {
    let serverClosed = false
    const server = makeServer((line, socket) => {
      // 收到订阅请求但永不 ack；等客户端 abort 后应观察到连接关闭。
      const _req = JSON.parse(line)
      socket.on('close', () => {
        serverClosed = true
      })
    })
    socketPath = await listen(server)
    const transport = createHerdrTransport()
    const controller = new AbortController()
    const errors: unknown[] = []
    setTimeout(() => controller.abort(), 80)
    await assert.rejects(
      withTimeout(transport.subscribe({ socketPath }, () => {}, (err) => errors.push(err), { signal: controller.signal })),
      (err: unknown) => err instanceof HerdrTransportError && err.code === 'herdr_aborted',
    )
    // abort 主动销毁本方 socket：服务端必观察到关闭，且不产生额外 onError。
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(serverClosed, true)
    assert.equal(errors.length, 0)
    await close(server)
  })

  it('ack 后 abort 与正常退订：释放连接且不误报 onError', { timeout: 60_000 }, async () => {
    let serverClosed = false
    const server = makeServer((line, socket) => {
      const req = JSON.parse(line)
      socket.on('close', () => {
        serverClosed = true
      })
      socket.write(`${JSON.stringify({ id: req.id, result: { type: 'subscription_started' } })}\n`)
    })
    socketPath = await listen(server)
    const transport = createHerdrTransport()
    // 第一段：ack 后 abort —— 静默关闭，不报错。
    const controller = new AbortController()
    const errors: unknown[] = []
    const stop1 = await withTimeout(
      transport.subscribe({ socketPath }, () => {}, (err) => errors.push(err), {
        paneIds: ['w1:p1'],
        signal: controller.signal,
      }),
    )
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(errors.length, 0, 'abort after ack must not raise onError')
    stop1() // 幂等
    // 第二段：无 signal 正常退订同样不报错。
    const stop2 = await withTimeout(transport.subscribe({ socketPath }, () => {}, (err) => errors.push(err), { paneIds: ['w1:p1'] }))
    stop2()
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(errors.length, 0)
    await close(server)
  })
})

describe('herdr transport output files', () => {
  let workDir: string

  before(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'herdr-files-'))
    await mkdir(join(workDir, '.helm'), { recursive: true })
  })

  after(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  it('readOutput 只允许 .helm/wf-out-*.json|md', { timeout: 60_000 }, async () => {
    await writeFile(join(workDir, '.helm', 'wf-out-agent1.json'), '{"ok":true}', 'utf8')
    const transport = createHerdrTransport()
    const content = await withTimeout(transport.readOutput({}, workDir, 'wf-out-agent1.json'))
    assert.equal(content, '{"ok":true}')
    await assert.rejects(
      transport.readOutput({}, workDir, '../secret.txt'),
      (err: unknown) => err instanceof HerdrTransportError && err.code === 'herdr_invalid_output_name',
    )
    await assert.rejects(
      transport.readOutput({}, workDir, 'wf-out-agent1.txt'),
      (err: unknown) => err instanceof HerdrTransportError && err.code === 'herdr_invalid_output_name',
    )
  })

  it('readOutput 拒绝软链与缺失文件', { timeout: 60_000 }, async () => {
    const outside = join(workDir, 'outside.json')
    await writeFile(outside, '{}', 'utf8')
    await symlink(outside, join(workDir, '.helm', 'wf-out-link.json'))
    const transport = createHerdrTransport()
    await assert.rejects(
      transport.readOutput({}, workDir, 'wf-out-link.json'),
      (err: unknown) => err instanceof HerdrTransportError && err.code === 'herdr_output_not_file',
    )
    await assert.rejects(
      transport.readOutput({}, workDir, 'wf-out-missing.json'),
      (err: unknown) => err instanceof HelmError && err.code === 'herdr_output_missing' && err.status === 404,
    )
  })

  it('removeOutput 对 ENOENT 幂等，对软链拒绝', { timeout: 60_000 }, async () => {
    const transport = createHerdrTransport()
    await transport.removeOutput({}, workDir, 'wf-out-never-existed.md')
    await writeFile(join(workDir, '.helm', 'wf-out-gone.md'), 'x', 'utf8')
    await transport.removeOutput({}, workDir, 'wf-out-gone.md')
    await assert.rejects(
      transport.readOutput({}, workDir, 'wf-out-gone.md'),
      (err: unknown) => err instanceof HelmError && err.code === 'herdr_output_missing',
    )
    const outside = join(workDir, 'outside2.md')
    await writeFile(outside, 'x', 'utf8')
    await symlink(outside, join(workDir, '.helm', 'wf-out-link2.md'))
    await assert.rejects(
      transport.removeOutput({}, workDir, 'wf-out-link2.md'),
      (err: unknown) => err instanceof HerdrTransportError && err.code === 'herdr_output_not_file',
    )
  })

  it('.helm 为软链时读写均拒绝', { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'herdr-escape-'))
    const cwd = join(root, 'task')
    const outside = join(root, 'outside')
    await mkdir(cwd)
    await mkdir(outside)
    await writeFile(join(outside, 'wf-out-parent.json'), '{"private":true}')
    await symlink(outside, join(cwd, '.helm'))
    const transport = createHerdrTransport({ subscribeAckTimeoutMs: 250 })
    await assert.rejects(transport.readOutput({}, cwd, 'wf-out-parent.json'), (err: unknown) => err instanceof HerdrTransportError && (err.code === 'herdr_output_escaping' || err.code === 'herdr_output_not_file'))
    await assert.rejects(transport.removeOutput({}, cwd, 'wf-out-parent.json'), (err: unknown) => err instanceof HerdrTransportError && (err.code === 'herdr_output_escaping' || err.code === 'herdr_output_not_file'))
    assert.equal(await readFile(join(outside, 'wf-out-parent.json'), 'utf8'), '{"private":true}')
    await rm(root, { recursive: true, force: true })
  })

  for (const remote of [false, true]) {
    it(`${remote ? '远端节点' : '本机'}缺少 .helm 目录时读取为缺文件，删除保持幂等`, { timeout: 60_000 }, async (t) => {
      const root = await tempRoot(t)
      const { transport, target } = remote
        ? await channelFixture(t, () => {})
        : { transport: createHerdrTransport(), target: {} as { nodeId?: string; socketPath?: string } }
      const finalTarget = remote ? target : {}
      await assert.rejects(transport.readOutput(finalTarget, root, 'wf-out-missing.md'), { code: 'herdr_output_missing' })
      await transport.removeOutput(finalTarget, root, 'wf-out-missing.md')
    })
  }
})

describe('herdr transport local gate', () => {
  it('本机 transport Gate 在传入的 cwd 实际执行', { timeout: 60_000 }, async (t) => {
    const root = await tempRoot(t)
    const result = await createHerdrTransport().runGate({}, 'pwd', root)
    assert.deepEqual(result, { ok: true, output: `${root}\n` })
  })

  it('exit 非零 ok=false 且保留输出', { timeout: 60_000 }, async () => {
    const transport = createHerdrTransport()
    const result = await withTimeout(transport.runGate({}, 'echo boom >&2; exit 3', process.cwd()))
    assert.equal(result.ok, false)
    assert.ok(result.output.includes('boom'))
  })

  it('env 经第 5 参数注入且不继承宿主环境', { timeout: 60_000 }, async () => {
    const transport = createHerdrTransport()
    const result = await withTimeout(
      transport.runGate({}, 'test "$GATE_SECRET" = "g-123" && test -z "$HOME" && echo clean', process.cwd(), undefined, { GATE_SECRET: 'g-123' }),
    )
    assert.ok(result.ok, result.output)
    assert.ok(result.output.includes('clean'))
  })

  it('abort 终止 gate', { timeout: 60_000 }, async () => {
    const transport = createHerdrTransport()
    const controller = new AbortController()
    const pending = transport.runGate({}, 'sleep 30', process.cwd(), controller.signal)
    const timer = setTimeout(() => controller.abort(), 80)
    try {
      await assert.rejects(withTimeout(pending), { code: 'herdr_aborted' })
    } finally {
      clearTimeout(timer)
    }
  })

  it('超限输出 ok=false 且明确报限额', { timeout: 60_000 }, async () => {
    const transport = createHerdrTransport({ subscribeAckTimeoutMs: 250 })
    // 1MiB+ 输出：限额内成功保留完整；超出则显式失败。此处生成 1.1MiB。
    const result = await transport.runGate({}, 'head -c 1150000 /dev/zero | tr "\\0" "x"', process.cwd())
    if (result.ok) {
      assert.ok(result.output.length > 1_000_000, '限额内输出必须完整保留')
    } else {
      assert.ok(result.output.includes('exceeded'), '超限必须明确说明而非截断')
    }
  })

  it('Gate 主进程已退出时 abort 仍清理持有管道的自有子进程', { timeout: 60_000 }, async (t) => {
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
})

describe('herdr transport remote (node channel)', () => {
  it('nodeId 与 session 校验拒绝注入', { timeout: 60_000 }, () => {
    // 新契约：单一安全 token /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/（含 'local'）。
    // 旧 SSH 机器名形态（user@host、IPv6）不再是合法节点 ID。
    for (const nodeId of ['build-box', 'local', 'work_host', 'node-1.sub', 'macbook_pro.2', 'a'.repeat(128)]) {
      assert.equal(isValidNodeId(nodeId), true, `合法节点：${nodeId}`)
    }
    for (const nodeId of ['', 'root@10.0.0.3', 'user@work_host', '2001:db8::1', '[2001:db8::1]', 'a'.repeat(129), '-oProxyCommand=evil', '-oProxyCommand=bad', 'user@host;bad', 'a b', 'x\ny']) {
      assert.equal(isValidNodeId(nodeId), false, `非法节点：${JSON.stringify(nodeId)}`)
    }
    assert.equal(isValidSessionName('helm-wf-1'), true)
    assert.equal(isValidSessionName('../escape'), false)
  })

  it('远端节点未注入通道时显式报 herdr_node_offline，绝不静默回退本机', { timeout: 60_000 }, async () => {
    const offlineChannel = new MutableNodeChannel() // 无任何注册节点
    const transport = createHerdrTransport({ nodeChannel: offlineChannel })
    await assert.rejects(
      transport.call({ nodeId: 'build-box' }, 'ping', {}),
      (err: unknown) => err instanceof HerdrTransportError && err.code === 'herdr_node_offline',
    )
  })

  it('call 经节点通道完成 NDJSON 往返且机密只在 JSON 结构内', { timeout: 60_000 }, async (t) => {
    const fixture = await nodeFixture(t, (request, socket) => {
      const req = request as { id: string; method: string; params: { env?: Record<string, string> } }
      assert.equal(req.id, 'helm-remote-1')
      assert.equal(req.method, 'tab.create')
      assert.equal(req.params.env?.['HELM_TOKEN'], secret())
      socket.end(`${JSON.stringify({ id: req.id, result: { type: 'tab_created', tab: { tab_id: 'w1:t2' } } })}\n`)
    })
    const channel = new MutableNodeChannel()
    channel.nodes.set('build-box', { online: true, channel: fixture.channel })
    const transport = createHerdrTransport({ nodeChannel: channel })
    const result = (await withTimeout(
      transport.call({ nodeId: 'build-box', socketPath: fixture.socketPath }, 'tab.create', { env: { HELM_TOKEN: secret() } }),
    )) as Record<string, unknown>
    assert.equal(result['type'], 'tab_created')
    // 机密只在 JSON 结构内部传输；socketPath 等经通道入参传递，绝不进入任何 argv。
    assert.equal((fixture.requests[0]?.params.env as Record<string, string> | undefined)?.['HELM_TOKEN'], secret())
  })

  it('无限期 agent.wait 在对端保持半开且不响应时也能被 abort 立即终止', { timeout: 60_000 }, async (t) => {
    const _root = await tempRoot(t)
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
})
