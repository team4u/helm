/**
 * 时间线渲染隔离纯函数层（纯 .ts，零 React/DOM 依赖，单测直测）。
 *
 * 背景：长会话时间线保留完整 DOM（大纲定位 / 搜索高亮 / 插件 timeline.renderer
 * 契约不裁剪条目），历史已完成行通过 CSS `content-visibility: auto` +
 * `contain-intrinsic-size: auto <px>` 交给浏览器跳过屏外行的渲染工作。
 *
 * 诚实边界：这不是 DOM 虚拟化（节点始终在文档中，querySelectorAll / 大纲 /
 * 搜索照常工作）；也不承诺零滚动抖动——从未渲染过的行只有按文本规模分桶的
 * 占位估高，滚动经过时浏览器按真实高度纠正，表现为滚动条长度轻微变化。
 *
 * 本模块同时承载「视口当前阅读锚点」的 IntersectionObserver 决策纯函数：
 * 观察器以「行顶越过容器顶 + OUTLINE_ACTIVE_LINE_PX 基准线」为相交语义，
 * 与 outline-model.resolveActiveOutlineEntryId 的“最后一个越过基准线的锚点、
 * 全部未越过时取首个锚点”语义对齐，屏外行不触发整列 getBoundingClientRect
 * 强制布局。
 */

import type { TimelineItem } from './timeline-model.js'

// ---------------------------------------------------------------------------
// 估高分桶
// ---------------------------------------------------------------------------

/** 历史完成行渲染隔离桶（对应 CSS 类 tl-cv-<bucket>）。 */
export type ContainmentBucket = 'xs' | 'sm' | 'md' | 'lg'

/** 各桶 contain-intrinsic-size 估高起点（px）；`auto` 关键字优先沿用真实高度。 */
export const CONTAINMENT_INTRINSIC_PX: Readonly<Record<ContainmentBucket, number>> = {
  xs: 48,
  sm: 120,
  md: 360,
  lg: 900,
}

/** 行级渲染隔离 CSS 类名。 */
export function containmentClassName(bucket: ContainmentBucket): string {
  return `tl-cv-${bucket}`
}

/** 正文估高参数：约 55 字符/行（中英混排折中）、每行约 23px。 */
const CHARS_PER_LINE = 55
const LINE_HEIGHT_PX = 23
/** 单条工具行 / 折叠组摘要行（26px 行高 + 间隙均摊）。 */
const TOOL_ROW_PX = 30
/** 人类胶囊内边距 + 底部栏、回合 footer 等固定铬块估高。 */
const HUMAN_CHROME_PX = 42
const TURN_CHROME_PX = 48
/** 每个附件芯片（缩略图/芯片行）估高。 */
const ATTACHMENT_PX = 34

function bucketByEstimatedHeight(px: number): ContainmentBucket {
  if (px <= 160) return 'sm'
  if (px <= 480) return 'md'
  return 'lg'
}

/**
 * 按文本规模为历史完成行选择估高桶：
 * - divider：固定 26px 分割线，给最小桶；
 * - plugin-card：插件 timeline.renderer 卡片高度不可知（可变高内容），给中等桶，
 *   首次渲染后由 contain-intrinsic-size 的 auto 记忆沿用真实高度；
 * - human / assistant：按正文字符量（+附件/工具行数）粗估行数后分桶。
 */
export function estimateContainmentBucket(item: TimelineItem): ContainmentBucket {
  if (item.kind === 'divider') return 'xs'
  if (item.kind === 'plugin-card') return 'md'
  if (item.kind === 'human') {
    const lines = Math.max(1, Math.ceil(item.text.length / CHARS_PER_LINE))
    const attachments = item.attachments?.length ?? 0
    return bucketByEstimatedHeight(lines * LINE_HEIGHT_PX + attachments * ATTACHMENT_PX + HUMAN_CHROME_PX)
  }
  // assistant：正文文本 + 工具行（step-group 折叠后仅占一条摘要行，
  // 用户展开后由 auto 记忆纠正；live 回合不参与隔离，见 resolveContainmentClass）。
  let chars = 0
  let rows = 0
  for (const seg of item.segments) {
    if (seg.kind === 'text') chars += seg.text.length
    else rows += 1
  }
  const lines = chars === 0 ? 0 : Math.ceil(chars / CHARS_PER_LINE)
  return bucketByEstimatedHeight(lines * LINE_HEIGHT_PX + rows * TOOL_ROW_PX + TURN_CHROME_PX)
}

