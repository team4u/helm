/**
 * 原子文件写入与带边界错误信息的的安全读取。
 * 写路径：临时文件（随机 uuid 名 + 0600）→ fsync → rename，崩溃不留半截内容；
 * 0600 确保凭据等机密内容不会经临时文件泄漏权限。
 */
import fsp from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Windows 上 rename 替换目标被读取方（并发读/杀毒/索引）短暂占用时的有界退避参数。 */
const RENAME_BUSY_TOTAL_MS = 1_500
const RENAME_BUSY_INITIAL_POLL_MS = 5
const RENAME_BUSY_MAX_POLL_MS = 50

export class FileNotFoundError extends Error {
  constructor(path: string) {
    super(`文件不存在: ${path}`)
    this.name = 'FileNotFoundError'
  }
}

export class FileParseError extends Error {
  constructor(
    path: string,
    public readonly cause: unknown,
  ) {
    super(`JSON 解析失败: ${path}: ${String(cause)}`)
    this.name = 'FileParseError'
  }
}

/**
 * Windows 瞬时占用判定：目标被读取/扫描期间 rename 会短暂 EPERM/EACCES/EBUSY，
 * 有界退避重试即可提交。其他平台这些码属于真实权限/挂载错误，立即失败。
 */
function isTransientRenameBusy(err: unknown): boolean {
  if (process.platform !== 'win32') return false
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

/**
 * rename 原子替换；仅 Windows 瞬时占用时指数退避（5→50ms，总窗口约 1.5s），
 * 耗尽仍保留原始 ErrnoException（含 code），仅追加重试诊断便于区分权限错误。
 */
async function renameAtomically(tmp: string, targetPath: string): Promise<void> {
  const startedAt = Date.now()
  const deadline = startedAt + RENAME_BUSY_TOTAL_MS
  let retries = 0
  for (;;) {
    try {
      await fsp.rename(tmp, targetPath)
      return
    } catch (err) {
      if (!isTransientRenameBusy(err) || Date.now() >= deadline) {
        if (retries > 0 && err instanceof Error) {
          const elapsed = Date.now() - startedAt
          try {
            err.message = `${err.message}（Windows 目标文件瞬时占用，已重试 ${retries} 次 / ${elapsed}ms 仍失败）`
          } catch {
            /* message 不可写时保留原错误 */
          }
        }
        throw err
      }
      const delayMs = Math.min(RENAME_BUSY_MAX_POLL_MS, RENAME_BUSY_INITIAL_POLL_MS * 2 ** retries)
      retries += 1
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

/** 原子写文件：temp(随机 uuid, 0600) → fsync → rename。exclusive 防并发重名。 */
export async function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
  opts?: { mode?: number },
): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  const mode = opts?.mode ?? 0o600
  const handle = await fsp.open(tmp, 'w', mode)
  let handleClosed = false
  try {
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
      handleClosed = true
    }
    await renameAtomically(tmp, path)
  } catch (err) {
    if (!handleClosed) await handle.close().catch(() => {})
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/** 原子写 JSON（UTF-8，2 空格缩进，稳定键序便于人工审查与 diff）。 */
export async function atomicWriteJson(
  path: string,
  value: unknown,
  opts?: { mode?: number },
): Promise<void> {
  const text = JSON.stringify(value, null, 2) + '\n'
  await atomicWriteFile(path, text, opts)
}

/** 读取 UTF-8 文本；缺失抛 FileNotFoundError（含路径，不静默返回空）。 */
export async function readTextFile(path: string): Promise<string> {
  try {
    return await fsp.readFile(path, 'utf8')
  } catch (err) {
    if (isNoSuchFileError(err)) throw new FileNotFoundError(path)
    throw err
  }
}

/** 读取并解析 JSON；缺失抛 FileNotFoundError，损坏抛 FileParseError（均含路径）。 */
export async function readJsonFile(path: string): Promise<unknown> {
  const text = await readTextFile(path)
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new FileParseError(path, err)
  }
}

/** 读取可选 JSON：缺失返回 undefined，损坏仍抛 FileParseError（诚实暴露）。 */
export async function readJsonFileOptional(path: string): Promise<unknown> {
  try {
    return await readJsonFile(path)
  } catch (err) {
    if (err instanceof FileNotFoundError) return undefined
    throw err
  }
}

/** 复制文件（保留目标 0600，用于 artifacts 收纳来源文件）。 */
export async function copyFilePrivate(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dirname(dest), { recursive: true })
  const tmp = join(dirname(dest), `.${randomUUID()}.tmp`)
  try {
    await fsp.copyFile(src, tmp)
    await renameAtomically(tmp, dest)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  // rename 保留源模式位；机密边界统一收敛为 0600（POSIX chmod 对 Windows 无意义，跳过）。
  if (process.platform !== 'win32') {
    const handle = await fsp.open(dest, 'r')
    try {
      await handle.chmod(0o600)
    } finally {
      await handle.close()
    }
  }
}

/**
 * 判定路径当前模式位是否不含 group/other 权限（即私有）。
 *
 * Windows 的 NTFS/ACL 不承载 POSIX group/other 位，Node stat.mode 仅反映
 * 只读位；0600 语义不可用，直接视为私有（与 node/doctor.ts 的平台约定一致）。
 * 非 Windows 仍严格校验：模式位含 group/other 即非私有。
 */
export async function isPrivateMode(path: string): Promise<boolean> {
  // 即使 Windows 不检查 POSIX mode，也要先 stat，避免把文件消失或权限错误静默视为私有。
  const s = await fsp.stat(path)
  if (process.platform === 'win32') return true
  return (s.mode & 0o077) === 0
}

function isNoSuchFileError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOENT'
  )
}
