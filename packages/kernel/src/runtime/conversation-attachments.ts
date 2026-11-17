/**
 * Conversation artifact authorization and attachment resolution / content assembly module.
 *
 * Responsibilities:
 * - Check conversation access authorization for artifacts (self or ancestor conversation chain, max depth 32 to prevent cycles);
 * - Resolve and validate attachment artifact IDs (existence, authorization, lightweight ref, metadata, absolute path on disk);
 * - Assemble model-visible attachment prompt block `[Attached Files]` (with pull instructions);
 * - Assemble model-visible multimodal content when image attachments are present (plain text / text block + ImageContent base64).
 */
import { join } from 'node:path'
import type { ArtifactMetadata, ConversationAttachmentRef } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { FileNotFoundError, type ArtifactService } from '../services/index.js'
import type { HelmStore } from './store.js'

/** Image MIME types: predicate set for assembling multimodal ImageContent blocks from attachments. */
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

interface ConversationAttachmentsHost {
  readonly store: HelmStore
  readonly artifactsSvc: ArtifactService
  readonly dataDir: string
}

export class ConversationAttachments {
  constructor(private readonly host: ConversationAttachmentsHost) {}

  /** Artifact authorization: current conversation or its ancestor chain (children can read parent artifacts); capped at 32 hops to avoid cycles. */
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
   * Resolve and authorize a list of attachment artifact IDs:
   * - artifact must exist (FileNotFoundError -> 404 not_found with artifactId);
   * - artifact's conversation must be this conversation or an ancestor (unauthorized mount -> 403 artifact_forbidden);
   * - returns lightweight pointer (ref), full metadata, and absolute disk path (for prompt and multimodal assembly).
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
          throw new HelmError('not_found', `attachment artifact not found: ${artifactId}`, 404, { artifactId })
        }
        throw error
      })
      if (!this.isArtifactAuthorized(conversationId, metadata.conversationId)) {
        throw new HelmError(
          'artifact_forbidden',
          `artifact ${artifactId} does not belong to conversation ${conversationId} or its ancestor chain; refusing unauthorized attachment`,
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

  /** Single-attachment resolution and authorization (for hub composition / herdr plugin injection; identical error semantics). */
  async resolveAuthorizedAttachment(
    conversationId: number,
    artifactId: string,
  ): Promise<{ id: string; name: string; mimeType: string; size: number; absPath: string }> {
    const [resolved] = await this.resolveAuthorizedAttachments(conversationId, [artifactId])
    if (resolved === undefined) {
      throw new HelmError('not_found', `attachment artifact not found: ${artifactId}`, 404, { artifactId })
    }
    return { ...resolved.ref, absPath: resolved.absPath }
  }

  /** Plaintext `[Attached Files]` manifest block (for spawned task prompts, without body text prefix). */
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
   * Build model-visible content with attachments:
   * - appends the `[Attached Files]` manifest (with pull instructions) after the message body;
   * - if any image attachments exist, returns a multimodal block array (text block + base64 ImageContent blocks);
   * - if no image attachments exist, returns the concatenated plain string.
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
