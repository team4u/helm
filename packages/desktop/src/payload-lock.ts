/**
 * 跨进程文件锁（尽力而为）：以 O_CREAT|O_EXCL 原子创建锁文件为获取语义，持有者记录
 * pid 与获取时间；pid 已死或持有超时（staleMs）时允许接管（崩溃遗留自愈）。进程内另有
 * promise 链互斥，同进程并发调用确定性串行。
 *
 * 诚实边界：非内核级锁；极端竞态（双方同时判定 stale 同时接管）由后续 open('wx')
 * 失败自然收敛为单持有者，不构成正确性破坏。
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DesktopError } from './errors.js';

export interface PayloadLockOptions {
  /** 获取锁的最长等待（ms）；超时抛 updater_lock_timeout。 */
  acquireTimeoutMs?: number;
  /** 持有超时（ms）：超过即视为崩溃遗留，允许接管。 */
  staleMs?: number;
}

interface LockHolder {
  pid: number;
  at: number;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但无权限探测，视为存活；其余（ESRCH）视为已死。
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class PayloadFileLock {
  private readonly acquireTimeoutMs: number;
  private readonly staleMs: number;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    readonly lockPath: string,
    options: PayloadLockOptions = {},
  ) {
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? 120_000;
    this.staleMs = options.staleMs ?? 300_000;
  }

  /** 串行执行 fn：进程内排队 + 跨进程锁文件互斥；fn 抛错时锁必然释放。 */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.tail.then(() => this.runLocked(fn));
    this.tail = job.catch(() => {});
    return await job;
  }

  private async runLocked<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      try {
        rmSync(this.lockPath, { force: true });
      } catch {
        // 释放失败由 staleMs 接管兜底；不掩盖 fn 的原始结果
      }
    }
  }

  private async acquire(): Promise<void> {
    const deadline = Date.now() + this.acquireTimeoutMs;
    let delay = 25;
    for (;;) {
      if (this.tryCreate()) return;
      const holder = this.readHolder();
      if (holder !== null && this.isStealable(holder)) {
        try {
          rmSync(this.lockPath, { force: true });
        } catch {
          // 竞态：他人先删/先建，直接重试
        }
      } else if (Date.now() >= deadline) {
        throw new DesktopError(
          'updater_lock_timeout',
          `payload 安装锁等待超时（${this.acquireTimeoutMs}ms）: ${this.lockPath}`,
          { lockPath: this.lockPath, holder: holder ?? null },
        );
      }
      await sleep(Math.min(delay, 200));
      delay = Math.min(delay * 2, 200);
    }
  }

  private tryCreate(): boolean {
    const payload: LockHolder = { pid: process.pid, at: Date.now() };
    try {
      mkdirSync(path.dirname(this.lockPath), { recursive: true });
      const fh = openSync(this.lockPath, 'wx');
      try {
        writeSync(fh, JSON.stringify(payload));
      } finally {
        closeSync(fh);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }

  private readHolder(): LockHolder | null {
    try {
      const parsed = JSON.parse(readFileSync(this.lockPath, 'utf8')) as Partial<LockHolder>;
      const pid = parsed.pid;
      const at = parsed.at;
      if (typeof pid === 'number' && Number.isInteger(pid) && typeof at === 'number' && Number.isFinite(at)) {
        return { pid, at };
      }
      // 内容非法但存在：以 mtime 兜底，仅允许按持有超时接管。
      return { pid: -1, at: statSync(this.lockPath).mtimeMs };
    } catch {
      return null; // 锁文件消失 = 已释放，直接重试
    }
  }

  private isStealable(holder: LockHolder): boolean {
    if (Date.now() - holder.at > this.staleMs) return true;
    return holder.pid > 0 && holder.pid !== process.pid && !isPidAlive(holder.pid);
  }
}
