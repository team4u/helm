/**
 * AssetWatcher：监听数据目录，150ms 防抖后回调变更的相对路径。
 * 兼容 temp(随机名)+fsync+rename 原子写（rename 表现为 add/change）。
 * watcher 自身错误（如目录被删除）显式抛给 onError，绝不静默吞掉。
 */
import { EventEmitter } from 'node:events'
import { watch } from 'node:fs'
import type { WatchListener } from 'node:fs'
import { join, relative, sep } from 'node:path'

export interface AssetWatcherOptions {
  /** 防抖窗口，默认 150ms。 */
  debounceMs?: number
  /** watcher/轮询异常回调；未提供时抛到进程（不静默吞错）。 */
  onError?: (err: Error) => void
}

export const ASSET_WATCHER_DEBOUNCE_MS = 150

export class AssetWatcher {
  private handle: ReturnType<typeof watch> | undefined
  private timer: NodeJS.Timeout | undefined
  private readonly pending = new Set<string>()
  private readonly debounceMs: number
  private readonly onError?: (err: Error) => void
  private closed = false

  constructor(
    private readonly rootDir: string,
    private readonly onChange: (changedPaths: string[]) => void,
    opts: AssetWatcherOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? ASSET_WATCHER_DEBOUNCE_MS
    this.onError = opts.onError
  }

  /** 开始监听（recursive 尽力开启；不支持的平台上以显式错误暴露）。 */
  start(): void {
    if (this.handle !== undefined) return
    const listener: WatchListener<string> = (event, filename) => {
      if (this.closed || filename === null) return
      // 忽略自身原子写的临时文件（随机 uuid 命名，rename 前的中间态）。
      if (isTmpName(filename)) return
      const rel = relative(this.rootDir, join(this.rootDir, filename))
      if (rel.startsWith('..')) return
      this.pending.add(rel.split(sep).join('/'))
      this.scheduleFlush()
    }
    try {
      this.handle = watch(this.rootDir, { recursive: true }, listener)
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)))
      return
    }
    this.handle.on('error', (err: unknown) => {
      this.fail(err instanceof Error ? err : new Error(String(err)))
    })
  }

  close(): void {
    this.closed = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.handle?.close()
    this.handle = undefined
  }

  private scheduleFlush(): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      const batch = [...this.pending]
      this.pending.clear()
      if (batch.length > 0 && !this.closed) {
        try {
          this.onChange(batch)
        } catch (err) {
          this.fail(err instanceof Error ? err : new Error(String(err)))
        }
      }
    }, this.debounceMs)
  }

  private fail(err: Error): void {
    if (this.onError !== undefined) this.onError(err)
    else throw err
  }
}

/** 原子写临时文件名形如 `.<uuid>.tmp`。 */
export function isTmpName(filename: string): boolean {
  const base = filename.split(/[\\/]/).pop() ?? ''
  return base.startsWith('.') && base.endsWith('.tmp')
}
