/**
 * 会话产物授权与附件解析/内容组装模块。
 *
 * 职责：
 * - 判定会话对产物的访问授权（本会话或父会话链，最多 32 层防环）；
 * - 解析并校验附件产物 ID 列表（存在性、授权、轻量指针、元数据、磁盘绝对路径）；
 * - 拼装模型可见的附件提示词块 [Attached Files]（含拉取指引）；
 * - 拼装带多模态图片的模型可见内容（纯文本 / 文本块 + ImageContent base64）。
 */
import { join } from 'node:path'
import type { ArtifactMetadata, ConversationAttachmentRef } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { FileNotFoundError, type ArtifactService } from '../services/index.js'
import type { HelmStore } from './store.js'

/** 图片类 mime：附件拼装多模态 ImageContent 的判定集。 */
export const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export interface ConversationAttachmentsHost {
  readonly store: HelmStore
  readonly artifactsSvc: ArtifactService
  readonly dataDir: string
}

export class ConversationAttachments {
  constructor(private readonly host: ConversationAttachmentsHost) {}

  /** 产物授权：当前会话或其父链（子会话可读父会话产物）；最多 32 层防环。 */
  isArtifactAuthorized(conversationId: number, artifactConversationId: number): boolean {
    if (conversationId === artifactConversationId) return true
    let current: number | undefined = conversationId
    const seen = new Set<number>()
    for (let depth = 0; depth < 32 && current !== undefined && !seen.has(current); depth += 1) {
      seen.add(current)
      if (current === artifactConversationId) return true
      current = this.host.store.getConv(current)?.parentConversationId
    }
    return false
  }

  /**
   * 解析并授权校验附件产物 ID 列表：
   * - 产物必须存在（FileNotFoundError -> 404 not_found，附 artifactId）；
   * - 产物会话必须是当前会话或其父链（越权挂载 403 artifact_forbidden）；
   * - 返回轻量指针（ref）+ 完整元数据 + 绝对路径（供提示词与多模态拼装）。
   */
  async resolveAuthorizedAttachments(
    conversationId: number,
    attachmentIds: readonly string[],
  ): Promise<
    Array<{ ref: ConversationAttachmentRef; metadata: ArtifactMetadata; absPath: string }>
  > {
    const unique = [...new Set(attachmentIds)]
    const out: Array<{ ref: ConversationAttachmentRef; metadata: ArtifactMetadata; absPath: string }> = []
    for (const artifactId of unique) {
      const metadata = await this.host.artifactsSvc.get(artifactId).catch((error: unknown) => {
        if (error instanceof FileNotFoundError) {
          throw new HelmError('not_found', `附件产物不存在：${artifactId}`, 404, { artifactId })
        }
        throw error
      })
      if (!this.isArtifactAuthorized(conversationId, metadata.conversationId)) {
        throw new HelmError(
          'artifact_forbidden',
          `产物 ${artifactId} 不属于会话 ${conversationId} 或其父会话链，拒绝越权挂载`,
          403,
          { conversationId, artifactId, artifactConversationId: metadata.conversationId },
        )
      }
      out.push({
        ref: { id: metadata.id, name: metadata.name, mimeType: metadata.mimeType, size: metadata.size },
        metadata,
        absPath: join(this.host.dataDir, metadata.path),
      })
    }
    return out
  }

  /** 单附件授权解析（app 组合层/herdr 插件依赖注入用；错误语义同上）。 */
  async resolveAuthorizedAttachment(
    conversationId: number,
    artifactId: string,
  ): Promise<{ id: string; name: string; mimeType: string; size: number; absPath: string }> {
    const [resolved] = await this.resolveAuthorizedAttachments(conversationId, [artifactId])
    if (resolved === undefined) {
      throw new HelmError('not_found', `附件产物不存在：${artifactId}`, 404, { artifactId })
    }
    return { ...resolved.ref, absPath: resolved.absPath }
  }

  /** [Attached Files] 纯文本清单块（spawn 任务提示词用；无正文前缀）。 */
  buildAttachmentBlock(
    resolved: Array<{ ref: ConversationAttachmentRef; absPath: string }>,
  ): string {
    const lines = resolved.map(
      ({ ref, absPath }) =>
        `- ${ref.name} (id=${ref.id}, mime=${ref.mimeType}, size=${ref.size} bytes, path=${absPath}, pull=\`helm artifacts get ${ref.id} --output ./${ref.name}\`)`,
    )
    return `[Attached Files]\n${lines.join('\n')}`
  }

  /**
   * 构造带附件的模型可见内容：
   * - [Attached Files] 清单（含拉取指引）拼在正文后；
   * - 存在图片附件时返回多模态块数组（文本块 + 图片 ImageContent base64）；
   * - 无图片附件时返回拼接后的纯文本。
   */
  async buildAttachmentContent(
    effectiveText: string,
    resolved: Array<{ ref: ConversationAttachmentRef; absPath: string }>,
  ): Promise<
    string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  > {
    const lines = resolved.map(
      ({ ref, absPath }) =>
        `- ${ref.name} (id=${ref.id}, mime=${ref.mimeType}, size=${ref.size} bytes, path=${absPath}, pull=\`helm artifacts get ${ref.id} --output ./${ref.name}\`)`,
    )
    const attachedBlock = `[Attached Files]\n${lines.join('\n')}`
    const modelText = effectiveText.length > 0 ? `${effectiveText}\n\n${attachedBlock}` : attachedBlock
    const hasImage = resolved.some(({ ref }) => IMAGE_MIMES.has(ref.mimeType))
    if (!hasImage) return modelText
    const contentParts: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
      { type: 'text', text: modelText },
    ]
    for (const item of resolved) {
      if (!IMAGE_MIMES.has(item.ref.mimeType)) continue
      const bytes = await this.host.artifactsSvc.readBuffer(item.ref.id)
      contentParts.push({
        type: 'image',
        data: Buffer.from(bytes).toString('base64'),
        mimeType: item.ref.mimeType,
      })
    }
    return contentParts
  }
}
