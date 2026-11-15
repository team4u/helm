/**
 * 文件工具统一执行环境适配（read/write/edit 的 local 分支与 EnvFabric 远端
 * 分支原为逐行复制，此处收敛为同一操作面 + 单一工具模板，行为等价）：
 *
 * - local 实现：进程内 node:fs/promises（canonicalProbe 用 realpath；解析
 *   失败（不存在/悬空软链/无权等）按「不存在」处理，真实错误由随后的
 *   mkdir/writeFile 如实上抛）；互斥队列用 localWithFileMutationQueue
 *   （key 前缀与 NodeExecutionEnv.id 一致，local 两种入口互斥）；
 * - 远端实现：EnvFabric 的 ExecutionEnv env RPC（经 guards.requireRemoteEnv
 *   守卫获取，EnvFabric 缺失 / 节点离线显式失败，绝不回退本机误读写 Hub
 *   磁盘）；Result 形态在实现内解包，失败一律 throw（外层工具模板统一转
 *   *_failed 脱敏文本）；互斥队列用 envWithFileMutationQueue（与插件 API
 *   共享同一目标节点 canonical 路径互斥队列，同文件不丢更新；详见
 *   env/file-mutation-queue.ts 契约）；
 * - read 的分类文案（目录/特殊文件/超限）在此常量化，local 预检、local
 *   打开后复核与远端 fileInfo 共用，绝不漂移。
 */
import type { Context } from '@earendil-works/chord'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { constants as fsConstants } from 'node:fs'
import { mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { targetPathShape, type TargetPlatform } from '@helm/protocol'
import { envWithFileMutationQueue, localWithFileMutationQueue } from '../../env/file-mutation-queue.js'
import { nodePathForShape, resolveTargetPath } from './target-path.js'
import { requireRemoteEnv, type FileOpAction } from './guards.js'
import type { HelmToolDeps } from '../tool-deps.js'

/** read 工具单文件上限：与 spill 预览链路一致的明确限额。 */
export const READ_FILE_MAX_BYTES = 128 * 1024

/** read 工具共享分类文案（local 预检 / local 打开后复核 / 远端 fileInfo 共用）。 */
const readDirectoryText = (raw: string): string => `read_failed: ${raw} 是目录，read 仅支持普通文件`
const fileTooLargeText = (raw: string, size: number): string =>
  `file_too_large: ${raw} 为 ${size} 字节，超过 read 工具 ${READ_FILE_MAX_BYTES} 字节上限。` +
  '请用 bash 命令输出到文件后经 read_artifact 分页读取，或用 head/tail/sed 取所需片段。'

/** canonical 探测结果形态（与 ExecutionEnv.canonicalPath 的 Result 一致）。 */
export type CanonicalProbeResult =
  | { ok: true; value: string }
  | { ok: false; error: { code: string; message: string } }

/**
 * write/edit 的统一执行环境：单一工具模板不感知节点位置。
 * 操作失败一律 throw（Result 仅在实现内解包），外层统一转 *_failed 脱敏文本。
 */
export interface WritableFileEnv {
  /** canonical 探测：目标已存在时解析到真实路径（软链别名写到真实文件，与
   * 互斥队列 key 对齐）；不存在时由调用方按词法绝对路径回退。 */
  canonicalProbe(path: string, context: Context): Promise<CanonicalProbeResult>
  /** 读全文（UTF-8）。 */
  readTextFile(path: string, context: Context): Promise<string>
  /** 写全文（UTF-8）。 */
  writeFile(path: string, content: string, context: Context): Promise<void>
  /** 递归确保父目录存在。 */
  ensureDir(path: string, context: Context): Promise<void>
  /** 读-改-写互斥窗口（local 与远端 key 空间互斥，见 env/file-mutation-queue.ts）。 */
  withMutationQueue<T>(path: string, fn: () => Promise<T>, context: Context): Promise<T>
}

/**
 * read 的统一执行环境：预检分类（目录/特殊文件/超限）返回工具级错误文本，
 * 真实 IO/解析失败一律 throw（外层统一转 read_failed 脱敏文本）。
 * displayPath：远端为 canonical 解析后路径，local 为词法绝对路径（回显契约）。
 */
export interface ReadableFileEnv {
  readText(
    lexicalAbs: string,
    raw: string,
    context: Context,
  ): Promise<
    | { ok: true; content: string; displayPath: string }
    | { ok: false; errorText: string }
  >
}

/** local write/edit 实现：进程内 fs，错误自然上抛。 */
function localWritableEnv(): WritableFileEnv {
  return {
    // canonicalPath 直接用 realpath；解析失败（不存在/悬空软链/无权等）一律
    // 按「不存在」处理，真实错误由随后的 mkdir/writeFile 如实上抛。
    canonicalProbe: async (path, _context): Promise<CanonicalProbeResult> => {
      try {
        return { ok: true, value: await realpath(path) }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: (error as { code?: string }).code ?? 'not_found',
            message: String(error),
          },
        }
      }
    },
    readTextFile: (path, _context) => readFile(path, 'utf8'),
    writeFile: async (path, content, _context) => {
      await writeFile(path, content, 'utf8')
    },
    ensureDir: async (path, _context) => {
      await mkdir(path, { recursive: true })
    },
    withMutationQueue: (path, fn, context) => localWithFileMutationQueue(path, fn, context.abortSignal),
  }
}

