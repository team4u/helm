/**
 * AssetWatcher: watches the data directory and invokes the callback with changed relative paths after a 150ms debounce.
 * Compatible with temp (random name) + fsync + rename atomic writes (renames appear as add/change).
 * Errors from the watcher itself (such as directory deletion) are thrown explicitly to onError and never silently swallowed.
 */
import { EventEmitter } from 'node:events'
import { watch } from 'node:fs'
import type { WatchListener } from 'node:fs'
import { join, relative, sep } from 'node:path'

export interface AssetWatcherOptions {
  /** Debounce window in milliseconds, defaulting to 150ms. */
  debounceMs?: number
  /** Callback for watcher/polling errors; if omitted, errors are thrown to the process (never silently swallowed). */
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

  /** Start watching (enables recursive mode where supported; exposes an explicit error on unsupported platforms). */
  start(): void {
    if (this.handle !== undefined) return
    const listener: WatchListener<string> = (event, filename) => {
      if (this.closed || filename === null) return
      // Ignore our own atomic-write temp files (random UUID names in the intermediate state before rename).
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

/** Atomic-write temporary filenames have the form `.<uuid>.tmp`. */
export function isTmpName(filename: string): boolean {
  const base = filename.split(/[\\/]/).pop() ?? ''
  return base.startsWith('.') && base.endsWith('.tmp')
}
