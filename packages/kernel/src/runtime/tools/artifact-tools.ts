/**
 * Conversation artifact tools (`register_artifact` / `read_artifact`).
 *
 * `register_artifact`: copies real regular files from the conversation's target node into the current
 * conversation's artifacts (written via `artifacts.writeUploaded` under Hub `dataDir` for Web preview/download),
 * preserving binary bytes up to a 15 MiB cap. Honesty contract: remote paths run via `EnvFabric`
 * `canonicalPath` / `fileInfo` preflight + `openBinaryReader` bounded same-fd reads; offline nodes or missing
 * `EnvFabric` fail explicitly (`guards.ts`), never falling back to Hub disk or unbounded `readBinaryFile`
 * buffering; regular files only (`stat` preflight + `O_NONBLOCK` when supported to close `stat -> open` races +
 * authoritative `fstat` on the same fd); local uses bounded loops to EOF (`readArtifactBytesFromHandle`).
 * Size/mutation messages are defined once and shared across preflight, post-open, and post-read without drift.
 *
 * `read_artifact`: paginated reads of spilled artifacts (`<= 4 KiB`, guaranteed forward progress on UTF-8 boundaries);
 * restricted to artifacts authorized for the current conversation (including parent authorization chains) — never
 * accepts arbitrary file paths. Honesty: only missing artifacts (`FileNotFoundError`) map to `artifact_not_found`;
 * storage failures surface the redacted underlying error (`artifact_read_failed`) rather than masquerading as missing.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { int, obj, opt, str } from '@earendil-works/pi-schema'
import { constants as fsConstants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { MAX_ARTIFACT_BYTES } from '../../services/artifacts.js'
import { FileNotFoundError } from '../../services/index.js'
import { resolveTargetPath } from './target-path.js'
import { resolveToolTarget } from './tool-target.js'
import { requireRemoteEnv } from './guards.js'
import { basenameForShape } from './file-env.js'
import type { HelmToolDeps } from '../tool-deps.js'

/** Shared classification/limit messages for `register_artifact` (shared across preflight, post-open, and post-read).
 * Note: `'is directory'`, `'15 MiB'`, and `'not ordinary file'` wording are preserved for test compatibility. */
const registerIsDirectoryText = (path: string): string =>
  `register_failed: ${path} is directory; register_artifact only supports regular files`
const artifactTooLargeText = (path: string, size: number): string =>
  `artifact_too_large: ${path} is ${size} bytes, exceeding the ${MAX_ARTIFACT_BYTES}-byte (15 MiB) per-artifact cap`
const artifactTooLargeReadText = (path: string, size: number): string =>
  `artifact_too_large: ${path} read ${size} bytes, exceeding the ${MAX_ARTIFACT_BYTES}-byte (15 MiB) per-artifact cap`

/** Local `register_artifact` read outcome: complete bytes on success, or machine-readable failure code. */
export type ArtifactFileBytes =
  | { ok: true; bytes: Buffer; size: number }
  | { ok: false; code: 'artifact_too_large'; read: number }
  | { ok: false; code: 'file_changed'; detail: string }

/** Minimal file-handle interface needed for helper reads (structurally satisfied by real FileHandle; allows short-read/mutation fakes in tests). */
export interface ArtifactReadHandle {
  stat(): Promise<{ size: number; mtimeMs: number; ctimeMs: number }>
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ bytesRead: number; buffer: Buffer }>
}

/** Per-iteration chunk size (bounded streaming loop avoids eagerly allocating 15 MiB buffers). */
const ARTIFACT_READ_CHUNK_BYTES = 256 * 1024

/** Local open flags: `O_RDONLY` plus `O_NONBLOCK` (and optional `O_NOFOLLOW`) where supported. Prevents `stat -> open` swap races
 * (replacing a regular file with a FIFO/device node before open would otherwise block `O_RDONLY` indefinitely)
 * so `fstat` on the same fd can reject safely; Windows libuv omits `O_NONBLOCK` and has no FIFOs. */
