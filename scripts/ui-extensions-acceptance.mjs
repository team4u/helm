// Browser acceptance fixtures for UI extensions (P0–P4): real kernel/SQLite/PluginHost/HTTP/esbuild,
// zero model calls (no faux provider injected; the test plugins exercise only the UI/doc/action surface).
//
// Preconditions: pnpm build has run in this repo (packages/hub/dist, packages/kernel/dist and
// packages/web/dist exist).
// Note: the current worktree baseline does not yet contain the P0–P4 implementation
// (sessionDoc / micro-actions / PluginSlot / the composer control plane are being developed in
// parallel on the backend and frontend; the protocol contract lives in ce17ae67). This script
// is a fixture prepared for the real browser acceptance after the merge: running it now fails
// at the registration of the new extension points (ctx.sessionDoc /
// ctx.ui.conversationHeaderAction etc.) with a TypeError from the old PluginHost — an honest
// failure, not a script defect; do not comment out any registration to work around it (silent
// degradation is forbidden). After the main agent merges all implementations and runs pnpm build:
//   node scripts/ui-extensions-acceptance.mjs
// Output: /tmp/helm-ui-extensions-acceptance-info.json (mode 0600, containing url/token/conversation IDs).
//
// Differences from scripts/web-acceptance.mjs:
// - Covers only the UI extension surface (parameterized Screen / composer / micro-actions /
//   PluginSlot / sessionDoc) and performs no message-rendering pagination acceptance, so no
//   faux model output is needed;
// - startHub port:0 (random port; never occupies 3201/3202 or 3000/3001/3002/3101/3102),
//   webDistDir explicitly points at this worktree's built packages/web/dist (a missing dir is
//   an explicit error, never a silent fallback that disables static hosting);
// - The service keeps running until SIGTERM/SIGINT for real interaction by agent-browser.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const { createHelm } = await import('../packages/hub/dist/app.js')
const { startHub } = await import('../packages/kernel/dist/http/index.js')

// 1. Isolated data dir (mkdtemp under the system temp dir; never reads or writes ~/.helm or legacy system data)
const dataDir = await mkdtemp(join(tmpdir(), 'helm-ui-ext-acceptance-'))

// 2. Real kernel: SQLite + PluginHost + the built-in esbuild client compiler all ready.
//    No models injected: this fixture makes zero model calls (conversation creation and the
//    UI/action surface do not depend on models).
const app = await createHelm({ dataDir, cwd: projectRoot })

// 3. Random test password for auth.setup (a UUID satisfies >=8 chars; the info JSON is written with mode 0600)
const testPassword = crypto.randomUUID()
const issued = await app.kernel.auth.setup(testPassword)

// 4. Two non-root test conversations: the UI extension scope matches on the tag 'ui-ext'
const mainConv = await app.kernel.createConversation({ title: 'UI 扩展验收主会话', tags: ['ui-ext'] })
const auxConv = await app.kernel.createConversation({ title: 'UI 扩展验收辅助会话', tags: ['ui-ext'] })

