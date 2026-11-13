/**
 * 跨进程安装互斥锁（fail-closed）：O_CREAT|O_EXCL 原子创建锁文件为获取语义，持有者
 * 记录 pid 与获取时间。锁已被占用时仅有界等待持有者正常释放（删除锁文件），
 * 绝不接管任何锁——pid 已死、持有超时、内容非法一律不构成接管理由：安装超时
 * （10min）远超历史 stale 阈值（5min），自动接管会偷走存活进程的锁并互删对方
 * 新建的锁、破坏对方 staging。崩溃遗留的锁文件由工具/用户按诊断信息确认后手动
 * 移除（显式诊断优于静默自愈）。进程内另有 promise 链互斥，同进程并发调用确定性串行。
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DesktopError } from './errors.js';

export interface PayloadLockOptions {
  /** 有界等待时长（ms）；超时抛 updater_lock_timeout（附持有者诊断）。 */
  acquireTimeoutMs?: number;
}

interface LockHolder {
  pid: number;
  at: number;
}

function describeHolder(holder: LockHolder | null): string {
  if (holder === null) return '未知（锁文件存在但无法读取）';
  const heldMs = holder.at > 0 ? Math.max(0, Math.round(Date.now() - holder.at)) : null;
  return `pid=${holder.pid > 0 ? holder.pid : '未知'}，已持有 ${heldMs !== null ? `${heldMs}ms` : '未知'}`;
}

export class PayloadFileLock {
  private readonly acquireTimeoutMs: number;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    readonly lockPath: string,
    options: PayloadLockOptions = {},
  ) {
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? 120_000;
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
      this.release();
    }
  }

  /** 有界等待获取：他人持锁时轮询直至释放或超时；超时显式报错并附诊断，绝不删除他人锁。 */
  private async acquire(): Promise<void> {
    const startedAt = Date.now();
    const deadline = startedAt + this.acquireTimeoutMs;
    let delay = 25;
    let lastHolder: LockHolder | null = null;
    for (;;) {
      if (this.tryCreate()) return;
      const holder = this.readHolder();
      if (holder !== null) lastHolder = holder;
      if (Date.now() >= deadline) {
        throw new DesktopError(
          'updater_lock_timeout',
          `payload 安装锁被占用，等待 ${this.acquireTimeoutMs}ms 未释放: ${this.lockPath}` +
            `（持有者 ${describeHolder(lastHolder)}；本锁 fail-closed 不自动接管，` +
            '请确认无安装进程仍在运行后手动删除该锁文件再重试）',
          { lockPath: this.lockPath, holder: lastHolder, waitedMs: Date.now() - startedAt },
        );
      }
      await sleep(Math.min(delay, 200));
      delay = Math.min(delay * 2, 200);
    }
  }

  /** 释放：只删除属于自己的锁文件（pid 匹配），绝不触碰他人持有的锁。 */
  private release(): void {
    const holder = this.readHolder();
    if (holder === null || holder.pid !== process.pid) return;
    try {
      rmSync(this.lockPath, { force: true });
    } catch {
      // 释放失败不掩盖 fn 的原始结果；残留锁文件按 fail-closed 诊断由人工处置
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
      // 内容非法但文件存在：仍 fail-closed，仅以 mtime 提供持有时长诊断。
      return { pid: -1, at: statSync(this.lockPath).mtimeMs };
    } catch {
      return null; // 锁文件消失 = 已释放，直接重试
    }
  }
}
