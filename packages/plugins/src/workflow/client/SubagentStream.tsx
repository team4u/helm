/**
 * 子代理实时流展开区组件：渲染紧凑活动行（指令 / 思考 / 工具 / 回复）。
 * 贴底跟随的滚动 hook 由父卡持有（跨折叠/展开保持「用户上滚不抢位」状态），
 * 经 ref / onScroll 注入本展示组件。
 */
import type { ReactNode, RefObject } from 'react'
import { SPIN } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'
import { toolResultPreviewTruncated } from './model-format.ts'
import type { SubagentStreamLine } from './model-subagent-stream.ts'

export function SubagentStream(props: {
  lines: SubagentStreamLine[]
  followRef: RefObject<HTMLDivElement | null>
  onScroll: () => void
}): ReactNode {
  const { lines, followRef, onScroll } = props
  return (
    <div className="subagent-live-stream" ref={followRef} onScroll={onScroll}>
      {lines.slice(-30).map((line) =>
        line.kind === 'prompt' ? (
          <div key={line.key} className="subagent-stream-line subagent-stream-prompt">
            <span className="subagent-stream-tag">指令</span>
            <span className="subagent-stream-body">{line.text}</span>
          </div>
        ) : line.kind === 'thinking' ? (
          <div key={line.key} className="subagent-stream-line subagent-stream-thinking">
            <span className="subagent-stream-tag">思考</span>
            <span className="subagent-stream-body">{line.text}</span>
          </div>
        ) : line.kind === 'tool' ? (
          <div key={line.key} className="subagent-stream-line subagent-stream-tool">
            <Icon name={line.status === 'running' ? 'loader' : line.isError ? 'x' : 'check'} size={11} className={line.status === 'running' ? SPIN : undefined} />
            <span className="subagent-stream-body">
            {line.toolName} {line.summary}{line.resultPreview !== undefined ? `：${line.resultPreview}` : ''}
            {toolResultPreviewTruncated(line.resultPreview) ? <span className="subagent-stream-truncated">（已截断）</span> : null}
          </span>
          </div>
        ) : (
          <div key={line.key} className="subagent-stream-line">
            <span className="subagent-stream-tag">回复</span>
            <span className="subagent-stream-body">{line.text}</span>
          </div>
        ),
      )}
    </div>
  )
}
