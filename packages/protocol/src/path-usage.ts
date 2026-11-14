/**
 * 目标路径进程占用扫描的纯编排器（Linux /proc 语义；删除前快照）。
 *
 * 架构约束：本模块属于 @helm/protocol，必须保持浏览器安全——零 Node 内置
 * import，一切文件系统访问经 `PathUsageIo` 注入（kernel 与 @helm/node 各自
 * 提供薄 fs 适配）；禁止相对 import 跨包。错误信封 `{ code, message }` 由
 * 两侧适配方映射为 RpcResult（节点 RPC）或 HelmError（Hub fabric）。
 *
 * 诚实性纪律（fail-closed）：
 * - 平台非 Linux（无 /proc 可靠语义）→ not_supported，绝不伪造结果；
 * - 进程已退出（ENOENT/ESRCH）是正常竞态，忽略；无权读取（EACCES/EPERM）
 *   与其他读取错误必须可见：complete=false + diagnostics（附属主 uid），
 *   绝不当作干净；
 * - 扫描 PID 上限触发 → complete=false（绝不静默漏报）；
 * - 命中清单受报告上限截断时 matchedTotal 保留真实计数；
 * - 只读取定位信息（cwd、fd 链接、comm），绝不读 cmdline/environ（机密）。
 *
 * 匹配规则：候选路径（cwd 或 fd 真实路径）等于目标路径、或位于其下（路径
 * 分量边界——'/a' 不匹配 '/ab'，只匹配 '/a' 与 '/a/...'）；已删除文件后缀
 * " (deleted)" 在匹配前剥离（报告保留原值）。同时匹配调用方传入路径与
 * realpath 解析结果（软链拼写的候选不漏报）。
 */

import type { NodePathUsage, NodePathUsageProcess } from './env-rpc.js'

/** 注入的只读 fs 面（browser-safe；两侧适配用 node:fs/promises 实现）。 */
export interface PathUsageIo {
  /** 符号链接解析（/proc/<pid>/cwd、/proc/<pid>/fd/<n>、目标 realpath）。 */
  readlink(path: string): Promise<string>
  /** 目录列举（仅名字；/proc 与 /proc/<pid>/fd）。 */
  readdir(path: string): Promise<string[]>
  /** 取属主 uid（被拒 PID 的诊断；/proc/<pid> 的 st_uid 世界可读）。 */
  stat(path: string): Promise<{ uid: number }>
  /** 读小文本（/proc/<pid>/comm；仅在命中时惰性读取）。 */
  readFile(path: string): Promise<string>
  /** 目标路径的 realpath（软链拼写消歧；适配方实现）。 */
  realpath(path: string): Promise<string>
}

/** 扫描失败码（适配方映射：invalid→400/not_supported→501/aborted→499/permission_denied与unknown→502）。 */
export type PathUsageFailureCode = 'invalid' | 'not_supported' | 'aborted' | 'permission_denied' | 'unknown'

export type PathUsageScanResult =
  | { ok: true; value: NodePathUsage }
  | { ok: false; error: { code: PathUsageFailureCode; message: string } }

export interface ScanPathUsageOptions {
  io: PathUsageIo
  /** 目标平台（process.platform 口径）；非 'linux' 显式 not_supported。 */
  platform: string
  /** /proc 根（缺省 '/proc'；测试可注入 fixture 目录）。 */
  procRoot?: string
  /** 扫描 PID 数上限（缺省 262_144；触发即 complete=false，绝不静默漏报）。 */
  maxPids?: number
  /** 命中进程报告上限（缺省 256；matchedTotal 始终保留真实计数）。 */
  maxReported?: number
  /** 诊断条数上限（缺省 32；超出聚合计数，不无限膨胀）。 */
  maxDiagnostics?: number
  signal?: AbortSignal
}

/** POSIX 绝对路径校验（扫描仅支持 Linux，按 POSIX 规则收口）：非空、≤4096、无 NUL、以 '/' 开头、无 '.'/'..' 段、无尾随 '/'（根除外）。 */
export function validatePosixScanPath(path: string): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof path !== 'string' || path.length === 0) return { ok: false, message: 'path 必须是非空字符串' }
  if (path.includes('\u0000')) return { ok: false, message: 'path 含 NUL 字节' }
  if (path.length > 4096) return { ok: false, message: `path 超过 4096 字符（收到 ${path.length}）` }
  if (!path.startsWith('/')) return { ok: false, message: `path 必须是绝对路径（以 '/' 开头，收到 ${JSON.stringify(path.slice(0, 40))}）` }
  // 归一化尾随 '/'（根 '/' 除外）。
  let normalized = path.length > 1 && path.endsWith('/') ? path.replace(/\/+$/, '') : path
  if (normalized === '') normalized = '/'
  if (normalized !== '/') {
    for (const segment of normalized.split('/').slice(1)) {
      if (segment === '') return { ok: false, message: `path 含空路径段（收到 ${JSON.stringify(path.slice(0, 40))}）` }
      if (segment === '.' || segment === '..') return { ok: false, message: `path 含 '.'/'..' 段（收到 ${JSON.stringify(path.slice(0, 40))}）` }
    }
  }
  return { ok: true, value: normalized }
}

