/**
 * ArtifactService: conversation artifact and over long tool output Spill.
 * - register source file duplicate enter artifacts/<convId>/ and register metadata:
 *   text class mime first read text via SecretStash.redact again atomic write (stash do not
 *   promise override register path); two enter system keep byte original duplicate, does not any rotate code;
 * - spill for > 32KiB(UTF-8 byte) text write all amount file, return 4KiB header preview;
 * - all write text and model preview first via SecretStash redaction, already exists placeholder keep original.
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

/** metadata repository contract: by durable layer (state.sqlite artifacts table) implement. */
export interface ArtifactRepository {
  get(id: string): ArtifactMetadata | undefined
  list(conversationId: number): ArtifactMetadata[]
  put(metadata: ArtifactMetadata): void
  deleteByConversation(conversationId: number): void
}

/** test/memory implement; produce by pi-durable artifacts table provide. */
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

/** Spill threshold: exceeds 32 KiB(UTF-8 byte) only then. */
export const SPILL_THRESHOLD_BYTES = 32 * 1024
/** preview header length:4 KiB(UTF-8 security truncate). */
export const PREVIEW_HEAD_BYTES = 4 * 1024
/** upload artifact large small cap:15 MiB. */
export const MAX_ARTIFACT_BYTES = 15 * 1024 * 1024
/**
 * protocol layer callId legal form: first token symbol character parent number, after continue allows `A-Za-z0-9._:|+-`, forbidden `..` and path isolate symbol.
 * override Anthropic (`toolu_*`),OpenAI Completions (`call_*`) and OpenAI Responses (`call_*|fc_*`).
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

/** upload filename length cap. */
const MAX_UPLOAD_NAME_LENGTH = 200

/** upload filename clean: reject through exceeds/control character/over long name (boundary directly 400, not silently change name). */
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
    throw new HelmError('validation_error', `illegal artifact filename: ${raw}`, 400)
  }
  return name
}

export interface RegisterOptions {
  /** render name; default use source file name. */
  name?: string
  mimeType?: string
}

export interface SpillResult {
  text: string
  artifact?: ArtifactMetadata
}

/** before conversation store in re-check dependency (HTTP upload path inject): close entry validate via →
 * conversation delete → upload hand over wrong window (upload body read can reach whole segment 15 MiB when long),
 * avoid in artifacts/<already delete conversation>/ rebuild directory under forever long orphan child file. not inject when
 * do not re-check (tool path operation at leap conversation, conversation ID from subject to message execute context). */
export interface WriteUploadedDeps {
  conversationExists(conversationId: number): boolean | Promise<boolean>
}

const BINARY_MIME = 'application/octet-stream'

/** common text extension → mime(default do not guess, unify BINARY_MIME, read way away buffer zone). */
const TEXT_MIME_BY_EXT: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  txt: 'text/plain',
  csv: 'text/csv',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/plain',
  xml: 'application/xml',
  log: 'text/plain',
}

/** common two enter system extension → mime(without third way mime store, only override high frequency format). */
const BINARY_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
}

function detectMime(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return TEXT_MIME_BY_EXT[ext] ?? BINARY_MIME_BY_EXT[ext] ?? BINARY_MIME
}

/** is otherwise text class mime(register when must redaction,spill/HTTP readContent return text). */
function isTextMime(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    mimeType === 'image/svg+xml' ||
    mimeType === 'text/yaml'
  )
}

/** UTF-8 security truncate: by byte cap cut, never in multibyte character middle disconnect. */
export function truncateUtf8Safe(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1
  return buf.subarray(0, end).toString('utf8')
}

/** UTF-8 security take tail part maxBytes byte (tail part summary use). */
export function truncateUtf8Tail(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let start = buf.length - maxBytes
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start += 1
  return buf.subarray(start).toString('utf8')
}

export type { ArtifactKind, ArtifactMetadata }

/**
 * artifact relative path (POSIX isolate symbol, written to the database and across platform read unique form).
 *
 * never can via path.join generate:Windows will obtain to backslash isolate relative path, while
 * resolveStoredPath segment validate by `/` cut and explicit reject backslash (guard against through exceeds),
 * at is all artifact in the same platform on after write immediately read do not out.
 */
function artifactRelPath(conversationId: number, storedName: string): string {
  return `artifacts/${String(conversationId)}/${storedName}`
}

export class ArtifactService {
  constructor(
    private readonly dataDir: string,
    private readonly repository: ArtifactRepository,
    /** and context output before filter already register secret. */
    private readonly stash?: { redact(text: string): string },
  ) {}

  private convDir(conversationId: number): string {
    return join(this.dataDir, 'artifacts', String(conversationId))
  }

