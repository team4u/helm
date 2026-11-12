/**
 * node-fetch 隧道弃置兜底测试（env/node-fetch.ts tunnelFetch 的 Response
 * body 生命周期）：
 * - 传输中断（响应头已到、连接被销毁）且 body 无人读取：res close/error
 *   兜底必须确定性销毁隧道（不等 GC、不等永不发生的 pull/cancel）；
 * - 完整响应 + 服务器关闭连接（Connection: close 正常路径）且 body 无人
 *   读取：连接关闭即销毁隧道；
 * - 上游连接永不断开（keep-alive 忽略 Connection: close）且 body 被弃置：
 *   FinalizationRegistry 在 GC 时销毁（best-effort，见实现注释）；
 * - 正常消费 / 显式 cancel 语义不变；中断后迟到的读取得到显式错误。
 *
 * 全部走 local 直连隧道（connectLocalTunnel），无需远端 daemon。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import v8 from 'node:v8'
import vm from 'node:vm'
import type { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { tunnelFetch, connectLocalTunnel } from '../src/env/node-fetch.js'

/** 强制全量 GC（子进程未开 --expose-gc 时的标准 workaround）。 */
function forceGc(): void {
  v8.setFlagsFromString('--expose_gc')
  vm.runInNewContext('gc')()
}

/** 记录最近一条隧道的 openTunnel（tunnelFetch 的隧道就是该 duplex）。 */
function recordingOpenTunnel(): { open: (t: { host?: string; port: number }, signal?: AbortSignal) => Promise<Duplex>; last(): Duplex | undefined } {
  let lastTunnel: Duplex | undefined
  return {
    open: async (target, signal) => {
      lastTunnel = await connectLocalTunnel(target.host ?? '127.0.0.1', target.port, signal)
      return lastTunnel
    },
    last: () => lastTunnel,
  }
}

/** 轮询等待隧道被销毁（确定性路径预算 2s；失败返回 false）。 */
async function waitDestroyed(tunnel: Duplex | undefined, budgetMs = 2_000): Promise<boolean> {
  for (let i = 0; i < budgetMs / 25 && tunnel !== undefined; i += 1) {
    if (tunnel.destroyed) return true
    await delay(25)
  }
  return tunnel?.destroyed ?? false
}

describe('tunnelFetch 弃置 body 兜底', { timeout: 60_000 }, () => {
  test('传输中断 + body 无人读取：res close 兜底确定性销毁隧道', { timeout: 60_000 }, async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('partial')
      // 响应头送达后销毁连接（模拟传输中断）。
      setTimeout(() => res.destroy(), 50)
    })
    server.on('clientError', () => undefined)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    try {
      const tunnels = recordingOpenTunnel()
      const response = await tunnelFetch(tunnels.open, 'local', new Request(`http://127.0.0.1:${port}/x`))
      assert.equal(response.status, 200)
      // 只查 status，不读不 cancel——隧道必须在中断后立即销毁。
      assert.ok(await waitDestroyed(tunnels.last()), '传输中断后隧道必须确定性销毁')
      // 中断后迟到的读取得到显式错误（不静默伪造完整 body）。
      await assert.rejects(response.text())
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('完整响应 + 服务器关连接 + body 无人读取：连接关闭即销毁隧道', { timeout: 60_000 }, async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    try {
      const tunnels = recordingOpenTunnel()
      const response = await tunnelFetch(tunnels.open, 'local', new Request(`http://127.0.0.1:${port}/y`))
      assert.equal(response.status, 200)
      assert.ok(await waitDestroyed(tunnels.last()), '服务器关闭后隧道必须销毁')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('上游连接永不断开 + body 被 GC：FinalizationRegistry 销毁隧道', { timeout: 60_000 }, async () => {
    // raw TCP 手写 HTTP 响应：Connection: keep-alive 且永不关 socket。
    const server = net.createServer((socket) => {
      socket.on('error', () => undefined)
      socket.on('data', () => {
        socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    try {
      const tunnels = recordingOpenTunnel()
      {
        const response = await tunnelFetch(tunnels.open, 'local', new Request(`http://127.0.0.1:${port}/health`))
        assert.equal(response.status, 200)
        assert.equal(tunnels.last()?.destroyed, false, '连接未关闭时隧道仍存活（SSE 等场景不得误杀）')
        // response 出作用域即弃置（只查过 status）。
      }
      let destroyed = false
      for (let i = 0; i < 20 && !destroyed; i += 1) {
        await delay(50)
        forceGc()
        destroyed = tunnels.last()?.destroyed ?? false
      }
      assert.ok(destroyed, '弃置 body 被 GC 后隧道必须销毁（FinalizationRegistry 兜底）')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('正常消费与显式 cancel 语义不变', { timeout: 60_000 }, async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('full-body')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    try {
      // 完整消费：body 正常送达，读尽后隧道销毁。
      {
        const tunnels = recordingOpenTunnel()
        const response = await tunnelFetch(tunnels.open, 'local', new Request(`http://127.0.0.1:${port}/a`))
        assert.equal(await response.text(), 'full-body')
        assert.ok(await waitDestroyed(tunnels.last()), '读尽后隧道销毁')
      }
      // 显式 cancel：立即销毁（既有语义）。
      {
        const tunnels = recordingOpenTunnel()
        const response = await tunnelFetch(tunnels.open, 'local', new Request(`http://127.0.0.1:${port}/b`))
        await response.body?.cancel()
        assert.ok(await waitDestroyed(tunnels.last()), 'cancel 后隧道销毁')
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
