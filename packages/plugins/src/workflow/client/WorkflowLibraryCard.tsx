/** 工作流库卡片组件：名称/描述/阶段/文件事实；点击打开右侧详情抽屉。 */
import type { ReactNode } from 'react'
import { formatBytes, formatTime } from '@helm/plugin-client'
import { Icon } from './WorkflowIcon.tsx'
import { firstLineOf } from './model-format.ts'
import type { SavedWorkflowView } from './model-library.ts'

export function WorkflowLibraryCard(props: { item: SavedWorkflowView; onShowDetail: () => void }): ReactNode {
  const { item } = props
  const description = item.metadataError !== undefined ? undefined : item.description
  return (
    <div
      className={`workflow-lib-card${item.metadataError !== undefined ? ' workflow-lib-card-warn' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`查看工作流 ${item.name} 详情`}
      onClick={props.onShowDetail}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          props.onShowDetail()
        }
      }}
    >
      <div className="workflow-lib-card-head">
        <Icon name="terminal" size={14} />
        <strong className="workflow-lib-card-name" title={item.path ?? item.name}>{item.name}</strong>
      </div>
      {item.metadataError !== undefined ? (
        <div className="callout callout--warn workflow-lib-card-meta-error">元数据校验失败：{firstLineOf(item.metadataError, 120)}</div>
      ) : (
        <>
          {description !== undefined ? (
            <div className="workflow-lib-card-desc" title={description}>{firstLineOf(description, 140)}</div>
          ) : (
            <div className="workflow-lib-card-desc workflow-lib-card-desc-empty">无描述</div>
          )}
          {item.phases !== undefined ? (
            <div className="workflow-lib-card-phases" title={item.phases.map((p) => p.title).join(' → ')}>
              {`${item.phases.length} 阶段：${item.phases.map((p) => p.title).join(' / ')}`}
            </div>
          ) : null}
        </>
      )}
      <div className="workflow-lib-card-footer">
        <span className="workflow-lib-card-facts tabular-nums" title={`定义文件：${item.path ?? item.name}.js`}>
          {formatTime(item.updatedAt)} · {formatBytes(item.size)}
        </span>
        <span className="badge badge-neutral">查看详情</span>
      </div>
    </div>
  )
}