// 5. Owner plugin clientRoot: a real client.tsx inside the temp dir (esbuild compiles on
//    demand; react/lucide/@helm/plugin-client are virtualized by the compiler into the host's
//    globally shared instances).
const clientSrcDir = join(dataDir, 'client-src')
await mkdir(join(clientSrcDir, 'parts'), { recursive: true })
await writeFile(
  join(clientSrcDir, 'client.tsx'),
  [
    "import { useState } from 'react'",
    "import { usePluginContext, usePluginDoc, usePluginSessionDoc, PluginSlot } from '@helm/plugin-client'",
    "import { Plus, History, Gauge } from 'lucide-react'",
    "import { sessionNote } from './parts/note'",
    '',
    '// Screen: params/isSplit/setParams (P1 deep links) + <PluginSlot name="cards" /> (P3)',
    'export function Screen(props) {',
    '  const [pushCount, setPushCount] = useState(0)',
    '  const status = usePluginDoc("status", "test:ui-owner")',
    '  return (',
    '    <div data-testid="owner-screen" style={{ display: \'flex\', flexDirection: \'column\', gap: 10 }}>',
    '      <p data-testid="screen-params">{JSON.stringify(props.params)}</p>',
    '      <p data-testid="screen-split">{String(props.isSplit)}</p>',
    '      <p data-testid="screen-doc">{JSON.stringify(status)}</p>',
    '      <p data-testid="screen-note">{sessionNote()}</p>',
    '      <div style={{ display: \'flex\', gap: 8 }}>',
    '        <button data-testid="set-filter" onClick={() => props.setParams({ filter: \'active\' })}><Plus size={12} />setParams replace</button>',
    '        <button data-testid="push-history" onClick={() => { props.setParams({ filter: `push-${pushCount + 1}` }, { push: true }); setPushCount(pushCount + 1) }}><History size={12} />setParams push</button>',
    '        <button data-testid="clear-filter" onClick={() => props.setParams({ filter: undefined })}>clear filter</button>',
    '      </div>',
    '      <div data-testid="owner-cards"><PluginSlot name="cards" fallback={<span>no contributor</span>} /></div>',
    '    </div>',
    '  )',
    '}',
    '',
    '// composer.pill: read/write draft and attachment counts; never calls submit (avoids triggering model turns)',
    'export function ComposerPill(props) {',
    '  const composer = props.composer',
    '  const ctx = usePluginContext()',
    '  const [snap, setSnap] = useState(null)',
    '  if (composer === undefined) return <span data-testid="pill-no-composer">composer unavailable</span>',
    '  return (',
    '    <span data-testid="owner-pill" style={{ display: \'inline-flex\', gap: 6, alignItems: \'center\' }}>',
    '      <button data-testid="pill-insert" onClick={() => composer.insertText("[ui-ext]")}>insert</button>',
    '      <button data-testid="pill-setdraft" onClick={() => composer.setDraft("draft-by-pill")}>setDraft</button>',
    '      <button data-testid="pill-snapshot" onClick={() => setSnap({ draft: composer.draft, attachments: composer.attachments.length })}>snapshot</button>',
    '      {snap !== null && <span data-testid="pill-snap-result">{snap.draft}|{snap.attachments}</span>}',
    '      <span data-testid="pill-ctx-plugin">{ctx.pluginId}</span>',
    '    </span>',
    '  )',
    '}',
    '',
    '// workbench.panel: usePluginSessionDoc renders the current conversation metrics; the button invokes this plugin increment',
    'export function MetricsPanel(props) {',
    '  const ctx = usePluginContext()',
    '  const doc = usePluginSessionDoc("metrics")',
    '  const conversationId = props.conversation.id',
    '  const onIncrement = () => { void ctx.callAction("increment", { conversationId, delta: 1 }).catch((error) => ctx.notify(String(error), "error")) }',
    '  return (',
    '    <div data-testid="owner-panel" style={{ display: \'flex\', flexDirection: \'column\', gap: 6 }}>',
    '      <span style={{ display: \'flex\', alignItems: \'center\', gap: 4 }}><Gauge size={12} />会话 {conversationId} metrics</span>',
    '      <span data-testid="panel-count">{String(doc && doc.count)}</span>',
    '      <button data-testid="panel-increment" onClick={onIncrement}>',
    '        <Plus size={12} />increment',
    '      </button>',
    '    </div>',
    '  )',
    '}',
    '',
  ].join('\n'),
)
await writeFile(join(clientSrcDir, 'parts', 'note.ts'), "export const sessionNote = () => 'owner client.tsx 本地依赖已编译'\n")

