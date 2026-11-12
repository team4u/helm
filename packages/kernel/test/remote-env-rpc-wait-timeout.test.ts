/**
 * 远端文件操作解析 RPC 的有界等待测试（env/remote-env.ts #rpcBounded）：
 * - withFileMutationQueue 持锁窗口内节点断连且永不重连：等待 rpcWaitTimeoutMs
 *   后抛 node_offline（锁随异常释放），该文件的后续排队者不被冻结；
 * - 节点重连后（wait 可解）后续排队者正常执行——互斥语义不破坏；
 * - 排队者自身在等待前序时不受该超时影响（超时只约束 RPC 解析等待）。
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
 * 受控节点：files 为内存文件表；online 翻转为 false 后 getNodeEnvRpc 返回
 * undefined、waitForNodeOnline 永不 resolve（模拟断连后永不重连），直至
 * 翻回 true。
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
    /** 模拟节点重连：唤醒全部等待者。 */
    reconnect: () => {
      state.online = true
      for (const wake of waiters) wake()
      waiters = []
    },
  }
}

const WAIT_MS = 200

describe('RemoteExecutionEnv 文件操作 RPC 有界等待', { timeout: 60_000 }, () => {
  test('持锁窗口内断连且永不重连：超时抛 node_offline 释放锁，排队者不被冻结', { timeout: 60_000 }, async () => {
    const node = makeControlledNode()
    const env = new RemoteExecutionEnv(node.resolver, { nodeId: 'offline-node', cwd: '/w', rpcWaitTimeoutMs: WAIT_MS })
    const target = '/w/a.txt'

    // 任务 1 持锁后立刻断连，锁内 write 无限等待重连（修复前会冻结整条队列）。
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
    // 任务 2 在任务 1 持锁期间入队（同文件）。
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

    // 任务 1 必须在有界时间内以 node_offline 失败（而非无限等待）。
    const startedAt = Date.now()
    await assert.rejects(
      task1,
      (error: unknown) => error instanceof HelmError && error.code === 'node_offline',
      '持锁窗口内的 RPC 等待超时必须抛 node_offline',
    )
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed < WAIT_MS * 5, `超时应在有界时间内触发（实际 ${elapsed}ms）`)

    // 队列解冻：节点重连后任务 2 正常执行（互斥链未破坏）。
    node.reconnect()
    assert.equal(await task2, 'task2')
    assert.ok(task2Ran)
    assert.equal(node.files.get(target), 'v2')
    await delay(10)
    assert.equal(fileMutationQueueSize(), 0, '链全部结算后队列清空')
  })

  test('节点在线期间文件操作不受影响（快速路径无超时开销语义）', { timeout: 60_000 }, async () => {
    const node = makeControlledNode()
    const env = new RemoteExecutionEnv(node.resolver, { nodeId: 'online-node', cwd: '/w', rpcWaitTimeoutMs: WAIT_MS })
    const result = await env.writeFile('/w/b.txt', 'content', BACKGROUND_CONTEXT)
    assert.equal(result.ok, true)
    assert.equal(node.files.get('/w/b.txt'), 'content')
  })

  test('键解析（absolutePath/canonicalPath）同样有界：离线时快速失败而非挂起', { timeout: 60_000 }, async () => {
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
