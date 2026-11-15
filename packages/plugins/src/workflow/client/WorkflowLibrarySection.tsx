/**
 * 工作流库分节组件（工作台内）：紧凑运行入口；定义管理（源码/删除）去
 * 工作流库 Screen。每行独立 args 草稿与解析错误（按 name 存）。
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { usePluginContext } from '@helm/plugin-client'
import { useWorkflowLibrary } from './hooks.ts'
import { SPIN } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'
import { firstLineOf } from './model-format.ts'
import { parseWorkflowArgsInput } from './model-library.ts'

export function WorkflowLibrarySection(props: { conversationId: number }): ReactNode {
  const ctx = usePluginContext()
  const { items, error, loading, reload } = useWorkflowLibrary()
  const [open, setOpen] = useState(true)
  const [runningName, setRunningName] = useState<string | undefined>(undefined)
  // 每行独立草稿与解析错误（按 name 存）；组件由调用方以 conversationId 作 key，切会话重置。
  const [drafts, setDrafts] = useState<Record<string, { draft: string; error?: string }>>({})

  const runSaved = (name: string): void => {
    const draft = drafts[name]?.draft ?? ''
    const parsed = parseWorkflowArgsInput(draft)
    if (!parsed.ok) {
      setDrafts((prev) => ({ ...prev, [name]: { draft, error: parsed.error } }))
      return
    }
    setRunningName(name)
    ctx
      .callAction('run', {
        name,
        conversationId: props.conversationId,
        ...(parsed.args !== undefined ? { args: parsed.args } : {}),
      })
      .then(() => {
        ctx.notify(`工作流 ${name} 已在当前会话启动`)
        setDrafts((prev) => (prev[name] === undefined ? prev : { ...prev, [name]: { draft: '' } }))
      })
      .catch((err: unknown) => ctx.notify(`启动工作流失败：${err instanceof Error ? err.message : String(err)}`, 'error'))
      .finally(() => setRunningName(undefined))
  }

  return (
    <section className="workflow-library">
      <div className="trace-section-label workflow-library-header">
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          onClick={() => setOpen((v) => !v)}
          title={open ? '收起工作流库' : '展开工作流库'}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
        </button>
        工作流库（已保存定义）
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          title="打开工作流库全屏视图（源码只读、运行、删除等定义管理）"
          onClick={() => ctx.openScreen(`screen:${ctx.pluginId}/library`)}
        >
          <Icon name="external-link" size={11} />
          工作流库
        </button>
        <button type="button" className="btn btn-ghost btn-xs" disabled={loading} onClick={() => void reload()} title="重新读取工作流目录">
          <Icon name="rotate-cw" size={11} className={loading ? SPIN : undefined} />
          刷新
        </button>
      </div>
      {open ? (
        <div className="workflow-library-body">
          {loading && items === undefined ? <div className="workflow-phase-empty">工作流目录读取中…</div> : null}
          {error !== undefined ? (
            <div className="callout callout--error worktree-inspect-error">
              <div>读取工作流目录失败：{error}</div>
              <button type="button" className="btn btn-xs" onClick={() => void reload()}>
                重试
              </button>
            </div>
          ) : null}
          {items !== undefined && items.length === 0 && error === undefined ? (
            <div className="workflow-phase-empty">暂无已保存工作流（保存目录内无带 meta 声明的脚本）</div>
          ) : null}
          {items?.map((item) => (
            <div key={item.name} className="workflow-library-item">
              <div className="workflow-library-item-head">
                <Icon name="terminal" size={12} />
                <strong className="workflow-library-name" title={item.path ?? item.name}>{item.name}</strong>
                {item.phases !== undefined ? (
                  <span className="workflow-library-phases" title={item.phases.map((p) => p.title).join(' → ')}>
                    {`${item.phases.length} 阶段：${item.phases.map((p) => p.title).join(' / ')}`}
                  </span>
                ) : null}
              </div>
              {item.metadataError !== undefined ? (
                <div className="callout callout--warn">元数据校验失败：{item.metadataError}</div>
              ) : (
                <>
                  {item.description !== undefined ? (
                    <div className="workflow-library-desc" title={item.description}>{firstLineOf(item.description, 120)}</div>
                  ) : null}
                  {item.whenToUse !== undefined ? (
                    <div className="workflow-library-when" title={item.whenToUse}>{`适用：${firstLineOf(item.whenToUse, 120)}`}</div>
                  ) : null}
                </>
              )}
              <div className="workflow-library-run">
                <input
                  className="workflow-library-args"
                  type="text"
                  placeholder="args JSON（可选，严格解析）"
                  value={drafts[item.name]?.draft ?? ''}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [item.name]: { draft: e.target.value } }))}
                  aria-label={`工作流 ${item.name} 的 args JSON`}
                />
                <button
                  type="button"
                  className="btn btn-xs"
                  disabled={runningName !== undefined}
                  onClick={() => runSaved(item.name)}
                  title={`在当前会话运行已保存工作流 ${item.name}（args 为空则沿用脚本缺省）`}
                >
                  <Icon name={runningName === item.name ? 'loader' : 'circle'} size={11} className={runningName === item.name ? SPIN : undefined} />
                  运行
                </button>
              </div>
              {drafts[item.name]?.error !== undefined ? (
                <div className="callout callout--error">{drafts[item.name]!.error}</div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}
