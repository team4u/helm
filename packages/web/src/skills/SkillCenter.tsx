import React, { useMemo, useState } from 'react'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { SkillCard } from './SkillCard.js'
import { SkillDetailDrawer } from './SkillDetailDrawer.js'
import {
  buildSkillCategoryCounts,
  filterSkills,
  summarizeSkills,
  type SkillCategoryTab,
} from './skill-center-model.js'

export interface SkillCenterProps {
  isSplit?: boolean
  onCloseSplit?: () => void
  /** 显式指定详情抽屉是否内联渲染（便于测试与 SSR 统一断言） */
  inlineDrawer?: boolean
}

const CATEGORY_TABS: Array<{ key: SkillCategoryTab; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'builtin', label: '内置' },
  { key: 'workspace', label: '工作区' },
  { key: 'plugins', label: '插件' },
]

/**
 * 全屏技能中心（Skill Center）主视图容器：
 * - 升格为系统一级全屏视图，统一管理大模型工具技能、规程与代码参考指引；
 * - 顶栏：标题、副标题、分屏操作按钮与技能统计徽章；
 * - 检索栏：输入框支持模糊搜索 ID / 名称 / 描述 / 参考文件路径，联动分类药丸标签；
 * - 响应式卡片网格：消费 SkillCard 呈现流式卡片，零 Emoji；
 * - 详情与文档预览抽屉：联动 SkillDetailDrawer 展示 SKILL.md 与 references/*.md；
 * - 与 URL Hash 深度联动：支持 #/skills?id=<id> 深链直达与浏览器历史栈同步；
 * - 严格遵循零 Emoji 铁律与 Fast Refresh 规范。
 */
export function SkillCenter({
  isSplit = false,
  onCloseSplit,
  inlineDrawer = false,
}: SkillCenterProps): React.JSX.Element {
  const store = useHelmStore()
  const [query, setQuery] = useState('')
  const [activeTab, setActiveTab] = useState<SkillCategoryTab>('all')

  const skills = store.skills ?? []
  const categoryCounts = useMemo(() => buildSkillCategoryCounts(skills), [skills])

  const filteredSkills = useMemo(() => {
    return filterSkills(skills, {
      query,
      categoryTab: activeTab,
    })
  }, [skills, query, activeTab])

  const currentTarget = isSplit ? store.splitTarget : store.primaryTarget
  const selectedSkillId =
    currentTarget && currentTarget.kind === 'skills' ? currentTarget.skillId : undefined

  const selectedSkill = useMemo(
    () => skills.find((s) => s.id === selectedSkillId) ?? null,
    [skills, selectedSkillId],
  )

  const isDrawerOpen = Boolean(selectedSkillId && selectedSkill)

  const handleSelectSkill = (skillId: string) => {
    store.openTarget({ kind: 'skills', skillId }, isSplit ? { split: true } : undefined)
  }

  const handleCloseDrawer = () => {
    store.openTarget({ kind: 'skills' }, isSplit ? { split: true } : undefined)
  }

  return (
    <div className={`primary-center skill-center${isSplit ? ' is-split' : ''}`} data-view="skill-center">
      {/* 顶栏：标题、副标题、统计与分屏操作 */}
      <div className="primary-center-topbar">
        <div className="primary-center-title-wrap">
          <div className="primary-center-title">
            <HelmIcon name="terminal" size={16} />
            <span>技能中心</span>
          </div>
        </div>

        <div className="primary-center-topbar-actions">
          {isSplit && onCloseSplit && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title="关闭分屏"
              aria-label="关闭分屏"
              onClick={onCloseSplit}
            >
              <HelmIcon name="x" size={14} />
            </button>
          )}
        </div>
      </div>

      {/* 检索栏与分类筛选药丸标签 */}
      <div className="primary-center-toolbar">
        <div className="primary-search-box">
          <HelmIcon name="search" size={14} />
          <input
            type="text"
            placeholder="搜索技能名称、ID、描述或参考文件…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索技能"
          />
          {query && (
            <button
              type="button"
              className="btn btn-ghost btn-sm primary-search-clear"
              title="清空搜索"
              aria-label="清空搜索"
              onClick={() => setQuery('')}
            >
              <HelmIcon name="x" size={12} />
            </button>
          )}
        </div>

        <div className="primary-category-pills" role="tablist" aria-label="技能分类筛选">
          {CATEGORY_TABS.map((tab) => {
            const count = categoryCounts[tab.key] ?? 0
            const isActive = activeTab === tab.key
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`primary-category-pill${isActive ? ' is-active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
              >
                <span>{tab.label}</span>
                <span className="badge tabular-nums">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* 主视口：响应式卡片网格或空状态 */}
      <div className="primary-center-content">
        {filteredSkills.length > 0 ? (
          <div className="primary-center-grid">
            {filteredSkills.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                selected={selectedSkillId === skill.id}
                onSelect={() => handleSelectSkill(skill.id)}
              />
            ))}
          </div>
        ) : (
          <div className="primary-center-empty">
            <div className="primary-center-empty-icon">
              <HelmIcon name="search" size={28} />
            </div>
            <div className="primary-center-empty-text">未找到匹配的技能</div>
            <div className="primary-center-empty-hint">
              请尝试调整搜索关键字或切换分类标签。
            </div>
            {(query || activeTab !== 'all') && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setQuery('')
                  setActiveTab('all')
                }}
              >
                <HelmIcon name="rotate-ccw" size={12} />
                <span>重置筛选条件</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* 右侧滑出式详情与文档阅读抽屉 */}
      <SkillDetailDrawer
        skill={selectedSkill}
        open={isDrawerOpen}
        onClose={handleCloseDrawer}
        inline={inlineDrawer}
      />
    </div>
  )
}
