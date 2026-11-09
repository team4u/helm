/**
 * @json-render 声明式渲染入口（单入口）：
 * - 双形态 Spec 归一化（spec-normalize）；
 * - 响应式 $docs 注入（usePluginDocsMap 随 SSE plugin.doc.updated 实时重渲染）；
 * - 20 个标准原语分派（spec-primitives）；
 * - 3 个声明式动作指令：helm:action / helm:open / helm:send；
 * - 动作闭环反馈：按钮 loading 防连点 + 成功后 1.5s 原地 check 确认态
 *   （按 pendingKey 独立计时：快速重复提交/先成功后失败都不会残留旧 check）；
 * - helm:send 默认发往当前会话（target 省略 / 'current'），成功后从组件根
 *   DOM 定位自身所在的 .timeline-scroll 贴底（分屏互不影响）；
 * - 通知文案只表示请求已提交（插件 action 可能返回后台 task），不承诺业务完成；
 * - 动作失败经 store.pushNotice 显式报错（诚实性纪律：不静默降级）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ViewBoundary } from './ViewBoundary.js'
import { conversationsApi } from '../lib/api.js'
import { useHelmStore, usePluginDocsMap, usePluginSessionDocsMap } from '../lib/store-context.js'
import type { EvalScope } from './evaluator.js'
import { isDegradedNode, normalizeSpec, type NormalizedSpecNode } from './spec-normalize.js'
import { resolveSpecAction } from './spec-action.js'
import { SpecNodeList, type SpecRenderContext } from './spec-primitives.js'
import { parseArtifactUrl } from '../conversation/artifact-link.js'

export interface HelmSpecViewProps {
  pluginId?: string
  spec?: Record<string, unknown>
  docs?: string[]
  sessionDocs?: string[]
  data?: Record<string, unknown>
  conversationId?: number
}

/** 成功确认态保持时长（按钮打勾 1.5s 后回落）。 */
const SUCCEED_CONFIRM_MS = 1_500

