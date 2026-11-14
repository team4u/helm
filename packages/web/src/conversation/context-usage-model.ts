/**
 * 会话上下文用量的纯展示模型（Composer 胶囊/浮层与测试共用）。
 *
 * 契约（内核 ConversationContextUsage）：
 * - tokens 恒有；contextWindow 未知时省略（内核不伪造，前端同样不显示伪百分比）；
 * - thresholds 仅在窗口已知且自动压缩启用时携带；
 * - compacting/compactionError 为 pi.live 压缩状态透传。
 */

export type ContextUsageTone = 'ok' | 'warn' | 'high' | 'compacting'

export interface ContextUsageRow {
  key: string
  value: string
  /** 错误行（压缩失败）用错误色渲染。 */
  danger?: boolean
}

export interface ContextUsageView {
  /** 胶囊主文本：窗口已知为 '37%'，未知为估算量 '12.4k'。 */
  pillLabel: string
  /** 胶囊语义色调。 */
  tone: ContextUsageTone
  /** 浮层键值行（已格式化）。 */
  rows: ContextUsageRow[]
  /** 无障碍摘要。 */
  ariaLabel: string
}

/** tokens 人类可读：<1000 原值；k/M 一位小数（>=100k 取整）。 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '--'
  if (tokens < 1_000) return String(Math.round(tokens))
  if (tokens < 1_000_000) {
    const k = tokens / 1_000
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`
  }
  const m = tokens / 1_000_000
  return `${m >= 100 ? Math.round(m) : m.toFixed(1)}M`
}

/** 占用百分比（窗口未知返回 undefined；不伪造）。 */
export function contextPercent(usage: {
  tokens: number
  contextWindow?: number
}): number | undefined {
  if (usage.contextWindow === undefined || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) {
    return undefined
  }
  return Math.round((usage.tokens / usage.contextWindow) * 100)
}

/** 语义色调：压缩中优先展示；超阻塞阈值 high、超后台阈值 warn、其余 ok。 */
export function contextTone(usage: {
  tokens: number
  thresholds?: { backgroundTokens?: number; blockingTokens: number }
  compacting?: unknown
}): ContextUsageTone {
  if (usage.compacting !== undefined) return 'compacting'
  const blocking = usage.thresholds?.blockingTokens
  if (blocking !== undefined && usage.tokens > blocking) return 'high'
  const background = usage.thresholds?.backgroundTokens
  if (background !== undefined && usage.tokens > background) return 'warn'
  return 'ok'
}

const COMPACTION_TRIGGER_LABEL: Record<string, string> = {
  manual: '手动',
  threshold: '阈值',
  overflow: '溢出',
}

/** 组装胶囊 + 浮层展示数据（纯函数；无 usage 输入时调用方不渲染胶囊）。 */
export function contextUsageView(usage: {
  tokens: number
  contextWindow?: number
  measuredTokens?: number
  thresholds?: { backgroundTokens?: number; blockingTokens: number }
  compacting?: { trigger: 'manual' | 'threshold' | 'overflow'; blocking: boolean }
  compactionError?: string
}): ContextUsageView {
  const percent = contextPercent(usage)
  const pillLabel = percent !== undefined ? `${percent}%` : formatTokens(usage.tokens)
  const tone = contextTone(usage)
  const rows: ContextUsageRow[] = [
    { key: '上下文估算', value: `${formatTokens(usage.tokens)} tokens` },
    {
      key: '计量方式',
      value:
        usage.measuredTokens !== undefined
          ? `实测 ${formatTokens(usage.measuredTokens)} · 估算 ${formatTokens(Math.max(0, usage.tokens - usage.measuredTokens))}`
          : '全部估算（暂无实测锚点）',
    },
    {
      key: '上下文窗口',
      value:
        usage.contextWindow !== undefined
          ? `${formatTokens(usage.contextWindow)} tokens`
          : '未知（模型目录无窗口数据，不显示百分比）',
    },
  ]
  if (usage.thresholds !== undefined) {
    rows.push({ key: '阻塞压缩阈值', value: `${formatTokens(usage.thresholds.blockingTokens)} tokens` })
    if (usage.thresholds.backgroundTokens !== undefined) {
      rows.push({ key: '后台压缩阈值', value: `${formatTokens(usage.thresholds.backgroundTokens)} tokens` })
    }
  }
  if (usage.compacting !== undefined) {
    const trigger = COMPACTION_TRIGGER_LABEL[usage.compacting.trigger] ?? usage.compacting.trigger
    rows.push({
      key: '压缩进行中',
      value: `${trigger}触发${usage.compacting.blocking ? ' · 阻塞生成' : ' · 后台执行'}`,
    })
  }
  if (usage.compactionError !== undefined) {
    rows.push({ key: '最近压缩失败', value: usage.compactionError, danger: true })
  }
  const ariaLabel =
    percent !== undefined
      ? `上下文占用 ${percent}%（约 ${formatTokens(usage.tokens)} tokens）`
      : `上下文估算 ${formatTokens(usage.tokens)} tokens，窗口未知`
  return { pillLabel, tone, rows, ariaLabel }
}
