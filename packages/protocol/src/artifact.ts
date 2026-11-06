/**
 * 会话产物契约：工具超长输出自动 Spill 与会话产出文件的统一元数据。
 */

/** 产物元数据（与 services 层代理对齐的固定字段集）。 */
export interface ArtifactMetadata {
  id: string
  conversationId: number
  name: string
  /** 相对 dataDir 的文件路径（`artifacts/<convId>/<name>`）。 */
  path: string
  mimeType: string
  /** 字节数。 */
  size: number
  /** Unix 毫秒时间戳。 */
  createdAt: number
}
