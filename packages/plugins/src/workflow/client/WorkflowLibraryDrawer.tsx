/**
 * 工作流库详情抽屉组件：只读元数据/源码 + 运行（选目标会话）+ 删除；
 * 无任何编辑能力。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  CopyButton,
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  Select,
  formatBytes,
  formatTime,
  useConversations,
  usePluginContext,
} from '@helm/plugin-client'
import { SPIN } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'
import {
  buildWorkflowEditRequest,
  buildWorkflowRunTargetOptions,
  parseWorkflowArgsInput,
  parseWorkflowDetail,
} from './model-library.ts'
import type { SavedWorkflowView } from './model-library.ts'

export function WorkflowLibraryDrawer(props: {
  item: SavedWorkflowView
  inline?: boolean
  onClose: () => void
  onDeleted: () => void
}): ReactNode {
  const ctx = usePluginContext()
  const { item, onClose } = props
  const [detail, setDetail] = useState<{ script: string; description?: string; whenToUse?: string; phases?: SavedWorkflowView['phases'] } | undefined>(undefined)
  const [detailError, setDetailError] = useState<string | undefined>(undefined)
  const [detailLoading, setDetailLoading] = useState(true)
  const [argsDraft, setArgsDraft] = useState('')
  const [argsError, setArgsError] = useState<string | undefined>(undefined)
  const [conversationId, setConversationId] = useState<string>('')
  const [running, setRunning] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined)
  const generation = useRef(0)
  const conversations = useConversations()

  const loadDetail = async (): Promise<void> => {
    const current = ++generation.current
    setDetailLoading(true)
    setDetailError(undefined)
    try {
      const raw = await ctx.callAction('get', { name: item.name })
      if (generation.current !== current) return
      const parsed = parseWorkflowDetail(raw)
      if (parsed === undefined) {
        setDetailError('定义详情返回结构不合法（动作返回非预期形状，拒绝伪造展示）')
      } else {
        setDetail({ script: parsed.script, description: parsed.description, whenToUse: parsed.whenToUse, phases: parsed.phases })
      }
    } catch (err) {
      if (generation.current !== current) return
      setDetailError(err instanceof Error ? err.message : String(err))
    } finally {
      if (generation.current === current) setDetailLoading(false)
    }
  }

  useEffect(() => {
    setDetail(undefined)
    setDetailError(undefined)
    setDetailLoading(true)
    setArgsDraft('')
    setArgsError(undefined)
    setConversationId('')
    setConfirmDelete(false)
    setDeleteError(undefined)
    void loadDetail()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.name])

  // 目标会话选项：顶层会话优先（子代理会话不出现在选择器里）。
  const conversationOptions = useMemo(() => buildWorkflowRunTargetOptions(conversations), [conversations])

  const run = (): void => {
    if (running) return
    if (conversationId === '') {
      setArgsError('请先选择目标会话')
      return
    }
    const parsed = parseWorkflowArgsInput(argsDraft)
    if (!parsed.ok) {
      setArgsError(parsed.error)
      return
    }
    setArgsError(undefined)
    setRunning(true)
    ctx
      .callAction('run', {
        name: item.name,
        conversationId: Number(conversationId),
        ...(parsed.args !== undefined ? { args: parsed.args } : {}),
      })
      .then(() => ctx.notify(`工作流 ${item.name} 已在会话 #${conversationId} 启动`))
      .catch((err: unknown) => ctx.notify(`启动工作流失败：${err instanceof Error ? err.message : String(err)}`, 'error'))
      .finally(() => setRunning(false))
  }

  const remove = (): void => {
    if (deleting) return
    setDeleting(true)
    setDeleteError(undefined)
    ctx
      .callAction('delete', { name: item.name })
      .then(() => {
        ctx.notify(`已删除工作流定义 ${item.name}（历史运行记录不受影响）`)
        setConfirmDelete(false)
        props.onDeleted()
      })
      .catch((err: unknown) => setDeleteError(err instanceof Error ? err.message : String(err)))
      .finally(() => setDeleting(false))
  }

  const editRequestText = useMemo(
    () => buildWorkflowEditRequest(item.name, { description: detail?.description }),
    [item.name, detail?.description],
  )

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPortal inline={props.inline}>
        <DialogOverlay className="modal-backdrop primary-drawer-backdrop" />
        <DialogContent
          className="primary-drawer-content workflow-lib-drawer"
          role="dialog"
          aria-label={`工作流 ${item.name} 详情`}
        >
          <div className="primary-drawer-header">
            <div className="primary-drawer-header-left">
              <div className="primary-drawer-icon-wrap">
                <Icon name="terminal" size={18} />
              </div>
              <div className="primary-drawer-title-col">
                <div className="primary-drawer-title-row">
                  <DialogTitle className="primary-drawer-title">{item.name}</DialogTitle>
                  <span className="badge badge-neutral tabular-nums" title={`定义文件：${item.path ?? ''}`}>
                    {formatBytes(item.size)}
                  </span>
                  <span className="badge badge-neutral tabular-nums">{formatTime(item.updatedAt)}</span>
                  {item.metadataError !== undefined ? <span className="badge badge-warn">元数据异常</span> : null}
                </div>
                <div className="primary-drawer-id mono">{item.path ?? item.name}</div>
              </div>
            </div>
            <DialogClose asChild>
              <button type="button" className="btn btn-ghost btn-sm" aria-label="关闭" title="关闭">
                <Icon name="x" size={14} />
              </button>
            </DialogClose>
          </div>

          <div className="primary-drawer-body">
            {item.metadataError !== undefined ? (
              <div className="callout callout--warning">元数据校验失败：{item.metadataError}</div>
            ) : null}

            <div className="form-grid">
              <div className="form-grid-row">
                <span className="form-grid-label"><span>描述</span></span>
                <span className="form-grid-value" title={detail?.description ?? item.description ?? ''}>
                  {detail?.description ?? item.description ?? '—'}
                </span>
              </div>
              {(detail?.whenToUse ?? item.whenToUse) !== undefined ? (
                <div className="form-grid-row">
                  <span className="form-grid-label"><span>适用场景</span></span>
                  <span className="form-grid-value" title={(detail?.whenToUse ?? item.whenToUse) ?? ''}>
                    {detail?.whenToUse ?? item.whenToUse}
                  </span>
                </div>
              ) : null}
              <div className="form-grid-row">
                <span className="form-grid-label"><span>阶段</span></span>
                <span className="form-grid-value">
                  {(detail?.phases ?? item.phases) !== undefined
                    ? (detail?.phases ?? item.phases)!.map((p) => p.title).join(' → ')
                    : '未声明'}
                </span>
              </div>
            </div>

            <div className="workflow-lib-drawer-section">
              <div className="trace-section-label">
                源码（只读）
                <button type="button" className="btn btn-ghost btn-xs" disabled={detailLoading} onClick={() => void loadDetail()} title="重新读取源码">
                  <Icon name="rotate-cw" size={11} className={detailLoading ? SPIN : undefined} />
                  刷新
                </button>
              </div>
              {detailLoading && detail === undefined ? <div className="workflow-phase-empty">源码读取中…</div> : null}
              {detailError !== undefined ? (
                <div className="callout callout--error">
                  <div>读取源码失败：{detailError}</div>
                  <button type="button" className="btn btn-xs" onClick={() => void loadDetail()}>重试</button>
                </div>
              ) : null}
              {detail !== undefined ? (
                <>
                  <pre className="code-block-pre workflow-lib-source selectable"><code>{detail.script}</code></pre>
                  <CopyButton text={detail.script} label="复制完整源码" />
                </>
              ) : null}
              <div className="workflow-lib-hint">
                工作流的创建与修改由 AI / CLI 调用 save 动作完成，Web 端不提供源码编辑器。
              </div>
            </div>

            <div className="workflow-lib-drawer-section">
              <div className="trace-section-label">运行（选择目标会话）</div>
              <div className="workflow-lib-run-row">
                <div className="workflow-lib-run-select">
                  <Select
                    value={conversationId}
                    options={conversationOptions}
                    onChange={(e) => setConversationId(e.target.value)}
                    placeholder="选择目标会话"
                    aria-label="选择运行目标会话"
                  />
                </div>
                <input
                  className="workflow-library-args"
                  type="text"
                  placeholder="args JSON（可选，严格解析）"
                  value={argsDraft}
                  onChange={(e) => {
                    setArgsDraft(e.target.value)
                    setArgsError(undefined)
                  }}
                  aria-label={`工作流 ${item.name} 的 args JSON`}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={running || conversationOptions.length === 0}
                  title={conversationOptions.length === 0 ? '无可用顶层会话' : `在选定会话运行工作流 ${item.name}`}
                  onClick={run}
                >
                  <Icon name={running ? 'loader' : 'play'} size={11} className={running ? SPIN : undefined} />
                  运行
                </button>
              </div>
              {argsError !== undefined ? <div className="callout callout--error">{argsError}</div> : null}
            </div>

            <div className="workflow-lib-drawer-section">
              <div className="trace-section-label">让 AI 修改</div>
              <div className="workflow-lib-hint">
                复制以下请求发给任意会话中的 AI，由它读取源码、修改并经 save 动作写回；本页不直接改动文件。
              </div>
              <pre className="code-block-pre workflow-lib-edit-request selectable"><code>{editRequestText}</code></pre>
              <CopyButton text={editRequestText} label="复制修改请求" />
            </div>
          </div>

          {deleteError !== undefined ? (
            <div className="callout callout--error workflow-lib-delete-error">{deleteError}</div>
          ) : null}

          <div className="primary-drawer-footer">
            {confirmDelete ? (
              <div className="workflow-lib-delete-confirm">
                <span className="text-subtle">确认删除工作流定义 {item.name}？历史运行记录保留。</span>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={deleting}
                  onClick={() => setConfirmDelete(false)}
                >
                  取消
                </button>
                <button type="button" className="btn btn-sm btn-danger" disabled={deleting} onClick={remove}>
                  <Icon name="x" size={12} />
                  {deleting ? '正在删除…' : '确认删除'}
                </button>
              </div>
            ) : (
              <>
                <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
                  关闭
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost btn-danger"
                  title="删除定义文件（历史运行记录不受影响）"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Icon name="x" size={12} />
                  删除
                </button>
              </>
            )}
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
