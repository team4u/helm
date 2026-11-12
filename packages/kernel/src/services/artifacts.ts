/**
 * ArtifactService：会话产物落盘与超长工具输出 Spill。
 * - register 将来源文件复制进 artifacts/<convId>/ 并登记元数据：
 *   文本类 mime 先读文本经 SecretStash.redact 再原子写（stash 的「不落盘」
 *   承诺覆盖 register 路径）；二进制保持字节原样复制，不做任何转码；
 * - spill 对 > 32KiB（UTF-8 字节）的文本写全量文件，返回 4KiB 头部预览；
 * - 所有写盘文本与模型预览先经 SecretStash 脱敏，已存在的占位符保持原样。
 */
import { mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { HelmError, type ArtifactMetadata } from '@helm/protocol'
import {
  FileNotFoundError,
  atomicWriteFile,
  copyFilePrivate,
  readTextFile,
} from './atomic-file.js'

/** 元数据仓库契约：由持久层（state.sqlite artifacts 表）实现。 */
export interface ArtifactRepository {
  get(id: string): ArtifactMetadata | undefined
  list(conversationId: number): ArtifactMetadata[]
  put(metadata: ArtifactMetadata): void
  deleteByConversation(conversationId: number): void
}

/** 测试/内存实现；生产由 pi-durable artifacts 表提供。 */
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

/** Spill 阈值：超过 32 KiB（UTF-8 字节）才落盘。 */
export const SPILL_THRESHOLD_BYTES = 32 * 1024
/** 预览头部长度：4 KiB（UTF-8 安全截断）。 */
export const PREVIEW_HEAD_BYTES = 4 * 1024
/** 上传产物大小上限：15 MiB。 */
export const MAX_ARTIFACT_BYTES = 15 * 1024 * 1024
/**
 * 协议层 callId 合法形态：首字符字母数字，后续允许 `A-Za-z0-9._:|+-`，禁止 `..` 与路径分隔符。
 * 覆盖 Anthropic (`toolu_*`)、OpenAI Completions (`call_*`) 与 OpenAI Responses (`call_*|fc_*`)。
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

/** 上传文件名长度上限。 */
const MAX_UPLOAD_NAME_LENGTH = 200

/** 上传文件名净化：拒绝穿越/控制字符/超长名（边界直接 400，不静默改名）。 */
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
    throw new HelmError('validation_error', `非法产物文件名: ${raw}`, 400)
  }
  return name
}

export interface RegisterOptions {
  /** 展示名；缺省用源文件名。 */
  name?: string
  mimeType?: string
}

export interface SpillResult {
  text: string
  artifact?: ArtifactMetadata
}

/** 落盘前会话存在性复核依赖（HTTP 上传路径注入）：关闭「入口校验通过 →
 * 会话删除 → 上传落盘」交错窗口（上传体读取可达整段 15 MiB 时长），
 * 避免在 artifacts/<已删会话>/ 重建目录留下永久孤儿文件。未注入时
 * 不复核（工具路径操作于活跃会话，会话 ID 来自受信执行上下文）。 */
export interface WriteUploadedDeps {
  conversationExists(conversationId: number): boolean | Promise<boolean>
}

const BINARY_MIME = 'application/octet-stream'

/** 常见文本扩展名 → mime（缺省不猜，统一 BINARY_MIME，读方走缓冲区）。 */
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

/** 常见二进制扩展名 → mime（无第三方 mime 库，仅覆盖高频格式）。 */
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

/** 是否文本类 mime（register 时需脱敏，spill/HTTP readContent 返回文本）。 */
function isTextMime(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    mimeType === 'image/svg+xml' ||
    mimeType === 'text/yaml'
  )
}

/** UTF-8 安全截断：按字节上限切，绝不在多字节字符中间断开。 */
export function truncateUtf8Safe(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1
  return buf.subarray(0, end).toString('utf8')
}

/** UTF-8 安全取尾部 maxBytes 字节（尾部摘要用）。 */
export function truncateUtf8Tail(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let start = buf.length - maxBytes
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start += 1
  return buf.subarray(start).toString('utf8')
}

