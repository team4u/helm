/**
 * Conversation workspace file reader: reads a single regular file strictly within a
 * conversation's bound (nodeId, cwd) workspace.
 *
 * - Enforces strict lexical + canonical containment (never equal to cwdReal, catches
 *   `..` escapes and symlink escapes on both local and remote nodes).
 * - Uses bounded O_NONBLOCK + O_NOFOLLOW local reads and remote openBinaryReader
 *   capped at MAX_ARTIFACT_BYTES (15 MiB) with concurrent-modification checks.
 * - Text files are decoded as UTF-8, redacted via SecretStash, and returned with
 *   `; charset=utf-8`; binary files are returned byte-for-byte untouched.
 */
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import type { FileError } from '@earendil-works/pi-durable/env'
import { HelmError, targetPathShape } from '@helm/protocol'
import { open, realpath } from 'node:fs/promises'
import type { EnvFabric } from '../env/index.js'
import { MAX_ARTIFACT_BYTES, detectWorkspaceFileMime } from '../services/index.js'
import { targetPlatformForNode } from './target-platform.js'
import { artifactOpenFlags, readArtifactBytesFromHandle } from './tools/artifact-tools.js'
import { basenameForShape } from './tools/file-env.js'
import { resolveTargetPath, isStrictlyInsideRoot } from './tools/target-path.js'

export interface ConversationFileContent {
  bytes: Uint8Array
  mimeType: string
  name: string
  resolvedPath: string
}

interface ReadWorkspaceFileDeps {
  nodeId: string
  cwd: string
  rawPath: string
  envFabric?: EnvFabric
  redact?: (text: string) => string
  signal?: AbortSignal
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new HelmError('aborted', 'workspace file read cancelled', 499)
  }
}

function pathsEqualForShape(a: string, b: string, shape: 'posix' | 'win32' | undefined): boolean {
  return shape === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function mapLocalFsError(error: unknown, rawPath: string, fromOpenNoFollow = false): HelmError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new HelmError('file_not_found', `file not found: ${rawPath}`, 404)
  }
  if (code === 'EISDIR') {
    return new HelmError('not_a_regular_file', `requested path is not a regular file: ${rawPath}`, 400)
  }
  if (code === 'ELOOP') {
    return fromOpenNoFollow
      ? new HelmError('path_outside_workspace', 'requested path is outside conversation workspace', 403)
      : new HelmError('invalid_path', `symlink loop at path: ${rawPath}`, 400)
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new HelmError('permission_denied', `permission denied: ${rawPath}`, 403)
  }
  return new HelmError(
    'file_read_failed',
    error instanceof Error ? error.message : String(error),
    500,
  )
}

function mapRemoteFileError(error: FileError, rawPath: string): HelmError {
  if (error.code === 'not_found' || error.code === 'not_directory') {
    return new HelmError('file_not_found', `file not found: ${rawPath}`, 404)
  }
  if (error.code === 'is_directory') {
    return new HelmError('not_a_regular_file', `requested path is not a regular file: ${rawPath}`, 400)
  }
  if (error.code === 'permission_denied') {
    return new HelmError('permission_denied', `permission denied: ${rawPath}`, 403)
  }
  if (error.code === 'aborted') {
    return new HelmError('aborted', 'workspace file read cancelled', 499)
  }
  if (error.code === 'invalid') {
    const msg = error.message.toLowerCase()
    if (msg.includes('symbolic link') || msg.includes('symlink') || msg.includes('eloop')) {
      return new HelmError('path_outside_workspace', 'requested path is outside conversation workspace', 403)
    }
    return new HelmError('not_a_regular_file', error.message, 400)
  }
  return new HelmError('file_read_failed', error.message, 502)
}

