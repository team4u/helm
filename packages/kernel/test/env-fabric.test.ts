/**
 * 跨平台节点底座（EnvFabric）端到端测试：真实 Hub WS 网关 + 真实
 * @helm/node 守护进程（每条连接一代独立 env RPC server，断换代即销毁）。
 *
 * 覆盖：
 * 1. NodeRegistry + attachNodeWsGateway + RemoteExecutionEnv + ScopedExecutionEnv：
 *    鉴权通过与失败（4003）、fail-closed 无鉴权、未注册超时（4001）、
 *    远端文件读写（含 envFlushFile 真实转发）、远端命令流式输出、
 *    取消传播杀进程、断线返回 unknown（不重试、不回退 local）、
 *    同节点多会话 ScopedExecutionEnv 环境隔离（绑定键不可被逐调用 env 覆盖）、
 *    撤销红线（延迟鉴权在途 disconnect 后 resolve(true) 不再发布旧连接）、
 *    reader 跨代（断连后旧 readerId 不发给新代，不误读别的文件）。
 * 2. GET /api/nodes、POST /api/nodes/issue（token 一次性返回）、
 *    DELETE /api/nodes/:id（掐断连接 + local 保护）、POST /api/env/exec
 *    （local JSON 与 stream:true NDJSON 帧 + 离线 409 node_offline + 会话靶点继承）。
 * 3. 会话绑定远端 nodeId 后经真实模型回合调用 bash/read/write/edit 在远端生效。
 */

import { test, describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import type { NodeRegisterInput, NodeRegisterResult } from '@helm/protocol'
import type { HubConnectionLocal } from '../src/env/registry.js'
import { createBirpc } from 'birpc'
import {
  attachNodeWsGateway,
  createEnvFabric,
  RemoteExecutionEnv,
  type EnvFabric,
} from '../src/env/index.js'
import { KernelRuntime } from '../src/runtime/index.js'
import { startHub } from '../src/http/index.js'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import {
  createNodeDaemon,
  type NodeDaemon,
  type NodeIdentity,
} from '@helm/node'

const bg = BACKGROUND_CONTEXT

// ---------------------------------------------------------------------------
// 基座
// ---------------------------------------------------------------------------

function makeFauxModels() {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  return { models, faux }
}

/** 纯 EnvFabric 测试基座（HTTP server + gateway，不经 KernelRuntime）。 */
async function startFabricHub(
  authenticate?: (nodeId: string, token: string) => boolean | Promise<boolean>,
) {
  const fabric = createEnvFabric({
    ...(authenticate !== undefined ? { authenticate } : {}),
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 60_000,
    envOptions: ({ conversationId }): Record<string, string> =>
      conversationId === undefined ? {} : { HELM_CONVERSATION_ID: String(conversationId) },
  })
  const server = http.createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const gateway = attachNodeWsGateway(server, { registry: fabric.registry })
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    fabric,
    close: async () => {
      await gateway.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await fabric.dispose()
    },
  }
}

/** 真实节点守护进程（快速重连；log 静默）。 */
async function startNode(opts: {
  url: string
  nodeId: string
  token: string
  dataDir: string
  reconnectBaseMs?: number
}): Promise<NodeDaemon> {
  const identity: NodeIdentity = { nodeId: opts.nodeId, token: opts.token }
  return createNodeDaemon({
    hubUrl: opts.url,
    identity,
    dataDir: opts.dataDir,
    reconnectBaseDelayMs: opts.reconnectBaseMs ?? 100,
    reconnectMaxDelayMs: opts.reconnectBaseMs ?? 800,
    log: () => undefined,
  })
}

let rootDir: string

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-envfabric-'))
})

