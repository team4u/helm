/**
 * SSE 实时订阅、短断线续传（bootId + seq 水位与失败回退全量 snapshot）、
 * 空闲看门狗及指数退避重连状态机 hook。
 */
import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type {
  ArtifactMetadata,
  ConversationDetail,
  ConversationSummary,
  HelmEvent,
  HelmEventFrame,
  HelmResumedFrame,
  HelmSnapshot,
  HelmTransientLiveFrame,
  PluginSummary,
} from '@helm/protocol/browser'
import { getStoredToken } from './api.js'
import { errorText } from './format.js'
import {
  applyEventFrame,
  applyResumedFrame,
  applySnapshot,
  applyTransientLiveFrame,
  readSseChunkWithDeadline,
  SseParser,
  sseClientTimings,
  type LiveState,
} from './live-state.js'
import { evictPluginClientCache, reconcilePluginClientCache } from './plugin-client.js'
import { evictSessionDocsOfConversation, evictSessionDocSubscriptions } from './session-docs.js'
import { deletedConversationFallbackTarget } from './space-navigation.js'
import type { ActiveModal, ResolvedTarget, ToastNotice } from './types.js'
import type { ArtifactsSyncWatermark } from './use-unread-sync.js'

export interface SseCursor {
  bootId: string
  seq: number
}

export interface UseSseEventsOptions {
  authenticated: boolean
  session: MutableRefObject<number>
  sseCursorRef: MutableRefObject<SseCursor | null>
  liveRef: MutableRefObject<LiveState>
  requests: MutableRefObject<Map<string, Promise<unknown>>>
  failedDocs: MutableRefObject<Set<string>>
  unreadClearInFlight: MutableRefObject<Set<number>>
  unreadClearedSeq: MutableRefObject<Map<number, number>>
  pluginEpoch: MutableRefObject<Map<string, number>>
  targets: MutableRefObject<{ primaryTarget: ResolvedTarget; splitTarget: ResolvedTarget | null }>
  activeModalRef: MutableRefObject<ActiveModal>
  pendingHistoryMode: MutableRefObject<'push' | 'replace' | null>
  logout: () => void
  setSseConnected: Dispatch<SetStateAction<boolean>>
  setConnectionError: Dispatch<SetStateAction<string | null>>
  setLoadErrors: Dispatch<SetStateAction<Record<string, string>>>
  updateLive: (update: (state: LiveState) => LiveState) => void
  setKernelBootId: Dispatch<SetStateAction<string | null>>
  setConversationArtifacts: Dispatch<SetStateAction<Record<number, ArtifactMetadata[]>>>
  conversationArtifactsRef?: MutableRefObject<Record<number, ArtifactMetadata[]>>
  artifactsWatermarksRef?: MutableRefObject<Map<number, ArtifactsSyncWatermark>>
  visibleConversationIds: () => number[]
  loadConversationDetail: (
    id: number,
    force?: boolean,
    opts?: { silent?: boolean; limit?: number },
  ) => Promise<ConversationDetail | undefined>
  loadConversationArtifacts: (id: number, opts?: { silent?: boolean }) => Promise<ArtifactMetadata[] | undefined>
  abortInFlightConversationRequests?: () => void
  clearVisibleConversationUnread: (id: number, candidate?: ConversationSummary) => void
  pushNotice: (notice: Omit<ToastNotice, 'id' | 'createdAt'>) => void
  refreshAssets: () => Promise<void>
  applyPrimaryTarget: (target: ResolvedTarget) => void
  setSplitTarget: Dispatch<SetStateAction<ResolvedTarget | null>>
  setActiveModal: Dispatch<SetStateAction<ActiveModal>>
}

interface StreamSessionState {
  mode: 'fresh' | 'resumed' | null
  resumedHeadSeq: number
  liveAnnounced: boolean
}

interface FrameHandlerContext extends UseSseEventsOptions {
  streamState: StreamSessionState
  announceLive: () => void
  resetRetry: () => void
}

function buildSseEventsUrl(cursor: SseCursor | null): string {
  return cursor !== null
    ? `/api/events?afterSeq=${cursor.seq}&bootId=${encodeURIComponent(cursor.bootId)}`
    : '/api/events'
}