// 6. Owner plugin: a public global status doc + public sessionDoc('metrics', {count:0})
//    + an increment action (receives conversationId, updates that conversation's doc) +
//    Screen / workbench panel / composerPill / header/row micro-actions (scope matched on the
//    test conversation tags) / two settings panels.
await app.kernel.plugins.register({
  id: 'test:ui-owner',
  name: 'UI 扩展验收 owner',
  version: '1.0.0',
  clientRoot: clientSrcDir,
  definePlugin(ctx) {
    // Public global doc for cross-plugin usePluginDoc testing
    const status = ctx.doc('status', { source: 'test:ui-owner', ok: true, revisions: 0 }, { public: true })
    // Conversation-scoped projected doc (P4): initial { count: 0 }
    const metrics = ctx.sessionDoc('metrics', { count: 0 }, { public: true })
    ctx.action({
      id: 'increment',
      description: '会话 metrics 计数（P4 sessionDoc 写路径验收）',
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: { type: 'integer', minimum: 1 },
          delta: { type: 'integer' },
        },
        required: ['conversationId'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { conversationId: { type: 'integer' }, count: { type: 'integer' } },
        required: ['conversationId', 'count'],
      },
      handler(input) {
        const delta = typeof input.delta === 'number' && Number.isSafeInteger(input.delta) ? input.delta : 1
        let next = 0
        metrics.update(input.conversationId, (current) => {
          next = (typeof current.count === 'number' ? current.count : 0) + delta
          return { count: next }
        })
        return { conversationId: input.conversationId, count: next }
      },
    })
    ctx.action({
      id: 'bump_status',
      description: '全局 status doc 计数（P1 跨插件 usePluginDoc 写路径验收）',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object', properties: { revisions: { type: 'integer' } }, required: ['revisions'] },
      handler() {
        let revisions = 0
        status.update((current) => {
          revisions = current.revisions + 1
          return { ...current, revisions }
        })
        return { revisions }
      },
    })
    ctx.ui.sidebarItem({ id: 'ui-ext-entry', label: 'UI 扩展验收', icon: 'layers', target: 'screen:test:ui-owner/main' })
    ctx.ui.screen({ id: 'main', label: 'UI 扩展验收主屏', client: { module: 'client.tsx', export: 'Screen' } })
    ctx.ui.composerPill({
      id: 'draft-tools',
      label: '草稿工具',
      client: { module: 'client.tsx', export: 'ComposerPill' },
      scope: { tags: ['ui-ext'] },
    })
    ctx.ui.workbenchPanel({
      id: 'metrics',
      label: '会话 metrics',
      icon: 'activity',
      client: { module: 'client.tsx', export: 'MetricsPanel' },
    })
    // Micro-actions (P2): a top-bar toolbar button (the host injects conversationId); the row menu likewise
    ctx.ui.conversationHeaderAction({
      id: 'header-increment',
      label: 'metrics +1',
      icon: 'plus',
      placement: 'toolbar',
      actionId: 'increment',
      scope: { tags: ['ui-ext'] },
    })
    ctx.ui.conversationRowAction({
      id: 'row-bump-status',
      label: 'status bump',
      icon: 'zap',
      actionId: 'bump_status',
      scope: { tags: ['ui-ext'] },
    })
    // Slash command (P1): actionId='increment', input explicitly fills the test conversation id
    ctx.ui.command({
      id: 'metrics-increment',
      title: '会话 metrics 计数 +1',
      slash: 'ui-metrics',
      description: '对 UI 扩展验收主会话执行 increment（P1 slash 命令）',
      icon: 'plus',
      actionId: 'increment',
      input: { conversationId: mainConv.id, delta: 1 },
      keywords: ['ui', 'metrics', 'session-doc'],
    })
    // Two settings panels from the same plugin (P2 multi-panel rendering acceptance)
    ctx.ui.settingsPanel({
      id: 'owner-settings',
      label: 'owner 验收说明',
      order: 10,
      json: {
        component: 'Stack',
        children: [
          { component: 'Callout', title: 'test:ui-owner', text: 'P1/P3/P4 owner 插件设置面板（第一块）。' },
        ],
      },
    })
    ctx.ui.settingsPanel({
      id: 'owner-settings-more',
      label: 'owner 第二面板',
      order: 20,
      json: {
        component: 'Stack',
        children: [
          { component: 'Callout', title: '第二面板', text: '同插件多 settings.panel 渲染验收（P2）。' },
        ],
      },
    })
  },
})

