/**
 * builtin:workflow 后台结算汇报折叠卡（timeline.renderer 精确接管 helm.input）。
 *
 * - 复用 ExecutionCard 紧凑头部 + 单行副栏框架（与子代理实时卡同一套
 *   .subagent-live-* 样式与字号）：左侧 bot/状态图标与「子代理汇报 / 工作流汇报」
 *   短标题（有真实 execution 时附子会话 #ID），右侧终态徽章与复制 / 打开子会话
 *   图标动作（btn-xs/btn-ghost，aria-label 明确）；runId 仅入悬浮提示，收起态不占位。
 * - 头部触发区即折叠开关（aria-expanded / aria-controls 恒指向真实区域）；展开才
 *   挂载完整 result/error/在途快照（字符串走宿主 MarkdownText，JSON 缩进代码块，
 *   .subagent-live-stream 限高滚动）。
 * - 历史展示基于 entry 自身不变快照，不订阅实时状态、不发多余请求。
 * - 数据损坏显式「汇报数据格式异常」，仍可展开复制原文，不伪造成功。
 */
import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { TimelineRendererProps } from '@helm/protocol'
import { CopyButton, MarkdownText, usePluginContext } from '@helm/plugin-client'
import { RUN_BADGE, RUN_LABEL } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'
import { ExecutionCard } from './ExecutionCard.tsx'
import { backgroundReportPreview, parseBackgroundReportEntry } from './model-background-report.ts'
import type { BackgroundReportView } from './model-background-report.ts'

const PREVIEW_MAX_CHARS = 120

export function BackgroundReportCard(props: TimelineRendererProps): ReactNode {
  const ctx = usePluginContext()
  const view = useMemo(() => parseBackgroundReportEntry(props.entry), [props.entry])
  const [open, setOpen] = useState(false)
  const bodyId = useId()

  const conversationId = view.invalid ? undefined : view.executionConversationId
  const isFailure = !view.invalid && (view.status === 'failed' || view.status === 'aborted')
  const title = view.invalid ? '后台汇报' : view.kind === 'subagent_report' ? '子代理汇报' : '工作流汇报'
  const statusIcon = view.invalid || isFailure ? 'x' : view.kind === 'workflow_report' ? 'check' : 'bot'
  const preview = view.invalid ? '' : backgroundReportPreview(view, PREVIEW_MAX_CHARS)

  // 头部触发区：展开指示 + 状态图标 + 短标题（+ 子会话 #ID）+ 终态徽章。
  const heading = (
    <>
      <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} className="execution-child-expand" />
      <Icon name={statusIcon} size={13} />
      <span className="subagent-live-title" title={view.invalid ? undefined : `运行 ${view.runId}`}>
        <span className="subagent-live-id">{title}</span>
        {conversationId !== undefined ? (
          <span className="subagent-live-title-text">{`子会话 #${conversationId}`}</span>
        ) : null}
      </span>
      {view.invalid ? (
        <span className="badge badge-err">汇报数据格式异常</span>
      ) : (
        <span className={`badge ${RUN_BADGE[view.status] ?? 'badge-neutral'}`}>{RUN_LABEL[view.status] ?? view.status}</span>
      )}
    </>
  )

  // 右侧图标动作：复制原文（完整正文）+ 有真实 execution 时的子会话入口。
  const actions = (
    <>
      <CopyButton text={view.rawText} className="btn btn-ghost btn-xs" />
      {conversationId !== undefined ? (
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          title={`打开子会话 #${conversationId}`}
          aria-label={`打开子会话 #${conversationId}`}
          onClick={(e) => {
            e.stopPropagation()
            ctx.openConversationDrawer(conversationId)
          }}
        >
          <Icon name="external-link" size={11} />
        </button>
      ) : null}
    </>
  )

  // 折叠态单行副栏：完成看结果首行；失败/中止错误直见（红色强调）。
  const snippet =
    preview === '' ? undefined : (
      <div className={`subagent-live-subline${isFailure ? ' execution-report-subline-error' : ''}`} title={preview}>
        <Icon name="corner-down-right" size={11} />
        <span className="subagent-live-subline-text">{preview}</span>
      </div>
    )

  return (
    <ExecutionCard
      variantClass={open ? 'subagent-live-card-expanded' : undefined}
      toggle={{
        label: open ? '收起后台任务汇报详情' : '展开后台任务汇报详情',
        expanded: open,
        controlsId: bodyId,
        onToggle: () => setOpen((v) => !v),
      }}
      heading={heading}
      actions={actions}
      snippet={snippet}
    >
      {/* 外层裸 div 保证 hidden 生效（subagent-live-stream 的 display:flex 会盖过 UA 的 [hidden]）。 */}
      <div id={bodyId} hidden={!open}>
        {open ? (
          <div className="subagent-live-stream">
            {view.invalid ? <pre className="code-block-pre selectable"><code>{view.rawText}</code></pre> : <ExpandedBody view={view} />}
          </div>
        ) : null}
      </div>
    </ExecutionCard>
  )
}

/** 展开态：完整 result/error/在途快照（挂载才渲染，限高滚动）。 */
function ExpandedBody({ view }: { view: BackgroundReportView }): ReactNode {
  const isFailure = view.status === 'failed' || view.status === 'aborted'
  return (
    <>
      {view.error !== undefined && view.error !== '' ? (
        <div className={`callout ${isFailure ? 'callout--error' : 'callout--warning'}`} role={isFailure ? 'alert' : undefined}>
          {view.error}
        </div>
      ) : null}
      {view.hasResult ? (
        <div>
          <div className="trace-section-label">结果</div>
          {typeof view.result === 'string' ? (
            <MarkdownText text={view.result} />
          ) : (
            <pre className="code-block-pre"><code>{JSON.stringify(view.result, null, 2)}</code></pre>
          )}
        </div>
      ) : (
        <div className="subagent-stream-empty">本次运行未携带结果数据。</div>
      )}
      {view.otherRunningTasks.length > 0 ? (
        <div>
          <div className="trace-section-label">投递时其余在途任务（快照）</div>
          <div className="execution-report-tasks">
            {view.otherRunningTasks.map((task) => (
              <span key={task.runId} className="badge badge-neutral" title={`${task.runId} · ${task.kind}`}>
                {task.name}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </>
  )
}
