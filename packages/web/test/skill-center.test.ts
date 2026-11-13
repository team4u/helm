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
  getSkillSourceBadge,
  isSkillAgents,
  isSkillBuiltin,
  isSkillPlugin,
  isSkillWorkspace,
  summarizeSkills,
  type SkillCategoryTab,
} from '../src/skills/skill-center-model.js'
import { SkillCard } from '../src/skills/SkillCard.js'
import {
  buildSkillFileList,
  extractSkillFrontmatter,
  isSkillMarkdownFile,
  renderSkillDocMarkdown,
  renderSkillFrontmatterTable,
  skillFileBasename,
  skillFileLanguage,
} from '../src/skills/skill-reader-model.js'
import { makeTestStore } from './helpers/store.js'

// 抽屉与技能中心携带 @radix-ui/react-select 依赖图，须在 happy-dom
// GlobalRegistrator.register() 之后动态加载（与 select.test.ts 同一约定），
// 否则 Radix Select 下拉浮层在预注册环境中无法展开。
const { SkillDetailDrawer } = await import('../src/skills/SkillDetailDrawer.js')
const { SkillCenter } = await import('../src/skills/SkillCenter.js')

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

/** 在真实宿主 store 上下文内渲染抽屉（MarkdownView 依赖 useHelmStore）。 */
function renderDrawerElement(props: React.ReactElement): React.ReactElement {
  return e(HelmStoreContext.Provider, { value: makeTestStore() }, props)
}

/** 通过键盘交互打开文件选择器并选中指定选项（Radix Select 无原生 select）。 */
async function chooseFileOption(host: HTMLElement, optionText: string): Promise<void> {
  const trigger = host.querySelector('.skill-file-select .helm-select-trigger') as HTMLElement | null
  assert.ok(trigger, '应渲染文件选择器触发器')
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  const options = Array.from(host.querySelectorAll('[role="option"]')) as HTMLElement[]
  const target = options.find((el) => el.textContent?.includes(optionText))
  assert.ok(target, `下拉选项中应包含 ${optionText}`)
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
}

