import React, { useEffect, useRef, useState } from 'react'
import type { SkillSummary } from '@helm/protocol'
import { HelmIcon } from '../lib/icons.js'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '../ui/Dialog.js'
import {
  getSkillSourceBadge,
  skillsApi,
} from './skill-center-model.js'

export interface SkillDetailDrawerProps {
  skill: SkillSummary | null
  open: boolean
  onClose: () => void
  /** 显式指定是否内联渲染（便于测试与 SSR 统一断言） */
  inline?: boolean
  /** 初始内容注入（主要供 SSR 测试断言文档区使用） */
  initialContent?: string
  /** 自定义文件读取实现，默认使用 skillsApi.read */
  readSkill?: (id: string, path?: string) => Promise<{ text: string }>
}

/**
 * 全屏技能中心详情与代码预览抽屉组件：
 * - 基于 Radix UI Dialog 封装，520px-560px 右侧滑出抽屉；
 * - 顶部展示图标、名称、来源徽章（内置 / 共享 / 工作区 / 插件）、技能 ID 与关闭按钮；
 * - 支持在主规程 SKILL.md 与 references/*.md 子文件之间无缝切换；
 * - 异步调用 skillsApi.read，使用代数防竞态（loadGenerationRef）防止多任务交错覆盖；
 * - 提供格式化等宽文本阅读区（.skill-file-pre），安全展示 Markdown 与代码文档；
 * - 严格遵循零 Emoji 铁律与 Fast Refresh 规范。
 */
