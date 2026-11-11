// UI 扩展（P0–P4）浏览器验收夹具：真实内核/SQLite/PluginHost/HTTP/esbuild，
// 零模型调用（不注入 faux provider，测试插件只走 UI/文档/action 面）。
//
// 前置：本仓库已完成 pnpm build（packages/kernel/dist 与 packages/web/dist 存在）。
// 注意：当前 worktree 基线尚不含 P0–P4 实现（sessionDoc / 微操作 / PluginSlot /
// composer 控制面在后端与前端并行开发中，protocol 契约见 ce17ae67）。本脚本
// 是为合入后的真实浏览器验收预置的夹具：现在直接运行会在注册
// ctx.sessionDoc / ctx.ui.conversationHeaderAction 等新扩展点时被旧版
// PluginHost 以 TypeError 拒绝——这是如实的失败，不是脚本缺陷；请勿为绕过
// 而注释掉任何注册（禁止静默降级）。主代理合入全部实现并 pnpm build 后运行：
//   node scripts/ui-extensions-acceptance.mjs
// 产出：/tmp/helm-ui-extensions-acceptance-info.json（mode 0600，含 url/token/会话 ID）。
//
// 与 scripts/web-acceptance.mjs 的差异：
// - 只覆盖 UI 扩展面（Screen 参数化 / composer / 微操作 / PluginSlot / sessionDoc），
//   不做消息渲染分页验收，因此不需要 faux 模型输出；
// - startHub port:0（随机端口，绝不占用 3201/3202 与 3000/3001/3002/3101/3102），
//   webDistDir 显式指向本 worktree 构建的 packages/web/dist（失效即显式报错，
//   不静默禁用静态托管）；
// - 服务保持运行直到 SIGTERM/SIGINT，供 agent-browser 真实交互。
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const { createHelm } = await import('../packages/kernel/dist/app.js')
const { startHub } = await import('../packages/kernel/dist/http/index.js')

// 1. 隔离数据目录（mkdtemp 于系统临时目录，绝不读写 ~/.helm 或旧系统数据）
const dataDir = await mkdtemp(join(tmpdir(), 'helm-ui-ext-acceptance-'))

// 2. 真实内核：SQLite + PluginHost + 内置 esbuild client 编译器全部就绪。
//    不注入 models：本夹具零模型调用（会话创建与 UI/action 面不依赖模型）。
const app = await createHelm({ dataDir, cwd: projectRoot })

// 3. 随机测试密码 auth.setup（UUID 满足 >=8 位；info JSON mode 0600 落盘）
const testPassword = crypto.randomUUID()
const issued = await app.kernel.auth.setup(testPassword)

// 4. 两个非根测试会话：UI 扩展 scope 按 tag 'ui-ext' 命中
const mainConv = await app.kernel.createConversation({ title: 'UI 扩展验收主会话', tags: ['ui-ext'] })
const auxConv = await app.kernel.createConversation({ title: 'UI 扩展验收辅助会话', tags: ['ui-ext'] })

// 5. owner 插件 clientRoot：临时目录内真实 client.tsx（esbuild 按需编译，
//    react/lucide/@helm/plugin-client 由编译器虚拟化为宿主全局共享实例）。
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
    '// Screen：params/isSplit/setParams（P1 深链）+ <PluginSlot name="cards" />（P3）',
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
    '// composer.pill：读写草稿/附件计数，绝不调用 submit（避免触发模型回合）',
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
    '// workbench.panel：usePluginSessionDoc 展示当前会话 metrics，按钮调用本插件 increment',
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

// 6. owner 插件：public 全局 status doc + public sessionDoc('metrics', {count:0})
//    + increment action（接收 conversationId，更新该会话 doc）+ Screen / 工作台面板 /
//    composerPill / header/row 微操作（scope 按测试会话标签）/ 两块 settings 面板。
await app.kernel.plugins.register({
  id: 'test:ui-owner',
  name: 'UI 扩展验收 owner',
  version: '1.0.0',
  clientRoot: clientSrcDir,
  definePlugin(ctx) {
    // 跨插件 usePluginDoc 测试用的公开全局文档
    const status = ctx.doc('status', { source: 'test:ui-owner', ok: true, revisions: 0 }, { public: true })
    // 会话级投影文档（P4）：初始 { count: 0 }
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
    // 微操作（P2）：顶栏 toolbar 按钮（宿主注入 conversationId）；行菜单同理
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
    // slash 命令（P1）：actionId='increment'，input 显式填测试会话 id
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
    // 同插件两块 settings 面板（P2 多面板渲染验收）
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

// 7. contributor 插件：向 test:ui-owner/cards 注入 JSON 轨与 client.tsx 轨贡献卡，
//    React 卡展示贡献者插件上下文并经 ctx.callAction 跨插件调用 bump_status。
const contributorSrcDir = join(dataDir, 'contributor-src')
await mkdir(contributorSrcDir, { recursive: true })
await writeFile(
  join(contributorSrcDir, 'client.tsx'),
  [
    "import { useState } from 'react'",
    "import { usePluginContext, usePluginDoc } from '@helm/plugin-client'",
    "import { Boxes, ArrowRight } from 'lucide-react'",
    '',
    '// 注入 owner 的 <PluginSlot name="cards" />：贡献者上下文 + 跨插件 action / doc',
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
    // JSON 轨贡献卡（声明式 Slot 注入，仅用既有原语组件 Card/Text/Badge）
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
    // client.tsx 轨贡献卡（React 组件注入，order 靠前排在前）
    ctx.ui.slot({
      id: 'react-card',
      target: 'test:ui-owner/cards',
      order: 10,
      client: { module: 'client.tsx', export: 'ContributorCard' },
    })
    // timeline 微操作注册（不生成消息；省略 kinds 以默认匹配普通消息条目，
    // 为 entry 级 hover 操作覆盖面保留注册面）
    ctx.ui.timelineEntryAction({
      id: 'entry-note',
      label: '标记验收条目',
      icon: 'check',
      actionId: 'bump_status',
      scope: { tags: ['ui-ext'] },
    })
  },
})

// 8. startHub：port 0（随机端口，绝不占用 3201/3202 与 3000/3001/3002/3101/3102），
//    webDistDir 显式指向本 worktree 构建产物（缺失时 startHub 显式 web_dist_invalid）。
const hub = await startHub({ kernel: app.kernel, port: 0, webDistDir: join(projectRoot, 'packages/web/dist') })

// 9. info JSON（mode 0600）：默认 /tmp/helm-ui-extensions-acceptance-info.json
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

console.log(`UI 扩展验收服务已就绪：${hub.url}`)
console.log(`测试会话：main=${mainConv.id} aux=${auxConv.id}（均带 ui-ext 标签；根会话 #1 不动）`)
console.log(`插件：test:ui-owner / test:ui-contributor；数据目录 ${dataDir}`)
console.log(`登录信息 JSON（0600）：${infoPath}`)
console.log('服务保持运行；SIGTERM/SIGINT 优雅关闭。')

// 10. 优雅关闭：先关 hub（断 SSE/在途请求）再关内核（SQLite 落盘）；
//     本夹具不控制任何 Herdr/终端窗格（无 human 窗格交互面）。
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
