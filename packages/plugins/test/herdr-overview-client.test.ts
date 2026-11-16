/**
 * builtin:herdr HerdrOverviewScreen 双端响应式排版与人类归属权红线 DOM 测试：
 * 1. 工具栏与筛选栏脱离 .pane-actions 不可折行容器，采用可换行布局；
 * 2. 同时提供桌面表格（.herdr-desktop-table）与 <=680px 移动端双行卡片（.herdr-mobile-cards）；
 *    CSS 含 @media (max-width: 680px) 与 @container herdr-overview (max-width: 680px) 切换规则；
 * 3. 严守 AGENTS.md §3 看门狗归属权红线：ownedBy === 'human' 窗格无论 pendingAsk / focused /
 *    blocked 状态如何，在桌面表格操作列与移动端卡片上均绝不渲染任何交互控件（只读诊断徽章）。
 * 4. 仅 ownedBy === 'helm' 受管窗格开放聚焦 / 快照 / 关联会话动作，零原生 <select>，零 Emoji。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { CLIENT_SHARED_GLOBALS, compilePluginClientModule } from '@helm/plugin-build'
import { PLUGIN_CLIENT_CSS_EXPORT } from '@helm/protocol'
import type { OverviewDoc } from '../src/herdr/client/models.js'

GlobalRegistrator.register()

const req = createRequire(new URL('../../plugin-client/package.json', import.meta.url))
const React = req('react') as typeof import('react')
const ReactDOM = req('react-dom') as typeof import('react-dom')
const ReactDOMClient = req('react-dom/client') as typeof import('react-dom/client')
const ReactJsxRuntime = req('react/jsx-runtime') as Record<string, unknown>
const LucideReact = req('lucide-react') as Record<string, unknown>
const SDK = await import('../../plugin-client/src/index.js')

const g = globalThis as Record<string, unknown>
g.React = React
g.IS_REACT_ACT_ENVIRONMENT = true
g[CLIENT_SHARED_GLOBALS['react']] = React
g[CLIENT_SHARED_GLOBALS['react-dom']] = ReactDOM
g[CLIENT_SHARED_GLOBALS['react-dom/client']] = ReactDOMClient
g[CLIENT_SHARED_GLOBALS['react/jsx-runtime']] = ReactJsxRuntime
g[CLIENT_SHARED_GLOBALS['lucide-react']] = LucideReact
g[CLIENT_SHARED_GLOBALS['@helm/plugin-client']] = SDK

const e = React.createElement
const { act } = React
const { createRoot } = ReactDOMClient

const __dirname = dirname(fileURLToPath(import.meta.url))
const HERDR_CLIENT_DIR = resolve(__dirname, '../src/herdr/client')

interface HerdrClientModule {
  HerdrOverviewScreen: React.ComponentType<Record<string, unknown>>
  [PLUGIN_CLIENT_CSS_EXPORT]?: string
}

let tempDir: string
let mod: HerdrClientModule

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'helm-herdr-client-'))
  const bundle = await compilePluginClientModule('builtin:herdr', HERDR_CLIENT_DIR, 'index.tsx', tempDir)
  const url = `data:text/javascript;base64,${Buffer.from(bundle.code, 'utf8').toString('base64')}`
  mod = (await import(url)) as HerdrClientModule
})

after(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function mountHerdrOverview(doc: OverviewDoc) {
  const actionCalls: Array<{ actionId: string; input: unknown }> = []
  const openedScreens: string[] = []
  const openedDrawers: number[] = []
  const paramsWrites: Array<Record<string, string | undefined>> = []

  const port: import('../../plugin-client/src/index.js').PluginClientHostPort = {
    authenticated: true,
    theme: 'dark',
    conversations: [],
    conversationDetails: {},
    conversationLives: {},
    pendingAsks: [],
    loadErrors: {},
    plugins: [],
    screens: [],
    pluginDocs: { 'builtin:herdr/overview': doc },
    ensurePluginDoc: async () => doc,
    getPluginSessionDoc: async () => undefined,
    subscribeSessionDoc: () => () => {},
    getSessionDocState: () => ({ hasValue: false, deleted: false, connected: false, value: undefined }),
    invokePluginAction: async (_pluginId, actionId, input) => {
      actionCalls.push({ actionId, input })
      if (actionId === 'read') return { text: 'terminal snapshot ok' }
      if (actionId === 'list') return { panes: [{ paneId: '%10', nodeId: 'local', parentConversationId: 88 }] }
      return { ok: true }
    },
    submitConversationInput: async () => undefined,
    openTarget: (target) => {
      openedScreens.push(target)
    },
    openConversationDrawer: (id) => {
      openedDrawers.push(id)
    },
    openArtifactPreview: () => undefined,
    setWorkbenchOpen: () => undefined,
    setWorkbenchTab: () => undefined,
    notify: () => undefined,
    loadConversationDetail: () => undefined,
    slots: { collectItems: () => [], renderItem: () => null },
    markdown: { view: ({ text }) => e('div', null, text), codeBlock: ({ code }) => e('pre', null, code) },
  }

  const ctx = SDK.createPluginClientContext(port, 'builtin:herdr', undefined)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      e(
        SDK.PluginClientHostContext.Provider,
        { value: port },
        e(
          SDK.PluginClientContext.Provider,
          { value: ctx },
          e(mod.HerdrOverviewScreen, {
            pluginId: 'builtin:herdr',
            screenId: 'overview',
            isSplit: false,
            params: {},
            setParams: (patch: Record<string, string | undefined>) => paramsWrites.push(patch),
            close: () => undefined,
          }),
        ),
      ),
    )
  })

  return {
    container,
    actionCalls,
    openedScreens,
    openedDrawers,
    paramsWrites,
    unmount: () => {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

describe('HerdrOverviewScreen 双端适配与 human 只读红线', () => {
  test('human 直连窗格在桌面表格与移动卡片均严格只读，零控制按钮；helm 受管窗格开放合规动作', { timeout: 60_000 }, async () => {
    const doc: OverviewDoc = {
      updatedAt: 1_700_000_050_000,
      stale: false,
      asks: [{ paneId: '%10', nodeId: 'local', seq: 3, phase: 'waiting_approval' }],
      panes: [
        {
          nodeId: 'local',
          paneId: '%1',
          ownedBy: 'human',
          agentStatus: 'blocked',
          agentName: 'claude',
          title: '人类主会话窗格',
          cwd: '/root/code/helm',
          focused: false,
          pendingAsk: true,
        },
        {
          nodeId: 'local',
          paneId: '%10',
          ownedBy: 'helm',
          agentStatus: 'blocked',
          agentName: 'codex',
          title: '受管后台窗格',
          cwd: '/root/code/helm-worktrees/ux-wf',
          focused: false,
          pendingAsk: true,
        },
      ],
    }

    const mounted = mountHerdrOverview(doc)
    try {
      // 1. 禁止 .pane-actions 不可折行陷阱与原生 <select>
      assert.equal(mounted.container.querySelector('.pane-actions'), null, '工具栏与筛选栏不得复用不可折行的 .pane-actions')
      assert.equal(mounted.container.querySelector('select'), null, '严禁使用原生 <select>')
      assert.ok(mounted.container.querySelector('.herdr-toolbar-stats') !== null)
      assert.ok(mounted.container.querySelector('.herdr-toolbar-actions') !== null)

      // 2. 桌面表格：human 行操作列没有任何 <button>，仅含「只读」诊断徽章
      const desktopRows = [...mounted.container.querySelectorAll('.herdr-desktop-table tbody tr')]
      assert.equal(desktopRows.length, 2)
      const humanDesktopRow = desktopRows.find((tr) => tr.textContent?.includes('%1') && !tr.textContent?.includes('%10'))!
      assert.equal(humanDesktopRow.querySelectorAll('button').length, 0, 'human 桌面行严禁渲染任何操作按钮')
      assert.ok(humanDesktopRow.textContent?.includes('只读'))

      // 3. 移动端卡片：human 卡片没有任何 <button>，仅含「只读」诊断徽章
      const humanMobileCard = mounted.container.querySelector('.herdr-mobile-cards article[data-owned-by="human"]')
      assert.ok(humanMobileCard !== null, '应为 human 窗格渲染移动端只读卡片')
      assert.equal(humanMobileCard.querySelectorAll('button').length, 0, 'human 移动卡片严禁渲染发送/中止/聚焦/快照等交互控件')
      assert.ok(humanMobileCard.textContent?.includes('只读'))

      // 4. helm 受管窗格：开放聚焦与快照动作，点击快照弹出 Radix Dialog 展示文本
      const helmMobileCard = mounted.container.querySelector('.herdr-mobile-cards article[data-owned-by="helm"]')
      assert.ok(helmMobileCard !== null)
      const snapshotBtn = [...helmMobileCard.querySelectorAll('button')].find((b) => b.textContent?.includes('快照'))
      assert.ok(snapshotBtn !== undefined, 'helm 受管窗格应渲染快照按钮')
      await act(async () => {
        snapshotBtn.click()
      })
      assert.equal(mounted.actionCalls.at(-1)?.actionId, 'read')
      assert.ok(document.body.textContent?.includes('terminal snapshot ok'), '快照 Modal 应展示只读终端输出')
    } finally {
      mounted.unmount()
    }
  })

  test('Herdr CSS 具备 <=680px media + container 双断点卡片切换且全文件零 Emoji', { timeout: 60_000 }, async () => {
    const css = await readFile(join(HERDR_CLIENT_DIR, 'styles.css'), 'utf8')
    assert.ok(css.includes('@media (max-width: 680px)'), '应定义 680px 视口媒体断点')
    assert.ok(css.includes('@container herdr-overview (max-width: 680px)'), '分屏容器窄宽度也应自动切换卡片布局')
    assert.ok(css.includes('.herdr-desktop-table'), '应保留桌面表格容器类')
    assert.ok(css.includes('.herdr-mobile-cards'), '应提供移动端双行卡片容器类')
    const tsx = await readFile(join(HERDR_CLIENT_DIR, 'index.tsx'), 'utf8')
    assert.equal(/\p{Extended_Pictographic}/u.test(tsx), false, 'herdr/client/index.tsx 禁止包含 Emoji')
  })
})
