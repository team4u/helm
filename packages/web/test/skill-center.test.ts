import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ensureHappyDom, typeIntoControl } from './helpers/dom-harness.js'

ensureHappyDom()

const React = (await import('react')).default
const { act } = await import('react')
const ReactDOMClient = await import('react-dom/client')
const { renderToString } = await import('react-dom/server')

import type { SkillSummary } from '@helm/protocol'
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
import {
  buildSkillFileList,
  extractSkillFrontmatter,
  isSkillMarkdownFile,
  renderSkillDocMarkdown,
  renderSkillFrontmatterTable,
  skillFileBasename,
  skillFileLanguage,
} from '../src/skills/skill-reader-model.js'
import { makeTestStore, HelmExternalStoreContext } from './helpers/store.js'

// The drawer and skill center carry the @radix-ui/react-select dependency
// graph and must be dynamically loaded after happy-dom
// GlobalRegistrator.register() (same convention as select.test.ts);
// otherwise Radix Select popovers cannot open in a pre-registered environment.
const { HostStoreProviders } = await import('./helpers/host-store.js')
// SkillCard statically imports HelmIcon via @helm/plugin-client (Radix dependency graph): dynamically loaded after register, same convention
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

/** Render the drawer inside a real host store context (MarkdownView depends on useHelmStore). */
function renderDrawerElement(props: React.ReactElement): React.ReactElement {
  return e(HelmExternalStoreContext.Provider, { value: makeTestStore() }, props)
}

/** Open the file picker via keyboard interaction and pick the given option (Radix Select has no native select). */
async function chooseFileOption(host: HTMLElement, optionText: string): Promise<void> {
  const trigger = host.querySelector('.skill-file-select .helm-select-trigger') as HTMLElement | null
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
// 1. Pure model tests (skill-center-model.ts)
// ---------------------------------------------------------------------------

test('skill-center-model: skill category pure functions (builtin / plugin / shared / workspace)', { timeout: 60_000 }, () => {
  const builtinAssistant = makeSkill({ id: 'assistant-helper', managedByPlugin: 'builtin:profile' })
  const builtinCli = makeSkill({ id: 'helm-cli', managedByPlugin: 'builtin:profile' })
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
  // 1. helm-cli (builtin:profile) -> builtin
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

  const emptyCounts = buildSkillCategoryCounts([])
  assert.deepEqual(emptyCounts, { all: 0, builtin: 0, workspace: 0, plugins: 0, agents: 0 })
})

test('skill-center-model: summarizeSkills metric summary', { timeout: 60_000 }, () => {
  const summary = summarizeSkills(mockSkills)
  assert.deepEqual(summary, {
    total: 6,
    builtin: 2,
    workspace: 2,
    plugins: 1,
    agents: 1,
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
  const idSearch = filterSkills(mockSkills, { query: 'helm-cli', categoryTab: 'all' })
  assert.equal(idSearch.length, 1)
  assert.equal(idSearch[0]!.id, 'helm-cli')

  // Keyword search by description
  const descSearch = filterSkills(mockSkills, { query: 'PostgreSQL', categoryTab: 'all' })
  assert.equal(descSearch.length, 1)
  assert.equal(descSearch[0]!.id, 'database-migration')

  // Keyword search by reference files
  const refSearch = filterSkills(mockSkills, { query: 'generative-ui.md', categoryTab: 'all' })
  assert.equal(refSearch.length, 1)
  assert.equal(refSearch[0]!.id, 'helm-cli')

  // Combined filter: category + search
  const comboMatch = filterSkills(mockSkills, { query: '多节点', categoryTab: 'builtin' })
  assert.equal(comboMatch.length, 1)
  assert.equal(comboMatch[0]!.id, 'herdr-deploy')

  const comboMismatch = filterSkills(mockSkills, { query: '多节点', categoryTab: 'workspace' })
  assert.equal(comboMismatch.length, 0)
})

test('skill-center-model: getSkillSourceBadge mapping', { timeout: 60_000 }, () => {
  const cliSkill = makeSkill({ id: 'helm-cli', managedByPlugin: 'builtin:profile' })
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
    renderSkillDocMarkdown('---\nname: helm-cli\ndescription: 手册\n---\n\n# 正文\n\n段落。'),
    [
      '## Skill metadata',
      '',
      '| Field | Value |',
      '| --- | --- |',
      '| name | helm-cli |',
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
  const skill = mockSkills[0] // helm-cli, 2 references
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
  assert.ok(html.includes('Helm 命令行操作手册'), 'must show the skill name (zh fixture)')
  assert.ok(html.includes('helm-cli'), 'must show the skill ID')
  assert.ok(html.includes('指导大模型通过 helm 命令行控制 Hub'), 'must show the description (zh fixture)')
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

  // Drawer structure assertions
  assert.ok(html.includes('primary-drawer-content'), 'must include primary-drawer-content')
  assert.ok(html.includes('primary-drawer-title'), 'must include the drawer title')
  assert.ok(html.includes('Helm 命令行操作手册'), 'must show the skill name (zh fixture)')
  assert.ok(html.includes('helm-cli'), 'must show the skill ID')
  assert.ok(html.includes('Built-in'), 'must show the built-in source badge')

  // Single-row file toolbar: shared Select trigger + reading mode toggle + file index and line count
  assert.ok(html.includes('skill-reader-toolbar'), 'must include the skill-reader-toolbar')
  assert.ok(html.includes('helm-select-trigger'), 'multi-file readers must use the shared Select dropdown')
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
  assert.ok(html.includes('Helm CLI 技能规范</h1>'), 'must render the Markdown heading (zh fixture)')
  assert.ok(html.includes('这是测试用 Markdown 文档正文。'), 'must render the body paragraph (zh fixture)')
  assert.ok(!html.includes('# Helm CLI 技能规范'), 'rich mode must not show raw Markdown hashes')

  // Zero-emoji assertion
  assert.doesNotMatch(html, emojiRegex, 'SkillDetailDrawer output must contain no emoji')
})

test('SkillDetailDrawer: rich mode converts frontmatter into a metadata table flowing with the body; source mode keeps the raw text', { timeout: 60_000 }, async () => {
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
    ['name', 'helm-cli'],
    ['description', '头部元信息'],
    ['managedByPlugin', 'builtin:profile'],
  ], 'fields keep their original YAML order')

  // The body follows in the same content flow; raw YAML key/value syntax never leaks
  assert.ok(doc.textContent?.includes('正文标题'), 'the body after the frontmatter must survive (zh fixture)')
  assert.ok(doc.textContent?.includes('内容段落。'), 'the body paragraph must survive (zh fixture)')
  assert.ok(!doc.textContent?.includes('name: helm-cli'), 'frontmatter must not render as raw YAML')
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
  assert.ok(codeWrap.textContent?.includes('name: helm-cli'), 'source mode must keep the raw YAML frontmatter')
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
  assert.equal(readCalls[0]!.id, 'helm-cli')
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
  assert.ok(host2.querySelector('.helm-select-trigger') === null, 'single-file readers have no Select trigger')
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
          initialContent: '# Helm CLI 技能规范\n\n正文。',
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
  assert.ok(html.includes('Helm 命令行操作手册'), 'the grid must render mock skill cards (zh fixture)')
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
  assert.deepEqual(store.getPrimaryTarget(), { kind: 'skills', skillId: 'helm-cli' })

  await act(async () => {
    root.unmount()
  })
  host.remove()
})
