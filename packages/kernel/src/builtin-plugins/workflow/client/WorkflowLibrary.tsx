/**
 * builtin:workflow 插件工作流库组件（list/get 动作驱动的已保存定义视图）：
 * - WorkflowLibrarySection：工作台内紧凑运行入口（定义管理去工作流库 Screen）；
 * - WorkflowLibraryCard：库卡片（名称/描述/阶段/文件事实，点击打开详情抽屉）；
 * - WorkflowLibraryDrawer：详情抽屉（只读元数据/源码 + 运行（选目标会话）+ 删除）；
 * - WorkflowLibraryScreen：全屏视图（screen 扩展点，一级主舞台卡片网格 + 右侧抽屉）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ScreenProps } from '@helm/protocol'
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
import { useWorkflowLibrary } from './hooks.ts'
import { SPIN } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'
import { firstLineOf } from './model-format.ts'
import {
  buildWorkflowEditRequest,
  parseWorkflowArgsInput,
  parseWorkflowDetail,
} from './model-library.ts'
import type { SavedWorkflowView } from './model-library.ts'

// ---------------------------------------------------------------------------
// 工作流库：list 动作驱动的已保存定义视图（工作台紧凑运行入口 + 全屏库）
// ---------------------------------------------------------------------------

/** 工作流库分节（工作台内）：紧凑运行入口；定义管理（源码/删除）去工作流库 Screen。 */
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

/** 工作流库卡片：名称/描述/阶段/文件事实；点击打开右侧详情抽屉。 */
function WorkflowLibraryCard(props: { item: SavedWorkflowView; onShowDetail: () => void }): ReactNode {
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

/** 工作流库详情抽屉：只读元数据/源码 + 运行（选目标会话）+ 删除；无任何编辑能力。 */
function WorkflowLibraryDrawer(props: {
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
  const conversationOptions = useMemo(() => {
    const topLevel = conversations.filter((c) => c.parentConversationId === undefined)
    return [...topLevel]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 50)
      .map((c) => ({
        value: String(c.id),
        label: `#${c.id} ${c.title !== '' && c.title !== undefined ? c.title : c.profileId}`.slice(0, 40),
      }))
  }, [conversations])

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
              <div className="callout callout--warn">元数据校验失败：{item.metadataError}</div>
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
                  <Icon name={running ? 'loader' : 'circle'} size={11} className={running ? SPIN : undefined} />
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
            <div className="callout callout--error" style={{ margin: '0 20px 8px' }}>{deleteError}</div>
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

/**
 * 工作流库全屏视图（screen 扩展点）：一级主舞台卡片网格 + 右侧详情抽屉；
 * 只读浏览 / 查看源码 / 运行 / 删除 / 刷新，无源码编辑。选中项与搜索词写入
 * sp.* 深链参数（setParams 唯一导航机制）；inlineDrawer 供宿主内嵌场景与
 * SSR/测试环境内联渲染抽屉（与 AppCenterScreen 同款契约）。
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

  const filtered = useMemo(() => {
    if (items === undefined) return undefined
    if (query === '') return items
    return items.filter(
      (i) =>
        i.name.toLowerCase().includes(query) ||
        (i.description ?? '').toLowerCase().includes(query) ||
        (i.whenToUse ?? '').toLowerCase().includes(query),
    )
  }, [items, query])

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
            <Icon name="circle" size={13} />
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