/** 远端 write/edit 实现：EnvFabric env RPC，Result 在此解包、失败上抛。 */
function remoteWritableEnv(env: ExecutionEnv): WritableFileEnv {
  return {
    canonicalProbe: (path, context) => env.canonicalPath(path, context),
    readTextFile: async (path, context) => {
      const result = await env.readTextFile(path, context)
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    writeFile: async (path, content, context) => {
      const result = await env.writeFile(path, content, context)
      if (!result.ok) throw new Error(result.error.message)
    },
    ensureDir: async (path, context) => {
      const result = await env.createDir(path, { recursive: true }, context)
      if (!result.ok) throw new Error(result.error.message)
    },
    withMutationQueue: (path, fn, context) => envWithFileMutationQueue(env, path, fn, context),
  }
}

/** local read 实现：stat 预检 + 同 fd fstat 权威复核。 */
function localReadableEnv(): ReadableFileEnv {
  return {
    async readText(lexicalAbs, raw, _context) {
      // 进程内 fs。stat（跟随软链）先做普通文件预检，给出清晰错误分类
      //（目录/特殊文件/超限）；随后 fd 读取：fstat 与读取同一 fd，校验即
      // 所读内容（打开与预检之间目标被替换时以 fd 为准）。
      const info = await stat(lexicalAbs)
      if (info.isDirectory()) return { ok: false, errorText: readDirectoryText(raw) }
      if (!info.isFile()) {
        return { ok: false, errorText: `read_failed: ${raw} 不是普通文件（特殊文件）` }
      }
      if (info.size > READ_FILE_MAX_BYTES) return { ok: false, errorText: fileTooLargeText(raw, info.size) }
      // 打开跟随软链（与 bash 同权，软链指向哪里是用户文件系统自己的事实）；
      // 预检之后、打开之前目标被替换时，以同一 fd 上的 fstat 复核为准。
      const handle = await open(lexicalAbs, fsConstants.O_RDONLY)
      try {
        const statInfo = await handle.stat()
        if (!statInfo.isFile()) {
          return { ok: false, errorText: `read_failed: ${raw} 在打开后不是普通文件，拒绝读取` }
        }
        if (statInfo.size > READ_FILE_MAX_BYTES) {
          return { ok: false, errorText: fileTooLargeText(raw, statInfo.size) }
        }
        return {
          ok: true,
          content: await handle.readFile({ encoding: 'utf8' }),
          displayPath: lexicalAbs,
        }
      } finally {
        await handle.close()
      }
    },
  }
}

/** 远端 read 实现：env RPC 的 canonicalPath + fileInfo + readTextFile。 */
function remoteReadableEnv(env: ExecutionEnv): ReadableFileEnv {
  return {
    async readText(lexicalAbs, raw, context) {
      // 先经 canonicalPath 解析软链：fileInfo 是 lstat 语义（软链
      // kind='symlink'），解析到真实目标后才能与 local 的跟随语义一致；
      // 目标不存在/悬空软链在此如实报错（throw 由外层统一转 read_failed）。
      const targetRealR = await env.canonicalPath(lexicalAbs, context)
      if (!targetRealR.ok) throw new Error(targetRealR.error.message)
      const targetReal = targetRealR.value
      const infoR = await env.fileInfo(targetReal, context)
      if (!infoR.ok) throw new Error(infoR.error.message)
      if (infoR.value.kind === 'directory') return { ok: false, errorText: readDirectoryText(raw) }
      if (infoR.value.kind !== 'file') {
        return { ok: false, errorText: `read_failed: ${raw} 不是普通文件（kind=${infoR.value.kind}）` }
      }
      if (infoR.value.size > READ_FILE_MAX_BYTES) {
        return { ok: false, errorText: fileTooLargeText(raw, infoR.value.size) }
      }
      const contentR = await env.readTextFile(targetReal, context)
      if (!contentR.ok) throw new Error(contentR.error.message)
      return { ok: true, content: contentR.value, displayPath: targetReal }
    },
  }
}

/** 构造 read 执行环境：远端先过守卫（显式失败文本），local 直连进程内 fs。 */
export function readableEnvFor(
  deps: HelmToolDeps,
  nodeId: string,
  base: string,
): { error: string } | { env: ReadableFileEnv } {
  if (nodeId !== 'local') {
    const remote = requireRemoteEnv(deps.envFabric, nodeId, base, '读取')
    if ('error' in remote) return { error: remote.error }
    return { env: remoteReadableEnv(remote.env) }
  }
  return { env: localReadableEnv() }
}

/** 构造 write/edit 执行环境：远端先过守卫（显式失败文本），local 直连进程内 fs。 */
export function writableEnvFor(
  deps: HelmToolDeps,
  nodeId: string,
  base: string,
  action: Extract<FileOpAction, '写入' | '编辑'>,
): { error: string } | { env: WritableFileEnv } {
  if (nodeId !== 'local') {
    const remote = requireRemoteEnv(deps.envFabric, nodeId, base, action)
    if ('error' in remote) return { error: remote.error }
    return { env: remoteWritableEnv(remote.env) }
  }
  return { env: localWritableEnv() }
}

/**
 * 靶点路径解析：cwd（base）仅作相对路径基准，绝对路径与 ../ 跨目录均
 * 允许（与 bash 同权，不设 cwd 沙箱）；权限边界交给操作系统本身。
 * 词法解析按目标路径形状的纯 posix/win32 规则（绝不用 Hub 宿主 path 默认
 * 规则解析远端路径）；盘符相对路径（C:relative）在此显式拒绝。目标已存在时
 * 经 canonicalPath/realpath 解析到真实路径再写——软链别名写到真实文件，
 * 且与 env/file-mutation-queue 的 canonical key 对齐；不存在（含悬空软链，
 * writeFile 会跟随它在目标处创建文件，与 bash 重定向语义一致）按词法绝对
 * 路径写入；无权探测等真实错误由后续 mkdir/writeFile 如实上抛。
 */
export async function resolveWritableTarget(
  probe: (path: string, context: Context) => Promise<CanonicalProbeResult>,
  raw: string,
  base: string,
  platform: TargetPlatform | undefined,
  context: Context,
): Promise<{ ok: true; abs: string } | { ok: false; message: string }> {
  const resolvedR = resolveTargetPath(raw, base, platform)
  if (!resolvedR.ok) return { ok: false, message: `invalid_path: ${resolvedR.reason}` }
  const absolute = resolvedR.abs
  const targetRealR = await probe(absolute, context)
  if (targetRealR.ok) return { ok: true, abs: targetRealR.value }
  return { ok: true, abs: absolute }
}

/** 按目标形状取 dirname（win32 反斜杠分隔符规则）。 */
export function dirnameForShape(abs: string): string {
  return nodePathForShape(targetPathShape(abs)).dirname(abs)
}

/** 按目标形状取 basename。 */
export function basenameForShape(abs: string): string {
  return nodePathForShape(targetPathShape(abs)).basename(abs)
}