async function readLocalWorkspaceFile(
  rawPath: string,
  cwdNorm: string,
  lexicalAbs: string,
  lexicalShape: 'posix' | 'win32' | undefined,
  signal?: AbortSignal,
): Promise<{ rawBytes: Uint8Array; resolvedPath: string }> {
  assertNotAborted(signal)
  let cwdReal: string
  try {
    cwdReal = await realpath(cwdNorm)
  } catch (error) {
    throw mapLocalFsError(error, cwdNorm)
  }
  const realShape = targetPathShape(cwdReal) ?? lexicalShape
  if (!isStrictlyInsideRoot(lexicalAbs, cwdNorm, lexicalShape) && !isStrictlyInsideRoot(lexicalAbs, cwdReal, realShape)) {
    throw new HelmError('path_outside_workspace', 'requested path is outside conversation workspace', 403)
  }
  assertNotAborted(signal)
  let targetReal: string
  try {
    targetReal = await realpath(lexicalAbs)
  } catch (error) {
    throw mapLocalFsError(error, rawPath)
  }
  if (!isStrictlyInsideRoot(targetReal, cwdReal, realShape)) {
    throw new HelmError('path_outside_workspace', 'requested path is outside conversation workspace', 403)
  }
  assertNotAborted(signal)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(targetReal, artifactOpenFlags({ noFollow: true }))
  } catch (error) {
    throw mapLocalFsError(error, rawPath, true)
  }
  try {
    const statInfo = await handle.stat()
    if (!statInfo.isFile()) {
      throw new HelmError('not_a_regular_file', `requested path is not a regular file: ${rawPath}`, 400)
    }
    if (statInfo.size > MAX_ARTIFACT_BYTES) {
      throw new HelmError(
        'file_too_large',
        `file size ${statInfo.size} exceeds ${MAX_ARTIFACT_BYTES} byte limit`,
        413,
        { maxBytes: MAX_ARTIFACT_BYTES, actualBytes: statInfo.size },
      )
    }
    const read = await readArtifactBytesFromHandle(handle)
    if (!read.ok) {
      if (read.code === 'artifact_too_large') {
        throw new HelmError(
          'file_too_large',
          `file size ${read.read} exceeds ${MAX_ARTIFACT_BYTES} byte limit`,
          413,
          { maxBytes: MAX_ARTIFACT_BYTES, actualBytes: read.read },
        )
      }
      throw new HelmError('file_changed', read.detail, 409)
    }
    return {
      rawBytes: new Uint8Array(read.bytes.buffer, read.bytes.byteOffset, read.bytes.byteLength),
      resolvedPath: targetReal,
    }
  } finally {
    await handle.close()
  }
}

async function readRemoteWorkspaceFile(
  envFabric: EnvFabric | undefined,
  nodeId: string,
  cwd: string,
  rawPath: string,
  cwdNorm: string,
  lexicalAbs: string,
  lexicalShape: 'posix' | 'win32' | undefined,
  signal?: AbortSignal,
): Promise<{ rawBytes: Uint8Array; resolvedPath: string }> {
  if (envFabric === undefined) {
    throw new HelmError(
      'env_fabric_missing',
      `node ${nodeId} is remote but EnvFabric is not configured`,
      503,
      { nodeId },
    )
  }
  if (!envFabric.isOnline(nodeId)) {
    throw new HelmError(
      'node_offline',
      `node ${nodeId} is offline, cannot read remote workspace file`,
      409,
      { nodeId },
    )
  }
  assertNotAborted(signal)
  const env = envFabric.envFor(nodeId, cwd)
  const ctx = signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT
  const cwdRealR = await env.canonicalPath(cwdNorm, ctx)
  if (!cwdRealR.ok) throw mapRemoteFileError(cwdRealR.error, cwdNorm)
  const cwdReal = cwdRealR.value
  const realShape = targetPathShape(cwdReal) ?? lexicalShape
  if (!isStrictlyInsideRoot(lexicalAbs, cwdNorm, lexicalShape) && !isStrictlyInsideRoot(lexicalAbs, cwdReal, realShape)) {
    throw new HelmError('path_outside_workspace', 'requested path is outside conversation workspace', 403)
  }
  const targetRealR = await env.canonicalPath(lexicalAbs, ctx)
  if (!targetRealR.ok) throw mapRemoteFileError(targetRealR.error, rawPath)
  const targetReal = targetRealR.value
  if (!isStrictlyInsideRoot(targetReal, cwdReal, realShape)) {
    throw new HelmError('path_outside_workspace', 'requested path is outside conversation workspace', 403)
  }
  const readerR = await env.openBinaryReader(targetReal, { noFollow: true }, ctx)
  if (!readerR.ok) throw mapRemoteFileError(readerR.error, rawPath)
  const reader = readerR.value
  try {
    const openedR = await reader.info(ctx)
    if (!openedR.ok) throw mapRemoteFileError(openedR.error, rawPath)
    const opened = openedR.value
    if (opened.kind !== 'file') {
      throw new HelmError('not_a_regular_file', `requested path is not a regular file: ${rawPath}`, 400)
    }
    if (opened.size > MAX_ARTIFACT_BYTES) {
      throw new HelmError(
        'file_too_large',
        `file size ${opened.size} exceeds ${MAX_ARTIFACT_BYTES} byte limit`,
        413,
        { maxBytes: MAX_ARTIFACT_BYTES, actualBytes: opened.size },
      )
    }
    const readR = await reader.read(0, MAX_ARTIFACT_BYTES + 1, ctx)
    if (!readR.ok) throw mapRemoteFileError(readR.error, rawPath)
    const readBytes = readR.value
    if (readBytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new HelmError(
        'file_too_large',
        `file size ${readBytes.byteLength} exceeds ${MAX_ARTIFACT_BYTES} byte limit`,
        413,
        { maxBytes: MAX_ARTIFACT_BYTES, actualBytes: readBytes.byteLength },
      )
    }
    const afterR = await reader.info(ctx)
    if (!afterR.ok) throw mapRemoteFileError(afterR.error, rawPath)
    const after = afterR.value
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || readBytes.byteLength !== opened.size) {
      throw new HelmError(
        'file_changed',
        `file changed while reading: ${rawPath} (size ${opened.size} -> ${after.size}, read ${readBytes.byteLength})`,
        409,
      )
    }
    return { rawBytes: readBytes, resolvedPath: targetReal }
  } finally {
    await reader.close(BACKGROUND_CONTEXT)
  }
}

