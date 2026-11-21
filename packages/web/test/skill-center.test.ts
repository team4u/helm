import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ensureHappyDom, flushMacrotask, typeIntoControl } from './helpers/dom-harness.js'

ensureHappyDom()

const React = (await import('react')).default
const { act } = await import('react')
const ReactDOMClient = await import('react-dom/client')
const { renderToString } = await import('react-dom/server')

import type { SkillSummary } from '@helmx/protocol'
import {
  buildSkillCategoryCounts,
  filterSkills,
  getSkillSourceBadge,
  isSkillAgents,
  isSkillInTab,
  isSkillBuiltin,
  isSkillPlugin,
  isSkillWorkspace,
  summarizeSkills,
  type SkillCategoryTab,
} from '../src/skills/skill-center-model.js'
import {
  buildSkillFileList,
  extractSkillFrontmatter,
  isSkillMarkdownFile,
  renderSkillDocMarkdown,
  renderSkillFrontmatterTable,
  skillFileBasename,
  skillFileLanguage,
} from '../src/skills/skill-reader-model.js'
import { makeTestStore, HelmxExternalStoreContext } from './helpers/store.js'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'
import {
  parseSkillCatalogResult,
  parseSkillReadResult,
  fetchScopedSkillCatalog,
  readScopedSkillFile,
} from '../src/skills/skill-scope-api.js'
import {
  buildSkillScopeCandidates,
  conversationSkillScope,
  parseSkillScopeEnv,
  skillScopeKey,
  skillScopeTargetEnv,
  standbySkillScope,
} from '../src/skills/skill-scope-model.js'
import type { ConversationSummary, Profile } from '@helmx/protocol'

// The drawer and skill center carry the @radix-ui/react-select dependency
// graph and must be dynamically loaded after happy-dom
// GlobalRegistrator.register() (same convention as select.test.ts);
// otherwise Radix Select popovers cannot open in a pre-registered environment.
const { HostStoreProviders } = await import('./helpers/host-store.js')
// SkillCard statically imports HelmxIcon via @helmx/plugin-client (Radix dependency graph): dynamically loaded after register, same convention
const { SkillCard } = await import('../src/skills/SkillCard.js')
const { SkillDetailDrawer } = await import('../src/skills/SkillDetailDrawer.js')
const { SkillCenter } = await import('../src/skills/SkillCenter.js')

const e = React.createElement
const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u
const typeIntoInput = typeIntoControl

function makeSkill(partial: Partial<SkillSummary> & { id: string }): SkillSummary {
  return {
    name: partial.name ?? partial.id,
    description: partial.description ?? '测试技能描述', // zh fixture data
    references: partial.references ?? [],
    ...partial,
  }
}

/** Render the drawer inside a real host store context (MarkdownView depends on useHelmxStore). */
function renderDrawerElement(props: React.ReactElement): React.ReactElement {
  return e(HelmxExternalStoreContext.Provider, { value: makeTestStore() }, props)
}

/** Open the file picker via keyboard interaction and pick the given option (Radix Select has no native select). */
async function chooseFileOption(host: HTMLElement, optionText: string): Promise<void> {
  const trigger = host.querySelector('.skill-file-select .helmx-select-trigger') as HTMLElement | null
  assert.ok(trigger, 'the file picker trigger must render')
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  const options = Array.from(host.querySelectorAll('[role="option"]')) as HTMLElement[]
  const target = options.find((el) => el.textContent?.includes(optionText))
  assert.ok(target, `the dropdown options must include ${optionText}`)
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
}

