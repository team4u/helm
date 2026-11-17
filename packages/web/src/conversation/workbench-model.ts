/**
 * 工作台抽屉纯逻辑层（零 React/DOM 依赖，单测直测）：
 * - 合并插件 workbench.panel 贡献与内置「产物」页签，按 spec.order 升序排列；
 * - 解析 WorkbenchPanelSpec.badge：从插件 public doc 提取每面板（可按会话）的
 *   count / tone / footerText；
 * - 汇总顶栏「工作台」按钮总角标计数与最高优先级色调（warn > accent > neutral）；
 * - 解析当前有效激活页签（无效页签回退首个可用页签）。
 */
import type { ArtifactKind, ArtifactMetadata, HelmLocale, WorkbenchPanelBadgeSpec, WorkbenchPanelSpec } from '@helm/protocol/browser'
import { resolveLocalizedText } from '@helm/protocol/browser'
import { createWebTranslator, englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import type { GroupedUiSpecs } from '../lib/types.js'

export type WorkbenchBadgeTone = 'warn' | 'accent' | 'neutral'

/** 单个工作台页签的渲染视图模型。 */
export interface WorkbenchTab {
  id: string
  label: string
  order: number
  /** 页签角标计数（0 表示无角标）。 */
  count: number
  /** 角标色调（顶栏汇总取最高优先级）。 */
  tone: WorkbenchBadgeTone
  /** 抽屉底部状态栏文案（空值不展示）。 */
  footerText?: string
  /** 插件面板贡献（内置产物页签为 undefined）。 */
  pluginId?: string
  spec?: WorkbenchPanelSpec
}

/** 顶栏「工作台」按钮汇总角标。 */
export interface WorkbenchSummaryBadge {
  totalCount: number
  tone: WorkbenchBadgeTone
}

/** 内置产物页签固定 ID。 */
export const WORKBENCH_ARTIFACTS_TAB_ID = 'artifacts'

function toneValue(tone: unknown): WorkbenchBadgeTone | undefined {
  return tone === 'warn' || tone === 'accent' || tone === 'neutral' ? tone : undefined
}

function safeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** 从插件 public doc 提取面板角标数据（按会话索引优先，缺省回落全局字段）。 */
export function resolveWorkbenchPanelBadge(
  badge: WorkbenchPanelBadgeSpec | undefined,
  docValue: unknown,
  conversationId: number | undefined,
): { count: number; tone: WorkbenchBadgeTone; footerText?: string } {
  if (badge === undefined) return { count: 0, tone: 'neutral' }
  if (docValue === null || typeof docValue !== 'object' || Array.isArray(docValue)) {
    return { count: 0, tone: 'neutral' }
  }
  const doc = docValue as Record<string, unknown>
  // 按会话索引：doc[byConversationField][String(conversationId)] = { count, tone?, footerText? }
  if (badge.byConversationField !== undefined && conversationId !== undefined) {
    const byConv = doc[badge.byConversationField]
    if (byConv !== null && typeof byConv === 'object' && !Array.isArray(byConv)) {
      const entry = (byConv as Record<string, unknown>)[String(conversationId)]
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        const e = entry as Record<string, unknown>
        const count = safeCount(e['count'])
        if (count !== undefined) {
          return {
            count,
            tone: toneValue(e['tone']) ?? 'neutral',
            ...(typeof e['footerText'] === 'string' && e['footerText'] !== '' ? { footerText: e['footerText'] } : {}),
          }
        }
      }
    }
  }
  // 全局字段回落：docValue[countField] / docValue[toneField]
  const count = badge.countField !== undefined ? safeCount(doc[badge.countField]) : undefined
  if (count === undefined) return { count: 0, tone: 'neutral' }
  return {
    count,
    tone: (badge.toneField !== undefined ? toneValue(doc[badge.toneField]) : undefined) ?? 'neutral',
  }
}

/**
 * 计算当前会话可用的工作台页签列表：
 * - 内置「产物 (N)」页签固定 order 20；
 * - 插件 workbench.panel 按 spec.order ?? 50 升序合并，label 属
 *   LocalizedText 显示元数据，按传入 locale 解析（解析为空回退 spec.id）；
 * - 每面板角标经 resolveWorkbenchPanelBadge 从 pluginDocs 提取。
 */
export function buildWorkbenchTabs(input: {
  groupedUi: Pick<GroupedUiSpecs, 'workbenchPanels'>
  /** 各插件 public doc 映射（key: `${pluginId}/${docName}`）。 */
  pluginDocs: Record<string, unknown>
  /** 当前会话产物数量（内置产物页签计数）。 */
  artifactCount: number
  /** 当前会话 ID（badge 按会话索引时使用）。 */
  conversationId: number | undefined
  /** 面板 label（LocalizedText）的解析 locale。 */
  locale: HelmLocale
  /** 可选 Web 翻译器（未传时按 input.locale 派生）。 */
  t?: WebMessageTranslator
}): WorkbenchTab[] {
  const t = input.t ?? createWebTranslator(input.locale)
  const tabs: WorkbenchTab[] = [
    {
      id: WORKBENCH_ARTIFACTS_TAB_ID,
      label: t('conv.workbench.artifactsTab'),
      order: 20,
      count: input.artifactCount,
      tone: 'neutral',
    },
  ]
  for (const panel of input.groupedUi.workbenchPanels) {
    const badge = panel.spec.badge
    const resolved =
      badge !== undefined
        ? resolveWorkbenchPanelBadge(badge, input.pluginDocs[`${panel.pluginId}/${badge.doc}`], input.conversationId)
        : { count: 0, tone: 'neutral' as const }
    tabs.push({
      id: `plugin:${panel.pluginId}/${panel.spec.id}`,
      label: resolveLocalizedText(panel.spec.label, input.locale) || panel.spec.id,
      order: panel.spec.order ?? 50,
      count: resolved.count,
      tone: resolved.tone,
      ...(resolved.footerText !== undefined ? { footerText: resolved.footerText } : {}),
      pluginId: panel.pluginId,
      spec: panel.spec,
    })
  }
  tabs.sort((a, b) => a.order - b.order)
  return tabs
}

