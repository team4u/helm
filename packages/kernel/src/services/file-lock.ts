/**
 * 进程内按真实路径共享的文件串行器。
 * 为什么不用实例级队列：AuthService 内部、runtime、插件各自 new 的
 * ConfigService / CredentialService 是不同实例，实例队列挡不住跨实例
 * 「并发读同一旧文件后互相覆盖」。以真实路径为 key 的进程级锁才能让
 * 同一 dataDir 的全部实例串行读改写。
 * 进程内互斥见 withFileLock；跨进程互斥见 withProcessFileLock。
 * 不可重入：fn 内部不得再对同一 path 加锁（会死锁）。
 */
import { realpath, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'

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

// ---------------------------------------------------------------------------
// 跨进程文件锁：同一文件可能由多个 Hub/管理进程读改写，
// 仅进程内串行挡不住跨进程「并发读同一旧文件后互相覆盖」。
// 锁协议：
//   锁文件为 <目标文件>.lock，O_EXCL 创建，内容首字段为持有者 PID（十进制）。
//   只在 PID 确认死亡（ESRCH）时视为 stale 破除并重试；不按存活时长强拆
//   （合法持锁者可能只是慢）。坏锁内容/无法判定时显式报错，绝不猜测。
//   释放仅删除自己持有的锁文件（防误删他人紧接创建的新锁）。
//   不可重入：同进程内先经 withFileLock 串行，再进本锁。
// ---------------------------------------------------------------------------

const PROCESS_LOCK_WAIT_MS = 10_000
const PROCESS_LOCK_POLL_MS = 25
/** 锁文件刚创建但内容尚未写完的宽限期：期内空/半截内容视为正在写入。 */
const FRESH_LOCK_GRACE_MS = 1_500

interface LockOwner {
  pid: number | undefined
}

function parseLockOwner(text: string): LockOwner | undefined {
  const head = text.trim().split(/\s+/)[0] ?? ''
  if (!/^\d+$/.test(head)) return undefined
  return { pid: Number(head) }
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 跨进程排他锁下执行 fn；锁文件为 `${path}.lock`。
 * 与 CLI 的锁实现协议兼容：双方可互相排队、互斥同一目标文件。
 */
export async function withProcessFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockFile = `${path}.lock`
  const owner = `${process.pid} ${randomUUID()}`
  const deadline = Date.now() + PROCESS_LOCK_WAIT_MS
  for (;;) {
    try {
      await writeFile(lockFile, `${owner}\n`, { flag: 'wx', mode: 0o600 })
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error(`无法创建锁文件（${lockFile}）：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    // 拿锁失败：仅在持有者 PID 确认死亡时破除 stale 锁（不按存活时长强拆）
    try {
      const raw = await readFile(lockFile, 'utf8')
      const holder = parseLockOwner(raw)
      if (holder === undefined) {
        // 并发进程刚以 open('wx') 创建锁文件但尚未写完持有者记录：mtime 距今
        // < 1500ms 视为正在写入，等待重试而非误判锁损坏（误判会破除健康锁）；
        // 过了宽限期仍无法解析才是真的损坏，显式报错（诚实性纪律）。
        const stats = await stat(lockFile)
        if (Date.now() - stats.mtimeMs >= FRESH_LOCK_GRACE_MS) {
          throw new Error(`锁文件内容损坏（${lockFile}）：${JSON.stringify(raw.slice(0, 120))}`)
        }
      } else if (holder.pid !== undefined && !(await isProcessAlive(holder.pid))) {
        // 持有者已退出：原子抢占（unlink 与后续 wx 创建之间仍有竞态，失败即重试）
        await rm(lockFile, { force: true })
        continue
      }
    } catch (err) {
      // 锁刚被释放时重新争抢；权限、IO 与内容损坏均须显式失败。
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    if (Date.now() > deadline) {
      throw new Error(`文件被并发写入，等待锁超时（${lockFile}）`)
    }
    await new Promise((resolve) => setTimeout(resolve, PROCESS_LOCK_POLL_MS))
  }
  try {
    return await fn()
  } finally {
    try {
      const raw = await readFile(lockFile, 'utf8')
      if (raw.trim() === owner) await rm(lockFile, { force: true })
    } catch {
      /* 释放失败留给持有者死亡后的 stale 破除，不掩盖业务结果 */
    }
  }
}
