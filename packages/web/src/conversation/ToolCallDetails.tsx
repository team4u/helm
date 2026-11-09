import { useMemo } from 'react'
import type { ToolTrace } from './timeline-model.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'

/** 业务卡片内的原始调用入口，保留本次入参、结果及完整产物。 */
export function ToolCallDetails({ tool }: { tool: ToolTrace }) {
  const store = useHelmStore()
  const input = useMemo(() => {
    if (tool.input === undefined) return undefined
    try { return JSON.stringify(tool.input, null, 2) } catch { return String(tool.input) }
  }, [tool.input])
  return (
    <details className="tool-call-details">
      <summary>调用详情</summary>
      <div className="trace-expanded-body selectable">
        {input !== undefined ? <div><div className="trace-section-label">入参</div><pre className="code-block-pre"><code>{input}</code></pre></div> : null}
        {tool.resultText !== undefined ? <div><div className="trace-section-label">输出</div><pre className="code-block-pre"><code>{tool.resultText}</code></pre></div> : null}
        {tool.artifactRef !== undefined ? (
          <button type="button" className="btn btn-xs" onClick={() => store.setActiveModal({ kind: 'artifact-preview', artifactId: tool.artifactRef! })}>
            <HelmIcon name="external-link" size={11} />打开完整产物 #{tool.artifactRef}
          </button>
        ) : null}
      </div>
    </details>
  )
}