const mockSkills: [SkillSummary, SkillSummary, SkillSummary, SkillSummary, SkillSummary, SkillSummary] = [
  makeSkill({
    id: 'helm-cli',
    name: 'Helm 命令行操作手册',
    description: '指导大模型通过 helm 命令行控制 Hub、检查状态与排查问题',
    references: ['references/cli-reference.md', 'references/generative-ui.md'],
    managedByPlugin: 'builtin:profile',
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
  makeSkill({
    id: 'git-commit',
    name: 'Git 提交信息生成',
    description: '生成符合规范的中文 Git 提交信息',
    references: [],
    source: 'agents',
  }),
]

// ---------------------------------------------------------------------------
// 1. 纯函数模型测试 (skill-center-model.ts)
// ---------------------------------------------------------------------------

test('skill-center-model: 技能类别判定纯函数（内置 / 插件 / 共享 / 工作区）', { timeout: 60_000 }, () => {
  const builtinAssistant = makeSkill({ id: 'assistant-helper', managedByPlugin: 'builtin:profile' })
  const builtinCli = makeSkill({ id: 'helm-cli', managedByPlugin: 'builtin:profile' })
  const pluginManaged = makeSkill({ id: 'custom-skill', managedByPlugin: 'vendor:tools' })
  const workspacePrivate = makeSkill({ id: 'my-private-skill' })
  const agentsShared = makeSkill({ id: 'git-commit', source: 'agents' })

  // 内置判定
  assert.equal(isSkillBuiltin(builtinAssistant), true)
  assert.equal(isSkillBuiltin(builtinCli), true)
  assert.equal(isSkillBuiltin(pluginManaged), false)
  assert.equal(isSkillBuiltin(workspacePrivate), false)
  assert.equal(isSkillBuiltin(agentsShared), false)

  // 插件托管判定
  assert.equal(isSkillPlugin(pluginManaged), true)
  assert.equal(isSkillPlugin(builtinAssistant), false)
  assert.equal(isSkillPlugin(builtinCli), false)
  assert.equal(isSkillPlugin(workspacePrivate), false)
  assert.equal(isSkillPlugin(agentsShared), false)

  // 机器级共享根判定
  assert.equal(isSkillAgents(agentsShared), true)
  assert.equal(isSkillAgents(workspacePrivate), false)
  assert.equal(isSkillAgents(builtinCli), false)
  assert.equal(isSkillAgents(pluginManaged), false)

  // 本地工作区私有技能判定（不含共享根来源）
  assert.equal(isSkillWorkspace(workspacePrivate), true)
  assert.equal(isSkillWorkspace(builtinAssistant), false)
  assert.equal(isSkillWorkspace(builtinCli), false)
  assert.equal(isSkillWorkspace(pluginManaged), false)
  assert.equal(isSkillWorkspace(agentsShared), false, '共享根技能不得归入工作区')
})

test('skill-center-model: buildSkillCategoryCounts 准确统计各分类数量', { timeout: 60_000 }, () => {
  const counts = buildSkillCategoryCounts(mockSkills)
  // mockSkills 包含：
  // 1. helm-cli (builtin:profile) -> builtin
  // 2. code-review (无 managedByPlugin) -> workspace
  // 3. database-migration (无 managedByPlugin) -> workspace
  // 4. herdr-deploy (builtin:herdr) -> builtin
  // 5. community-linter (community:linter) -> plugins
  // 6. git-commit (source: agents) -> agents
  assert.equal(counts.all, 6)
  assert.equal(counts.builtin, 2)
  assert.equal(counts.workspace, 2)
  assert.equal(counts.plugins, 1)
  assert.equal(counts.agents, 1)

  const emptyCounts = buildSkillCategoryCounts([])
  assert.deepEqual(emptyCounts, { all: 0, builtin: 0, workspace: 0, plugins: 0, agents: 0 })
})

test('skill-center-model: summarizeSkills 指标汇总', { timeout: 60_000 }, () => {
  const summary = summarizeSkills(mockSkills)
  assert.deepEqual(summary, {
    total: 6,
    builtin: 2,
    workspace: 2,
    plugins: 1,
    agents: 1,
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

  // 机器级共享根分类筛选
  const agentsSkills = filterSkills(mockSkills, { query: '', categoryTab: 'agents' })
  assert.equal(agentsSkills.length, 1)
  assert.equal(agentsSkills[0]!.id, 'git-commit')
  assert.ok(agentsSkills.every((s) => isSkillAgents(s)))

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

test('skill-center-model: getSkillSourceBadge 映射正确', { timeout: 60_000 }, () => {
  const cliSkill = makeSkill({ id: 'helm-cli', managedByPlugin: 'builtin:profile' })
  const codeSkill = makeSkill({ id: 'code-review' })
  const sharedSkill = makeSkill({ id: 'git-commit', source: 'agents' })

  const badgeBuiltin = getSkillSourceBadge(cliSkill)
  assert.equal(badgeBuiltin.label, '内置')
  assert.equal(badgeBuiltin.variant, 'builtin')

  const badgePlugin = getSkillSourceBadge(mockSkills[4])
  assert.equal(badgePlugin.label, 'community:linter')
  assert.equal(badgePlugin.variant, 'plugin')

  const badgeWs = getSkillSourceBadge(codeSkill)
  assert.equal(badgeWs.label, '工作区')
  assert.equal(badgeWs.variant, 'workspace')

  // 共享根技能优先归入 agents 徽章（即使无 managedByPlugin，也不冒充工作区）
  const badgeAgents = getSkillSourceBadge(sharedSkill)
  assert.equal(badgeAgents.label, '共享')
  assert.equal(badgeAgents.variant, 'agents')
})

test('skill-reader-model: buildSkillFileList 主规程置顶 + 参考文件短名与目录辅助信息', { timeout: 60_000 }, () => {
  const files = buildSkillFileList(['references/cli-reference.md', 'scripts/deploy.py'])
  assert.equal(files.length, 3)

  // 主规程置顶：读取路径为空串，展示名固定 SKILL.md
  assert.deepEqual(files[0], {
    path: '',
    fileName: 'SKILL.md',
    meta: '主规程',
    displayPath: 'SKILL.md',
  })

  // 参考文件：短文件名 + 目录辅助信息 + 完整路径
  assert.deepEqual(files[1], {
    path: 'references/cli-reference.md',
    fileName: 'cli-reference.md',
    meta: 'references/',
    displayPath: 'references/cli-reference.md',
  })
  assert.deepEqual(files[2], {
    path: 'scripts/deploy.py',
    fileName: 'deploy.py',
    meta: 'scripts/',
    displayPath: 'scripts/deploy.py',
  })

  // 根目录文件目录信息回退 ./；空与非法项被过滤；空清单仅剩主规程
  assert.deepEqual(buildSkillFileList(['notes.md']), [
    { path: '', fileName: 'SKILL.md', meta: '主规程', displayPath: 'SKILL.md' },
    { path: 'notes.md', fileName: 'notes.md', meta: './', displayPath: 'notes.md' },
  ])
  assert.equal(buildSkillFileList(['', '   ', undefined as unknown as string]).length, 1)
  assert.equal(buildSkillFileList(undefined).length, 1)
  assert.equal(buildSkillFileList(null).length, 1)
})

test('skill-reader-model: skillFileBasename 与 isSkillMarkdownFile 判定', { timeout: 60_000 }, () => {
  assert.equal(skillFileBasename('references/cli-reference.md'), 'cli-reference.md')
  assert.equal(skillFileBasename('SKILL.md'), 'SKILL.md')
  assert.equal(skillFileBasename('deploy.py?v=2'), 'deploy.py')
  assert.equal(skillFileBasename(''), '')

  // 空串视为主规程 SKILL.md，按 Markdown 渲染
  assert.equal(isSkillMarkdownFile(''), true)
  assert.equal(isSkillMarkdownFile('SKILL.md'), true)
  assert.equal(isSkillMarkdownFile('references/guide.MARKDOWN'), true)
  assert.equal(isSkillMarkdownFile('scripts/deploy.py'), false)
  assert.equal(isSkillMarkdownFile('config.json'), false)
})

test('skill-reader-model: extractSkillFrontmatter 解析字段序列与正文（单行标量 / 块标量 / 引号）', { timeout: 60_000 }, () => {
  // 常规 frontmatter：字段按原 YAML 顺序保留，正文剥离围栏与后续空行
  const doc = extractSkillFrontmatter(
    '---\nname: helm-cli\ndescription: 手册\nmanagedByPlugin: builtin:profile\n---\n\n# 正文\n\n段落。',
  )
  assert.deepEqual(doc, {
    fields: [
      { key: 'name', value: 'helm-cli' },
      { key: 'description', value: '手册' },
      { key: 'managedByPlugin', value: 'builtin:profile' },
    ],
    body: '# 正文\n\n段落。',
  })

  // ... 围栏结束同样支持
  assert.deepEqual(extractSkillFrontmatter('---\nname: x\n...\n# 标题'), {
    fields: [{ key: 'name', value: 'x' }],
    body: '# 标题',
  })

  // 未闭合 / 无围栏 / 非围栏分隔线：返回 null，调用方原文回退
  assert.equal(extractSkillFrontmatter('---\nname: x\n# 正文'), null)
  assert.equal(extractSkillFrontmatter('# 标题\n\n正文'), null)
  assert.equal(extractSkillFrontmatter('----\nname: x\n----\n# 正文'), null)
  assert.equal(extractSkillFrontmatter(''), null)

  // 块标量：折叠型 > / >- 空格拼接，保留型 | / |- 换行拼接（语义对齐 kernel parser）
  assert.deepEqual(
    extractSkillFrontmatter('---\ndescription: >\n  第一行\n  第二行\n---\n正文')?.fields,
    [{ key: 'description', value: '第一行 第二行' }],
  )
  assert.deepEqual(
    extractSkillFrontmatter('---\ndescription: >-\n  甲\n\n  乙\nname: x\n---\n正文')?.fields,
    [
      { key: 'description', value: '甲 乙' },
      { key: 'name', value: 'x' },
    ],
  )
  assert.deepEqual(
    extractSkillFrontmatter('---\ndescription: |\n  第一行\n  第二行\n---\n正文')?.fields,
    [{ key: 'description', value: '第一行\n第二行' }],
  )
  assert.deepEqual(
    extractSkillFrontmatter('---\ndescription: |-\n  甲\n  乙\nname: x\n---\n正文')?.fields,
    [
      { key: 'description', value: '甲\n乙' },
      { key: 'name', value: 'x' },
    ],
  )

  // 单行值剥首尾对称引号与转义还原；不对称引号原样保留
  assert.deepEqual(
    extractSkillFrontmatter('---\nname: "quoted name"\ndescription: \'It\'\'s fine\'\n---\n正文')?.fields,
    [
      { key: 'name', value: 'quoted name' },
      { key: 'description', value: "It's fine" },
    ],
  )
  assert.deepEqual(
    extractSkillFrontmatter('---\nname: a"b\n---\n正文')?.fields,
    [{ key: 'name', value: 'a"b' }],
  )

  // 注释与空行不匹配键模式，跳过不进字段序列
  assert.deepEqual(
    extractSkillFrontmatter('---\n# 注释\nname: x\n\nlicense: MIT\n---\n正文')?.fields.map((f) => f.key),
    ['name', 'license'],
  )

  // 全部为 frontmatter 时正文为空串；空 frontmatter 字段序列为空
  assert.deepEqual(extractSkillFrontmatter('---\nname: x\n---\n'), {
    fields: [{ key: 'name', value: 'x' }],
    body: '',
  })
  assert.deepEqual(extractSkillFrontmatter('---\n---\n# 正文'), { fields: [], body: '# 正文' })
})

test('skill-reader-model: renderSkillFrontmatterTable 字段按序转为元数据表格且特殊字符安全', { timeout: 60_000 }, () => {
  // 常规转换：标题 + 表头 + 字段行，顺序保留
  assert.equal(
    renderSkillFrontmatterTable([
      { key: 'name', value: 'agent-browser' },
      { key: 'description', value: 'Browser automation CLI' },
      { key: 'managedByPlugin', value: 'builtin:profile' },
    ]),
    [
      '## 技能元数据',
      '',
      '| 字段 | 内容 |',
      '| --- | --- |',
      '| name | agent-browser |',
      '| description | Browser automation CLI |',
      '| managedByPlugin | builtin:profile |',
    ].join('\n'),
  )

  // 空字段序列返回空串（无可渲染内容，不注入空表）
  assert.equal(renderSkillFrontmatterTable([]), '')

  // 特殊字符安全转义：竖线 / 换行 / 尖括号 / 与号 / 反斜杠均不破坏表格列结构
  const escaped = renderSkillFrontmatterTable([
    { key: 'description', value: 'a | b\nsecond <hr> & "x" \\y' },
  ])
  assert.ok(
    escaped.includes('| description | a \\| b second &lt;hr> &amp; "x" \\\\y |'),
    '竖线转义、换行折空格、< 转字符引用、& 转义、反斜杠加倍',
  )
  // 转义后单元格仍为单行（换行折叠为空格，不破坏 GFM 表格行结构）
  const cell = escaped.split('\n').find((l) => l.startsWith('| description |'))
  assert.ok(cell !== undefined && !/\r|\n/.test(cell), '元数据单元格必须单行')
})

test('skill-reader-model: renderSkillDocMarkdown 统一文档视图（表格 + 正文同流，未闭合回退）', { timeout: 60_000 }, () => {
  // 带 frontmatter：元数据表格在前，正文紧随其后
  assert.equal(
    renderSkillDocMarkdown('---\nname: helm-cli\ndescription: 手册\n---\n\n# 正文\n\n段落。'),
    [
      '## 技能元数据',
      '',
      '| 字段 | 内容 |',
      '| --- | --- |',
      '| name | helm-cli |',
      '| description | 手册 |',
      '',
      '# 正文',
      '',
      '段落。',
    ].join('\n'),
  )

  // 无 frontmatter：正文原样返回
  assert.equal(renderSkillDocMarkdown('# 标题\n\n正文'), '# 标题\n\n正文')

  // 未闭合 frontmatter：原文回退，绝不截断正文
  const unclosed = '---\nname: x\n# 正文'
  assert.equal(renderSkillDocMarkdown(unclosed), unclosed)

  // 非围栏分隔线开头：不误伤，原文返回
  const dashes = '----\nname: x\n----\n# 正文'
  assert.equal(renderSkillDocMarkdown(dashes), dashes)

  // 只有 frontmatter：仅元数据表格
  assert.equal(
    renderSkillDocMarkdown('---\nname: x\n---\n'),
    '## 技能元数据\n\n| 字段 | 内容 |\n| --- | --- |\n| name | x |',
  )

  // 空 frontmatter（无字段）：正文原样，不注入空表
  assert.equal(renderSkillDocMarkdown('---\n---\n# 正文'), '# 正文')
})

test('skill-reader-model: skillFileLanguage 按后缀推导语法语言', { timeout: 60_000 }, () => {
  assert.equal(skillFileLanguage(''), 'markdown')
  assert.equal(skillFileLanguage('references/guide.md'), 'markdown')
  assert.equal(skillFileLanguage('scripts/deploy.py'), 'python')
  assert.equal(skillFileLanguage('configs/setup.json'), 'json')
  assert.equal(skillFileLanguage('bin/run.sh'), 'bash')
  // 无法识别返回空串（回退普通等宽样式，不猜造语言）
  assert.equal(skillFileLanguage('assets/unknown.custom'), '')
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

test('SkillCard: 共享根技能展示「共享」徽章与强调色样式', { timeout: 60_000 }, () => {
  const sharedSkill = mockSkills[5] // git-commit, source: agents
  const html = renderToString(
    e(SkillCard, {
      skill: sharedSkill,
      selected: false,
      onSelect: () => {},
    }),
  )

  assert.ok(html.includes('badge-accent'), '共享根技能应使用 badge-accent 徽章样式')
  assert.ok(html.includes('共享'), '共享根技能应展示「共享」来源徽章')
  assert.ok(!html.includes('工作区'), '共享根技能不得展示「工作区」徽章')
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
// 4. SkillDetailDrawer 组件测试（紧凑文件阅读器）
// ---------------------------------------------------------------------------

test('SkillDetailDrawer: SSR 渲染单行文件工具条与富文本阅读区（不再渲染标签墙，零 Emoji）', { timeout: 60_000 }, () => {
  const skill = mockSkills[0]
  const initialContent = '# Helm CLI 技能规范\n\n这是测试用 Markdown 文档正文。'

  const html = renderToString(
    renderDrawerElement(
      e(SkillDetailDrawer, {
        skill,
        open: true,
        inline: true,
        initialContent,
        onClose: () => {},
      }),
    ),
  )

  // 抽屉结构断言
  assert.ok(html.includes('primary-drawer-content'), '应包含 primary-drawer-content')
  assert.ok(html.includes('primary-drawer-title'), '应包含抽屉标题')
  assert.ok(html.includes('Helm 命令行操作手册'), '应展示技能名称')
  assert.ok(html.includes('helm-cli'), '应展示技能 ID')
  assert.ok(html.includes('内置'), '应展示内置来源徽章')

  // 单行文件工具条：公共 Select 触发器 + 阅读模式切换 + 文件序号与行数
  assert.ok(html.includes('skill-reader-toolbar'), '应包含 skill-reader-toolbar 工具条')
  assert.ok(html.includes('helm-select-trigger'), '多文件时应使用公共 Select 下拉选择器')
  assert.ok(html.includes('aria-label="选择技能文件"'), '文件选择器应具备无障碍标签')
  assert.ok(html.includes('SKILL.md'), '触发器应展示当前文件短名 SKILL.md')
  assert.ok(html.includes('富文本'), '应提供富文本阅读模式按钮')
  assert.ok(html.includes('源码'), '应提供源码阅读模式按钮')
  assert.ok(html.includes('1/3'), '应展示文件序号 1/3')
  assert.ok(html.includes('3 行'), '应展示当前文件行数')
  assert.ok(html.includes('aria-label="复制"'), '工具条应提供复制按钮')

  // 标签墙已移除：不再渲染任何 role=tab 文件按钮与文件清单区块
  assert.ok(!html.includes('role="tab"'), '不得再渲染多文件标签墙（role=tab）')
  assert.ok(!html.includes('技能文件清单'), '不得再渲染文件清单区块')

  // 富文本阅读区：MarkdownView 渲染标题与正文，默认不出现原始 Markdown 井号标记
  assert.ok(html.includes('skill-reader-doc'), '应包含 skill-reader-doc 富文本阅读区')
  assert.ok(html.includes('msg-ai-body'), '富文本模式应复用 MarkdownView 渲染')
  assert.ok(html.includes('Helm CLI 技能规范</h1>'), '应渲染 Markdown 标题')
  assert.ok(html.includes('这是测试用 Markdown 文档正文。'), '应渲染正文段落')
  assert.ok(!html.includes('# Helm CLI 技能规范'), '富文本模式不应展示原始 Markdown 井号标记')

  // 零 Emoji 断言
  assert.doesNotMatch(html, emojiRegex, 'SkillDetailDrawer 渲染输出严禁包含 Emoji 表情')
})

test('SkillDetailDrawer: 富文本模式把 frontmatter 转为元数据表格与正文同流，源码模式保留原文', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const frontmatterDoc =
    '---\nname: helm-cli\ndescription: 头部元信息\nmanagedByPlugin: builtin:profile\n---\n\n# 正文标题\n\n内容段落。'
  const reader = async () => ({ text: frontmatterDoc })

  await act(async () => {
    root.render(
      renderDrawerElement(
        e(SkillDetailDrawer, {
          skill: mockSkills[0],
          open: true,
          inline: true,
          readSkill: reader,
          onClose: () => {},
        }),
      ),
    )
  })

  // 默认富文本：.skill-reader-doc 同一内容流同时包含元数据表格与正文
  const readerBody = host.querySelector('.skill-reader-body') as HTMLElement
  assert.equal(readerBody.getAttribute('data-mode'), 'rich', 'Markdown 文件默认富文本模式')
  const doc = host.querySelector('.skill-reader-doc') as HTMLElement
  assert.ok(doc, '富文本模式应渲染 MarkdownView 阅读区')

  // 元数据表格：标题 + 表头 + 字段行按原 YAML 顺序保留
  assert.ok(doc.textContent?.includes('技能元数据'), '应渲染「技能元数据」标题')
  const table = doc.querySelector('table') as HTMLTableElement
  assert.ok(table, 'frontmatter 应转换为 Markdown 表格渲染')
  const headerCells = Array.from(table.querySelectorAll('thead th')).map((c) => c.textContent)
  assert.deepEqual(headerCells, ['字段', '内容'], '表头应为字段/内容两列')
  const rows = Array.from(table.querySelectorAll('tbody tr')).map(
    (tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent),
  )
  assert.deepEqual(rows, [
    ['name', 'helm-cli'],
    ['description', '头部元信息'],
    ['managedByPlugin', 'builtin:profile'],
  ], '字段按原 YAML 顺序保留')

  // 正文紧随其后，同一内容流；原始 YAML 键值语法不泄漏
  assert.ok(doc.textContent?.includes('正文标题'), 'frontmatter 后的正文应保留')
  assert.ok(doc.textContent?.includes('内容段落。'), '正文段落应保留')
  assert.ok(!doc.textContent?.includes('name: helm-cli'), '不得以 YAML 原文形式展示 frontmatter')
  assert.ok(!doc.textContent?.includes('description: 头部元信息'), 'frontmatter 键值均不得泄漏')
  assert.ok(!doc.textContent?.includes('---'), '富文本模式不得残留围栏分隔线')

  // 切换源码模式：完整原文（含 frontmatter 的 --- 围栏）以等宽代码呈现
  const sourceBtn = Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent?.includes('源码'),
  ) as HTMLButtonElement
  assert.ok(sourceBtn, '应能找到源码模式按钮')
  await act(async () => {
    sourceBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  assert.equal(readerBody.getAttribute('data-mode'), 'source', '点击后应进入源码模式')
  const codeWrap = host.querySelector('.skill-reader-code .code-block-wrap') as HTMLElement
  assert.ok(codeWrap, '源码模式应使用 CodeBlockView 代码块')
  assert.ok(codeWrap.textContent?.includes('---'), '源码模式应保留 YAML frontmatter 的 --- 围栏')
  assert.ok(codeWrap.textContent?.includes('name: helm-cli'), '源码模式应保留 YAML frontmatter 原文')
  assert.ok(codeWrap.textContent?.includes('# 正文标题'), '源码模式应保留正文原文')

  // 切回富文本：表格 + 正文恢复，仍无原始 YAML
  const richBtn = Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent?.includes('富文本'),
  ) as HTMLButtonElement
  await act(async () => {
    richBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  assert.equal(readerBody.getAttribute('data-mode'), 'rich', '可切回富文本模式')
  assert.ok(host.querySelector('.skill-reader-doc table'), '富文本阅读区恢复元数据表格')

  await act(async () => {
    root.unmount()
  })
  host.remove()
})

test('SkillDetailDrawer: 文件下拉选择器切换参考文件与序号/行数联动', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const readCalls: Array<{ id: string; path?: string }> = []
  const library: Record<string, string> = {
    '': '# 主规程\n\n主文件正文。',
    'references/cli-reference.md': '# CLI 参考\n\n命令细节一。\n\n命令细节二。',
    'references/generative-ui.md': '# 生成 UI 参考\n\n卡片细节。',
  }
  const customReader = async (id: string, path?: string) => {
    readCalls.push({ id, path })
    return { text: library[path ?? ''] ?? '' }
  }

  await act(async () => {
    root.render(
      renderDrawerElement(
        e(SkillDetailDrawer, {
          skill: mockSkills[0],
          open: true,
          inline: true,
          readSkill: customReader,
          onClose: () => {},
        }),
      ),
    )
  })

  // 初始加载主规程 SKILL.md，工具条展示序号 1/3 与行数
  assert.equal(readCalls.length, 1)
  assert.equal(readCalls[0]!.id, 'helm-cli')
  assert.equal(readCalls[0]!.path, undefined)
  assert.ok(host.querySelector('.skill-reader-doc')?.textContent?.includes('主规程'), '应加载根文件正文')
  assert.ok(host.querySelector('.skill-reader-index')?.textContent?.includes('1/3'))
  assert.ok(host.querySelector('.skill-reader-lines')?.textContent?.includes('3 行'))

  // 通过下拉选择器切换到 references/cli-reference.md
  await chooseFileOption(host, 'cli-reference.md')
  assert.equal(readCalls.length, 2)
  assert.equal(readCalls[1]!.path, 'references/cli-reference.md')
  assert.ok(
    host.querySelector('.skill-reader-doc')?.textContent?.includes('CLI 参考'),
    '应更新展示参考文件正文',
  )
  assert.ok(host.querySelector('.skill-reader-index')?.textContent?.includes('2/3'))
  assert.ok(host.querySelector('.skill-reader-lines')?.textContent?.includes('5 行'))

  // 切换到末尾参考文件 generative-ui.md，序号推进到 3/3
  await chooseFileOption(host, 'generative-ui.md')
  assert.equal(readCalls.length, 3)
  assert.equal(readCalls[2]!.path, 'references/generative-ui.md')
  assert.ok(host.querySelector('.skill-reader-index')?.textContent?.includes('3/3'))

  await act(async () => {
    root.unmount()
  })
  host.remove()
})

test('SkillDetailDrawer: 非 Markdown 文件用 CodeBlockView 按后缀推导语言，单文件不渲染下拉', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const pySkill = makeSkill({
    id: 'ops-scripts',
    name: '运维脚本集',
    references: ['scripts/deploy.py'],
  })
  const customReader = async (_id: string, path?: string) => ({
    text: path === 'scripts/deploy.py' ? 'print("deploy")' : '# 主规程',
  })

  await act(async () => {
    root.render(
      renderDrawerElement(
        e(SkillDetailDrawer, {
          skill: pySkill,
          open: true,
          inline: true,
          readSkill: customReader,
          onClose: () => {},
        }),
      ),
    )
  })

  // 非 Markdown 文件：无富文本/源码切换，直接代码块呈现并按后缀推导语言
  await chooseFileOption(host, 'deploy.py')
  const body = host.querySelector('.skill-reader-body') as HTMLElement
  assert.equal(body.getAttribute('data-mode'), 'source', '非 Markdown 文件固定源码模式')
  const codeWrap = host.querySelector('.skill-reader-code .code-block-wrap') as HTMLElement
  assert.ok(codeWrap, '应使用 CodeBlockView 展示代码文件')
  assert.ok(codeWrap.querySelector('.code-block-header')?.textContent?.includes('python'), '语言应推导为 python')
  assert.ok(codeWrap.textContent?.includes('print("deploy")'), '应展示代码正文')
  const modeToggle = host.querySelector('.skill-reader-mode')
  assert.equal(modeToggle, null, '非 Markdown 文件不提供阅读模式切换')

  await act(async () => {
    root.unmount()
  })
  host.remove()

  // 单文件技能：不渲染下拉选择器，直接展示文件名与序号 1/1
  const host2 = document.createElement('div')
  document.body.appendChild(host2)
  const root2 = ReactDOMClient.createRoot(host2)
  await act(async () => {
    root2.render(
      renderDrawerElement(
        e(SkillDetailDrawer, {
          skill: mockSkills[2], // database-migration 无参考文件
          open: true,
          inline: true,
          readSkill: async () => ({ text: '# 迁移演练' }),
          onClose: () => {},
        }),
      ),
    )
  })

  assert.equal(host2.querySelector('.skill-file-select'), null, '单文件时不渲染下拉选择器')
  assert.equal(host2.querySelector('.helm-select-trigger'), null, '单文件时无 Select 触发器')
  const fileLabel = host2.querySelector('.skill-reader-file-label') as HTMLElement
  assert.ok(fileLabel.textContent?.includes('SKILL.md'), '单文件时直接展示文件名')
  assert.ok(host2.querySelector('.skill-reader-index')?.textContent?.includes('1/1'), '序号应为 1/1')
  assert.ok(host2.querySelector('.skill-reader-doc'), '单文件 Markdown 默认富文本')

  await act(async () => {
    root2.unmount()
  })
  host2.remove()
})

test('SkillDetailDrawer: 读取失败显式报错与空文件占位，不静默降级', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const failingReader = async () => {
    throw new Error('节点离线')
  }
  await act(async () => {
    root.render(
      renderDrawerElement(
        e(SkillDetailDrawer, {
          skill: mockSkills[1],
          open: true,
          inline: true,
          readSkill: failingReader,
          onClose: () => {},
        }),
      ),
    )
  })

  const callout = host.querySelector('.callout--error') as HTMLElement
  assert.ok(callout, '读取失败应渲染错误提示')
  assert.ok(callout.textContent?.includes('读取失败'), '错误提示应包含失败前缀')
  assert.ok(callout.textContent?.includes('节点离线'), '错误提示应包含原始错误信息')

  await act(async () => {
    root.unmount()
  })
  host.remove()

  // 空文件：占位提示而非空白区域
  const host2 = document.createElement('div')
  document.body.appendChild(host2)
  const root2 = ReactDOMClient.createRoot(host2)
  await act(async () => {
    root2.render(
      renderDrawerElement(
        e(SkillDetailDrawer, {
          skill: mockSkills[1],
          open: true,
          inline: true,
          readSkill: async () => ({ text: '' }),
          onClose: () => {},
        }),
      ),
    )
  })
  const placeholder = host2.querySelector('.skill-reader-placeholder') as HTMLElement
  assert.ok(placeholder, '空文件应渲染占位提示')
  assert.ok(placeholder.textContent?.includes('文件内容为空'), '占位文案应为文件内容为空')

  await act(async () => {
    root2.unmount()
  })
  host2.remove()
})

test('SkillDetailDrawer: 共享根技能标注来源且不提供编辑入口', { timeout: 60_000 }, () => {
  const sharedSkill = mockSkills[5] // git-commit, source: agents
  const html = renderToString(
    renderDrawerElement(
      e(SkillDetailDrawer, {
        skill: sharedSkill,
        open: true,
        inline: true,
        initialContent: '# Git 提交技能',
        onClose: () => {},
      }),
    ),
  )

  assert.ok(html.includes('共享'), '共享根技能应展示「共享」徽章')
  assert.ok(html.includes('badge-accent'), '共享根技能应使用 badge-accent 徽章样式')
  assert.ok(html.includes('机器级共享根'), '共享根技能应标注来源')
  assert.ok(!html.includes('工作区'), '共享根技能不得标注工作区来源')
  assert.doesNotMatch(html, emojiRegex, 'SkillDetailDrawer 渲染输出严禁包含 Emoji 表情')
})

test('SkillDetailDrawer: 未选中技能时渲染空状态', { timeout: 60_000 }, () => {
  const html = renderToString(
    renderDrawerElement(
      e(SkillDetailDrawer, {
        skill: null,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )

  assert.ok(html.includes('未选择技能'), '应渲染未选择技能空状态')
  assert.doesNotMatch(html, emojiRegex, '空状态严禁包含 Emoji')
})

test('SkillDetailDrawer: 异步读取文件正文与代数防竞态 (loadGenerationRef)', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  let callCount = 0
  let slowResolve: (val: { text: string }) => void = () => {}
  const slowPromise = new Promise<{ text: string }>((resolve) => {
    slowResolve = resolve
  })
  let fastResolve: (val: { text: string }) => void = () => {}
  const fastPromise = new Promise<{ text: string }>((resolve) => {
    fastResolve = resolve
  })
  const racingReader = async () => {
    callCount++
    if (callCount === 1) return slowPromise
    return fastPromise
  }

  await act(async () => {
    root.render(
      renderDrawerElement(
        e(SkillDetailDrawer, {
          skill: mockSkills[1], // code-review: 1 个参考文件
          open: true,
          inline: true,
          readSkill: racingReader,
          onClose: () => {},
        }),
      ),
    )
  })

  // 通过下拉选择器切换文件触发第二个请求
  await chooseFileOption(host, 'checklist.md')
  assert.equal(callCount, 2, '切换文件应发起第二次读取')

  // 先完成第二个（快速）请求
  await act(async () => {
    fastResolve({ text: '快速新请求内容' })
  })
  assert.ok(
    host.querySelector('.skill-reader-body')?.textContent?.includes('快速新请求内容'),
    '新请求结果已显示',
  )

  // 后完成第一个（慢速）请求，验证不会倒退覆盖
  await act(async () => {
    slowResolve({ text: '过期的慢请求内容' })
  })
  assert.ok(
    !host.querySelector('.skill-reader-body')?.textContent?.includes('过期的慢请求内容'),
    '旧请求即便稍后返回也不得覆盖新请求结果',
  )

  await act(async () => {
    root.unmount()
  })
  host.remove()
})

test('SkillDetailDrawer: skill.description 不再作为独立区块渲染，描述仅来自 frontmatter 表格', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const longDesc =
    '浏览器自动化命令行工具，供智能体打开网站、填写表单、点击按钮、截图、抓取数据、自动化测试 Web 应用、登录站点或执行任何需要网页交互的任务；也适用于探索性测试、食粮验证与问题排查。'.repeat(2)
  const longSkill = makeSkill({ id: 'agent-browser', description: longDesc })
  const docWithFrontmatter = '---\nname: agent-browser\ndescription: 文件内描述\n---\n\n# 规程正文'

  await act(async () => {
    root.render(
      renderDrawerElement(
        e(SkillDetailDrawer, {
          skill: longSkill,
          open: true,
          inline: true,
          readSkill: async () => ({ text: docWithFrontmatter }),
          onClose: () => {},
        }),
      ),
    )
  })

  // 模型级 skill.description 不再进入阅读区：无独立描述块、无展开/收起按钮
  assert.equal(host.querySelector('.skill-reader-desc'), null, '不得渲染独立描述区块')
  assert.equal(host.querySelector('.skill-reader-desc-text'), null, '不得渲染独立描述文本节点')
  assert.equal(host.querySelector('.skill-reader-desc-toggle'), null, '不得渲染展开/收起按钮')
  const readerEl = host.querySelector('.skill-reader') as HTMLElement
  assert.ok(readerEl, '应渲染 skill-reader 阅读器')
  assert.ok(!readerEl.textContent?.includes(longDesc), '模型字段 description 不得直接进入阅读区')

  // 描述信息仅来自 frontmatter 转换的元数据表格，与正文同处同一内容流
  const doc = host.querySelector('.skill-reader-doc') as HTMLElement
  assert.ok(doc, '应渲染统一文档内容流')
  const cells = Array.from(doc.querySelectorAll('table td')).map((td) => td.textContent)
  assert.ok(cells.includes('description'), '元数据表格应包含 description 字段行')
  assert.ok(cells.includes('文件内描述'), '描述值应来自文件内 frontmatter 而非模型字段')
  assert.ok(doc.textContent?.includes('规程正文'), '正文与元数据表格同流展示')

  await act(async () => {
    root.unmount()
  })
  host.remove()
})

test('SkillDetailDrawer: 布局契约——工具条紧贴 Header，元数据与正文同处单一滚动区', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  await act(async () => {
    root.render(
      renderDrawerElement(
        e(SkillDetailDrawer, {
          skill: mockSkills[0],
          open: true,
          inline: true,
          initialContent: '# Helm CLI 技能规范\n\n正文。',
          onClose: () => {},
        }),
      ),
    )
  })

  const reader = host.querySelector('.skill-reader') as HTMLElement
  assert.ok(reader, '应渲染 skill-reader 阅读器')
  const children = Array.from(reader.children) as HTMLElement[]

  // 工具条是阅读器第一个子节点：紧贴抽屉 Header，中间不夹描述等独立区块
  assert.equal(children.length, 2, '阅读器仅含工具条与滚动阅读区两个子节点')
  assert.ok(children[0]?.classList.contains('skill-reader-toolbar'), '工具条应为首子节点')
  assert.ok(children[1]?.classList.contains('skill-reader-scroll'), '第二子节点应为单一滚动阅读区')

  // 滚动区内仅正文阅读区；元数据表格与正文同在 .skill-reader-doc 内容流内
  const scroll = children[1]!
  const scrollChildren = Array.from(scroll.children) as HTMLElement[]
  assert.equal(scrollChildren.length, 1, '滚动区仅含正文阅读区一个子节点')
  assert.ok(scrollChildren[0]?.classList.contains('skill-reader-body'), '正文阅读区应为唯一子节点')
  assert.ok(scroll.querySelector('.skill-reader-body'), '正文阅读区应位于滚动区内部')
  assert.equal(host.querySelector('.skill-reader-desc'), null, '不得存在工具条与正文之间的独立描述块')
  // 复制按钮携带 skill-reader-copy 类（移动端隐藏文字只留图标的新增样式钩子）
  assert.ok(host.querySelector('.skill-reader-copy'), '复制按钮应携带 skill-reader-copy 类')

  await act(async () => {
    root.unmount()
  })
  host.remove()
})

test('SkillDetailDrawer: 样式契约——单一滚动容器、无独立描述块与移动端/桌面不分叉', { timeout: 60_000 }, () => {
  const stylesSrc = readFileSync(join(PKG_ROOT, 'src/styles.css'), 'utf-8')
  const responsiveSrc = readFileSync(join(PKG_ROOT, 'src/responsive.css'), 'utf-8')
  const drawerSrc = readFileSync(join(PKG_ROOT, 'src/skills/SkillDetailDrawer.tsx'), 'utf-8')

  // 桌面：抽屉主体外层不滚动，唯一滚动交给 .skill-reader-scroll
  assert.match(
    stylesSrc,
    /\.skill-drawer-content \.primary-drawer-body\s*\{[^}]*overflow:\s*hidden/,
    '抽屉主体应为 overflow: hidden，消除双层滚动',
  )
  assert.match(
    stylesSrc,
    /\.skill-reader-scroll\s*\{[^}]*flex:\s*1[^}]*overflow-y:\s*auto/,
    '阅读区应 flex:1 占满剩余高度并作为唯一纵向滚动容器',
  )
  // 独立描述块已移除：不得残留任何 skill-reader-desc 样式钩子
  assert.ok(!stylesSrc.includes('skill-reader-desc'), 'styles.css 不得残留 skill-reader-desc 样式')
  // 阅读区自身不再内部滚动（消除与外层的双滚动冲突）
  assert.doesNotMatch(stylesSrc, /\.skill-reader-doc\s*\{[^}]*overflow/, 'skill-reader-doc 不得内部滚动')

  // 移动端：单行工具条 + 隐藏次要统计噪音 + 收紧头部与主体内边距
  assert.match(responsiveSrc, /\.skill-reader-toolbar\s*\{\s*flex-wrap:\s*nowrap[^}]*\}/, '移动端工具条单行不折行')
  assert.match(responsiveSrc, /\.skill-reader-file\s*\{\s*flex:\s*1 1 auto[^}]*\}/, '文件选择区自适应单行布局')
  assert.match(responsiveSrc, /\.skill-reader-lines\s*\{\s*display:\s*none/, '移动端隐藏行数统计噪音')
  assert.match(responsiveSrc, /\.skill-reader-copy\s*>\s*span\s*\{\s*display:\s*none/, '移动端复制按钮只留图标')
  assert.match(
    responsiveSrc,
    /\.skill-drawer-content \.primary-drawer-header\s*\{[^}]*padding:\s*10px 14px/,
    '移动端抽屉头部内边距收紧',
  )
  assert.match(
    responsiveSrc,
    /\.skill-drawer-content \.primary-drawer-body\s*\{[^}]*padding:\s*10px 12px/,
    '移动端抽屉主体内边距收紧',
  )
  assert.match(responsiveSrc, /\.skill-reader-body\s*\{\s*min-height:\s*0/, '移动端阅读区 min-height 归零')

  // 桌面/移动不分叉：元数据表格与正文共用同一 .skill-reader-doc 内容流，
  // responsive.css 不得为 skill-reader-doc / 元数据表格单独建移动端结构
  assert.ok(
    !responsiveSrc.includes('skill-reader-doc'),
    'responsive.css 不得为 skill-reader-doc 建移动端专属覆盖',
  )
  assert.ok(
    !responsiveSrc.includes('skill-reader-desc'),
    'responsive.css 不得残留移动端描述块结构',
  )
  // 组件单一渲染路径：无 matchMedia / 视口分支，富文本统一走 renderSkillDocMarkdown
  assert.ok(!drawerSrc.includes('matchMedia'), '抽屉不得按视口分叉渲染逻辑')
  assert.ok(
    drawerSrc.includes('renderSkillDocMarkdown(content)'),
    '富文本模式应统一走 renderSkillDocMarkdown 单一转换入口',
  )
})

// ---------------------------------------------------------------------------
// 5. SkillCenter 组件测试
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

  // 顶栏断言（副标题与统计摘要已按极简顶栏契约移除）
  assert.ok(html.includes('primary-center-topbar'), '应包含 primary-center-topbar 顶栏')
  assert.ok(html.includes('技能中心'), '应展示技能中心标题')
  assert.ok(!html.includes('primary-center-subtitle'), '不应再渲染副标题')

  // 检索栏与分类标签
  assert.ok(html.includes('primary-center-toolbar'), '应包含 primary-center-toolbar 工具栏')
  assert.ok(html.includes('搜索技能名称、ID、描述或参考文件'), '应包含搜索框占位符')
  assert.ok(html.includes('primary-category-pill'), '应包含分类筛选标签')
  assert.ok(html.includes('全部'), '应包含全部标签')
  assert.ok(html.includes('内置'), '应包含内置标签')
  assert.ok(html.includes('共享'), '应包含共享标签')
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
  assert.equal(cards.length, 6, '清空搜索后恢复全量卡片')

  // 3. 点击分类药丸标签过滤
  const pills = Array.from(host.querySelectorAll('.primary-category-pill')) as HTMLButtonElement[]
  const builtinPill = pills.find((p) => p.textContent?.includes('内置'))
  assert.ok(builtinPill, '应找到内置分类标签')

  await act(async () => {
    builtinPill.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  cards = host.querySelectorAll('.skill-card')
  assert.equal(cards.length, 2, '内置分类下应仅展示 2 个内置技能')

  // 3.5 共享分类药丸：仅展示 source=agents 的技能
  const agentsPill = pills.find((p) => p.textContent?.includes('共享'))
  assert.ok(agentsPill, '应找到共享分类标签')
  await act(async () => {
    agentsPill.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  cards = host.querySelectorAll('.skill-card')
  assert.equal(cards.length, 1, '共享分类下应仅展示 1 个共享根技能')
  assert.ok(cards[0]!.textContent?.includes('git-commit'), '共享分类卡片应为 git-commit')

  // 恢复全部后点击卡片触发 openTarget
  const allPill = pills.find((p) => p.textContent?.includes('全部'))
  assert.ok(allPill)
  await act(async () => {
    allPill.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  cards = host.querySelectorAll('.skill-card')
  assert.equal(cards.length, 6, '恢复全部后应回到全量卡片')

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
// 6. 源码静态规范契约：零 Emoji 铁律与 Fast Refresh
// ---------------------------------------------------------------------------

test('静态规范契约：所有技能模块源码 0 Emoji 且保 Fast Refresh', { timeout: 60_000 }, () => {
  const modelSrc = readFileSync(join(PKG_ROOT, 'src/skills/skill-center-model.ts'), 'utf-8')
  const readerModelSrc = readFileSync(join(PKG_ROOT, 'src/skills/skill-reader-model.ts'), 'utf-8')
  const cardSrc = readFileSync(join(PKG_ROOT, 'src/skills/SkillCard.tsx'), 'utf-8')
  const drawerSrc = readFileSync(join(PKG_ROOT, 'src/skills/SkillDetailDrawer.tsx'), 'utf-8')
  const centerSrc = readFileSync(join(PKG_ROOT, 'src/skills/SkillCenter.tsx'), 'utf-8')

  assert.doesNotMatch(modelSrc, emojiRegex, 'skill-center-model.ts 源码严禁包含 Emoji')
  assert.doesNotMatch(readerModelSrc, emojiRegex, 'skill-reader-model.ts 源码严禁包含 Emoji')
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

  // 阅读器契约：文件选择必须复用公共 Select，严禁原生 select；样式不落内联
  assert.match(drawerSrc, /import\s*\{[^}]*Select[^}]*\}\s*from\s*['"]\.\.\/ui\/Select\.js['"]/)
  assert.ok(!drawerSrc.includes('<select'), 'SkillDetailDrawer 严禁使用原生 select')
  assert.ok(!/style=\{/.test(drawerSrc), 'SkillDetailDrawer 不得残留内联 style')
})
