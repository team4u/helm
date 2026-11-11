/**
 * builtin:json-render client 组件：聊天 ```ui 代码块的安全 JSON 卡片渲染。
 *
 * - JSON.parse 安全解析：非法 JSON / 非对象回退普通代码块（诚实失败，不伪报成功）；
 * - 流式不完整 JSON（尾部截断）在流结束前回退源码展示，最终内容正常渲染；
 * - 动作执行经宿主受控 usePluginContext（callAction / submitInput / openScreen /
 *   openArtifact / notify），不直接触达宿主 store，无 eval / 任意 JS / 任意 URL；
 * - 原语样式全部在本插件 CSS（styles.css，编译为 __helmClientCss 宿主托管注入）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { usePluginContext, ViewBoundary, HelmIcon, Callout } from '@helm/plugin-client'
import type { MarkdownCodeBlockProps } from '@helm/protocol'
import { CopyButton } from '@helm/plugin-client'
import { isDegradedNode, normalizeSpec, type NormalizedSpecNode } from './spec-normalize.ts'
import { resolveSpecAction } from './spec-action.ts'
import type { EvalScope } from './evaluator.ts'
import { SpecNodeList, type SpecRenderContext } from './spec-primitives.tsx'

/** 成功确认态保持时长（按钮打勾 1.5s 后回落）。 */
const SUCCEED_CONFIRM_MS = 1_500

function StandardCodeBlock({ language, code }: { language: string; code: string }): ReactNode {
  return (
    <div className="code-block-wrap jr-fallback-wrap">
      <div className="code-block-header">
        <span>{language === '' ? 'text' : language}</span>
        <CopyButton text={code} />
      </div>
      <pre className="code-block-pre code-block-pre-flush selectable">
        <code>{code}</code>
      </pre>
    </div>
  )
}

export function JsonRenderCodeBlock({ language, code, conversationId }: MarkdownCodeBlockProps): ReactNode {
  const parsed = useMemo<{ ok: true; spec: Record<string, unknown> } | { ok: false }>(() => {
    try {
      const value = JSON.parse(code) as unknown
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return { ok: true, spec: value as Record<string, unknown> }
      }
      return { ok: false }
    } catch {
      return { ok: false }
    }
  }, [code])

  if (!parsed.ok) {
    // 流式未完成的 JSON 回退源码展示（不伪报成功）；最终合法内容由流稳定后重渲染。
    return <StandardCodeBlock language={language} code={code} />
  }

  return (
    <ViewBoundary label="JSON 卡片">
      <JsonCardView spec={parsed.spec} conversationId={conversationId} />
    </ViewBoundary>
  )
}

function JsonCardView({ spec, conversationId }: { spec: Record<string, unknown>; conversationId?: number }): ReactNode {
  const ctx = usePluginContext()
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(new Set())
  const [succeededKeys, setSucceededKeys] = useState<ReadonlySet<string>>(new Set())
  const inflightRef = useRef<Set<string>>(new Set())
  const succeedTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const mountedRef = useRef(true)

  const clearSucceedTimer = useCallback((key: string): void => {
    const timer = succeedTimersRef.current.get(key)
    if (timer !== undefined) {
      clearTimeout(timer)
      succeedTimersRef.current.delete(key)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    const timers = succeedTimersRef.current
    return () => {
      mountedRef.current = false
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }, [])

  const runAction = useCallback(
    (rawAction: unknown, scope: EvalScope, pendingKey: string) => {
      if (inflightRef.current.has(pendingKey)) return
      inflightRef.current.add(pendingKey)
      clearSucceedTimer(pendingKey)
      setSucceededKeys((prev) => {
        if (!prev.has(pendingKey)) return prev
        const next = new Set(prev)
        next.delete(pendingKey)
        return next
      })
      const beginRequest = (): void => setPendingKeys((prev) => new Set(prev).add(pendingKey))
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
        inflightRef.current.delete(pendingKey)
        ctx.notify(`声明式动作无效：${error instanceof Error ? error.message : String(error)}`, 'warning')
        return
      }
      if (resolved.kind === 'invalid') {
        inflightRef.current.delete(pendingKey)
        ctx.notify(`声明式动作无效：${resolved.message}`, 'warning')
        return
      }

      const run = async (): Promise<void> => {
        try {
          if (resolved.kind === 'action') {
            beginRequest()
            await ctx.callAction(resolved.actionId, resolved.input, {
              pluginId: resolved.pluginId,
              ...(conversationId !== undefined ? { conversationId } : {}),
            })
            if (mountedRef.current) {
              markSucceeded()
              if (conversationId !== undefined) ctx.notify(`动作请求已提交：${resolved.actionId}`)
            }
            return
          }
          if (resolved.kind === 'open') {
            beginRequest()
            if (resolved.target.startsWith('artifact:')) {
              ctx.openArtifact(resolved.target.slice('artifact:'.length))
            } else if (resolved.split) {
              ctx.openSplitScreen(resolved.target)
            } else {
              ctx.openScreen(resolved.target)
            }
            markSucceeded()
            return
          }
          beginRequest()
          await ctx.submitInput(resolved.text, {
            conversationId: resolved.conversationId,
            ...(resolved.whenBusy !== undefined ? { whenBusy: resolved.whenBusy } : {}),
          })
          if (mountedRef.current) {
            markSucceeded()
            ctx.notify(
              resolved.conversationId === conversationId
                ? `已发送卡片指令：${resolved.text}`
                : `已发送到会话 #${resolved.conversationId}`,
            )
          }
        } catch (error) {
          if (mountedRef.current) {
            ctx.notify(
              resolved.kind === 'action'
                ? `动作 ${resolved.actionId} 执行失败：${error instanceof Error ? error.message : String(error)}`
                : resolved.kind === 'send'
                  ? `发送到会话 #${resolved.conversationId} 失败：${error instanceof Error ? error.message : String(error)}`
                  : `打开目标失败：${error instanceof Error ? error.message : String(error)}`,
              'error',
            )
          }
        } finally {
          finishRequest()
        }
      }
      void run()
    },
    [ctx, conversationId, clearSucceedTimer],
  )

  const normalized = useMemo(() => normalizeSpec(spec), [spec])
  const isPending = useCallback((key: string) => pendingKeys.has(key), [pendingKeys])
  const isSucceeded = useCallback((key: string) => succeededKeys.has(key), [succeededKeys])

  if (normalized.root === null) return null
  if (isDegradedNode(normalized.root)) {
    const reason =
      typeof normalized.root.props['reason'] === 'string' ? normalized.root.props['reason'] : '未知原因'
    return (
      <Callout tone="warn" title="界面声明无效">
        <span>{reason}</span>
      </Callout>
    )
  }

  const renderCtx: SpecRenderContext = {
    scope: { $data: {} },
    conversationId,
    pluginId: undefined,
    renderChildren: (children: NormalizedSpecNode[]) => <SpecNodeList nodes={children} ctx={renderCtx} />,
    runAction,
    isPending,
    isSucceeded,
  }

  return (
    <div className="jr-card-wrap">
      <SpecNodeList nodes={[normalized.root]} ctx={renderCtx} />
    </div>
  )
}
