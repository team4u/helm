/**
 * 已完成 run 重放表单组件（WorkflowRunCardBody 消费）：源 run 标识 + args
 * 覆盖输入 + 缓存语义说明；args 解析与动作派发由父卡持有。
 */
import type { ReactNode } from 'react'
import type { WorkflowRunSummary } from '../../contracts.js'
import { SPIN } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'

export function WorkflowReplayForm(props: {
  run: WorkflowRunSummary
  replayArgs: string
  onReplayArgsChange: (value: string) => void
  replayError: string | undefined
  busy: boolean
  onReplay: () => void
}): ReactNode {
  const { run, busy, replayArgs, replayError } = props
  return (
    <div className="workflow-replay-form">
      <div className="workflow-replay-meta">
        源 run <code className="mono">{run.id}</code>（会话 #{run.conversationId}；
        {run.savedName !== undefined ? `已保存定义 ${run.savedName} 按最新文件内容执行` : '内联脚本沿用原源码'}）
      </div>
      <div className="workflow-replay-hint">缓存仅复用调用载荷完全相同的前缀节点；首次载荷失配起真实重执行，改参不保证命中缓存，含外部副作用的节点会照实重跑。</div>
      <div className="workflow-replay-row">
        <input
          className="workflow-replay-args"
          type="text"
          placeholder="args JSON（可选；空白沿用原 args，非空严格解析）"
          value={replayArgs}
          onChange={(e) => props.onReplayArgsChange(e.target.value)}
          aria-label={`重放 run ${run.id} 的 args JSON 覆盖`}
        />
        <button
          type="button"
          className="btn btn-xs"
          disabled={busy}
          onClick={props.onReplay}
          aria-label="发起重放"
          title="按 resumeFromRunId 发起重放（新 run 保留原会话；空白 args 沿用原 args）"
        >
          <Icon name="rotate-cw" size={11} className={busy ? SPIN : undefined} />
          发起重放
        </button>
      </div>
      {replayError !== undefined ? <div className="callout callout--error">{replayError}</div> : null}
    </div>
  )
}
