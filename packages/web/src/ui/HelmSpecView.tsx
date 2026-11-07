/**
 * @json-render 声明式渲染入口（单入口）：
 * - 双形态 Spec 归一化（spec-normalize）；
 * - 响应式 $docs 注入（usePluginDocsMap 随 SSE plugin.doc.updated 实时重渲染）；
 * - 20 个标准原语分派（spec-primitives）；
 * - 3 个声明式动作指令：helm:action / helm:open / helm:send；
 * - 动作失败经 store.pushNotice 显式报错（诚实性纪律：不静默降级）。
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ViewBoundary } from './ViewBoundary.js'
import { conversationsApi } from '../lib/api.js'
import { useHelmStore, usePluginDocsMap } from '../lib/store-context.js'
import type { EvalScope } from './evaluator.js'
import { isDegradedNode, normalizeSpec, type NormalizedSpecNode } from './spec-normalize.js'
import { resolveSpecAction } from './spec-action.js'
import { SpecNodeList, type SpecRenderContext } from './spec-primitives.js'

export interface HelmSpecViewProps {
  pluginId?: string
  spec?: Record<string, unknown>
  docs?: string[]
  data?: Record<string, unknown>
  conversationId?: number
}

export function HelmSpecView({ pluginId, spec, docs, data, conversationId }: HelmSpecViewProps): React.JSX.Element | null {
  const store = useHelmStore()
  const docsMap = usePluginDocsMap(pluginId, docs)
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set())
  // 同步在途集合：防止同一按钮在 setState 异步生效前连续触发同一动作（竞态）
  const inflightRef = useRef<Set<string>>(new Set())

  const normalized = useMemo(() => normalizeSpec(spec), [spec])

  const runAction = useCallback(
    (rawAction: unknown, scope: EvalScope, pendingKey: string) => {
      // 同步检查 + 登记：同一 pendingKey 在动作完成前只允许一次在途执行
      if (inflightRef.current.has(pendingKey)) return
      inflightRef.current.add(pendingKey)
      const resolved = resolveSpecAction(rawAction, scope)
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
      setPendingKeys((prev) => new Set(prev).add(pendingKey))
      const done = () => {
        inflightRef.current.delete(pendingKey)
        setPendingKeys((prev) => {
          const next = new Set(prev)
          next.delete(pendingKey)
          return next
        })
      }
      if (resolved.kind === 'action') {
        void store
          .invokePluginAction(resolved.pluginId ?? pluginId ?? '', resolved.actionId, resolved.input, conversationId)
          .then(done)
          .catch((error: unknown) => {
            done()
            store.pushNotice({
              type: 'notification',
              level: 'error',
              title: `动作 ${resolved.actionId} 执行失败`,
              body: error instanceof Error ? error.message : String(error),
            })
          })
        return
      }
      if (resolved.kind === 'open') {
        store.openTarget(resolved.target, { split: resolved.split })
        done()
        return
      }
      // helm:send：向目标会话以人类身份提交文本
      void conversationsApi
        .submitInput(resolved.conversationId, { text: resolved.text, origin: 'human' })
        .then(done)
        .catch((error: unknown) => {
          done()
          store.pushNotice({
            type: 'notification',
            level: 'error',
            title: `发送到会话 #${resolved.conversationId} 失败`,
            body: error instanceof Error ? error.message : String(error),
          })
        })
    },
    [store, pluginId, conversationId],
  )

  const isPending = useCallback((key: string) => pendingKeys.has(key), [pendingKeys])

  if (normalized.root === null) return null
  if (isDegradedNode(normalized.root)) {
    const reason = typeof normalized.root.props['reason'] === 'string' ? normalized.root.props['reason'] : '未知原因'
    return <div className="jr-callout jr-callout-warn">界面声明无效：{reason}</div>
  }

  const ctx: SpecRenderContext = {
    scope: { $docs: docsMap, $data: data ?? {} },
    renderChildren: (children: NormalizedSpecNode[]) => <SpecNodeList nodes={children} ctx={ctx} />,
    runAction,
    isPending,
  }

  return <ViewBoundary label="插件界面"><SpecNodeList nodes={[normalized.root]} ctx={ctx} /></ViewBoundary>
}
