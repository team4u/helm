import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { SkillSummary } from '@helm/protocol'
import { HelmIcon } from '../lib/icons.js'
import { CopyButton } from '../conversation/CopyButton.js'
import { CodeBlockView, MarkdownView } from '../conversation/MarkdownView.js'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '../ui/Dialog.js'
import { Select } from '../ui/Select.js'
import type { SelectOption } from '../ui/Select.js'
import {
  getSkillSourceBadge,
  skillsApi,
} from './skill-center-model.js'
import {
  buildSkillFileList,
  isSkillMarkdownFile,
  skillFileLanguage,
  stripMarkdownFrontmatter,
} from './skill-reader-model.js'

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

/** Markdown 文件的阅读模式：富文本渲染或等宽源码。 */
type SkillViewMode = 'rich' | 'source'

/**
 * 全屏技能中心详情与紧凑文件阅读器抽屉组件：
 * - 基于 Radix UI Dialog 封装，520px-560px 右侧滑出抽屉；
 * - 顶部展示图标、名称、来源徽章（内置 / 共享 / 工作区 / 插件）、技能 ID 与关闭按钮；
 * - 单行文件工具条：多文件时以公共 Select 下拉切换（短文件名 + 目录辅助信息），
 *   单文件时直接展示文件名，不再渲染多文件标签墙；
 * - Markdown 文件支持「富文本 / 源码」双模式阅读，富文本模式剥离头部重复展示的
 *   YAML frontmatter；代码类文件用 CodeBlockView 按后缀推导语言高亮；
 * - 异步调用 skillsApi.read，使用代数防竞态（loadGenerationRef）防止多任务交错覆盖；
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
  const [viewMode, setViewMode] = useState<SkillViewMode>('rich')
  const loadGenerationRef = useRef(0)

  const files = useMemo(() => buildSkillFileList(skill?.references), [skill?.references])
  const activeIndex = Math.max(
    0,
    files.findIndex((f) => f.path === activePath),
  )
  const activeFile = files[activeIndex]
  const activeDisplayPath = activeFile?.displayPath ?? 'SKILL.md'
  const isMarkdown = isSkillMarkdownFile(activePath)
  const richText = isMarkdown && viewMode === 'rich'

  // 切换技能时重置到根规程 SKILL.md 与富文本模式
  useEffect(() => {
    setActivePath('')
    setViewMode('rich')
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
        ? 'badge badge-neutral mono'
        : sourceBadge?.variant === 'agents'
          ? 'badge badge-accent'
          : 'badge badge-ghost'

  const fileOptions: Array<SelectOption<string>> = files.map((f) => ({
    value: f.path,
    label: f.fileName,
    meta: f.meta,
  }))

  const displayText = richText ? stripMarkdownFrontmatter(content) : content
  const sourceLanguage = skillFileLanguage(activePath)
  const lineCount = content === '' ? 0 : content.split('\n').length

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
                  <div className="text-subtle text-xs">机器级共享根</div>
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
                  <div className="skill-reader-desc">{skill.description}</div>
                )}

                {/* 紧凑文件阅读器：单行工具条 + 正文阅读区 */}
                <div className="skill-reader">
                  <div className="skill-reader-toolbar" role="group" aria-label="技能文件阅读工具条">
                    <div className="skill-reader-file">
                      {files.length > 1 ? (
                        <Select
                          className="skill-file-select"
                          size="sm"
                          inline={inline}
                          value={activePath}
                          options={fileOptions}
                          onChange={(ev) => setActivePath(ev.target.value)}
                          aria-label="选择技能文件"
                          prefixIcon="file-text"
                        />
                      ) : (
                        <span className="skill-reader-file-label mono" title={activeDisplayPath}>
                          <HelmIcon name={isMarkdown ? 'file-text' : 'file-code'} size={13} />
                          <span>{activeDisplayPath}</span>
                        </span>
                      )}
                    </div>

                    <div className="skill-reader-toolbar-meta">
                      {loading && (
                        <span className="skill-reader-loading text-subtle">
                          <HelmIcon name="loader" size={12} className="spin" />
                          <span>加载中…</span>
                        </span>
                      )}
                      {isMarkdown && (
                        <div
                          className="segmented-control skill-reader-mode"
                          role="group"
                          aria-label="阅读模式"
                        >
                          <button
                            type="button"
                            className="segmented-control-btn"
                            aria-pressed={richText}
                            title="Markdown 富文本阅读"
                            onClick={() => setViewMode('rich')}
                          >
                            <HelmIcon name="eye" size={12} />
                            <span>富文本</span>
                          </button>
                          <button
                            type="button"
                            className="segmented-control-btn"
                            aria-pressed={viewMode === 'source'}
                            title="查看等宽源码"
                            onClick={() => setViewMode('source')}
                          >
                            <HelmIcon name="code" size={12} />
                            <span>源码</span>
                          </button>
                        </div>
                      )}
                      <span
                        className="badge badge-neutral tabular-nums skill-reader-index"
                        title={`第 ${activeIndex + 1} 个文件，共 ${files.length} 个`}
                      >
                        {`${activeIndex + 1}/${files.length}`}
                      </span>
                      <span className="skill-reader-lines tabular-nums" title={`${activeDisplayPath} 总行数`}>
                        {lineCount > 0 ? `${lineCount} 行` : '--'}
                      </span>
                      <CopyButton text={content} label="复制" />
                    </div>
                  </div>

                  {/* 正文阅读区 */}
                  <div className="skill-reader-body" data-mode={richText ? 'rich' : 'source'}>
                    {error ? (
                      <div className="callout callout--error" role="alert">
                        <HelmIcon name="alert-circle" size={13} />
                        <span>{`读取失败：${error}`}</span>
                      </div>
                    ) : loading && content === '' ? (
                      <div className="skill-reader-placeholder text-subtle">
                        <HelmIcon name="loader" size={13} className="spin" />
                        <span>正在读取技能内容…</span>
                      </div>
                    ) : content === '' ? (
                      <div className="skill-reader-placeholder text-subtle">文件内容为空</div>
                    ) : richText ? (
                      <div className="skill-reader-doc selectable">
                        <MarkdownView text={displayText} />
                      </div>
                    ) : (
                      <div className="skill-reader-code">
                        <CodeBlockView code={content} language={sourceLanguage} />
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
