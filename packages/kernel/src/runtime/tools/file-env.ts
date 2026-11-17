/**
 * Unified execution environment adapters for file tools (`read`/`write`/`edit`). Local (`node:fs`) and remote
 * (`EnvFabric`) branches used to be duplicated line-by-line and are unified here into common operation interfaces
 * and a single tool template with identical behavior:
 *
 * - Local implementation: uses `node:fs/promises` (`canonicalProbe` uses `realpath`; resolution failures like
 *   missing/dangling symlink/EACCES are treated as missing so real `mkdir`/`writeFile` errors surface loudly);
 *   mutex queue uses `localWithFileMutationQueue` (key prefix matches `NodeExecutionEnv.id`, ensuring mutual
 *   exclusion between both local entry points);
 * - Remote implementation: delegates to `EnvFabric` `ExecutionEnv` RPC (`guards.requireRemoteEnv` rejects missing
 *   `EnvFabric` or offline nodes explicitly, never falling back silently to Hub's disk); unwraps `Result` inside the
 *   adapter and throws on failure (outer template formats redacted `*_failed` text uniformly); mutex queue uses
 *   `envWithFileMutationQueue` (shares canonical-path mutex queues per target node with plugin APIs so updates to
 *   the same file never get lost; see `env/file-mutation-queue.ts`);
 * - Read classification messages (directory/special file/size cap) are defined in one place and shared by local
 *   preflight, local post-open verification, and remote `fileInfo` without drift.
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

/** Single-file byte cap for `read` (explicit cap aligned with spill preview limit). */
export const READ_FILE_MAX_BYTES = 128 * 1024

/** Shared `read` classification messages (used across local preflight, post-open re-check, and remote `fileInfo`).
 * Note: `'is directory'` and `'not ordinary file'` wording are preserved for compatibility with existing test checks. */
const readDirectoryText = (raw: string): string => `read_failed: ${raw} is directory; read only supports regular files`
const fileTooLargeText = (raw: string, size: number): string =>
  `file_too_large: ${raw} is ${size} bytes, exceeding the ${READ_FILE_MAX_BYTES}-byte cap for read. ` +
  'Redirect command output via bash to a file and read it paginated with read_artifact, or slice with head/tail/sed.'

/** Canonical probe result shape (aligned with `ExecutionEnv.canonicalPath` `Result`). */
export type CanonicalProbeResult =
  | { ok: true; value: string }
  | { ok: false; error: { code: string; message: string } }

/**
 * Unified writable execution environment for `write`/`edit`: node-agnostic single template.
 * Unwraps `Result` inside and throws on failure; outer template catches and returns redacted `*_failed` text.
 */
export interface WritableFileEnv {
  /** Canonical probe: resolves existing files (and symlinks) to their canonical paths (so symlink writes align with
   *  their target in mutex queues); falls back to lexical absolute path when missing. */
  canonicalProbe(path: string, context: Context): Promise<CanonicalProbeResult>
  /** Read full UTF-8 text. */
  readTextFile(path: string, context: Context): Promise<string>
  /** Write full UTF-8 text. */
  writeFile(path: string, content: string, context: Context): Promise<void>
  /** Recursively ensure parent directory exists. */
  ensureDir(path: string, context: Context): Promise<void>
  /** Read-modify-write mutex window (shared local/remote canonical namespace; see `env/file-mutation-queue.ts`). */
  withMutationQueue<T>(path: string, fn: () => Promise<T>, context: Context): Promise<T>
}

/**
 * Unified readable execution environment for `read`: classification errors (directory/special file/oversized)
 * return tool-level error text, while genuine IO/resolution failures throw (formatted by outer template as `read_failed`).
 * `displayPath`: canonicalized path remotely, lexical absolute path locally (preserved contract).
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

/** Local write/edit implementation: in-process `node:fs`; errors propagate as-is. */
function localWritableEnv(): WritableFileEnv {
  return {
    // Use realpath directly for canonicalPath; treat resolution failures (missing/dangling symlink/EACCES)
    // as missing so real IO errors surface on subsequent mkdir/writeFile.
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

/** Remote write/edit implementation: `EnvFabric` RPC; unwraps `Result` and throws on failure. */
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

/** Local read implementation: `stat` preflight + authoritative `fstat` re-check on the same open fd. */
function localReadableEnv(): ReadableFileEnv {
  return {
    async readText(lexicalAbs, raw, _context) {
      // In-process `fs.stat` (follows symlinks) classifies directories/special files/size caps cleanly before opening,
      // then opens fd once and validates via `fstat` on the exact same fd so a swap between `stat` and `open` is caught.
      const info = await stat(lexicalAbs)
      if (info.isDirectory()) return { ok: false, errorText: readDirectoryText(raw) }
      if (!info.isFile()) {
        return { ok: false, errorText: `read_failed: ${raw} is not ordinary file (special file)` }
      }
      if (info.size > READ_FILE_MAX_BYTES) return { ok: false, errorText: fileTooLargeText(raw, info.size) }
      // Follow symlinks on open (same privilege boundary as bash: symlinks are the user's filesystem reality);
      // re-verify the opened fd with `fstat` in case the target changed after preflight.
      const handle = await open(lexicalAbs, fsConstants.O_RDONLY)
      try {
        const statInfo = await handle.stat()
        if (!statInfo.isFile()) {
          return { ok: false, errorText: `read_failed: ${raw} is not ordinary file after open; read rejected` }
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

/** Remote read implementation: `env` RPC `canonicalPath` + `fileInfo` + `readTextFile`. */
function remoteReadableEnv(env: ExecutionEnv): ReadableFileEnv {
  return {
    async readText(lexicalAbs, raw, context) {
      // Resolve symlinks via `canonicalPath` first: `fileInfo` has `lstat` semantics (`kind='symlink'`), so
      // canonicalizing aligns symlink-following semantics with local; missing/dangling targets throw (`read_failed`).
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

/** Construct `read` execution environment: guards remote nodes first (explicit error text), local uses `node:fs`. */
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

/** Construct `write`/`edit` execution environment: guards remote nodes first (explicit error text), local uses `node:fs`. */
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
 * Resolve writable target path: `cwd` (`base`) acts only as base for relative paths; absolute paths and `../`
 * traversals are permitted (same boundary as `bash`, enforced by OS permissions). Lexical resolution follows
 * target path shape (`posix`/`win32`, never Hub host default), rejecting Windows drive-relative paths (`C:rel`).
 * Existing targets resolve via `canonicalPath`/`realpath` so symlink writes target the real file and align with
 * `env/file-mutation-queue` canonical keys; missing targets (including dangling symlinks — `writeFile` creates the
 * symlink target, matching bash redirection) fall back to lexical absolute path; real permission errors surface
 * on subsequent `mkdir`/`writeFile`.
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

/** `dirname` using the path shape's rules (`win32` backslash separators). */
export function dirnameForShape(abs: string): string {
  return nodePathForShape(targetPathShape(abs)).dirname(abs)
}

/** `basename` using the path shape's rules. */
export function basenameForShape(abs: string): string {
  return nodePathForShape(targetPathShape(abs)).basename(abs)
}
