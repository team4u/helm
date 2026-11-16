/**
 * target path process occupy scan pure orchestration (Linux /proc semantics; before deletion snapshot).
 *
 * architecture constraint: this module belongs to @helm/env-io(kernel and @helm/node sharing execute implement
 * package), keep can inject io side (PathUsageIo) - - test and non- Node host can inject fixture;
 * node side real fs access unify use same package createNodePathUsageIo adapt.RPC shape
 * (NodePathUsage / NodePathUsageProcess) unique true source in @helm/protocol env-rpc;
 * error message seal `{ code, message }` by two side adapt way mapping is RpcResult(node RPC) or
 * HelmError(Hub fabric).
 *
 * honest discipline (fail-closed):
 * - platform non- Linux(without /proc can rely semantics)→ not_supported, never fabricate result;
 * - process already exit (ENOENT/ESRCH) is normal race, ignore; read by refuse and other read
 *   error must visible, never when act clean. semantics by errno govern: durable EACCES/EPERM
 *   refuse read (via re-check confirm PID store and heavy read still refuse) do not argument uid one rule is permission cannot observability
 *   structure blind spot (across uid, or non-dumpable process such as systemd --user- - belong main
 *   itself also read do not;OS capability model such as this, non- scan exception) - -unobservable counter
 *   + diagnostics such as present (attach uid), do not placement complete=false(never static default
 *   discard); non- permission class read error (EIO etc.) and stat itself non- permission class exception still placement
 *   complete=false(fail-closed); and Hub same uid ordinary can rotate store process
 *   (helm derive subagent/git/shell) forever can observability, protect side do not subject to affect;
 * - scan PID cap trigger → complete=false(never static default leak report);
 * - hit manifest subject to report cap truncate when matchedTotal keep real counter;
 * - only read locate information (cwd,fd link,comm), never read cmdline/environ(secret).
 *
 * match rule: choose path (cwd or fd real path) equals target path, or at its under (path
 * amount boundary - -'/a' does not match '/ab', only match '/a' and '/a/...'); deleted file suffix
 * " (deleted)" in match before strip (report keep original value). also match caller pass path and
 * realpath parse result (symlink piece together write choose do not leak report).
 */

import type { NodePathUsage, NodePathUsageProcess } from '@helm/protocol'

/** inject only read fs side (browser-safe; two side adapt use node:fs/promises implement). */
export interface PathUsageIo {
  /** symlink parse (/proc/<pid>/cwd,/proc/<pid>/fd/<n>, target realpath). */
  readlink(path: string): Promise<string>
  /** directory column raise (only name;/proc and /proc/<pid>/fd). */
  readdir(path: string): Promise<string[]>
  /** take belong main uid(by refuse PID diagnose;/proc/<pid>  st_uid is world-readable). */
  stat(path: string): Promise<{ uid: number }>
  /** read small text (/proc/<pid>/comm; only in hit when lazy read). */
  readFile(path: string): Promise<string>
  /** target path realpath(symlink piece together write consume ambiguity; adapt way implement). */
  realpath(path: string): Promise<string>
}

/** scan failed code (adapt way mapping:invalid→400/not_supported→501/aborted→499/permission_deniedandunknown→502). */
export type PathUsageFailureCode = 'invalid' | 'not_supported' | 'aborted' | 'permission_denied' | 'unknown'

export type PathUsageScanResult =
  | { ok: true; value: NodePathUsage }
  | { ok: false; error: { code: PathUsageFailureCode; message: string } }

export interface ScanPathUsageOptions {
  io: PathUsageIo
  /** target platform (process.platform opening path); non- 'linux' explicit not_supported. */
  platform: string
  /** /proc (default '/proc'; test can inject fixture directory). */
  procRoot?: string
  /** scan PID count cap (default 262_144; trigger i.e. complete=false, never static default leak report). */
  maxPids?: number
  /** hit process report cap (default 256;matchedTotal always keep real counter). */
  maxReported?: number
  /** diagnose count cap (default 32; exceeds aggregate counter, do not unbounded expansion). */
  maxDiagnostics?: number
  signal?: AbortSignal
}

/** POSIX absolute path validate (scan only support Linux, by POSIX rule consolidate): non-empty,≤4096, without NUL, with '/' open head, without '.'/'..' segment, without tail follow '/'(except outside). */
export function validatePosixScanPath(path: string): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof path !== 'string' || path.length === 0) return { ok: false, message: 'path must be non-empty string' }
  if (path.includes('\u0000')) return { ok: false, message: 'path contains NUL byte' }
  if (path.length > 4096) return { ok: false, message: `path exceeds 4096 character (receives ${path.length})` }
  if (!path.startsWith('/')) return { ok: false, message: `path must be absolute path (with '/' open head, receives ${JSON.stringify(path.slice(0, 40))})` }
  // archive one tail follow '/'( '/' except outside).
  let normalized = path.length > 1 && path.endsWith('/') ? path.replace(/\/+$/, '') : path
  if (normalized === '') normalized = '/'
  if (normalized !== '/') {
    for (const segment of normalized.split('/').slice(1)) {
      if (segment === '') return { ok: false, message: `path contains empty path segment (receives ${JSON.stringify(path.slice(0, 40))})` }
      if (segment === '.' || segment === '..') return { ok: false, message: `path contains '.'/'..' segment (receives ${JSON.stringify(path.slice(0, 40))})` }
    }
  }
  return { ok: true, value: normalized }
}

