/**
 * Pure process-usage scanner for a target path (Linux `/proc` semantics; pre-deletion diagnostics).
 *
 * Architecture: lives in `@helmx/env-io` (shared between `@helmx/kernel` and `@helmx/node`) with an
 * injectable `PathUsageIo` interface so tests and non-Node hosts can supply fixtures, while real
 * Node.js environments use `createNodePathUsageIo()`. RPC types (`NodePathUsage` /
 * `NodePathUsageProcess`) are sourced from `@helmx/protocol`.
 *
 * Fail-closed discipline:
 * - Non-Linux platforms (no `/proc`) fail explicitly with `not_supported` rather than fabricating data;
 * - Exited processes (`ENOENT`/`ESRCH`) are normal races and ignored; permission denials and other read
 *   failures are never treated as clean: persistent `EACCES`/`EPERM` (after confirming the PID still exists)
 *   counts toward `unobservable` + `diagnostics` (across UIDs or non-dumpable processes like `systemd --user`)
 *   without marking `complete=false`, whereas non-permission I/O errors (e.g. `EIO`) and `stat` failures
 *   set `complete=false`;
 * - Exceeding the PID scan cap sets `complete=false` (never silently underreports);
 * - Exceeding `maxReported` truncates `processes` while keeping exact `matchedTotal`;
 * - Reads only location metadata (`cwd`, `fd` links, `comm`), never `cmdline` or `environ` (secrets).
 *
 * Matching rules: candidate path (`cwd` or open `fd` target) equals `target` or sits beneath it on a
 * path-component boundary (`'/a'` matches `'/a'` and `'/a/...'`, not `'/ab'`). Trailing `' (deleted)'`
 * is stripped before matching while preserving the raw string in reports, and `realpath(target)` is also
 * checked so symlink aliases are caught.
 */

import type { NodePathUsage, NodePathUsageProcess } from '@helmx/protocol'

/** Injectable read-only filesystem interface (browser-safe; Node adapters wrap `node:fs/promises`). */
export interface PathUsageIo {
  /** Read symlink target (`/proc/<pid>/cwd`, `/proc/<pid>/fd/<n>`). */
  readlink(path: string): Promise<string>
  /** List directory entry names (`/proc`, `/proc/<pid>/fd`). */
  readdir(path: string): Promise<string[]>
  /** Read owner UID of `/proc/<pid>` for permission-denial diagnostics (world-readable `st_uid`). */
  stat(path: string): Promise<{ uid: number }>
  /** Read small text files (`/proc/<pid>/comm`, read lazily only on match). */
  readFile(path: string): Promise<string>
  /** Resolve canonical path for `target` so symlinked paths also match. */
  realpath(path: string): Promise<string>
}

/** Failure codes mapped by callers (`invalid`->400, `not_supported`->501, `aborted`->499, others->502). */
export type PathUsageFailureCode = 'invalid' | 'not_supported' | 'aborted' | 'permission_denied' | 'unknown'

export type PathUsageScanResult =
  | { ok: true; value: NodePathUsage }
  | { ok: false; error: { code: PathUsageFailureCode; message: string } }

export interface ScanPathUsageOptions {
  io: PathUsageIo
  /** Target platform (`process.platform`); anything other than `'linux'` fails with `not_supported`. */
  platform: string
  /** Procfs root (defaults to `'/proc'`; tests may inject a fixture directory). */
  procRoot?: string
  /** Maximum PIDs to scan (defaults to `262_144`; exceeding sets `complete=false`). */
  maxPids?: number
  /** Maximum matched processes in `processes` (defaults to `256`; `matchedTotal` always tracks the full count). */
  maxReported?: number
  /** Maximum diagnostic lines (defaults to `32`; excess entries are summarized). */
  maxDiagnostics?: number
  signal?: AbortSignal
}