const mockSkills: [SkillSummary, SkillSummary, SkillSummary, SkillSummary, SkillSummary, SkillSummary] = [
  makeSkill({
    id: 'helmx-cli',
    name: 'Helmx 命令行操作手册',
    description: '指导大模型通过 helmx 命令行控制 Hub、检查状态与排查问题',
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
// 1. Pure model tests (skill-center-model.ts)
// ---------------------------------------------------------------------------

test('skill-center-model: skill category pure functions (builtin / plugin / shared / workspace)', { timeout: 60_000 }, () => {
  const builtinAssistant = makeSkill({ id: 'assistant-helper', managedByPlugin: 'builtin:profile' })
  const builtinCli = makeSkill({ id: 'helmx-cli', managedByPlugin: 'builtin:profile' })
  const pluginManaged = makeSkill({ id: 'custom-skill', managedByPlugin: 'vendor:tools' })
  const workspacePrivate = makeSkill({ id: 'my-private-skill' })
  const agentsShared = makeSkill({ id: 'git-commit', source: 'agents' })

  // Builtin classification
  assert.equal(isSkillBuiltin(builtinAssistant), true)
  assert.equal(isSkillBuiltin(builtinCli), true)
  assert.equal(isSkillBuiltin(pluginManaged), false)
  assert.equal(isSkillBuiltin(workspacePrivate), false)
  assert.equal(isSkillBuiltin(agentsShared), false)

  // Plugin-managed classification
  assert.equal(isSkillPlugin(pluginManaged), true)
  assert.equal(isSkillPlugin(builtinAssistant), false)
  assert.equal(isSkillPlugin(builtinCli), false)
  assert.equal(isSkillPlugin(workspacePrivate), false)
  assert.equal(isSkillPlugin(agentsShared), false)

  // Machine-level shared root classification
  assert.equal(isSkillAgents(agentsShared), true)
  assert.equal(isSkillAgents(workspacePrivate), false)
  assert.equal(isSkillAgents(builtinCli), false)
  assert.equal(isSkillAgents(pluginManaged), false)

  // Local workspace-private classification (excluding shared-root sources)
  assert.equal(isSkillWorkspace(workspacePrivate), true)
  assert.equal(isSkillWorkspace(builtinAssistant), false)
  assert.equal(isSkillWorkspace(builtinCli), false)
  assert.equal(isSkillWorkspace(pluginManaged), false)
  assert.equal(isSkillWorkspace(agentsShared), false, 'shared-root skills must not be classified as workspace')
})

test('skill-center-model: buildSkillCategoryCounts counts each category accurately', { timeout: 60_000 }, () => {
  const counts = buildSkillCategoryCounts(mockSkills)
  // mockSkills contains:
  // 1. helmx-cli (builtin:profile) -> builtin
  // 2. code-review (no managedByPlugin) -> workspace
  // 3. database-migration (no managedByPlugin) -> workspace
  // 4. herdr-deploy (builtin:herdr) -> builtin
  // 5. community-linter (community:linter) -> plugins
  // 6. git-commit (source: agents) -> agents
  assert.equal(counts.all, 6)
  assert.equal(counts.builtin, 2)
  assert.equal(counts.workspace, 2)
  assert.equal(counts.plugins, 1)
  assert.equal(counts.agents, 1)
  assert.equal(counts.node, 0)

  const emptyCounts = buildSkillCategoryCounts([])
  assert.deepEqual(emptyCounts, { all: 0, builtin: 0, workspace: 0, plugins: 0, agents: 0, node: 0 })
})

test('skill-center-model: summarizeSkills metric summary', { timeout: 60_000 }, () => {
  const summary = summarizeSkills(mockSkills)
  assert.deepEqual(summary, {
    total: 6,
    builtin: 2,
    workspace: 2,
    plugins: 1,
    agents: 1,
    node: 0,
  })
})

test('skill-center-model: filterSkills category filtering and multi-dimension search (ID / name / description / references)', { timeout: 60_000 }, () => {
  // Category filter
  const builtinSkills = filterSkills(mockSkills, { query: '', categoryTab: 'builtin' })
  assert.equal(builtinSkills.length, 2)
  assert.ok(builtinSkills.every((s) => isSkillBuiltin(s)))

  const workspaceSkills = filterSkills(mockSkills, { query: '', categoryTab: 'workspace' })
  assert.equal(workspaceSkills.length, 2)
  assert.ok(workspaceSkills.every((s) => isSkillWorkspace(s)))

  const pluginSkills = filterSkills(mockSkills, { query: '', categoryTab: 'plugins' })
  assert.equal(pluginSkills.length, 1)
  assert.equal(pluginSkills[0]!.id, 'community-linter')

  // Machine-level shared root category filter
  const agentsSkills = filterSkills(mockSkills, { query: '', categoryTab: 'agents' })
  assert.equal(agentsSkills.length, 1)
  assert.equal(agentsSkills[0]!.id, 'git-commit')
  assert.ok(agentsSkills.every((s) => isSkillAgents(s)))

  // Keyword search by name
  const nameSearch = filterSkills(mockSkills, { query: '代码审查', categoryTab: 'all' })
  assert.equal(nameSearch.length, 1)
  assert.equal(nameSearch[0]!.id, 'code-review')

  // Keyword search by ID
  const idSearch = filterSkills(mockSkills, { query: 'helmx-cli', categoryTab: 'all' })
  assert.equal(idSearch.length, 1)
  assert.equal(idSearch[0]!.id, 'helmx-cli')

  // Keyword search by description
  const descSearch = filterSkills(mockSkills, { query: 'PostgreSQL', categoryTab: 'all' })
  assert.equal(descSearch.length, 1)
  assert.equal(descSearch[0]!.id, 'database-migration')

  // Keyword search by reference files
  const refSearch = filterSkills(mockSkills, { query: 'generative-ui.md', categoryTab: 'all' })
  assert.equal(refSearch.length, 1)
  assert.equal(refSearch[0]!.id, 'helmx-cli')

  // Combined filter: category + search
  const comboMatch = filterSkills(mockSkills, { query: '多节点', categoryTab: 'builtin' })
  assert.equal(comboMatch.length, 1)
  assert.equal(comboMatch[0]!.id, 'herdr-deploy')

  const comboMismatch = filterSkills(mockSkills, { query: '多节点', categoryTab: 'workspace' })
  assert.equal(comboMismatch.length, 0)
})

test('skill-center-model: getSkillSourceBadge mapping', { timeout: 60_000 }, () => {
  const cliSkill = makeSkill({ id: 'helmx-cli', managedByPlugin: 'builtin:profile' })
  const codeSkill = makeSkill({ id: 'code-review' })
  const sharedSkill = makeSkill({ id: 'git-commit', source: 'agents' })

  const badgeBuiltin = getSkillSourceBadge(cliSkill)
  assert.equal(badgeBuiltin.label, 'Built-in')
  assert.equal(badgeBuiltin.variant, 'builtin')

  const badgePlugin = getSkillSourceBadge(mockSkills[4])
  assert.equal(badgePlugin.label, 'community:linter')
  assert.equal(badgePlugin.variant, 'plugin')

  const badgeWs = getSkillSourceBadge(codeSkill)
  assert.equal(badgeWs.label, 'Workspace')
  assert.equal(badgeWs.variant, 'workspace')

  // Shared-root skills resolve to the agents badge first (no managedByPlugin, never posing as workspace)
  const badgeAgents = getSkillSourceBadge(sharedSkill)
  assert.equal(badgeAgents.label, 'Shared')
  assert.equal(badgeAgents.variant, 'agents')
})

test('skill-reader-model: buildSkillFileList main file first + reference short names and directory hints', { timeout: 60_000 }, () => {
  const files = buildSkillFileList(['references/cli-reference.md', 'scripts/deploy.py'])
  assert.equal(files.length, 3)

  // Main file first: read path is the empty string, display name fixed to SKILL.md
  assert.deepEqual(files[0], {
    path: '',
    fileName: 'SKILL.md',
    meta: 'Main file',
    displayPath: 'SKILL.md',
  })

  // Reference files: short file name + directory hint + full path
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

  // Root-level files fall back to ./ for the directory hint; empty and invalid entries are filtered; an empty list keeps only the main file
  assert.deepEqual(buildSkillFileList(['notes.md']), [
    { path: '', fileName: 'SKILL.md', meta: 'Main file', displayPath: 'SKILL.md' },
    { path: 'notes.md', fileName: 'notes.md', meta: './', displayPath: 'notes.md' },
  ])
  assert.equal(buildSkillFileList(['', '   ', undefined as unknown as string]).length, 1)
  assert.equal(buildSkillFileList(undefined).length, 1)
  assert.equal(buildSkillFileList(null).length, 1)
})

test('skill-reader-model: skillFileBasename and isSkillMarkdownFile classification', { timeout: 60_000 }, () => {
  assert.equal(skillFileBasename('references/cli-reference.md'), 'cli-reference.md')
  assert.equal(skillFileBasename('SKILL.md'), 'SKILL.md')
  assert.equal(skillFileBasename('deploy.py?v=2'), 'deploy.py')
  assert.equal(skillFileBasename(''), '')

  // The empty string means the main SKILL.md, rendered as Markdown
  assert.equal(isSkillMarkdownFile(''), true)
  assert.equal(isSkillMarkdownFile('SKILL.md'), true)
  assert.equal(isSkillMarkdownFile('references/guide.MARKDOWN'), true)
  assert.equal(isSkillMarkdownFile('scripts/deploy.py'), false)
  assert.equal(isSkillMarkdownFile('config.json'), false)
})

test('skill-reader-model: extractSkillFrontmatter parses fields and body (single-line scalars / block scalars / quotes)', { timeout: 60_000 }, () => {
  // Regular frontmatter: fields keep their original YAML order; the body strips the fence and trailing blank line
  const doc = extractSkillFrontmatter(
    '---\nname: helmx-cli\ndescription: 手册\nmanagedByPlugin: builtin:profile\n---\n\n# 正文\n\n段落。',
  )
  assert.deepEqual(doc, {
    fields: [
      { key: 'name', value: 'helmx-cli' },
      { key: 'description', value: '手册' },
      { key: 'managedByPlugin', value: 'builtin:profile' },
    ],
    body: '# 正文\n\n段落。',
  })

  // The ... fence terminator is supported too
  assert.deepEqual(extractSkillFrontmatter('---\nname: x\n...\n# 标题'), {
    fields: [{ key: 'name', value: 'x' }],
    body: '# 标题',
  })

  // Unclosed / missing fence / non-fence divider: returns null and callers fall back to the raw text
  assert.equal(extractSkillFrontmatter('---\nname: x\n# 正文'), null)
  assert.equal(extractSkillFrontmatter('# 标题\n\n正文'), null)
  assert.equal(extractSkillFrontmatter('----\nname: x\n----\n# 正文'), null)
  assert.equal(extractSkillFrontmatter(''), null)

  // Block scalars: folded > / >- join with spaces, literal | / |- keep newlines (semantics aligned with the kernel parser)
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

  // Single-line values strip symmetric quotes and restore escapes; asymmetric quotes stay verbatim
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

  // Comments and blank lines never match the key pattern and are skipped
  assert.deepEqual(
    extractSkillFrontmatter('---\n# 注释\nname: x\n\nlicense: MIT\n---\n正文')?.fields.map((f) => f.key),
    ['name', 'license'],
  )

  // Frontmatter-only documents yield an empty body; an empty frontmatter yields no fields
  assert.deepEqual(extractSkillFrontmatter('---\nname: x\n---\n'), {
    fields: [{ key: 'name', value: 'x' }],
    body: '',
  })
  assert.deepEqual(extractSkillFrontmatter('---\n---\n# 正文'), { fields: [], body: '# 正文' })
})

test('skill-reader-model: renderSkillFrontmatterTable converts fields in order into a metadata table with safe escaping', { timeout: 60_000 }, () => {
  // Regular conversion: heading + header row + field rows, order preserved
  assert.equal(
    renderSkillFrontmatterTable([
      { key: 'name', value: 'agent-browser' },
      { key: 'description', value: 'Browser automation CLI' },
      { key: 'managedByPlugin', value: 'builtin:profile' },
    ]),
    [
      '## Skill metadata',
      '',
      '| Field | Value |',
      '| --- | --- |',
      '| name | agent-browser |',
      '| description | Browser automation CLI |',
      '| managedByPlugin | builtin:profile |',
    ].join('\n'),
  )

  // An empty field sequence returns '' (nothing to render; no empty table injected)
  assert.equal(renderSkillFrontmatterTable([]), '')

  // Safe escaping: pipes / newlines / angle brackets / ampersands / backslashes never break the table column structure
  const escaped = renderSkillFrontmatterTable([
    { key: 'description', value: 'a | b\nsecond <hr> & "x" \\y' },
  ])
  assert.ok(
    escaped.includes('| description | a \\| b second &lt;hr> &amp; "x" \\\\y |'),
    '竖线转义、换行折空格、< 转字符引用、& 转义、反斜杠加倍',
  )
  // Escaped cells stay single-line (newlines fold into spaces, preserving the GFM table row structure)
  const cell = escaped.split('\n').find((l) => l.startsWith('| description |'))
  assert.ok(cell !== undefined && !/\r|\n/.test(cell), 'metadata cells must stay single-line')
})

test('skill-reader-model: renderSkillDocMarkdown unified doc view (table + body in one flow, unclosed fallback)', { timeout: 60_000 }, () => {
  // With frontmatter: the metadata table comes first, the body follows
  assert.equal(
    renderSkillDocMarkdown('---\nname: helmx-cli\ndescription: 手册\n---\n\n# 正文\n\n段落。'),
    [
      '## Skill metadata',
      '',
      '| Field | Value |',
      '| --- | --- |',
      '| name | helmx-cli |',
      '| description | 手册 |',
      '',
      '# 正文',
      '',
      '段落。',
    ].join('\n'),
  )

  // Without frontmatter: the body returns verbatim
  assert.equal(renderSkillDocMarkdown('# 标题\n\n正文'), '# 标题\n\n正文')

  // Unclosed frontmatter: fall back to the raw text, never truncate the body
  const unclosed = '---\nname: x\n# 正文'
  assert.equal(renderSkillDocMarkdown(unclosed), unclosed)

  // Starting with a non-fence divider: no false positives, raw text returned
  const dashes = '----\nname: x\n----\n# 正文'
  assert.equal(renderSkillDocMarkdown(dashes), dashes)

  // Frontmatter only: just the metadata table
  assert.equal(
    renderSkillDocMarkdown('---\nname: x\n---\n'),
    '## Skill metadata\n\n| Field | Value |\n| --- | --- |\n| name | x |',
  )

  // Empty frontmatter (no fields): body verbatim, no empty table injected
  assert.equal(renderSkillDocMarkdown('---\n---\n# 正文'), '# 正文')
})

test('skill-reader-model: skillFileLanguage derives the syntax language from the file suffix', { timeout: 60_000 }, () => {
  assert.equal(skillFileLanguage(''), 'markdown')
  assert.equal(skillFileLanguage('references/guide.md'), 'markdown')
  assert.equal(skillFileLanguage('scripts/deploy.py'), 'python')
  assert.equal(skillFileLanguage('configs/setup.json'), 'json')
  assert.equal(skillFileLanguage('bin/run.sh'), 'bash')
  // Unrecognized suffixes return '' (plain monospace fallback, never a fabricated language)
  assert.equal(skillFileLanguage('assets/unknown.custom'), '')
})

// ---------------------------------------------------------------------------
// 2. SkillCard component tests
// ---------------------------------------------------------------------------

/** Render a card inside a real host store context (useWebLocale needs the store). */
function renderCardElement(props: React.ReactElement): React.ReactElement {
  return e(HostStoreProviders, { value: makeTestStore() }, props)
}

test('SkillCard: SSR structure, source badge, reference pills and the zero-emoji rule', { timeout: 60_000 }, () => {
  const skill = mockSkills[0] // helmx-cli, 2 references
  const html = renderToString(
    renderCardElement(
      e(SkillCard, {
        skill,
        selected: false,
        onSelect: () => {},
      }),
    ),
  )

  // Structure assertions
  assert.ok(html.includes('primary-card'), 'must include the primary-card class')
  assert.ok(html.includes('skill-card'), 'must include the skill-card class')
  assert.ok(html.includes('Helmx 命令行操作手册'), 'must show the skill name (zh fixture)')
  assert.ok(html.includes('helmx-cli'), 'must show the skill ID')
  assert.ok(html.includes('指导大模型通过 helmx 命令行控制 Hub'), 'must show the description (zh fixture)')
  assert.ok(html.includes('Built-in'), 'built-in skills must show the built-in source badge')
  assert.ok(html.includes('2 reference files'), 'must show the 2-reference-files pill')

  // Zero-emoji assertion
  assert.doesNotMatch(html, emojiRegex, 'SkillCard output must contain no emoji')
})

test('SkillCard: selected state and the workspace source badge', { timeout: 60_000 }, () => {
  const wsSkill = mockSkills[1] // code-review, workspace, 1 reference
  const html = renderToString(
    renderCardElement(
      e(SkillCard, {
        skill: wsSkill,
        selected: true,
        onSelect: () => {},
      }),
    ),
  )

  assert.ok(html.includes('is-selected'), 'selected cards must carry the is-selected class')
  assert.ok(html.includes('aria-selected="true"'), 'selected cards must carry aria-selected')
  assert.ok(html.includes('Workspace'), 'workspace-private skills must show the workspace source badge')
  assert.ok(html.includes('1 reference files'), 'must show the 1-reference-file pill')
  assert.doesNotMatch(html, emojiRegex, 'SkillCard output must contain no emoji')
})

test('SkillCard: shared-root skills show the shared badge with the accent style', { timeout: 60_000 }, () => {
  const sharedSkill = mockSkills[5] // git-commit, source: agents
  const html = renderToString(
    renderCardElement(
      e(SkillCard, {
        skill: sharedSkill,
        selected: false,
        onSelect: () => {},
      }),
    ),
  )

  assert.ok(html.includes('badge-accent'), 'shared-root skills must use the badge-accent style')
  assert.ok(html.includes('Shared'), 'shared-root skills must show the shared source badge')
  assert.ok(!html.includes('Workspace'), 'shared-root skills must not show the workspace badge')
  assert.doesNotMatch(html, /badge-ghost|badge-subtle/, 'undefined badge-ghost / badge-subtle classes must not appear')
  assert.doesNotMatch(html, emojiRegex, 'SkillCard output must contain no emoji')
})

test('SkillCard: omits the 0-references pill without references; the /skill:<id> command pill copies and stops propagation', { timeout: 60_000 }, async () => {
  const { act } = await import('react')
  const ReactDOMClient = await import('react-dom/client')
  const noRefSkill = mockSkills[2] // database-migration, no references
  let selectedCount = 0

  const html = renderToString(
    renderCardElement(
      e(SkillCard, {
        skill: noRefSkill,
        selected: false,
        onSelect: () => {},
      }),
    ),
  )
  assert.ok(!html.includes('0 reference files'), 'the 0-references pill must not render without references')
  assert.ok(html.includes('/skill:database-migration'), 'the copyable /skill:<id> command pill must render')

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)
  const navWithClipboard = navigator as unknown as {
    clipboard?: { writeText?: (text: string) => Promise<void> }
  }
  const origClipboard = navWithClipboard.clipboard
  const copied: string[] = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied.push(text)
      },
    },
  })

  try {
    await act(async () => {
      root.render(
        renderCardElement(
          e(SkillCard, {
            skill: noRefSkill,
            selected: false,
            onSelect: () => {
              selectedCount++
            },
          }),
        ),
      )
    })

    const copyBtn = host.querySelector('button[aria-label="Copy slash command /skill:database-migration"]')
    assert.ok(copyBtn, 'the clickable /skill:<id> copy button must render')
    await act(async () => {
      copyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.equal(selectedCount, 0, 'clicking the command pill must stopPropagation instead of opening the detail drawer')
    assert.deepEqual(copied, ['/skill:database-migration'])
  } finally {
    if (origClipboard !== undefined) {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: origClipboard })
    }
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

test('SkillCard: mouse click and keyboard accessibility activation', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  let selectedCount = 0
  const onSelect = () => {
    selectedCount++
  }

  await act(async () => {
    root.render(
      renderCardElement(
        e(SkillCard, {
          skill: mockSkills[0],
          selected: false,
          onSelect,
        }),
      ),
    )
  })

  const card = host.querySelector('.skill-card') as HTMLElement
  assert.ok(card, 'the card DOM node must be found')

  // Click activation
  await act(async () => {
    card.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  assert.equal(selectedCount, 1, 'clicking must trigger onSelect')

  // Enter activation
  await act(async () => {
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  assert.equal(selectedCount, 2, 'Enter must trigger onSelect')

  // Space activation
  await act(async () => {
    card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  })
  assert.equal(selectedCount, 3, 'Space must trigger onSelect')

  await act(async () => {
    root.unmount()
  })
  host.remove()
})

// ---------------------------------------------------------------------------
// 4. SkillDetailDrawer component tests (compact file reader)
// ---------------------------------------------------------------------------

test('SkillDetailDrawer: SSR renders the single-row file toolbar and rich reader area (no tab wall, zero emoji)', { timeout: 60_000 }, () => {
  const skill = mockSkills[0]
  const initialContent = '# Helmx CLI 技能规范\n\n这是测试用 Markdown 文档正文。'

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

  // Drawer structure assertions
  assert.ok(html.includes('primary-drawer-content'), 'must include primary-drawer-content')
  assert.ok(html.includes('primary-drawer-title'), 'must include the drawer title')
  assert.ok(html.includes('Helmx 命令行操作手册'), 'must show the skill name (zh fixture)')
  assert.ok(html.includes('helmx-cli'), 'must show the skill ID')
  assert.ok(html.includes('Built-in'), 'must show the built-in source badge')

  // Single-row file toolbar: shared Select trigger + reading mode toggle + file index and line count
  assert.ok(html.includes('skill-reader-toolbar'), 'must include the skill-reader-toolbar')
  assert.ok(html.includes('helmx-select-trigger'), 'multi-file readers must use the shared Select dropdown')
  assert.ok(html.includes('aria-label="Choose a skill file"'), 'the file picker must carry an accessibility label')
  assert.ok(html.includes('SKILL.md'), 'the trigger must show the current file short name SKILL.md')
  assert.ok(html.includes('Rich text'), 'the rich reading mode button must be offered')
  assert.ok(html.includes('Source'), 'the source reading mode button must be offered')
  assert.ok(html.includes('1/3'), 'must show the file index 1/3')
  assert.ok(html.includes('3 lines'), 'must show the current file line count')
  assert.ok(html.includes('aria-label="Copy"'), 'the toolbar must offer a copy button')

  // The tab wall is gone: no role=tab file buttons and no file list block
  assert.ok(!html.includes('role="tab"'), 'the multi-file tab wall (role=tab) must not render')
  assert.ok(!html.includes('skill file list'), 'no file list block may render')

  // Rich reader area: MarkdownView renders the heading and body; raw Markdown hashes never show by default
  assert.ok(html.includes('skill-reader-doc'), 'must include the skill-reader-doc rich reader area')
  assert.ok(html.includes('msg-ai-body'), 'rich mode must reuse MarkdownView')
  assert.ok(html.includes('Helmx CLI 技能规范</h1>'), 'must render the Markdown heading (zh fixture)')
  assert.ok(html.includes('这是测试用 Markdown 文档正文。'), 'must render the body paragraph (zh fixture)')
  assert.ok(!html.includes('# Helmx CLI 技能规范'), 'rich mode must not show raw Markdown hashes')

  // Zero-emoji assertion
  assert.doesNotMatch(html, emojiRegex, 'SkillDetailDrawer output must contain no emoji')
})

test('SkillDetailDrawer: rich mode converts frontmatter into a metadata table flowing with the body; source mode keeps the raw text', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const frontmatterDoc =
    '---\nname: helmx-cli\ndescription: 头部元信息\nmanagedByPlugin: builtin:profile\n---\n\n# 正文标题\n\n内容段落。'
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

  // Rich by default: .skill-reader-doc holds both the metadata table and the body in one content flow
  const readerBody = host.querySelector('.skill-reader-body') as HTMLElement
  assert.equal(readerBody.getAttribute('data-mode'), 'rich', 'Markdown files default to rich mode')
  const doc = host.querySelector('.skill-reader-doc') as HTMLElement
  assert.ok(doc, 'rich mode must render the MarkdownView reader area')

  // Metadata table: heading + header row + field rows in original YAML order
  assert.ok(doc.textContent?.includes('Skill metadata'), 'must render the skill metadata heading')
  const table = doc.querySelector('table') as HTMLTableElement
  assert.ok(table, 'frontmatter must convert into a rendered Markdown table')
  const headerCells = Array.from(table.querySelectorAll('thead th')).map((c) => c.textContent)
  assert.deepEqual(headerCells, ['Field', 'Value'], 'the header must be the field/value columns')
  const rows = Array.from(table.querySelectorAll('tbody tr')).map(
    (tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent),
  )
  assert.deepEqual(rows, [
    ['name', 'helmx-cli'],
    ['description', '头部元信息'],
    ['managedByPlugin', 'builtin:profile'],
  ], 'fields keep their original YAML order')

  // The body follows in the same content flow; raw YAML key/value syntax never leaks
  assert.ok(doc.textContent?.includes('正文标题'), 'the body after the frontmatter must survive (zh fixture)')
  assert.ok(doc.textContent?.includes('内容段落。'), 'the body paragraph must survive (zh fixture)')
  assert.ok(!doc.textContent?.includes('name: helmx-cli'), 'frontmatter must not render as raw YAML')
  assert.ok(!doc.textContent?.includes('description: 头部元信息'), 'no frontmatter key/value pair may leak')
  assert.ok(!doc.textContent?.includes('---'), 'rich mode must not leave fence dividers behind')

  // Switch to source mode: the complete raw text (including the --- frontmatter fence) renders as monospace code
  const sourceBtn = Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent?.includes('Source'),
  ) as HTMLButtonElement
  assert.ok(sourceBtn, 'the source mode button must be found')
  await act(async () => {
    sourceBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  assert.equal(readerBody.getAttribute('data-mode'), 'source', 'clicking must enter source mode')
  const codeWrap = host.querySelector('.skill-reader-code .code-block-wrap') as HTMLElement
  assert.ok(codeWrap, 'source mode must use the CodeBlockView code block')
  assert.ok(codeWrap.textContent?.includes('---'), 'source mode must keep the YAML frontmatter --- fence')
  assert.ok(codeWrap.textContent?.includes('name: helmx-cli'), 'source mode must keep the raw YAML frontmatter')
  assert.ok(codeWrap.textContent?.includes('# 正文标题'), 'source mode must keep the raw body (zh fixture)')

  // Switch back to rich: table + body restored, still no raw YAML
  const richBtn = Array.from(host.querySelectorAll('button')).find(
    (b) => b.textContent?.includes('Rich text'),
  ) as HTMLButtonElement
  await act(async () => {
    richBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  assert.equal(readerBody.getAttribute('data-mode'), 'rich', 'switching back to rich mode works')
  assert.ok(host.querySelector('.skill-reader-doc table'), 'the rich reader area restores the metadata table')

  await act(async () => {
    root.unmount()
  })
  host.remove()
})

test('SkillDetailDrawer: file dropdown switches reference files with index/line-count sync', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const readCalls: Array<{ id: string; path?: string }> = []
  const library: Record<string, string> = {
    '': '# Main file\n\n主文件正文。',
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

  // Initially loads the main SKILL.md; the toolbar shows index 1/3 and the line count
  assert.equal(readCalls.length, 1)
  assert.equal(readCalls[0]!.id, 'helmx-cli')
  assert.equal(readCalls[0]!.path, undefined)
  assert.ok(host.querySelector('.skill-reader-doc')?.textContent?.includes('Main file'), 'the root file body must load')
  assert.ok(host.querySelector('.skill-reader-index')?.textContent?.includes('1/3'))
  assert.ok(host.querySelector('.skill-reader-lines')?.textContent?.includes('3 lines'))

  // Switch to references/cli-reference.md via the dropdown
  await chooseFileOption(host, 'cli-reference.md')
  assert.equal(readCalls.length, 2)
  assert.equal(readCalls[1]!.path, 'references/cli-reference.md')
  assert.ok(
    host.querySelector('.skill-reader-doc')?.textContent?.includes('CLI 参考'),
    'the reference file body must update (zh fixture)',
  )
  assert.ok(host.querySelector('.skill-reader-index')?.textContent?.includes('2/3'))
  assert.ok(host.querySelector('.skill-reader-lines')?.textContent?.includes('5 lines'))

  // Switch to the last reference generative-ui.md; the index advances to 3/3
  await chooseFileOption(host, 'generative-ui.md')
  assert.equal(readCalls.length, 3)
  assert.equal(readCalls[2]!.path, 'references/generative-ui.md')
  assert.ok(host.querySelector('.skill-reader-index')?.textContent?.includes('3/3'))

  await act(async () => {
    root.unmount()
  })
  host.remove()
})

test('SkillDetailDrawer: non-Markdown files use CodeBlockView with suffix-derived language; single-file skills render no dropdown', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const pySkill = makeSkill({
    id: 'ops-scripts',
    name: '运维脚本集',
    references: ['scripts/deploy.py'],
  })
  const customReader = async (_id: string, path?: string) => ({
    text: path === 'scripts/deploy.py' ? 'print("deploy")' : '# Main file',
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

  // Non-Markdown files: no rich/source toggle, rendered directly as a code block with the suffix-derived language
  await chooseFileOption(host, 'deploy.py')
  const body = host.querySelector('.skill-reader-body') as HTMLElement
  assert.equal(body.getAttribute('data-mode'), 'source', 'non-Markdown files stay in source mode')
  const codeWrap = host.querySelector('.skill-reader-code .code-block-wrap') as HTMLElement
  assert.ok(codeWrap, 'code files must render through CodeBlockView')
  assert.ok(codeWrap.querySelector('.code-block-header')?.textContent?.includes('python'), 'the language must derive as python')
  assert.ok(codeWrap.textContent?.includes('print("deploy")'), 'the code body must render')
  const modeToggle = host.querySelector('.skill-reader-mode')
  assert.ok(modeToggle === null, 'non-Markdown files offer no reading mode toggle')

  await act(async () => {
    root.unmount()
  })
  host.remove()

  // Single-file skill: no dropdown, the file name and index 1/1 render directly
  const host2 = document.createElement('div')
  document.body.appendChild(host2)
  const root2 = ReactDOMClient.createRoot(host2)
  await act(async () => {
    root2.render(
      renderDrawerElement(
        e(SkillDetailDrawer, {
          skill: mockSkills[2], // database-migration, no references
          open: true,
          inline: true,
          readSkill: async () => ({ text: '# 迁移演练' }), // zh fixture content
          onClose: () => {},
        }),
      ),
    )
  })

  assert.ok(host2.querySelector('.skill-file-select') === null, 'single-file readers render no dropdown')
  assert.ok(host2.querySelector('.helmx-select-trigger') === null, 'single-file readers have no Select trigger')
  const fileLabel = host2.querySelector('.skill-reader-file-label') as HTMLElement
  assert.ok(fileLabel.textContent?.includes('SKILL.md'), 'single-file readers show the file name directly')
  assert.ok(host2.querySelector('.skill-reader-index')?.textContent?.includes('1/1'), 'the index must be 1/1')
  assert.ok(host2.querySelector('.skill-reader-doc'), 'single-file Markdown defaults to rich mode')

  await act(async () => {
    root2.unmount()
  })
  host2.remove()
})

test('SkillDetailDrawer: Failed to read errors explicitly and empty files show a placeholder, never a silent degradation', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const failingReader = async () => {
    throw new Error('节点离线') // raw backend error text stays verbatim (zh fixture)
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

  const callout = host.querySelector('.callout-error') as HTMLElement
  assert.ok(callout, 'Failed to read must render the unified .callout-error hint')
  assert.ok(callout.textContent?.includes('Failed to read'), 'the error hint must include the failure prefix')
  assert.ok(callout.textContent?.includes('节点离线'), 'the error hint must include the raw error text (zh fixture)')

  await act(async () => {
    root.unmount()
  })
  host.remove()

  // Empty file: a placeholder hint instead of a blank area
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
  assert.ok(placeholder, 'empty files must render the placeholder hint')
  assert.ok(placeholder.textContent?.includes('The file is empty'), 'the placeholder copy must be the empty-file message')

  await act(async () => {
    root2.unmount()
  })
  host2.remove()
})

test('SkillDetailDrawer: shared-root skills annotate their source with no edit entry', { timeout: 60_000 }, () => {
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

  assert.ok(html.includes('Shared'), 'shared-root skills must show the shared badge')
  assert.ok(html.includes('badge-accent'), 'shared-root skills must use the badge-accent style')
  assert.ok(html.includes('Machine-level shared root'), 'shared-root skills must annotate the source')
  assert.ok(!html.includes('Workspace'), 'shared-root skills must not be labeled workspace')
  assert.doesNotMatch(html, emojiRegex, 'SkillDetailDrawer output must contain no emoji')
})

test('SkillDetailDrawer: renders the empty state when no skill is selected', { timeout: 60_000 }, () => {
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

  assert.ok(html.includes('No skill selected'), 'the no-skill-selected empty state must render')
  assert.doesNotMatch(html, emojiRegex, 'the empty state must contain no emoji')
})

test('SkillDetailDrawer: async body reads with algebraic race protection (loadGenerationRef)', { timeout: 60_000 }, async () => {
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
          skill: mockSkills[1], // code-review: 1 reference
          open: true,
          inline: true,
          readSkill: racingReader,
          onClose: () => {},
        }),
      ),
    )
  })

  // Switching files via the dropdown triggers a second request
  await chooseFileOption(host, 'checklist.md')
  assert.equal(callCount, 2, 'switching files must issue a second read')

  // The second (fast) request completes first
  await act(async () => {
    fastResolve({ text: '快速新请求内容' })
  })
  assert.ok(
    host.querySelector('.skill-reader-body')?.textContent?.includes('快速新请求内容'),
    'the new request result is displayed (zh fixture)',
  )

  // The first (slow) request completes later; verify it cannot overwrite backwards
  await act(async () => {
    slowResolve({ text: '过期的慢请求内容' })
  })
  assert.ok(
    !host.querySelector('.skill-reader-body')?.textContent?.includes('过期的慢请求内容'),
    'a stale request returning later must never overwrite the newer result (zh fixture)',
  )

  await act(async () => {
    root.unmount()
  })
  host.remove()
})

test('SkillDetailDrawer: skill.description no longer renders as a standalone block; descriptions come only from the frontmatter table', { timeout: 60_000 }, async () => {
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

  // The model-level skill.description never enters the reader: no standalone description block, no expand/collapse button
  assert.ok(host.querySelector('.skill-reader-desc') === null, 'no standalone description block may render')
  assert.ok(host.querySelector('.skill-reader-desc-text') === null, 'no standalone description text node may render')
  assert.ok(host.querySelector('.skill-reader-desc-toggle') === null, 'no expand/collapse button may render')
  const readerEl = host.querySelector('.skill-reader') as HTMLElement
  assert.ok(readerEl, 'the skill-reader must render')
  assert.ok(!readerEl.textContent?.includes(longDesc), 'the model description field must not enter the reader directly')

  // Description info comes only from the frontmatter-converted metadata table, in the same content flow as the body
  const doc = host.querySelector('.skill-reader-doc') as HTMLElement
  assert.ok(doc, 'the unified document content flow must render')
  const cells = Array.from(doc.querySelectorAll('table td')).map((td) => td.textContent)
  assert.ok(cells.includes('description'), 'the metadata table must include the description field row')
  assert.ok(cells.includes('文件内描述'), 'the description value must come from the in-file frontmatter, not the model field (zh fixture)')
  assert.ok(doc.textContent?.includes('规程正文'), 'the body renders in the same flow as the metadata table (zh fixture)')

  await act(async () => {
    root.unmount()
  })
  host.remove()
})

test('SkillDetailDrawer: layout contract — the toolbar hugs the header; metadata and body share one scroll area', { timeout: 60_000 }, async () => {
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
          initialContent: '# Helmx CLI 技能规范\n\n正文。',
          onClose: () => {},
        }),
      ),
    )
  })

  const reader = host.querySelector('.skill-reader') as HTMLElement
  assert.ok(reader, 'the skill-reader must render')
  const children = Array.from(reader.children) as HTMLElement[]

  // The toolbar is the reader's first child: hugging the drawer header with no standalone blocks in between
  assert.equal(children.length, 2, 'the reader holds exactly the toolbar and the scroll area')
  assert.ok(children[0]?.classList.contains('skill-reader-toolbar'), 'the toolbar must be the first child')
  assert.ok(children[1]?.classList.contains('skill-reader-scroll'), 'the second child must be the single scroll area')

  // Inside the scroll area only the body reader; the metadata table and body share the .skill-reader-doc flow
  const scroll = children[1]!
  const scrollChildren = Array.from(scroll.children) as HTMLElement[]
  assert.equal(scrollChildren.length, 1, 'the scroll area holds only the body reader')
  assert.ok(scrollChildren[0]?.classList.contains('skill-reader-body'), 'the body reader must be the only child')
  assert.ok(scroll.querySelector('.skill-reader-body'), 'the body reader must live inside the scroll area')
  assert.ok(host.querySelector('.skill-reader-desc') === null, 'no standalone description block may sit between toolbar and body')
  // The copy button carries the skill-reader-copy class (the style hook for mobile hiding text and keeping the icon)
  assert.ok(host.querySelector('.skill-reader-copy'), 'the copy button must carry the skill-reader-copy class')

  await act(async () => {
    root.unmount()
  })
  host.remove()
})