/** 汇总顶栏「工作台」按钮角标：总数求和；色调取最高优先级（warn > accent > neutral）。 */
export function summarizeWorkbenchBadge(tabs: ReadonlyArray<WorkbenchTab>): WorkbenchSummaryBadge {
  let totalCount = 0
  let tone: WorkbenchBadgeTone = 'neutral'
  for (const tab of tabs) {
    totalCount += tab.count
    if (tab.tone === 'warn') tone = 'warn'
    else if (tab.tone === 'accent' && tone !== 'warn') tone = 'accent'
  }
  return { totalCount, tone }
}

/** 解析当前有效激活页签：requestedTab 在列表内取之，否则回退首个可用页签。 */
export function resolveActiveWorkbenchTab(
  requestedTab: string | undefined,
  tabs: ReadonlyArray<WorkbenchTab>,
): string {
  if (requestedTab !== undefined && tabs.some((tab) => tab.id === requestedTab)) return requestedTab
  return tabs[0]?.id ?? WORKBENCH_ARTIFACTS_TAB_ID
}

/** 抽屉底部状态栏文案：拼接各面板非空 footerText。 */
export function buildWorkbenchFooter(tabs: ReadonlyArray<WorkbenchTab>): string[] {
  const parts: string[] = []
  for (const tab of tabs) {
    if (tab.footerText !== undefined && tab.footerText !== '') parts.push(tab.footerText)
  }
  return parts
}

/** 按产物类型分离正式产物（registered / upload）与系统超长输出溢出快照（spill）。 */
export interface PartitionedArtifacts {
  readonly deliverables: ReadonlyArray<ArtifactMetadata>
  readonly spills: ReadonlyArray<ArtifactMetadata>
}

export function partitionArtifactsByKind(artifacts: ReadonlyArray<ArtifactMetadata> | undefined): PartitionedArtifacts {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return { deliverables: [], spills: [] }
  }
  const deliverables: ArtifactMetadata[] = []
  const spills: ArtifactMetadata[] = []
  for (const artifact of artifacts) {
    if (artifact.kind === 'spill') spills.push(artifact)
    else deliverables.push(artifact)
  }
  return { deliverables, spills }
}

/** 统计当前会话中的正式交付产物数量（排除 spill 输出快照）。 */
export function countDeliverableArtifacts(artifacts: ReadonlyArray<ArtifactMetadata> | undefined): number {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return 0
  let count = 0
  for (const artifact of artifacts) {
    if (artifact.kind !== 'spill') count += 1
  }
  return count
}

export function artifactKindLabel(kind: ArtifactKind, t: WebMessageTranslator = englishWebTranslator): string {
  if (kind === 'registered') return t('conv.workbench.kindRegistered')
  if (kind === 'upload') return t('conv.workbench.kindUpload')
  return t('conv.workbench.kindSpill')
}

export function isImageArtifact(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith('image/')
}

export function artifactFormatLabel(
  mimeType: string,
  filename: string,
  t: WebMessageTranslator = englishWebTranslator,
): string {
  const mime = mimeType.toLowerCase()
  if (mime.startsWith('image/')) return t('conv.workbench.formatImage')
  if (mime === 'application/pdf') return 'PDF'
  if (mime.includes('markdown') || filename.toLowerCase().endsWith('.md')) return 'Markdown'
  if (mime.includes('json') || filename.toLowerCase().endsWith('.json')) return 'JSON'
  if (mime.includes('csv') || filename.toLowerCase().endsWith('.csv')) return 'CSV'
  if (mime.includes('html') || /\.(html?|xhtml)$/i.test(filename)) return 'HTML'
  if (mime.includes('yaml') || /\.(ya?ml)$/i.test(filename)) return 'YAML'
  if (mime.startsWith('text/')) return t('conv.workbench.formatText')
  const dot = filename.lastIndexOf('.')
  if (dot > 0 && dot < filename.length - 1) {
    const ext = filename.slice(dot + 1).trim()
    if (ext.length > 0 && ext.length <= 6) return ext.toUpperCase()
  }
  return t('conv.workbench.formatFile')
}

export function artifactIconName(mimeType: string, kind: ArtifactKind): 'file-code' | 'file-text' | 'file' {
  if (kind === 'spill') return 'file-text'
  const mime = mimeType.toLowerCase()
  if (
    mime.includes('json')
    || mime.includes('javascript')
    || mime.includes('typescript')
    || mime.includes('html')
    || mime.includes('xml')
    || mime.includes('yaml')
  ) {
    return 'file-code'
  }
  if (mime.startsWith('text/') || mime.includes('markdown')) return 'file-text'
  return 'file'
}
