/**
 * End-to-end integration tests for the four primary centers (Profiles, Skills,
 * Nodes, Models).
 *
 * Coverage:
 * 1. Sidebar/footer five primary entries and route activation contract:
 *    - profiles, models & credentials, skills, compute nodes and the plugin
 *      center all call store.openTarget;
 *    - when their primaryTarget is active the rows show .is-active and
 *      aria-current="page";
 * 2. Command palette (CommandPaletteModal) direct navigation to primary centers:
 *    - clicking the four quick items runs openTarget and closes the palette;
 * 3. Routing contract and legacy URL smooth upgrades:
 *    - round-trip encoding supports settings/<center>/<id> path-segment deep
 *      links and split combinations;
 *    - legacy modal=profiles|providers|skills|nodes auto-upgrades to the
 *      matching full-screen primary view;
 * 4. The four center component groups mounting and drawer wiring:
 *    - ProfileCenter, SkillCenter, NodeCenter, ModelCenter rendering, card
 *      grids and drawer interactions;
 * 5. Hard-rule static scans:
 *    - every center component source plus App/Sidebar/CommandPalette stays
 *      absolutely emoji-free.
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
// 1. Sidebar/footer five primary entries and highlight-state contract
// ---------------------------------------------------------------------------

test('Sidebar: the five settings-space entries navigate to primary targets uniformly, active state aligned with routing', { timeout: 60_000 }, async () => {
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
    assert.ok(html.includes('nav-item-active'), `the ${label} row must highlight when primaryTarget=${kind}`)
    assert.ok(html.includes('aria-current="page"'), `the ${label} row must set aria-current="page" when primaryTarget=${kind}`)
  }

  // Clicking the five sidebar settings-space entries must call the matching openTarget
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
      assert.ok(btn, `the sidebar settings space must render the ${label} entry`)
      await act(async () => {
        btn.click()
      })
    }
    assert.deepEqual(
      opened,
      targets.map((t) => ({ kind: t.kind })),
      'all five sidebar settings-space entries must call store.openTarget',
    )
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

// ---------------------------------------------------------------------------
// 2. Command palette (CommandPaletteModal) primary-target dispatch
// ---------------------------------------------------------------------------

test('CommandPaletteModal: the four quick items dispatch primary routes uniformly and close the palette', { timeout: 60_000 }, async () => {
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
      assert.ok(row, `the command palette must include ${item.title}`)
      await act(async () => {
        row.click()
      })
      assert.equal(closed, true, `clicking ${item.title} must close the command palette`)
      assert.deepEqual(opened, [{ kind: item.kind }], `clicking ${item.title} must navigate to ${item.kind}`)
    } finally {
      act(() => root.unmount())
      host.remove()
    }
  }
})

// ---------------------------------------------------------------------------
// 4. URL hash encoding/decoding and legacy URL smooth upgrades
// ---------------------------------------------------------------------------

test('URL hash contract: four-center round-trip encoding and sub-item deep links', { timeout: 60_000 }, () => {
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
    assert.deepEqual(parsed.primaryTarget, state.primaryTarget, `parseLocationHash(${hash}) mismatch`)

    const formatted = formatLocationHash(parsed)
    assert.equal(formatted, hash, `formatLocationHash round-trip mismatch`)
  }
})

test('URL hash contract: upgradeLegacyLocationState smoothly upgrades legacy modal params to primary centers', { timeout: 60_000 }, () => {
  // 1. Legacy profiles modal upgrade
  const legacyProfiles = upgradeLegacyLocationState(parseLocationHash('#/c/1?modal=profiles&id=superagent'))
  assert.deepEqual(legacyProfiles.primaryTarget, { kind: 'profiles', profileId: 'superagent' })
  assert.equal(legacyProfiles.activeModal, null)

  // 2. Legacy providers modal upgrade
  const legacyProviders = upgradeLegacyLocationState(parseLocationHash('#/c/1?modal=providers'))
  assert.deepEqual(legacyProviders.primaryTarget, { kind: 'models' })
  assert.equal(legacyProviders.activeModal, null)

  // 3. Legacy skills modal upgrade
  const legacySkills = upgradeLegacyLocationState(parseLocationHash('#/c/1?modal=skills&id=helm-cli'))
  assert.deepEqual(legacySkills.primaryTarget, { kind: 'skills', skillId: 'helm-cli' })
  assert.equal(legacySkills.activeModal, null)

  // 4. Legacy nodes modal upgrade
  const legacyNodes = upgradeLegacyLocationState(parseLocationHash('#/c/1?modal=nodes&id=gpu-server'))
  assert.deepEqual(legacyNodes.primaryTarget, { kind: 'nodes', nodeId: 'gpu-server' })
  assert.equal(legacyNodes.activeModal, null)
})

// ---------------------------------------------------------------------------
// 5. The four center component groups: main-stage rendering and drawer interactions
// ---------------------------------------------------------------------------

test('four-center main-stage components: SSR structure and base container contract', { timeout: 60_000 }, () => {
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

test('four-center drawer wiring: carrying a sub-item ID auto-opens the matching 540px right slide-over drawer', { timeout: 60_000 }, () => {
  // 1. Profiles opens the drawer when carrying a profileId
  const profileStore = makeTestStore({
    profiles: [
      { id: 'superagent', name: 'SuperAgent 中枢', description: '总控', tags: [] }, // zh fixtures
    ],
    primaryTarget: { kind: 'profiles', profileId: 'superagent' },
  })
  const profileHtml = renderToString(
    e(HostStoreProviders, { value: profileStore }, e(ProfileCenter, { inlineDrawer: true })),
  )
  assert.ok(profileHtml.includes('primary-drawer-content'), 'Profiles must open the drawer')
  assert.ok(profileHtml.includes('SuperAgent 中枢'))

  // 2. Skills opens the drawer when carrying a skillId
  const skillStore = makeTestStore({
    skills: [
      { id: 'helm-cli', name: 'Helm CLI', description: '命令行', references: [] }, // zh fixtures
    ],
    primaryTarget: { kind: 'skills', skillId: 'helm-cli' },
  })
  const skillHtml = renderToString(
    e(HostStoreProviders, { value: skillStore }, e(SkillCenter, { inlineDrawer: true })),
  )
  assert.ok(skillHtml.includes('primary-drawer-content'), 'Skills must open the drawer')

  // 3. Nodes opens the drawer when carrying a nodeId
  const nodeStore = makeTestStore({
    nodes: [
      { id: 'local', kind: 'local', online: true, platform: 'linux', version: '0.1.0' },
    ],
    primaryTarget: { kind: 'nodes', nodeId: 'local' },
  })
  const nodeHtml = renderToString(
    e(HostStoreProviders, { value: nodeStore }, e(NodeCenter, { inlineDrawer: true })),
  )
  assert.ok(nodeHtml.includes('primary-drawer-content'), 'Nodes must open the drawer')
  assert.ok(nodeHtml.includes('System overview'))

  // 4. Models opens the drawer when carrying a providerId
  const modelStore = makeTestStore({
    primaryTarget: { kind: 'models', providerId: 'anthropic' },
  })
  const modelHtml = renderToString(
    e(HostStoreProviders, { value: modelStore }, e(ModelCenter, { inlineDrawer: true })),
  )
  assert.ok(modelHtml.includes('primary-drawer-content'), 'Models must open the drawer')
  assert.ok(modelHtml.includes('Credentials and connection settings'))
})

// ---------------------------------------------------------------------------
// 6. Repo-wide strict zero-emoji static scan
// ---------------------------------------------------------------------------

test('zero-emoji rule: all four-center components, styles and core entrances stay absolutely emoji-free', { timeout: 60_000 }, () => {
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
        assert.doesNotMatch(content, emojiRegex, `${file} must contain no emoji characters`)
      }
    }
  }

  // Check App.tsx, Sidebar.tsx, CommandPaletteModal.tsx
  const appSrc = readFileSync(join(PKG_ROOT, 'src/App.tsx'), 'utf-8')
  assert.doesNotMatch(appSrc, emojiRegex, 'App.tsx must contain no emoji')

  const sidebarSrc = readFileSync(join(PKG_ROOT, 'src/shell/Sidebar.tsx'), 'utf-8')
  assert.doesNotMatch(sidebarSrc, emojiRegex, 'Sidebar.tsx must contain no emoji')

  // Sidebar's split-out submodules join the zero-emoji static scan.
  const sidebarStandingsSrc = readFileSync(join(PKG_ROOT, 'src/shell/SidebarAgentStandings.tsx'), 'utf-8')
  assert.doesNotMatch(sidebarStandingsSrc, emojiRegex, 'SidebarAgentStandings.tsx must contain no emoji')
  const sidebarPrimitivesSrc = readFileSync(join(PKG_ROOT, 'src/shell/SidebarPrimitives.tsx'), 'utf-8')
  assert.doesNotMatch(sidebarPrimitivesSrc, emojiRegex, 'SidebarPrimitives.tsx must contain no emoji')

  const cmdSrc = readFileSync(join(PKG_ROOT, 'src/modals/CommandPaletteModal.tsx'), 'utf-8')
  assert.doesNotMatch(cmdSrc, emojiRegex, 'CommandPaletteModal.tsx must contain no emoji')
})