function computeReconnectBackoffMs(retry: number): number {
  return (
    Math.min(sseClientTimings.reconnectBaseMs * 2 ** retry, sseClientTimings.reconnectCapMs) +
    Math.random() * sseClientTimings.reconnectJitterMs
  )
}

const isPluginSummaryActive = (plugin: PluginSummary): boolean =>
  plugin.enabled && (plugin.status === undefined || plugin.status === 'active')

function sameClientHashes(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  return keysA.every((key) => Object.hasOwn(b, key) && b[key] === a[key])
}

function handleSnapshotFrame(payload: unknown, ctx: FrameHandlerContext): void {
  if (ctx.streamState.mode !== null) throw new Error('Live connection received a duplicate snapshot control frame')
  const snap = payload as HelmSnapshot
  if (snap === null || typeof snap !== 'object' || typeof snap.bootId !== 'string' || snap.bootId === '') {
    throw new Error('Invalid kernel live snapshot format (no valid bootId)')
  }
  const prevPlugins = ctx.liveRef.current.plugins
  const prevDetails = ctx.liveRef.current.conversationDetails
  const prevConversationIds = new Set(ctx.liveRef.current.conversations.map((c) => c.id))
  const nextConversationIds = new Set(snap.conversations.map((c) => c.id))

  ctx.streamState.mode = 'fresh'
  ctx.session.current++
  ctx.abortInFlightConversationRequests?.()
  ctx.requests.current.clear()
  ctx.failedDocs.current.clear()
  ctx.unreadClearInFlight.current.clear()
  ctx.unreadClearedSeq.current.clear()

  // 断线期间增量对账插件客户端缓存：保留启用且 hash 未变的模块与样式，仅逐出变更/停用项。
  reconcilePluginClientCache(snap.plugins)

  const nextPluginById = new Map(snap.plugins.map((p) => [p.id, p]))
  const stalePluginIds = new Set<string>()
  for (const prevPlugin of prevPlugins) {
    const nextPlugin = nextPluginById.get(prevPlugin.id)
    if (
      nextPlugin === undefined ||
      !isPluginSummaryActive(nextPlugin) ||
      !sameClientHashes(prevPlugin.clientHashes, nextPlugin.clientHashes) ||
      (!isPluginSummaryActive(prevPlugin) && isPluginSummaryActive(nextPlugin))
    ) {
      stalePluginIds.add(prevPlugin.id)
    }
    if (nextPlugin === undefined || !nextPlugin.enabled) {
      evictSessionDocSubscriptions(prevPlugin.id)
    }
  }
  for (const nextPlugin of snap.plugins) {
    if (!isPluginSummaryActive(nextPlugin)) stalePluginIds.add(nextPlugin.id)
    if (!nextPlugin.enabled) evictSessionDocSubscriptions(nextPlugin.id)
  }
  for (const prevId of prevConversationIds) {
    if (!nextConversationIds.has(prevId)) {
      evictSessionDocsOfConversation(prevId)
      ctx.artifactsWatermarksRef?.current.delete(prevId)
    }
  }

  // loadErrors 仅清理已被停用/移除/hash 变更插件的旧 doc 错误以及已删除会话的错误。
  ctx.setLoadErrors((prev) => {
    let changed = false
    const next: Record<string, string> = {}
    for (const [key, value] of Object.entries(prev)) {
      if (key.startsWith('doc:')) {
        const slash = key.indexOf('/')
        const pluginId = slash > 4 ? key.slice(4, slash) : ''
        if (stalePluginIds.has(pluginId)) {
          changed = true
          continue
        }
      } else if (
        key.startsWith('conversation:') ||
        key.startsWith('history:') ||
        key.startsWith('artifacts:')
      ) {
        const convId = Number(key.slice(key.indexOf(':') + 1))
        if (Number.isInteger(convId) && !nextConversationIds.has(convId)) {
          changed = true
          continue
        }
      }
      next[key] = value
    }
    return changed ? next : prev
  })

  ctx.updateLive((state) => applySnapshot(state, snap))
  ctx.sseCursorRef.current = { bootId: snap.bootId, seq: snap.seq }
  ctx.setKernelBootId(snap.bootId)

  // SWR 保活：保留仍存在会话的产物缓存，仅清理已删除会话。
  ctx.setConversationArtifacts((prev) => {
    let changed = false
    const next: Record<number, ArtifactMetadata[]> = {}
    for (const [k, list] of Object.entries(prev)) {
      const numId = Number(k)
      if (nextConversationIds.has(numId)) next[numId] = list
      else changed = true
    }
    return changed ? next : prev
  })

  ctx.resetRetry()
  ctx.announceLive()
  for (const id of ctx.visibleConversationIds()) {
    const prevDetail = prevDetails[id]
    const nextSummary = snap.conversations.find((c) => c.id === id)
    const unchanged =
      prevDetail !== undefined &&
      nextSummary !== undefined &&
      nextSummary.status !== 'working' &&
      prevDetail.stateChangeSeq === nextSummary.stateChangeSeq &&
      prevDetail.lastEntryId !== undefined &&
      nextSummary.lastEntryId !== undefined &&
      prevDetail.lastEntryId === nextSummary.lastEntryId
    if (!unchanged) {
      const silent = prevDetail !== undefined
      void ctx.loadConversationDetail(id, true, silent ? { silent: true } : undefined)
      void ctx.loadConversationArtifacts(id, silent ? { silent: true } : undefined)
    } else if (ctx.conversationArtifactsRef !== undefined && ctx.conversationArtifactsRef.current[id] === undefined) {
      void ctx.loadConversationArtifacts(id, { silent: true })
    } else if (ctx.artifactsWatermarksRef !== undefined && !ctx.artifactsWatermarksRef.current.has(id)) {
      ctx.artifactsWatermarksRef.current.set(id, {
        stateChangeSeq: nextSummary.stateChangeSeq,
        lastEntryId: nextSummary.lastEntryId,
      })
    }
    ctx.clearVisibleConversationUnread(id)
  }
}