/** Validate a POSIX absolute scan path: non-empty, <=4096 chars, no NUL, leading `'/'`, no `.`/`..` segments, no trailing `'/'` (except `'/'`). */
export function validatePosixScanPath(path: string): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof path !== 'string' || path.length === 0) return { ok: false, message: 'path must be a non-empty string' }
  if (path.includes('\u0000')) return { ok: false, message: 'path contains a NUL byte' }
  if (path.length > 4096) return { ok: false, message: `path exceeds 4096 characters (got ${path.length})` }
  if (!path.startsWith('/')) {
    return {
      ok: false,
      message: `path must be an absolute path starting with '/' (got ${JSON.stringify(path.slice(0, 40))})`,
    }
  }
  let normalized = path.length > 1 && path.endsWith('/') ? path.replace(/\/+$/, '') : path
  if (normalized === '') normalized = '/'
  if (normalized !== '/') {
    for (const segment of normalized.split('/').slice(1)) {
      if (segment === '') {
        return { ok: false, message: `path contains an empty segment (got ${JSON.stringify(path.slice(0, 40))})` }
      }
      if (segment === '.' || segment === '..') {
        return { ok: false, message: `path contains a '.' or '..' segment (got ${JSON.stringify(path.slice(0, 40))})` }
      }
    }
  }
  return { ok: true, value: normalized }
}

/** Strip Linux's `' (deleted)'` symlink suffix before path comparison while preserving the raw path in reports. */
function stripDeletedSuffix(candidate: string): string {
  return candidate.endsWith(' (deleted)') ? candidate.slice(0, -' (deleted)'.length) : candidate
}

/** Component-boundary containment check (`'/a'` matches `'/a'` and `'/a/...'`, not `'/ab'`). */
function pathContains(base: string, candidate: string): boolean {
  const c = stripDeletedSuffix(candidate)
  if (c === base) return true
  const prefix = base.endsWith('/') ? base : `${base}/`
  return c.startsWith(prefix)
}

type ReadOutcome = { kind: 'value'; value: string } | { kind: 'gone' } | { kind: 'denied'; code: string; message: string }

async function readLink(io: PathUsageIo, path: string): Promise<ReadOutcome> {
  try {
    return { kind: 'value', value: await io.readlink(path) }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'ENOENT' || code === 'ESRCH') return { kind: 'gone' }
    return { kind: 'denied', code: code ?? 'UNKNOWN', message }
  }
}

/** Bounded diagnostic accumulator that summarizes overflow past `limit`. */
class Diagnostics {
  private readonly entries: string[] = []
  private extra = 0
  constructor(private readonly limit: number) {}
  add(entry: string): void {
    if (this.entries.length < this.limit) this.entries.push(entry)
    else this.extra += 1
  }
  get values(): string[] {
    return this.extra > 0 ? [...this.entries, `... and ${this.extra} more omitted diagnostic(s)`] : [...this.entries]
  }
}

/**
 * Scan processes holding `cwd` or open `fd`s at or below `target`.
 * Never throws; all errors (including unexpected injected `io` failures) return structured failures.
 */
