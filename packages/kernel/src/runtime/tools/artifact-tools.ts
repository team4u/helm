/**
 * conversation artifact tool (register_artifact / read_artifact).
 *
 * register_artifact: conversation target node on real ordinary file duplicate register is when before conversation artifact
 *(via artifacts.writeUploaded  Hub data directory,Web can preview/download), support two enter system,
 * cap 15 MiB. honest contract: remote must via EnvFabric  canonicalPath / fileInfo
 * preflight + openBinaryReader same fd has boundary read; node offline or EnvFabric missing explicit failed
 *(guards.ts), never fall back local mistakenly read Hub local machine disk, also do not fallback
 * readBinaryFile without boundary all amount buffer; only accept ordinary file (stat preflight + O_NONBLOCK
 *(platform support when) seal stat→open race + the same fd fstat right threat re-check);local has boundary
 * loop read to EOF(readArtifactBytesFromHandle). size over limit/in route change text proposal in this
 * constant (preflight/open after/read after shared use, never drift).
 *
 * read_artifact: page read spill artifact (≤4KiB,UTF-8 boundary align guarantee before enter); only
 * allows when before conversation (contains parent conversation authorization chain) artifact, do not accept any path. honest: only
 *artifact missing (FileNotFoundError) archive is artifact_not_found; store real read
 * failed such as through out original error (artifact_read_failed, via redaction), never swallow into not_found.
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

/** register_artifact shared use classify/over limit text proposal (preflight / open after re-check / read after shared use). */
const registerIsDirectoryText = (path: string): string =>
  `register_failed: ${path} is directory,register_artifact only support ordinary file`
const artifactTooLargeText = (path: string, size: number): string =>
  `artifact_too_large: ${path} is ${size} byte, exceeds single artifact ${MAX_ARTIFACT_BYTES} byte (15 MiB) cap`
const artifactTooLargeReadText = (path: string, size: number): string =>
  `artifact_too_large: ${path} read to ${size} byte, exceeds single artifact ${MAX_ARTIFACT_BYTES} byte (15 MiB) cap`

/** register_artifact local read result: succeeded carry complete byte; failed is machine can read code. */
export type ArtifactFileBytes =
  | { ok: true; bytes: Buffer; size: number }
  | { ok: false; code: 'artifact_too_large'; read: number }
  | { ok: false; code: 'file_changed'; detail: string }

/** helper read which must most small handle side (real FileHandle structure satisfy, convenient at test inject short read/change). */
export interface ArtifactReadHandle {
  stat(): Promise<{ size: number; mtimeMs: number; ctimeMs: number }>
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ bytesRead: number; buffer: Buffer }>
}

/** single time read chunk large small (has boundary loop read, avoid once occupy 15 MiB buffer). */
const ARTIFACT_READ_CHUNK_BYTES = 256 * 1024

/** local open flag:O_RDONLY + platform support when O_NONBLOCK (+ optional O_NOFOLLOW).stat preflight and open between store in
 *  race window (ordinary file by swap into FIFO/device file will make pure O_RDONLY  open unbounded block),
 *  O_NONBLOCK let open immediately return, by the same fd on fstat right threat reject;Windows
 *  libuv unsupported O_NONBLOCK, only use O_RDONLY(Windows without FIFO, risk side different). */
