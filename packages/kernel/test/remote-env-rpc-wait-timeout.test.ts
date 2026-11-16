/**
 * remote file operation parse RPC has boundary wait for test (env/remote-env.ts #rpcBounded):
 * - withFileMutationQueue hold lock window inside node assert connect and forever do not reconnect: wait for rpcWaitTimeoutMs
 *   after throw node_offline(lock follow exception release), the file after continue queue up do not by freeze;
 * - node reconnect after (wait can solve) after continue queue up normal execute - - mutual exclusion semantics do not break;
 * - queue up itself in wait for before order when do not subject to the timeout affect (timeout only constraint RPC parse wait for).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { HelmError } from '@helm/protocol'
import { RemoteExecutionEnv, type NodeRpcResolver } from '../src/env/remote-env.js'
import { envWithFileMutationQueue, fileMutationQueueSize } from '../src/env/file-mutation-queue.js'
import type { NodeEnvRpcFunctions } from '@helm/protocol'

/**
 * subject to control node:files is memory file table;online translate rotate is false after getNodeEnvRpc return
 * undefined,waitForNodeOnline forever do not resolve(simulated assert connect after forever do not reconnect), direct until
 * translate back true.
 */
function makeControlledNode() {
  const files = new Map<string, string>()
  const state = { online: true }
  const rpc = {
    envAbsolutePath: async ({ path }: { path: string }) => ({ ok: true as const, value: path }),
    envJoinPath: async ({ parts }: { parts: string[] }) => {
      const segs: string[] = []
      for (const seg of parts.join('/').split('/')) {
        if (seg === '' || seg === '.') continue
        if (seg === '..') segs.pop()
        else segs.push(seg)
      }
      return { ok: true as const, value: '/' + segs.join('/') }
    },
    envCanonicalPath: async ({ path }: { path: string }) =>
      files.has(path)
        ? { ok: true as const, value: path }
        : { ok: false as const, error: { code: 'not_found', message: `ENOENT: ${path}` } },
    envCreateDir: async () => ({ ok: true as const, value: null }),
    envWriteFile: async ({ path, content }: { path: string; content: string }) => {
      files.set(path, content)
      return { ok: true as const, value: null }
    },
  } as unknown as NodeEnvRpcFunctions
  let waiters: (() => void)[] = []
  const resolver: NodeRpcResolver = {
    getNodeEnvRpc: () => (state.online ? rpc : undefined),
    waitForNodeOnline: () =>
      new Promise((resolve) => {
        if (state.online) return resolve(rpc)
        waiters.push(() => resolve(rpc))
      }),
  }
  return {
    files,
    state,
    resolver,
    rpc,
    /** simulated node reconnect: wake all wait for. */
    reconnect: () => {
      state.online = true
      for (const wake of waiters) wake()
      waiters = []
    },
  }
}

const WAIT_MS = 200

describe('RemoteExecutionEnv file operation RPC has boundary wait for', { timeout: 60_000 }, () => {
  test('hold lock window inside assert connect and forever do not reconnect: timeout throw node_offline release lock, queue up do not by freeze', { timeout: 60_000 }, async () => {
    const node = makeControlledNode()
    const env = new RemoteExecutionEnv(node.resolver, { nodeId: 'offline-node', cwd: '/w', rpcWaitTimeoutMs: WAIT_MS })
    const target = '/w/a.txt'

    // task 1 hold lock after immediately assert connect, lock inside write unbounded wait for reconnect (fix before will freeze whole queue).
    let lockHeld = false
    const task1 = envWithFileMutationQueue(
      env,
      target,
      async () => {
        lockHeld = true
        node.state.online = false
        const result = await env.writeFile(target, 'v1', BACKGROUND_CONTEXT)
        return result
      },
      BACKGROUND_CONTEXT,
    )
    // task 2 in task 1 hold lock during queue (same file).
    while (!lockHeld) await delay(5)
    let task2Ran = false
    const task2 = envWithFileMutationQueue(
      env,
      target,
      async () => {
        task2Ran = true
        const result = await env.writeFile(target, 'v2', BACKGROUND_CONTEXT)
        if (!result.ok) throw new Error(result.error.message)
        return 'task2'
      },
      BACKGROUND_CONTEXT,
    )

    // task 1 must in has boundary time inside with node_offline failed (while non- unbounded wait for).
    const startedAt = Date.now()
    await assert.rejects(
      task1,
      (error: unknown) => error instanceof HelmError && error.code === 'node_offline',
      'hold lock window inside RPC wait timed out must throw node_offline',
    )
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed < WAIT_MS * 5, `timeout should in has boundary time inside trigger (actual ${elapsed}ms)`)

    // queue solve freeze: node reconnect after task 2 normal execute (mutual exclusion chain not break).
    node.reconnect()
    assert.equal(await task2, 'task2')
    assert.ok(task2Ran)
    assert.equal(node.files.get(target), 'v2')
    await delay(10)
    assert.equal(fileMutationQueueSize(), 0, 'chain all compute after queue empty')
  })

  test('node online during file operation do not subject to affect (fast path without timeout overhead semantics)', { timeout: 60_000 }, async () => {
    const node = makeControlledNode()
    const env = new RemoteExecutionEnv(node.resolver, { nodeId: 'online-node', cwd: '/w', rpcWaitTimeoutMs: WAIT_MS })
    const result = await env.writeFile('/w/b.txt', 'content', BACKGROUND_CONTEXT)
    assert.equal(result.ok, true)
    assert.equal(node.files.get('/w/b.txt'), 'content')
  })

  test('key parse (absolutePath/canonicalPath) same has boundary: offline when fast failed while non- suspended', { timeout: 60_000 }, async () => {
    const node = makeControlledNode()
    node.state.online = false
    const env = new RemoteExecutionEnv(node.resolver, { nodeId: 'dead-node', cwd: '/w', rpcWaitTimeoutMs: WAIT_MS })
    await assert.rejects(
      envWithFileMutationQueue(env, '/w/c.txt', async () => 'never', BACKGROUND_CONTEXT),
      (error: unknown) => error instanceof HelmError && error.code === 'node_offline',
    )
    assert.equal(fileMutationQueueSize(), 0)
  })
})