function handleResumedFrame(payload: unknown, ctx: FrameHandlerContext): void {
  if (ctx.streamState.mode !== null) throw new Error('Live connection received a duplicate resumed control frame')
  const resumed = payload as HelmResumedFrame
  const current = ctx.sseCursorRef.current
  if (
    current === null ||
    resumed === null ||
    typeof resumed !== 'object' ||
    typeof resumed.bootId !== 'string' ||
    resumed.bootId !== current.bootId ||
    resumed.seq !== current.seq ||
    !Number.isSafeInteger(resumed.headSeq) ||
    resumed.headSeq < current.seq
  ) {
    throw new Error('Live connection resume handshake mismatch; full re-sync in progress')
  }
  ctx.streamState.mode = 'resumed'
  ctx.streamState.resumedHeadSeq = resumed.headSeq
  ctx.updateLive((state) => applyResumedFrame(state, resumed))
  ctx.resetRetry()
  // 不清详情/产物/插件缓存：续传补发未丢失任何状态；只有实际追平 headSeq
  // 才宣称 live（零补发时立即 live），重放中不显示「新鲜」。
  if (ctx.liveRef.current.seq >= ctx.streamState.resumedHeadSeq) ctx.announceLive()
}

function handleTransientLiveFrame(payload: unknown, ctx: FrameHandlerContext): void {
  if (ctx.streamState.mode === null) throw new Error('Live connection missing the initial snapshot')
  ctx.updateLive((state) => applyTransientLiveFrame(state, payload as HelmTransientLiveFrame))
}

