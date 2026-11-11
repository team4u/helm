/**
 * builtin:herdr 零参插件的单元级受控环境（herdr.test / herdr-plugin-fixes /
 * herdr-attachments 共享）。
 *
 * 生产插件依赖全部来自 ctx.host 公共端口：连接走真实 transport（UDS 行
 * 协议），交接文件读写走真实文件系统。测试仍使用进程内 FakeTransport 形状
 * （可编程 panes/outputFiles/gate 行为）——本模块把它「搬到真实边界」：
 *
 * - serveTransport：临时 UDS socket 上按 Herdr 官方行协议提供服务器，帧
 *   分发到受控 transport.call / transport.subscribe（一问一答；events.
 *   subscribe 回 ack 后保持连接推裸事件帧）。插件生产 transport 经
 *   backend.nodeIpc（LocalNodeChannel，endpoint 指向本 socket）真实到达，
 *   测试注入零私有缝。
 * - FsOutputFiles：Map 形状的交接文件存储（键 <cwd>/.helm/<name>），set
 *   真实落盘（含父目录创建）、delete 真实删除——生产 readLocalOutput /
 *   removeLocalOutput 在同一路径真实生效。
 */
import { connect, createServer, type Server, type Socket } from 'node:net'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { HelmError, type RpcResult } from '@helm/protocol'
import type { HerdrTransport } from '../../src/builtin-plugins/herdr/contracts.js'

/**
 * Map 形状的交接文件存储（真实落盘）：生产链路 readLocalOutput /
 * removeLocalOutput 经真实 fs 读取同一路径；测试 set/delete 同步真实文件。
 */
export class FsOutputFiles {
  private store = new Map<string, string>()

  set(key: string, content: string): void {
    mkdirSync(dirname(key), { recursive: true })
    writeFileSync(key, content, 'utf8')
    this.store.set(key, content)
  }

  get(key: string): string | undefined {
    return this.store.get(key) ?? (() => {
      try {
        return readFileSync(key, 'utf8')
      } catch {
        return undefined
      }
    })()
  }

  delete(key: string): boolean {
    const existed = this.store.has(key) || (() => {
      try {
        readFileSync(key)
        return true
      } catch {
        return false
      }
    })()
    try {
      unlinkSync(key)
    } catch {
      // 已被生产链路删除：幂等。
    }
    this.store.delete(key)
    return existed
  }

  has(key: string): boolean {
    return this.store.has(key)
  }
}

export interface ServedTransport {
  socketPath: string
  close(): Promise<void>
}

/**
 * 把受控 FakeTransport 暴露为真实 UDS 行协议服务器（零参插件的生产
 * transport 直连）。targetOf 为每次协议调用的 HerdrTarget 解析函数。
 */
export async function serveTransport(
  transport: HerdrTransport,
  socketPath: string,
  targetOf: () => { nodeId?: string } = () => ({}),
): Promise<ServedTransport> {
  const sockets = new Set<Socket>()
  const socketsWithReleases: Array<{ socket: Socket; release: () => void }> = []
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    // 客户端结束请求后，异步事件帧可能晚到；测试服务器不得因写入已关闭
    // 的订阅 socket 产生未处理 EPIPE，生产协议仍由客户端负责取消订阅。
    socket.on('error', () => {})
    const writeFrame = (frame: string): void => {
      if (!socket.destroyed && socket.writable) socket.write(frame, () => {})
    }
    let buffer = ''
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        void (async () => {
          const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> }
          try {
            if (request.method === 'events.subscribe') {
              const release = await transport.subscribe(targetOf(), (event) => {
                writeFrame(`${JSON.stringify({ event })}\n`)
              }, () => {
                // 受控 transport 注入流故障：销毁订阅 socket 模拟真实断线，
                // 客户端 close 路径如实触发其 onError（不静默吞掉注入故障）。
                socket.destroy()
              })
              writeFrame(`${JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })}\n`)
              // 生产 stop() 直接 socket.destroy()（FIN 不保证对端 close 事件同步
              // 到达）：fixture 在订阅 socket 结束（close 或 error）时同步释放受控
              // transport 监听，半途失败清理断言才能观测到释放。
              // 客户端 stop() 只 destroy 本方 socket；fixture server 侧经 close
              // 事件感知并释放受控 transport 监听（与生产对端释放语义一致）。
              socket.once('end', () => release())
              socket.once('close', () => release())
              socketsWithReleases.push({ socket, release })
              return
            }
            const result = await transport.call(targetOf(), request.method, request.params)
            socket.end(`${JSON.stringify({ id: request.id, result })}\n`)
          } catch (error) {
            const body = error instanceof HelmError
              ? { code: error.code, message: error.message }
              : { code: 'internal', message: error instanceof Error ? error.message : String(error) }
            socket.end(`${JSON.stringify({ id: request.id, error: body })}\n`)
          }
        })()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return {
    socketPath,
    close: async () => {
      // close() 销毁全部连接：触发每个订阅 socket 的 close 释放（见上）。
      for (const entry of socketsWithReleases) entry.socket.destroy()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** 交接文件目录真实化辅助：mkdirSync(join(cwd, '.helm'), recursive)。 */
export function ensureHelmDir(cwd: string): string {
  const dir = join(cwd, '.helm')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 单次行协议调用（任意节点通用）：写入一行请求，读到首个换行响应即返回。
 * 供 backend.nodeIpc.call 将远端 nodeId 的帧转发到受控 socket（协议与
 * LocalNodeChannel 一致，但不限 'local'）。
 */
export async function ipcLineCall(
  socketPath: string,
  line: string,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
): Promise<RpcResult<string>> {
  signal?.throwIfAborted()
  return await new Promise((resolve) => {
    const socket = connect(socketPath)
    socket.setNoDelay(true)
    let buffer = ''
    let settled = false
    const settle = (result: RpcResult<string>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      resolve(result)
    }
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => settle({ ok: false, error: { code: 'timeout', message: `ipcLineCall no response within ${timeoutMs}ms` } }), timeoutMs)
    const onAbort = () => settle({ ok: false, error: { code: 'aborted', message: 'ipcLineCall aborted' } })
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.on('connect', () => socket.write(`${line}\n`))
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      settle({ ok: true, value: buffer.slice(0, newline) })
    })
    socket.once('error', (err) => settle({ ok: false, error: { code: 'unknown', message: err.message } }))
  })
}

/** 临时目录工厂（测试自清理约定由调用方 rmSync）。 */
export function unitTempDir(prefix: string): string {
  return join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}
