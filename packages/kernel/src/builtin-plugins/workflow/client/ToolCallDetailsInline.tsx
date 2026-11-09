/**
 * 内嵌工具入参/输出/产物按钮详情区（插件 client 组件内部使用）。
 * 点击产物按钮调 ctx.openArtifact(artifactId) 打开宿主产物预览弹窗。
 */
import { useMemo, useState } from 'react'
import { usePluginContext } from '@helm/plugin-client'

export interface ToolCallDetailsInlineProps {
  /** 本次工具调用的原始入参。 */
  input?: unknown
  /** 本次工具调用的原始输出文本。 */
  result?: unknown
  /** 输出中检测到的产物引用（内核超长 Spill 标记 / art_ 前缀）。 */
  artifactRef?: string
}

export function ToolCallDetailsInline({ input, result, artifactRef }: ToolCallDetailsInlineProps) {
  const ctx = usePluginContext()
  const [open, setOpen] = useState(false)
  const inputJson = useMemo(() => {
    if (input === undefined) return undefined
    try {
      return JSON.stringify(input, null, 2)
    } catch {
      return String(input)
    }
  }, [input])
  const resultText = typeof result === 'string' ? result : result !== undefined ? useMemo(() => {
    try {
      return JSON.stringify(result, null, 2)
    } catch {
      return String(result)
    }
  }, [result]) : undefined

  return (
    <details className="tool-call-details" open={open} onToggle={(e: unknown) => setOpen((e as { currentTarget: { open: boolean } }).currentTarget.open)}>
      <summary>调用详情</summary>
      <div className="trace-expanded-body selectable">
        {inputJson !== undefined ? (
          <div>
            <div className="trace-section-label">入参</div>
            <pre className="code-block-pre"><code>{inputJson}</code></pre>
          </div>
        ) : null}
        {resultText !== undefined ? (
          <div>
            <div className="trace-section-label">输出</div>
            <pre className="code-block-pre"><code>{resultText}</code></pre>
          </div>
        ) : null}
        {artifactRef !== undefined ? (
          <button
            type="button"
            className="btn btn-xs"
            onClick={() => ctx.openArtifact(artifactRef)}
          >
            打开完整产物 #{artifactRef}
          </button>
        ) : null}
      </div>
    </details>
  )
}
