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
 * - key = `${文件系统 id}\u0000${canonical 路径}`；local 底座 id 恒为 'node:local'
 *   （Hub 本机文件系统），远端底座 id 为 'remote:<nodeId>'（每节点一台文件
 *   系统）——不同节点的同形路径天然不同 key，互不阻塞；
 * - canonical：realpath 解析软链别名（不同写法指向同一文件共享一把锁）；
 *   新文件（尚不存在）取「最近存在祖先的 canonical + 剩余段」拼接，保证
 *   「创建它的 write」与「之后的 edit」同 key；整条链都不存在时退化为
 *   词法绝对路径（进程内仍互斥；跨进程无锁承诺，见下）；
 * - 只锁 fn 执行窗口（读-改-写），不锁无关文件、不阻塞读操作；
 * - 队列条目按链尾结算自清理：被取消的排队者立即释放执行权，但其 Map 占位
 *   保留到前序结算后才消失——绝不提前删掉仍在运行的头部锁（否则后续新任务
 *   会与持锁者并发）；长运行进程无泄漏；
 * - 排队中被取消：与前序任务竞争等待，signal 先到立即拒绝（不等前序、不执行
 *   fn），abort listener 无论去向均清理；
 * - 不可重入：同一异步链（AsyncLocalStorage 传播）内对同一 key 嵌套入队立即
 *   显式报错 `file_mutation_queue_reentrant`，绝不静默挂死。fn 内直接调用底层
 *   writeFile（不再次入队）合法；绕过本进程异步链发起的嵌套（如独立 HTTP
 *   请求回调绕回）无法检测，仍按普通排队语义等待。
 *
 * 诚实边界（不承诺的）：
 * - 不是对 bash / 其他进程的锁——shell 与外部工具仍可能并发改文件；
 * - 不是跨进程/跨 Hub 的分布式锁：同一远端节点如有第二个 Hub 进程接入，
 *   两个 Hub 各自的队列互不可见。当前部署模型一个节点只接一个 Hub；
 * - 可信插件仍可直接 node:fs / bash 绕过本队列（无沙箱承诺）。
 */

import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context'
import type { ExecutionEnv, FileError } from '@earendil-works/pi-durable/env'
import { AsyncLocalStorage } from 'node:async_hooks'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** 每文件链尾（Promise<void>：链上前序任务全部结算即 resolve，绝不 reject）。 */
const queues = new Map<string, Promise<void>>()

/** 当前异步链持有的锁 key 集（嵌套重入检测）。 */
const activeKeys = new AsyncLocalStorage<Set<string>>()

/** env 调用失败上抛（Result 模型归一为异常，错误如实传播不吞）。 */
async function unwrapOrThrow<T>(result: { ok: true; value: T } | { ok: false; error: FileError }): Promise<T> {
  if (result.ok) return result.value
  throw result.error
}

/**
 * canonical 路径：文件不存在时取「canonical 父目录 + 文件名」逐级上溯
 * （软链目录下的新文件与创建它的 write / 后续 edit 同 key）。ENOTDIR
 * （路径中某段是文件而非目录，pi-durable 与节点侧 local-env 映射
 * not_directory）与 ENOENT 同按「不存在」上溯：与 localCanonical 及内核
 * 工具的探测链一致，否则同一 `/已存在文件/x` 路径会在两入口算出不同 key
 *（local 直连上溯、env 入口抛错），双锁与报错分叉都由此而来。
 */
async function canonicalPath(env: ExecutionEnv, absolutePath: string, context: Context): Promise<string> {
  const direct = await env.canonicalPath(absolutePath, context)
  if (direct.ok) return direct.value
  if (direct.error.code === 'not_supported') return absolutePath
  if (direct.error.code !== 'not_found' && direct.error.code !== 'not_directory') throw direct.error
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
 * local canonical：与 canonicalPath 同语义，直接用 node:fs realpath。
 * 仅 ENOENT / ENOTDIR（路径组件缺失）按「不存在」上溯拼接；EACCES / EIO 等
 * 如实上抛（吞掉会把真实故障伪装成不存在，违反诚实性纪律）。
 */
async function localCanonical(absolutePath: string): Promise<string> {
  try {
    return await realpath(absolutePath)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    const parent = dirname(absolutePath)
    // 根终止：父即自身（realpath('/') 失败的病态文件系统），绝不再递归。
    if (parent === absolutePath) return absolutePath
    return join(await localCanonical(parent), basename(absolutePath))
  }
}

/** 重入检测：同 key 已被当前异步链持有时立即显式报错（绝不静默挂死）。 */
function assertNotReentrant(key: string): void {
  if (activeKeys.getStore()?.has(key)) {
    const canonical = key.split('\u0000')[1] ?? key
    throw new Error(
      `file_mutation_queue_reentrant: 路径 ${canonical} 的互斥队列不可重入——fn 内不得再对同一文件入队` +
        '（常见成因：持锁窗口内调用同样会对该文件入队的 write/edit；请在锁外发起，或改为在 fn 内直接底层写入）',
    )
  }
}

/** 在「持有 key」的异步上下文中执行 fn（供嵌套调用重入检测）。 */
async function runWithKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const store = new Set(activeKeys.getStore())
  store.add(key)
  return activeKeys.run(store, fn)
}

/**
 * 共享调度核心（env / local 两入口唯一实现，消除重复）：
 * - 占位后与前序任务竞争 signal：排队中被取消立即拒绝（不等前序、不执行
 *   fn），abort listener 无论去向均清理；前序先结算则进入执行窗口，窗口内
 *   取消交由 fn 自身的 signal 语义；
 * - finally 无条件释放本位（done），Map 条目删除只在链尾自身结算之后——
 *   被取消排队者的占位随前序结算自然消失，绝不提前删掉仍在运行的头部锁。
 */
async function runQueued<T>(
  key: string,
  previous: Promise<void>,
  fn: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  assertNotReentrant(key)
  let release!: () => void
  const done = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => done)
  queues.set(key, tail)
  // 链尾结算（前序完成 + 本位释放）后才允许删除 Map 条目。
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  try {
    if (signal === undefined) {
      await previous
    } else {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => reject(new DOMException('This operation was aborted', 'AbortError'))
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
        void previous.then(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        })
      })
    }
    return await runWithKey(key, fn)
  } finally {
    release()
  }
}

/**
 * 同一文件（canonical）的变更严格串行；排队中取消立即拒绝（见 runQueued）。
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
  return runQueued(key, previous, fn, context.abortSignal)
}

/**
 * local Hub 磁盘文件的互斥队列（与经 ExecutionEnv 的 local 底座同 key 空间：
 * key 前缀同为 'node:local'，canonical 算法一致，因此两种入口互斥）。
 */
export async function localWithFileMutationQueue<T>(
  absolutePath: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const key = `node:local\u0000${await localCanonical(absolutePath)}`
  const previous = queues.get(key) ?? Promise.resolve()
  return runQueued(key, previous, fn, signal)
}

/** 队列内现存条目数（诊断/测试内省；不进 env/index 公共出口）。 */
export function fileMutationQueueSize(): number {
  return queues.size
}
