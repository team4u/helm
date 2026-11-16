/**
 * conversation artifact authorization and attachment parse/content group install module.
 *
 * responsibility:
 * - decide conversation for artifact access authorization (this conversation or parent conversation chain, at most 32 layer guard against ring);
 * - parse and validate attachment artifact ID list (store in, authorization, light amount pointer, metadata, disk absolute path);
 * - piece together install model visible attachment prompt chunk [Attached Files](contains pull refer quote);
 * - piece together install carries multimodal diagram piece model visible content (pure text / text chunk + ImageContent base64).
 */
import { join } from 'node:path'
import type { ArtifactMetadata, ConversationAttachmentRef } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { FileNotFoundError, type ArtifactService } from '../services/index.js'
import type { HelmStore } from './store.js'

/** diagram piece class mime: attachment piece together install multimodal ImageContent decide collection. */
export const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export interface ConversationAttachmentsHost {
  readonly store: HelmStore
  readonly artifactsSvc: ArtifactService
  readonly dataDir: string
}

export class ConversationAttachments {
  constructor(private readonly host: ConversationAttachmentsHost) {}

  /** artifact authorization: when before conversation or its parent chain (sub-conversation can read parent conversation artifact); at most 32 layer guard against ring. */
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
   * parse and authorization validate attachment artifact ID list:
   * - artifact must store in (FileNotFoundError -> 404 not_found, attach artifactId);
   * - artifact conversation must be when before conversation or its parent chain (exceeds right mount 403 artifact_forbidden);
   * - return light amount pointer (ref)+ complete metadata + absolute path (supply prompt and multimodal piece together install).
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
          throw new HelmError('not_found', `attachment artifact missing:${artifactId}`, 404, { artifactId })
        }
        throw error
      })
      if (!this.isArtifactAuthorized(conversationId, metadata.conversationId)) {
        throw new HelmError(
          'artifact_forbidden',
          `artifact ${artifactId} do not belongs to conversation ${conversationId} or its parent conversation chain, reject exceeds right mount`,
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

  /** single attachment authorization parse (app combine layer/herdr plugin dependency inject use; error semantics same on). */
  async resolveAuthorizedAttachment(
    conversationId: number,
    artifactId: string,
  ): Promise<{ id: string; name: string; mimeType: string; size: number; absPath: string }> {
    const [resolved] = await this.resolveAuthorizedAttachments(conversationId, [artifactId])
    if (resolved === undefined) {
      throw new HelmError('not_found', `attachment artifact missing:${artifactId}`, 404, { artifactId })
    }
    return { ...resolved.ref, absPath: resolved.absPath }
  }

  /** [Attached Files] pure text manifest chunk (spawn task prompt use; without body text prefix). */
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
   * construct carries attachment model visible content:
   * - [Attached Files] manifest (contains pull refer quote) piece together in body text after;
   * - store in diagram piece attachment when return multimodal chunk array (text chunk + diagram piece ImageContent base64);
   * - without diagram piece attachment when return concatenate after pure text.
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