/** match before strip deleted file suffix (report keep original value, match use strip value). */
function stripDeletedSuffix(candidate: string): string {
  return candidate.endsWith(' (deleted)') ? candidate.slice(0, -' (deleted)'.length) : candidate
}

/** path amount boundary contains:base === candidate or candidate at base of under ('/a' does not match '/ab'). */
function pathContains(base: string, candidate: string): boolean {
  const c = stripDeletedSuffix(candidate)
  if (c === base) return true
  const prefix = base.endsWith('/') ? base : `${base}/`
  return c.startsWith(prefix)
}

/** read error classify (inject fs implement throws must carries `code` property, and node:fs consistent). */
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
/** diagnose aggregate (cap truncate after aggregate remaining counter, do not unbounded expansion). */
class Diagnostics {
  private readonly entries: string[] = []
  private extra = 0
  constructor(private readonly limit: number) {}
  add(entry: string): void {
    if (this.entries.length < this.limit) this.entries.push(entry)
    else this.extra += 1
  }
  get values(): string[] {
    return this.extra > 0 ? [...this.entries, `... another has ${this.extra} do not complete reason not column out`] : [...this.entries]
  }
}

/**
 * scan target absolute path process occupy (cwd + open fd). return value convention see NodePathUsage;
 * this function itself do not throws (everything failed, contains inject io non- ENOENT exception, via Result error
 * message seal explicit return):
 * - target realpath failed to parse:ENOENT only use original path match (directory store in by upstream
 *   negative duty);EACCES/EPERM → permission_denied(permission can diagnose); other → unknown.
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
        message: `process occupy scan when before only implement Linux /proc only read semantics (target platform '${platform}' unsupported; do not fabricate across platform result)`,
      },
    }
  }
  const validated = validatePosixScanPath(target)
  if (!validated.ok) return { ok: false, error: { code: 'invalid', message: validated.message } }
  const rawPath = validated.value

  // match base: reference original + realpath(symlink piece together write choose do not leak report;realpath failed by
  // head note release policy explicit classify, never to on throw bare exception).
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
          message: `without right parse target path realpath(${code}: ${error instanceof Error ? error.message : String(error)}); match base do not complete, reject scan`,
        },
      }
    } else {
      return {
        ok: false,
        error: {
          code: 'unknown',
          message: `target path realpath failed to parse (${code ?? 'UNKNOWN'}: ${error instanceof Error ? error.message : String(error)}), reject scan`,
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
        message: `cannot column raise ${procRoot}(${code ?? 'UNKNOWN'}: ${error instanceof Error ? error.message : String(error)})`,
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
    diagnostics.add(`PID count ${pids.length} exceeds scan cap ${maxPids}, only scan before ${maxPids} (the rest not scan, do not pretend complete)`)
  }

  const processes: NodePathUsageProcess[] = []
  /** hit process unique PID collection (same process cwd+multiple fd only count once; first reference cwd takes precedence). */
  const matchedPids = new Set<number>()
  let matchedTotal = 0
  let truncated = false
  const pidDenied = new Set<number>()
  let unobservable = 0
  let scanned = 0

  /**
   * record durable refuse read (same PID dedupe): by errno govern - -EACCES/EPERM is permission
   * cannot observability structure blind spot (across uid or non-dumpable, such as systemd --user;
   * do not argument uid,uid unknown also count), such as counter unobservable + diagnose (attach uid),
   * do not count complete decide; other errno(EIO etc.) still fail-closed:
   * complete=false + diagnose.
   */
  const recordDenied = (pid: number, what: string, uid: number | undefined, code: string): void => {
    if (pidDenied.has(pid)) return
    pidDenied.add(pid)
    const owner = uid !== undefined ? ` (uid ${uid})` : ''
    if (code === 'EACCES' || code === 'EPERM') {
      unobservable += 1
      diagnostics.add(
        `pid ${pid}${owner}: without right read ${what}(${code}), permission cannot observability (across uid or non-dumpable, such as systemd --user; not count complete decide)`,
      )
      return
    }
    complete = false
    diagnostics.add(`pid ${pid}${owner}: read ${what} failed (${code}), the process occupy case unknown`)
  }

  /** PID store probe:ENOENT/ESRCH verify already exit; other error cannot verify store in state. */
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
   * by refuse read has boundary re-check (exactly once, pure only read heavy read verify, do not rely on extend when/identity guess):
   * - stat verify PID already exit (ENOENT/ESRCH)→ exit race, ignore (contract allows);
   * - PID still in → heavy read once: succeeded then such as adopt (instantaneous error do not compute blind spot); still refuse or
   *   gone(this time heavy read verify exit) then by exit/blind spot such as compute;
   * - stat itself non- exit class error → cannot verify store in state, same via recordDenied by
   *   errno govern (EACCES/EPERM blind spot - -uid unknown also count; the rest fail-closed).
   * never because should can read put true EACCES: still refuse and PID store when must via recordDenied
   * such as compute (permission class errno blind spot counter present, non- permission class error placement complete=false).
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

  /** readLink result adapt is settleDenied heavy read side. */
  const retryLink = (p: string) =>
    readLink(io, p).then((o): { ok: true; value: string } | { ok: false; code: string } =>
      o.kind === 'value' ? { ok: true, value: o.value } : { ok: false, code: o.kind === 'gone' ? 'ENOENT' : o.code })

  /** by refuse readLink has boundary re-check (settleDenied semantics): result mapping back ReadOutcome(heavy read succeeded such as adopt). */
  const settleLink = async (pid: number, what: string, p: string): Promise<ReadOutcome> => {
    const settled = await settleDenied<string>(pid, what, () => retryLink(p))
    if (settled.result === 'ok') return { kind: 'value', value: settled.value }
    if (settled.result === 'gone') return { kind: 'gone' }
    return { kind: 'denied', code: 'DENIED', message: 're-check after still by refuse' }
  }

  /**
   * register once hit (by PID dedupe): same process cwd/fd many where reference only count a process,
   * only report first reference (cwd first scan reason takes precedence);matchedTotal always is unique PID real counter,
   * report manifest truncate does not affect counter.
   */
  const pushMatch = async (pid: number, source: 'cwd' | 'fd', path: string): Promise<void> => {
    if (matchedPids.has(pid)) return
    matchedPids.add(pid)
    matchedTotal += 1
    if (processes.length >= maxReported) {
      truncated = true
      return
    }
    // process name lazy read (only first hit when once;is world-readable; failed default non-blocking).
    let name: string | undefined
    try {
      const comm = await io.readFile(`${procRoot}/${pid}/comm`)
      name = comm.trim().split('\n', 1)[0]
      if (name === '') name = undefined
    } catch {
      // comm cannot read (race/permission): occupy fact already into establish (cwd/fd hit), do not default name.
    }
    processes.push({ pid, ...(name !== undefined ? { name } : {}), source, path })
  }

  for (const pid of pids) {
    if (scanned >= maxPids) break // cap trigger already in diagnostics record,complete=false.
    scanned += 1
    if (options.signal?.aborted === true) {
      return { ok: false, error: { code: 'aborted', message: 'process occupy scan cancelled' } }
    }
    // cwd(process work directory in target inside). by refuse when first has boundary re-check:PID already exit → race ignore; heavy read succeeded → such as adopt.
    let cwd = await readLink(io, `${procRoot}/${pid}/cwd`)
    if (cwd.kind === 'denied') {
      cwd = await settleLink(pid, 'cwd', `${procRoot}/${pid}/cwd`)
    }
    if (cwd.kind === 'value' && cwd.value.startsWith('/') && [...bases].some((base) => pathContains(base, cwd.value))) {
      await pushMatch(pid, 'cwd', cwd.value)
    }
    // fd(open file/directory in target inside;socket:/pipe:/anon_inode: etc. non- path directly skip).
    let fdNames: string[] | undefined
    try {
      fdNames = await io.readdir(`${procRoot}/${pid}/fd`)
    } catch (error) {
      const code = (error as { code?: string } | null)?.code
      if (code === 'ENOENT' || code === 'ESRCH') continue // process already exit (normal race).
      // by refuse: first has boundary re-check (stat verify exit → race ignore; still in → heavy read once set seize).
      const settled = await settleDenied(pid, 'fd', () =>
        io.readdir(`${procRoot}/${pid}/fd`).then(
          (names): { ok: true; value: string[] } | { ok: false; code: string } => ({ ok: true, value: names }),
          (e: unknown) => ({ ok: false as const, code: (e as { code?: string } | null)?.code ?? 'UNKNOWN' }),
        ),
      )
      if (settled.result !== 'ok') continue // race exit or still refuse: this PID compute done.
      fdNames = settled.value
    }
    for (const fdName of fdNames) {
      if (!/^\d+$/.test(fdName)) continue
      // local variable heavy read:abort can occur in this loop body inside await during, cannot by loop head
      // narrow conclusion mask (TS for property chain narrow do not across await update).
      const signal = options.signal
      if (signal?.aborted === true) {
        return { ok: false, error: { code: 'aborted', message: 'process occupy scan cancelled' } }
      }
      let link = await readLink(io, `${procRoot}/${pid}/fd/${fdName}`)
      if (link.kind === 'denied') {
        link = await settleLink(pid, `fd/${fdName}`, `${procRoot}/${pid}/fd/${fdName}`)
      }
      // gone(contains re-check verify exit) is common state race: skip;denied already in re-check inside record blind spot.
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
