/**
 * builtin:superagent 插件 client.tsx 组件（只导出组件，保 Fast Refresh 契约）：
 * - SuperAgentComposerWidget：中枢态势挂件（活跃 Worker / 订阅实时计数 + 表）；
 * - SuperAgentRouterModePill：中枢路由收敛模式开关（set_router_mode 动作）；
 * - SuperAgentDispatchToolView：dispatch_worker 工具卡（派工状态 + 归档动作）；
 * - SuperAgentWorkerReportCard：Worker 汇报时间线卡（meta.renderer 精确匹配）；
 * - SuperAgentRecallScreen：RecallGraph 记忆图谱 + 事件订阅全屏视图；
 * - SuperAgentSettingsPanel：设置面板（只读托管状态，指向配置项）。
 *
 * 数据经 @helm/plugin-client 共享 hooks（usePluginDoc）响应式订阅本插件
 * public doc；动作经 ctx.callAction 走 POST /api/actions，导航经 ctx.openScreen /
 * ctx.openSplitScreen。通用结构一律复用宿主设计系统原语
 * （.screen-container / .helm-table / .kv-list / .callout / .loading-state），
 * 仅保留 sa-widget / sa-pill / sa-report 等巡检专有业务结构样式。
 */
import { useState } from 'react'
import './styles.css'
import type { ReactNode } from 'react'
import type { ComposerScopeProps, ScreenProps, TimelineRendererProps, ToolViewProps } from '@helm/protocol'
import { Switch, usePluginContext, usePluginDoc } from '@helm/plugin-client'
import {
  dispatchedWorkerId,
  dispatchInput,
  formatTime,
  outcomeLabel,
  outcomeTone,
  parseRecallNodes,
  parseRouterMode,
  parseSubscriptions,
  parseWorkers,
  workerReportMeta,
  type RecallGraphDoc,
  type RouterModeDoc,
  type SuperAgentIndexDoc,
  type ThreadSubscriptionDoc,
} from './models.ts'

