/**
 * node upgrade arrange empty (node_draining) in kernel side consume semantics:
 * - fabric.ipcCall:RpcResult original keep node_draining error code (connect still in,
 *   by caller type, do not swallow into aborted/unknown);
 * - fabric.ipcSubscribe: arrange empty refuse new throw HelmError node_draining(503),
 *   and ipc_subscribe_failed(502) zone, and onClosed exactly call back once;
 * - remote-env exec: node envExec return node_draining when error code runtime pass-through
 *   (do not by archive and is aborted/unknown), immediately failed, does not trigger wait for reconnect
 *  (node online, arrange empty ≠ offline); real cancel still is aborted.
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

/** register false node (authentication constant), can inject any env RPC function (ipcSubscribe etc.). */
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

test('fabric.ipcCall: arrange empty refuse new RpcResult keep node_draining original code (do not throw do not swallow)', { timeout: 60_000 }, async () => {
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

test('fabric.ipcSubscribe: arrange empty refuse new throw HelmError node_draining(503),onClosed exactly once', { timeout: 60_000 }, async () => {
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
    // subscribe not establish:finish already in reject path call back onClosed(without leak leak wait for).
    await delay(20)
    assert.equal(closed, 1)
    socket.close()
  } finally {
    await fabric.dispose()
  }
})

test('remote-env exec:node_draining runtime pass-through (non- aborted/unknown), without waiting reconnect', { timeout: 60_000 }, async () => {
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
    // arrange empty during node online: must not away to wait for reconnect (away to i.e. semantics error).
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
  // runtime error code original keep: on layer can zone node is now upgrade arrange empty and
  // aborted(cancel)/unknown(assert connect result unknown), never archive and.
  assert.equal(!result.ok && result.error.code, 'node_draining')
  assert.match(!result.ok ? result.error.message : '', /draining/)
  // immediately failed (has boundary return, does not enter reconnect wait for).
  assert.ok(elapsed < 2_000, `should in has boundary time inside return (actual ${elapsed}ms)`)
  assert.equal(waitCalled, 0, 'node online during arrange empty reject must not trigger waitForNodeOnline')
})

test('remote-env exec: real cancel still is aborted(do not because arrange empty code change regression)', { timeout: 60_000 }, async () => {
  const rpc = {
    // simulated user cancel: node side command by abort,RPC return aborted.
    envExec: async () => ({ ok: false, error: { code: 'aborted', message: 'Command aborted' } }),
    envAbortExec: async () => undefined,
  } as unknown as NodeEnvRpcFunctions
  const resolver: NodeRpcResolver = { getNodeEnvRpc: () => rpc }
  const env = new RemoteExecutionEnv(resolver, { nodeId: 'cancel-node', cwd: '/w' })
  const controller = new AbortController()
  const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT)
  const result = await env.exec('sleep 5', undefined, context)
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.error.code, 'aborted', 'real cancel must keep aborted')
})
