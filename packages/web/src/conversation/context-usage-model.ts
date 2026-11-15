/**
 * 会话上下文用量的纯展示模型（Composer 只读状态文本与测试共用）。
 *
 * 展示规则严格对齐 pi agent 1.5.2 footer（dist/modes/interactive/components/footer.js）：
 * - formatTokens 分档：<1000 原值；<10000 一位小数 k；<1M 四舍五入 k；
 *   <10M 一位小数 M；之后四舍五入 M；
 * - 窗口已知显示 `${percent.toFixed(1)}%/${formatTokens(window)}`；百分比
 *   >90 红色、>70 黄色、其余默认灰；着色阈值严格大于（>90 / >70）；
 * - 压缩后尚无有效 assistant usage（tokens 为 null）显示 `?/${formatTokens(window)}`；
 * - 窗口未知绝不显示伪百分比或伪分母，有 tokens 只显示紧凑估算量且不着色；
 * - tokens=0（空会话 / 刚 reset）与压缩中以外的空 usage 不渲染。
 *
 * 契约（内核 ConversationContextUsage）：tokens 恒有（可为 null）；
 * contextWindow 未知时省略（内核不伪造）；compacting 为布尔透传；response 为
 * 最近一次成功且可测量的 assistant 响应端到端速率（可省略，无占位符）。
 * formatTokens 已收敛至 lib/format.ts（与会话用量展示同源的仓内唯一实现）。
 */
import type { ConversationResponseMetric } from '@helm/protocol'
import { formatTokens } from '../lib/format.js'

export type ContextUsageTone = 'default' | 'warn' | 'high'

export interface ContextUsageLabel {
  /** 只读文本（pi footer 同款格式）。 */
  text: string
  /** 语义色调：high 红 / warn 黄 / default 灰；窗口未知恒 default。 */
  tone: ContextUsageTone
  /** 悬停说明（非交互；无障碍与解释窗口/未知语义用）。 */
  title: string
}

export interface ContextUsageInput {
  tokens: number | null
  contextWindow?: number
  compacting?: boolean
  response?: ConversationResponseMetric
}

/** 组装只读状态文本（纯函数）；返回 null 表示不渲染任何状态文本。 */
export function contextUsageLabel(usage: ContextUsageInput): ContextUsageLabel | null {
  if (usage.compacting === true) {
    return { text: '精简中…', tone: 'default', title: '上下文精简进行中' }
  }
  if (usage.tokens === null) {
    // 最近一次精简后尚无新的回答：真实上下文未知，绝不拿摘要估算冒充。
    return usage.contextWindow !== undefined
      ? {
          text: `?/${formatTokens(usage.contextWindow)}`,
          tone: 'default',
          title: '最近一次精简后尚无新的回答，上下文用量未知',
        }
      : { text: '?', tone: 'default', title: '上下文用量未知（模型窗口未知）' }
  }
  // 空会话 / 刚 reset：无上下文可占，不渲染状态文本。
  if (usage.tokens === 0) return null
  if (usage.contextWindow === undefined) {
    return {
      text: formatTokens(usage.tokens),
      tone: 'default',
      title: `上下文估算 ${formatTokens(usage.tokens)} tokens（模型窗口未知，不显示百分比）`,
    }
  }
  const percent = (usage.tokens / usage.contextWindow) * 100
  const tone: ContextUsageTone = percent > 90 ? 'high' : percent > 70 ? 'warn' : 'default'
  return {
    text: `${percent.toFixed(1)}%/${formatTokens(usage.contextWindow)}`,
    tone,
    title: `上下文占用 ${percent.toFixed(1)}%（约 ${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} tokens）`,
  }
}

export interface ResponseTpsLabel {
  /** 只读文本（紧凑 mono/tabular，如 `52.4 tok/s`）。 */
  text: string
  /** 悬停说明：必须如实标注端到端（含首字延迟）语义，不得声称纯解码速率。 */
  title: string
}

/** 最近响应端到端速率只读文本（纯函数）；无有效测量返回 null——
 * 不显示占位符，不用过期速度或历史平均冒充。 */
export function responseTpsLabel(usage: ContextUsageInput): ResponseTpsLabel | null {
  const metric = usage.response
  if (metric === undefined) return null
  const tps = metric.responseTps
  if (typeof tps !== 'number' || !Number.isFinite(tps) || tps <= 0) return null
  const seconds = metric.responseDurationMs / 1000
  const durationText = Number.isFinite(seconds) && seconds > 0 ? `${seconds.toFixed(1)}s` : '未知耗时'
  return {
    text: `${tps.toFixed(1)} tok/s`,
    title: `最近响应 ${tps.toFixed(1)} tok/s（端到端：${metric.responseOutputTokens} 输出 tokens / ${durationText}，含首字延迟，非纯解码速率）`,
  }
}
