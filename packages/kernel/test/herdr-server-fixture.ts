/**
 * 零参 builtin:herdr 的真实连接 fixture：临时 Unix Socket 上按 Herdr 官方
 * 行协议提供受控服务端（一连接一请求 / events.subscribe ack + 裸事件帧）。
 *
 * 用途：替代历史 herdrTransport 注入缝——插件依赖全部来自 ctx.host 公共
 * 端口，生产 transport 直连真实 socket；测试通过本 fixture 的可编程响应
 * 观察启停/订阅/快照生命周期（连接计数、订阅请求记录、snapshot 内容）。
 */
import { createServer, type Server, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'

/** 受控 snapshot 内容：agents/panes 原样透传（结构由调用方按协议构造）。 */
export interface ControlledSnapshot {
  agents: Array<Record<string, unknown>>
  panes: Array<Record<string, unknown>>
  tabs?: Array<Record<string, unknown>>
  workspaces?: Array<Record<string, unknown>>
}

/** 单次请求记录（method + params；断言用）。 */
export interface ServedRequest {
  method: string
  params: Record<string, unknown>
}

export interface HerdrServerFixture {
  socketPath: string
  /** 已发生的连接数（每连接一请求；启停/重连断言）。 */
  connectionCount(): number
  /** 已收到的一行请求记录（含 events.subscribe）。 */
  requests: ServedRequest[]
  /** events.subscribe 连接当前是否存活（订阅释放断言）。 */
  subscriptionAlive(): boolean
  /** 编程 snapshot（默认空会话）。 */
  setSnapshot(snapshot: ControlledSnapshot): void
  /** 关闭服务与临时目录。 */
  close(): Promise<void>
}

const EMPTY_SNAPSHOT: ControlledSnapshot = { agents: [], panes: [], tabs: [], workspaces: [] }

/** 起一个受控 Herdr 行协议服务器（subscribe 永久连接推 ack，其余一问一答）。 */
export async function herdrServerFixture(
  t: TestContext,
  respond?: (request: { method: string; params: Record<string, unknown> }) =>
    | { result: unknown }
    | { error: { code: string; message: string } },
): Promise<HerdrServerFixture> {
  const root = await mkdtemp(join(tmpdir(), 'helm-herdr-server-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const socketPath = join(root, 'herdr.sock')
  const requests: ServedRequest[] = []
  let connections = 0
  let alive = false
  let snapshot: ControlledSnapshot = EMPTY_SNAPSHOT
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    connections += 1
    sockets.add(socket)
    socket.once('close', () => {
      sockets.delete(socket)
      alive = false
    })
    let buffer = ''
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> }
        requests.push({ method: request.method, params: request.params })
        if (request.method === 'events.subscribe') {
          alive = true
          socket.write(`${JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })}\n`)
          continue
        }
        const custom = respond?.(request)
        const reply = custom === undefined
          ? { id: request.id, result: requestResult(request.method) }
          : 'error' in custom
            ? { id: request.id, error: custom.error }
            : { id: request.id, result: custom.result }
        socket.end(`${JSON.stringify(reply)}\n`)
      }
    })
  })
  const sockets = new Set<Socket>()
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  const close = async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(root, { recursive: true, force: true })
  }
  function requestResult(method: string): unknown {
    if (method === 'session.snapshot') {
      return { type: 'session_snapshot', snapshot }
    }
    return { type: 'ok' }
  }
  return {
    socketPath,
    connectionCount: () => connections,
    requests,
    subscriptionAlive: () => alive,
    setSnapshot(next) { snapshot = next },
    close,
  }
}