export function artifactOpenFlags(opts?: { noFollow?: boolean }): number {
  if (process.platform === 'win32') return fsConstants.O_RDONLY
  return (
    fsConstants.O_RDONLY |
    (fsConstants as { O_NONBLOCK?: number }).O_NONBLOCK! |
    (opts?.noFollow ? ((fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0) : 0)
  )
}

/**
 * Bounded read to EOF on a single `FileHandle` (sole local implementation for `register_artifact`):
 * loops across chunks until EOF (short reads advance the offset rather than assuming EOF); caps total budget
 * at `MAX+1` (triggering explicit overflow at `cap+1`); verifies `size`/`mtime`/`ctime` via post-read `stat` on the
 * same fd and rejects mid-read mutations explicitly with `file_changed` rather than registering stale prefixes.
 */
export async function readArtifactBytesFromHandle(handle: ArtifactReadHandle): Promise<ArtifactFileBytes> {
  const before = await handle.stat()
  const budget = MAX_ARTIFACT_BYTES + 1
  const chunks: Buffer[] = []
  let total = 0
  let position = 0
  for (;;) {
    const want = Math.min(ARTIFACT_READ_CHUNK_BYTES, budget - total)
    if (want <= 0) return { ok: false, code: 'artifact_too_large', read: total }
    const chunk = Buffer.alloc(want)
    const { bytesRead } = await handle.read(chunk, 0, want, position)
    if (bytesRead === 0) break
    chunks.push(chunk.subarray(0, bytesRead))
    total += bytesRead
    position += bytesRead
    if (total > MAX_ARTIFACT_BYTES) return { ok: false, code: 'artifact_too_large', read: total }
  }
  const after = await handle.stat()
  if (
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  ) {
    return {
      ok: false,
      code: 'file_changed',
      detail: `file changed during read (size ${before.size} -> ${after.size}, mtime ${before.mtimeMs} -> ${after.mtimeMs}, ctime ${before.ctimeMs} -> ${after.ctimeMs}); refusing incomplete snapshot`,
    }
  }
  return { ok: true, bytes: Buffer.concat(chunks, total), size: after.size }
}

const registerArtifactParameters = obj({
  path: str({ description: 'Source file path to register as a conversation artifact (relative to conversation cwd or absolute; supports ../ traversal, same boundary as bash)' }),
  name: opt(str({ description: 'Display name for the artifact (defaults to source filename)' })),
  mimeType: opt(str({ description: 'MIME type (inferred from extension by default; text is redacted while binary bytes remain verbatim)' })),
})

/**
 * `register_artifact` tool: copies an existing regular file on the conversation's target node into the current
 * conversation's artifacts (written via `artifacts.writeUploaded` for Web preview/download).
 * Returns structured `artifactId`, resolved absolute path (lexical locally, canonical remotely), `nodeId`, `name`,
 * `size`/`mime`; binary fidelity and text redaction are unified in `ArtifactService`; all errors pass through `deps.redact`.
 */
export function createRegisterArtifactTool(
  deps: HelmToolDeps,
): ToolRegistration<typeof registerArtifactParameters, never> {
  return defineTool({
    name: 'register_artifact',
    description:
      'Register an existing regular file on the conversation\'s target node as a conversation artifact (copied into Hub dataDir for Web preview/download). ' +
      'Supports binary (verbatim bytes) and text (redacted) up to 15 MiB; reads from the target node when bound remotely without falling back locally. ' +
      'Prefer write(..., artifact: true) when generating new text; use this tool to hand existing files (command outputs, build artifacts, images) to the user.',
    parameters: registerArtifactParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        artifactId: { type: 'string', description: 'Artifact ID (renderable via [filename](artifact:<id>))' },
        path: { type: 'string', description: 'Source file absolute path (canonicalized remotely)' },
        nodeId: { type: 'string', description: 'Node where file was read' },
        name: { type: 'string', description: 'Artifact display name' },
        size: { type: 'number', description: 'Registered byte length (post-redaction size for text)' },
        mimeType: { type: 'string', description: 'Artifact MIME type' },
      },
      required: ['artifactId', 'path', 'nodeId', 'name', 'size', 'mimeType'],
    },
    async execute(args, api, context) {
      if (deps.artifacts.writeUploaded === undefined) {
        return {
          output: [
            { type: 'text', text: 'register_failed: artifact service does not support writeUploaded; cannot register conversation artifact' },
          ],
          isError: true,
        }
      }
      const target0 = await resolveToolTarget(deps, api, context)
      if ('error' in target0) {
        return { output: [{ type: 'text', text: `register_failed: ${target0.error}` }], isError: true }
      }
      const { nodeId, base, platform } = target0
      try {
        const resolvedR = resolveTargetPath(args.path, base, platform)
        if (!resolvedR.ok) {
          return { output: [{ type: 'text', text: `invalid_path: ${resolvedR.reason}` }], isError: true }
        }
        const lexicalAbs = resolvedR.abs
        const displayName = args.name ?? basenameForShape(lexicalAbs)
        let bytes: Uint8Array
        let sourcePath: string
        if (nodeId !== 'local') {
          // Remote: requires EnvFabric (explicit failure on missing/offline; never falls back locally).
          const remote = requireRemoteEnv(deps.envFabric, nodeId, base, 'read')
          if ('error' in remote) {
            return { output: [{ type: 'text', text: remote.error }], isError: true }
          }
          const env = remote.env
          // Resolve symlinks via `canonicalPath` first (consistent with `read`): `fileInfo` uses `lstat` semantics.
          const targetRealR = await env.canonicalPath(lexicalAbs, context)
          if (!targetRealR.ok) throw new Error(targetRealR.error.message)
          sourcePath = targetRealR.value
          const infoR = await env.fileInfo(sourcePath, context)
          if (!infoR.ok) throw new Error(infoR.error.message)
          const info = infoR.value
          if (info.kind === 'directory') {
            return {
              output: [{ type: 'text', text: registerIsDirectoryText(args.path) }],
              isError: true,
            }
          }
          if (info.kind !== 'file') {
            return {
              output: [
                { type: 'text', text: `register_failed: ${args.path} is not ordinary file (kind=${info.kind})` },
              ],
              isError: true,
            }
          }
          if (info.size > MAX_ARTIFACT_BYTES) {
            return {
              output: [{ type: 'text', text: artifactTooLargeText(args.path, info.size) }],
              isError: true,
            }
          }
          // Bounded binary read: `openBinaryReader` performs positional reads on one fd (daemon uses
          // `O_NONBLOCK` + `fstat` to reject special files), avoiding unbounded `readBinaryFile` full-file buffering
          // that would buffer gigabytes before rejecting. Open failures fail loudly with no fallback.
          const readerR = await env.openBinaryReader(sourcePath, { noFollow: true }, context)
          if (!readerR.ok) throw new Error(readerR.error.message)
          const reader = readerR.value
          try {
            // Authoritative post-open metadata on the same fd (not path view); preflight size was only fast-reject.
            const openedR = await reader.info(context)
            if (!openedR.ok) throw new Error(openedR.error.message)
            const opened = openedR.value
            if (opened.kind !== 'file') {
              return {
                output: [
                  {
                    type: 'text',
                    text: `register_failed: ${args.path} is not ordinary file after open (kind=${opened.kind}); read rejected`,
                  },
                ],
                isError: true,
              }
            }
            if (opened.size > MAX_ARTIFACT_BYTES) {
              return {
                output: [{ type: 'text', text: artifactTooLargeText(args.path, opened.size) }],
                isError: true,
              }
            }
            // Request cap+1: SDK reads up to `length` bytes (stopping only on EOF) — enforces cap cleanly without reading entire multi-GB files.
            const readR = await reader.read(0, MAX_ARTIFACT_BYTES + 1, context)
            if (!readR.ok) throw new Error(readR.error.message)
            const readBytes = readR.value
            if (readBytes.byteLength > MAX_ARTIFACT_BYTES) {
              return {
                output: [{ type: 'text', text: artifactTooLargeReadText(args.path, readBytes.byteLength) }],
                isError: true,
              }
            }
            // Post-read check on same fd: reject if size/mtime shifted or byte count differs from opened size (never register truncated files as complete).
            const afterR = await reader.info(context)
            if (!afterR.ok) throw new Error(afterR.error.message)
            const after = afterR.value
            if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
              return {
                output: [
                  {
                    type: 'text',
                    text:
                      `file_changed: ${args.path} changed during read ` +
                      `(size ${opened.size} -> ${after.size}, mtime ${opened.mtimeMs} -> ${after.mtimeMs}); refusing incomplete snapshot`,
                  },
                ],
                isError: true,
              }
            }
            if (readBytes.byteLength !== opened.size) {
              return {
                output: [
                  {
                    type: 'text',
                    text: `file_changed: ${args.path} read ${readBytes.byteLength} bytes, mismatching stable size ${opened.size}; refusing truncated snapshot`,
                  },
                ],
                isError: true,
              }
            }
            bytes = readBytes
          } finally {
            // Release remote handle on cancel/error too (node readers tie to connection lifecycle; explicit close frees immediately).
            await reader.close(BACKGROUND_CONTEXT)
          }
        } else {
          // Local matches `read` semantics: `stat` (follows symlinks) classifies dirs/special files/caps cleanly;
          // `open` uses `O_NONBLOCK` (when supported) to prevent `stat -> open` FIFO swaps from blocking;
          // `fstat` re-verifies on the same fd, then reads boundedly to EOF and checks mid-read changes (`file_changed`).
          const preInfo = await stat(lexicalAbs)
          if (preInfo.isDirectory()) {
            return {
              output: [{ type: 'text', text: registerIsDirectoryText(args.path) }],
              isError: true,
            }
          }
          if (!preInfo.isFile()) {
            return {
              output: [
                { type: 'text', text: `register_failed: ${args.path} is not ordinary file (special file)` },
              ],
              isError: true,
            }
          }
          if (preInfo.size > MAX_ARTIFACT_BYTES) {
            return {
              output: [{ type: 'text', text: artifactTooLargeText(args.path, preInfo.size) }],
              isError: true,
            }
          }
          const handle = await open(lexicalAbs, artifactOpenFlags())
          try {
            const statInfo = await handle.stat()
            if (statInfo.isDirectory()) {
              return {
                output: [{ type: 'text', text: registerIsDirectoryText(args.path) }],
                isError: true,
              }
            }
            if (!statInfo.isFile()) {
              return {
                output: [
                  { type: 'text', text: `register_failed: ${args.path} is not ordinary file after open (special file); read rejected` },
                ],
                isError: true,
              }
            }
            if (statInfo.size > MAX_ARTIFACT_BYTES) {
              return {
                output: [{ type: 'text', text: artifactTooLargeText(args.path, statInfo.size) }],
                isError: true,
              }
            }
            const read = await readArtifactBytesFromHandle(handle)
            if (!read.ok) {
              if (read.code === 'artifact_too_large') {
                return {
                  output: [{ type: 'text', text: artifactTooLargeReadText(args.path, read.read) }],
                  isError: true,
                }
              }
              return {
                output: [
                  { type: 'text', text: `file_changed: ${args.path} ${read.detail}` },
                ],
                isError: true,
              }
            }
            bytes = read.bytes
          } finally {
            await handle.close()
          }
          sourcePath = lexicalAbs
        }
        const meta = await deps.artifacts.writeUploaded(api.conversationId as number, {
          name: displayName,
          bytes,
          ...(args.mimeType !== undefined ? { mimeType: args.mimeType } : {}),
        })
        return {
          output: [
            {
              type: 'text',
              text:
                `[Artifact] id=${meta.id} name=${meta.name}\n` +
                `register_artifact_ok: source ${sourcePath} (node ${nodeId}, ${meta.size} bytes, ${meta.mimeType})`,
            },
          ],
          structuredOutput: {
            artifactId: meta.id,
            path: sourcePath,
            nodeId,
            name: meta.name,
            size: meta.size,
            mimeType: meta.mimeType,
          } as JsonValue,
        }
      } catch (error) {
        return {
          output: [{ type: 'text', text: `register_failed: ${deps.redact(String(error))}` }],
          isError: true,
        }
      }
    },
  })
}

