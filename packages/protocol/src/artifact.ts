/**
 * Conversation artifact contract: unified metadata for automatic spill of over-long tool output
 * and conversation-produced files.
 */

/** Artifact source category: upload = explicit user/tool upload, registered = local file registration, spill = over-long output snapshot. */
export type ArtifactKind = 'upload' | 'registered' | 'spill'

export const ARTIFACT_KINDS = ['upload', 'registered', 'spill'] as const satisfies readonly ArtifactKind[]

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return value === 'upload' || value === 'registered' || value === 'spill'
}

/** Artifact metadata (a fixed field set aligned with the services layer agents). */
export interface ArtifactMetadata {
  id: string
  conversationId: number
  kind: ArtifactKind
  name: string
  /** File path relative to dataDir (`artifacts/<convId>/<name>`). */
  path: string
  mimeType: string
  /** Size in bytes. */
  size: number
  /** Unix timestamp in milliseconds. */
  createdAt: number
}

/** Lightweight artifact pointer attached to conversation input (zero Base64 bloat in SQLite). */
export interface ConversationAttachmentRef {
  id: string
  name: string
  mimeType: string
  size: number
}
