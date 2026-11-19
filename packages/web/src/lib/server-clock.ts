/**
 * 浏览器↔Hub 时钟偏差估计。
 *
 * Why：时间线「运行中」秒表（RunningElapsed）用浏览器 Date.now() 减服务端 epoch 起点
 * （assistant.timestamp+durationMs）。两端时钟差几秒时秒表整体偏移几秒，落定时再跳回
 * 服务端实测 durationMs。这里用 ConversationLive.updatedAt（Hub 广播时的 Date.now()）
 * 做样本估计偏差：offset 样本 = 本地时刻 − updatedAt，单向网络延迟只会让样本偏大，
 * 取滑窗最小值即从上方逼近真实偏差，永不低估（除非 Hub 时钟回拨，此时新样本立即胜出）。
 */

/** 样本滑窗大小：活跃回合每秒多帧，32 帧内收敛；时钟中途被 NTP 校正后随窗口轮换自愈。 */
const SAMPLE_WINDOW = 32

export interface ServerClock {
  /** 记录一个服务端 epoch 样本（非法值直接忽略，绝不参与估计）。 */
  observeServerEpoch(epochMs: number): void
  /** 当前最佳偏差估计（本地时刻 − 服务端时刻）；无样本时为 0（等价旧行为）。 */
  offsetMs(): number
  /** 服务端时钟域下的「现在」。 */
  now(): number
}

/** 纯工厂：注入时钟便于测试；窗口有界，样本永不跨实例泄漏。 */
export function createServerClock(nowMs: () => number = Date.now): ServerClock {
  const samples: number[] = []
  return {
    observeServerEpoch(epochMs: number): void {
      if (!Number.isFinite(epochMs) || epochMs <= 0) return
      samples.push(nowMs() - epochMs)
      if (samples.length > SAMPLE_WINDOW) samples.splice(0, samples.length - SAMPLE_WINDOW)
    },
    offsetMs(): number {
      return samples.length > 0 ? Math.min(...samples) : 0
    },
    now(): number {
      return nowMs() - this.offsetMs()
    },
  }
}

/** 应用级单例：SSE 层采样（use-sse-events），秒表读取。 */
const serverClock = createServerClock()

export function observeServerEpoch(epochMs: number): void {
  serverClock.observeServerEpoch(epochMs)
}

export function serverClockOffsetMs(): number {
  return serverClock.offsetMs()
}

export function serverNow(): number {
  return serverClock.now()
}
