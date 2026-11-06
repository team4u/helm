/**
 * 进程内按真实路径共享的文件串行器。
 * 为什么不用实例级队列：AuthService 内部、runtime、插件各自 new 的
 * ConfigService / CredentialService 是不同实例，实例队列挡不住跨实例
 * 「并发读同一旧文件后互相覆盖」。以真实路径为 key 的进程级锁才能让
 * 同一 dataDir 的全部实例串行读改写。
 * 诚实边界：仅进程内互斥；跨进程（多 Hub 进程共用一个 dataDir）不在此承诺。
 * 不可重入：fn 内部不得再对同一 path 加锁（会死锁）。
 */
import { realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const locks = new Map<string, Promise<unknown>>()

/** 锁 key 归一化：优先真实路径（dataDir 为软链时不同写法仍共享同一把锁）。 */
async function lockKey(path: string): Promise<string> {
  const real = await realpath(path).catch(() => undefined)
  if (real !== undefined) return real
  const dirReal = await realpath(dirname(path)).catch(() => undefined)
  if (dirReal !== undefined) return join(dirReal, basename(path))
  return resolve(path)
}

/** 以 path 为互斥 key 串行执行 fn；同 key 的所有调用（跨实例）严格按序排队。 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = await lockKey(path)
  const prev = locks.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => undefined)
  locks.set(key, tail)
  // 尾部结算后清理，防止长期运行进程的 Map 无界增长。
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key)
  })
  return run
}