// ---------------------------------------------------------------------------
// 5. SkillCenter component tests
// ---------------------------------------------------------------------------

test('SkillCenter: SSR renders the top bar, search bar, grid flow and zero-emoji rule', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    skills: mockSkills,
    primaryTarget: { kind: 'skills' },
  })

  const html = renderToString(
    e(
      HostStoreProviders,
      { value: store },
      e(SkillCenter, { inlineDrawer: true }),
    ),
  )

  // Top bar assertions (subtitle and stats summary removed per the minimal top-bar contract)
  assert.ok(html.includes('primary-center-topbar'), 'must include the primary-center-topbar')
  assert.ok(html.includes('Skills Center'), 'must show the Skills Center title')
  assert.ok(!html.includes('primary-center-subtitle'), 'the subtitle must no longer render')

  // Search bar and category tabs
  assert.ok(html.includes('primary-center-toolbar'), 'must include the primary-center-toolbar')
  assert.ok(html.includes('Search skill name, ID, description or reference files'), 'must include the search placeholder')
  assert.ok(html.includes('primary-category-pill'), 'must include the category filter pills')
  assert.ok(html.includes('All'), 'must include the All tab')
  assert.ok(html.includes('Built-in'), 'must include the Built-in tab')
  assert.ok(html.includes('Shared'), 'must include the Shared tab')
  assert.ok(html.includes('Workspace'), 'must include the Workspace tab')
  assert.ok(html.includes('Plugins'), 'must include the Plugins tab')

  // Card grid
  assert.ok(html.includes('primary-center-grid'), 'must include the primary-center-grid')
  assert.ok(html.includes('Helmx 命令行操作手册'), 'the grid must render mock skill cards (zh fixture)')
  assert.ok(html.includes('工程代码审查规范'), 'the grid must render mock skill cards (zh fixture)')

  // Zero-emoji assertion
  assert.doesNotMatch(html, emojiRegex, 'SkillCenter output must contain no emoji anywhere')
})

