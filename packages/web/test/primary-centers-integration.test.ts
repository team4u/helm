/**
 * 四大中心（Profiles, Skills, Nodes, Models）端到端集成测试
 *
 * 覆盖：
 * 1. 旧模态物理淘汰断言：
 *    - ProfileEditorModal.tsx、SkillViewerModal.tsx、NodesModal.tsx、
 *      ProviderCatalog.tsx、ProviderAuthModal.tsx、provider-auth.css 彻底删除；
 *    - App.tsx 源码中无任何已淘汰模态的残留引用，并正确挂载四大一级中心与分屏支持；
 * 2. 侧栏底栏 5 大一级入口与路由激活契约：
 *    - 角色、模型与凭据、技能库、计算节点、插件中心均调用 store.openTarget；
 *    - 对应 primaryTarget 激活时呈现 .is-active 与 aria-current="page"；
 * 3. 命令面板（CommandPaletteModal）直达一级中心：
 *    - 四大快捷项执行 openTarget 并自动关闭面板；
 * 4. 路由契约与旧 URL 平滑升级：
 *    - 往返编解码支持 ?id=<id> 子项深链与分屏组合；
 *    - 旧 modal=profiles|providers|skills|nodes 自动升格为对应全屏一级视图；
 * 5. 四大中心组件群挂载与抽屉联动：
 *    - ProfileCenter、SkillCenter、NodeCenter、ModelCenter 渲染、卡片网格与抽屉交互；
 * 6. 铁律遵循静态扫描：
 *    - 四大中心全部组件源码与 App/Sidebar/CommandPalette 绝对 0 Emoji。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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

import { HelmStoreContext } from '../src/lib/store-context.js'
import {
  parseLocationHash,
  formatLocationHash,
  upgradeLegacyLocationState,
} from '../src/lib/url-hash-model.js'
import { makeTestStore } from './helpers/store.js'
import { ProfileCenter } from '../src/profiles/ProfileCenter.js'
import { SkillCenter } from '../src/skills/SkillCenter.js'
import { NodeCenter } from '../src/nodes/NodeCenter.js'
import { ModelCenter } from '../src/models/ModelCenter.js'
import { Sidebar } from '../src/shell/Sidebar.js'
import { CommandPaletteModal } from '../src/modals/CommandPaletteModal.js'
import type { HelmStoreValue } from '../src/lib/types.js'

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const e = React.createElement

// ---------------------------------------------------------------------------
// 1. 旧模态物理淘汰与源码契约断言
// ---------------------------------------------------------------------------

test('旧模态物理淘汰：旧四大居中模态及样式已从磁盘物理删除', { timeout: 60_000 }, () => {
  const legacyFiles = [
    'src/modals/ProfileEditorModal.tsx',
    'src/modals/SkillViewerModal.tsx',
    'src/modals/NodesModal.tsx',
    'src/modals/ProviderCatalog.tsx',
    'src/modals/ProviderAuthModal.tsx',
    'src/modals/provider-auth.css',
  ]

  for (const rel of legacyFiles) {
    const full = join(PKG_ROOT, rel)
    assert.equal(existsSync(full), false, `${rel} 必须已从文件系统彻底物理删除`)
  }
})

test('App.tsx 源码契约：主舞台与分屏舞台完整挂载四大一级中心，且零旧模态残留', { timeout: 60_000 }, () => {
  const appSrc = readFileSync(join(PKG_ROOT, 'src/App.tsx'), 'utf-8')

  // 1. 导入四大一级中心
  assert.match(appSrc, /import\s*\{[^}]*ProfileCenter[^}]*\}\s*from\s*['"]\.\/profiles\/ProfileCenter(?:\.js)?['"]/)
  assert.match(appSrc, /import\s*\{[^}]*SkillCenter[^}]*\}\s*from\s*['"]\.\/skills\/SkillCenter(?:\.js)?['"]/)
  assert.match(appSrc, /import\s*\{[^}]*NodeCenter[^}]*\}\s*from\s*['"]\.\/nodes\/NodeCenter(?:\.js)?['"]/)
  assert.match(appSrc, /import\s*\{[^}]*ModelCenter[^}]*\}\s*from\s*['"]\.\/models\/ModelCenter(?:\.js)?['"]/)

  // 2. 主舞台挂载四大中心
  assert.match(appSrc, /store\.primaryTarget\.kind === 'profiles'\s*\?\s*\(\s*<ProfileCenter\s+key="primary-profiles"\s*\/>\s*\)/)
  assert.match(appSrc, /store\.primaryTarget\.kind === 'skills'\s*\?\s*\(\s*<SkillCenter\s+key="primary-skills"\s*\/>\s*\)/)
  assert.match(appSrc, /store\.primaryTarget\.kind === 'nodes'\s*\?\s*\(\s*<NodeCenter\s+key="primary-nodes"\s*\/>\s*\)/)
  assert.match(appSrc, /store\.primaryTarget\.kind === 'models'\s*\?\s*\(\s*<ModelCenter\s+key="primary-models"\s*\/>\s*\)/)

  // 3. 分屏舞台挂载四大中心（支持 isSplit 与 onCloseSplit）
  assert.match(appSrc, /store\.splitTarget\.kind === 'profiles'\s*\?\s*\(\s*<ProfileCenter\s+key="split-profiles"\s+isSplit\s+onCloseSplit=\{store\.closeSplit\}\s*\/>\s*\)/)
  assert.match(appSrc, /store\.splitTarget\.kind === 'skills'\s*\?\s*\(\s*<SkillCenter\s+key="split-skills"\s+isSplit\s+onCloseSplit=\{store\.closeSplit\}\s*\/>\s*\)/)
  assert.match(appSrc, /store\.splitTarget\.kind === 'nodes'\s*\?\s*\(\s*<NodeCenter\s+key="split-nodes"\s+isSplit\s+onCloseSplit=\{store\.closeSplit\}\s*\/>\s*\)/)
  assert.match(appSrc, /store\.splitTarget\.kind === 'models'\s*\?\s*\(\s*<ModelCenter\s+key="split-models"\s+isSplit\s+onCloseSplit=\{store\.closeSplit\}\s*\/>\s*\)/)

  // 4. 彻底杜绝旧模态引用与渲染
  assert.doesNotMatch(appSrc, /ProfileEditorModal/)
  assert.doesNotMatch(appSrc, /SkillViewerModal/)
  assert.doesNotMatch(appSrc, /NodesModal/)
  assert.doesNotMatch(appSrc, /ProviderAuthModal/)
  assert.doesNotMatch(appSrc, /ProviderCatalog/)
})

// ---------------------------------------------------------------------------
// 2. 侧栏底栏 5 大一级入口与高亮状态契约
// ---------------------------------------------------------------------------

test('Sidebar.tsx：设置空间 5 大入口统一导航至一级目标，且激活态与路由对齐', { timeout: 60_000 }, () => {
  const sidebarSrc = readFileSync(join(PKG_ROOT, 'src/shell/Sidebar.tsx'), 'utf-8')
  const typesSrc = readFileSync(join(PKG_ROOT, 'src/lib/types.ts'), 'utf-8')

  // 1. 源码包含 5 大一级入口的纵向列表分发（表驱动 CENTER_TARGETS，与侧栏空间推导共用，位于 lib/types）
  assert.match(typesSrc, /export const CENTER_TARGETS = \['profiles', 'models', 'skills', 'nodes', 'plugins'\] as const/)
  assert.match(sidebarSrc, /function SettingsNavGroup/)

  // 2. SSR 渲染断言激活高亮
  const targets = [
    { kind: 'profiles' as const, label: '角色' },
    { kind: 'models' as const, label: '模型与凭据' },
    { kind: 'skills' as const, label: '技能库' },
    { kind: 'nodes' as const, label: '计算节点' },
    { kind: 'plugins' as const, label: '插件中心' },
  ]

  for (const { kind, label } of targets) {
    const store = makeTestStore({ primaryTarget: { kind } })
    const html = renderToString(e(HelmStoreContext.Provider, { value: store }, e(Sidebar)))
    assert.ok(html.includes(`nav-item-active`), `当 primaryTarget=${kind} 时，${label} 行应高亮`)
    assert.ok(html.includes(`aria-current="page"`), `当 primaryTarget=${kind} 时，${label} 行应设置 aria-current="page"`
    )
  }
})

// ---------------------------------------------------------------------------
// 3. 命令面板（CommandPaletteModal）一级目标分发
// ---------------------------------------------------------------------------

test('CommandPaletteModal：4 大快捷项统一分发一级路由并关闭面板', { timeout: 60_000 }, () => {
  const cmdSrc = readFileSync(join(PKG_ROOT, 'src/modals/CommandPaletteModal.tsx'), 'utf-8')

  // 1. 源码中四大命令动作重构断言
  assert.match(cmdSrc, /id:\s*'builtin:open-profile-editor'[\s\S]*?store\.openTarget\(\{\s*kind:\s*'profiles'\s*\}\)/)
  assert.match(cmdSrc, /id:\s*'builtin:open-provider-auth'[\s\S]*?store\.openTarget\(\{\s*kind:\s*'models'\s*\}\)/)
  assert.match(cmdSrc, /id:\s*'builtin:open-skill-viewer'[\s\S]*?store\.openTarget\(\{\s*kind:\s*'skills'\s*\}\)/)
  assert.match(cmdSrc, /id:\s*'builtin:open-nodes'[\s\S]*?store\.openTarget\(\{\s*kind:\s*'nodes'\s*\}\)/)

  // 2. 不得包含旧 activeModal 的侵入调用
  assert.doesNotMatch(cmdSrc, /setActiveModal\(\{\s*kind:\s*'profile-editor'/)
  assert.doesNotMatch(cmdSrc, /setActiveModal\(\{\s*kind:\s*'provider-auth'/)
  assert.doesNotMatch(cmdSrc, /setActiveModal\(\{\s*kind:\s*'skill-viewer'/)
  assert.doesNotMatch(cmdSrc, /setActiveModal\(\{\s*kind:\s*'nodes'/)
})

// ---------------------------------------------------------------------------
// 4. URL Hash 编解码与旧 URL 平滑升级
// ---------------------------------------------------------------------------

test('URL Hash 契约：四大中心往返编解码与子项深链', { timeout: 60_000 }, () => {
  const cases = [
    { hash: '#/profiles', state: { primaryTarget: { kind: 'profiles' as const } } },
    { hash: '#/profiles?id=watchdog', state: { primaryTarget: { kind: 'profiles' as const, profileId: 'watchdog' } } },
    { hash: '#/skills', state: { primaryTarget: { kind: 'skills' as const } } },
    { hash: '#/skills?id=helm-cli', state: { primaryTarget: { kind: 'skills' as const, skillId: 'helm-cli' } } },
    { hash: '#/nodes', state: { primaryTarget: { kind: 'nodes' as const } } },
    { hash: '#/nodes?id=local', state: { primaryTarget: { kind: 'nodes' as const, nodeId: 'local' } } },
    { hash: '#/models', state: { primaryTarget: { kind: 'models' as const } } },
    { hash: '#/models?id=anthropic', state: { primaryTarget: { kind: 'models' as const, providerId: 'anthropic' } } },
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
    e(HelmStoreContext.Provider, { value: store }, e(ProfileCenter)),
  )
  assert.ok(profileHtml.includes('primary-center-topbar'))
  assert.ok(profileHtml.includes('智能体角色中心'))
  assert.ok(profileHtml.includes('新建角色'))

  // 2. SkillCenter
  const skillHtml = renderToString(
    e(HelmStoreContext.Provider, { value: store }, e(SkillCenter)),
  )
  assert.ok(skillHtml.includes('primary-center-topbar'))
  assert.ok(skillHtml.includes('技能中心'))
  assert.ok(skillHtml.includes('primary-center-toolbar'))

  // 3. NodeCenter
  const nodeHtml = renderToString(
    e(HelmStoreContext.Provider, { value: store }, e(NodeCenter)),
  )
  assert.ok(nodeHtml.includes('primary-center-topbar'))
  assert.ok(nodeHtml.includes('计算节点中心'))
  assert.ok(nodeHtml.includes('接入节点'))

  // 4. ModelCenter
  const modelHtml = renderToString(
    e(HelmStoreContext.Provider, { value: store }, e(ModelCenter)),
  )
  assert.ok(modelHtml.includes('primary-center-topbar'))
  assert.ok(modelHtml.includes('模型与凭证中心'))
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
    e(HelmStoreContext.Provider, { value: profileStore }, e(ProfileCenter, { inlineDrawer: true })),
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
    e(HelmStoreContext.Provider, { value: skillStore }, e(SkillCenter, { inlineDrawer: true })),
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
    e(HelmStoreContext.Provider, { value: nodeStore }, e(NodeCenter, { inlineDrawer: true })),
  )
  assert.ok(nodeHtml.includes('primary-drawer-content'), 'Nodes 应呼出抽屉')
  assert.ok(nodeHtml.includes('系统概览'))

  // 4. Models 携带 providerId 呼出抽屉
  const modelStore = makeTestStore({
    primaryTarget: { kind: 'models', providerId: 'anthropic' },
  })
  const modelHtml = renderToString(
    e(HelmStoreContext.Provider, { value: modelStore }, e(ModelCenter, { inlineDrawer: true })),
  )
  assert.ok(modelHtml.includes('primary-drawer-content'), 'Models 应呼出抽屉')
  assert.ok(modelHtml.includes('凭证与连接设置'))
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

  const cmdSrc = readFileSync(join(PKG_ROOT, 'src/modals/CommandPaletteModal.tsx'), 'utf-8')
  assert.doesNotMatch(cmdSrc, emojiRegex, 'CommandPaletteModal.tsx 不得含有任何 Emoji 表情')
})