/** Read a workspace file strictly within the conversation's bound (nodeId, cwd). */
export async function readWorkspaceFile(deps: ReadWorkspaceFileDeps): Promise<ConversationFileContent> {
  const { nodeId, cwd, rawPath, envFabric, redact, signal } = deps
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new HelmError('invalid_path', 'path must be a non-empty string', 400)
  }
  if (rawPath.length > 1024) {
    throw new HelmError('invalid_path', 'path length must be <= 1024 characters', 400)
  }
  if (rawPath.includes('\0')) {
    throw new HelmError('invalid_path', 'path must not contain NUL bytes', 400)
  }

  const platformInfo = targetPlatformForNode(envFabric, nodeId)
  const platform = platformInfo.known ? platformInfo.platform : undefined
  const resolved = resolveTargetPath(rawPath, cwd, platform)
  if (!resolved.ok) {
    throw new HelmError('invalid_path', resolved.reason, 400)
  }
  const cwdNormR = resolveTargetPath('.', cwd, platform)
  if (!cwdNormR.ok) {
    throw new HelmError('invalid_path', cwdNormR.reason, 400)
  }
  const lexicalAbs = resolved.abs
  const cwdNorm = cwdNormR.abs
  const lexicalShape = targetPathShape(cwdNorm) ?? targetPathShape(lexicalAbs)
  if (pathsEqualForShape(lexicalAbs, cwdNorm, lexicalShape)) {
    throw new HelmError('invalid_path', 'requested path must not resolve to conversation workspace root', 400)
  }

  const { rawBytes, resolvedPath } =
    nodeId === 'local'
      ? await readLocalWorkspaceFile(rawPath, cwdNorm, lexicalAbs, lexicalShape, signal)
      : await readRemoteWorkspaceFile(envFabric, nodeId, cwd, rawPath, cwdNorm, lexicalAbs, lexicalShape, signal)

  const name = basenameForShape(resolvedPath)
  const detected = detectWorkspaceFileMime(name, rawBytes)
  if (detected.isText) {
    const decoded = Buffer.from(rawBytes).toString('utf8')
    const safeText = redact !== undefined ? redact(decoded) : decoded
    return {
      bytes: new TextEncoder().encode(safeText),
      mimeType: `${detected.mimeType}; charset=utf-8`,
      name,
      resolvedPath,
    }
  }
  return {
    bytes: rawBytes,
    mimeType: detected.mimeType,
    name,
    resolvedPath,
  }
}