test('SkillCenter: renders the empty state with zero emoji when nothing matches', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    skills: [],
    primaryTarget: { kind: 'skills' },
  })

  const html = renderToString(
    e(
      HostStoreProviders,
      { value: store },
      e(SkillCenter, { inlineDrawer: true }),
    ),
  )

  assert.ok(html.includes('primary-center-empty'), 'primary-center-empty must render without data')
  assert.ok(html.includes('No matching skills'), 'must hint that no skills match')
  assert.doesNotMatch(html, emojiRegex, 'the empty state must contain no emoji')
})

test('SkillCenter: zh-CN locale renders the localized center copy', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    locale: 'zh-CN',
    skills: mockSkills,
    primaryTarget: { kind: 'skills' },
  })

  const html = renderToString(
    e(
      HostStoreProviders,
      { value: store },
      e(SkillCenter, { inlineDrawer: true }),
    ),
  )

  assert.ok(html.includes('技能中心'), 'must render the localized title')
  assert.ok(html.includes('刷新技能清单'), 'must render the localized refresh title')
  assert.ok(html.includes('搜索技能名称、ID、描述或参考文件…'), 'must render the localized search placeholder')
  assert.ok(html.includes('aria-label="技能分类筛选"'), 'must render the localized filter aria-label')
  assert.ok(html.includes('全部'), 'must render the localized All tab')
  assert.ok(html.includes('内置'), 'must render the localized Built-in tab')
  assert.ok(html.includes('插件'), 'must render the localized Plugins tab')
  assert.ok(html.includes('共享'), 'must render the localized Shared tab')
  assert.ok(html.includes('工作区'), 'must render the localized Workspace tab')
  assert.ok(html.includes('暂无描述') === false, 'skills with descriptions never show the no-description fallback')
  assert.ok(!html.includes('Skills Center'), 'the English title must not render in zh-CN')
  assert.doesNotMatch(html, emojiRegex, 'zh-CN SkillCenter output must contain no emoji')
})