/** 匹配前剥离已删除文件后缀（报告保留原值，匹配用剥离值）。 */
function stripDeletedSuffix(candidate: string): string {
  return candidate.endsWith(' (deleted)') ? candidate.slice(0, -' (deleted)'.length) : candidate
}

/** 路径分量边界包含：base === candidate 或 candidate 位于 base 之下（'/a' 不匹配 '/ab'）。 */
function pathContains(base: string, candidate: string): boolean {
  const c = stripDeletedSuffix(candidate)
  if (c === base) return true
  const prefix = base.endsWith('/') ? base : `${base}/`
  return c.startsWith(prefix)
}

/** 读取错误分类（注入的 fs 实现抛错须带 `code` 属性，与 node:fs 一致）。 */
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
/** 诊断聚合（上限截断后聚合剩余计数，不无限膨胀）。 */
class Diagnostics {
  private readonly entries: string[] = []
  private extra = 0
  constructor(private readonly limit: number) {}
  add(entry: string): void {
    if (this.entries.length < this.limit) this.entries.push(entry)
    else this.extra += 1
  }
  get values(): string[] {
    return this.extra > 0 ? [...this.entries, `…另有 ${this.extra} 条不完整原因未列出`] : [...this.entries]
  }
}

/**
 * 扫描目标绝对路径的进程占用（cwd + 打开 fd）。返回值约定见 NodePathUsage；
 * 本函数自身不抛错（一切失败，含注入 io 的非 ENOENT 异常，经 Result error
 * 信封显式返回）：
 * - 目标 realpath 解析失败：ENOENT 只用原始路径匹配（目录存在性由上游
 *   负责）；EACCES/EPERM → permission_denied（权限可诊断）；其他 → unknown。
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
        message: `进程占用扫描当前仅实现 Linux /proc 只读语义（目标平台 '${platform}' 不支持；不伪造跨平台结果）`,
      },
    }
  }
  const validated = validatePosixScanPath(target)
  if (!validated.ok) return { ok: false, error: { code: 'invalid', message: validated.message } }
  const rawPath = validated.value

  // 匹配基：入参原样 + realpath（软链拼写的候选不漏报；realpath 失败按
  // 头注释策略显式分类，绝不向上抛裸异常）。
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
          message: `无权解析目标路径 realpath（${code}: ${error instanceof Error ? error.message : String(error)}）；匹配基不完整，拒绝扫描`,
        },
      }
    } else {
      return {
        ok: false,
        error: {
          code: 'unknown',
          message: `目标路径 realpath 解析失败（${code ?? 'UNKNOWN'}: ${error instanceof Error ? error.message : String(error)}），拒绝扫描`,
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
        message: `无法列举 ${procRoot}（${code ?? 'UNKNOWN'}: ${error instanceof Error ? error.message : String(error)}）`,
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
    diagnostics.add(`PID 数 ${pids.length} 超过扫描上限 ${maxPids}，仅扫描前 ${maxPids} 个（其余未扫描，不假装完整）`)
  }

  const processes: NodePathUsageProcess[] = []
  /** 命中进程唯一 PID 集（同进程 cwd+多个 fd 只计一次；首个引用 cwd 优先）。 */
  const matchedPids = new Set<number>()
  let matchedTotal = 0
  let truncated = false
  const pidDenied = new Set<number>()
  let scanned = 0

  /** 记录盲区（fail-closed）：complete=false + 诊断（附 uid；同 PID 去重）。 */
  const recordDenied = (pid: number, what: string, uid: number | undefined, code: string): void => {
    complete = false
    if (pidDenied.has(pid)) return
    pidDenied.add(pid)
    diagnostics.add(`pid ${pid}${uid !== undefined ? ` (uid ${uid})` : ''}: 无权读取 ${what}（${code}），该进程占用情况未知`)
  }

  /** PID 存活探测：ENOENT/ESRCH 证实已退出；其他错误无法证明存在状态。 */
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
   * 被拒读取的有界复核（恰一次，纯只读重读证明，不凭延时/身份猜测）：
   * - stat 证实 PID 已退出（ENOENT/ESRCH）→ 退出竞态，忽略（契约允许）；
   * - PID 仍在 → 重读一次：成功则如实采用（瞬时错误不算盲区）；仍拒或
   *   gone（本次重读证实退出）则按退出/盲区如实结算；
   * - stat 自身非退出类错误 → 无法证明存在状态，直接记录盲区（fail-closed）。
   * 绝不因「应该可读」放过真 EACCES：仍拒师 PID 存活时必记 complete=false。
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

  /** readLink 结果适配为 settleDenied 重读面。 */
  const retryLink = (p: string) =>
    readLink(io, p).then((o): { ok: true; value: string } | { ok: false; code: string } =>
      o.kind === 'value' ? { ok: true, value: o.value } : { ok: false, code: o.kind === 'gone' ? 'ENOENT' : o.code })

  /** 被拒 readLink 的有界复核（settleDenied 语义）：结果映射回 ReadOutcome（重读成功如实采用）。 */
  const settleLink = async (pid: number, what: string, p: string): Promise<ReadOutcome> => {
    const settled = await settleDenied<string>(pid, what, () => retryLink(p))
    if (settled.result === 'ok') return { kind: 'value', value: settled.value }
    if (settled.result === 'gone') return { kind: 'gone' }
    return { kind: 'denied', code: 'DENIED', message: '复核后仍被拒' }
  }

  /**
   * 登记一次命中（按 PID 去重）：同进程的 cwd/fd 多处引用只计一个进程、
   * 只报首个引用（cwd 先扫故优先）；matchedTotal 始终为唯一 PID 真实计数，
   * 报告清单截断不影响计数。
   */
  const pushMatch = async (pid: number, source: 'cwd' | 'fd', path: string): Promise<void> => {
    if (matchedPids.has(pid)) return
    matchedPids.add(pid)
    matchedTotal += 1
    if (processes.length >= maxReported) {
      truncated = true
      return
    }
    // 进程名惰性读取（仅首个命中时一次；世界可读；失败缺省不阻塞）。
    let name: string | undefined
    try {
      const comm = await io.readFile(`${procRoot}/${pid}/comm`)
      name = comm.trim().split('\n', 1)[0]
      if (name === '') name = undefined
    } catch {
      // comm 不可读（竞态/权限）：占用事实已成立（cwd/fd 命中），不缺省名。
    }
    processes.push({ pid, ...(name !== undefined ? { name } : {}), source, path })
  }

  for (const pid of pids) {
    if (scanned >= maxPids) break // 上限触发已在 diagnostics 记录，complete=false。
    scanned += 1
    if (options.signal?.aborted === true) {
      return { ok: false, error: { code: 'aborted', message: '进程占用扫描已取消' } }
    }
    // cwd（进程工作目录在目标内）。被拒时先有界复核：PID 已退出 → 竞态忽略；重读成功 → 如实采用。
    let cwd = await readLink(io, `${procRoot}/${pid}/cwd`)
    if (cwd.kind === 'denied') {
      cwd = await settleLink(pid, 'cwd', `${procRoot}/${pid}/cwd`)
    }
    if (cwd.kind === 'value' && cwd.value.startsWith('/') && [...bases].some((base) => pathContains(base, cwd.value))) {
      await pushMatch(pid, 'cwd', cwd.value)
    }
    // fd（打开的文件/目录在目标内；socket:/pipe:/anon_inode: 等非路径直接跳过）。
    let fdNames: string[] | undefined
    try {
      fdNames = await io.readdir(`${procRoot}/${pid}/fd`)
    } catch (error) {
      const code = (error as { code?: string } | null)?.code
      if (code === 'ENOENT' || code === 'ESRCH') continue // 进程已退出（正常竞态）。
      // 被拒：先有界复核（stat 证实退出 → 竞态忽略；仍在 → 重读一次定夺）。
      const settled = await settleDenied(pid, 'fd', () =>
        io.readdir(`${procRoot}/${pid}/fd`).then(
          (names): { ok: true; value: string[] } | { ok: false; code: string } => ({ ok: true, value: names }),
          (e: unknown) => ({ ok: false as const, code: (e as { code?: string } | null)?.code ?? 'UNKNOWN' }),
        ),
      )
      if (settled.result !== 'ok') continue // 竞态退出或仍拒：本 PID 结算完毕。
      fdNames = settled.value
    }
    for (const fdName of fdNames) {
      if (!/^\d+$/.test(fdName)) continue
      // 局部变量重读：abort 可发生在本循环体内 await 期间，不能被循环头的
      // 窄化结论掩盖（TS 对属性链的窄化不跨 await 更新）。
      const signal = options.signal
      if (signal?.aborted === true) {
        return { ok: false, error: { code: 'aborted', message: '进程占用扫描已取消' } }
      }
      let link = await readLink(io, `${procRoot}/${pid}/fd/${fdName}`)
      if (link.kind === 'denied') {
        link = await settleLink(pid, `fd/${fdName}`, `${procRoot}/${pid}/fd/${fdName}`)
      }
      // gone（含复核证实退出）是常态竞态：跳过；denied 已在复核内记录盲区。
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
      diagnostics: diagnostics.values,
    },
  }
}
