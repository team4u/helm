/**
 * builtin:token-speed：实时解码速率（tok/s）只读状态插件（默认停用，可选启用）。
 *
 * 职责边界（机制与策略分离）：
 * - 内核只透传 ConversationLive.generation 通用流式事实（attempt + 受限
 *   message 投影），零速率计算；本插件消费这些事实自行推导全部策略：
 *   时间滑动窗口速率、chars/4 估算、TTFT（起点=首次观测，不伪造）、
 *   burst/stall 平滑、provider usage 终值对账、工具执行时间剔除（见
 *   tracker.ts）；停用本插件不产生任何额外内核计算或持久写放大；
 * - 高频会话级状态只进 public sessionDoc（专用 SSE 按需订阅，写入按
 *   250ms 节流；首测 / 阶段变化 / 终态立即写），绝不进全局 ctx.doc 或
 *   conversation summary；
 * - 展示经 ctx.ui.slot 注入 COMPOSER_STATUS_SLOT（宿主输入区状态行），
 *   停用即随 UI 贡献一起消失，无幻影提示词；无动作 / 无工具 / 无 CLI
 *   （纯只读展示，不触发五端映射义务）。
 *
 * 事件时序事实（内核观察链路，跨同提交折叠稳定）：
 * - conversation.entry（pi.assistant 最终 usage）先于同提交的 conversation.live
 *   帧到达——终值进待对账队列，段关闭时 FIFO 消费；
 * - pi-durable 每个工具轮 handOver 换 generation 任务，回合内每个模型请求
 *   各结算一次 turn_settled：payload.conversation.status 仍为 working 表示
 *   链延续（继续累计）；非 working 为链终点（终态发布 + 下一 generation 帧
 *   重置链）。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMPOSER_STATUS_SLOT, HelmError, type PluginDefinition } from '@helm/protocol'
import {
  DEFAULT_SLIDING_WINDOW_MS,
  DOC_WRITE_INTERVAL_MS,
  MAX_SLIDING_WINDOW_MS,
  MIN_SLIDING_WINDOW_MS,
  TOKEN_SPEED_DOC,
  TOKEN_SPEED_PLUGIN_ID,
  asAssistantUsageOutput,
  asConversationDeletedId,
  asConversationLiveFrame,
  type TokenSpeedStatus,
} from './token-speed/contracts.js'
import { ConversationTokenSpeedTracker } from './token-speed/tracker.js'

export { TOKEN_SPEED_PLUGIN_ID }

/** clientRoot 兼容 src / dist 运行路径（与 memory / magpie 插件同机制）。 */
function resolveTokenSpeedClientRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const local = join(here, 'token-speed', 'client')
  if (existsSync(local)) return local
  const pkgRoot = dirname(here)
  const srcFallback = join(pkgRoot, 'src', 'token-speed', 'client')
  if (existsSync(srcFallback)) return srcFallback
  throw new HelmError(
    'token_speed_plugin_client_missing',
    `内置插件 ${TOKEN_SPEED_PLUGIN_ID} 找不到 client 组件目录（期望 ${local} 或 ${srcFallback}）`,
    500,
  )
}

