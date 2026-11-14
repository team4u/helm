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

/** 扫描失败码（适配方映射：invalid→400/not_supported→501/aborted→499/unknown→502）。 */
export type PathUsageFailureCode = 'invalid' | 'not_supported' | 'aborted' | 'unknown'

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
 * 本函数自身不抛错（一切失败经 Result error 信封）。
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

  // 匹配基：入参原样 + realpath（软链拼写的候选不漏报；realpath ENOENT 时
  // 只用原样路径——目录消失由调用方上游存在性检查负责）。
  const bases = new Set<string>([rawPath])
  const real = await io.realpath(rawPath).then(
    (value) => value,
    (error: unknown) => {
      const code = (error as { code?: string } | null)?.code
      if (code !== 'ENOENT') throw error
      return undefined
    },
  )
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
  let matchedTotal = 0
  let truncated = false
  const pidDenied = new Set<number>()
  let scanned = 0

  const pushMatch = async (pid: number, source: 'cwd' | 'fd', path: string): Promise<void> => {
    matchedTotal += 1
    if (processes.length >= maxReported) {
      truncated = true
      return
    }
    // 进程名惰性读取（仅命中时一次；世界可读；失败缺省不阻塞）。
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

  const deny = async (pid: number, what: string, code: string): Promise<void> => {
    complete = false
    if (pidDenied.has(pid)) return
    pidDenied.add(pid)
    let uid: string | undefined
    try {
      uid = String((await io.stat(`${procRoot}/${pid}`)).uid)
    } catch {
      // /proc/<pid> 属主不可读（竞态）：诊断只缺 uid，不缺 PID。
    }
    diagnostics.add(`pid ${pid}${uid !== undefined ? ` (uid ${uid})` : ''}: 无权读取 ${what}（${code}），该进程占用情况未知`)
  }

  for (const pid of pids) {
    if (scanned >= maxPids) break // 上限触发已在 diagnostics 记录，complete=false。
    scanned += 1
    if (options.signal?.aborted === true) {
      return { ok: false, error: { code: 'aborted', message: '进程占用扫描已取消' } }
    }
    // cwd（进程工作目录在目标内）。
    const cwd = await readLink(io, `${procRoot}/${pid}/cwd`)
    if (cwd.kind === 'value' && cwd.value.startsWith('/') && [...bases].some((base) => pathContains(base, cwd.value))) {
      await pushMatch(pid, 'cwd', cwd.value)
    } else if (cwd.kind === 'denied') {
      await deny(pid, 'cwd', cwd.code)
    }
    // fd（打开的文件/目录在目标内；socket:/pipe:/anon_inode: 等非路径直接跳过）。
    let fdNames: string[]
    try {
      fdNames = await io.readdir(`${procRoot}/${pid}/fd`)
    } catch (error) {
      const code = (error as { code?: string } | null)?.code
      if (code === 'ENOENT' || code === 'ESRCH') continue // 进程已退出（正常竞态）。
      await deny(pid, 'fd', code ?? 'UNKNOWN')
      continue
    }
    for (const fdName of fdNames) {
      if (!/^\d+$/.test(fdName)) continue
      const link = await readLink(io, `${procRoot}/${pid}/fd/${fdName}`)
      if (link.kind !== 'value') {
        // fd 链接的 ENOENT 是常态竞态（fd 刚关闭）；denied 只在 fd 目录本身
        // 被拒时才有意义（逐 fd EACCES 不出现在 Linux 现实中，忽略即可）。
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
