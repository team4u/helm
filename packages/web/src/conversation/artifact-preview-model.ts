/**
 * artifact.previewer 纯逻辑：宿主侧产物预览贡献匹配与稳定排序（无组件导出）。
 *
 * 契约（@helm/protocol ui.ts）：
 * - mimeTypes：MIME 精确值或 type/* 通配；extensions：含点号小写后缀（含多段后缀）；
 *   两类匹配取 OR；都省略 = 声明接管全部产物；
 * - scope：需宿主已加载真实会话元数据才命中（无会话上下文不可泛命中）；
 * - 排序：priority 降序 -> 贡献顺序稳定。
 */
import type { ArtifactPreviewerSpec, ConversationSummary } from '@helm/protocol'
import { matchesUiScope, type QualifiedUiSpec } from '../lib/types.js'

export type ArtifactPreviewerContribution = QualifiedUiSpec<ArtifactPreviewerSpec>

/** MIME 精确值或 type/* 通配（大小写不敏感；其余通配形态不支持）。 */
export function matchesMimeType(mimeTypes: ReadonlyArray<string> | undefined, mimeType: string): boolean {
  if (mimeTypes === undefined || mimeTypes.length === 0) return false
  const actual = mimeType.trim().toLowerCase()
  if (!actual) return false
  for (const declared of mimeTypes) {
    const pattern = declared.trim().toLowerCase()
    if (!pattern) continue
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1) // 'text/'
      if (actual.startsWith(prefix)) return true
    } else if (actual === pattern) {
      return true
    }
  }
  return false
}

/**
 * 文件名后缀匹配：extensions 为含点号小写后缀（可多段，如 '.tar.gz'）。
 * 名称未知（undefined / 空）时不做任何后缀猜测——绝不以 artifactId 冒充文件名。
 */
export function matchesExtension(extensions: ReadonlyArray<string> | undefined, name: string | undefined): boolean {
  if (extensions === undefined || extensions.length === 0) return false
  if (name === undefined || name.trim() === '') return false
  const lower = name.toLowerCase()
  for (const declared of extensions) {
    const ext = declared.trim().toLowerCase()
    if (!ext) continue
    if (lower.endsWith(ext)) return true
  }
  return false
}

/**
 * 单个贡献是否命中当前产物（mime / extensions 取 OR；两者皆缺省 = 接管全部）。
 */
export function previewerMatchesArtifact(
  spec: ArtifactPreviewerSpec,
  artifact: { name?: string; mimeType: string },
): boolean {
  const hasMime = spec.mimeTypes !== undefined && spec.mimeTypes.length > 0
  const hasExt = spec.extensions !== undefined && spec.extensions.length > 0
  if (!hasMime && !hasExt) return true
  return matchesMimeType(spec.mimeTypes, artifact.mimeType) || matchesExtension(spec.extensions, artifact.name)
}

/**
 * 收集命中当前产物的预览贡献：scope 过滤 + MIME/后缀匹配 + priority 降序稳定排序。
 *
 * @param conversation 当前会话元数据；undefined 表示无已加载会话上下文——
 *   此时带 scope 的贡献一律不命中（无会话上下文不可泛命中），只有全局贡献可用。
 */
export function collectArtifactPreviewers(
  contributions: ReadonlyArray<ArtifactPreviewerContribution>,
  artifact: { name?: string; mimeType: string },
  conversation: ConversationSummary | undefined,
): ArtifactPreviewerContribution[] {
  const matched: ArtifactPreviewerContribution[] = []
  for (const item of contributions) {
    // scope 过滤复用全局会话语义：带 scope 贡献在无会话上下文时一律不命中。
    if (!matchesUiScope(conversation, item.spec.scope)) continue
    if (!previewerMatchesArtifact(item.spec, artifact)) continue
    matched.push(item)
  }
  return matched
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (b.item.spec.priority ?? 0) - (a.item.spec.priority ?? 0) || a.index - b.index)
    .map((entry) => entry.item)
}
