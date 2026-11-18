/**
 * ArtifactService: manages conversation artifacts and oversized tool-output spills.
 * - Registering a source file copies it into `artifacts/<convId>/` and records metadata:
 *   text MIME types are decoded, redacted via `SecretStash.redact`, and atomically written (preserving the
 *   non-leakage guarantee across registered files); binary files are copied byte-for-byte with no re-encoding;
 * - Spill persists the full text when UTF-8 byte length exceeds 32 KiB and returns a 4 KiB head preview;
 * - All written text and model previews pass through SecretStash redaction while keeping existing placeholders intact.
 */
import { mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { HelmError, type ArtifactKind, type ArtifactMetadata } from '@helm/protocol'
import {
  FileNotFoundError,
  atomicWriteFile,
  copyFilePrivate,
  readTextFile,
} from './atomic-file.js'
import { BINARY_MIME, detectMimeByExtension, isTextMime } from './file-mime.js'

/** Metadata repository contract: implemented by the durable layer (`state.sqlite` artifacts table). */
interface ArtifactRepository {
  get(id: string): ArtifactMetadata | undefined
  list(conversationId: number): ArtifactMetadata[]
  put(metadata: ArtifactMetadata): void
  deleteByConversation(conversationId: number): void
}

/** In-memory/test implementation; production uses the `pi-durable` artifacts table. */
export class InMemoryArtifactRepository implements ArtifactRepository {
  private readonly items = new Map<string, ArtifactMetadata>()

  get(id: string): ArtifactMetadata | undefined {
    return this.items.get(id)
  }

  list(conversationId: number): ArtifactMetadata[] {
    return [...this.items.values()]
      .filter((a) => a.conversationId === conversationId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  put(metadata: ArtifactMetadata): void {
    this.items.set(metadata.id, metadata)
  }

  deleteByConversation(conversationId: number): void {
    for (const [id, item] of this.items) {
      if (item.conversationId === conversationId) this.items.delete(id)
    }
  }
}

/** Spill threshold: only spills when exceeding 32 KiB (UTF-8 bytes). */
const SPILL_THRESHOLD_BYTES = 32 * 1024
/** Head preview length: 4 KiB (UTF-8 safe truncation). */
const PREVIEW_HEAD_BYTES = 4 * 1024
/** Uploaded artifact size cap: 15 MiB. */
export const MAX_ARTIFACT_BYTES = 15 * 1024 * 1024
/**
 * Valid protocol-layer `callId` format: starts with ASCII alphanumeric, followed by `A-Za-z0-9._:|+-`,
 * forbidding `..` and path separators. Covers Anthropic (`toolu_*`), OpenAI Completions (`call_*`),
 * and OpenAI Responses (`call_*|fc_*`).
 */
const CALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:|+-]{0,255}$/
const DIRECT_FILENAME_CALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/

function toSpillFileName(callId: string): string {
  if (DIRECT_FILENAME_CALL_ID_PATTERN.test(callId)) {
    return `tool-spill-${callId}.txt`
  }
  const slug = callId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)
  const digest = createHash('sha256').update(callId).digest('hex').slice(0, 12)
  return `tool-spill-${slug}-${digest}.txt`
}

/** Maximum length for uploaded filenames. */
const MAX_UPLOAD_NAME_LENGTH = 200

/** Sanitize uploaded filename: reject traversal, control characters, and oversized names (400 at boundary, never silently renamed). */
export function sanitizeUploadFilename(raw: string): string {
  const name = raw.trim()
  if (
    name === '' ||
    name.length > MAX_UPLOAD_NAME_LENGTH ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    /[\x00-\x1f\x7f]/.test(name)
  ) {
    throw new HelmError('validation_error', `invalid artifact filename: ${raw}`, 400)
  }
  return name
}

interface RegisterOptions {
  /** Display name; defaults to source filename. */
  name?: string
  mimeType?: string
}

interface SpillResult {
  text: string
  artifact?: ArtifactMetadata
}

/**
 * Dependency for re-checking conversation existence right before write (injected by HTTP upload path):
 * closes the interleaving window between initial validation -> conversation deletion -> upload completion
 * (reading up to 15 MiB can take a while), preventing orphan files under `artifacts/<deletedConv>/`.
 * Omitted when not needed (tool path runs inside a live turn with a trusted conversation ID).
 */
interface WriteUploadedDeps {
  conversationExists(conversationId: number): boolean | Promise<boolean>
}

function detectMime(name: string): string {
  return detectMimeByExtension(name) ?? BINARY_MIME
}

/** UTF-8 safe head truncation: slices by byte budget without splitting multi-byte code points. */
function truncateUtf8Safe(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1
  return buf.subarray(0, end).toString('utf8')
}

/** UTF-8 safe tail truncation: takes the trailing `maxBytes` bytes (used for tail summaries). */
function truncateUtf8Tail(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let start = buf.length - maxBytes
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start += 1
  return buf.subarray(start).toString('utf8')
}

export type { ArtifactKind, ArtifactMetadata }

/**
 * Artifact relative path (POSIX separator, the canonical form stored in DB and read cross-platform).
 *
 * Must NEVER be generated with `path.join`: Windows would produce backslashes, whereas `resolveStoredPath`
 * splits on `/` and explicitly rejects backslashes (traversal guard), breaking immediate reads on the same host.
 */
function artifactRelPath(conversationId: number, storedName: string): string {
  return `artifacts/${String(conversationId)}/${storedName}`
}

export class ArtifactService {
  constructor(
    private readonly dataDir: string,
    private readonly repository: ArtifactRepository,
    /** Filters registered secrets before touching disk or returning output to model context. */
    private readonly stash?: { redact(text: string): string },
  ) {}

  /**
   * Per-conversation write/delete chain: serializes disk writes + metadata mutations for one
   * conversation so an upload that already passed its existence check can never recreate the
   * directory of a conversation deleted concurrently (existence checks alone cannot close that
   * interleaving — the write itself awaits). Chains settle to empty tails so keys never leak.
   */
  private readonly conversationChains = new Map<number, Promise<unknown>>()

  private runOnConversationChain<T>(conversationId: number, op: () => Promise<T>): Promise<T> {
    const prev = this.conversationChains.get(conversationId) ?? Promise.resolve()
    const run = prev.then(op, op)
    const tail = run.then(
      () => {},
      () => {},
    )
    this.conversationChains.set(conversationId, tail)
    void tail.then(() => {
      if (this.conversationChains.get(conversationId) === tail) this.conversationChains.delete(conversationId)
    })
    return run
  }

  private convDir(conversationId: number): string {
    return join(this.dataDir, 'artifacts', String(conversationId))
  }

  /** Boundary check on `conversationId`: positive integer only (prevents `-1` or floats from escaping dirs). */
  private assertConversationId(conversationId: number): void {
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      throw new Error(`invalid conversationId: ${String(conversationId)}`)
    }
  }

  /**
   * Register a source file: copies (0600) into `artifacts/<convId>/` and returns metadata.
   * - Text MIME types: read text -> `stash.redact` -> atomic write so registration never bypasses
   *   SecretStash guarantees; writes verbatim if no stash is configured (never fakes security silently);
   * - Binary files: copied byte-for-byte without text re-encoding.
   */
  async register(
    conversationId: number,
    sourcePath: string,
    opts: RegisterOptions = {},
  ): Promise<ArtifactMetadata> {
    this.assertConversationId(conversationId)
    if (typeof sourcePath !== 'string' || sourcePath === '') {
      throw new Error('sourcePath cannot be empty')
    }
    const name = opts.name ?? sourcePath.split(/[\\/]/).pop() ?? 'artifact'
    if (/[\\/\0]/.test(name)) throw new Error(`invalid artifact name: ${name}`)
    const mimeType = opts.mimeType ?? detectMime(name)
    // Chained like uploads (ordering vs deleteConversation); no existence check by design —
    // the tool-spill path runs inside a live turn with a trusted conversation ID.
    return this.runOnConversationChain(conversationId, async () => {
      const id = randomUUID()
      const storedName = `${id}-${name}`
      const dest = join(this.convDir(conversationId), storedName)
      let size: number
      if (isTextMime(mimeType)) {
        // Read source text and redact first: registration copies must honor stash non-leakage guarantees.
        const raw = await readTextFile(sourcePath)
        const safe = this.stash !== undefined ? this.stash.redact(raw) : raw
        await atomicWriteFile(dest, safe)
        size = Buffer.byteLength(safe, 'utf8')
      } else {
        await copyFilePrivate(sourcePath, dest)
        size = (await stat(dest)).size
      }
      const metadata: ArtifactMetadata = {
        id,
        conversationId,
        kind: 'registered',
        name,
        path: artifactRelPath(conversationId, storedName),
        mimeType,
        size,
        createdAt: Date.now(),
      }
      this.repository.put(metadata)
      return metadata
    })
  }

  /**
   * Upload write: cross-platform HTTP artifact upload entrypoint (handles both binary streams and JSON base64).
   * - Capped at 15 MiB (`413 artifact_too_large` on overflow);
   * - Text MIME types pass through `stash.redact` before atomic write;
   * - Binary files are written atomically byte-for-byte (no UTF-8 re-encoding);
   * - Written verbatim when no stash is configured (never fakes security silently).
   */
  async writeUploaded(
    conversationId: number,
    input: { name: string; bytes: Uint8Array; mimeType?: string },
    deps?: WriteUploadedDeps,
  ): Promise<ArtifactMetadata> {
    this.assertConversationId(conversationId)
    const safeName = sanitizeUploadFilename(input.name)
    if (input.bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new HelmError(
        'artifact_too_large',
        `artifact size exceeds 15 MiB limit (${input.bytes.byteLength} > ${MAX_ARTIFACT_BYTES})`,
        413,
        { maxBytes: MAX_ARTIFACT_BYTES, actualBytes: input.bytes.byteLength },
      )
    }
    const mimeType =
      input.mimeType !== undefined && input.mimeType.trim() !== ''
        ? input.mimeType.trim().toLowerCase()
        : detectMime(safeName)
    // Existence check, write, and metadata put run inside the per-conversation chain: relative to a
    // concurrently running deleteConversation (rm + metadata purge) the upload either completes
    // wholly before the purge (final state clean) or observes the deletion and rejects 404 — it can
    // never recreate the directory of a deleted conversation as an orphan.
    return this.runOnConversationChain(conversationId, async () => {
      if (deps !== undefined && !(await deps.conversationExists(conversationId))) {
        throw new HelmError('not_found', `conversation not found: ${conversationId}`, 404, { conversationId })
      }
      const id = randomUUID()
      const storedName = `${id}-${safeName}`
      const dest = join(this.convDir(conversationId), storedName)
      let size: number
      if (isTextMime(mimeType)) {
        const raw = Buffer.from(input.bytes).toString('utf8')
        const safeText = this.stash !== undefined ? this.stash.redact(raw) : raw
        await atomicWriteFile(dest, safeText)
        size = Buffer.byteLength(safeText, 'utf8')
      } else {
        await atomicWriteFile(dest, input.bytes)
        size = input.bytes.byteLength
      }
      const metadata: ArtifactMetadata = {
        id,
        conversationId,
        kind: 'upload',
        name: safeName,
        path: artifactRelPath(conversationId, storedName),
        mimeType,
        size,
        createdAt: Date.now(),
      }
      this.repository.put(metadata)
      return metadata
    })
  }

  async get(id: string): Promise<ArtifactMetadata> {
    const metadata = this.repository.get(id)
    if (metadata === undefined) throw new FileNotFoundError(`artifact ${id}`)
    return metadata
  }

  async list(conversationId: number): Promise<ArtifactMetadata[]> {
    this.assertConversationId(conversationId)
    return this.repository.list(conversationId)
  }

  /**
   * Resolve `metadata.path` to an absolute path inside `dataDir/artifacts`.
   * The repository (sqlite/in-memory Map) is not a trusted boundary: hand-edited DB `path` values must
   * never let this service read arbitrary files—paths must still normalize inside `artifacts/<convId>/`.
   */
  private async resolveStoredPath(metadata: ArtifactMetadata): Promise<string> {
    this.assertConversationId(metadata.conversationId)
    const parts = metadata.path.split('/')
    if (parts[0] !== 'artifacts' || parts[1] !== String(metadata.conversationId) || parts.length < 3 ||
        parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) {
      throw new Error(`artifact path escapes artifacts conversation directory; read rejected: ${metadata.path}`)
    }
    const dataRoot = await realpath(this.dataDir)
    const artifactsRoot = await realpath(join(dataRoot, 'artifacts'))
    const conversationRoot = await realpath(join(artifactsRoot, String(metadata.conversationId)))
    const filePath = await realpath(join(this.dataDir, metadata.path))
    if (!artifactsRoot.startsWith(dataRoot + sep) || !conversationRoot.startsWith(artifactsRoot + sep) ||
        !filePath.startsWith(conversationRoot + sep)) {
      throw new Error(`artifact path escapes artifacts conversation directory; read rejected: ${metadata.path}`)
    }
    return filePath
  }

  /** Read artifact contents as UTF-8 text. */
  async readContent(id: string): Promise<string> {
    const metadata = await this.get(id)
    return readTextFile(await this.resolveStoredPath(metadata))
  }

  /** Read raw artifact bytes (used by HTTP client downloads; also works for text artifacts). */
  async readBuffer(id: string): Promise<Uint8Array> {
    const metadata = await this.get(id)
    return readFile(await this.resolveStoredPath(metadata))
  }

  /**
   * Oversized tool-output spill:
   * - `<= 32 KiB`: returned verbatim (no artifact created);
   * - `> 32 KiB`: writes full content to `tool-spill-<callId>.txt` (through stash redaction) and
   *   returns a 4 KiB head preview + truncation marker + tail summary + artifact reference.
   */
  async spill(conversationId: number, callId: string, text: string): Promise<SpillResult> {
    this.assertConversationId(conversationId)
    if (typeof text !== 'string') throw new Error('spill text must be a string')
    if (typeof callId !== 'string' || callId === '') throw new Error('callId cannot be empty')
    if (!CALL_ID_PATTERN.test(callId) || callId.includes('..')) {
      throw new Error(`invalid callId: ${callId}`)
    }
    // Redact content first: existing secret placeholders remain untouched while registered secrets are scrubbed.
    const safeText = this.stash !== undefined ? this.stash.redact(text) : text
    const totalBytes = Buffer.byteLength(safeText, 'utf8')
    if (totalBytes <= SPILL_THRESHOLD_BYTES) {
      return { text: safeText }
    }
    const fileName = toSpillFileName(callId)
    const absPath = join(this.convDir(conversationId), fileName)
    await atomicWriteFile(absPath, safeText)
    const metadata: ArtifactMetadata = {
      id: randomUUID(),
      conversationId,
      kind: 'spill',
      name: fileName,
      path: artifactRelPath(conversationId, fileName),
      mimeType: 'text/plain',
      size: totalBytes,
      createdAt: Date.now(),
    }
    this.repository.put(metadata)
    const head = truncateUtf8Safe(safeText, PREVIEW_HEAD_BYTES)
    const tail = truncateUtf8Tail(safeText, 256)
    const text2 =
      `${head}\n\n...[output too long, truncated. Full result (${totalBytes} bytes) written to artifact]...\n\n` +
      `--- tail summary ---\n${tail}\n\n` +
      `[Artifact] id=${metadata.id} path=${metadata.path} (call tool read_artifact to get full text)`
    return { text: text2, artifact: metadata }
  }

  /**
   * Cascading deletion: delete artifact files on disk first, then remove metadata on success.
   * Order must not be reversed: deleting metadata first before a failed `rm` leaves unindexed orphan files;
   * crashing between `rm` and deleting metadata can simply be retried idempotently on the next delete with zero data loss.
   */
  async deleteConversation(conversationId: number): Promise<void> {
    this.assertConversationId(conversationId)
    // Runs on the same per-conversation chain as uploads/registrations: an in-flight write that
    // queued earlier finishes first and is then purged wholesale; anything queued after observes
    // its own existence re-check (upload path) or lands before the purge completes.
    await this.runOnConversationChain(conversationId, async () => {
      await rm(this.convDir(conversationId), { recursive: true, force: true })
      this.repository.deleteByConversation(conversationId)
    })
  }

  /** Actual filenames in the conversation artifact directory (used by test assertions). */
  async listFiles(conversationId: number): Promise<string[]> {
    try {
      return (await readdir(this.convDir(conversationId))).sort()
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return []
      throw err
    }
  }

  /** Ensure conversation artifact directory exists (for callers placing files directly). */
  async ensureConversationDir(conversationId: number): Promise<string> {
    this.assertConversationId(conversationId)
    const dir = this.convDir(conversationId)
    await mkdir(dir, { recursive: true })
    return dir
  }
}