export function createTokenSpeedPlugin(): PluginDefinition {
  return {
    id: TOKEN_SPEED_PLUGIN_ID,
    name: 'Token 速率',
    description:
      '输入区状态行的实时解码速率（tok/s）：滑动窗口速率、首字延迟与终态对账；策略可选启用，内核零计算。',
    icon: 'gauge',
    version: '0.1.0',
    clientRoot: resolveTokenSpeedClientRoot(),
    definePlugin(rawCtx) {
      const ctx = rawCtx

      ctx.configSchema({
        slidingWindowMs: {
          type: 'number',
          label: '滑动窗口（毫秒）',
          description: '实时速率的时间窗口；慢服务器建议 3000-15000（对齐 pi-token-speed 指引）',
          default: DEFAULT_SLIDING_WINDOW_MS,
          minimum: MIN_SLIDING_WINDOW_MS,
          maximum: MAX_SLIDING_WINDOW_MS,
          integer: true,
        },
      })

      const speedDoc = ctx.sessionDoc<TokenSpeedStatus | null>(TOKEN_SPEED_DOC, null, { public: true })

      /** 会话 -> 速率状态机（链粒度创建；配置变化从下一回合生效）。 */
      const trackers = new Map<number, ConversationTokenSpeedTracker>()
      /** 会话 -> 上次 sessionDoc 写入时间（节流）。 */
      const lastWriteAt = new Map<number, number>()
      /** 链已终结的会话：下一个 generation 帧重置链（新回合从零累计）。 */
      const settledChains = new Set<number>()

      const windowMsOf = (): number => {
        const raw = (ctx.getConfig() as { slidingWindowMs?: unknown }).slidingWindowMs
        if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_SLIDING_WINDOW_MS
        return Math.min(MAX_SLIDING_WINDOW_MS, Math.max(MIN_SLIDING_WINDOW_MS, Math.round(raw)))
      }

      const trackerOf = (conversationId: number): ConversationTokenSpeedTracker => {
        let tracker = trackers.get(conversationId)
        if (tracker === undefined) {
          tracker = new ConversationTokenSpeedTracker({
            windowMs: windowMsOf(),
            minSpanMs: MIN_SLIDING_WINDOW_MS,
          })
          trackers.set(conversationId, tracker)
        }
        return tracker
      }

      /** 写 sessionDoc（节流；force 用于首测 / 阶段变化 / 终态 / 清理）。 */
      const publish = (conversationId: number, status: TokenSpeedStatus | null, force: boolean, now: number): void => {
        const previous = speedDoc.get(conversationId)
        if (!force) {
          if (status !== null && previous?.phase === status.phase) {
            const last = lastWriteAt.get(conversationId) ?? 0
            if (now - last < DOC_WRITE_INTERVAL_MS) return
          }
        }
        lastWriteAt.set(conversationId, now)
        speedDoc.set(conversationId, status)
      }

      const nowOf = (fallback: number): number =>
        Number.isFinite(fallback) && fallback > 0 ? fallback : Date.now()

      // 实时帧：驱动状态机并发布节流文档。
      ctx.host.onEvent('conversation.live', (raw) => {
        const frame = asConversationLiveFrame(raw)
        if (frame === undefined) return
        const now = nowOf(frame.updatedAt)
        if (settledChains.has(frame.conversationId)) {
          if (frame.generation === undefined) return
          // 新回合开始：链重置（上一回合终态值保留在文档中直到本回合首测）。
          settledChains.delete(frame.conversationId)
          trackers.get(frame.conversationId)?.resetChain()
        }
        const tracker = trackerOf(frame.conversationId)
        tracker.observeFrame(now, frame)
        const status = tracker.liveStatus(now)
        if (status === undefined) return
        const previous = speedDoc.get(frame.conversationId)
        const force = previous === null || previous.phase !== status.phase
        publish(frame.conversationId, status, force, now)
      })

      // 最终 usage 对账：pi.assistant entry 先于同提交 live 帧到达。
      ctx.host.onEvent('conversation.entry', (raw) => {
        const entry = asAssistantUsageOutput(raw)
        if (entry === undefined) return
        trackers.get(entry.conversationId)?.noteAssistantUsage(entry.usageOutput)
      })

      // 回合结算：working = 工具轮 handOver 的中间结算（链继续）；其余为链
      // 终点——发布终态并等待下一 generation 帧重置链。
      ctx.hook.onTurnSettled((payload) => {
        const conversationId = payload.conversation.id
        if (payload.conversation.status === 'working') return
        const tracker = trackers.get(conversationId)
        settledChains.add(conversationId)
        if (tracker === undefined) return
        const now = Date.now()
        const status = tracker.settle(now)
        publish(conversationId, status ?? null, true, now)
      })

      // 会话删除：状态机与节流指纹彻底清理；文档删除在会话行已消失时按
      // not_found 拒绝（三元组存在性断言），仅此错误 tolerated——会话 id 单调
      // 不复用，持久残留不可达，随插件卸载 purgePlugin 一并清理；其余错误如实上抛。
      ctx.host.onEvent('conversation.deleted', (raw) => {
        const conversationId = asConversationDeletedId(raw)
        if (conversationId === undefined) return
        trackers.delete(conversationId)
        lastWriteAt.delete(conversationId)
        settledChains.delete(conversationId)
        try {
          speedDoc.delete(conversationId)
        } catch (error) {
          if (!(error instanceof HelmError && error.status === 404)) throw error
        }
      })

      // ---- 声明式 UI：宿主输入区状态行插槽（只读速率文本） ------------------
      ctx.ui.slot({
        id: 'token-speed-status',
        target: COMPOSER_STATUS_SLOT,
        order: 10,
        client: { module: 'index.tsx', export: 'TokenSpeedStatusBadge' },
      })
    },
  }
}
