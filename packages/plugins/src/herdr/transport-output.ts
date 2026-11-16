import { posix, win32 } from 'node:path'
import { HelmError } from '@helm/protocol'
import type { Context } from '@earendil-works/chord/context'
import type { HerdrNodeChannel, HerdrNodeEnv, HerdrTarget } from './contracts.js'
import { checkAborted, contextOf, HerdrTransportError } from './transport-shared.js'

/**
 * `.helm/wf-out-*` 交接文件 IO 与跨平台路径安全边界（从 transport.ts 拆出，
 * 行为与拆分前逐行等价）：
 * - 文件名白名单 OUTPUT_FILE_PATTERN（拒绝 herdr_invalid_output_name）；
 * - 本机：cwd realpath + `.helm` 必须真实目录（非软链）且仍在真实 cwd 内；
 *   O_NOFOLLOW 打开收敛 TOCTOU（Windows 无 O_NOFOLLOW，退回读后 realpath 复核）；
 * - 远端：按 cwd 路径形状选 win32/posix 纯规则拼 `<cwd>/.helm`，经节点 env
 *   canonicalPath 校验，读后 canonical 复核仍锚定 realHelm 内；
 * - 目录缺失 = 404 herdr_output_missing（唯一可自愈边界）；remove 语义幂等；
 * - MAX_OUTPUT_BYTES 大小上限，超限显式失败，绝不静默截断。
 */

/** 交接文件读取上限；超限显式失败，绝不静默截断充当成功。 */
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
export const OUTPUT_FILE_PATTERN = /^wf-out-[A-Za-z0-9_.-]{1,64}\.(json|md)$/

export function assertSafeOutputName(fileName: string, target: string): void {
  if (!OUTPUT_FILE_PATTERN.test(fileName)) {
    throw new HerdrTransportError('herdr_invalid_output_name', `refusing unsafe output file name: ${fileName}`, target)
  }
}

/** 本机输出路径：校验 cwd 真实存在、.helm 是真实目录（非软链）且在真实 cwd 内。 */
async function resolveLocalOutputPath(cwd: string, fileName: string, target: string): Promise<string> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  let realCwd: string
  try {
    realCwd = await fs.realpath(cwd)
  } catch (err) {
    throw new HerdrTransportError('herdr_invalid_cwd', `cwd not accessible: ${cwd}`, target, { cause: err })
  }
  const helmDir = path.join(realCwd, '.helm')
  let helmStat
  try {
    helmStat = await fs.lstat(helmDir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // 目录缺失 = 交接文件缺失：read 报 404、remove 幂等（一次自愈边界）。
      throw new HelmError('herdr_output_missing', `交接目录不存在: ${helmDir}`, 404)
    }
    throw new HerdrTransportError('herdr_io', `failed to inspect ${helmDir}: ${code ?? String(err)}`, target, { cause: err })
  }
  if (helmStat.isSymbolicLink() || !helmStat.isDirectory()) {
    throw new HerdrTransportError('herdr_output_escaping', `.helm must be a real directory inside cwd`, target)
  }
  // realpath 再验证：目录内不允许任何中间软链把最终路径移出 cwd。
  const realHelm = await fs.realpath(helmDir)
  if (realHelm !== helmDir) {
    throw new HerdrTransportError('herdr_output_escaping', `.helm resolves outside cwd`, target)
  }
  return path.join(helmDir, fileName)
}

export async function readLocalOutput(cwd: string, fileName: string, signal: AbortSignal | undefined, target: string, redact: (s: string) => string): Promise<string> {
  const fs = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  checkAborted(signal, target)
  const path = await resolveLocalOutputPath(cwd, fileName, target)
  // 以 O_NOFOLLOW 打开收敛 TOCTOU：lstat 与 readFile 分离时，窗口内文件可被
  // 替换为符号链接越出 .helm；在打开时点拒绝 symlink 后从同一句柄 fstat+读
  // （Windows 无 O_NOFOLLOW，退回读后 realpath 复核仍锚定 .helm 内）。
  const noFollow = fs.constants.O_NOFOLLOW ?? 0
  let fh: Awaited<ReturnType<typeof fs.open>>
  try {
    fh = await fs.open(path, fs.constants.O_RDONLY | noFollow)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new HelmError('herdr_output_missing', `交接文件不存在: ${path}`, 404)
    }
    if (code === 'ELOOP') {
      throw new HerdrTransportError('herdr_output_escaping', `output path is a symlink: ${path}`, target)
    }
    throw new HerdrTransportError('herdr_io', `failed to open output file: ${redact(String(err))}`, target, { cause: err })
  }
  try {
    const stat = await fh.stat()
    if (!stat.isFile()) {
      throw new HerdrTransportError('herdr_output_not_file', `output path is not a regular file: ${path}`, target)
    }
    if (stat.size > MAX_OUTPUT_BYTES) {
      throw new HerdrTransportError('herdr_output_too_large', `output exceeds ${MAX_OUTPUT_BYTES} bytes`, target)
    }
    const content = await fh.readFile('utf8')
    if (Buffer.byteLength(content, 'utf8') > MAX_OUTPUT_BYTES) {
      throw new HerdrTransportError('herdr_output_too_large', `output grew past limit while reading`, target)
    }
    if (!noFollow) {
      const real = await fs.realpath(path)
      if (!pathContains(await fs.realpath(dirname(path)), real)) {
        throw new HerdrTransportError('herdr_output_escaping', `output resolves outside .helm`, target)
      }
    }
    return content
  } finally {
    await fh.close().catch(() => {})
  }
}

