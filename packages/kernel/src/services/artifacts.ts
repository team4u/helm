/**
 * ArtifactService：会话产物落盘与超长工具输出 Spill。
 * - register 将来源文件复制进 artifacts/<convId>/ 并登记元数据；
 * - spill 对 > 32KiB（UTF-8 字节）的文本写全量文件，返回 4KiB 头部预览；
 * - 所有写盘文本先经 SecretStash 还原占位符检查——注意方向：spill 落盘的是
 *   「工具原始输出」，其中若含 stash 占位符则保持占位形态（秘密绝不落盘）；
 *   提供给模型上下文的预览同样只含占位符，不还原秘密。
 */
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ArtifactMetadata } from '@helm/protocol'
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

export interface RegisterOptions {
  /** 展示名；缺省用源文件名。 */
  name?: string
  mimeType?: string
}

export interface SpillResult {
  text: string
  artifact?: ArtifactMetadata
}

const BINARY_MIME = 'application/octet-stream'

function detectTextMime(name: string): string {
  if (/\.md$/i.test(name)) return 'text/markdown'
  if (/\.json$/i.test(name)) return 'application/json'
  if (/\.txt$/i.test(name)) return 'text/plain'
  return BINARY_MIME
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

export class ArtifactService {
  constructor(
    private readonly dataDir: string,
    private readonly repository: ArtifactRepository,
    /** 预留：落盘前的文本脱敏钩子（如未来需要擦除其他敏感模式）。 */
    private readonly stash?: { redact(text: string): string },
  ) {}

  private convDir(conversationId: number): string {
    return join(this.dataDir, 'artifacts', String(conversationId))
  }

  /**
   * 登记来源文件：复制（0600）到 artifacts/<convId>/ 下，返回元数据。
   * 复制而非移动——不破坏调用方工作目录中的原文件。
   */
  async register(
    conversationId: number,
    sourcePath: string,
    opts: RegisterOptions = {},
  ): Promise<ArtifactMetadata> {
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      throw new Error(`非法 conversationId: ${String(conversationId)}`)
    }
    if (typeof sourcePath !== 'string' || sourcePath === '') {
      throw new Error('sourcePath 不能为空')
    }
    const name = opts.name ?? sourcePath.split(/[\\/]/).pop() ?? 'artifact'
    if (/[\\/\0]/.test(name)) throw new Error(`非法产物名: ${name}`)
    const mimeType = opts.mimeType ?? detectTextMime(name)
    const id = randomUUID()
    const storedName = `${id}-${name}`
    const dest = join(this.convDir(conversationId), storedName)
    await copyFilePrivate(sourcePath, dest)
    const size = (await stat(dest)).size
    const metadata: ArtifactMetadata = {
      id,
      conversationId,
      name,
      path: join('artifacts', String(conversationId), storedName),
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
    return this.repository.list(conversationId)
  }

  /** 读产物内容（任意产物，文本形态返回）。 */
  async readContent(id: string): Promise<string> {
    const metadata = await this.get(id)
    return readTextFile(join(this.dataDir, metadata.path))
  }

  /**
   * 工具超长输出 Spill：
   * - <= 32KiB：原样返回（不产生 artifact）；
   * - > 32KiB：全量写 `tool-spill-<callId>.txt`（经 stash 脱敏钩子），
   *   返回「头部 4KiB 预览 + 截断标记 + 尾部摘要 + artifact 指引」。
   */
  async spill(conversationId: number, callId: string, text: string): Promise<SpillResult> {
    if (typeof text !== 'string') throw new Error('spill 文本必须是字符串')
    if (typeof callId !== 'string' || callId === '') throw new Error('callId 不能为空')
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(callId)) {
      throw new Error(`非法 callId: ${callId}`)
    }
    // 落盘内容先脱敏：秘密占位符保持占位（不还原），并交由 stash 钩子擦除。
    const safeText = this.stash !== undefined ? this.stash.redact(text) : text
    const totalBytes = Buffer.byteLength(safeText, 'utf8')
    if (totalBytes <= SPILL_THRESHOLD_BYTES) {
      return { text: safeText }
    }
    const fileName = `tool-spill-${callId}.txt`
    const absPath = join(this.convDir(conversationId), fileName)
    await atomicWriteFile(absPath, safeText)
    const metadata: ArtifactMetadata = {
      id: randomUUID(),
      conversationId,
      name: fileName,
      path: join('artifacts', String(conversationId), fileName),
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

  /** 级联删除：移除该会话全部产物文件与元数据。 */
  async deleteConversation(conversationId: number): Promise<void> {
    this.repository.deleteByConversation(conversationId)
    await rm(this.convDir(conversationId), { recursive: true, force: true })
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
    const dir = this.convDir(conversationId)
    await mkdir(dir, { recursive: true })
    return dir
  }
}