export function HelmSpecView({ pluginId, spec, docs, sessionDocs, data, conversationId }: HelmSpecViewProps): React.JSX.Element | null {
  const store = useHelmStore()
  const docsMap = usePluginDocsMap(pluginId, docs)
  const sessionDocsMap = usePluginSessionDocsMap(pluginId, sessionDocs, conversationId)
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(new Set())
  const [succeededKeys, setSucceededKeys] = useState<ReadonlySet<string>>(new Set())
  // 同步在途集合：防止同一按钮在 setState 异步生效前连续触发同一动作（竞态）
  const inflightRef = useRef<Set<string>>(new Set())
  // 按 pendingKey 的确认态回落 timer：新一轮请求开始时清旧 timer，
  // 快速重复提交的第二次成功拿到完整 1500ms，不会被前一轮的 timer 提前清除。
  const succeedTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  // 卸载守卫：请求迟到时组件可能已卸载，不得再 scroll/toast/setState/排 timer。
  const mountedRef = useRef(true)
  // 组件根 DOM：helm:send 成功后仅滚动本组件所在的 timeline（分屏互不影响）。
  const rootRef = useRef<HTMLDivElement | null>(null)

  const clearSucceedTimer = useCallback((key: string): void => {
    const timer = succeedTimersRef.current.get(key)
    if (timer !== undefined) {
      clearTimeout(timer)
      succeedTimersRef.current.delete(key)
    }
  }, [])

  useEffect(() => {
    // React strict 模式会重挂 effect：重挂时重置守卫，清理函数只清本轮 timer。
    mountedRef.current = true
    const timers = succeedTimersRef.current
    return () => {
      mountedRef.current = false
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }, [])

  const normalized = useMemo(() => normalizeSpec(spec), [spec])

  const runAction = useCallback(
    (rawAction: unknown, scope: EvalScope, pendingKey: string) => {
      // 同步检查 + 登记：同一 pendingKey 在动作完成前只允许一次在途执行
      if (inflightRef.current.has(pendingKey)) return
      inflightRef.current.add(pendingKey)
      // 新一轮请求开始：清该 key 旧确认 timer 与旧成功态（前一轮成功残留
      // 的 check 不得在第二次执行期间继续显示）。
      clearSucceedTimer(pendingKey)
      setSucceededKeys((prev) => {
        if (!prev.has(pendingKey)) return prev
        const next = new Set(prev)
        next.delete(pendingKey)
        return next
      })
      const beginRequest = (): void => {
        setPendingKeys((prev) => new Set(prev).add(pendingKey))
      }
      const finishRequest = (): void => {
        inflightRef.current.delete(pendingKey)
        if (!mountedRef.current) return
        setPendingKeys((prev) => {
          if (!prev.has(pendingKey)) return prev
          const next = new Set(prev)
          next.delete(pendingKey)
          return next
        })
      }
      const markSucceeded = (): void => {
        if (!mountedRef.current) return
        setSucceededKeys((prev) => new Set(prev).add(pendingKey))
        const timer = setTimeout(() => {
          succeedTimersRef.current.delete(pendingKey)
          if (!mountedRef.current) return
          setSucceededKeys((prev) => {
            if (!prev.has(pendingKey)) return prev
            const next = new Set(prev)
            next.delete(pendingKey)
            return next
          })
        }, SUCCEED_CONFIRM_MS)
        succeedTimersRef.current.set(pendingKey, timer)
      }

      let resolved: ReturnType<typeof resolveSpecAction>
      try {
        resolved = resolveSpecAction(rawAction, scope, conversationId)
      } catch (error) {
        // 求值器抛错（模板非法等）同 invalid：显式通知，不挂 pending
        inflightRef.current.delete(pendingKey)
        store.pushNotice({
          type: 'notification',
          level: 'warning',
          title: '声明式动作无效',
          body: error instanceof Error ? error.message : String(error),
        })
        return
      }
      if (resolved.kind === 'invalid') {
        inflightRef.current.delete(pendingKey)
        store.pushNotice({
          type: 'notification',
          level: 'warning',
          title: '声明式动作无效',
          body: resolved.message,
        })
        return
      }

      const run = async (): Promise<void> => {
        try {
          if (resolved.kind === 'action') {
            beginRequest()
            await store.invokePluginAction(
              resolved.pluginId ?? pluginId ?? '',
              resolved.actionId,
              resolved.input,
              conversationId,
            )
            if (mountedRef.current) {
              markSucceeded()
              // 插件 action 可能返回后台 task：只承诺请求已提交，不承诺业务完成
              if (conversationId !== undefined) {
                store.pushNotice({
                  type: 'notification',
                  level: 'info',
                  title: `动作请求已提交：${resolved.actionId}`,
                  conversationId,
                })
              }
            }
            return
          }
          if (resolved.kind === 'open') {
            beginRequest()
            const artifactId = parseArtifactUrl(resolved.target)
            if (artifactId !== null) {
              store.setActiveModal({
                kind: 'artifact-preview',
                artifactId,
                ...(conversationId !== undefined ? { conversationId } : {}),
              })
            } else {
              store.openTarget(resolved.target, { split: resolved.split })
            }
            markSucceeded()
            return
          }
          // helm:send：向目标会话以人类身份提交文本（默认当前会话）
          beginRequest()
          await conversationsApi.submitInput(resolved.conversationId, {
            text: resolved.text,
            origin: 'human',
            ...(resolved.whenBusy !== undefined ? { whenBusy: resolved.whenBusy } : {}),
          })
          if (!mountedRef.current) return
          markSucceeded()
          // 当前会话：贴底滚动（仅本组件所在 timeline）+ 保留通知（历史卡片
          // 进入新回合会重建，通知是跨回合可追溯的发送凭证）。
          if (resolved.conversationId === conversationId) {
            store.pushNotice({
              type: 'notification',
              level: 'info',
              title: '已发送卡片指令',
              body: resolved.text,
              conversationId: resolved.conversationId,
            })
            const timeline = rootRef.current?.closest('.timeline-scroll')
            timeline?.scrollTo({ top: timeline.scrollHeight, behavior: 'smooth' })
          } else {
            store.pushNotice({
              type: 'notification',
              level: 'info',
              title: `已发送到会话 #${resolved.conversationId}`,
              body: resolved.text,
              conversationId: resolved.conversationId,
            })
          }
        } catch (error) {
          if (mountedRef.current) {
            store.pushNotice({
              type: 'notification',
              level: 'error',
              title:
                resolved.kind === 'action'
                  ? `动作 ${resolved.actionId} 执行失败`
                  : resolved.kind === 'send'
                    ? `发送到会话 #${resolved.conversationId} 失败`
                    : '打开目标失败',
              body: error instanceof Error ? error.message : String(error),
            })
          }
        } finally {
          finishRequest()
        }
      }
      void run()
    },
    [store, pluginId, conversationId, clearSucceedTimer],
  )

  const isPending = useCallback((key: string) => pendingKeys.has(key), [pendingKeys])
  const isSucceeded = useCallback((key: string) => succeededKeys.has(key), [succeededKeys])

  if (normalized.root === null) return null
  if (isDegradedNode(normalized.root)) {
    const reason = typeof normalized.root.props['reason'] === 'string' ? normalized.root.props['reason'] : '未知原因'
    return <div className="jr-callout jr-callout-warn">界面声明无效：{reason}</div>
  }

  const ctx: SpecRenderContext = {
    scope: { $docs: docsMap, $sessionDocs: sessionDocsMap, $data: data ?? {} },
    conversationId,
    pluginId,
    renderChildren: (children: NormalizedSpecNode[]) => <SpecNodeList nodes={children} ctx={ctx} />,
    runAction,
    isPending,
    isSucceeded,
  }

  return (
    <div ref={rootRef}>
      <ViewBoundary label="插件界面">
        <SpecNodeList nodes={[normalized.root]} ctx={ctx} />
      </ViewBoundary>
    </div>
  )
}