export type { ArtifactMetadata }

/**
 * 产物相对路径（POSIX 分隔符，落库与跨平台读取的唯一形态）。
 *
 * 绝不能经 path.join 生成：Windows 会得到反斜杠分隔的相对路径，而
 * resolveStoredPath 的分段校验按 `/` 切分并显式拒绝反斜杠（防穿越），
 * 于是所有产物在同一平台上写入后立刻读不出来。
 */
function artifactRelPath(conversationId: number, storedName: string): string {
  return `artifacts/${String(conversationId)}/${storedName}`
}

export class ArtifactService {
  constructor(
    private readonly dataDir: string,
    private readonly repository: ArtifactRepository,
    /** 落盘及上下文输出前过滤已登记的秘密。 */
    private readonly stash?: { redact(text: string): string },
  ) {}

  private convDir(conversationId: number): string {
    return join(this.dataDir, 'artifacts', String(conversationId))
  }

  /** conversationId 边界校验：正整数，防 -1/小数作为目录段越界。 */
  private assertConversationId(conversationId: number): void {
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      throw new Error(`非法 conversationId: ${String(conversationId)}`)
    }
  }

  /**
   * 登记来源文件：复制（0600）到 artifacts/<convId>/ 下，返回元数据。
   * - 文本类 mime：读文本 → stash.redact 脱敏 → 原子写。stash 保证秘密
   *   「不落盘」，复制即落盘的路径必须同样守住该承诺；无 stash 时如实照原样写
   *   （调用方未配置脱敏钩子，不为静默降级而伪造安全）。
   * - 二进制：按字节原样复制，绝不以文本模式转码破坏内容。
   */
  async register(
    conversationId: number,
    sourcePath: string,
    opts: RegisterOptions = {},
  ): Promise<ArtifactMetadata> {
    this.assertConversationId(conversationId)
    if (typeof sourcePath !== 'string' || sourcePath === '') {
      throw new Error('sourcePath 不能为空')
    }
    const name = opts.name ?? sourcePath.split(/[\\/]/).pop() ?? 'artifact'
    if (/[\\/\0]/.test(name)) throw new Error(`非法产物名: ${name}`)
    const mimeType = opts.mimeType ?? detectMime(name)
    const id = randomUUID()
    const storedName = `${id}-${name}`
    const dest = join(this.convDir(conversationId), storedName)
    let size: number
    if (isTextMime(mimeType)) {
      // 先读源文本脱敏再落盘：register 复制不得绕过 stash 不落盘承诺。
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
   * 上传写入：跨平台 HTTP 产物入口（Web/CLI 二进制流或 JSON base64 统一在此落盘）。
   * - 上限 15 MiB（超限 413 artifact_too_large）；
   * - 文本类 mime 经 stash.redact 脱敏后原子写（守住「秘密不落盘」承诺）；
   * - 二进制字节原样原子写（不 UTF-8 重编码，保真）；
   * - 无 stash 时如实照原样写（调用方未配置脱敏钩子，不为静默降级而伪造安全）。
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
        `产物大小超过 15 MiB 上限（${input.bytes.byteLength} > ${MAX_ARTIFACT_BYTES}）`,
        413,
        { maxBytes: MAX_ARTIFACT_BYTES, actualBytes: input.bytes.byteLength },
      )
    }
    // 落盘前最后一刻复核会话存在：复核到写盘之间无 await（原子窗口），
    // HTTP 路径的孤儿产物交错窗口由此闭合；非 not_found 错误由调用方回调
    // 如实上抛，不在此伪称会话缺失。
    if (deps !== undefined && !(await deps.conversationExists(conversationId))) {
      throw new HelmError('not_found', `会话不存在：${conversationId}`, 404, { conversationId })
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
   * 将 metadata.path 解析为 dataDir/artifacts 内的绝对路径。
   * 仓库（sqlite/内存 Map）不是可信边界：手改 DB 的 path 字段不得让本服务
   * 读任意文件，故强制规范化后必须仍在 artifacts 根内。
   */
  private async resolveStoredPath(metadata: ArtifactMetadata): Promise<string> {
    this.assertConversationId(metadata.conversationId)
    const parts = metadata.path.split('/')
    if (parts[0] !== 'artifacts' || parts[1] !== String(metadata.conversationId) || parts.length < 3 ||
        parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) {
      throw new Error(`产物路径越出 artifacts 会话目录，拒绝读取: ${metadata.path}`)
    }
    const dataRoot = await realpath(this.dataDir)
    const artifactsRoot = await realpath(join(dataRoot, 'artifacts'))
    const conversationRoot = await realpath(join(artifactsRoot, String(metadata.conversationId)))
    const filePath = await realpath(join(this.dataDir, metadata.path))
    if (!artifactsRoot.startsWith(dataRoot + sep) || !conversationRoot.startsWith(artifactsRoot + sep) ||
        !filePath.startsWith(conversationRoot + sep)) {
      throw new Error(`产物路径越出 artifacts 会话目录，拒绝读取: ${metadata.path}`)
    }
    return filePath
  }

  /** 读产物内容（任意产物，文本形态返回）。 */
  async readContent(id: string): Promise<string> {
    const metadata = await this.get(id)
    return readTextFile(await this.resolveStoredPath(metadata))
  }

  /** 读产物原始字节（HTTP 侧向客户端传输用；文本产物同样可走此路径）。 */
  async readBuffer(id: string): Promise<Uint8Array> {
    const metadata = await this.get(id)
    return readFile(await this.resolveStoredPath(metadata))
  }

  /**
   * 工具超长输出 Spill：
   * - <= 32KiB：原样返回（不产生 artifact）；
   * - > 32KiB：全量写 `tool-spill-<callId>.txt`（经 stash 脱敏钩子），
   *   返回「头部 4KiB 预览 + 截断标记 + 尾部摘要 + artifact 指引」。
   */
  async spill(conversationId: number, callId: string, text: string): Promise<SpillResult> {
    this.assertConversationId(conversationId)
    if (typeof text !== 'string') throw new Error('spill 文本必须是字符串')
    if (typeof callId !== 'string' || callId === '') throw new Error('callId 不能为空')
    if (!CALL_ID_PATTERN.test(callId) || callId.includes('..')) {
      throw new Error(`非法 callId: ${callId}`)
    }
    // 落盘内容先脱敏：秘密占位符保持占位（不还原），并交由 stash 钩子擦除。
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
      `${head}\n\n…[输出超长，已截断。完整结果 ${totalBytes} 字节已写入产物]…\n\n` +
      `--- 尾部摘要 ---\n${tail}\n\n` +
      `[Artifact] id=${metadata.id} path=${metadata.path}（调用工具 read_artifact 获取全文）`
    return { text: text2, artifact: metadata }
  }

  /**
   * 级联删除：先物理删除产物文件，成功后再移除元数据。
   * 顺序不可倒置：先删索引后 rm 失败会留下无主文件（孤儿）；反之最坏情况
   * 是 rm 成功但删索引前崩溃，下次重删仍可白等价重试，不丢数据。
   */
  async deleteConversation(conversationId: number): Promise<void> {
    this.assertConversationId(conversationId)
    await rm(this.convDir(conversationId), { recursive: true, force: true })
    this.repository.deleteByConversation(conversationId)
  }

  /** 目录中实际文件名清单（测试观察物理落盘用）。 */
  async listFiles(conversationId: number): Promise<string[]> {
    try {
      return (await readdir(this.convDir(conversationId))).sort()
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return []
      throw err
    }
  }

  /** 确保会话产物目录存在（供外部直接放置文件的场景）。 */
  async ensureConversationDir(conversationId: number): Promise<string> {
    this.assertConversationId(conversationId)
    const dir = this.convDir(conversationId)
    await mkdir(dir, { recursive: true })
    return dir
  }
}
