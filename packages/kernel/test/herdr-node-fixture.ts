/**
 * 测试共享：基于真实本地 Unix Socket + LocalNodeChannel 的节点通道 fixture。
 * 取代历史「假 ssh 脚本 + python3 stdin」通道：协议边界、取消、限额均经
 * 真实生产代码路径（createHerdrTransport + LocalNodeChannel）验证。
 *
 * LocalNodeChannel 现仅承载 'local' 节点（isOnline/拒绝语义收紧）；远端节点
 * 由 MutableNodeChannel 组合（fixture UDS + 真实通道实现，协议同构）。
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import type { Context } from '@earendil-works/chord/context'
import { LocalNodeChannel } from '../src/builtin-plugins/herdr/local-node-channel.js'
import type { HerdrNodeChannel } from '../src/builtin-plugins/herdr/contracts.js'

export interface NodeFixture {
  /** 临时根目录（测试自清理）。 */
  root: string
  /** 目标节点的 Herdr UDS 路径。 */
  socketPath: string
  /** 已收到的一行请求（JSON）。 */
  requests: Array<{ id: string; method: string; params: Record<string, unknown> }>
  /** ipcCall/ipcSubscribe 实际收到的 endpoint/session 传参（远端端点纪律断言用）。 */
  endpointInputs: Array<{ endpoint?: string; session?: string }>
  /** 连接存活追踪（取消语义断言用）。 */
  sockets: Set<Socket>
  server: Server
  /** 节点通道实现（真实 LocalNodeChannel，协议同构；仅承载 'local'）。 */
  channel: HerdrNodeChannel
  close(): Promise<void>
}

/**
 * 可编程响应服务器 + 节点通道。
 * respond 收到（请求对象, socket）；缺省应答 `{id, result:{type:'ok'}}`。
 */
export async function nodeFixture(
  t: TestContext,
  respond: (request: Record<string, unknown>, socket: Socket) => void = (_req, socket) => {
    socket.end(`${JSON.stringify({ id: 'helm-remote-1', result: { type: 'ok' } })}\n`)
  },
): Promise<NodeFixture> {
  const root = await mkdtemp(join(tmpdir(), 'helm-node-channel-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const socketPath = join(root, 'herdr.sock')
  const requests: Array<{ id: string; method: string; params: Record<string, unknown> }> = []
  const endpointInputs: NodeFixture['endpointInputs'] = []
  const sockets = new Set<Socket>()
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    let input = ''
    socket.on('data', (chunk) => {
      input += chunk.toString('utf8')
      const newline = input.indexOf('\n')
      if (newline < 0) return
      const request = JSON.parse(input.slice(0, newline)) as { id: string; method: string; params: Record<string, unknown> }
      requests.push(request)
      respond(request, socket)
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })
  const close = async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(root, { recursive: true, force: true })
  }
  const channel = new LocalNodeChannel()
  return { root, socketPath, requests, endpointInputs, sockets, server, channel, close }
}

/**
 * 可变注册的节点注册表 fixture：按 nodeId 提供在线状态、hubUrl 与底层通道；
 * 未注册节点视为离线（transport 显式报 herdr_node_offline，绝不回退本机）。
 * 'local' 委托真实 LocalNodeChannel；注册的远端节点经 labelFor 包装：协议/
 * 文件/执行全部走真实实现，仅 nodeId 换标（目标节点的本机 IPC 同协议）。
 */
export class MutableNodeChannel implements HerdrNodeChannel {
  readonly nodes = new Map<string, { online: boolean; hubUrl?: string; channel: HerdrNodeChannel }>()
  private readonly local = new LocalNodeChannel()
  /** ipcCall 实际收到的入参记录（远端端点纪律断言用）。 */
  readonly seenCallInputs: Array<{ nodeId: string; endpoint?: string; session?: string }> = []

  isOnline(nodeId: string): boolean {
    if (nodeId === 'local') return true
    return this.nodes.get(nodeId)?.online ?? false
  }

  getNodeHubUrl(nodeId: string): string | undefined {
    return this.nodes.get(nodeId)?.hubUrl
  }

  async ipcCall(
    nodeId: string,
    input: { endpoint?: string; session?: string; line: string; timeoutMs?: number },
    context: Context,
  ) {
    const target = this.channelOf(nodeId)
    if (nodeId !== 'local') this.seenCallInputs.push({ nodeId, endpoint: input.endpoint, session: input.session })
    if (target === undefined) {
      return { ok: false as const, error: { code: 'unknown' as const, message: `node '${nodeId}' unknown` } }
    }
    return target.ipcCall(nodeId, input, context)
  }

  envFor(nodeId: string, cwd: string) {
    const target = this.channelOf(nodeId)
    if (target === undefined) throw new Error(`node '${nodeId}' unknown`)
    return target.envFor(nodeId, cwd)
  }

  private channelOf(nodeId: string): HerdrNodeChannel | undefined {
    if (nodeId === 'local') return this.local
    const node = this.nodes.get(nodeId)
    if (node === undefined) return undefined
    return relabelChannel(node.channel, nodeId)
  }
}

/**
 * nodeId 换标适配器：把仅承载 'local' 的真实 LocalNodeChannel 以目标远端 nodeId
 * 对外暴露（协议/文件/执行零改动；fixture 模拟 EnvFabric 远端节点的同构形态）。
 */
export function relabelChannel(local: HerdrNodeChannel, nodeId: string): HerdrNodeChannel {
  return {
    isOnline: (id) => id === nodeId && local.isOnline('local'),
    getNodeHubUrl: () => undefined,
    ipcCall: (id, input, context) => local.ipcCall('local', input, context),
    envFor: (id, cwd) => local.envFor('local', cwd),
  }
}

/** 临时目录（含 .helm）。 */
export async function tempRoot(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.helm'), { recursive: true })
  return root
}

/** 轮询直至条件满足或超时（显式失败，不静默跳过）。 */
export async function pollUntil(predicate: () => Promise<boolean> | boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${label} 未在 ${timeoutMs}ms 内满足`)
}
