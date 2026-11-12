/**
 * 节点升级排空（node_draining）在 kernel 侧的消费语义：
 * - fabric.ipcCall：RpcResult 原样保留 node_draining 错误码（连接仍在，
 *   由调用方分型，不吞成 aborted/unknown）；
 * - fabric.ipcSubscribe：排空拒新抛 HelmError node_draining(503)，
 *   与 ipc_subscribe_failed(502) 区分，且 onClosed 恰好回调一次；
 * - remote-env exec：节点 envExec 返回 node_draining 时错误码运行时透传
 *   （不被归并为 aborted/unknown），立即失败、不触发等待重连
 *  （节点在线，排空 ≠ 离线）；真实取消仍为 aborted。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import { HelmError, type NodeEnvRpcFunctions } from '@helm/protocol'
import type { WebSocket as WsSocket } from 'ws'
import { createEnvFabric } from '../src/env/fabric.js'
import { NodeRegistry } from '../src/env/registry.js'
import { RemoteExecutionEnv, type NodeRpcResolver } from '../src/env/remote-env.js'

class FakeSocket extends EventEmitter {
  OPEN = 1
  CLOSED = 3
  readyState = 1
  close() { this.readyState = 3; this.emit('close') }
}

/** 注册假节点（鉴权恒过），可注入任意 env RPC 函数（ipcSubscribe 等）。 */
async function registerFakeNode(registry: NodeRegistry, nodeId: string, rpc: Record<string, unknown>): Promise<FakeSocket> {
  const socket = new FakeSocket()
  const outcome = await registry.register(
    socket as unknown as WsSocket,
    { nodeId, token: `${nodeId}:secret`, hostname: 'h', platform: 'linux' },
    () => ({ $close() {}, ...rpc }) as never,
  )
  assert.equal(outcome.accepted, true)
  return socket
}

test('fabric.ipcCall：排空拒新 RpcResult 保留 node_draining 原码（不拋不吞）', { timeout: 60_000 }, async () => {
  const fabric = createEnvFabric({ authenticate: () => true })
  try {
    const socket = await registerFakeNode(fabric.registry, 'drain-node', {
      ipcCall: async () => ({
        ok: false,
        error: { code: 'node_draining', message: 'daemon is draining (upgrade in progress), rejecting new IPC calls' },
      }),
      ipcAbortCall: async () => undefined,
    })
    const result = await fabric.ipcCall('drain-node', { line: 'ping' })
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.error.code, 'node_draining')
    assert.match(!result.ok ? result.error.message : '', /draining/)
    socket.close()
  } finally {
    await fabric.dispose()
  }
})

test('fabric.ipcSubscribe：排空拒新抛 HelmError node_draining(503)，onClosed 恰好一次', { timeout: 60_000 }, async () => {
  const fabric = createEnvFabric({ authenticate: () => true })
  try {
    const socket = await registerFakeNode(fabric.registry, 'drain-sub-node', {
      ipcSubscribe: async () => ({
        ok: false,
        error: { code: 'node_draining', message: 'daemon is draining (upgrade in progress), rejecting new IPC subscriptions' },
      }),
      ipcUnsubscribe: async () => undefined,
    })
    let closed = 0
    await assert.rejects(
      fabric.ipcSubscribe('drain-sub-node', { line: 'hello' }, () => undefined, () => { closed += 1 }),
      (error: unknown) =>
        error instanceof HelmError && error.code === 'node_draining' && error.status === 503 && /draining/.test(error.message),
    )
    // 订阅未建立：finish 已在拒绝路径回调 onClosed（无泄漏等待）。
    await delay(20)
    assert.equal(closed, 1)
    socket.close()
  } finally {
    await fabric.dispose()
  }
})

test('remote-env exec：node_draining 运行时透传（非 aborted/unknown），不等待重连', { timeout: 60_000 }, async () => {
  let waitCalled = 0
  const drainingRpc = {
    envExec: async () => ({
      ok: false,
      error: { code: 'node_draining', message: 'daemon is draining (upgrade in progress), rejecting new commands' },
    }),
    envAbortExec: async () => undefined,
  } as unknown as NodeEnvRpcFunctions
  const resolver: NodeRpcResolver = {
    getNodeEnvRpc: () => drainingRpc,
    // 排空期间节点在线：不应走到等待重连（走到即语义错误）。
    waitForNodeOnline: () => {
      waitCalled += 1
      return Promise.resolve(drainingRpc)
    },
  }
  const env = new RemoteExecutionEnv(resolver, { nodeId: 'draining-node', cwd: '/w' })

  const startedAt = Date.now()
  const result = await env.exec('echo hi', undefined, BACKGROUND_CONTEXT)
  const elapsed = Date.now() - startedAt

  assert.equal(result.ok, false)
  // 运行时错误码原样保留：上层可区分「节点正在升级排空」与
  // aborted（取消）/unknown（断连结果未知），绝不归并。
  assert.equal(!result.ok && result.error.code, 'node_draining')
  assert.match(!result.ok ? result.error.message : '', /draining/)
  // 立即失败（有界返回，不进入重连等待）。
  assert.ok(elapsed < 2_000, `应在有界时间内返回（实际 ${elapsed}ms）`)
  assert.equal(waitCalled, 0, '节点在线期间排空拒绝不得触发 waitForNodeOnline')
})

test('remote-env exec：真实取消仍为 aborted（不因排空码改动回归）', { timeout: 60_000 }, async () => {
  const rpc = {
    // 模拟用户取消：节点侧命令被 abort，RPC 返回 aborted。
    envExec: async () => ({ ok: false, error: { code: 'aborted', message: 'Command aborted' } }),
    envAbortExec: async () => undefined,
  } as unknown as NodeEnvRpcFunctions
  const resolver: NodeRpcResolver = { getNodeEnvRpc: () => rpc }
  const env = new RemoteExecutionEnv(resolver, { nodeId: 'cancel-node', cwd: '/w' })
  const controller = new AbortController()
  const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT)
  const result = await env.exec('sleep 5', undefined, context)
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.error.code, 'aborted', '真实取消必须保持 aborted')
})