function dispatchFrameSideEffects(
  event: HelmEvent,
  deletedConversationId: number | undefined,
  deletedSummary: ConversationSummary | undefined,
  ctx: FrameHandlerContext,
): void {
  if (event.type === 'notification' && 'title' in event) ctx.pushNotice(event)
  if (event.type === 'plugin.changed' && 'plugin' in event) {
    ctx.pluginEpoch.current.set(event.plugin.id, (ctx.pluginEpoch.current.get(event.plugin.id) ?? 0) + 1)
    for (const key of ctx.requests.current.keys()) {
      if (key.startsWith(`doc:${event.plugin.id}/`)) ctx.requests.current.delete(key)
    }
    ctx.failedDocs.current.clear()
    // 任意 plugin.changed（含 enabled=true 的热重载/升级）都让该插件 client 模块
    // 缓存失效：loader 只在缓存代变化后才重新拉取比对 contentHash，只处理停用
    // 会让启用态重载后无限残留旧 UI 代码（续传不 reset 全局缓存时更是如此）。
    evictPluginClientCache(event.plugin.id)
    // 插件停用/卸载（ui 贡献移除）时同步释放全部会话文档订阅
    if (!event.plugin.enabled) {
      evictSessionDocSubscriptions(event.plugin.id)
    }
    void ctx.refreshAssets()
  }
  if (event.type === 'models.changed') void ctx.refreshAssets()
  if (event.type === 'conversation.upsert' && 'conversation' in event) {
    const conv = event.conversation
    if (!conv.unread) ctx.unreadClearedSeq.current.delete(conv.id)
    const visible = ctx.visibleConversationIds().includes(conv.id)
    if (visible && conv.status !== 'working') void ctx.loadConversationArtifacts(conv.id)
    if (visible && conv.unread) ctx.clearVisibleConversationUnread(conv.id, conv)
  }
  if (deletedConversationId !== undefined) {
    ctx.unreadClearInFlight.current.delete(deletedConversationId)
    ctx.unreadClearedSeq.current.delete(deletedConversationId)
    // 删除导航唯一 truths：仅当被删的正是当前主屏/分屏/抽屉目标时，
    // 以 replace 回到该智能体待命态（无 Profile 信息时显式回角色中心）；
    // 绝不选中其他会话，批量连续删除不闪烁，用户已切走时不覆盖新导航。
    const fallback = deletedConversationFallbackTarget(deletedSummary)
    const primaryHit =
      ctx.targets.current.primaryTarget.kind === 'conversation' &&
      ctx.targets.current.primaryTarget.conversationId === deletedConversationId
    const splitHit =
      ctx.targets.current.splitTarget?.kind === 'conversation' &&
      ctx.targets.current.splitTarget.conversationId === deletedConversationId
    const drawerHit =
      ctx.activeModalRef.current?.kind === 'conversation-drawer' &&
      ctx.activeModalRef.current.conversationId === deletedConversationId
    if (primaryHit || splitHit || drawerHit) ctx.pendingHistoryMode.current = 'replace'
    if (primaryHit) ctx.applyPrimaryTarget(fallback)
    if (splitHit) ctx.setSplitTarget(null)
    if (drawerHit) ctx.setActiveModal(null)
    ctx.setConversationArtifacts((prev) => {
      const next = { ...prev }
      delete next[deletedConversationId]
      return next
    })
    evictSessionDocsOfConversation(deletedConversationId)
  }
}

function handleEventFrame(payload: unknown, ctx: FrameHandlerContext): void {
  if (ctx.streamState.mode === null) throw new Error('Live connection missing the initial snapshot')
  const frame = payload as HelmEventFrame
  if (frame === null || typeof frame !== 'object' || frame.event === null || typeof frame.event !== 'object' || typeof frame.event.type !== 'string') {
    throw new Error('Invalid live event frame format (missing event)')
  }
  const oldSeq = ctx.liveRef.current.seq
  // 删除事件先快照被删会话摘要（applyEventFrame 后列表即移除）：待命目标需
  // 继承其 profileId/nodeId/cwd，防止远端坐标悄悄回落本机。
  const deletedEvent = frame.event.type === 'conversation.deleted' && 'conversationId' in frame.event ? frame.event : undefined
  const deletedSummary = deletedEvent !== undefined
    ? ctx.liveRef.current.conversations.find((c) => c.id === deletedEvent.conversationId)
    : undefined
  ctx.updateLive((state) => applyEventFrame(state, frame))
  // 按帧实际应用推进续传水位（应用失败已在边界作废凭据，绝不提前推进）。
  const applied = ctx.sseCursorRef.current
  if (applied !== null && ctx.liveRef.current.seq > applied.seq) {
    ctx.sseCursorRef.current = { bootId: applied.bootId, seq: ctx.liveRef.current.seq }
  }
  if (ctx.streamState.mode === 'resumed' && ctx.liveRef.current.seq >= ctx.streamState.resumedHeadSeq) {
    ctx.announceLive()
  }
  if (frame.seq <= oldSeq) return
  dispatchFrameSideEffects(frame.event, deletedEvent?.conversationId, deletedSummary, ctx)
}

