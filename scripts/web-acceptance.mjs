// 仅供浏览器验收：真实内核/SQLite/HTTP，模型输出由 SDK faux provider 提供。
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHelm } from '../packages/kernel/dist/app.js'
import { startHub } from '../packages/kernel/dist/http/index.js'
const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const sdkRoot = new URL('../packages/kernel/node_modules/@earendil-works/pi-ai/dist/', import.meta.url)
const { createModels } = await import(new URL('models.js', sdkRoot).href)
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(new URL('providers/faux.js', sdkRoot).href)
const dataDir = await mkdtemp(join(tmpdir(), 'helm-web-acceptance-'))
const faux = fauxProvider({ tokensPerSecond: 150 })
const models = createModels()
models.setProvider(faux.provider)
const app = await createHelm({ dataDir, cwd: projectRoot, model: 'faux/faux-1', models })
const testPassword = crypto.randomUUID()
const issued = await app.kernel.auth.setup(testPassword)
const chat = await app.kernel.createConversation({ title: 'Web 验收：消息与附件' })
const history = await app.kernel.createConversation({ title: '历史分页验收' })
const example = [
  '这是一条 **Web 验收用的固定模型响应**，用于检查真实持久会话和浏览器的渲染连接。',
  '',
  '| 项目 | 状态 |', '| --- | --- |', '| 真实工具执行 | 已完成 |', '| 多模态附件 | 已登记 |',
  '', '```typescript', 'const message = "Helm Web"', 'console.log(message)', '```',
  '', '```mermaid', 'flowchart LR', '  A[用户输入] --> B[持久会话]', '  B --> C[工具执行]', '  C --> D[结果展示]', '```',
  '', '```ui', JSON.stringify({ component: 'Card', title: '声明式消息卡', children: [{ component: 'Text', text: '使用与插件相同的原语组件。' }, { component: 'Button', label: '打开个人助理', action: { type: 'helm:open', target: 'conversation:1', split: true } }] }), '```',
].join('\n')
faux.setResponses(Array.from({ length: 90 }, (_, i) => fauxAssistantMessage(`分页检查 ${i + 1}`)))
for (let index = 0; index < 85; index++) {
  await app.kernel.submitInput(history.id, `历史记录 ${index + 1}：${index === 0 ? '唯一最早搜索标记 HelmHistoryNeedle' : '检查分页'}`)
  await app.kernel.waitForIdle(history.id)
}
faux.setResponses([
  fauxAssistantMessage([fauxToolCall('bash', { command: "printf 'helm-web-tool-ok\\n'" })], { stopReason: 'toolUse' }),
  fauxAssistantMessage(example),
  ...Array.from({ length: 40 }, () => fauxAssistantMessage(example)),
])
await app.kernel.submitInput(chat.id, '请执行一次本地测试命令，再展示 Markdown、图表与声明式卡片。')
await app.kernel.waitForIdle(chat.id)
await app.kernel.artifacts.writeUploaded(chat.id, { name: '验收说明.md', mimeType: 'text/markdown', bytes: new TextEncoder().encode('# Helm Web 验收\n\n真实产物文件。') })
await app.kernel.plugins.register({
  id: 'test:web-acceptance', name: 'Web 验收组件样例', version: '1.0.0', definePlugin(ctx) {
    const doc = ctx.doc('catalog', { enabled: false, rows: [{ conversationId: chat.id, label: '消息与附件' }, { conversationId: history.id, label: '历史记录' }] }, { public: true })
    ctx.action({ id: 'toggle', description: '验收 Switch 原始布尔参数', inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'], additionalProperties: false }, outputSchema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] }, handler(input) { doc.update((old) => ({ ...old, enabled: input.enabled })); return { enabled: input.enabled } } })
    ctx.ui.sidebarItem({ id: 'catalog', label: '组件验收样例', icon: 'layers', target: 'screen:test:web-acceptance/catalog' })
    ctx.ui.screen({ id: 'catalog', label: '组件验收样例', docs: ['catalog'], json: { component: 'Stack', children: [
      { component: 'Callout', title: '测试专用', text: '此页只在独立验收服务中注册。' },
      { component: 'KeyValueList', items: [{ label: '原始布尔值', key: '/$docs/catalog/enabled' }, { label: '会话数量', key: '/$docs/catalog/rows/length' }] },
      { component: 'Switch', label: '启用样例', value: '{$docs.catalog.enabled}', action: { type: 'helm:action', actionId: 'toggle', input: { enabled: '{$value}' } } },
      { component: 'Table', columns: [{ key: 'conversationId', label: '会话' }, { key: 'label', label: '用途' }], rows: '{$docs.catalog.rows}', rowActions: [{ label: '在右屏打开', action: { type: 'helm:open', target: 'conversation:{$row.conversationId}', split: true } }] },
    ] } })
  },
})
// client.tsx 第二轨道验收夹具：真实 clientRoot + 动态编译加载（浏览器验收用）
const clientSrcDir = join(dataDir, 'client-src')
await mkdir(join(clientSrcDir, 'parts'), { recursive: true })
await writeFile(
  join(clientSrcDir, 'client.tsx'),
  [
    "import { useState } from 'react'",
    "import { Activity } from 'lucide-react'",
    "import { statusLine } from './parts/line'",
    "import { usePluginDoc } from '@helm/plugin-client'",
    '',
    'export function Panel(props) {',
    "  const [count, setCount] = useState(0)",
    "  const catalog = usePluginDoc('catalog')",
    '  return (',
    '    <div className="card" style={{ display: \'flex\', flexDirection: \'column\', gap: 8 }}>',
    '      <div style={{ display: \'flex\', alignItems: \'center\', gap: 6 }}>',
    '        <Activity size={13} />',
    '        <strong>client.tsx 动态组件验收</strong>',
    '      </div>',
    '      <p style={{ margin: 0, fontSize: 12.5 }}>screenId: {props.screenId}；点击计数：{count}</p>',
    '      <p style={{ margin: 0, fontSize: 12.5 }}>{statusLine()}</p>',
    '      <p style={{ margin: 0, fontSize: 12.5 }}>docs.catalog: {JSON.stringify(catalog)}</p>',
    '      <button className="btn btn-sm" onClick={() => setCount(count + 1)}>client 组件内计数</button>',
    '    </div>',
    '  )',
    '}',
    '',
  ].join('\n'),
)
await writeFile(join(clientSrcDir, 'parts', 'line.ts'), "export const statusLine = () => '本地依赖（parts/line.ts）已随插件闭包编译进产物'\n")
await app.kernel.plugins.register({
  id: 'test:client-acceptance', name: 'Web 验收 client.tsx 样例', version: '1.0.0', clientRoot: clientSrcDir, definePlugin(ctx) {
    ctx.ui.sidebarItem({ id: 'client-demo', label: 'client.tsx 验收', icon: 'code', target: 'screen:test:client-acceptance/demo' })
    ctx.ui.screen({ id: 'demo', label: 'client.tsx 动态组件', client: { module: 'client.tsx', export: 'Panel' } })
  },
})

void app.kernel.createAsk({ conversationId: chat.id, title: '浏览器验收：请确认', description: '这是验收服务的审批卡，不控制真实终端。', fields: [{ name: 'allow', label: '继续测试', type: 'confirm', required: true }] }).catch(console.error)
const hub = await startHub({ kernel: app.kernel, workflows: app.workflows, port: 3202 })
const infoPath = process.env.HELM_WEB_ACCEPTANCE_INFO ?? join(dataDir, 'browser.json')
await writeFile(infoPath, JSON.stringify({ dataDir, chatId: chat.id, historyId: history.id, url: hub.url, token: issued.token }), { mode: 0o600 })
console.log(`独立验收服务已就绪：${hub.url}；会话 ${chat.id}，历史 ${history.id}；数据目录 ${dataDir}`)
console.log(`测试登录密码：${testPassword}（仅用于本次临时数据目录）`)
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await hub.close(); await app.close(); process.exit(0) })