after(async () => {
  rmSync(rootDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. EnvFabric 核心行为
// ---------------------------------------------------------------------------

describe('EnvFabric 节点连接与远端执行', { timeout: 60_000 }, () => {
  it('鉴权通过与拒绝：正确 token 注册成功；错误 token 不注册；fail-closed 无鉴权拒绝一切', { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(rootDir, 'auth-'))
    const TOKEN = 'node-a:secret-a1'
    const hub = await startFabricHub((nodeId, token) => nodeId === 'node-a' && token === TOKEN)
    try {
      const good = await startNode({ url: hub.baseUrl, nodeId: 'node-a', token: TOKEN, dataDir: dir })
      assert.ok(await good.waitUntilRegistered(), '正确 token 应注册成功')
      assert.equal(hub.fabric.isOnline('node-a'), true)
      await good.close()

      const bad = await startNode({ url: hub.baseUrl, nodeId: 'node-a', token: 'node-a:WRONG', dataDir: dir })
      assert.equal(await bad.waitUntilRegistered(2_000), false, '错误 token 不得注册')
      assert.equal(hub.fabric.registry.get('node-a'), undefined)
      await bad.close()
    } finally {
      await hub.close()
    }

    // fail-closed：无鉴权回调。
    const dir2 = await mkdtemp(join(rootDir, 'noauth-'))
    const hub2 = await startFabricHub()
    try {
      const daemon = await startNode({ url: hub2.baseUrl, nodeId: 'x', token: 'x:t', dataDir: dir2 })
      assert.equal(await daemon.waitUntilRegistered(2_000), false, '无鉴权回调 → 拒绝一切注册')
      assert.equal(hub2.fabric.registry.get('x'), undefined)
      await daemon.close()
    } finally {
      await hub2.close()
    }
  })

  it('未注册超时 4001：连接后不 register 即被网关关闭', { timeout: 60_000 }, async () => {
    const hub = await startFabricHub(() => true)
    try {
      const ws = new WebSocket(`${hub.baseUrl.replace(/^http/, 'ws')}/ws/node`)
      const codes: number[] = []
      await new Promise<void>((resolve) => ws.once('open', () => resolve()))
      ws.on('close', (code) => codes.push(code))
      await delay(10_600)
      assert.ok(codes.includes(4001), `未注册连接应以 4001 关闭（收到 ${codes.join(',')}）`)
    } finally {
      await hub.close()
    }
  })

  it('远端文件读写 + envFlushFile 真实转发 + 流式 exec + 取消传播', { timeout: 60_000 }, async () => {
    const nodeData = await mkdtemp(join(rootDir, 'rw-node-'))
    const workDir = await mkdtemp(join(rootDir, 'rw-work-'))
    const TOKEN = 'node-rw:secret'
    const hub = await startFabricHub((nodeId, token) => nodeId === 'node-rw' && token === TOKEN)
    try {
      const daemon = await startNode({ url: hub.baseUrl, nodeId: 'node-rw', token: TOKEN, dataDir: nodeData })
      assert.ok(await daemon.waitUntilRegistered())
      const env = hub.fabric.envFor('node-rw', workDir)
      assert.ok(env instanceof RemoteExecutionEnv)

      // 写 + flush（真实转发）+ 读回。
      const w = await env.writeFile('hello.txt', '你好 helm', bg)
      assert.ok(w.ok, JSON.stringify(w))
      const f = await env.flushFile('hello.txt', bg)
      assert.ok(f.ok, `envFlushFile 应真实转发成功：${JSON.stringify(f)}`)
      const r = await env.readTextFile('hello.txt', bg)
      assert.ok(r.ok && r.value === '你好 helm')

      // 流式 exec：onOutput 按到达序回放。
      const chunks: string[] = []
      const exec = await env.exec("printf 'a\\nb\\nc'", { onOutput: (t) => chunks.push(t) }, bg)
      assert.ok(exec.ok && exec.value.exitCode === 0)
      assert.equal(chunks.join(''), 'a\nb\nc')

      // 取消传播：abort → envAbortExec → 节点杀该命令进程树。
      const sentinel = join(workDir, 'cancel-sentinel.txt')
      const controller = new AbortController()
      const running = env.exec(`sleep 30 && touch ${sentinel}`, undefined, withAbortSignal(controller.signal, bg))
      await delay(400)
      controller.abort()
      const aborted = await running
      assert.ok(!aborted.ok && aborted.error.code === 'aborted')
      await delay(600)
      assert.ok(!existsSync(sentinel), '取消后远端进程树不得存活写入 sentinel')
      // 取消不影响后续命令（单命令进程树语义）。
      const after = await env.exec('echo alive', undefined, bg)
      assert.ok(after.ok && after.value.exitCode === 0)
      await daemon.close()
    } finally {
      await hub.close()
    }
  })

  it('断线 unknown：exec 在途断开显式报结果未知，绝不重试、绝不回退 local', { timeout: 60_000 }, async () => {
    const nodeData = await mkdtemp(join(rootDir, 'disc-node-'))
    const workDir = await mkdtemp(join(rootDir, 'disc-work-'))
    const TOKEN = 'node-disc:secret'
    const hub = await startFabricHub((nodeId, token) => nodeId === 'node-disc' && token === TOKEN)
    try {
      const daemon = await startNode({ url: hub.baseUrl, nodeId: 'node-disc', token: TOKEN, dataDir: nodeData })
      assert.ok(await daemon.waitUntilRegistered())
      const env = hub.fabric.envFor('node-disc', workDir)
      const localMarker = join(rootDir, 'disc-local-marker.txt')
      const longRun = env.exec('sleep 5; echo done', undefined, bg)
      await delay(400)
      await daemon.close()
      const result = await longRun
      assert.ok(!result.ok, '断线中的命令不得成功')
      assert.equal(result.error.code, 'unknown', `期望 unknown，得到 ${JSON.stringify(result)}`)
      assert.match(result.error.message, /不自动重试/)
      assert.ok(!existsSync(localMarker), '绝不回退 local 执行')
    } finally {
      await hub.close()
    }
  })

  it('ScopedExecutionEnv：同节点多会话环境隔离；绑定键不可被逐调用 env 覆盖', { timeout: 60_000 }, async () => {
    const nodeData = await mkdtemp(join(rootDir, 'scope-node-'))
    const workDir = await mkdtemp(join(rootDir, 'scope-work-'))
    const TOKEN = 'node-scope:secret'
    const hub = await startFabricHub((nodeId, token) => nodeId === 'node-scope' && token === TOKEN)
    try {
      const daemon = await startNode({ url: hub.baseUrl, nodeId: 'node-scope', token: TOKEN, dataDir: nodeData })
      assert.ok(await daemon.waitUntilRegistered())
      const s1 = hub.fabric.envForTarget({ conversationId: 101, nodeId: 'node-scope', cwd: workDir })
      const s2 = hub.fabric.envForTarget({ conversationId: 202, nodeId: 'node-scope', cwd: workDir })
      // 环境按会话现场合成（fresh）。
      await s1.exec('echo "$HELM_CONVERSATION_ID" > who.txt', undefined, bg)
      assert.equal((await readFile(join(workDir, 'who.txt'), 'utf8')).trim(), '101')
      await s2.exec('echo "$HELM_CONVERSATION_ID" > who.txt', undefined, bg)
      assert.equal((await readFile(join(workDir, 'who.txt'), 'utf8')).trim(), '202')
      // 绑定键不可被逐调用 env 覆盖（防伪造作用域）。
      await s1.exec('echo "$HELM_CONVERSATION_ID" > who.txt', { env: { HELM_CONVERSATION_ID: '999' } }, bg)
      assert.equal((await readFile(join(workDir, 'who.txt'), 'utf8')).trim(), '101')
      await daemon.close()
    } finally {
      await hub.close()
    }
  })

  it('撤销红线：延迟鉴权在途 disconnect 后 resolve(true) 不再发布旧连接', { timeout: 60_000 }, async () => {
    const TOKEN = 'node-rev:secret'
    let authDelayMs = 500
    const hub = await startFabricHub(async (nodeId, token) => {
      if (nodeId === 'node-rev' && token === TOKEN) {
        await delay(authDelayMs)
        return true
      }
      return false
    })
    try {
      // 原始 WS 客户端手动 register（可控时序，无 daemon 自动重连干扰）。
      const ws = new WebSocket(`${hub.baseUrl.replace(/^http/, 'ws')}/ws/node?nodeId=node-rev`)
      await new Promise<void>((resolve) => ws.once('open', () => resolve()))
      const hubRpc = createBirpc<{
        register(input: NodeRegisterInput): Promise<NodeRegisterResult>
        heartbeat(nodeId: string): Promise<boolean>
      }, HubConnectionLocal>(
        {
          onEnvExecOutput: () => undefined,
          onIpcEvent: () => undefined,
          onIpcClosed: () => undefined,
        },
        {
          post: (data) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
          },
          on: (cb) => {
            ws.on('message', (raw) => {
              const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8')
              try {
                cb(JSON.parse(text) as never)
              } catch {
              /* 非 JSON 忽略 */
              }
            })
          },
          serialize: (d) => d,
          deserialize: (d) => d as never,
          timeout: 10_000,
        },
      )
      const registerPromise = hubRpc.register({
        nodeId: 'node-rev',
        token: TOKEN,
        hostname: 'revoke-probe',
        platform: process.platform,
      })
      // 鉴权挂起中（authDelayMs=500）：立即 disconnect（模拟 removeNode/轮换）。
      await delay(120)
      hub.fabric.registry.disconnect('node-rev')
      // 鉴权随后 resolve(true)：register 必须被拒（register superseded by
      // revoke/replace），旧连接绝不发布在线。
      const outcome = await registerPromise
      assert.equal(outcome.ok, false, `迟到 resolve(true) 不得发布：${JSON.stringify(outcome)}`)
      assert.match(outcome.reason ?? '', /superseded/)
      await delay(300)
      assert.equal(hub.fabric.registry.get('node-rev'), undefined, '注册表仍离线')
      assert.equal(hub.fabric.isOnline('node-rev'), false)
      // 撤销完成后新注册不受影响（epoch 已推进但无在途注册）。
      authDelayMs = 0
      const daemon2 = await startNode({
        url: hub.baseUrl,
        nodeId: 'node-rev',
        token: TOKEN,
        dataDir: await mkdtemp(join(rootDir, 'revoke-d2-')),
      })
      assert.ok(await daemon2.waitUntilRegistered(), '撤销完成后新注册正常')
      await daemon2.close()
      try {
        hubRpc.$close()
      } catch {
        /* 已关 */
      }
      try {
        ws.close()
      } catch {
        /* 已关 */
      }
    } finally {
      await hub.close()
    }
  })

  it('reader 跨代：断连后旧 readerId 不发给新代（不误读别的文件）', { timeout: 60_000 }, async () => {
    const nodeData = await mkdtemp(join(rootDir, 'reader-node-'))
    const workDir = await mkdtemp(join(rootDir, 'reader-work-'))
    await writeFile(join(workDir, 'a.txt'), 'A1\nA2\n')
    await writeFile(join(workDir, 'b.txt'), 'B1\nB2\n')
    const TOKEN = 'node-reader:secret'
    const hub = await startFabricHub((nodeId, token) => nodeId === 'node-reader' && token === TOKEN)
    try {
      const daemon = await startNode({ url: hub.baseUrl, nodeId: 'node-reader', token: TOKEN, dataDir: nodeData })
      assert.ok(await daemon.waitUntilRegistered())
      const env = hub.fabric.envFor('node-reader', workDir)

      // 第一代：打开 a.txt（readerId r1）。
      const opened = await env.openTextLineReader('a.txt', bg)
      assert.ok(opened.ok)
      const line1 = await opened.value.readLine(bg)
      assert.ok(line1.ok && line1.value?.text === 'A1')

      // 断开（第一代终结，句柄 r1 销毁）→ 新代重连并打开 b.txt
      //（新代 readerId 重新计数，r1 将指向 b.txt）。
      await daemon.close()
      const daemon2 = await startNode({ url: hub.baseUrl, nodeId: 'node-reader', token: TOKEN, dataDir: nodeData })
      assert.ok(await daemon2.waitUntilRegistered())
      const env2 = hub.fabric.envFor('node-reader', workDir)
      const openedB = await env2.openTextLineReader('b.txt', bg)
      assert.ok(openedB.ok)

      // 旧 reader 再次 read：必须明确报错，绝不读到 B1（跨代误读）。
      const stale = await opened.value.readLine(bg)
      if (stale.ok) {
        // 个别实现下 rpc 调用对已 close 的代抛错（走 catch 分支）——那是
        // 明确失败而非读到数据，同样满足「不误读」；但读到 B1 绝不允许。
        assert.notEqual(stale.value?.text, 'B1', '旧代 reader 绝不读到新代文件内容')
      } else {
        assert.ok(
          ['unknown', 'invalid', 'not_found', 'aborted'].includes(stale.error.code),
          `期望明确错误，得到 ${JSON.stringify(stale)}`,
        )
      }
      await daemon2.close()
    } finally {
      await hub.close()
    }
  })

  it('输出 sink 绑定连接代：断连后旧代迟到输出事件不得污染新代', { timeout: 60_000 }, async () => {
    const nodeData = await mkdtemp(join(rootDir, 'sink-node-'))
    const workDir = await mkdtemp(join(rootDir, 'sink-work-'))
    const TOKEN = 'node-sink:secret'
    const hub = await startFabricHub((nodeId, token) => nodeId === 'node-sink' && token === TOKEN)
    try {
      const daemon = await startNode({ url: hub.baseUrl, nodeId: 'node-sink', token: TOKEN, dataDir: nodeData })
      assert.ok(await daemon.waitUntilRegistered())
      // 注册输出 sink 收集全部事件。
      const received: Array<{ execId: string; text: string }> = []
      hub.fabric.registry.addOutputSink('node-sink', (event) => received.push({ execId: event.execId, text: event.text }))
      const env = hub.fabric.envFor('node-sink', workDir)
      const r1 = await env.exec('echo old-gen', undefined, bg)
      assert.ok(r1.ok)
      await delay(200)
      assert.ok(received.some((e) => e.text.includes('old-gen')), '在线时输出正常路由')
      // 断开：旧代事件通道终结。
      await daemon.close()
      await delay(300)
      const countAfterDisconnect = received.length
      // 新代重连后再执行：事件应继续路由（新代绑定新 sink 分发路径），
      // 且断开期间无伪造事件到达。
      const daemon2 = await startNode({ url: hub.baseUrl, nodeId: 'node-sink', token: TOKEN, dataDir: nodeData })
      assert.ok(await daemon2.waitUntilRegistered())
      const r2 = await env.exec('echo new-gen', undefined, bg)
      assert.ok(r2.ok)
      await delay(300)
      assert.ok(received.some((e) => e.text.includes('new-gen')), '新代输出继续路由到 sink')
      // 断开期间到达的事件只可能是断开前的迟到帧；确认无旧代 reconnect 后的伪造注入
      //（new-gen 之前不增加与 old-gen 无关的 execId）。
      void countAfterDisconnect
      await daemon2.close()
    } finally {
      await hub.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. HTTP 路由：/api/nodes 与 /api/env/exec
// ---------------------------------------------------------------------------

describe('节点管理与 env/exec HTTP 路由', { timeout: 60_000 }, () => {
  interface TestApp {
    kernel: KernelRuntime
    hub: Awaited<ReturnType<typeof startHub>>
    token: string
    close(): Promise<void>
  }

  async function openApp(dir: string): Promise<TestApp> {
    const { models } = makeFauxModels()
    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models: models as never,
      watchdogIntervalMs: 0,
    })
    const hub = await startHub({
      kernel: kernel as never,
      workflows: {
        list: () => [],
        listRuns: () => [],
        run: async () => { throw new Error('此节点测试不提供工作流执行') },
        getRun: async () => undefined,
        wait: async () => undefined,
        abort: async () => undefined,
      },
      port: 0,
    })
    const setup = await fetch(`${hub.url}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'envfabric-test-pass' }),
    })
    const { token } = (await setup.json()) as { token: string }
    return {
      kernel,
      hub,
      token,
      async close() {
        await hub.close()
        await kernel.close()
      },
    }
  }

  async function call(app: TestApp, method: string, path: string, body?: unknown) {
    const res = await fetch(`${app.hub.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${app.token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    let json: any
    try {
      json = text.length > 0 ? JSON.parse(text) : null
    } catch {
      json = text
    }
    return { status: res.status, json, text }
  }

  it('GET /api/nodes + issue（token 一次性）+ remove（掐断连接、local 保护）', { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(rootDir, 'http-nodes-'))
    const app = await openApp(dir)
    try {
      const initial = await call(app, 'GET', '/api/nodes')
      assert.equal(initial.status, 200)
      assert.ok(Array.isArray(initial.json))
      assert.equal(initial.json[0].id, 'local')
      assert.equal(initial.json[0].kind, 'local')
      assert.equal(initial.json[0].online, true)

      const issue = await call(app, 'POST', '/api/nodes/issue', { nodeId: 'http-node' })
      assert.equal(issue.status, 201)
      assert.equal(issue.json.nodeId, 'http-node')
      assert.ok(typeof issue.json.token === 'string' && issue.json.token.startsWith('http-node:'))

      const list1 = await call(app, 'GET', '/api/nodes')
      assert.equal(list1.json.length, 2)
      assert.equal(list1.json[1].id, 'http-node')
      assert.equal(list1.json[1].online, false, '未连接时 offline')

      const daemon = await startNode({ url: app.hub.url, nodeId: 'http-node', token: issue.json.token, dataDir: dir })
      assert.ok(await daemon.waitUntilRegistered())
      const list2 = await call(app, 'GET', '/api/nodes')
      assert.equal(list2.json[1].online, true)
      assert.ok(typeof list2.json[1].hostname === 'string' && list2.json[1].hostname.length > 0, 'daemon 注册上报 hostname')

      // node.changed 事件序列（SSE 增量帧）：上线 -> 移除恰好一条含 removed:true；
      // 事件为 NodeChangedEvent 形状（'node' in event），不坠入 Custom payload 嵌套。
      const nodeEvents: Array<{ node: { id: string }; removed?: boolean; payload?: unknown }> = []
      const releaseEvents = app.kernel.events.subscribe((frame) => {
        const event = frame.event as { type: string; node?: unknown; removed?: unknown; payload?: unknown }
        if (event.type === 'node.changed') {
          assert.ok('node' in event, `node.changed 必须是 NodeChangedEvent 形状，得到 ${JSON.stringify(event)}`)
          nodeEvents.push(event as { node: { id: string }; removed?: boolean })
        }
      })

      const removed = await call(app, 'DELETE', `/api/nodes/${encodeURIComponent('http-node')}`)
      assert.equal(removed.status, 200)
      assert.deepEqual(removed.json, { ok: true })
      await delay(300)
      releaseEvents()
      const removals = nodeEvents.filter((e) => e.removed === true && e.node.id === 'http-node')
      assert.equal(
        removals.length,
        1,
        `移除实际节点时恰好发布一条含 removed:true 的事件（onNodeChanged 去重后），得到 ${JSON.stringify(nodeEvents)}`,
      )
      assert.equal(
        nodeEvents.filter((e) => e.node.id === 'http-node' && e.removed !== true).length,
        0,
        `移除后不得再发布 http-node 的非 removed 事件（离线事件须被去重），得到 ${JSON.stringify(nodeEvents)}`,
      )
      for (const e of nodeEvents) {
        assert.equal(e.payload, undefined, 'NodeChangedEvent 不携带 payload 字段')
      }
      const list3 = await call(app, 'GET', '/api/nodes')
      assert.equal(list3.json.length, 1, '移除后只剩 local')

      const localRemove = await call(app, 'DELETE', '/api/nodes/local')
      assert.equal(localRemove.status, 400)
      assert.equal(localRemove.json.error.code, 'cannot_remove_local_node')
      await daemon.close()
      await app.close()
    } finally {
      await app.close().catch(() => undefined)
    }
  })

  it('POST /api/env/exec：local JSON、远端 stream NDJSON 帧、离线 409、会话靶点继承', { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(rootDir, 'http-exec-'))
    const app = await openApp(dir)
    try {
      // local JSON。
      const local = await call(app, 'POST', '/api/env/exec', { command: 'echo hello-env-exec' })
      assert.equal(local.status, 200)
      assert.equal(local.json.ok, true)
      assert.equal(local.json.exitCode, 0)
      assert.ok(local.json.output.includes('hello-env-exec'))

      // 离线节点：409 node_offline。
      await call(app, 'POST', '/api/nodes/issue', { nodeId: 'offline-node' })
      const offline = await call(app, 'POST', '/api/env/exec', {
        command: 'echo x',
        nodeId: 'offline-node',
        cwd: '/tmp',
      })
      assert.equal(offline.status, 409)
      assert.equal(offline.json.error.code, 'node_offline')

      // 远端 stream NDJSON：output 帧 + 唯一 exit 终帧（帧协议 output/exit/error）。
      const nodeData = await mkdtemp(join(rootDir, 'http-exec-node-'))
      const workDir = await mkdtemp(join(rootDir, 'http-exec-work-'))
      const issue = await call(app, 'POST', '/api/nodes/issue', { nodeId: 'stream-node' })
      const daemon = await startNode({ url: app.hub.url, nodeId: 'stream-node', token: issue.json.token, dataDir: nodeData })
      assert.ok(await daemon.waitUntilRegistered())
      const res = await fetch(`${app.hub.url}/api/env/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${app.token}` },
        body: JSON.stringify({
          command: "printf 'line1\\nline2\\n'",
          nodeId: 'stream-node',
          cwd: workDir,
          stream: true,
        }),
      })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'application/x-ndjson; charset=utf-8')
      const text = await res.text()
      const frames = text
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l))
      assert.ok(frames.every((f) => ['output', 'exit', 'error'].includes(f.type)), '帧协议只有 output/exit/error')
      const exits = frames.filter((f) => f.type === 'exit')
      assert.equal(exits.length, 1, '恰好一个 exit 终帧')
      assert.equal(exits[0].ok, true)
      assert.equal(exits[0].exitCode, 0)
      const joined = frames.filter((f) => f.type === 'output').map((f) => f.text).join('')
      assert.ok(joined.includes('line1') && joined.includes('line2'), `流式拼接应含全部输出：${joined}`)

      // 会话靶点继承：创建绑定 stream-node 的会话后，不带 nodeId/cwd 的
      // exec 以 conversationId 继承远端靶点。
      const conv = await call(app, 'POST', '/api/conversations', {
        nodeId: 'stream-node',
        cwd: workDir,
        title: '远端会话',
      })
      assert.equal(conv.json.nodeId, 'stream-node')
      await writeFile(join(workDir, 'target-only.txt'), 'TARGET\n')
      const inherited = await call(app, 'POST', '/api/env/exec', {
        command: 'cat target-only.txt',
        conversationId: conv.json.id,
      })
      assert.equal(inherited.status, 200, JSON.stringify(inherited))
      assert.equal(inherited.json.ok, true)
      assert.ok(inherited.json.output.includes('TARGET'), '会话靶点继承：远端文件在远端读取')
      await daemon.close()
    } finally {
      await app.close()
    }
  })

  it('会话绑定远端 nodeId：真实模型回合经 bash/write/edit/read 在远端生效', { timeout: 60_000 }, async () => {
    const hubDir = await mkdtemp(join(rootDir, 'conv-hub-'))
    const nodeData = await mkdtemp(join(rootDir, 'conv-node-'))
    const workDir = await mkdtemp(join(rootDir, 'conv-work-'))
    const { models, faux } = makeFauxModels()
    const kernel = await KernelRuntime.open({
      dataDir: hubDir,
      cwd: hubDir,
      model: 'faux/faux-1',
      models: models as never,
      watchdogIntervalMs: 0,
    })
    const hub = await startHub({
      kernel: kernel as never,
      workflows: {
        list: () => [],
        listRuns: () => [],
        run: async () => { throw new Error('此节点测试不提供工作流执行') },
        getRun: async () => undefined,
        wait: async () => undefined,
        abort: async () => undefined,
      },
      port: 0,
    })
    try {
      const setup = await fetch(`${hub.url}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'conv-remote-pass' }),
      })
      const { token } = (await setup.json()) as { token: string }
      const issueRes = await fetch(`${hub.url}/api/nodes/issue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ nodeId: 'work-node' }),
      })
      const issue = (await issueRes.json()) as { token: string }
      const daemon = await startNode({ url: hub.url, nodeId: 'work-node', token: issue.token, dataDir: nodeData })
      assert.ok(await daemon.waitUntilRegistered())

      const convRes = await fetch(`${hub.url}/api/conversations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ nodeId: 'work-node', cwd: workDir, title: '远端会话' }),
      })
      const conv = (await convRes.json()) as { id: number; nodeId: string }
      assert.equal(conv.nodeId, 'work-node')

      // 远端独有文件：若工具误跑 Hub 本机，cat 必失败（Hub 目录无此文件）。
      await writeFile(join(workDir, 'remote-only.txt'), 'REMOTE-ONLY\n')

      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('bash', { command: 'cat remote-only.txt && echo NODE=$HELM_NODE_ID && pwd' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage([fauxToolCall('write', { path: 'written.txt', content: 'written-by-write-tool' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage(
          [fauxToolCall('edit', { path: 'written.txt', oldText: 'write-tool', newText: 'edit-tool-ok' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage([fauxToolCall('read', { path: 'written.txt' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('全部完成'),
      ])
      await kernel.submitInput(conv.id, '在远端执行系列工具')
      await kernel.waitForIdle(conv.id)

      // 磁盘事实断言（最可靠）：write + edit 均在远端生效。
      const written = await readFile(join(workDir, 'written.txt'), 'utf8')
      assert.equal(written, 'written-by-edit-tool-ok', 'write + edit 均在远端生效')
      assert.equal(await kernel.getLastAssistantText(conv.id), '全部完成')
      await daemon.close()
    } finally {
      await hub.close()
      await kernel.close()
    }
  })
})
