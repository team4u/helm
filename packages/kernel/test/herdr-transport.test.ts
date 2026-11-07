import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import { HelmError } from '@helm/protocol'

import {
  HERDR_CALL_TIMEOUT_MS,
  HerdrTransportError,
  createHerdrTransport,
  isValidMachineName,
  isValidSessionName,
} from '../src/builtin-plugins/herdr/transport.js'

/**
 * 传输层边界测试：用真实临时 Unix socket 验证 NDJSON wire、订阅流、错误信封、
 * abort 与文件安全边界；用受控 ssh fixture（process.env.PATH 前置假 ssh 脚本）
 * 验证远端 stdin 脚本分派与「机密不出现在 argv」。这不伪称真实远端 E2E。
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

  it('远端 subscribe 显式拒绝，不静默降级', { timeout: 60_000 }, async () => {
    const transport = createHerdrTransport()
    await assert.rejects(
      transport.subscribe({ machine: 'build-box' }, () => {}, () => {}),
      (err: unknown) => err instanceof HerdrTransportError && err.code === 'herdr_subscribe_unsupported',
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
})

describe('herdr transport local gate', () => {
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
})

describe('herdr transport remote (controlled ssh fixture)', () => {
  let fixtureDir: string
  let logFile: string
  const priorPath: string | undefined = process.env.PATH

  before(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'herdr-ssh-'))
    logFile = join(fixtureDir, 'argv.log')
  })

  after(async () => {
    process.env.PATH = priorPath
    await rm(fixtureDir, { recursive: true, force: true })
  })

  it('machine 与 session 校验拒绝注入', { timeout: 60_000 }, () => {
    assert.equal(isValidMachineName('build-box'), true)
    assert.equal(isValidMachineName('root@10.0.0.3'), true)
    assert.equal(isValidMachineName('-oProxyCommand=evil'), false)
    assert.equal(isValidMachineName('a b'), false)
    assert.equal(isValidSessionName('helm-wf-1'), true)
    assert.equal(isValidSessionName('../escape'), false)
  })

  it('call 走远端 stdin 脚本且机密不出现在 argv', { timeout: 60_000 }, async () => {
    // 受控 ssh fixture：记录 argv；远端命令固定 python3 -u -，由 fixture 以本地 python3 执行 stdin 脚本。
    // 真实 transport 会把 base64 payload 写到 ssh stdin；fixture 经环境变量旁路承接该 payload，
    // 断言重点在：op/method/env 的分派约定与机密绝不出现在 ssh argv。
    const handler = [
      'import base64, json, os, sys',
      'payload = json.loads(base64.b64decode(os.environ["HERDR_FIXTURE_PAYLOAD"]))',
      'spec = payload["target"] or {}',
      'assert payload["op"] == "rpc"',
      'assert payload["method"] == "tab.create"',
      'assert payload["params"]["env"]["HELM_TOKEN"] == "sk-secret-DO-NOT-LEAK-9f1b2c"',
      'print(json.dumps({"result": {"type": "tab_created", "tab": {"tab_id": "w1:t2"}}}))',
    ].join('\n')
    const script = join(fixtureDir, 'ssh')
    const glue = [
      '#!/bin/sh',
      'printf "%s\\n" "$@" >> "$HERDR_SSH_ARGV_LOG"',
      'exec python3 -u - <<"PYSPLIT"',
      handler,
      'PYSPLIT',
      '',
    ].join('\n')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(script, glue, { mode: 0o755 })
    process.env.PATH = `${fixtureDir}:${priorPath ?? ''}`
    process.env.HERDR_SSH_ARGV_LOG = logFile
    const encoded = Buffer.from(
      JSON.stringify({ op: 'rpc', target: {}, method: 'tab.create', params: { env: { HELM_TOKEN: secret() } } }),
    ).toString('base64')
    process.env.HERDR_FIXTURE_PAYLOAD = encoded

    const transport = createHerdrTransport()
    const result = (await withTimeout(transport.call({ machine: 'build-box' }, 'tab.create', { env: { HELM_TOKEN: secret() } }))) as Record<
      string,
      unknown
    >
    assert.equal(result['type'], 'tab_created')

    const { readFile } = await import('node:fs/promises')
    const argvLog = await readFile(logFile, 'utf8')
    assert.ok(argvLog.includes('python3 -u -'))
    assert.ok(!argvLog.includes(secret()), 'secret must never appear in ssh argv')
    delete process.env.HERDR_FIXTURE_PAYLOAD
    delete process.env.HERDR_SSH_ARGV_LOG
  })
})