export async function scanPathUsage(target: string, options: ScanPathUsageOptions): Promise<PathUsageScanResult> {
  const { io, platform } = options
  const procRoot = options.procRoot ?? '/proc'
  const maxPids = options.maxPids ?? 262_144
  const maxReported = options.maxReported ?? 256
  const diagnostics = new Diagnostics(options.maxDiagnostics ?? 32)

  if (platform !== 'linux') {
    return {
      ok: false,
      error: {
        code: 'not_supported',
        message: `path-usage scanning is only supported on Linux /proc (target platform '${platform}' is unsupported)`,
      },
    }
  }
  const validated = validatePosixScanPath(target)
  if (!validated.ok) return { ok: false, error: { code: 'invalid', message: validated.message } }
  const rawPath = validated.value

  // Match against both rawPath and realpath(rawPath) so symlinked paths are not missed.
  const bases = new Set<string>([rawPath])
  let real: string | undefined
  try {
    real = await io.realpath(rawPath)
  } catch (error) {
    const code = (error as { code?: string } | null)?.code
    if (code === 'ENOENT') {
      real = undefined
    } else if (code === 'EACCES' || code === 'EPERM') {
      return {
        ok: false,
        error: {
          code: 'permission_denied',
          message: `permission denied resolving target realpath (${code}: ${error instanceof Error ? error.message : String(error)}); match bases incomplete, scan rejected`,
        },
      }
    } else {
      return {
        ok: false,
        error: {
          code: 'unknown',
          message: `failed to resolve target realpath (${code ?? 'UNKNOWN'}: ${error instanceof Error ? error.message : String(error)}), scan rejected`,
        },
      }
    }
  }
  if (real !== undefined && real !== '') bases.add(real)

  let entries: string[]
  try {
    entries = await io.readdir(procRoot)
  } catch (error) {
    const code = (error as { code?: string } | null)?.code
    return {
      ok: false,
      error: {
        code: code === 'EACCES' || code === 'EPERM' ? 'not_supported' : 'unknown',
        message: `failed to list ${procRoot} (${code ?? 'UNKNOWN'}: ${error instanceof Error ? error.message : String(error)})`,
      },
    }
  }

  const pids = entries
    .filter((name) => name.length > 0 && name.length <= 10 && /^\d+$/.test(name))
    .map((name) => Number.parseInt(name, 10))
    .sort((a, b) => a - b)

  let complete = true
  if (pids.length > maxPids) {
    complete = false
    diagnostics.add(`PID count ${pids.length} exceeds scan limit ${maxPids}; only the first ${maxPids} PIDs were scanned (scan incomplete)`)
  }

  const processes: NodePathUsageProcess[] = []
  /** Deduplicate hits by PID (first hit wins; `cwd` is checked before `fd`). */
  const matchedPids = new Set<number>()
  let matchedTotal = 0
  let truncated = false
  const pidDenied = new Set<number>()
  let unobservable = 0
  let scanned = 0

  /**
   * Record a persistent read failure (deduplicated per PID): `EACCES`/`EPERM` counts as a structural
   * permission blind spot (`unobservable`) without marking `complete=false`; other errnos (e.g. `EIO`)
   * fail closed with `complete=false`.
   */
  const recordDenied = (pid: number, what: string, uid: number | undefined, code: string): void => {
    if (pidDenied.has(pid)) return
    pidDenied.add(pid)
    const owner = uid !== undefined ? ` (uid ${uid})` : ''
    if (code === 'EACCES' || code === 'EPERM') {
      unobservable += 1
      diagnostics.add(
        `pid ${pid}${owner}: permission denied reading ${what} (${code}); process unobservable (cross-uid or non-dumpable, excluded from completeness check)`,
      )
      return
    }
    complete = false
    diagnostics.add(`pid ${pid}${owner}: failed reading ${what} (${code}); process usage unknown`)
  }

  /** Probe PID liveness: `ENOENT`/`ESRCH` proves exit; other errors leave liveness unknown. */
  const statPid = async (
    pid: number,
  ): Promise<{ kind: 'exists'; uid: number } | { kind: 'gone' } | { kind: 'unknown'; code: string }> => {
    try {
      return { kind: 'exists', uid: (await io.stat(`${procRoot}/${pid}`)).uid }
    } catch (error) {
      const code = (error as { code?: string } | null)?.code
      if (code === 'ENOENT' || code === 'ESRCH') return { kind: 'gone' }
      return { kind: 'unknown', code: code ?? 'UNKNOWN' }
    }
  }

  /**
   * Bounded re-check after a denied read (exactly once):
   * - `stat` returns `ENOENT`/`ESRCH`: process exited -> ignore race;
   * - `stat` succeeds: retry the read once (adopts success on transient failure; otherwise records denial);
   * - `stat` fails with non-exit errno: record via `recordDenied` (same `EACCES`/`EPERM` vs fail-closed split).
   */
  const settleDenied = async <T>(
    pid: number,
    what: string,
    reread: () => Promise<{ ok: true; value: T } | { ok: false; code: string }>,
  ): Promise<{ result: 'gone' } | { result: 'ok'; value: T } | { result: 'denied' }> => {
    const st = await statPid(pid)
    if (st.kind === 'gone') return { result: 'gone' }
    if (st.kind === 'unknown') {
      recordDenied(pid, what, undefined, st.code)
      return { result: 'denied' }
    }
    const retry = await reread()
    if (retry.ok) return { result: 'ok', value: retry.value }
    if (retry.code === 'ENOENT' || retry.code === 'ESRCH') return { result: 'gone' }
    recordDenied(pid, what, st.uid, retry.code)
    return { result: 'denied' }
  }

  const retryLink = (p: string) =>
    readLink(io, p).then((o): { ok: true; value: string } | { ok: false; code: string } =>
      o.kind === 'value' ? { ok: true, value: o.value } : { ok: false, code: o.kind === 'gone' ? 'ENOENT' : o.code })

  const settleLink = async (pid: number, what: string, p: string): Promise<ReadOutcome> => {
    const settled = await settleDenied<string>(pid, what, () => retryLink(p))
    if (settled.result === 'ok') return { kind: 'value', value: settled.value }
    if (settled.result === 'gone') return { kind: 'gone' }
    return { kind: 'denied', code: 'DENIED', message: 'denied after re-check' }
  }

  const pushMatch = async (pid: number, source: 'cwd' | 'fd', path: string): Promise<void> => {
    if (matchedPids.has(pid)) return
    matchedPids.add(pid)
    matchedTotal += 1
    if (processes.length >= maxReported) {
      truncated = true
      return
    }
    let name: string | undefined
    try {
      const comm = await io.readFile(`${procRoot}/${pid}/comm`)
      name = comm.trim().split('\n', 1)[0]
      if (name === '') name = undefined
    } catch {
      // Unreadable `comm` (race/permission) does not invalidate an established cwd/fd match.
    }
    processes.push({ pid, ...(name !== undefined ? { name } : {}), source, path })
  }

  for (const pid of pids) {
    if (scanned >= maxPids) break
    scanned += 1
    if (options.signal?.aborted === true) {
      return { ok: false, error: { code: 'aborted', message: 'path-usage scan aborted' } }
    }
    let cwd = await readLink(io, `${procRoot}/${pid}/cwd`)
    if (cwd.kind === 'denied') {
      cwd = await settleLink(pid, 'cwd', `${procRoot}/${pid}/cwd`)
    }
    if (cwd.kind === 'value' && cwd.value.startsWith('/') && [...bases].some((base) => pathContains(base, cwd.value))) {
      await pushMatch(pid, 'cwd', cwd.value)
    }
    let fdNames: string[] | undefined
    try {
      fdNames = await io.readdir(`${procRoot}/${pid}/fd`)
    } catch (error) {
      const code = (error as { code?: string } | null)?.code
      if (code === 'ENOENT' || code === 'ESRCH') continue
      const settled = await settleDenied(pid, 'fd', () =>
        io.readdir(`${procRoot}/${pid}/fd`).then(
          (names): { ok: true; value: string[] } | { ok: false; code: string } => ({ ok: true, value: names }),
          (e: unknown) => ({ ok: false as const, code: (e as { code?: string } | null)?.code ?? 'UNKNOWN' }),
        ),
      )
      if (settled.result !== 'ok') continue
      fdNames = settled.value
    }
    for (const fdName of fdNames) {
      if (!/^\d+$/.test(fdName)) continue
      const signal = options.signal
      if (signal?.aborted === true) {
        return { ok: false, error: { code: 'aborted', message: 'path-usage scan aborted' } }
      }
      let link = await readLink(io, `${procRoot}/${pid}/fd/${fdName}`)
      if (link.kind === 'denied') {
        link = await settleLink(pid, `fd/${fdName}`, `${procRoot}/${pid}/fd/${fdName}`)
      }
      if (link.kind !== 'value') {
        continue
      }
      if (link.value.startsWith('/') && [...bases].some((base) => pathContains(base, link.value))) {
        await pushMatch(pid, 'fd', link.value)
      }
    }
  }

  return {
    ok: true,
    value: {
      path: rawPath,
      processes,
      matchedTotal,
      processesTruncated: truncated,
      complete,
      unobservable,
      diagnostics: diagnostics.values,
    },
  }
}