export function SkillDetailDrawer({
  skill,
  open,
  onClose,
  inline = false,
  initialContent,
  readSkill,
}: SkillDetailDrawerProps): React.JSX.Element {
  const [loading, setLoading] = useState(false)
  const [content, setContent] = useState<string>(() => initialContent ?? '')
  const [error, setError] = useState<string | null>(null)
  const [activePath, setActivePath] = useState<string>('')
  const loadGenerationRef = useRef(0)

  // 切换技能时重置到根规程 SKILL.md
  useEffect(() => {
    setActivePath('')
  }, [skill?.id])

  // 异步获取规程文件内容，严格防竞态
  useEffect(() => {
    if (!skill || !open) {
      if (initialContent === undefined) {
        setContent('')
      }
      setError(null)
      setLoading(false)
      return
    }

    const gen = ++loadGenerationRef.current
    setLoading(true)
    setError(null)

    const reader = readSkill ?? skillsApi.read
    reader(skill.id, activePath || undefined)
      .then((res) => {
        if (loadGenerationRef.current === gen) {
          setContent(res.text ?? '')
          setLoading(false)
        }
      })
      .catch((err) => {
        if (loadGenerationRef.current === gen) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      })
  }, [skill?.id, activePath, open, readSkill, initialContent])

  const sourceBadge = skill ? getSkillSourceBadge(skill) : null
  const badgeClass =
    sourceBadge?.variant === 'builtin'
      ? 'badge badge-neutral'
      : sourceBadge?.variant === 'plugin'
        ? 'badge badge-subtle mono'
        : sourceBadge?.variant === 'agents'
          ? 'badge badge-accent'
          : 'badge badge-ghost'

  const references = skill?.references ?? []
  const totalFiles = 1 + references.length

  return (
    <Dialog
      open={open}
      inline={inline}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose()
      }}
    >
      <DialogPortal inline={inline}>
        <DialogOverlay className="modal-backdrop primary-drawer-backdrop skill-drawer-backdrop" />
        <DialogContent
          className="primary-drawer-content skill-drawer-content"
          role="dialog"
          aria-label={skill ? `${skill.name || skill.id} 技能详情` : '技能详情'}
        >
          {/* 抽屉顶部头部 */}
          <div className="primary-drawer-header">
            <div className="primary-drawer-header-left">
              <div className="primary-drawer-title-col">
                <div className="primary-drawer-title-row">
                  <DialogTitle className="primary-drawer-title">
                    {skill?.name || skill?.id || '技能详情'}
                  </DialogTitle>
                  {sourceBadge && (
                    <span className={badgeClass} title={`来源：${sourceBadge.label}`}>
                      {sourceBadge.label}
                    </span>
                  )}
                </div>
                {skill && (
                  <div className="primary-drawer-id mono text-subtle text-xs" title={skill.id}>
                    {skill.id}
                  </div>
                )}
                {skill?.source === 'agents' && (
                  <div className="text-subtle text-xs">机器级共享根 · 只读</div>
                )}
              </div>
            </div>
            <DialogClose asChild>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label="关闭"
                title="关闭"
              >
                <HelmIcon name="x" size={14} />
              </button>
            </DialogClose>
          </div>

          {/* 抽屉主体 */}
          <div className="primary-drawer-body">
            {!skill ? (
              <div className="empty-state">未选择技能</div>
            ) : (
              <>
                {/* 简短描述 */}
                {skill.description && (
                  <div className="text-secondary text-sm" style={{ lineHeight: 1.5 }}>
                    {skill.description}
                  </div>
                )}

                {/* 参考文件导航清单 */}
                <div className="skill-files-section flex-col" style={{ gap: 8 }}>
                  <div className="flex-row-between text-subtle text-xs">
                    <div className="flex-row" style={{ gap: 4 }}>
                      <HelmIcon name="folder" size={13} />
                      <span>技能文件清单</span>
                    </div>
                    <span className="badge badge-subtle tabular-nums">{totalFiles}</span>
                  </div>

                  <div
                    className="skill-files-list flex-row-wrap"
                    role="tablist"
                    aria-label="技能文件清单"
                    style={{ gap: 6 }}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activePath === ''}
                      className={`btn btn-sm ${activePath === '' ? 'btn-primary' : 'btn-ghost'}`}
                      style={{ height: 26, fontSize: 12, padding: '0 8px' }}
                      onClick={() => setActivePath('')}
                    >
                      <HelmIcon name="file-text" size={12} />
                      <span className="mono">SKILL.md</span>
                      <span
                        className="badge badge-neutral"
                        style={{ fontSize: 10, padding: '0 4px', height: 16 }}
                      >
                        主规程
                      </span>
                    </button>
                    {references.map((ref) => (
                      <button
                        key={ref}
                        type="button"
                        role="tab"
                        aria-selected={activePath === ref}
                        className={`btn btn-sm ${activePath === ref ? 'btn-primary' : 'btn-ghost'}`}
                        style={{ height: 26, fontSize: 12, padding: '0 8px' }}
                        onClick={() => setActivePath(ref)}
                      >
                        <HelmIcon name="file-code" size={12} />
                        <span className="mono">{ref}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* 文档代码预览展示区 */}
                <div className="skill-document-view flex-col flex-1" style={{ gap: 8, minHeight: 0 }}>
                  <div className="flex-row-between text-subtle text-xs">
                    <div className="flex-row mono" style={{ gap: 6 }}>
                      <HelmIcon name={activePath ? 'file-code' : 'file-text'} size={13} />
                      <span>{activePath || 'SKILL.md'}</span>
                    </div>
                    <div className="flex-row" style={{ gap: 8 }}>
                      {loading && (
                        <span className="flex-row text-subtle" style={{ gap: 4 }}>
                          <HelmIcon name="loader" size={12} className="spin" />
                          <span>加载中…</span>
                        </span>
                      )}
                      {content && (
                        <span className="tabular-nums">
                          {`${content.split('\n').length} 行`}
                        </span>
                      )}
                    </div>
                  </div>

                  {error ? (
                    <div className="callout callout--error" role="alert">
                      <HelmIcon name="alert-circle" size={13} />
                      <span>{`读取失败：${error}`}</span>
                    </div>
                  ) : (
                    <pre
                      className="skill-file-pre mono selectable"
                      tabIndex={0}
                      aria-label="文件正文预览"
                    >
                      <code>{content || (loading ? '正在读取技能内容…' : '文件内容为空')}</code>
                    </pre>
                  )}
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
