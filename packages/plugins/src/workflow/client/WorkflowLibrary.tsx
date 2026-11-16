/**
 * 工作流库全屏视图组件（screen 扩展点）：一级主舞台卡片网格 + 右侧详情抽屉；
 * 只读浏览 / 查看源码 / 运行 / 删除 / 刷新，无源码编辑。
 * 工作台紧凑运行入口见 WorkflowLibrarySection；卡片 / 详情抽屉见
 * WorkflowLibraryCard / WorkflowLibraryDrawer。
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ScreenProps } from '@helm/protocol'
import { useWorkflowLibrary } from './hooks.ts'
import { SPIN } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'
import { WorkflowLibraryCard } from './WorkflowLibraryCard.tsx'
import { WorkflowLibraryDrawer } from './WorkflowLibraryDrawer.tsx'
import { filterSavedWorkflows } from './model-library.ts'

/**
 * 选中项与搜索词写入 sp.* 深链参数（setParams 唯一导航机制）；inlineDrawer
 * 供宿主内嵌场景与 SSR/测试环境内联渲染抽屉（与 AppCenterScreen 同款契约）。
 */
export interface WorkflowLibraryScreenProps extends ScreenProps {
  inlineDrawer?: boolean
}

export function WorkflowLibraryScreen(props: WorkflowLibraryScreenProps): ReactNode {
  const { items, error, loading, reload } = useWorkflowLibrary()
  const queryParam = props.params['q'] ?? ''
  const [queryDraft, setQueryDraft] = useState(queryParam)
  useEffect(() => {
    setQueryDraft(queryParam)
  }, [queryParam])
  const query = queryDraft.trim().toLowerCase()
  const selectedName = props.params['wf']
  const selectedItem = selectedName !== undefined ? items?.find((i) => i.name === selectedName) : undefined

  const filtered = useMemo(
    () => (items === undefined ? undefined : filterSavedWorkflows(items, query)),
    [items, query],
  )

  return (
    <div className="screen-container workflow-lib-screen">
      <div className="screen-header">
        <div className="screen-title">
          <Icon name="terminal" size={15} />
          <span>工作流库</span>
        </div>
        <span className="screen-subtitle">
          {`跨会话可复用编排资产 ${items?.length ?? 0} 个${props.isSplit ? ' · 分屏' : ''}`}
        </span>
        <div className="stack-row">
          <button type="button" className="btn btn-sm" disabled={loading} onClick={() => void reload()} title="重新读取工作流目录">
            <Icon name="rotate-cw" size={12} className={loading ? SPIN : undefined} />
            刷新
          </button>
        </div>
      </div>

      <div className="screen-section">
        <div className="workflow-lib-toolbar">
          <div className="workflow-lib-search">
            <Icon name="search" size={13} />
            <input
              type="text"
              className="input"
              placeholder="搜索名称、描述或适用场景…"
              value={queryDraft}
              onChange={(e) => {
                const value = e.target.value
                setQueryDraft(value)
                props.setParams({ q: value === '' ? undefined : value })
              }}
              aria-label="搜索工作流"
            />
            {queryDraft !== '' ? (
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                title="清空搜索"
                aria-label="清空搜索"
                onClick={() => {
                  setQueryDraft('')
                  props.setParams({ q: undefined })
                }}
              >
                <Icon name="x" size={11} />
              </button>
            ) : null}
          </div>
        </div>

        {loading && items === undefined ? <div className="workflow-phase-empty">工作流目录读取中…</div> : null}
        {error !== undefined ? (
          <div className="callout callout--error">
            <div>读取工作流目录失败：{error}</div>
            <button type="button" className="btn btn-xs" onClick={() => void reload()}>重试</button>
          </div>
        ) : null}
        {items !== undefined && items.length === 0 && error === undefined ? (
          <div className="workflow-phase-empty">
            暂无已保存工作流。在会话中用 SubagentWorkflow 内联运行后点「保存为工作流」，或让 AI / CLI 调用 workflow save 保存定义。
          </div>
        ) : null}
        {filtered !== undefined && filtered.length === 0 && query !== '' ? (
          <div className="workflow-phase-empty">未找到匹配「{queryDraft.trim()}」的工作流</div>
        ) : null}

        {filtered !== undefined && filtered.length > 0 ? (
          <div className="workflow-lib-grid">
            {filtered.map((item) => (
              <WorkflowLibraryCard
                key={item.name}
                item={item}
                onShowDetail={() => props.setParams({ wf: item.name })}
              />
            ))}
          </div>
        ) : null}
      </div>

      {selectedItem !== undefined ? (
        <WorkflowLibraryDrawer
          item={selectedItem}
          inline={props.inlineDrawer}
          onClose={() => props.setParams({ wf: undefined })}
          onDeleted={() => {
            void reload()
            props.setParams({ wf: undefined })
          }}
        />
      ) : null}
    </div>
  )
}
