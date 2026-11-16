/**
 * AssetWatcher: listen data directory,150ms guard against jitter after call back change relative path.
 * compatibility temp(random name)+fsync+rename atomic write (rename table now is add/change).
 * watcher itself error (such as directory by delete) explicit throw to onError, never static default swallow.
 */
import { EventEmitter } from 'node:events'
import { watch } from 'node:fs'
import type { WatchListener } from 'node:fs'
import { join, relative, sep } from 'node:path'

export interface AssetWatcherOptions {
  /** guard against jitter window, by default 150ms. */
  debounceMs?: number
  /** watcher/polling exception call back; not provide when throw to process (not silently swallow wrong). */
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

  /** start listen (recursive exhaust force open start; unsupported platform on with explicit error expose). */
  start(): void {
    if (this.handle !== undefined) return
    const listener: WatchListener<string> = (event, filename) => {
      if (this.closed || filename === null) return
      // ignore itself atomic write temp file (random uuid naming,rename before intermediate state).
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

/** atomic write temp file name shape such as `.<uuid>.tmp`. */
export function isTmpName(filename: string): boolean {
  const base = filename.split(/[\\/]/).pop() ?? ''
  return base.startsWith('.') && base.endsWith('.tmp')
}
