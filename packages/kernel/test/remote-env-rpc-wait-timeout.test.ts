/**
 * Bounded RPC waiting tests for remote file operations (env/remote-env.ts #rpcBounded):
 * - When the node disconnects inside a withFileMutationQueue lock window and never reconnects:
 *   throws node_offline after rpcWaitTimeoutMs (releasing the lock in catch/finally) so subsequent
 *   queued operations on the same file are never frozen;
 * - When the node reconnects (wait resolves), subsequent queued tasks run normally without breaking
 *   mutual exclusion semantics;
 * - Queue wait time prior to entering the lock does not count against rpcWaitTimeoutMs (which bounds
 *   only the RPC wait itself).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { HelmxError } from '@helmx/protocol'
import { RemoteExecutionEnv, type NodeRpcResolver } from '../src/env/remote-env.js'
import { envWithFileMutationQueue, fileMutationQueueSize } from '../src/env/file-mutation-queue.js'
import type { NodeEnvRpcFunctions } from '@helmx/protocol'

/**
 * Controllable mock node backed by an in-memory file map: once online flips to false,
 * getNodeEnvRpc returns undefined and waitForNodeOnline stays pending until flipped back to true.
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
    /** Simulates node reconnect by waking all pending waiters. */
    reconnect: () => {
      state.online = true
      for (const wake of waiters) wake()
      waiters = []
    },
  }
}

const WAIT_MS = 200

describe('RemoteExecutionEnv bounded RPC wait for file operations', { timeout: 60_000 }, () => {
  test('disconnect inside lock window without reconnect: throws node_offline after timeout, releases lock, unblocks queue', { timeout: 60_000 }, async () => {
    const node = makeControlledNode()
    const env = new RemoteExecutionEnv(node.resolver, { nodeId: 'offline-node', cwd: '/w', rpcWaitTimeoutMs: WAIT_MS })
    const target = '/w/a.txt'

    // Task 1 acquires lock then immediately disconnects, causing an RPC inside the lock to await reconnect
    // (previously blocked forever and froze the entire queue).
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
    // Task 2 queues behind task 1 while lock is held (same file).
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

    // Task 1 must fail with node_offline within bounded time rather than waiting indefinitely.
    const startedAt = Date.now()
    await assert.rejects(
      task1,
      (error: unknown) => error instanceof HelmxError && error.code === 'node_offline',
      'RPC wait timeout inside lock must throw node_offline',
    )
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed < WAIT_MS * 5, `timeout must fire within bounded window (actual ${elapsed}ms)`)

    // Queue unblocks: once node reconnects, task 2 runs normally (mutex chain intact).
    node.reconnect()
    assert.equal(await task2, 'task2')
    assert.ok(task2Ran)
    assert.equal(node.files.get(target), 'v2')
    await delay(10)
    assert.equal(fileMutationQueueSize(), 0, 'queue empties once chain completes')
  })

  test('file operations stay unaffected while node is online (fast path without timeout overhead)', { timeout: 60_000 }, async () => {
    const node = makeControlledNode()
    const env = new RemoteExecutionEnv(node.resolver, { nodeId: 'online-node', cwd: '/w', rpcWaitTimeoutMs: WAIT_MS })
    const result = await env.writeFile('/w/b.txt', 'content', BACKGROUND_CONTEXT)
    assert.equal(result.ok, true)
    assert.equal(node.files.get('/w/b.txt'), 'content')
  })

  test('key resolution (absolutePath/canonicalPath) is also bounded: fails fast when offline instead of hanging', { timeout: 60_000 }, async () => {
    const node = makeControlledNode()
    node.state.online = false
    const env = new RemoteExecutionEnv(node.resolver, { nodeId: 'dead-node', cwd: '/w', rpcWaitTimeoutMs: WAIT_MS })
    await assert.rejects(
      envWithFileMutationQueue(env, '/w/c.txt', async () => 'never', BACKGROUND_CONTEXT),
      (error: unknown) => error instanceof HelmxError && error.code === 'node_offline',
    )
    assert.equal(fileMutationQueueSize(), 0)
  })
})
