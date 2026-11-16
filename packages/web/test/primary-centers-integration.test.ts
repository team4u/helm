/**
 * 四大中心（Profiles, Skills, Nodes, Models）端到端集成测试
 *
 * 覆盖：
 * 1. 侧栏底栏 5 大一级入口与路由激活契约：
 *    - 角色、模型与凭据、技能库、计算节点、插件中心均调用 store.openTarget；
 *    - 对应 primaryTarget 激活时呈现 .is-active 与 aria-current="page"；
 * 2. 命令面板（CommandPaletteModal）直达一级中心：
 *    - 四大快捷项点击执行 openTarget 并自动关闭面板；
 * 3. 路由契约与旧 URL 平滑升级：
 *    - 往返编解码支持 settings/<center>/<id> 路径段子项深链与分屏组合；
 *    - 旧 modal=profiles|providers|skills|nodes 自动升格为对应全屏一级视图；
 * 4. 四大中心组件群挂载与抽屉联动：
 *    - ProfileCenter、SkillCenter、NodeCenter、ModelCenter 渲染、卡片网格与抽屉交互；
 * 5. 铁律遵循静态扫描：
 *    - 四大中心全部组件源码与 App/Sidebar/CommandPalette 绝对 0 Emoji。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ensureHappyDom, flushMacrotask } from './helpers/dom-harness.js'

ensureHappyDom()

const React = (await import('react')).default
const { act } = await import('react')
const ReactDOMClient = await import('react-dom/client')
const { renderToString } = await import('react-dom/server')

const {
  parseLocationHash,
  formatLocationHash,
  upgradeLegacyLocationState,
} = await import('../src/lib/url-hash-model.js')
const { makeTestStore } = await import('./helpers/store.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { ProfileCenter } = await import('../src/profiles/ProfileCenter.js')
const { SkillCenter } = await import('../src/skills/SkillCenter.js')
const { NodeCenter } = await import('../src/nodes/NodeCenter.js')
const { ModelCenter } = await import('../src/models/ModelCenter.js')
const { Sidebar } = await import('../src/shell/Sidebar.js')
const { CommandPaletteModal } = await import('../src/modals/CommandPaletteModal.js')

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const e = React.createElement

// ---------------------------------------------------------------------------
// 1. 侧栏底栏 5 大一级入口与高亮状态契约
// ---------------------------------------------------------------------------

test('Sidebar：设置空间 5 大入口统一导航至一级目标，且激活态与路由对齐', { timeout: 60_000 }, async () => {
  const targets = [
    { kind: 'profiles' as const, label: 'Profile' },
    { kind: 'models' as const, label: 'Models & credentials' },
    { kind: 'skills' as const, label: 'Skills' },
    { kind: 'nodes' as const, label: 'Compute nodes' },
    { kind: 'plugins' as const, label: 'Plugin Center' },
  ]

  for (const { kind, label } of targets) {
    const store = makeTestStore({ primaryTarget: { kind } })
    const html = renderToString(e(HostStoreProviders, { value: store }, e(Sidebar)))
    assert.ok(html.includes('nav-item-active'), `当 primaryTarget=${kind} 时，${label} 行应高亮`)
    assert.ok(html.includes('aria-current="page"'), `当 primaryTarget=${kind} 时，${label} 行应设置 aria-current="page"`)
  }

  // 点击侧栏设置空间 5 个入口应调用对应 openTarget
  const opened: Array<{ kind: string }> = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)
  const store = makeTestStore({
    primaryTarget: { kind: 'profiles' },
    openTarget: (target) => {
      if (typeof target !== 'string') opened.push({ kind: target.kind })
    },
  })
  try {
    await act(async () => {
      root.render(e(HostStoreProviders, { value: store }, e(Sidebar)))
    })
    for (const { label } of targets) {
      const btn = Array.from(host.querySelectorAll<HTMLButtonElement>('button.nav-item-main')).find((el) =>
        el.textContent?.includes(label),
      )
      assert.ok(btn, `侧栏设置空间应渲染 ${label} 入口`)
      await act(async () => {
        btn.click()
      })
    }
    assert.deepEqual(
      opened,
      targets.map((t) => ({ kind: t.kind })),
      '侧栏Settings space 5 大入口均应调用 store.openTarget',
    )
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

// ---------------------------------------------------------------------------
// 2. 命令面板（CommandPaletteModal）一级目标分发
// ---------------------------------------------------------------------------

test('CommandPaletteModal：4 大快捷项点击统一分发一级路由并关闭面板', { timeout: 60_000 }, async () => {
  const cases = [
    { title: 'Open agent profile center', kind: 'profiles' },
    { title: 'Open models and credentials center', kind: 'models' },
    { title: 'Open skills center', kind: 'skills' },
    { title: 'Open compute nodes center', kind: 'nodes' },
  ] as const

  for (const item of cases) {
    const opened: unknown[] = []
    let closed = false
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = ReactDOMClient.createRoot(host)
    const store = makeTestStore({
      activeModal: { kind: 'command-palette' },
      openTarget: (target) => opened.push(target),
    })
    try {
      await act(async () => {
        root.render(e(HostStoreProviders, { value: store }, e(CommandPaletteModal, { onClose: () => { closed = true } })))
        await flushMacrotask(0)
      })
      const row = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-idx].nav-item')).find((el) =>
        el.textContent?.includes(item.title),
      )
      assert.ok(row, `命令面板应包含 ${item.title}`)
      await act(async () => {
        row.click()
      })
      assert.equal(closed, true, `点击 ${item.title} 应关闭命令面板`)
      assert.deepEqual(opened, [{ kind: item.kind }], `点击 ${item.title} 应导航到 ${item.kind}`)
    } finally {
      act(() => root.unmount())
      host.remove()
    }
  }
})

// ---------------------------------------------------------------------------
// 4. URL Hash 编解码与旧 URL 平滑升级
// ---------------------------------------------------------------------------

test('URL Hash 契约：四大中心往返编解码与子项深链', { timeout: 60_000 }, () => {
  const cases = [
    { hash: '#/settings/profiles', state: { primaryTarget: { kind: 'profiles' as const } } },
    { hash: '#/settings/profiles/watchdog', state: { primaryTarget: { kind: 'profiles' as const, profileId: 'watchdog' } } },
    { hash: '#/settings/skills', state: { primaryTarget: { kind: 'skills' as const } } },
    { hash: '#/settings/skills/helm-cli', state: { primaryTarget: { kind: 'skills' as const, skillId: 'helm-cli' } } },
    { hash: '#/settings/nodes', state: { primaryTarget: { kind: 'nodes' as const } } },
    { hash: '#/settings/nodes/local', state: { primaryTarget: { kind: 'nodes' as const, nodeId: 'local' } } },
    { hash: '#/settings/models', state: { primaryTarget: { kind: 'models' as const } } },
    { hash: '#/settings/models/anthropic', state: { primaryTarget: { kind: 'models' as const, providerId: 'anthropic' } } },
    { hash: '#/settings/models/defaults', state: { primaryTarget: { kind: 'models' as const, tab: 'defaults' as const } } },
    { hash: '#/settings/models/anthropic/defaults', state: { primaryTarget: { kind: 'models' as const, providerId: 'anthropic', tab: 'defaults' as const } } },
  ]

  for (const { hash, state } of cases) {
    const parsed = parseLocationHash(hash)
    assert.deepEqual(parsed.primaryTarget, state.primaryTarget, `parseLocationHash(${hash}) 解析不匹配`)

    const formatted = formatLocationHash(parsed)
    assert.equal(formatted, hash, `formatLocationHash 编解码不一致`)
  }
})

test('URL Hash 契约：upgradeLegacyLocationState 将旧 modal 参数平滑升级为一级中心', { timeout: 60_000 }, () => {
  // 1. 旧 profiles 模态升级
  const legacyProfiles = upgradeLegacyLocationState(parseLocationHash('#/c/1?modal=profiles&id=superagent'))
  assert.deepEqual(legacyProfiles.primaryTarget, { kind: 'profiles', profileId: 'superagent' })
  assert.equal(legacyProfiles.activeModal, null)

  // 2. 旧 providers 模态升级
  const legacyProviders = upgradeLegacyLocationState(parseLocationHash('#/c/1?modal=providers'))
  assert.deepEqual(legacyProviders.primaryTarget, { kind: 'models' })
  assert.equal(legacyProviders.activeModal, null)

  // 3. 旧 skills 模态升级
  const legacySkills = upgradeLegacyLocationState(parseLocationHash('#/c/1?modal=skills&id=helm-cli'))
  assert.deepEqual(legacySkills.primaryTarget, { kind: 'skills', skillId: 'helm-cli' })
  assert.equal(legacySkills.activeModal, null)

  // 4. 旧 nodes 模态升级
  const legacyNodes = upgradeLegacyLocationState(parseLocationHash('#/c/1?modal=nodes&id=gpu-server'))
  assert.deepEqual(legacyNodes.primaryTarget, { kind: 'nodes', nodeId: 'gpu-server' })
  assert.equal(legacyNodes.activeModal, null)
})

// ---------------------------------------------------------------------------
// 5. 四大中心组件群主舞台渲染与抽屉交互
// ---------------------------------------------------------------------------

test('四大中心主舞台组件：SSR 渲染结构与基础容器契约', { timeout: 60_000 }, () => {
  const store = makeTestStore()

  // 1. ProfileCenter
  const profileHtml = renderToString(
    e(HostStoreProviders, { value: store }, e(ProfileCenter)),
  )
  assert.ok(profileHtml.includes('primary-center-topbar'))
  assert.ok(profileHtml.includes('Agent Profile Center'))
  assert.ok(profileHtml.includes('New profile'))

  // 2. SkillCenter
  const skillHtml = renderToString(
    e(HostStoreProviders, { value: store }, e(SkillCenter)),
  )
  assert.ok(skillHtml.includes('primary-center-topbar'))
  assert.ok(skillHtml.includes('Skills Center'))
  assert.ok(skillHtml.includes('primary-center-toolbar'))

  // 3. NodeCenter
  const nodeHtml = renderToString(
    e(HostStoreProviders, { value: store }, e(NodeCenter)),
  )
  assert.ok(nodeHtml.includes('primary-center-topbar'))
  assert.ok(nodeHtml.includes('Compute Nodes Center'))
  assert.ok(nodeHtml.includes('Connect node'))

  // 4. ModelCenter
  const modelHtml = renderToString(
    e(HostStoreProviders, { value: store }, e(ModelCenter)),
  )
  assert.ok(modelHtml.includes('primary-center-topbar'))
  assert.ok(modelHtml.includes('Models &amp; Credentials Center'))
})

test('四大中心抽屉联动：携带子项 ID 时自动呼出对应 540px 右侧滑出抽屉', { timeout: 60_000 }, () => {
  // 1. Profiles 携带 profileId 呼出抽屉
  const profileStore = makeTestStore({
    profiles: [
      { id: 'superagent', name: 'SuperAgent 中枢', description: '总控', tags: [] },
    ],
    primaryTarget: { kind: 'profiles', profileId: 'superagent' },
  })
  const profileHtml = renderToString(
    e(HostStoreProviders, { value: profileStore }, e(ProfileCenter, { inlineDrawer: true })),
  )
  assert.ok(profileHtml.includes('primary-drawer-content'), 'Profiles 应呼出抽屉')
  assert.ok(profileHtml.includes('SuperAgent 中枢'))

  // 2. Skills 携带 skillId 呼出抽屉
  const skillStore = makeTestStore({
    skills: [
      { id: 'helm-cli', name: 'Helm CLI', description: '命令行', references: [] },
    ],
    primaryTarget: { kind: 'skills', skillId: 'helm-cli' },
  })
  const skillHtml = renderToString(
    e(HostStoreProviders, { value: skillStore }, e(SkillCenter, { inlineDrawer: true })),
  )
  assert.ok(skillHtml.includes('primary-drawer-content'), 'Skills 应呼出抽屉')

  // 3. Nodes 携带 nodeId 呼出抽屉
  const nodeStore = makeTestStore({
    nodes: [
      { id: 'local', kind: 'local', online: true, platform: 'linux', version: '0.1.0' },
    ],
    primaryTarget: { kind: 'nodes', nodeId: 'local' },
  })
  const nodeHtml = renderToString(
    e(HostStoreProviders, { value: nodeStore }, e(NodeCenter, { inlineDrawer: true })),
  )
  assert.ok(nodeHtml.includes('primary-drawer-content'), 'Nodes 应呼出抽屉')
  assert.ok(nodeHtml.includes('System overview'))

  // 4. Models 携带 providerId 呼出抽屉
  const modelStore = makeTestStore({
    primaryTarget: { kind: 'models', providerId: 'anthropic' },
  })
  const modelHtml = renderToString(
    e(HostStoreProviders, { value: modelStore }, e(ModelCenter, { inlineDrawer: true })),
  )
  assert.ok(modelHtml.includes('primary-drawer-content'), 'Models 应呼出抽屉')
  assert.ok(modelHtml.includes('Credentials and connection settings'))
})

// ---------------------------------------------------------------------------
// 6. 全仓严格零 Emoji 铁律静态扫描
// ---------------------------------------------------------------------------

test('零 Emoji 铁律：四大中心全部组件、样式与核心入口绝对 0 Emoji', { timeout: 60_000 }, () => {
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u

  const dirsToScan = [
    join(PKG_ROOT, 'src/profiles'),
    join(PKG_ROOT, 'src/skills'),
    join(PKG_ROOT, 'src/nodes'),
    join(PKG_ROOT, 'src/models'),
  ]

  for (const dir of dirsToScan) {
    const files = readdirSync(dir)
    for (const file of files) {
      if (file.endsWith('.ts') || file.endsWith('.tsx')) {
        const full = join(dir, file)
        const content = readFileSync(full, 'utf-8')
        assert.doesNotMatch(content, emojiRegex, `${file} 中不得包含任何 Emoji 表情字符`)
      }
    }
  }

  // 检查 App.tsx、Sidebar.tsx、CommandPaletteModal.tsx
  const appSrc = readFileSync(join(PKG_ROOT, 'src/App.tsx'), 'utf-8')
  assert.doesNotMatch(appSrc, emojiRegex, 'App.tsx 不得含有任何 Emoji 表情')

  const sidebarSrc = readFileSync(join(PKG_ROOT, 'src/shell/Sidebar.tsx'), 'utf-8')
  assert.doesNotMatch(sidebarSrc, emojiRegex, 'Sidebar.tsx 不得含有任何 Emoji 表情')

  // Sidebar 拆分出的子模块同步纳入零 Emoji 静态检查。
  const sidebarStandingsSrc = readFileSync(join(PKG_ROOT, 'src/shell/SidebarAgentStandings.tsx'), 'utf-8')
  assert.doesNotMatch(sidebarStandingsSrc, emojiRegex, 'SidebarAgentStandings.tsx 不得含有任何 Emoji 表情')
  const sidebarPrimitivesSrc = readFileSync(join(PKG_ROOT, 'src/shell/SidebarPrimitives.tsx'), 'utf-8')
  assert.doesNotMatch(sidebarPrimitivesSrc, emojiRegex, 'SidebarPrimitives.tsx 不得含有任何 Emoji 表情')

  const cmdSrc = readFileSync(join(PKG_ROOT, 'src/modals/CommandPaletteModal.tsx'), 'utf-8')
  assert.doesNotMatch(cmdSrc, emojiRegex, 'CommandPaletteModal.tsx 不得含有任何 Emoji 表情')
})
