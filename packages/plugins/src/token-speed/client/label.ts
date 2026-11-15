/**
 * builtin:token-speed 速率徽标的纯展示模型（无组件导出，Fast Refresh 友好）。
 *
 * 诚实性纪律：
 * - 一切速率都是基于 live 节流帧（75ms 帧 × partial 提交 100ms 双重粒度）
 *   的观测估算——即使终态 token 数经 provider usage 对账准确，时间仍是帧
 *   观测近似，徽标文本一律加 ≈ 前缀（移动端无 title 也能知道是估算），
 *   绝不暗示服务器精确解码时间；
 * - 无可靠速率（工具暂停 / 窗口滑空 / 首字前 / 终态无可测累计）不渲染任何
 *   占位文本，绝不以 0.0 tok/s 冒充真实速率；
 * - tooltip 必须区分「实时滑动窗口观测」与「终态对账」口径，并如实标注：
 *   不含首字延迟与工具执行时间、估算口径（provider / estimate / mixed）、
 *   TTFT 起点是插件首次观测（非请求精确起点）。
 */

/** token 口径的展示文案。 */
function sourceLabel(source: string): string {
  if (source === 'provider') return '供应商 usage'
  if (source === 'mixed') return '供应商 usage + 字符估算混合'
  return '字符估算（chars/4）'
}

export interface SpeedLabel {
  /** 只读文本（紧凑 mono/tabular，如 `52.4 tok/s`）。 */
  text: string
  /** 悬停说明（口径自证）。 */
  title: string
}

/** 秒文本：不足 10s 保留一位小数，其余取整。 */
function secondsLabel(ms: number): string {
  const seconds = ms / 1000
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`
}

/** 速率徽标文案；无可靠速率返回 null（不渲染）。 */
export function tokenSpeedLabelOf(status: {
  phase: 'decoding' | 'tools' | 'settled'
  tps?: number
  outputTokens: number
  decodeMs: number
  source: string
  ttftMs?: number
  windowMs: number
}): SpeedLabel | null {
  const tps = status.tps
  if (typeof tps !== 'number' || !Number.isFinite(tps) || tps <= 0) return null
  const tokens = Math.max(1, Math.round(status.outputTokens))
  const source = sourceLabel(status.source)
  const ttft =
    typeof status.ttftMs === 'number' && Number.isFinite(status.ttftMs) && status.ttftMs >= 0
      ? `；首字延迟 ${Math.round(status.ttftMs)}ms（起点为插件首次观测，非请求精确起点）`
      : ''
  if (status.phase === 'settled') {
    return {
      text: `≈${tps.toFixed(1)} tok/s`,
      title: `最近回合解码 ≈${tps.toFixed(1)} tok/s（对账 ${tokens} tok / 观测解码净耗时 ${secondsLabel(status.decodeMs)}，口径 ${source}；时间为节流帧观测近似，非服务器精确解码时间；不含首字延迟与工具执行${ttft}）`,
    }
  }
  const windowSeconds = status.windowMs / 1000
  return {
    text: `≈${tps.toFixed(1)} tok/s`,
    title: `实时解码 ≈${tps.toFixed(1)} tok/s（${windowSeconds.toFixed(windowSeconds < 10 ? 1 : 0)}s 滑动窗口流式观测速率，口径 ${source}；时间为节流帧观测近似，非服务器精确解码时间；不含首字延迟与工具执行；已生成 ${tokens} tok / 观测解码 ${secondsLabel(status.decodeMs)}${ttft}）`,
  }
}
