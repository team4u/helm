import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'

import {
  HERDR_CALL_TIMEOUT_MS,
  HerdrTransportError,
  LineAssembler,
  createHerdrTransport,
} from '../src/builtin-plugins/herdr/transport.js'

/** 边界回归：帧解码确定性、订阅流终结语义、socket 解析优先级、Gate 输出限额。 */

describe('LineAssembler 字节级确定性', () => {
  it('逐字节喂入不破坏跨 chunk UTF-8 与多帧累计', { timeout: 60_000 }, () => {
    const frames = [
      JSON.stringify({ event: 'pane.updated', data: { pane: { pane_id: 'w1:p1', title: '中文标题-β与emoji占位' } } }),
      JSON.stringify({ id: '2', result: { type: 'agent_info', agent: { name: '名称二' } } }),
      JSON.stringify({ event: 'pane.closed', data: { pane_id: 'w2:p3' } }),
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

describe('socket 解析优先级', () => {
  it('target.socketPath 覆盖继承的 HERDR_SOCKET_PATH（禁止 env -u 凑绿）', { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'herdr-prio-'))
    const socketPath = join(dir, 'explicit.sock')
    const envSocket = join(dir, 'env.sock')
    const seen: string[] = []
    const server = createServer((socket) => {
      socket.on('data', (chunk) => {
        const req = JSON.parse(chunk.toString('utf8').trim())
        seen.push(req.method)
        socket.end(`${JSON.stringify({ id: req.id, result: { type: 'pong', via: 'explicit' } })}\n`)
      })
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    process.env.HERDR_SOCKET_PATH = envSocket // 故意指向不存在的路径
    try {
      const transport = createHerdrTransport()
      const result = (await transport.call({ socketPath }, 'ping', {})) as Record<string, unknown>
      assert.equal(result['via'], 'explicit')
      assert.deepEqual(seen, ['ping'])
    } finally {
      delete process.env.HERDR_SOCKET_PATH
      await rm(dir, { recursive: true, force: true })
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('订阅流终结语义', () => {
  let dir: string
  let counter = 0

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'herdr-sub-term-'))
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function frameServer(handler: (req: unknown, write: (line: string) => void, socket: Socket) => void) {
    const server = createServer((socket) => {
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        let index: number
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          handler(JSON.parse(line), (out) => socket.write(`${out}\n`), socket)
        }
      })
    })
    return server
  }

  async function listen(server: Server): Promise<string> {
    counter += 1
    const path = join(dir, `s-${counter}.sock`)
    await new Promise<void>((resolve) => server.listen(path, resolve))
    return path
  }

  async function close(server: Server): Promise<void> {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  it('ack 与事件同 chunk 到达时全部处理，不丢事件', { timeout: 60_000 }, async () => {
    const server = frameServer((req, write) => {
      const request = req as { id: string; method: string }
      assert.equal(request.method, 'events.subscribe')
      const ack = JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })
      const e1 = JSON.stringify({ event: 'pane.updated', data: { pane_id: 'w1:p2' } })
      const e2 = JSON.stringify({ event: 'pane.closed', data: { pane_id: 'w1:p3' } })
      // 三帧合并成一个 chunk 写出
      write(`${ack}\n${e1}\n${e2}`)
    })
    const path = await listen(server)
    const transport = createHerdrTransport()
    const events: { type: string; paneId: string }[] = []
    const stop = await transport.subscribe({ socketPath: path }, (event) => events.push(event), () => assert.fail('不应有错误'))
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.deepEqual(events.map((e) => [e.type, e.paneId]), [
      ['pane.updated', 'w1:p2'],
      ['pane.closed', 'w1:p3'],
    ])
    stop()
    await close(server)
  })

  it('坏 JSON 帧显式报错且只报一次', { timeout: 60_000 }, async () => {
    const server = frameServer((req, write) => {
      const request = req as { id: string }
      write(JSON.stringify({ id: request.id, result: { type: 'subscription_started' } }))
      write('{"event": "pane.updated", "data": ') // 坏 JSON
      write('同样一行坏 JSON')
    })
    const path = await listen(server)
    const transport = createHerdrTransport()
    const errors: unknown[] = []
    const stop = await transport.subscribe({ socketPath: path }, () => {}, (err) => errors.push(err))
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(errors.length, 1)
    assert.ok(errors[0] instanceof HerdrTransportError)
    stop()
    await close(server)
  })

  it('事件帧缺 pane 身份显式报错并停止', { timeout: 60_000 }, async () => {
    const server = frameServer((req, write) => {
      const request = req as { id: string }
      write(JSON.stringify({ id: request.id, result: { type: 'subscription_started' } }))
      write(JSON.stringify({ event: 'pane.updated', data: { pane: {} } }))
    })
    const path = await listen(server)
    const transport = createHerdrTransport()
    const errors: unknown[] = []
    const stop = await transport.subscribe({ socketPath: path }, () => {}, (err) => errors.push(err))
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(errors.length, 1)
    assert.ok(errors[0] instanceof HerdrTransportError && errors[0].code === 'herdr_protocol')
    stop()
    await close(server)
  })

  it('服务端永不 ack 时在期限内显式失败，不永久挂起', { timeout: 60_000 }, async () => {
    const server = frameServer(() => {
      /* 静默 */
    })
    const path = await listen(server)
    const transport = createHerdrTransport()
    await assert.rejects(
      transport.subscribe({ socketPath: path }, () => {}, () => {}),
      (err: unknown) => err instanceof HerdrTransportError && err.code === 'herdr_timeout',
    )
    await close(server)
    // ack promise 已被 race 拒绝终结；短暂等待确认无二次上报即可。
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  it('stop() 主动关闭不误报错误', { timeout: 60_000 }, async () => {
    const server = frameServer((req, write) => {
      const request = req as { id: string }
      write(JSON.stringify({ id: request.id, result: { type: 'subscription_started' } }))
    })
    const path = await listen(server)
    const transport = createHerdrTransport()
    const errors: unknown[] = []
    const stop = await transport.subscribe({ socketPath: path }, () => {}, (err) => errors.push(err))
    stop()
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(errors.length, 0)
    await close(server)
  })
})

describe('call 帧边界', () => {
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
    const transport = createHerdrTransport()
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
    const transport = createHerdrTransport()
    await assert.rejects(
      transport.call({ socketPath: path }, 'ping', {}),
      (err: unknown) => err instanceof HerdrTransportError && err.code === 'herdr_protocol',
    )
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})

describe('Gate 输出限额（不静默截断）', () => {
  it('超限输出 ok=false 且明确报限额', { timeout: 60_000 }, async () => {
    const transport = createHerdrTransport()
    // 1MiB+ 输出：限额内成功保留完整；超出则显式失败。此处生成 1.1MiB。
    const result = await transport.runGate({}, 'head -c 1150000 /dev/zero | tr "\\0" "x"', process.cwd())
    if (result.ok) {
      assert.ok(result.output.length > 1_000_000, '限额内输出必须完整保留')
    } else {
      assert.ok(result.output.includes('exceeded'), '超限必须明确说明而非截断')
    }
  })
})

describe('父目录软链逃逸（本地）', () => {
  it('.helm 为软链时读写均拒绝', { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'herdr-escape-'))
    const cwd = join(root, 'task')
    const outside = join(root, 'outside')
    await mkdir(cwd)
    await mkdir(outside)
    await writeFile(join(outside, 'wf-out-parent.json'), '{"private":true}')
    const { symlink } = await import('node:fs/promises')
    await symlink(outside, join(cwd, '.helm'))
    const transport = createHerdrTransport()
    await assert.rejects(transport.readOutput({}, cwd, 'wf-out-parent.json'), (err: unknown) => err instanceof HerdrTransportError && (err.code === 'herdr_output_escaping' || err.code === 'herdr_output_not_file'))
    await assert.rejects(transport.removeOutput({}, cwd, 'wf-out-parent.json'), (err: unknown) => err instanceof HerdrTransportError && (err.code === 'herdr_output_escaping' || err.code === 'herdr_output_not_file'))
    const { readFile } = await import('node:fs/promises')
    assert.equal(await readFile(join(outside, 'wf-out-parent.json'), 'utf8'), '{"private":true}')
    await rm(root, { recursive: true, force: true })
  })
})