export function artifactOpenFlags(opts?: { noFollow?: boolean }): number {
  if (process.platform === 'win32') return fsConstants.O_RDONLY
  return (
    fsConstants.O_RDONLY |
    (fsConstants as { O_NONBLOCK?: number }).O_NONBLOCK! |
    (opts?.noFollow ? ((fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0) : 0)
  )
}

/**
 * the same FileHandle on has boundary read to EOF(register_artifact local path unique implement):
 * one by one chunk loop to EOF(short read only push enter cursor, never when complete file); total pre- compute MAX+1(read to
 * cap+1 i.e. verify over limit); read after same fd stat compare size/mtime/ctime, in route change explicit
 * file_changed, never old prefix register succeeded.
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
      detail: `read during file occur change (size ${before.size} -> ${after.size},mtime ${before.mtimeMs} -> ${after.mtimeMs},ctime ${before.ctimeMs} -> ${after.ctimeMs}), reject register may do not complete snapshot`,
    }
  }
  return { ok: true, bytes: Buffer.concat(chunks, total), size: after.size }
}

const registerArtifactParameters = obj({
  path: str({ description: 'want register is conversation artifact source file path (each other for conversation cwd or absolute path, support ../ across directory, and bash same right)' }),
  name: opt(str({ description: 'artifact render name (default use source file name)' })),
  mimeType: opt(str({ description: 'MIME type (default by extension probe; text class will redaction after, two enter system byte original keep)' })),
})

/**
 * register_artifact tool: conversation target node on real ordinary file duplicate register is when before
 * conversation artifact (via artifacts.writeUploaded  Hub data directory,Web can preview/download).
 * structure result back visible artifactId, source file absolute path (local is term method absolute path, remote
 * is canonical parse after),nodeId,name,size/mime; two enter system fidelity and text redaction
 * by ArtifactService unify handle; everything exception text via deps.redact redaction.
 */
export function createRegisterArtifactTool(
  deps: HelmToolDeps,
): ToolRegistration<typeof registerArtifactParameters, never> {
  return defineTool({
    name: 'register_artifact',
    description:
      'conversation target node on real ordinary file register is when before conversation artifact (duplicate enter Hub data directory,Web UI visible/can preview/can download). support two enter system (byte original fidelity) and text (redaction after); single file cap 15 MiB; conversation bind set remote node when in target node read, never fall back local machine. generate new text content when takes precedence use write(..., artifact: true); this tool used to already has file (such as command output, build artifact, diagram piece) hand over to user.',
    parameters: registerArtifactParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        artifactId: { type: 'string', description: 'artifact ID(available [filename](artifact:<id>) render)' },
        path: { type: 'string', description: 'source file absolute path (remote is canonical parse after)' },
        nodeId: { type: 'string', description: 'actual read node' },
        name: { type: 'string', description: 'artifact render name' },
        size: { type: 'number', description: 'register byte count (text class is redaction after large small)' },
        mimeType: { type: 'string', description: 'artifact MIME type' },
      },
      required: ['artifactId', 'path', 'nodeId', 'name', 'size', 'mimeType'],
    },
    async execute(args, api, context) {
      if (deps.artifacts.writeUploaded === undefined) {
        return {
          output: [
            { type: 'text', text: 'register_failed: artifact service not config writeUploaded, cannot register conversation artifact' },
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
          // remote: must via EnvFabric(missing/offline explicit failed, never fall back local).
          const remote = requireRemoteEnv(deps.envFabric, nodeId, base, 'read')
          if ('error' in remote) {
            return { output: [{ type: 'text', text: remote.error }], isError: true }
          }
          const env = remote.env
          // canonicalPath first parse symlink (and read consistent):fileInfo is lstat semantics.
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
          // has boundary two enter system read:openBinaryReader open after same fd positional read
          //(node implement O_NONBLOCK open + same fd fstat refuse special file), never away
          // readBinaryFile without boundary all amount buffer (source file increase long count GB will first whole buffer transfer
          // after only then reject). failed to open explicit reject, without any fall back.
          const readerR = await env.openBinaryReader(sourcePath, { noFollow: true }, context)
          if (!readerR.ok) throw new Error(readerR.error.message)
          const reader = readerR.value
          try {
            // open after right threat information (same fd, non- path view):kind/size/mtime with reader
            //  info is allow, preflight size only act fast reject.
            const openedR = await reader.info(context)
            if (!openedR.ok) throw new Error(openedR.error.message)
            const opened = openedR.value
            if (opened.kind !== 'file') {
              return {
                output: [
                  {
                    type: 'text',
                    text: `register_failed: ${args.path} in open after is not ordinary file (kind=${opened.kind}), reject read`,
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
            // request cap+1:SDK contract at most length byte, only EOF where more short, internal
            // loop short read until length or EOF- - over limit i.e. verify, absolute without first all amount after reject.
            const readR = await reader.read(0, MAX_ARTIFACT_BYTES + 1, context)
            if (!readR.ok) throw new Error(readR.error.message)
            const readBytes = readR.value
            if (readBytes.byteLength > MAX_ARTIFACT_BYTES) {
              return {
                output: [{ type: 'text', text: artifactTooLargeReadText(args.path, readBytes.byteLength) }],
                isError: true,
              }
            }
            // read after second info(same fd):size/mtime and open when inconsistent or read long short and
            // stable size inconsistent all reject (read route in increase long/truncate must not truncate when succeeded).
            const afterR = await reader.info(context)
            if (!afterR.ok) throw new Error(afterR.error.message)
            const after = afterR.value
            if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
              return {
                output: [
                  {
                    type: 'text',
                    text:
                      `file_changed: ${args.path} read during file occur change` +
                      `(size ${opened.size} -> ${after.size},mtime ${opened.mtimeMs} -> ${after.mtimeMs}), reject register may do not complete snapshot`,
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
                    text: `file_changed: ${args.path} read to ${readBytes.byteLength} byte and stable large small ${opened.size} inconsistent, reject truncate when succeeded`,
                  },
                ],
                isError: true,
              }
            }
            bytes = readBytes
          } finally {
            // cancel/failed path same release remote handle (node side reader lifecycle and connect
            // bind set, explicit close immediately reclaim).
            await reader.close(BACKGROUND_CONTEXT)
          }
        } else {
          // local: and read tool same construct - - first stat(with follow symlink) preflight classify (directory/special
          // file/over limit;FIFO etc. special file in without race scenario under preflight i.e. reject); open use
          // O_NONBLOCK(platform support when) seal stat→open race window (ordinary file by swap into
          // FIFO after pure O_RDONLY  open will unbounded block); the same fd on fstat right threat re-check
          // after has boundary loop read to EOF(short read continue, over limit verify, in route change explicit file_changed,
          // see readArtifactBytesFromHandle).
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
                  { type: 'text', text: `register_failed: ${args.path} in open after is not ordinary file (special file), reject read` },
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
                `register_artifact_ok: source ${sourcePath}(node ${nodeId},${meta.size} byte,${meta.mimeType})`,
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
  id: str({ description: 'artifact ID(artifact metadata  id)' }),
  offset: opt(int({ minimum: 0, description: 'start byte offset (by default 0)' })),
  limit: opt(
    int({
      minimum: 1,
      maximum: ARTIFACT_PAGE_BYTES,
      description: `this time read byte count cap (by default ${ARTIFACT_PAGE_BYTES}, most large ${ARTIFACT_PAGE_BYTES})`,
    }),
  ),
})

/**
 * read_artifact tool: page read spill artifact. only allows when before conversation and its parent chain authorization conversation artifact,
 * do not accept any file path; each page ≤4KiB,UTF-8 boundary align and guarantee nextOffset strictly before enter.
 */
export function createReadArtifactTool(
  deps: HelmToolDeps,
  isAuthorized: (conversationId: number, artifactConversationId: number) => boolean,
): ToolRegistration<typeof readArtifactParameters, never> {
  return defineTool({
    name: 'read_artifact',
    // pure only read page tool: interrupt heavy open allows security replay.
    replay: 'safe',
    description:
      'page read artifact (spill all text etc.). each page at most 4KiB, by UTF-8 boundary align return nextOffset; is empty means already read completely.',
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
      // honest: only artifact missing (FileNotFoundError) is artifact_not_found;
      // store real failed to read (repository/DB fault etc.) such as through out original error text (via redaction,
      // and under way readBuffer same code artifact_read_failed), never swallow into not_found.
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
              text: `artifact_forbidden: artifact ${id} belongs to conversation ${meta.conversationId}, when before conversation ${conversationId} without right read`,
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
            { type: 'text', text: `[artifact ${id} bytes ${offset}-${offset}/${buffer.length}]\n(already read completely)` },
          ],
          structuredOutput: { id, offset, chunk: '' } as JsonValue,
        }
      }
      // UTF-8 boundary align:offset or end in multibyte sequence middle when, start point jump to under a
      // complete character first token node, final point fall back to character start point (keep before enter and never solve out replace symbol).
      let start = offset
      while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1
      const end = Math.min(buffer.length, offset + limit)
      let safeEnd = Math.max(end, start)
      while (safeEnd < buffer.length && (buffer[safeEnd]! & 0xc0) === 0x80) safeEnd -= 1
      // fall back:limit=1 and start is multibyte first token node when safeEnd may retreat back start; push enter to
      // under a character first token node, guarantee one page at least complete read out a character.
      while (safeEnd <= start && safeEnd < buffer.length) {
        safeEnd += 1
        while (safeEnd < buffer.length && (buffer[safeEnd]! & 0xc0) === 0x80) safeEnd += 1
      }
      const chunk = buffer.subarray(start, safeEnd).toString('utf8')
      const hasMore = safeEnd < buffer.length
      const header = `[artifact ${id} bytes ${offset}-${safeEnd}/${buffer.length}${start > offset ? `(offset ${offset} at multibyte character middle, already from ${start} start read)` : ''}]`
      const text = hasMore ? `${header}\n${chunk}\n[nextOffset=${safeEnd}]` : `${header}\n${chunk}`
      // nextOffset only in also has remaining when appear, never output undefined field (JSON-safe).
      const structured: Record<string, unknown> = { id, offset, chunk }
      if (hasMore) structured['nextOffset'] = safeEnd
      return {
        output: [{ type: 'text', text }],
        structuredOutput: structured as JsonValue,
      }
    },
  })
}