// 7. Contributor plugin: injects a JSON-track and a client.tsx-track contribution card into
//    test:ui-owner/cards; the React card shows the contributor plugin context and calls
//    bump_status cross-plugin via ctx.callAction.
const contributorSrcDir = join(dataDir, 'contributor-src')
await mkdir(contributorSrcDir, { recursive: true })
await writeFile(
  join(contributorSrcDir, 'client.tsx'),
  [
    "import { useState } from 'react'",
    "import { usePluginContext, usePluginDoc } from '@helm/plugin-client'",
    "import { Boxes, ArrowRight } from 'lucide-react'",
    '',
    '// Injected into the owner <PluginSlot name="cards" />: contributor context + cross-plugin action / doc',
    'export function ContributorCard(props) {',
    '  const ctx = usePluginContext()',
    '  const ownerStatus = usePluginDoc("status", "test:ui-owner")',
    '  const [result, setResult] = useState(null)',
    '  const onCross = () => {',
    '    void ctx.callAction("bump_status", {}, { pluginId: "test:ui-owner" })',
    '      .then((r) => setResult(JSON.stringify(r)))',
    '      .catch((error) => setResult(String(error)))',
    '  }',
    '  return (',
    '    <div data-testid="contributor-card" style={{ border: \'1px solid #ccc\', padding: 8, display: \'flex\', flexDirection: \'column\', gap: 6 }}>',
    '      <span style={{ display: \'flex\', alignItems: \'center\', gap: 4 }}><Boxes size={12} />contributor: {ctx.pluginId}</span>',
    '      <span data-testid="contributor-slot-props">{JSON.stringify(props)}</span>',
    '      <span data-testid="contributor-owner-doc">{JSON.stringify(ownerStatus)}</span>',
    '      <button data-testid="contributor-cross-action" onClick={onCross}><ArrowRight size={12} />跨插件 bump_status</button>',
    '      {result !== null && <span data-testid="contributor-cross-result">{result}</span>}',
    '    </div>',
    '  )',
    '}',
    '',
  ].join('\n'),
)
await app.kernel.plugins.register({
  id: 'test:ui-contributor',
  name: 'UI 扩展验收 contributor',
  version: '1.0.0',
  clientRoot: contributorSrcDir,
  definePlugin(ctx) {
    // JSON-track contribution card (declarative slot injection, using only the existing
    // primitive components Card/Text/Badge)
    ctx.ui.slot({
      id: 'json-card',
      target: 'test:ui-owner/cards',
      order: 20,
      json: {
        component: 'Card',
        title: 'JSON 轨贡献卡',
        children: [
          { component: 'Text', text: 'contributor 经 ctx.ui.slot 注入的声明式卡片。' },
          { component: 'Badge', text: 'json-slot' },
        ],
      },
    })
    // client.tsx-track contribution card (React component injection; the lower order sorts first)
    ctx.ui.slot({
      id: 'react-card',
      target: 'test:ui-owner/cards',
      order: 10,
      client: { module: 'client.tsx', export: 'ContributorCard' },
    })
    // Timeline micro-action registration (generates no message; kinds omitted to match plain
    // message entries by default, keeping the registration surface for entry-level hover
    // action coverage)
    ctx.ui.timelineEntryAction({
      id: 'entry-note',
      label: '标记验收条目',
      icon: 'check',
      actionId: 'bump_status',
      scope: { tags: ['ui-ext'] },
    })
  },
})

// 8. startHub: port 0 (random port; never occupies 3201/3202 or 3000/3001/3002/3101/3102),
//    webDistDir explicitly points at this worktree's build output (a missing dir makes
//    startHub fail explicitly with web_dist_invalid).
const hub = await startHub({ kernel: app.kernel, port: 0, webDistDir: join(projectRoot, 'packages/web/dist') })

// 9. Info JSON (mode 0600): default /tmp/helm-ui-extensions-acceptance-info.json
const infoPath = process.env.HELM_UI_EXT_ACCEPTANCE_INFO ?? '/tmp/helm-ui-extensions-acceptance-info.json'
await writeFile(
  infoPath,
  JSON.stringify(
    {
      url: hub.url,
      token: issued.token,
      password: testPassword,
      dataDir,
      conversations: { main: mainConv.id, aux: auxConv.id },
      plugins: ['test:ui-owner', 'test:ui-contributor'],
      clientRoots: { owner: clientSrcDir, contributor: contributorSrcDir },
    },
    null,
    2,
  ),
  { mode: 0o600 },
)

console.log(`UI extension acceptance service ready: ${hub.url}`)
console.log(`Test conversations: main=${mainConv.id} aux=${auxConv.id} (both tagged ui-ext; root conversation #1 untouched)`)
console.log(`Plugins: test:ui-owner / test:ui-contributor; data dir ${dataDir}`)
console.log(`Login info JSON (0600): ${infoPath}`)
console.log('Service keeps running; SIGTERM/SIGINT shut it down gracefully.')

// 10. Graceful shutdown: close the hub first (severing SSE/in-flight requests), then the
//     kernel (SQLite flushed to disk); this fixture controls no Herdr/terminal panes (no
//     human-pane interaction surface).
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    try {
      await hub.close()
      await app.close()
    } finally {
      process.exit(0)
    }
  })
}
