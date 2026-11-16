/**
 * 会话产物契约：工具超长输出自动 Spill 与会话产出文件的统一元数据。
 */

/** 产物来源分类：upload=用户/工具显式上传，registered=本地文件登记，spill=超长输出溢出快照。 */
export type ArtifactKind = 'upload' | 'registered' | 'spill'

export const ARTIFACT_KINDS = ['upload', 'registered', 'spill'] as const satisfies readonly ArtifactKind[]

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return value === 'upload' || value === 'registered' || value === 'spill'
}

/** 产物元数据（与 services 层代理对齐的固定字段集）。 */
export interface ArtifactMetadata {
  id: string
  conversationId: number
  kind: ArtifactKind
  name: string
  /** 相对 dataDir 的文件路径（`artifacts/<convId>/<name>`）。 */
  path: string
  mimeType: string
  /** 字节数。 */
  size: number
  /** Unix 毫秒时间戳。 */
  createdAt: number
}

/** 附着在会话输入上的轻量产物指针（SQLite 零 Base64 膨胀）。 */
export interface ConversationAttachmentRef {
  id: string
  name: string
  mimeType: string
  size: number
}