export async function removeLocalOutput(cwd: string, fileName: string, signal: AbortSignal | undefined, target: string, redact: (s: string) => string): Promise<void> {
  const fs = await import('node:fs/promises')
  checkAborted(signal, target)
  let path: string
  try {
    path = await resolveLocalOutputPath(cwd, fileName, target)
  } catch (err) {
    // 目录/文件缺失：remove 语义是幂等无操作（与插件一次自愈边界一致）。
    if (err instanceof HelmError && err.code === 'herdr_output_missing') return
    throw err
  }
  try {
    const stat = await fs.lstat(path)
    if (!stat.isFile()) {
      throw new HerdrTransportError('herdr_output_not_file', `output path is not a regular file: ${path}`, target)
    }
    await fs.unlink(path)
  } catch (err) {
    if (err instanceof HerdrTransportError || err instanceof HelmError) throw err
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new HerdrTransportError('herdr_io', `failed to remove output file: ${redact(String(err))}`, target, { cause: err })
  }
}

/**
 * 目标路径形状对应的纯路径规则（不依赖 Hub 进程平台）：
 * Windows 形状（盘符或 UNC `\\server\share`）用 win32 规则，其余 POSIX。
 */
function pathRulesFor(path: string): typeof posix | typeof win32 {
  return isWindowsShapedPath(path) ? win32 : posix
}

/** Windows 路径形状：盘符（C:\ 或 C:/）或 UNC（\\server\share）。纯规则判断。 */
export function isWindowsShapedPath(path: string): boolean {
  return /^([A-Za-z]:[\\/]|\\\\[^\\])/.test(path)
}

/** 路径是否为绝对路径（POSIX `/` 或 Windows 盘符/UNC；拒绝 `C:relative`）。纯规则。 */
export function isAbsoluteAnyPath(path: string): boolean {
  return isWindowsShapedPath(path) ? win32.isAbsolute(path) : posix.isAbsolute(path)
}

/**
 * 跨平台安全 containment：child 必须等于 root 或位于 root 之下（规范化比较，
 * 不多加目录分隔——root 为 `/` 时 `/foo` 合法包含，`//foo` 不额外产生）。
 * root 与 child 均为已 canonical 解析的路径（调用方保证）。
 */
export function pathContains(root: string, child: string): boolean {
  if (root === child) return true
  const rules = pathRulesFor(root)
  const rootPrefix = root.endsWith(rules.sep) ? root.slice(0, -1) : root
  return child.startsWith(rootPrefix + rules.sep)
}

/**
 * 远端节点输出目录解析（与本地 resolveLocalOutputPath 同一安全边界）：
 * - cwd 依据自身路径形状选用 win32/posix 纯规则拼 `<cwd>/.helm`（Hub 的
 *   node:path.join 会按 Hub 平台拆 Windows 路径——Linux Hub 会把 `\` 当
 *   普通字符产生错误目录名，Windows Hub 会把 POSIX cwd 拆碎）；
 * - cwd 经 env.canonicalPath 校验真实可解析（不可达 = invalid_cwd）；
 * - `<realCwd>/.helm` 必须是真实目录（缺失 = 404 可自愈边界；symlink/非目录 = 逃逸拒绝）；
 * - canonical 后必须仍落在 realCwd 之内（pathContains，中间软链拦截）。
 */
