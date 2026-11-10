/**
 * 目标节点文件互斥队列（对齐 pi-durable 的 withFileMutationQueue）。
 *
 * 为什么需要：内核 write/edit 与插件自定义文件读改写在同一 Hub 进程内并发
 * 时（同一回合、多会话、后台服务），互相「读同一旧内容后各自写回」会丢更新。
 * 以「文件系统 id + canonical 路径」为 key 的进程级队列让所有调用方严格排队。
 *
 * 与 pi-durable 的关系（语义对齐、实现独立）：
 * - pi-durable 的 tools/write、tools/edit 内部用同一算法的
 *   withFileMutationQueue 串行化，但该函数未从包 exports 暴露（deep import
 *   违反封装边界），且 helm 的 write/edit 是内核自带工具、不经 SDK 工具；
 * - 因此本模块在 helm 进程内提供同一语义的队列，并把内核 write/edit 与
 *   插件 API（EnvFabric.withFileMutationQueue）都接到这一份实现上。
 *
 * 锁契约：
 * - key = `${文件系统 id}\\0${canonical 路径}`；local 底座 id 恒为 'node:local'
 *   （Hub 本机文件系统），远端底座 id 为 'remote:<nodeId>'（每节点一台文件
 *   系统）——不同节点的同形路径天然不同 key，互不阻塞；
 * - canonical：realpath 解析软链别名（不同写法指向同一文件共享一把锁）；
 *   新文件（尚不存在）取「最近存在祖先的 canonical + 剩余段」拼接，保证
 *   「创建它的 write」与「之后的 edit」同 key；整条链都不存在时退化为
 *   词法绝对路径（进程内仍互斥；跨进程无锁承诺，见下）；
 * - 只锁 fn 执行窗口（读-改-写），不锁无关文件、不阻塞读操作；
 * - 队列条目在结算后自清理，长运行进程无泄漏；
 * - 不可重入：fn 内不得再对同一文件入队（死锁）。fn 内可安全调用底层
 *   writeFile（队列只包 fn，绝不递归入队）。
 *
 * 诚实边界（不承诺的）：
 * - 不是对 bash / 其他进程的锁——shell 与外部工具仍可能并发改文件；
 * - 不是跨进程/跨 Hub 的分布式锁：同一远端节点如有第二个 Hub 进程接入，
 *   两个 Hub 各自的队列互不可见。当前部署模型一个节点只接一个 Hub；
 * - 可信插件仍可直接 node:fs / bash 绕过本队列（无沙箱承诺）。
 */

import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context'
import type { ExecutionEnv, FileError } from '@earendil-works/pi-durable/env'

/** 每文件链尾（Promise<void>：前序任务完成即 resolve）。 */
const queues = new Map<string, Promise<void>>()

/** 
 * 排队等待取消：队列条目未获得锁且 signal 已中止时立即拒绝（不执行 fn，
 * 也不等前序任务）。释放已占的队列位置，后续任务照常入队。
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError')
}

/** env 调用失败上抛（Result 模型归一为异常，错误如实传播不吞）。 */
async function unwrapOrThrow<T>(result: { ok: true; value: T } | { ok: false; error: FileError }): Promise<T> {
  if (result.ok) return result.value
  throw result.error
}

/**
 * canonical 路径：文件不存在时取「canonical 父目录 + 文件名」逐级上溯
 * （软链目录下的新文件与创建它的 write / 后续 edit 同 key）。
 */
async function canonicalPath(env: ExecutionEnv, absolutePath: string, context: Context): Promise<string> {
  const direct = await env.canonicalPath(absolutePath, context)
  if (direct.ok) return direct.value
  if (direct.error.code === 'not_supported') return absolutePath
  if (direct.error.code !== 'not_found') throw direct.error
  // 环境按分隔符拆分路径：名字可能含其他文件系统的分隔符字符。
  const parent = await unwrapOrThrow(await env.joinPath([absolutePath, '..'], context))
  if (parent === absolutePath || !absolutePath.startsWith(parent)) return absolutePath
  const name = absolutePath.slice(parent.length + (/[/\\]$/.test(parent) ? 0 : 1))
  if (name === '') return absolutePath
  const parentCanonical = await canonicalPath(env, parent, context)
  return unwrapOrThrow(await env.joinPath([parentCanonical, name], context))
}

/** 队列 key：文件系统 id + canonical 路径。 */
async function mutationKey(env: ExecutionEnv, path: string, context: Context): Promise<string> {
  const absolute = await unwrapOrThrow(await env.absolutePath(path, context))
  return `${env.id}\u0000${await canonicalPath(env, absolute, context)}`
}

/**
 * 同一文件（canonical）的变更严格串行：先占位后执行，队列永不泄漏，
 * fn 抛错/被取消也释放（finally），下一任务立即可入队。
 * 并发同文件调用按「key 解析完成的顺序」排队（与 pi-durable 一致）。
 */
export async function envWithFileMutationQueue<T>(
  env: ExecutionEnv,
  path: string,
  fn: () => Promise<T>,
  context: Context,
): Promise<T> {
  const key = await mutationKey(env, path, context)
  const previous = queues.get(key) ?? Promise.resolve()
  let release!: () => void
  const done = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => done)
  queues.set(key, tail)
  try {
    // 排队等待中取消：立即让位（不执行 fn、不占队列头）；已持锁的任务
    // 不受排队取消影响（下一个检查点在前序释放之后自然通过或拒绝）。
    throwIfAborted(context.abortSignal)
    await previous
    throwIfAborted(context.abortSignal)
    return await fn()
  } finally {
    release()
    if (queues.get(key) === tail) queues.delete(key)
  }
}

/** 队列内现存条目数（诊断/测试内省）。 */
export function fileMutationQueueSize(): number {
  return queues.size
}

// ---------------------------------------------------------------------------
// local 直连变体：无 ExecutionEnv（tools.ts 的 local 分支直接用 fs/promises）。
// canonical 直接用 node:fs realpath，语义与 NodeExecutionEnv.canonicalPath 一致。
// ---------------------------------------------------------------------------

import { realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

async function localCanonical(absolutePath: string): Promise<string> {
  try {
    return await realpath(absolutePath)
  } catch {
    // 不存在：canonical 父目录 + 文件名（对齐 pi-durable 的 not_found 分支）。
    return join(await localCanonical(dirname(absolutePath)), basename(absolutePath))
  }
}

/** local Hub 磁盘文件的互斥队列（与经 ExecutionEnv 的 local 底座同 key 空间：
 *  key 前缀同为 'node:local'，canonical 算法一致，因此两种入口互斥）。 */
export async function localWithFileMutationQueue<T>(
  absolutePath: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const context = signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT)
  const key = `node:local\u0000${await localCanonical(absolutePath)}`
  const previous = queues.get(key) ?? Promise.resolve()
  let release!: () => void
  const done = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => done)
  queues.set(key, tail)
  try {
    throwIfAborted(context.abortSignal)
    await previous
    throwIfAborted(context.abortSignal)
    return await fn()
  } finally {
    release()
    if (queues.get(key) === tail) queues.delete(key)
  }
}