  /** conversationId boundary validate: positive integer, guard against -1/decimal as directory segment out of bounds. */
  private assertConversationId(conversationId: number): void {
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      throw new Error(`illegal conversationId: ${String(conversationId)}`)
    }
  }

  /**
   * register source file: duplicate (0600) to artifacts/<convId>/ under, return metadata.
   * - text class mime: read text → stash.redact redaction → atomic write.stash guarantee secret
   *   do not, duplicate i.e. path must same guard the promise; without stash when such as per original write
   *   (caller not config redaction hook, do not is static default fall back while fabricate security).
   * - two enter system: by byte original duplicate, never with text pattern rotate code break content.
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
    if (/[\\/\0]/.test(name)) throw new Error(`illegal artifact name: ${name}`)
    const mimeType = opts.mimeType ?? detectMime(name)
    const id = randomUUID()
    const storedName = `${id}-${name}`
    const dest = join(this.convDir(conversationId), storedName)
    let size: number
    if (isTextMime(mimeType)) {
      // first read source text redaction again:register duplicate must not bypass stash do not promise.
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
  }

  /**
   * upload write: across platform HTTP artifact entry (Web/CLI two enter system stream or JSON base64 unify in this).
   * - cap 15 MiB(over limit 413 artifact_too_large);
   * - text class mime via stash.redact redaction after atomic write (guard secret do not promise);
   * - two enter system byte original atomic write (do not UTF-8 heavy encode, fidelity);
   * - without stash when such as per original write (caller not config redaction hook, do not is static default fall back while fabricate security).
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
        `artifact large small exceeds 15 MiB cap (${input.bytes.byteLength} > ${MAX_ARTIFACT_BYTES})`,
        413,
        { maxBytes: MAX_ARTIFACT_BYTES, actualBytes: input.bytes.byteLength },
      )
    }
    // before finally one moment re-check conversation store in: re-check to write between without await(atomic window),
    // HTTP path orphan child artifact hand over wrong window by this closed together; non- not_found error by caller call back
    // such as on throw, do not in this fake call conversation missing.
    if (deps !== undefined && !(await deps.conversationExists(conversationId))) {
      throw new HelmError('not_found', `conversation missing:${conversationId}`, 404, { conversationId })
    }
    const mimeType =
      input.mimeType !== undefined && input.mimeType.trim() !== ''
        ? input.mimeType.trim().toLowerCase()
        : detectMime(safeName)
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
   *  metadata.path parse is dataDir/artifacts inside absolute path.
   * repository (sqlite/memory Map) is not can message boundary: manually change DB  path field must not let this service
   * read any file, reason force specification after must still in artifacts inside.
   */
  private async resolveStoredPath(metadata: ArtifactMetadata): Promise<string> {
    this.assertConversationId(metadata.conversationId)
    const parts = metadata.path.split('/')
    if (parts[0] !== 'artifacts' || parts[1] !== String(metadata.conversationId) || parts.length < 3 ||
        parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) {
      throw new Error(`artifact path exceeds out artifacts conversation directory, reject read: ${metadata.path}`)
    }
    const dataRoot = await realpath(this.dataDir)
    const artifactsRoot = await realpath(join(dataRoot, 'artifacts'))
    const conversationRoot = await realpath(join(artifactsRoot, String(metadata.conversationId)))
    const filePath = await realpath(join(this.dataDir, metadata.path))
    if (!artifactsRoot.startsWith(dataRoot + sep) || !conversationRoot.startsWith(artifactsRoot + sep) ||
        !filePath.startsWith(conversationRoot + sep)) {
      throw new Error(`artifact path exceeds out artifacts conversation directory, reject read: ${metadata.path}`)
    }
    return filePath
  }

  /** read artifact content (any artifact, text form return). */
  async readContent(id: string): Promise<string> {
    const metadata = await this.get(id)
    return readTextFile(await this.resolveStoredPath(metadata))
  }

  /** read artifact original byte (HTTP side to client transfer use; text artifact same can away this path). */
  async readBuffer(id: string): Promise<Uint8Array> {
    const metadata = await this.get(id)
    return readFile(await this.resolveStoredPath(metadata))
  }

  /**
   * tool over long output Spill:
   * - <= 32KiB: original return (produces no artifact);
   * - > 32KiB: all amount write `tool-spill-<callId>.txt`(via stash redaction hook),
   *   return header 4KiB preview + truncate mark record + tail part summary + artifact refer quote.
   */
  async spill(conversationId: number, callId: string, text: string): Promise<SpillResult> {
    this.assertConversationId(conversationId)
    if (typeof text !== 'string') throw new Error('spill text must be string')
    if (typeof callId !== 'string' || callId === '') throw new Error('callId cannot be empty')
    if (!CALL_ID_PATTERN.test(callId) || callId.includes('..')) {
      throw new Error(`illegal callId: ${callId}`)
    }
    // content first redaction: secret placeholder keep occupy (do not restore), and hand over by stash hook erase.
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
      `${head}\n\n...[output over long, already truncate. complete result ${totalBytes} byte already write artifact]...\n\n` +
      `--- tail part summary ---\n${tail}\n\n` +
      `[Artifact] id=${metadata.id} path=${metadata.path}(invoke tool read_artifact get all text)`
    return { text: text2, artifact: metadata }
  }

  /**
   * level join delete: first thing delete artifact file, after success again remove metadata.
   * order cannot upside down placement: first delete index after rm failed will under without main file (orphan child); reverse of most broken case
   * is rm succeeded but delete index before crash, under time heavy delete still can blank etc. price retry, do not lose data.
   */
  async deleteConversation(conversationId: number): Promise<void> {
    this.assertConversationId(conversationId)
    await rm(this.convDir(conversationId), { recursive: true, force: true })
    this.repository.deleteByConversation(conversationId)
  }

  /** directory in actual filename manifest (test observe thing use). */
  async listFiles(conversationId: number): Promise<string[]> {
    try {
      return (await readdir(this.convDir(conversationId))).sort()
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return []
      throw err
    }
  }

  /** ensure conversation artifact directory store in (supply external directly put placement file scenario). */
  async ensureConversationDir(conversationId: number): Promise<string> {
    this.assertConversationId(conversationId)
    const dir = this.convDir(conversationId)
    await mkdir(dir, { recursive: true })
    return dir
  }
}