import {
  Bot,
  Boxes,
  ExternalLink,
  GitFork,
  Loader2,
  MessageSquare,
  Network,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// 共享小组件（本插件内部，不入核心）
// ---------------------------------------------------------------------------

/** 数据尚未到达时的行内加载态（doc 订阅首帧前）。 */
function DocLoading({ label }: { label: string }): ReactNode {
  return (
    <div className="loading-state" role="status">
      <Loader2 size={12} className="spin-slow" />
      <span>{label}</span>
    </div>
  )
}

/** 动作错误横幅（callAction 显式失败；绝不静默）。 */
function ActionError({ message }: { message: string }): ReactNode {
  return (
    <div className="callout callout--error" role="alert">
      <span>{message}</span>
    </div>
  )
}

/**
 * Worker 行动作按钮。受同一 pending 守卫的按钮统一 disabled：
 * 任一动作在途时其余按钮同样不可点，杜绝「看似可点实际无动作」。
 */
function RowAction({
  label,
  icon,
  disabled,
  danger,
  onClick,
}: {
  label: string
  icon?: ReactNode
  disabled?: boolean
  danger?: boolean
  onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      className={`btn btn-xs ${danger === true ? 'btn-danger' : ''}`}
      disabled={disabled === true}
      onClick={onClick}
    >
      {disabled === true ? <Loader2 size={11} className="spin-slow" /> : icon}
      <span>{label}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// composerWidget：中枢态势
// ---------------------------------------------------------------------------

/** 中枢态势挂件：活跃 Worker / 事件订阅实时计数与表。 */
export function SuperAgentComposerWidget(_props: ComposerScopeProps): ReactNode {
  const ctx = usePluginContext()
  const index = usePluginDoc<SuperAgentIndexDoc>('index')
  const subscriptions = usePluginDoc<ThreadSubscriptionDoc>('subscriptions')
  const workers = parseWorkers(index)
  const subs = parseSubscriptions(subscriptions)
  const loading = index === undefined || subscriptions === undefined

  return (
    <div className="section-flat sa-widget">
      <div className="sa-widget-title">
        <Network size={13} strokeWidth={1.75} />
        <span>中枢态势</span>
      </div>
      {loading ? (
        <DocLoading label="态势读取中..." />
      ) : (
        <>
          <div className="sa-widget-muted">
            活跃 Worker {workers.length} 个；事件订阅 {subs.length} 条。
          </div>
          <div className="helm-table-wrap">
            <table className="helm-table">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Profile</th>
                  <th className="cell-actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {workers.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="table-empty">
                      暂无数据
                    </td>
                  </tr>
                ) : (
                  workers.map((w) => (
                    <tr key={w.conversationId}>
                      <td>#{w.conversationId}</td>
                      <td>{w.profileId}</td>
                      <td className="cell-actions">
                        <div className="row-actions-group">
                          <RowAction label="打开" icon={<ExternalLink size={11} />} onClick={() => ctx.openScreen(`conversation:${w.conversationId}`)} />
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// composerPill：中枢路由收敛模式开关
// ---------------------------------------------------------------------------

/** 中枢路由收敛模式胶囊（routing 镜像 doc；动作 set_router_mode 真实写配置）。 */
export function SuperAgentRouterModePill(_props: ComposerScopeProps): ReactNode {
  const ctx = usePluginContext()
  const routing = usePluginDoc<RouterModeDoc>('routing')
  const mode = parseRouterMode(routing)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const toggle = (next: boolean): void => {
    if (pending) return
    setPending(true)
    setError(undefined)
    void ctx
      .callAction('set_router_mode', { enabled: next })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        setPending(false)
      })
  }

  return (
    <span className="sa-pill">
      <Switch
        checked={mode === true}
        onChange={toggle}
        disabled={pending || mode === undefined}
        label="中枢路由"
        aria-label="中枢路由收敛模式"
      />
      {mode === undefined ? <span className="text-subtle">读取中</span> : null}
      {error !== undefined ? <ActionError message={error} /> : null}
    </span>
  )
}

// ---------------------------------------------------------------------------
// toolView：dispatch_worker 派工状态卡
// ---------------------------------------------------------------------------

/** dispatch_worker 工具卡：派工输入摘要 + 全部活跃 Worker 表 + 归档动作。 */
export function SuperAgentDispatchToolView(props: ToolViewProps): ReactNode {
  const ctx = usePluginContext()
  const index = usePluginDoc<SuperAgentIndexDoc>('index')
  const workers = parseWorkers(index)
  const input = dispatchInput(props)
  const resultWorkerId = dispatchedWorkerId(props)
  const [archiving, setArchiving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const archive = (workerConversationId: number): void => {
    if (archiving) return
    setArchiving(true)
    setError(undefined)
    void ctx
      .callAction('archive_worker', { workerConversationId })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        setArchiving(false)
      })
  }

  return (
    <div className="section-flat sa-widget">
      <div className="sa-widget-title">
        <Boxes size={13} strokeWidth={1.75} />
        <span>后台 Worker 派工</span>
      </div>
      {props.status === 'running' ? (
        <div className="loading-state" role="status">
          <Loader2 size={12} className="spin-slow" />
          <span>派工中...</span>
        </div>
      ) : (
        <div className="sa-widget-muted">
          {resultWorkerId !== undefined
            ? `已派工 Worker #${resultWorkerId}`
            : props.status === 'error'
              ? '派工失败'
              : '派工完成'}
          {input.profileId !== undefined ? ` · Profile ${input.profileId}` : ''}
          {input.threadKey !== undefined ? ` · threadKey ${input.threadKey}` : ''}
        </div>
      )}
      {error !== undefined ? <ActionError message={error} /> : null}
      {index === undefined ? (
        <DocLoading label="Worker 清单读取中..." />
      ) : (
        <div className="helm-table-wrap">
          <table className="helm-table">
            <thead>
              <tr>
                <th>会话</th>
                <th>Profile</th>
                <th className="cell-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {workers.length === 0 ? (
                <tr>
                  <td colSpan={3} className="table-empty">
                    暂无数据
                  </td>
                </tr>
              ) : (
                workers.map((w) => (
                  <tr key={w.conversationId}>
                    <td>#{w.conversationId}</td>
                    <td>{w.profileId}</td>
                    <td className="cell-actions">
                      {/* 归档在途时统一禁用本卡全部行按钮（一致防重行为） */}
                      <div className="row-actions-group">
                        <RowAction label="查看" icon={<ExternalLink size={11} />} disabled={archiving} onClick={() => ctx.openScreen(`conversation:${w.conversationId}`)} />
                        <RowAction
                          label="归档"
                          icon={<Boxes size={11} />}
                          disabled={archiving}
                          danger
                          onClick={() => archive(w.conversationId)}
                        />
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// timelineRenderer：Worker 汇报卡
// ---------------------------------------------------------------------------

/** Worker 汇报时间线卡（matchMeta.renderer = superagent:worker-report 精确匹配）。 */
export function SuperAgentWorkerReportCard(props: TimelineRendererProps): ReactNode {
  const ctx = usePluginContext()
  const meta = workerReportMeta(props)
  const tone = outcomeTone(meta.outcome)

  return (
    <div className="sa-report">
      <div className="sa-report-header">
        <span className={`badge badge-${tone === 'neutral' ? 'accent' : tone}`}>
          <Bot size={11} strokeWidth={1.75} />
          <span>Worker 汇报</span>
        </span>
        {meta.profileId !== undefined ? <span className="badge badge-neutral">{meta.profileId}</span> : null}
        {meta.outcome !== undefined ? (
          <span className={`badge badge-${tone}`}>
            <span>{outcomeLabel(meta.outcome)}</span>
          </span>
        ) : null}
      </div>
      <div className="sa-report-summary">{meta.summary ?? ''}</div>
      {meta.artifacts !== undefined && meta.artifacts.length > 0 ? (
        <div className="sa-report-meta">
          {meta.artifacts.map((a) => (
            <button
              key={a.id}
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => ctx.openArtifact(a.id)}
              title={`产物 ${a.name}（${a.size} 字节）`}
            >
              <ExternalLink size={11} />
              <span>{a.name}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="row-actions-group">
        <RowAction
          label="在右屏并排打开"
          icon={<MessageSquare size={11} />}
          onClick={() => {
            if (meta.workerId !== undefined) ctx.openSplitScreen(`conversation:${meta.workerId}`)
          }}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// screen：RecallGraph 记忆图谱 + 事件订阅
// ---------------------------------------------------------------------------

/** 记忆与订阅图谱全屏视图（recall-graph + subscriptions doc 实时订阅）。 */
export function SuperAgentRecallScreen(props: ScreenProps): ReactNode {
  const ctx = usePluginContext()
  const recall = usePluginDoc<RecallGraphDoc>('recall-graph')
  const subscriptions = usePluginDoc<ThreadSubscriptionDoc>('subscriptions')
  const nodes = parseRecallNodes(recall)
  const subs = parseSubscriptions(subscriptions)

  return (
    <div className="screen-container">
      <div className="screen-header">
        <div className="screen-title">
          <GitFork size={15} strokeWidth={1.75} />
          <span>RecallGraph 记忆图谱</span>
        </div>
        <span className="screen-subtitle">
          节点 {nodes.length} · 订阅 {subs.length}
          {props.isSplit ? ' · 分屏' : ''}
        </span>
      </div>

      <div className="screen-section">
        <div className="helm-table-wrap">
          <table className="helm-table">
            <thead>
              <tr>
                <th>会话</th>
                <th>Profile</th>
                <th>终态</th>
                <th>摘要</th>
                <th className="cell-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {recall === undefined && nodes.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <DocLoading label="图谱读取中..." />
                  </td>
                </tr>
              ) : nodes.length === 0 ? (
                <tr>
                  <td colSpan={5} className="table-empty">
                    暂无数据
                  </td>
                </tr>
              ) : (
                nodes.map((n) => (
                  <tr key={n.id}>
                    <td>#{n.conversationId}</td>
                    <td>{n.profileId}</td>
                    <td>
                      <span className={`badge badge-${outcomeTone(n.outcome)}`}>
                        <span>{outcomeLabel(n.outcome)}</span>
                      </span>
                    </td>
                    <td className="sa-summary-cell">{n.summary}</td>
                    <td className="cell-actions">
                      <div className="row-actions-group">
                        <RowAction label="打开会话" icon={<ExternalLink size={11} />} onClick={() => ctx.openScreen(`conversation:${n.conversationId}`)} />
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="screen-section">
        <div className="screen-section-title">
          <Network size={13} strokeWidth={1.75} />
          <span>事件订阅</span>
        </div>
        <div className="helm-table-wrap">
          <table className="helm-table">
            <thead>
              <tr>
                <th>ThreadKey</th>
                <th>Worker</th>
                <th>创建时间</th>
                <th className="cell-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions === undefined && subs.length === 0 ? (
                <tr>
                  <td colSpan={4}>
                    <DocLoading label="订阅读取中..." />
                  </td>
                </tr>
              ) : subs.length === 0 ? (
                <tr>
                  <td colSpan={4} className="table-empty">
                    暂无数据
                  </td>
                </tr>
              ) : (
                subs.map((s) => (
                  <tr key={s.threadKey}>
                    <td>{s.threadKey}</td>
                    <td>#{s.workerConversationId}</td>
                    <td>{formatTime(s.createdAt)}</td>
                    <td className="cell-actions">
                      <div className="row-actions-group">
                        <RowAction label="打开 Worker" icon={<ExternalLink size={11} />} onClick={() => ctx.openScreen(`conversation:${s.workerConversationId}`)} />
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// settingsPanel：只读托管状态
// ---------------------------------------------------------------------------

/** 设置面板：只读展示中枢/看门狗托管会话，配置项引导到插件配置区。 */
export function SuperAgentSettingsPanel(): ReactNode {
  const index = usePluginDoc<SuperAgentIndexDoc>('index')
  const routerId = typeof index?.routerConversationId === 'number' ? index.routerConversationId : undefined
  const watchdogId = typeof index?.watchdogConversationId === 'number' ? index.watchdogConversationId : undefined
  const workers = parseWorkers(index)

  return (
    <div className="screen-container">
      <div className="screen-section-title">
        <Network size={13} strokeWidth={1.75} />
        <span>SuperAgent 中枢</span>
      </div>
      <div className="sa-widget-muted">
        修改路由开关、静默事件源与看门狗参数请前往本插件的配置项设置；本面板只读展示托管状态。
      </div>
      {index === undefined ? (
        <DocLoading label="托管状态读取中..." />
      ) : (
        <div className="kv-list">
          <div className="kv-key">中枢会话</div>
          <div className="kv-val">{routerId !== undefined ? `#${routerId}` : '未自举'}</div>
          <div className="kv-key">看门狗会话</div>
          <div className="kv-val">{watchdogId !== undefined ? `#${watchdogId}` : '未自举'}</div>
          <div className="kv-key">活跃 Worker</div>
          <div className="kv-val">{workers.length}</div>
        </div>
      )}
    </div>
  )
}