async function resolveNodeOutputDir(
  env: HerdrNodeEnv,
  cwd: string,
  target: string,
  context: Context,
): Promise<{ realCwd: string; realHelm: string }> {
  const rules = pathRulesFor(cwd)
  const canonicalCwd = await env.canonicalPath(cwd, context)
  if (!canonicalCwd.ok) {
    throw new HerdrTransportError(
      'herdr_invalid_cwd',
      `cwd not accessible on node: ${canonicalCwd.error.code}: ${canonicalCwd.error.message}`,
      target,
      { cause: new Error(canonicalCwd.error.message) },
    )
  }
  const realCwd = canonicalCwd.value
  const helmDir = rules.join(realCwd, '.helm')
  const helmInfo = await env.fileInfo(helmDir, context)
  if (!helmInfo.ok) {
    const code = helmInfo.error.code
    if (code === 'not_found' || code === 'not_directory') {
      // 目录缺失 = 交接文件缺失：read 报 404、remove 幂等（一次自愈边界）。
      throw new HelmError('herdr_output_missing', `交接目录不存在: ${helmDir}`, 404)
    }
    throw new HerdrTransportError(
      'herdr_io',
      `failed to inspect ${helmDir}: ${code}: ${helmInfo.error.message}`,
      target,
    )
  }
  if (helmInfo.value.kind === 'symlink' || helmInfo.value.kind !== 'directory') {
    throw new HerdrTransportError('herdr_output_escaping', `.helm must be a real directory inside cwd`, target)
  }
  const canonicalHelm = await env.canonicalPath(helmDir, context)
  if (!canonicalHelm.ok) {
    throw new HerdrTransportError('herdr_io', `failed to resolve ${helmDir}: ${canonicalHelm.error.message}`, target)
  }
  const realHelm = canonicalHelm.value
  if (!pathContains(realCwd, realHelm)) {
    throw new HerdrTransportError('herdr_output_escaping', `.helm resolves outside cwd`, target)
  }
  return { realCwd, realHelm }
}

export async function readNodeOutput(
  nodeChannel: HerdrNodeChannel,
  nodeId: string,
  target: HerdrTarget,
  targetLabel: string,
  cwd: string,
  fileName: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const context = contextOf(signal, targetLabel)
  const env = nodeChannel.envFor(nodeId, cwd)
  const { realHelm } = await resolveNodeOutputDir(env, cwd, targetLabel, context)
  const filePath = pathRulesFor(realHelm).join(realHelm, fileName)
  const info = await env.fileInfo(filePath, context)
  if (!info.ok) {
    if (info.error.code === 'not_found') {
      throw new HelmError('herdr_output_missing', `交接文件不存在: ${filePath}`, 404)
    }
    throw new HerdrTransportError('herdr_io', `failed to inspect output file: ${info.error.code}: ${info.error.message}`, targetLabel)
  }
  if (info.value.kind !== 'file') {
    throw new HerdrTransportError('herdr_output_not_file', `output path is not a regular file: ${filePath}`, targetLabel)
  }
  if (info.value.size > MAX_OUTPUT_BYTES) {
    throw new HerdrTransportError('herdr_output_too_large', `output exceeds ${MAX_OUTPUT_BYTES} bytes`, targetLabel)
  }
  const content = await env.readTextFile(filePath, context)
  if (!content.ok) {
    throw new HerdrTransportError('herdr_io', `failed to read output file: ${content.error.code}: ${content.error.message}`, targetLabel)
  }
  // 读后 canonical 复核（TOCTOU 收敛）：fileInfo(lstat) 与 readTextFile（跟随
  // 软链）之间文件可被替换为符号链接越出 .helm；节点 env 无 O_NOFOLLOW 语义，
  // 以 realpath 复核实际读到的路径仍锚定 realHelm 内（内容已读入但绝不返回）。
  const canonical = await env.canonicalPath(filePath, context)
  if (!canonical.ok) {
    throw new HerdrTransportError('herdr_io', `failed to resolve ${filePath}: ${canonical.error.message}`, targetLabel)
  }
  if (!pathContains(realHelm, canonical.value)) {
    throw new HerdrTransportError('herdr_output_escaping', `output resolves outside .helm`, targetLabel)
  }
  if (Buffer.byteLength(content.value, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new HerdrTransportError('herdr_output_too_large', `output grew past limit while reading`, targetLabel)
  }
  return content.value
}

export async function removeNodeOutput(
  nodeChannel: HerdrNodeChannel,
  nodeId: string,
  targetLabel: string,
  cwd: string,
  fileName: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const context = contextOf(signal, targetLabel)
  const env = nodeChannel.envFor(nodeId, cwd)
  let realHelm: string
  try {
    realHelm = (await resolveNodeOutputDir(env, cwd, targetLabel, context)).realHelm
  } catch (err) {
    // 目录缺失：remove 幂等无操作（与本地语义一致）。
    if (err instanceof HelmError && err.code === 'herdr_output_missing') return
    throw err
  }
  const filePath = pathRulesFor(realHelm).join(realHelm, fileName)
  const info = await env.fileInfo(filePath, context)
  if (!info.ok) {
    if (info.error.code === 'not_found') return // 文件缺失：幂等
    throw new HerdrTransportError('herdr_io', `failed to inspect output file: ${info.error.code}: ${info.error.message}`, targetLabel)
  }
  if (info.value.kind !== 'file') {
    throw new HerdrTransportError('herdr_output_not_file', `output path is not a regular file: ${filePath}`, targetLabel)
  }
  const removed = await env.remove(filePath, { force: true }, context)
  if (!removed.ok) {
    throw new HerdrTransportError('herdr_io', `failed to remove output file: ${removed.error.code}: ${removed.error.message}`, targetLabel)
  }
}
