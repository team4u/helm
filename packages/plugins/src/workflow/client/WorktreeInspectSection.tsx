/**
 * builtin:workflow 插件受管工作树只读改动概览组件（可折叠）：展开时经
 * inspect_worktree 动作在目标节点真实执行 git 只读命令，展示登记元数据、
 * 状态统计与有上限 diff 预览；「让主会话审阅并合入」仅向父会话提交审阅请求
 * 文本（官方 submitInput 能力），Web 端不执行任何 git 写操作、也不重复实现
 * 合入状态机。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { CopyButton, usePluginContext } from '@helm/plugin-client'
import { SPIN } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'
import { buildWorktreeReviewRequest, buildWorktreeSelector, parseWorktreeInspectResult } from './model-worktree.ts'
import type { WorktreeInspectView } from './model-worktree.ts'

/**
 * 受管工作树只读改动概览（可折叠）：展开时经 inspect_worktree 动作在目标
 * 节点真实执行 git 只读命令，展示登记元数据、状态统计与有上限 diff 预览；
 * 「让主会话审阅并合入」仅向父会话提交审阅请求文本（官方 submitInput 能力），
 * Web 端不执行任何 git 写操作、也不重复实现合入状态机。
 */
export function WorktreeInspectSection(props: {
  worktree: { id?: string; path: string; branch: string }
  nodeId?: string
  baseCommit?: string
  taskLabel?: string
  parentConversationId: number
}): ReactNode {
  const ctx = usePluginContext()
  const { worktree } = props
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [data, setData] = useState<WorktreeInspectView | undefined>(undefined)
  const [sending, setSending] = useState(false)
  const generation = useRef(0)

  const load = async (): Promise<void> => {
    const current = ++generation.current
    setLoading(true)
    setError(undefined)
    try {
      const raw = await ctx.callAction('inspect_worktree', buildWorktreeSelector(worktree, props.nodeId))
      if (generation.current !== current) return
      const parsed = parseWorktreeInspectResult(raw)
      if (parsed === undefined) {
        setError('检视结果结构不合法（动作返回非预期形状，拒绝伪造展示）')
      } else {
        setData(parsed)
      }
    } catch (err) {
      if (generation.current !== current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (generation.current === current) setLoading(false)
    }
  }

  useEffect(() => {
    // 首次展开才拉取；重复展开沿用缓存（手动刷新按钮另路触发）。
    if (open && data === undefined && error === undefined && !loading) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, worktree.path, worktree.id])

  const reviewText = useMemo(
    () =>
      buildWorktreeReviewRequest({
        path: worktree.path,
        branch: data?.branch ?? worktree.branch,
        nodeId: data?.nodeId ?? props.nodeId,
        baseCommit: data?.baseCommit || props.baseCommit,
        taskLabel: props.taskLabel,
        ...(data !== undefined ? { inspect: data } : {}),
      }),
    [worktree.path, worktree.branch, props.nodeId, props.baseCommit, props.taskLabel, data],
  )

  const sendReview = (): void => {
    setSending(true)
    ctx
      .submitInput(reviewText, { conversationId: props.parentConversationId, whenBusy: 'followUp' })
      .then(() => ctx.notify('已向主会话提交工作树审阅请求'))
      .catch((err: unknown) => ctx.notify(`提交审阅请求失败：${err instanceof Error ? err.message : String(err)}`, 'error'))
      .finally(() => setSending(false))
  }

  const unavailableText =
    data?.unavailableReason === 'removed'
      ? '登记已清理（工作树已被移除）'
      : data?.unavailableReason === 'directory_missing'
        ? '目录已不存在（节点真实探测证实；登记仍保留）'
        : undefined

  return (
    <div className="worktree-inspect">
      <div className="worktree-inspect-header">
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          onClick={() => setOpen((v) => !v)}
          title={open ? '收起工作树改动概览' : '展开工作树只读改动概览（目标节点真实 git 检视）'}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
          <Icon name="git-branch" size={11} />
          改动概览
        </button>
        {open && data !== undefined ? (
          <button type="button" className="btn btn-ghost btn-xs" disabled={loading} onClick={() => void load()} title="重新检视（只读）">
            <Icon name="rotate-cw" size={11} className={loading ? SPIN : undefined} />
            刷新
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="worktree-inspect-body">
          {loading && data === undefined ? <div className="workflow-phase-empty">目标节点只读检视中…</div> : null}
          {error !== undefined ? (
            <div className="callout callout--error worktree-inspect-error">
              <div>只读检视失败：{error}</div>
              <button type="button" className="btn btn-xs" onClick={() => void load()}>
                重试
              </button>
            </div>
          ) : null}
          {data !== undefined ? (
            <>
              {unavailableText !== undefined ? (
                <div className="callout callout--warn">{unavailableText}，无法执行 git 检视；仅展示登记元数据。</div>
              ) : null}
              <div className="kv-grid">
                <span className="kv-key">分支</span>
                <span className="kv-val mono">
                  {data.currentBranch ?? data.branch}
                  {data.branchChanged === true ? (
                    <span className="badge badge-warn" title={`登记分支 ${data.branch}；工作树可能已被改签`}>与登记不一致</span>
                  ) : null}
                </span>
                <span className="kv-key">基线</span>
                <span className="kv-val mono" title={data.baseCommit !== '' ? data.baseCommit : undefined}>
                  {data.baseCommit !== '' ? `${data.baseCommit.slice(0, 12)}（${data.diffBase === 'HEAD' ? '无基线，按 HEAD' : '登记基线'}）` : '无登记基线（按 HEAD 检视未提交改动）'}
                </span>
                <span className="kv-key">未提交修改</span>
                <span className="kv-val">{`${data.dirtyFileCount} 个文件${data.dirtyFilesTruncated ? '（列表已截断，仅显示前若干项）' : ''}`}</span>
                {data.commitsAhead !== undefined ? (
                  <>
                    <span className="kv-key">领先基线提交</span>
                    <span className="kv-val">{`${data.commitsAhead} 个`}</span>
                  </>
                ) : null}
                {data.currentHead !== undefined ? (
                  <>
                    <span className="kv-key">当前 HEAD</span>
                    <span className="kv-val mono">{data.currentHead.slice(0, 12)}</span>
                  </>
                ) : null}
              </div>
              {data.dirtyFiles.length > 0 ? (
                <pre className="code-block-pre worktree-inspect-files"><code>{data.dirtyFiles.join('\n')}</code></pre>
              ) : data.exists ? (
                <div className="workflow-phase-empty">工作区无未提交修改</div>
              ) : null}
              {data.exists ? (
                <div className="worktree-inspect-note">Diff 仅包含已跟踪文件；未跟踪文件见状态列表。</div>
              ) : null}
              {data.diffStat !== undefined ? (
                <div>
                  <div className="trace-section-label">Diff 统计（相对{data.diffBase === 'HEAD' ? ' HEAD' : '基线'}）</div>
                  <pre className="code-block-pre workflow-node-pre"><code>{data.diffStat}</code></pre>
                </div>
              ) : null}
              {data.diffPreview !== undefined ? (
                <div>
                  <div className="trace-section-label">
                    Diff 预览（只读，有上限）
                    {data.diffTruncated ? <span className="badge badge-neutral">已截断</span> : null}
                  </div>
                  <pre className="code-block-pre workflow-node-pre worktree-inspect-diff selectable"><code>{data.diffPreview}</code></pre>
                </div>
              ) : data.exists ? (
                <div className="workflow-phase-empty">无已跟踪文件 diff</div>
              ) : null}
            </>
          ) : null}
          <div className="worktree-inspect-actions">
            <button type="button" className="btn btn-xs" disabled={sending} onClick={sendReview} title="向主会话提交审阅与合入请求（实际检视与合入由主会话执行）">
              <Icon name="git-pull-request" size={11} />
              让主会话审阅并合入
            </button>
            <CopyButton text={reviewText} label="复制审阅请求文本" />
          </div>
        </div>
      ) : null}
    </div>
  )
}
