/**
 * file tool unify execute environment adapt (read/write/edit  local branch and EnvFabric remote
 * branch original is one by one row duplicate, this where converge is the same operation side + single one tool template, behavior etc. price):
 *
 * - local implement: process inside node:fs/promises(canonicalProbe use realpath; parse
 *   failed (missing/dangling symlink/without right etc.) by missing handle, real error by then
 *   mkdir/writeFile such as on throw); mutual exclusion queue use localWithFileMutationQueue
 *   (key prefix and NodeExecutionEnv.id consistent,local two kinds of entry mutual exclusion);
 * - remote implement:EnvFabric  ExecutionEnv env RPC(via guards.requireRemoteEnv
 *   guard get,EnvFabric missing / node offline explicit failed, never fall back local machine mistakenly read write Hub
 *   disk);Result form in implement inside unwrap, failed one rule throw(outside layer tool template unify rotate
 *   *_failed redaction text); mutual exclusion queue use envWithFileMutationQueue(and plugin API
 *   sharing the same target node canonical path mutual exclusion queue, same file do not lose update; detail see
 *   env/file-mutation-queue.ts contract);
 * - read classify text proposal (directory/special file/over limit) in this constant,local preflight,local
 *   open after re-check and remote fileInfo shared use, never drift.
 */