export function useSseEvents(options: UseSseEventsOptions): void {
  const {
    authenticated,
    session,
    sseCursorRef,
    liveRef,
    requests,
    failedDocs,
    unreadClearInFlight,
    unreadClearedSeq,
    pluginEpoch,
    targets,
    activeModalRef,
    pendingHistoryMode,
    logout,
    setSseConnected,
    setConnectionError,
    setLoadErrors,
    updateLive,
    setKernelBootId,
    setConversationArtifacts,
    visibleConversationIds,
    loadConversationDetail,
    loadConversationArtifacts,
    abortInFlightConversationRequests,
    clearVisibleConversationUnread,
    pushNotice,
    refreshAssets,
    applyPrimaryTarget,
    setSplitTarget,
    setActiveModal,
  } = options

  useEffect(() => {
    if (!authenticated) return
    let active = true
    let retry = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    let connecting = false
    let immediateReconnect = false
    let lastDataAt = 0

    const connect = async (): Promise<void> => {
      connecting = true
      lastDataAt = Date.now()
      controller = new AbortController()
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        const token = getStoredToken()
        // 短断线续传：携带上一条连接实际应用到的水位（双凭据缺一不可）；
        // 校验不过时内核改发 snapshot 全量对齐，客户端无需预判。
        const cursor = sseCursorRef.current
        const eventsUrl = buildSseEventsUrl(cursor)
        const response = await fetch(eventsUrl, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
        })
        if (response.status === 401) {
          logout()
          return
        }
        if (cursor !== null && response.status === 400) {
          // 续传凭据被判非法：作废凭据（本次即失败重连，下次全量），绝不带坏凭据死循环。
          sseCursorRef.current = null
          throw new Error('Live resume request rejected by the kernel (HTTP 400); falling back to full re-sync')
        }
        if (!response.ok || !response.body) throw new Error(`Live connection failed (HTTP ${response.status})`)

        /** null=待首帧控制帧；fresh=全量已就绪；resumed=补发中（追平 headSeq 才 live）。 */
        const streamState: StreamSessionState = { mode: null, resumedHeadSeq: 0, liveAnnounced: false }
        const announceLive = (): void => {
          if (streamState.liveAnnounced) return
          streamState.liveAnnounced = true
          setSseConnected(true)
          setConnectionError(null)
        }
        const ctx: FrameHandlerContext = {
          authenticated,
          session,
          sseCursorRef,
          liveRef,
          requests,
          failedDocs,
          unreadClearInFlight,
          unreadClearedSeq,
          pluginEpoch,
          targets,
          activeModalRef,
          pendingHistoryMode,
          logout,
          setSseConnected,
          setConnectionError,
          setLoadErrors,
          updateLive,
          setKernelBootId,
          setConversationArtifacts,
          visibleConversationIds,
          loadConversationDetail,
          loadConversationArtifacts,
          abortInFlightConversationRequests,
          clearVisibleConversationUnread,
          pushNotice,
          refreshAssets,
          applyPrimaryTarget,
          setSplitTarget,
          setActiveModal,
          streamState,
          announceLive,
          resetRetry: () => { retry = 0 },
        }

        const parser = new SseParser((message) => {
          // 消息处理边界：任何协议错误（无效 JSON / 空或畸形控制帧 / 缺 event 增量 /
          // 快照或帧应用失败 / 握手不匹配 / 重复控制帧）都在此作废续传凭据后重抛
          // 断开本连接，下次强制全量——绝不带着可能错位的水位重试坏状态；网络层
          // 异常（空闲超时/流断开）不经过此边界，完好凭据仍可短断线续传。
          try {
            const payload: unknown = JSON.parse(message.data)
            if (message.event === 'snapshot') handleSnapshotFrame(payload, ctx)
            else if (message.event === 'resumed') handleResumedFrame(payload, ctx)
            else if (message.event === 'conversation.live') handleTransientLiveFrame(payload, ctx)
            else handleEventFrame(payload, ctx)
          } catch (error) {
            // 协议边界统一作废续传凭据（见边界注释）后重抛：本次连接按失败重连，
            // 下次必须全量快照，绝不携带可能错位的水位重试。
            sseCursorRef.current = null
            throw error
          }
        })

        lastDataAt = Date.now()
        reader = response.body.getReader()
        const decoder = new TextDecoder()
        while (active) {
          const read = await readSseChunkWithDeadline(reader, sseClientTimings.idleTimeoutMs, controller.signal)
          if (read.kind === 'idle') {
            // 连接卡死（如 dev 代理保留的挂起流，reader.read() 永不返回）：
            // 抛错走统一 catch（提示 + abort 解开挂起读取）与 finally 重连；
            // 重连 fetch 拿 401 即登出。正常连接持续收到字节（含心跳注释）不会触发。
            throw new Error('Live connection idle timeout; reconnecting')
          }
          if (read.chunk.done) break
          lastDataAt = Date.now()
          if (!active) return
          parser.push(decoder.decode(read.chunk.value, { stream: true }))
        }
        if (active) throw new Error('Live connection lost; re-syncing')
      } catch (error) {
        if (active && !controller.signal.aborted) setConnectionError(errorText(error))
        // 出错连接一律主动中止：解开空闲超时下可能挂起的 reader.read()
        //（其余路径连接本已坏，abort 幂等无害），finally 统一进入重连。
        controller.abort()
      } finally {
        if (reader) {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
        connecting = false
        controller = undefined
        if (active) {
          setSseConnected(false)
          if (immediateReconnect) {
            immediateReconnect = false
            retry = 0
            void connect()
          } else {
            // 指数退避 + 随机抖动：内核重启等同时断线场景避免同步重连风暴。
            const backoff = computeReconnectBackoffMs(retry)
            retry += 1
            timer = setTimeout(() => {
              timer = undefined
              void connect()
            }, backoff)
          }
        }
      }
    }

    const wakeup = (): void => {
      if (!active || immediateReconnect) return
      // 1. 断线重连退避等待中：立即取消退避定时器并发起无延迟重连
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
        retry = 0
        void connect()
        return
      }
      // 2. 活跃连接疑似半开陈旧（长时间未收任何字节/心跳）：中止当前连接立即重连；健康流不误杀
      if (connecting && controller !== undefined) {
        if (Date.now() - lastDataAt >= sseClientTimings.staleWakeupMs) {
          immediateReconnect = true
          controller.abort()
        }
        return
      }
      // 3. 无定时器且无在途连接：立即重连
      retry = 0
      void connect()
    }

    const onOnline = (): void => {
      wakeup()
    }
    const onVisibilityChange = (): void => {
      if (typeof document === 'undefined' || !document.hidden) wakeup()
    }

    if (typeof window !== 'undefined') window.addEventListener('online', onOnline)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange)

    void connect()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange)
      controller?.abort()
    }
  }, [
    authenticated,
    logout,
    loadConversationDetail,
    loadConversationArtifacts,
    abortInFlightConversationRequests,
    visibleConversationIds,
    clearVisibleConversationUnread,
    pushNotice,
    refreshAssets,
    updateLive,
    applyPrimaryTarget,
    activeModalRef,
    failedDocs,
    liveRef,
    pendingHistoryMode,
    pluginEpoch,
    requests,
    session,
    setActiveModal,
    setConnectionError,
    setConversationArtifacts,
    setKernelBootId,
    setLoadErrors,
    setSplitTarget,
    setSseConnected,
    sseCursorRef,
    targets,
    unreadClearInFlight,
    unreadClearedSeq,
  ])
}