// ---------------------------------------------------------------------------
// 隔离判定
// ---------------------------------------------------------------------------

/**
 * 时间线行的锚点 id：与渲染层 `data-entry-id` 同口径（人类/分割线/插件卡取
 * entryId，assistant 回合取首个持久化条目 id，无条目时退回 React key）。
 */
export function timelineAnchorId(item: TimelineItem): string {
  return item.kind === 'assistant' ? (item.entryIds[0] ?? item.key) : item.entryId
}

export interface ContainmentExclusions {
  /** 必须解除隔离的锚点集合（搜索/大纲高亮与定位目标：内容需真实布局后测量滚动）。 */
  releasedEntryIds: ReadonlySet<string>
  /** 最新 assistant 回合 key：无论会话 busy 与否始终真实渲染（见下）。 */
  latestAssistantKey?: string
}

/**
 * 判定单个时间线行是否可应用渲染隔离 class：
 * - 浏览器不支持或未启用（enabled=false）一律正常渲染；
 * - 仍在变化的内容不可隔离：live 流式回合、排队输入（queuedMode）；
 * - 最新 assistant 回合无论会话 busy 与否一律真实渲染：首次打开的初始贴底与
 *   活跃跟底的估高误差都集中在尾部（尾部长回答的真实高度远大于估高桶，
 *   隔离它会让首次置底落在估算总高上），且该回合是用户当前关注的落点；
 * - 高亮 / 大纲定位目标行必须解除隔离（否则 scrollIntoView 以占位高度定位失真）。
 */
export function resolveContainmentClass(
  item: TimelineItem,
  exclusions: ContainmentExclusions,
  enabled: boolean,
): string {
  if (!enabled) return ''
  if (item.kind === 'human' && item.queuedMode !== undefined) return ''
  if (item.kind === 'assistant') {
    if (item.live) return ''
    if (item.key === exclusions.latestAssistantKey) return ''
  }
  if (exclusions.releasedEntryIds.has(timelineAnchorId(item))) return ''
  return containmentClassName(estimateContainmentBucket(item))
}

/**
 * 浏览器是否支持 content-visibility 渲染隔离；不支持则整列正常渲染
 * （旧属性声明会被 CSS 忽略，此处仍在 JS 侧短路以避免无意义的类名维护）。
 */
export function supportsTimelineContainment(): boolean {
  if (typeof window === 'undefined' || typeof CSS === 'undefined' || typeof CSS.supports !== 'function') {
    return false
  }
  return CSS.supports('content-visibility', 'auto') && CSS.supports('contain-intrinsic-size', 'auto 120px')
}

// ---------------------------------------------------------------------------
// 视口当前阅读锚点（IntersectionObserver 决策）
// ---------------------------------------------------------------------------

/**
 * 大纲激活基准线（px）：与 outline-model.resolveActiveOutlineEntryId 的
 * 默认阈值同源——最后一个行顶越过「容器顶 + 96px」的锚点为当前阅读锚点。
 */
export const OUTLINE_ACTIVE_LINE_PX = 96

/**
 * 由当前相交锚点索引集合推导激活锚点索引（IO 路径决策核心）：
 * - 取 DOM 序（索引序）最后一个相交锚点，对齐 resolveActiveOutlineEntryId
 *   “最后一个越过基准线的锚点”语义（观察器 rootMargin 把相交区域下缘收窄到
 *   基准线，行相交 ⟺ 行顶已越过基准线且行身未远高于视口）；
 * - 空集（全部锚点都在基准线下方，如刚打开或滚动到最顶）回退首个锚点；
 * - 无锚点返回 -1。
 */
export function resolveActiveAnchorIndex(
  intersecting: ReadonlySet<number>,
  anchorCount: number,
): number {
  if (anchorCount === 0) return -1
  let max = -1
  for (const idx of intersecting) {
    if (idx < 0 || idx >= anchorCount) continue
    if (idx > max) max = idx
  }
  return max === -1 ? 0 : max
}
