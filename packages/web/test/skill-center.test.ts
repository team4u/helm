import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const React = (await import('react')).default
const { act } = await import('react')
const ReactDOMClient = await import('react-dom/client')
const { renderToString } = await import('react-dom/server')

;(globalThis as Record<string, unknown>).React = React

import type { SkillSummary } from '@helm/protocol'
import { HelmStoreContext } from '../src/lib/store-context.js'
import {
  buildSkillCategoryCounts,
  filterSkills,
  getSkillIcon,
  getSkillSourceBadge,
  isSkillBuiltin,
  isSkillPlugin,
  isSkillWorkspace,
  summarizeSkills,
  type SkillCategoryTab,
} from '../src/skills/skill-center-model.js'
import { SkillCard } from '../src/skills/SkillCard.js'
import { SkillDetailDrawer } from '../src/skills/SkillDetailDrawer.js'
import { SkillCenter } from '../src/skills/SkillCenter.js'
import { makeTestStore } from './helpers/store.js'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const e = React.createElement
const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u

function typeIntoInput(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  const tracker = (input as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
  const prev = tracker?.getValue() ?? ''
  setter?.call(input, text)
  tracker?.setValue(prev)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function makeSkill(partial: Partial<SkillSummary> & { id: string }): SkillSummary {
  return {
    name: partial.name ?? partial.id,
    description: partial.description ?? '测试技能描述',
    references: partial.references ?? [],
    ...partial,
  }
}

const mockSkills: [SkillSummary, SkillSummary, SkillSummary, SkillSummary, SkillSummary] = [
  makeSkill({
    id: 'helm-cli',
    name: 'Helm 命令行操作手册',
    description: '指导大模型通过 helm 命令行控制 Hub、检查状态与排查问题',
    references: ['references/cli-reference.md', 'references/generative-ui.md'],
    managedByPlugin: 'builtin:assistant',
  }),
  makeSkill({
    id: 'code-review',
    name: '工程代码审查规范',
    description: '自动化审查 PR 代码规范、单元测试覆盖率与类型安全',
    references: ['references/checklist.md'],
  }),
  makeSkill({
    id: 'database-migration',
    name: '数据库迁移演练',
    description: 'SQLite 与 PostgreSQL 数据库结构平滑变更与回滚规程',
    references: [],
  }),
  makeSkill({
    id: 'herdr-deploy',
    name: 'Herdr 集群发布',
    description: '多节点容器部署与健康检查',
    references: ['references/cluster.md', 'references/health.md'],
    managedByPlugin: 'builtin:herdr',
  }),
  makeSkill({
    id: 'community-linter',
    name: '社区语法分析器',
    description: '基于 ESLint 与 Prettier 的第三方静态代码分析规则',
    references: ['references/rules.md'],
    managedByPlugin: 'community:linter',
  }),
]

// ---------------------------------------------------------------------------
// 1. 纯函数模型测试 (skill-center-model.ts)
// ---------------------------------------------------------------------------

test('skill-center-model: 技能类别判定纯函数（内置 / 插件 / 工作区）', { timeout: 60_000 }, () => {
  const builtinAssistant = makeSkill({ id: 'assistant-helper', managedByPlugin: 'builtin:assistant' })
  const builtinCli = makeSkill({ id: 'helm-cli' })
  const pluginManaged = makeSkill({ id: 'custom-skill', managedByPlugin: 'vendor:tools' })
  const workspacePrivate = makeSkill({ id: 'my-private-skill' })

  // 内置判定
  assert.equal(isSkillBuiltin(builtinAssistant), true)
  assert.equal(isSkillBuiltin(builtinCli), true)
  assert.equal(isSkillBuiltin(pluginManaged), false)
  assert.equal(isSkillBuiltin(workspacePrivate), false)

  // 插件托管判定
  assert.equal(isSkillPlugin(pluginManaged), true)
  assert.equal(isSkillPlugin(builtinAssistant), false)
  assert.equal(isSkillPlugin(builtinCli), false)
  assert.equal(isSkillPlugin(workspacePrivate), false)

  // 本地工作区私有技能判定
  assert.equal(isSkillWorkspace(workspacePrivate), true)
  assert.equal(isSkillWorkspace(builtinAssistant), false)
  assert.equal(isSkillWorkspace(builtinCli), false)
  assert.equal(isSkillWorkspace(pluginManaged), false)
})

test('skill-center-model: buildSkillCategoryCounts 准确统计各分类数量', { timeout: 60_000 }, () => {
  const counts = buildSkillCategoryCounts(mockSkills)
  // mockSkills 包含：
  // 1. helm-cli (builtin:assistant) -> builtin
  // 2. code-review (无 managedByPlugin) -> workspace
  // 3. database-migration (无 managedByPlugin) -> workspace
  // 4. herdr-deploy (builtin:herdr) -> builtin
  // 5. community-linter (community:linter) -> plugins
  assert.equal(counts.all, 5)
  assert.equal(counts.builtin, 2)
  assert.equal(counts.workspace, 2)
  assert.equal(counts.plugins, 1)

  const emptyCounts = buildSkillCategoryCounts([])
  assert.deepEqual(emptyCounts, { all: 0, builtin: 0, workspace: 0, plugins: 0 })
})

test('skill-center-model: summarizeSkills 指标汇总', { timeout: 60_000 }, () => {
  const summary = summarizeSkills(mockSkills)
  assert.deepEqual(summary, {
    total: 5,
    builtin: 2,
    workspace: 2,
    plugins: 1,
  })
})

test('skill-center-model: filterSkills 分类筛选与多维搜索（ID / 名称 / 描述 / 参考文件）', { timeout: 60_000 }, () => {
  // 分类筛选
  const builtinSkills = filterSkills(mockSkills, { query: '', categoryTab: 'builtin' })
  assert.equal(builtinSkills.length, 2)
  assert.ok(builtinSkills.every((s) => isSkillBuiltin(s)))

  const workspaceSkills = filterSkills(mockSkills, { query: '', categoryTab: 'workspace' })
  assert.equal(workspaceSkills.length, 2)
  assert.ok(workspaceSkills.every((s) => isSkillWorkspace(s)))

  const pluginSkills = filterSkills(mockSkills, { query: '', categoryTab: 'plugins' })
  assert.equal(pluginSkills.length, 1)
  assert.equal(pluginSkills[0]!.id, 'community-linter')

  // 关键字按名称搜索
  const nameSearch = filterSkills(mockSkills, { query: '代码审查', categoryTab: 'all' })
  assert.equal(nameSearch.length, 1)
  assert.equal(nameSearch[0]!.id, 'code-review')

  // 关键字按 ID 搜索
  const idSearch = filterSkills(mockSkills, { query: 'helm-cli', categoryTab: 'all' })
  assert.equal(idSearch.length, 1)
  assert.equal(idSearch[0]!.id, 'helm-cli')

  // 关键字按描述搜索
  const descSearch = filterSkills(mockSkills, { query: 'PostgreSQL', categoryTab: 'all' })
  assert.equal(descSearch.length, 1)
  assert.equal(descSearch[0]!.id, 'database-migration')

  // 关键字按参考文件搜索
  const refSearch = filterSkills(mockSkills, { query: 'generative-ui.md', categoryTab: 'all' })
  assert.equal(refSearch.length, 1)
  assert.equal(refSearch[0]!.id, 'helm-cli')

  // 组合过滤：分类 + 搜索
  const comboMatch = filterSkills(mockSkills, { query: '多节点', categoryTab: 'builtin' })
  assert.equal(comboMatch.length, 1)
  assert.equal(comboMatch[0]!.id, 'herdr-deploy')

  const comboMismatch = filterSkills(mockSkills, { query: '多节点', categoryTab: 'workspace' })
  assert.equal(comboMismatch.length, 0)
})

test('skill-center-model: getSkillIcon 与 getSkillSourceBadge 映射正确', { timeout: 60_000 }, () => {
  const cliSkill = makeSkill({ id: 'helm-cli' })
  assert.equal(getSkillIcon(cliSkill), 'terminal')

  const codeSkill = makeSkill({ id: 'code-review' })
  assert.equal(getSkillIcon(codeSkill), 'file-code')

  const toolSkill = makeSkill({ id: 'custom-tool' })
  assert.equal(getSkillIcon(toolSkill), 'wrench')

  const badgeBuiltin = getSkillSourceBadge(cliSkill)
  assert.equal(badgeBuiltin.label, '内置')
  assert.equal(badgeBuiltin.variant, 'builtin')

  const badgePlugin = getSkillSourceBadge(mockSkills[4])
  assert.equal(badgePlugin.label, 'community:linter')
  assert.equal(badgePlugin.variant, 'plugin')

  const badgeWs = getSkillSourceBadge(codeSkill)
  assert.equal(badgeWs.label, '工作区')
  assert.equal(badgeWs.variant, 'workspace')
})

// ---------------------------------------------------------------------------
// 2. SkillCard 组件测试
// ---------------------------------------------------------------------------

test('SkillCard: SSR 渲染结构、来源徽章、参考文件胶囊与零 Emoji 铁律', { timeout: 60_000 }, () => {
  const skill = mockSkills[0] // helm-cli, 2 references
  const html = renderToString(
    e(SkillCard, {
      skill,
      selected: false,
      onSelect: () => {},
    }),
  )

  // 结构断言
  assert.ok(html.includes('primary-card'), '应包含 primary-card 类名')
  assert.ok(html.includes('skill-card'), '应包含 skill-card 类名')
  assert.ok(html.includes('Helm 命令行操作手册'), '应展示技能名称')
  assert.ok(html.includes('helm-cli'), '应展示技能 ID')
  assert.ok(html.includes('指导大模型通过 helm 命令行控制 Hub'), '应展示描述')
  assert.ok(html.includes('内置'), '系统内建技能应展示「内置」来源徽章')
  assert.ok(html.includes('2 个参考文件'), '应展示 2 个参考文件胶囊')

  // 零 Emoji 断言
  assert.doesNotMatch(html, emojiRegex, 'SkillCard 渲染输出严禁包含 Emoji 表情')
})

test('SkillCard: 选中状态与工作区来源徽章', { timeout: 60_000 }, () => {
  const wsSkill = mockSkills[1] // code-review, workspace, 1 reference
  const html = renderToString(
    e(SkillCard, {
      skill: wsSkill,
      selected: true,
      onSelect: () => {},
    }),
  )

  assert.ok(html.includes('is-selected'), '选中时应具有 is-selected 类')
  assert.ok(html.includes('aria-selected="true"'), '选中时应具备 aria-selected 属性')
  assert.ok(html.includes('工作区'), '私有技能应展示「工作区」来源徽章')
  assert.ok(html.includes('1 个参考文件'), '应展示 1 个参考文件胶囊')
  assert.doesNotMatch(html, emojiRegex, 'SkillCard 渲染输出严禁包含 Emoji')
})

test('SkillCard: 鼠标点击与键盘无障碍交互激活', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  let selectedCount = 0
  const onSelect = () => {
    selectedCount++
  }

  await act(async () => {
    root.render(
      e(SkillCard, {
        skill: mockSkills[0],
        selected: false,
        onSelect,
      }),
    )
  })

  const card = host.querySelector('.skill-card') as HTMLElement
  assert.ok(card, '应能找到卡片 DOM 节点')

  // 点击激活
  await act(async () => {
    card.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  assert.equal(selectedCount, 1, '点击应触发 onSelect')

  // Enter 键激活
  await act(async () => {
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  assert.equal(selectedCount, 2, 'Enter 键应触发 onSelect')

  // Space 键激活
  await act(async () => {
    card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  })
  assert.equal(selectedCount, 3, 'Space 键应触发 onSelect')

  await act(async () => {
    root.unmount()
  })
  host.remove()
})

// ---------------------------------------------------------------------------
// 3. SkillDetailDrawer 组件测试
// ---------------------------------------------------------------------------

test('SkillDetailDrawer: SSR 渲染抽屉主体、元信息、参考文件导航与文档阅读区（零 Emoji）', { timeout: 60_000 }, () => {
  const skill = mockSkills[0]
  const initialContent = '# Helm CLI 技能规范\n\n这是测试用 Markdown 文档正文。'

  const html = renderToString(
    e(SkillDetailDrawer, {
      skill,
      open: true,
      inline: true,
      initialContent,
      onClose: () => {},
    }),
  )

  // 抽屉结构断言
  assert.ok(html.includes('primary-drawer-content'), '应包含 primary-drawer-content')
  assert.ok(html.includes('primary-drawer-title'), '应包含抽屉标题')
  assert.ok(html.includes('Helm 命令行操作手册'), '应展示技能名称')
  assert.ok(html.includes('helm-cli'), '应展示技能 ID')
  assert.ok(html.includes('内置'), '应展示内置来源徽章')

  // 参考文件导航清单
  assert.ok(html.includes('技能文件清单'), '应包含技能文件清单标签')
  assert.ok(html.includes('SKILL.md'), '应展示主规程 SKILL.md')
  assert.ok(html.includes('主规程'), 'SKILL.md 应标记为主规程')
  assert.ok(html.includes('references/cli-reference.md'), '应包含参考文件 1')
  assert.ok(html.includes('references/generative-ui.md'), '应包含参考文件 2')

  // 文档阅读区
  assert.ok(html.includes('skill-file-pre'), '应包含 skill-file-pre 等宽阅读区')
  assert.ok(html.includes('# Helm CLI 技能规范'), '应展示正文 Markdown 内容')

  // 零 Emoji 断言
  assert.doesNotMatch(html, emojiRegex, 'SkillDetailDrawer 渲染输出严禁包含 Emoji 表情')
})

test('SkillDetailDrawer: 未选中技能时渲染空状态', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(SkillDetailDrawer, {
      skill: null,
      open: true,
      inline: true,
      onClose: () => {},
    }),
  )

  assert.ok(html.includes('未选择技能'), '应渲染未选择技能空状态')
  assert.doesNotMatch(html, emojiRegex, '空状态严禁包含 Emoji')
})

test('SkillDetailDrawer: 异步读取文件正文与代数防竞态 (loadGenerationRef)', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  let readCalls: Array<{ id: string; path?: string }> = []
  const customReader = async (id: string, path?: string) => {
    readCalls.push({ id, path })
    return { text: `内容来自 ${id} 路径 ${path ?? 'SKILL.md'}` }
  }

  await act(async () => {
    root.render(
      e(SkillDetailDrawer, {
        skill: mockSkills[0],
        open: true,
        inline: true,
        readSkill: customReader,
        onClose: () => {},
      }),
    )
  })

  // 初始加载 SKILL.md
  assert.equal(readCalls.length, 1)
  assert.equal(readCalls[0]!.id, 'helm-cli')
  assert.equal(readCalls[0]!.path, undefined)

  const pre = host.querySelector('.skill-file-pre') as HTMLElement
  assert.ok(pre.textContent?.includes('内容来自 helm-cli 路径 SKILL.md'), '应成功加载根文件正文')

  // 点击参考文件标签切换到 references/cli-reference.md
  const refButtons = Array.from(host.querySelectorAll('button[role="tab"]')) as HTMLButtonElement[]
  const refBtn = refButtons.find((btn) => btn.textContent?.includes('cli-reference.md'))
  assert.ok(refBtn, '应能找到参考文件按钮')

  await act(async () => {
    refBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  assert.equal(readCalls.length, 2)
  assert.equal(readCalls[1]!.path, 'references/cli-reference.md')
  assert.ok(
    pre.textContent?.includes('内容来自 helm-cli 路径 references/cli-reference.md'),
    '应更新展示参考文件正文',
  )

  // 竞态模拟：发起慢请求后立即发起新请求，慢请求返回不应覆盖新请求
  let slowResolve: (val: { text: string }) => void = () => {}
  const slowPromise = new Promise<{ text: string }>((resolve) => {
    slowResolve = resolve
  })

  let fastResolve: (val: { text: string }) => void = () => {}
  const fastPromise = new Promise<{ text: string }>((resolve) => {
    fastResolve = resolve
  })

  let callCount = 0
  const racingReader = async () => {
    callCount++
    if (callCount === 1) return slowPromise
    return fastPromise
  }

  await act(async () => {
    root.render(
      e(SkillDetailDrawer, {
        skill: mockSkills[1],
        open: true,
        inline: true,
        readSkill: racingReader,
        onClose: () => {},
      }),
    )
  })

  // 切换文件触发第二个请求
  const tabs = Array.from(host.querySelectorAll('button[role="tab"]')) as HTMLButtonElement[]
  const checklistBtn = tabs.find((b) => b.textContent?.includes('checklist.md'))
  if (checklistBtn) {
    await act(async () => {
      checklistBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  // 先完成第二个（快速）请求
  await act(async () => {
    fastResolve({ text: '快速新请求内容' })
  })
  assert.ok(pre.textContent?.includes('快速新请求内容'), '新请求结果已显示')

  // 后完成第一个（慢速）请求，验证不会倒退覆盖
  await act(async () => {
    slowResolve({ text: '过期的慢请求内容' })
  })
  assert.ok(
    !pre.textContent?.includes('过期的慢请求内容'),
    '旧请求即便稍后返回也不得覆盖新请求结果',
  )

  await act(async () => {
    root.unmount()
  })
  host.remove()
})

// ---------------------------------------------------------------------------
// 4. SkillCenter 组件测试
// ---------------------------------------------------------------------------

test('SkillCenter: SSR 渲染顶栏、检索栏、网格流与零 Emoji 铁律', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    skills: mockSkills,
    primaryTarget: { kind: 'skills' },
  })

  const html = renderToString(
    e(
      HelmStoreContext.Provider,
      { value: store },
      e(SkillCenter, { inlineDrawer: true }),
    ),
  )

  // 顶栏断言
  assert.ok(html.includes('primary-center-topbar'), '应包含 primary-center-topbar 顶栏')
  assert.ok(html.includes('技能中心'), '应展示技能中心标题')
  assert.ok(
    html.includes('管理大模型工具技能、规程与代码参考指引'),
    '应展示副标题',
  )
  assert.ok(html.includes('共 5 个技能'), '应展示总计技能数')
  assert.ok(html.includes('2 个内置'), '应展示内置技能数')
  assert.ok(html.includes('2 个工作区'), '应展示工作区技能数')

  // 检索栏与分类标签
  assert.ok(html.includes('primary-center-toolbar'), '应包含 primary-center-toolbar 工具栏')
  assert.ok(html.includes('搜索技能名称、ID、描述或参考文件'), '应包含搜索框占位符')
  assert.ok(html.includes('primary-category-pill'), '应包含分类筛选标签')
  assert.ok(html.includes('全部'), '应包含全部标签')
  assert.ok(html.includes('内置'), '应包含内置标签')
  assert.ok(html.includes('工作区'), '应包含工作区标签')
  assert.ok(html.includes('插件'), '应包含插件标签')

  // 卡片网格
  assert.ok(html.includes('primary-center-grid'), '应包含 primary-center-grid 卡片网格')
  assert.ok(html.includes('Helm 命令行操作手册'), '网格中应渲染 mock 技能卡片')
  assert.ok(html.includes('工程代码审查规范'), '网格中应渲染 mock 技能卡片')

  // 零 Emoji 断言
  assert.doesNotMatch(html, emojiRegex, 'SkillCenter 全界面渲染输出严禁包含 Emoji 表情')
})

test('SkillCenter: 当无匹配项时渲染空状态且零 Emoji', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    skills: [],
    primaryTarget: { kind: 'skills' },
  })

  const html = renderToString(
    e(
      HelmStoreContext.Provider,
      { value: store },
      e(SkillCenter, { inlineDrawer: true }),
    ),
  )

  assert.ok(html.includes('primary-center-empty'), '无数据时应渲染 primary-center-empty')
  assert.ok(html.includes('未找到匹配的技能'), '应提示未找到匹配技能')
  assert.doesNotMatch(html, emojiRegex, '空状态严禁包含 Emoji')
})

test('SkillCenter: 交互过滤、搜索与抽屉联动 (openTarget)', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const openTargetCalls: Array<{ target: unknown; opts?: unknown }> = []
  const store = makeTestStore({
    skills: mockSkills,
    primaryTarget: { kind: 'skills' },
    openTarget: (target, opts) => {
      openTargetCalls.push({ target, opts })
    },
  })

  await act(async () => {
    root.render(
      e(
        HelmStoreContext.Provider,
        { value: store },
        e(SkillCenter, { inlineDrawer: true }),
      ),
    )
  })

  // 1. 搜索过滤联动
  const searchInput = host.querySelector('.primary-search-box input') as HTMLInputElement
  assert.ok(searchInput, '应找到搜索框')

  await act(async () => {
    typeIntoInput(searchInput, 'PostgreSQL')
  })

  let cards = host.querySelectorAll('.skill-card')
  assert.equal(cards.length, 1, '搜索 PostgreSQL 应仅过滤出一张卡片')
  assert.ok(cards[0]!.textContent?.includes('数据库迁移演练'))

  // 2. 清空搜索
  const clearBtn = host.querySelector('.primary-search-clear') as HTMLButtonElement
  assert.ok(clearBtn, '应出现清空搜索按钮')
  await act(async () => {
    clearBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  cards = host.querySelectorAll('.skill-card')
  assert.equal(cards.length, 5, '清空搜索后恢复全量卡片')

  // 3. 点击分类药丸标签过滤
  const pills = Array.from(host.querySelectorAll('.primary-category-pill')) as HTMLButtonElement[]
  const builtinPill = pills.find((p) => p.textContent?.includes('内置'))
  assert.ok(builtinPill, '应找到内置分类标签')

  await act(async () => {
    builtinPill.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  cards = host.querySelectorAll('.skill-card')
  assert.equal(cards.length, 2, '内置分类下应仅展示 2 个内置技能')

  // 4. 点击卡片触发 openTarget 打开抽屉
  await act(async () => {
    cards[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  assert.ok(openTargetCalls.length > 0, '点击卡片应调用 openTarget')
  const lastCall = openTargetCalls[openTargetCalls.length - 1]
  assert.ok(lastCall)
  assert.deepEqual(lastCall.target, { kind: 'skills', skillId: 'helm-cli' })

  await act(async () => {
    root.unmount()
  })
  host.remove()
})

// ---------------------------------------------------------------------------
// 5. 源码静态规范契约：零 Emoji 铁律与 Fast Refresh
// ---------------------------------------------------------------------------

test('静态规范契约：所有技能模块源码 0 Emoji 且保 Fast Refresh', { timeout: 60_000 }, () => {
  const modelSrc = readFileSync(join(PKG_ROOT, 'src/skills/skill-center-model.ts'), 'utf-8')
  const cardSrc = readFileSync(join(PKG_ROOT, 'src/skills/SkillCard.tsx'), 'utf-8')
  const drawerSrc = readFileSync(join(PKG_ROOT, 'src/skills/SkillDetailDrawer.tsx'), 'utf-8')
  const centerSrc = readFileSync(join(PKG_ROOT, 'src/skills/SkillCenter.tsx'), 'utf-8')

  assert.doesNotMatch(modelSrc, emojiRegex, 'skill-center-model.ts 源码严禁包含 Emoji')
  assert.doesNotMatch(cardSrc, emojiRegex, 'SkillCard.tsx 源码严禁包含 Emoji')
  assert.doesNotMatch(drawerSrc, emojiRegex, 'SkillDetailDrawer.tsx 源码严禁包含 Emoji')
  assert.doesNotMatch(centerSrc, emojiRegex, 'SkillCenter.tsx 源码严禁包含 Emoji')

  // Fast Refresh 检查：.tsx 仅导出组件与 TS 类型声明
  const cardExports = cardSrc.match(/^export (?!interface|type)\s+(\w+)\s+([A-Za-z0-9_]+)/gm) ?? []
  assert.ok(
    cardExports.every((exp) => exp.includes('function SkillCard')),
    'SkillCard.tsx 只导出 SkillCard 组件与类型',
  )

  const drawerExports = drawerSrc.match(/^export (?!interface|type)\s+(\w+)\s+([A-Za-z0-9_]+)/gm) ?? []
  assert.ok(
    drawerExports.every((exp) => exp.includes('function SkillDetailDrawer')),
    'SkillDetailDrawer.tsx 只导出 SkillDetailDrawer 组件与类型',
  )

  const centerExports = centerSrc.match(/^export (?!interface|type)\s+(\w+)\s+([A-Za-z0-9_]+)/gm) ?? []
  assert.ok(
    centerExports.every((exp) => exp.includes('function SkillCenter')),
    'SkillCenter.tsx 只导出 SkillCenter 组件与类型',
  )
})