test('SkillCard: zh-CN locale renders localized card copy via the store translator', { timeout: 60_000 }, () => {
  const noDescSkill: SkillSummary = { ...mockSkills[2], description: '' }
  const store = makeTestStore({
    locale: 'zh-CN',
    skills: mockSkills,
    primaryTarget: { kind: 'skills' },
  })

  const html = renderToString(
    e(
      HostStoreProviders,
      { value: store },
      e(SkillCard, { skill: noDescSkill, selected: false, onSelect: () => {} }),
    ),
  )

  assert.ok(html.includes('暂无描述'), 'a missing description must fall back to the localized no-description copy')
  assert.ok(html.includes('title="来源：工作区"'), 'the source badge title must render the localized copy')
  assert.ok(!html.includes('No description'), 'the English fallback must not render in zh-CN')
})

test('SkillCenter: interactive filtering, search and drawer wiring (openTarget)', { timeout: 60_000 }, async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  const store = makeTestStore({
    skills: mockSkills,
    primaryTarget: { kind: 'skills' },
  })

  await act(async () => {
    root.render(
      e(
        HostStoreProviders,
        { value: store },
        e(SkillCenter, { inlineDrawer: true }),
      ),
    )
  })

  // 1. Search filtering
  const searchInput = host.querySelector('.primary-search-box input') as HTMLInputElement
  assert.ok(searchInput, 'the search input must be found')

  await act(async () => {
    typeIntoInput(searchInput, 'PostgreSQL')
  })

  let cards = host.querySelectorAll('.skill-card')
  assert.equal(cards.length, 1, 'searching PostgreSQL must filter down to one card')
  assert.ok(cards[0]!.textContent?.includes('数据库迁移演练'))

  // 2. Clear the search
  const clearBtn = host.querySelector('.primary-search-clear') as HTMLButtonElement
  assert.ok(clearBtn, 'the clear-search button must appear')
  await act(async () => {
    clearBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  cards = host.querySelectorAll('.skill-card')
  assert.equal(cards.length, 6, 'clearing the search restores all cards')

  // 3. Category pill filtering
  const pills = Array.from(host.querySelectorAll('.primary-category-pill')) as HTMLButtonElement[]
  const builtinPill = pills.find((p) => p.textContent?.includes('Built-in'))
  assert.ok(builtinPill, 'the Built-in pill must be found')

  await act(async () => {
    builtinPill.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  cards = host.querySelectorAll('.skill-card')
  assert.equal(cards.length, 2, 'the Built-in tab must show exactly the 2 built-in skills')

  // 3.5 Shared category pill: only source=agents skills
  const agentsPill = pills.find((p) => p.textContent?.includes('Shared'))
  assert.ok(agentsPill, 'the Shared pill must be found')
  await act(async () => {
    agentsPill.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  cards = host.querySelectorAll('.skill-card')
  assert.equal(cards.length, 1, 'the Shared tab must show exactly the 1 shared-root skill')
  assert.ok(cards[0]!.textContent?.includes('git-commit'), 'the shared card must be git-commit')

  // Restore All, then click a card to trigger openTarget
  const allPill = pills.find((p) => p.textContent?.includes('All'))
  assert.ok(allPill)
  await act(async () => {
    allPill.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  cards = host.querySelectorAll('.skill-card')
  assert.equal(cards.length, 6, 'restoring All returns to the full card set')

  // 4. Clicking a card triggers openTarget to open the drawer（经真实导航目标断言）
  await act(async () => {
    cards[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'skills', skillId: 'helmx-cli' })

  await act(async () => {
    root.unmount()
  })
  host.remove()
})

// ---------------------------------------------------------------------------
// 技能作用域（物理坐标 nodeId+cwd）纯函数与 action 边界校验
// ---------------------------------------------------------------------------

const convSummary = (id: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id,
  title: `会话 ${id}`,
  profileId: 'assistant',
  tags: [],
  cwd: '/tmp',
  model: 'faux/model',
  thinkingLevel: '',
  status: 'idle',
  stateChangeSeq: 1,
  completionSeq: 0,
  unread: false,
  pinned: false,
  pendingAskCount: 0,
  createdAt: id,
  updatedAt: id,
  ...overrides,
})

test('skill-scope-model: buildSkillScopeCandidates 会话在前按 updatedAt 倒序、角色显式 cwd 去重、nodeId 归一 local', { timeout: 60_000 }, () => {
  const conversations = [
    convSummary(1, { cwd: '/old/work', updatedAt: 10 }),
    convSummary(2, { nodeId: 'remote-1', cwd: '/remote/work', updatedAt: 30 }),
    convSummary(3, { cwd: '/new/work', updatedAt: 20 }),
    // 与会话 2 同坐标（不同会话）：去重
    convSummary(4, { nodeId: 'remote-1', cwd: '/remote/work', updatedAt: 5 }),
  ]
  const profiles: Array<Pick<Profile, 'id' | 'nodeId' | 'cwd'>> = [
    { id: 'assistant', nodeId: undefined, cwd: '/tmp' },            // 显式 cwd，local
    { id: 'coder', nodeId: 'remote-1', cwd: '/remote/work' },       // 与会话 2 同坐标：去重
    { id: 'wanderer', nodeId: 'remote-2', cwd: undefined },          // 无显式 cwd：不产候选
    { id: 'blank', nodeId: '  ', cwd: '   ' },                       // 空白：不产候选
  ]
  const candidates = buildSkillScopeCandidates(conversations, profiles)
  assert.deepEqual(
    candidates.map((c) => skillScopeKey(c)),
    [
      'remote-1\u0000/remote/work', // updatedAt 30 最先
      'local\u0000/new/work',
      'local\u0000/old/work',
      'local\u0000/tmp', // profile 显式 cwd（无重复）
    ],
  )
  assert.deepEqual(
    candidates.map((c) => c.origin),
    ['conversation', 'conversation', 'conversation', 'profile'],
  )
  // nodeId 缺省归一 local
  assert.equal(candidates[1]!.nodeId, 'local')
})

test('skill-scope-model: parseSkillScopeEnv 成对才构成作用域，半参数显式标记 partial', { timeout: 60_000 }, () => {
  assert.deepEqual(parseSkillScopeEnv(undefined), { scope: undefined, partial: false })
  assert.deepEqual(parseSkillScopeEnv({}), { scope: undefined, partial: false })
  assert.deepEqual(parseSkillScopeEnv({ nodeId: 'remote-1', cwd: '/w' }), {
    scope: { nodeId: 'remote-1', cwd: '/w' },
    partial: false,
  })
  // 只有一键（或值为空白）：不猜工作区，交由调用方自愈
  assert.deepEqual(parseSkillScopeEnv({ nodeId: 'remote-1' }), { scope: undefined, partial: true })
  assert.deepEqual(parseSkillScopeEnv({ cwd: '/w' }), { scope: undefined, partial: true })
  assert.deepEqual(parseSkillScopeEnv({ nodeId: '  ', cwd: '' }), { scope: undefined, partial: true })
})

test('skill-scope-model: skillScopeTargetEnv 目标形状稳定（Hub 无环境字段、带详情保留 skillId）', { timeout: 60_000 }, () => {
  assert.deepEqual(skillScopeTargetEnv(undefined), { kind: 'skills' })
  assert.deepEqual(skillScopeTargetEnv(undefined, { skillId: 'x' }), { kind: 'skills', skillId: 'x' })
  assert.deepEqual(skillScopeTargetEnv({ nodeId: 'n1', cwd: '/a' }), { kind: 'skills', nodeId: 'n1', cwd: '/a' })
  assert.deepEqual(skillScopeTargetEnv({ nodeId: 'n1', cwd: '/a' }, { skillId: 'x' }), {
    kind: 'skills',
    skillId: 'x',
    nodeId: 'n1',
    cwd: '/a',
  })
})

test('skill-scope-model: conversationSkillScope 与 standbySkillScope 的坐标归一', { timeout: 60_000 }, () => {
  assert.deepEqual(conversationSkillScope({ cwd: '/w' }), { nodeId: 'local', cwd: '/w' })
  assert.deepEqual(conversationSkillScope({ nodeId: 'remote', cwd: '/w' }), { nodeId: 'remote', cwd: '/w' })
  assert.equal(conversationSkillScope({ cwd: '' }), undefined, '无 cwd 的占位会话按 Hub 处理')

  // 待命草稿：显式定制优先（nodeId 空白归 local）；未定制回退角色显式 cwd；两处皆无 → Hub
  assert.deepEqual(
    standbySkillScope({ envCustomized: true, envNodeId: '', envCwd: '/draft' }, { nodeId: 'remote', cwd: '/profile' }),
    { nodeId: 'local', cwd: '/draft' },
  )
  assert.deepEqual(
    standbySkillScope({ envCustomized: false }, { nodeId: 'remote', cwd: '/profile' }),
    { nodeId: 'remote', cwd: '/profile' },
  )
  assert.equal(standbySkillScope({ envCustomized: false }, { cwd: undefined }), undefined)
  assert.equal(standbySkillScope({ envCustomized: false }, undefined), undefined)
})

test('skill-center-model: source=node 技能独立分类（tab、计数、徽章），不再折入工作区', { timeout: 60_000 }, () => {
  const nodeSkill = makeSkill({ id: 'deploy-runbook', source: 'node' })
  assert.equal(isSkillInTab(nodeSkill, 'node'), true)
  assert.equal(isSkillInTab(nodeSkill, 'workspace'), false)
  assert.equal(isSkillInTab(nodeSkill, 'all'), true)
  const counts = buildSkillCategoryCounts([...mockSkills, nodeSkill])
  assert.equal(counts.node, 1)
  assert.equal(counts.all, 7)
  assert.equal(counts.workspace, 2, '节点技能不挤占工作区计数')
  const badge = getSkillSourceBadge(nodeSkill)
  assert.equal(badge.variant, 'node')
  assert.equal(badge.label, 'Node')
})

test('skill-scope-api: parseSkillCatalogResult 边界校验（合法全形状 / 各字段非法显式拒绝）', { timeout: 60_000 }, () => {
  const valid = parseSkillCatalogResult({
    nodeId: 'remote-1',
    cwd: '/remote/work',
    skills: [
      { id: 'hub-skill', name: 'Hub', references: ['references/a.md'], managedByPlugin: 'builtin:profile' },
      { id: 'node-skill', name: '节点', references: [], source: 'node', description: '来自节点工作区' },
    ],
    shadowedNodeSkillIds: ['dup'],
    nodeUnavailable: '目标节点 remote-1 当前离线',
  })
  assert.equal(valid.skills.length, 2)
  assert.equal(valid.skills[1]!.source, 'node')
  assert.deepEqual(valid.shadowedNodeSkillIds, ['dup'])
  assert.equal(valid.nodeUnavailable, '目标节点 remote-1 当前离线')

  // 可省字段缺省（echo 坐标为 required）
  const minimal = parseSkillCatalogResult({ nodeId: 'local', cwd: '/w', skills: [] })
  assert.deepEqual(minimal, { skills: [], shadowedNodeSkillIds: [] })

  // 非法形状显式拒绝（绝不静默截断/编造）
  assert.throws(() => parseSkillCatalogResult(null), /skill_catalog/)
  assert.throws(() => parseSkillCatalogResult({}), /nodeId/)
  assert.throws(() => parseSkillCatalogResult({ skills: [] }), /nodeId/)
  assert.throws(() => parseSkillCatalogResult({ nodeId: '  ', cwd: '/w', skills: [] }), /nodeId/)
  assert.throws(() => parseSkillCatalogResult({ nodeId: 'local', skills: [] }), /cwd/)
  assert.throws(() => parseSkillCatalogResult({ nodeId: 'local', cwd: 5, skills: [] }), /cwd/)
  assert.throws(() => parseSkillCatalogResult({ nodeId: 'local', cwd: '/w' }), /skills/)
  assert.throws(() => parseSkillCatalogResult({ nodeId: 'local', cwd: '/w', skills: 'x' }), /skills/)
  assert.throws(() => parseSkillCatalogResult({ nodeId: 'local', cwd: '/w', skills: [{ id: '', name: 'x', references: [] }] }), /id/)
  assert.throws(() => parseSkillCatalogResult({ nodeId: 'local', cwd: '/w', skills: [{ id: 'a', name: 1, references: [] }] }), /name/)
  assert.throws(() => parseSkillCatalogResult({ nodeId: 'local', cwd: '/w', skills: [{ id: 'a', name: 'x', references: [1] }] }), /references/)
  assert.throws(() => parseSkillCatalogResult({ nodeId: 'local', cwd: '/w', skills: [], shadowedNodeSkillIds: [1] }), /shadowedNodeSkillIds/)
  assert.throws(() => parseSkillCatalogResult({ nodeId: 'local', cwd: '/w', skills: [], nodeUnavailable: 5 }), /nodeUnavailable/)
  assert.throws(() => parseSkillCatalogResult({ nodeId: 'local', cwd: '/w', skills: [{ id: 'a', name: 'x', references: [], source: 'weird' }] }), /source/)
})

test('skill-scope-api: fetch/read 调用形状（pluginId、actionId、input 边界）', { timeout: 60_000 }, async () => {
  const calls: Array<{ pluginId: string; actionId: string; input: unknown }> = []
  const invoke = async (pluginId: string, actionId: string, input: unknown): Promise<unknown> => {
    calls.push({ pluginId, actionId, input })
    if (actionId === 'skill_catalog') return { nodeId: 'remote-1', cwd: '/w', skills: [], shadowedNodeSkillIds: [] }
    return { text: '# SKILL' }
  }
  const catalog = await fetchScopedSkillCatalog(invoke, { nodeId: 'remote-1', cwd: '/w' })
  assert.deepEqual(catalog, { skills: [], shadowedNodeSkillIds: [] })
  assert.deepEqual(calls[0], {
    pluginId: 'builtin:profile',
    actionId: 'skill_catalog',
    input: { nodeId: 'remote-1', cwd: '/w' },
  })

  // 主文件读取不携带 path 键；references 读取原样透传
  const main = await readScopedSkillFile(invoke, { nodeId: 'local', cwd: '/w' }, 'node-skill')
  assert.equal(main.text, '# SKILL')
  assert.deepEqual(calls[1]!.input, { nodeId: 'local', cwd: '/w', skillId: 'node-skill' })
  await readScopedSkillFile(invoke, { nodeId: 'local', cwd: '/w' }, 'node-skill', 'references/guide.md')
  assert.deepEqual(calls[2]!.input, {
    nodeId: 'local',
    cwd: '/w',
    skillId: 'node-skill',
    path: 'references/guide.md',
  })

  // 读取输出同样过边界校验
  assert.deepEqual(parseSkillReadResult({ text: 'x' }), { text: 'x' })
  assert.throws(() => parseSkillReadResult({}), /text/)
  assert.throws(() => parseSkillReadResult('nope'), /skill_read/)
})

// ---------------------------------------------------------------------------
// SkillCenter 作用域组件行为（真实 store + fetch 桩）
// ---------------------------------------------------------------------------

interface CapturedActionCall {
  pluginId: string
  actionId: string
  input: Record<string, unknown>
}

interface ScopeFetchStub {
  calls: CapturedActionCall[]
  catalogResponse: (input: Record<string, unknown>) => unknown
  readResponse: (input: Record<string, unknown>) => unknown
  restore: () => void
}

/** 桩化全局 fetch：仅响应 builtin:profile 技能 action，其余 404（测试不应触达）。 */
function stubSkillActions(overrides: Partial<Pick<ScopeFetchStub, 'catalogResponse' | 'readResponse'>> = {}): ScopeFetchStub {
  const originalFetch = globalThis.fetch
  const calls: CapturedActionCall[] = []
  const stub: ScopeFetchStub = {
    calls,
    catalogResponse:
      overrides.catalogResponse ??
      ((input: Record<string, unknown>) => ({
        nodeId: String(input.nodeId ?? ''),
        cwd: String(input.cwd ?? ''),
        skills: [],
        shadowedNodeSkillIds: [],
      })),
    readResponse: overrides.readResponse ?? (() => ({ text: '' })),
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const match = /^\/api\/actions\/([^/]+)\/([^/?]+)$/.exec(url)
    if (match === null || String(init?.method ?? 'GET') !== 'POST') {
      return new Response(JSON.stringify({ error: { code: 'not_found', message: `unexpected fetch ${url}` } }), { status: 404 })
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { input?: Record<string, unknown> }
    const actionInput = body.input ?? {}
    calls.push({ pluginId: decodeURIComponent(match[1]!), actionId: decodeURIComponent(match[2]!), input: actionInput })
    const payload =
      decodeURIComponent(match[2]!) === 'skill_catalog' ? stub.catalogResponse(actionInput) : stub.readResponse(actionInput)
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return stub
}

const scopedNodeSkill: SkillSummary = {
  id: 'deploy-runbook',
  name: '部署规程',
  description: '节点工作区技能',
  references: ['references/rollout.md'],
  source: 'node',
}

const scopedHubSkill: SkillSummary = {
  id: 'helmx-cli',
  name: 'Helmx CLI',
  description: 'Hub 技能（合并目录内）',
  references: [],
  managedByPlugin: 'builtin:profile',
}

function makeScopedStore(env: { nodeId?: string; cwd?: string } | undefined): HelmxExternalStore {
  return makeTestStore({
    skills: [mockSkills[0]!],
    primaryTarget: {
      kind: 'skills',
      ...(env?.nodeId !== undefined ? { nodeId: env.nodeId } : {}),
      ...(env?.cwd !== undefined ? { cwd: env.cwd } : {}),
    },
    conversations: [
      convSummary(2, { nodeId: 'remote-1', cwd: '/remote/work', updatedAt: 30 }),
      convSummary(1, { cwd: '/local/work', updatedAt: 10 }),
    ],
    profiles: [{ id: 'assistant', name: '个人助理', cwd: '/tmp' }] satisfies Profile[],
  })
}

async function renderSkillCenter(store: HelmxExternalStore): Promise<{ host: HTMLElement; root: ReturnType<typeof ReactDOMClient.createRoot> }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)
  await act(async () => {
    root.render(e(HostStoreProviders, { value: store }, e(SkillCenter, { inlineDrawer: true })))
  })
  await act(async () => {
    await flushMacrotask()
  })
  return { host, root }
}

test('SkillCenter: 作用域深链渲染合并目录、节点分类与显式诊断（不可用/同名遮蔽）', { timeout: 60_000 }, async () => {
  const stub = stubSkillActions({
    catalogResponse: (input) => {
      assert.deepEqual(input, { nodeId: 'remote-1', cwd: '/remote/work' }, '目录请求携带物理坐标')
      return {
        nodeId: 'remote-1',
        cwd: '/remote/work',
        skills: [scopedHubSkill, scopedNodeSkill],
        shadowedNodeSkillIds: ['code-review'],
        nodeUnavailable: '目标节点 remote-1 当前离线，未能读取其工作区技能库。',
      }
    },
  })
  try {
    const store = makeScopedStore({ nodeId: 'remote-1', cwd: '/remote/work' })
    const { host, root } = await renderSkillCenter(store)

    // 节点分类 pill 计数为 1；卡片渲染节点徽章
    const nodePill = Array.from(host.querySelectorAll('.primary-category-pill')).find((p) =>
      p.textContent?.includes('Node'),
    )
    assert.ok(nodePill, '节点分类 pill 必须渲染')
    assert.ok(nodePill!.textContent?.includes('1'), '节点技能计数为 1')
    const card = host.querySelector('[data-skill-id="deploy-runbook"]')
    assert.ok(card, '节点技能卡片必须渲染')
    assert.ok(card!.textContent?.includes('Node'), '卡片来源徽章为 Node')

    // 显式诊断：不可用 + 同名遮蔽（绝不静默）
    const diagnostics = host.querySelector('.skill-scope-diagnostics')!.textContent ?? ''
    assert.ok(diagnostics.includes('目标节点 remote-1 当前离线'), 'nodeUnavailable 诊断如实展示')
    assert.ok(diagnostics.includes('code-review'), '同名遮蔽报告被遮蔽的节点技能 id')

    assert.equal(stub.calls.filter((c) => c.actionId === 'skill_catalog').length, 1, 'Hub 之外的目录只经 action 拉取一次')

    await act(async () => {
      root.unmount()
    })
    host.remove()
  } finally {
    stub.restore()
  }
})

test('SkillCenter: 节点技能详情经 action 读取并展示节点来源；关闭详情保留作用域参数', { timeout: 60_000 }, async () => {
  const stub = stubSkillActions({
    catalogResponse: () => ({
      nodeId: 'remote-1',
      cwd: '/remote/work',
      skills: [scopedHubSkill, scopedNodeSkill],
      shadowedNodeSkillIds: [],
    }),
    readResponse: (input) => {
      assert.deepEqual(input, {
        nodeId: 'remote-1',
        cwd: '/remote/work',
        skillId: 'deploy-runbook',
      })
      return { text: '# 部署规程\n\n按节点工作区规程执行。' }
    },
  })
  try {
    const store = makeScopedStore({ nodeId: 'remote-1', cwd: '/remote/work' })
    const { host, root } = await renderSkillCenter(store)

    const card = host.querySelector('[data-skill-id="deploy-runbook"]') as HTMLElement
    assert.ok(card)
    await act(async () => {
      card.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(store.getPrimaryTarget(), {
      kind: 'skills',
      skillId: 'deploy-runbook',
      nodeId: 'remote-1',
      cwd: '/remote/work',
    }, '打开详情保留作用域环境')

    await act(async () => {
      await flushMacrotask()
    })
    // 详情抽屉：节点来源标注 + 经 action 读到的正文
    const drawer = host.querySelector('.skill-drawer-content') as HTMLElement
    assert.ok(drawer, '详情抽屉打开')
    assert.ok(drawer.textContent?.includes('Node workspace source: remote-1 · /remote/work'), '节点来源坐标如实标注')
    assert.ok(drawer.textContent?.includes('按节点工作区规程执行'), '正文来自 skill_read action')
    const readCall = stub.calls.find((c) => c.actionId === 'skill_read')
    assert.ok(readCall, '节点技能读取必须经 skill_read action')
    assert.equal(readCall!.input.skillId, 'deploy-runbook')

    // 关闭详情：回到列表但作用域参数仍在（目标上携带）
    const closeBtn = drawer.querySelector('button[aria-label="Close"]') as HTMLButtonElement
    assert.ok(closeBtn)
    await act(async () => {
      closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(store.getPrimaryTarget(), {
      kind: 'skills',
      nodeId: 'remote-1',
      cwd: '/remote/work',
    }, '关闭详情保留作用域环境')

    await act(async () => {
      root.unmount()
    })
    host.remove()
  } finally {
    stub.restore()
  }
})

test('SkillCenter: 作用域目录加载失败显式报错并可重试；Hub 默认作用域不经 action', { timeout: 60_000 }, async () => {
  const stub = stubSkillActions({
    catalogResponse: () => ({ nodeId: 'local', cwd: '/local/work', skills: [], shadowedNodeSkillIds: [] }),
  })
  // 先用失败响应渲染
  const originalCatalog = stub.catalogResponse
  stub.catalogResponse = () => ({
    nodeId: 'local',
    cwd: '/local/work',
    skills: [{ id: 'broken', name: 'x', references: 'not-an-array' }],
  })
  try {
    const store = makeScopedStore({ nodeId: 'local', cwd: '/local/work' })
    const { host, root } = await renderSkillCenter(store)

    let diagnostics = host.querySelector('.skill-scope-diagnostics')?.textContent ?? ''
    assert.ok(diagnostics.includes('Failed to load the merged skill catalog'), '非法输出在边界显式报错（英文文案）')
    assert.ok(host.querySelector('.skill-scope-diagnostics .btn'), '提供重试入口')

    // 重试：恢复正常形状后收敛
    stub.catalogResponse = originalCatalog
    const retryBtn = host.querySelector('.skill-scope-diagnostics .btn') as HTMLButtonElement
    await act(async () => {
      retryBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await flushMacrotask()
    })
    diagnostics = host.querySelector('.skill-scope-diagnostics')?.textContent ?? ''
    assert.ok(!diagnostics.includes('Failed to load the merged skill catalog'), '重试成功后错误横幅消失')

    await act(async () => {
      root.unmount()
    })
    host.remove()
  } finally {
    stub.restore()
  }

  // Hub 默认作用域：零 action 调用，直用 store 技能
  const hubStub = stubSkillActions()
  try {
    const store = makeScopedStore(undefined)
    const { host, root } = await renderSkillCenter(store)
    assert.equal(hubStub.calls.length, 0, 'Hub 作用域不触发 action')
    assert.ok(host.querySelector('[data-skill-id="helmx-cli"]'), 'Hub 技能来自 store 目录')
    assert.ok(host.querySelector('.skill-scope-diagnostics') === null, '无作用域诊断区')
    await act(async () => {
      root.unmount()
    })
    host.remove()
  } finally {
    hubStub.restore()
  }
})

test('SkillCenter: 切换作用域的代数竞争保护——慢的旧目录不得覆盖新作用域', { timeout: 60_000 }, async () => {
  const originalFetch = globalThis.fetch
  const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>()
  const catalogSkills: Record<string, SkillSummary[]> = {
    'remote-1|/remote/work': [{ ...scopedNodeSkill, id: 'remote-skill' }],
    'local|/local/work': [{ ...scopedNodeSkill, id: 'local-skill' }],
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const match = /^\/api\/actions\/([^/]+)\/([^/?]+)$/.exec(url)
    if (match === null || decodeURIComponent(match[2]!) !== 'skill_catalog') {
      return new Response(JSON.stringify({ text: '' }), { status: 200 })
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { input?: Record<string, unknown> }
    const key = `${String(body.input?.nodeId)}|${String(body.input?.cwd)}`
    let resolve!: () => void
    const promise = new Promise<void>((r) => { resolve = r })
    gates.set(key, { promise, resolve })
    await promise
    return new Response(
      JSON.stringify({
        nodeId: String(body.input?.nodeId ?? ''),
        cwd: String(body.input?.cwd ?? ''),
        skills: catalogSkills[key] ?? [],
        shadowedNodeSkillIds: [],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch

  try {
    const store = makeScopedStore({ nodeId: 'remote-1', cwd: '/remote/work' })
    const { host, root } = await renderSkillCenter(store)
    assert.ok(gates.has('remote-1|/remote/work'), '第一个作用域请求已挂起')

    // 未等第一个返回就切到第二个作用域
    await act(async () => {
      store.openTarget({ kind: 'skills', nodeId: 'local', cwd: '/local/work' })
    })
    await act(async () => {
      await flushMacrotask()
    })
    assert.ok(gates.has('local|/local/work'), '第二个作用域请求已挂起')

    // 第二个先返回：界面收敛到 local 目录
    await act(async () => {
      gates.get('local|/local/work')!.resolve()
      await flushMacrotask()
    })
    assert.ok(host.querySelector('[data-skill-id="local-skill"]'), '新作用域数据渲染')

    // 第一个（旧作用域）迟到的返回不得反向覆盖
    await act(async () => {
      gates.get('remote-1|/remote/work')!.resolve()
      await flushMacrotask()
    })
    assert.ok(host.querySelector('[data-skill-id="local-skill"]'), '迟到旧数据被竞争保护丢弃')
    assert.ok(host.querySelector('[data-skill-id="remote-skill"]') === null)

    await act(async () => {
      root.unmount()
    })
    host.remove()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('SkillCenter: 半参数自愈——URL 只带 node 或 cwd 时清理为 Hub 并保持详情子项', { timeout: 60_000 }, async () => {
  const stub = stubSkillActions()
  try {
    const store = makeScopedStore({ nodeId: 'remote-1' })
    const { host, root } = await renderSkillCenter(store)

    assert.deepEqual(store.getPrimaryTarget(), { kind: 'skills' }, '半参数被自愈清理（replace）')
    assert.equal(stub.calls.length, 0, '半参数不触发目录请求')
    assert.ok(host.querySelector('.skill-scope-diagnostics') === null)

    await act(async () => {
      root.unmount()
    })
    host.remove()
  } finally {
    stub.restore()
  }
})