const ARTIFACT_PAGE_BYTES = 4 * 1024

const readArtifactParameters = obj({
  id: str({ description: 'Artifact ID (id from artifact metadata)' }),
  offset: opt(int({ minimum: 0, description: 'Starting byte offset (default 0)' })),
  limit: opt(
    int({
      minimum: 1,
      maximum: ARTIFACT_PAGE_BYTES,
      description: `Maximum bytes to read this page (default ${ARTIFACT_PAGE_BYTES}, max ${ARTIFACT_PAGE_BYTES})`,
    }),
  ),
})

/**
 * `read_artifact` tool: paginated reads of spilled artifacts. Restricts access to artifacts owned by the
 * current conversation or its parent chain (never accepts arbitrary paths); <= 4 KiB per page, aligned on
 * UTF-8 boundaries with guaranteed forward progress on `nextOffset`.
 */
export function createReadArtifactTool(
  deps: HelmToolDeps,
  isAuthorized: (conversationId: number, artifactConversationId: number) => boolean,
): ToolRegistration<typeof readArtifactParameters, never> {
  return defineTool({
    name: 'read_artifact',
    // Pure read-only pagination: safe to replay after interruption.
    replay: 'safe',
    description:
      'Read an artifact (such as spilled long text) page by page. Returns up to 4 KiB per page aligned on UTF-8 boundaries with nextOffset; empty output indicates EOF.',
    parameters: readArtifactParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        offset: { type: 'number' },
        nextOffset: { type: 'number' },
        chunk: { type: 'string' },
      },
      required: ['id', 'offset', 'chunk'],
    },
    async execute(args, api, _context) {
      const id = args.id
      const offset = args.offset ?? 0
      const limit = args.limit ?? ARTIFACT_PAGE_BYTES
      const conversationId = api.conversationId as number
      // Honesty: only missing artifacts (`FileNotFoundError`) map to `artifact_not_found`;
      // genuine storage/DB read failures surface the redacted underlying error (`artifact_read_failed`, matching `readBuffer` below).
      let meta: Awaited<ReturnType<HelmToolDeps['artifacts']['get']>>
      try {
        meta = await deps.artifacts.get(id)
      } catch (error) {
        if (error instanceof FileNotFoundError) {
          return {
            output: [{ type: 'text', text: `artifact_not_found: ${id}` }],
            isError: true,
          }
        }
        return {
          output: [{ type: 'text', text: `artifact_read_failed: ${deps.redact(String(error))}` }],
          isError: true,
        }
      }
      if (!isAuthorized(conversationId, meta.conversationId)) {
        return {
          output: [
            {
              type: 'text',
              text: `artifact_forbidden: artifact ${id} belongs to conversation ${meta.conversationId}; conversation ${conversationId} is not authorized to read it`,
            },
          ],
          isError: true,
        }
      }
      let buffer: Buffer
      try {
        buffer = Buffer.from(await deps.artifacts.readBuffer(id))
      } catch (error) {
        return {
          output: [{ type: 'text', text: `artifact_read_failed: ${deps.redact(String(error))}` }],
          isError: true,
        }
      }
      if (offset > buffer.length) {
        return {
          output: [{ type: 'text', text: `offset_out_of_range: ${offset} > ${buffer.length}` }],
          isError: true,
        }
      }
      if (offset === buffer.length) {
        return {
          output: [
            { type: 'text', text: `[artifact ${id} bytes ${offset}-${offset}/${buffer.length}]\n(EOF reached)` },
          ],
          structuredOutput: { id, offset, chunk: '' } as JsonValue,
        }
      }
      // UTF-8 boundary alignment: if `offset` or `end` lands inside a multi-byte sequence, advance `start` to the
      // next valid leading byte and step `safeEnd` back to a leading byte (ensures forward progress without U+FFFD replacement).
      let start = offset
      while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1
      const end = Math.min(buffer.length, offset + limit)
      let safeEnd = Math.max(end, start)
      while (safeEnd < buffer.length && (buffer[safeEnd]! & 0xc0) === 0x80) safeEnd -= 1
      // Fallback: when `limit=1` and `start` is a multi-byte lead byte, `safeEnd` could align back to `start`;
      // advance past that character so each page reads at least one full character.
      while (safeEnd <= start && safeEnd < buffer.length) {
        safeEnd += 1
        while (safeEnd < buffer.length && (buffer[safeEnd]! & 0xc0) === 0x80) safeEnd += 1
      }
      const chunk = buffer.subarray(start, safeEnd).toString('utf8')
      const hasMore = safeEnd < buffer.length
      const header = `[artifact ${id} bytes ${offset}-${safeEnd}/${buffer.length}${start > offset ? ` (offset ${offset} landed mid-character; started at ${start})` : ''}]`
      const text = hasMore ? `${header}\n${chunk}\n[nextOffset=${safeEnd}]` : `${header}\n${chunk}`
      // Emit `nextOffset` only when more bytes remain so no undefined fields leak (JSON-safe).
      const structured: Record<string, unknown> = { id, offset, chunk }
      if (hasMore) structured['nextOffset'] = safeEnd
      return {
        output: [{ type: 'text', text }],
        structuredOutput: structured as JsonValue,
      }
    },
  })
}