import type { Context } from '@earendil-works/chord/context'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { constants as fsConstants } from 'node:fs'
import { mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { targetPathShape, type TargetPlatform } from '@helm/protocol'
import { envWithFileMutationQueue, localWithFileMutationQueue } from '../../env/file-mutation-queue.js'
import { nodePathForShape, resolveTargetPath } from './target-path.js'
import { requireRemoteEnv, type FileOpAction } from './guards.js'
import type { HelmToolDeps } from '../tool-deps.js'

/** read tool single file cap: and spill preview link consistent explicit limit quota. */
export const READ_FILE_MAX_BYTES = 128 * 1024

/** read tool sharing classify text proposal (local preflight / local open after re-check / remote fileInfo shared use). */
const readDirectoryText = (raw: string): string => `read_failed: ${raw} is directory,read only support ordinary file`
const fileTooLargeText = (raw: string, size: number): string =>
  `file_too_large: ${raw} is ${size} byte, exceeds read tool ${READ_FILE_MAX_BYTES} byte cap.` +
  'please use bash command output to file after via read_artifact page read, or use head/tail/sed take which must fragment.'

/** canonical probe result form (and ExecutionEnv.canonicalPath  Result consistent). */
export type CanonicalProbeResult =
  | { ok: true; value: string }
  | { ok: false; error: { code: string; message: string } }

/**
 * write/edit unify execute environment: single one tool template unaware of node location.
 * operation failed one rule throw(Result only in implement inside unwrap), outside layer unify rotate *_failed redaction text.
 */
export interface WritableFileEnv {
  /** canonical probe: target already exists when parse to real path (symlink alias write to real file, and
   * mutual exclusion queue key align); missing when by caller by term method absolute path fall back. */
  canonicalProbe(path: string, context: Context): Promise<CanonicalProbeResult>
  /** read all text (UTF-8). */
  readTextFile(path: string, context: Context): Promise<string>
  /** write all text (UTF-8). */
  writeFile(path: string, content: string, context: Context): Promise<void>
  /** recursion ensure parent directory store in. */
  ensureDir(path: string, context: Context): Promise<void>
  /** read-change-write mutual exclusion window (local and remote key empty between mutual exclusion, see env/file-mutation-queue.ts). */
  withMutationQueue<T>(path: string, fn: () => Promise<T>, context: Context): Promise<T>
}

/**
 * read unify execute environment: preflight classify (directory/special file/over limit) return tool level error text,
 * real IO/failed to parse one rule throw(outside layer unify rotate read_failed redaction text).
 * displayPath: remote is canonical parse after path,local is term method absolute path (back visible contract).
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

/** local write/edit implement: process inside fs, error self however on throw. */
function localWritableEnv(): WritableFileEnv {
  return {
    // canonicalPath directly use realpath; failed to parse (missing/dangling symlink/without right etc.) one rule
    // by missing handle, real error by then mkdir/writeFile such as on throw.
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

/** remote write/edit implement:EnvFabric env RPC,Result in this unwrap, failed on throw. */
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

/** local read implement:stat preflight + same fd fstat right threat re-check. */
function localReadableEnv(): ReadableFileEnv {
  return {
    async readText(lexicalAbs, raw, _context) {
      // process inside fs.stat(with follow symlink) first do ordinary file preflight, to out clear error classify
      //(directory/special file/over limit); then fd read:fstat and read the same fd, validate i.e.
      // which read content (open and preflight between target by replace when with fd is allow).
      const info = await stat(lexicalAbs)
      if (info.isDirectory()) return { ok: false, errorText: readDirectoryText(raw) }
      if (!info.isFile()) {
        return { ok: false, errorText: `read_failed: ${raw} is not ordinary file (special file)` }
      }
      if (info.size > READ_FILE_MAX_BYTES) return { ok: false, errorText: fileTooLargeText(raw, info.size) }
      // open with follow symlink (and bash same right, symlink points to which in is user file system itself fact);
      // preflight after, open before target by replace when, with the same fd on fstat re-check is allow.
      const handle = await open(lexicalAbs, fsConstants.O_RDONLY)
      try {
        const statInfo = await handle.stat()
        if (!statInfo.isFile()) {
          return { ok: false, errorText: `read_failed: ${raw} in open after is not ordinary file, reject read` }
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

/** remote read implement:env RPC  canonicalPath + fileInfo + readTextFile. */
function remoteReadableEnv(env: ExecutionEnv): ReadableFileEnv {
  return {
    async readText(lexicalAbs, raw, context) {
      // first via canonicalPath parse symlink:fileInfo is lstat semantics (symlink
      // kind='symlink'), parse to real target after only then can and local with follow semantics consistent;
      // target missing/dangling symlink in this such as errors (throw by outside layer unify rotate read_failed).
      const targetRealR = await env.canonicalPath(lexicalAbs, context)
      if (!targetRealR.ok) throw new Error(targetRealR.error.message)
      const targetReal = targetRealR.value
      const infoR = await env.fileInfo(targetReal, context)
      if (!infoR.ok) throw new Error(infoR.error.message)
      if (infoR.value.kind === 'directory') return { ok: false, errorText: readDirectoryText(raw) }
      if (infoR.value.kind !== 'file') {
        return { ok: false, errorText: `read_failed: ${raw} is not ordinary file (kind=${infoR.value.kind})` }
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

/** construct read execute environment: remote first guard (explicit failed text),local direct connect process inside fs. */
export function readableEnvFor(
  deps: HelmToolDeps,
  nodeId: string,
  base: string,
): { error: string } | { env: ReadableFileEnv } {
  if (nodeId !== 'local') {
    const remote = requireRemoteEnv(deps.envFabric, nodeId, base, 'read')
    if ('error' in remote) return { error: remote.error }
    return { env: remoteReadableEnv(remote.env) }
  }
  return { env: localReadableEnv() }
}

/** construct write/edit execute environment: remote first guard (explicit failed text),local direct connect process inside fs. */
export function writableEnvFor(
  deps: HelmToolDeps,
  nodeId: string,
  base: string,
  action: Extract<FileOpAction, 'write' | 'edit'>,
): { error: string } | { env: WritableFileEnv } {
  if (nodeId !== 'local') {
    const remote = requireRemoteEnv(deps.envFabric, nodeId, base, action)
    if ('error' in remote) return { error: remote.error }
    return { env: remoteWritableEnv(remote.env) }
  }
  return { env: localWritableEnv() }
}

/**
 * target path parse:cwd(base) only act relative path base allow, absolute path and ../ across directory all
 * allows (and bash same right, do not set cwd sandbox); permission boundary hand over to OS itself.
 * term method parse by target path shape pure posix/win32 rule (never use Hub host path by default
 * rule parse remote path); symbol relative path (C:relative) in this explicit reject. target already exists when
 * via canonicalPath/realpath parse to real path again write - - symlink alias write to real file,
 * and and env/file-mutation-queue  canonical key align; missing (contains dangling symlink,
 * writeFile will with follow it in target where create file, and bash heavy set to semantics consistent) by term method absolute
 * path write; without right probe etc. real error by after continue mkdir/writeFile such as on throw.
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

/** by target shape take dirname(win32 backslash isolate symbol rule). */
export function dirnameForShape(abs: string): string {
  return nodePathForShape(targetPathShape(abs)).dirname(abs)
}

/** by target shape take basename. */
export function basenameForShape(abs: string): string {
  return nodePathForShape(targetPathShape(abs)).basename(abs)
}
