// Browser acceptance fixture only: real kernel/SQLite/HTTP, with model output provided by the SDK faux provider.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHelm } from '../packages/hub/dist/app.js'
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
const chat = await app.kernel.createConversation({ title: 'Web acceptance: messages and attachments' })
const history = await app.kernel.createConversation({ title: 'History pagination acceptance' })
const example = [
  'This is a **fixed model response for Web acceptance**, used to verify real durable conversations and browser rendering.',
  '',
  '| Item | Status |', '| --- | --- |', '| Real tool execution | Completed |', '| Multimodal attachment | Registered |',
  '', '```typescript', 'const message = "Helm Web"', 'console.log(message)', '```',
  '', '```mermaid', 'flowchart LR', '  A[User input] --> B[Durable conversation]', '  B --> C[Tool execution]', '  C --> D[Result display]', '```',
  '', '```ui', JSON.stringify({ component: 'Card', title: 'Declarative message card', children: [{ component: 'Text', text: 'Uses the same primitive components as plugins.' }, { component: 'Button', label: 'Open Assistant', action: { type: 'helm:open', target: 'conversation:1', split: true } }] }), '```',
].join('\n')
faux.setResponses(Array.from({ length: 90 }, (_, i) => fauxAssistantMessage(`Pagination check ${i + 1}`)))
for (let index = 0; index < 85; index++) {
  await app.kernel.submitInput(history.id, `History entry ${index + 1}: ${index === 0 ? 'unique earliest search marker HelmHistoryNeedle' : 'pagination check'}`)
  await app.kernel.waitForIdle(history.id)
}
faux.setResponses([
  fauxAssistantMessage([fauxToolCall('bash', { command: "printf 'helm-web-tool-ok\\n'" })], { stopReason: 'toolUse' }),
  fauxAssistantMessage(example),
  ...Array.from({ length: 40 }, () => fauxAssistantMessage(example)),
])
await app.kernel.submitInput(chat.id, 'Please run a local test command, then render Markdown, a diagram, a table, and a declarative card.')
await app.kernel.waitForIdle(chat.id)
await app.kernel.artifacts.writeUploaded(chat.id, { name: 'acceptance-note.md', mimeType: 'text/markdown', bytes: new TextEncoder().encode('# Helm Web Acceptance\n\nReal artifact file.') })
await app.kernel.plugins.register({
  id: 'test:web-acceptance', name: 'Web acceptance widget sample', version: '1.0.0', definePlugin(ctx) {
    const doc = ctx.doc('catalog', { enabled: false, rows: [{ conversationId: chat.id, label: 'Messages and attachments' }, { conversationId: history.id, label: 'History entries' }] }, { public: true })
    ctx.action({ id: 'toggle', description: 'Verify Switch raw boolean argument', inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'], additionalProperties: false }, outputSchema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] }, handler(input) { doc.update((old) => ({ ...old, enabled: input.enabled })); return { enabled: input.enabled } } })
    ctx.ui.sidebarItem({ id: 'catalog', label: 'Component acceptance sample', icon: 'layers', target: 'screen:test:web-acceptance/catalog' })
    ctx.ui.screen({ id: 'catalog', label: 'Component acceptance sample', docs: ['catalog'], json: { component: 'Stack', children: [
      { component: 'Callout', title: 'Test only', text: 'This screen is only registered in the standalone acceptance server.' },
      { component: 'KeyValueList', items: [{ label: 'Raw boolean', key: '/$docs/catalog/enabled' }, { label: 'Conversation count', key: '/$docs/catalog/rows/length' }] },
      { component: 'Switch', label: 'Enable sample', value: '{$docs.catalog.enabled}', action: { type: 'helm:action', actionId: 'toggle', input: { enabled: '{$value}' } } },
      { component: 'Table', columns: [{ key: 'conversationId', label: 'Conversation' }, { key: 'label', label: 'Purpose' }], rows: '{$docs.catalog.rows}', rowActions: [{ label: 'Open in right pane', action: { type: 'helm:open', target: 'conversation:{$row.conversationId}', split: true } }] },
    ] } })
  },
})
// Second-track client.tsx acceptance fixture: real clientRoot + dynamic compile/load (for browser acceptance).
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
    '        <strong>client.tsx dynamic component acceptance</strong>',
    '      </div>',
    '      <p style={{ margin: 0, fontSize: 12.5 }}>screenId: {props.screenId}; click count: {count}</p>',
    '      <p style={{ margin: 0, fontSize: 12.5 }}>{statusLine()}</p>',
    '      <p style={{ margin: 0, fontSize: 12.5 }}>docs.catalog: {JSON.stringify(catalog)}</p>',
    '      <button className="btn btn-sm" onClick={() => setCount(count + 1)}>Local component counter</button>',
    '    </div>',
    '  )',
    '}',
    '',
  ].join('\n'),
)
await writeFile(join(clientSrcDir, 'parts', 'line.ts'), "export const statusLine = () => 'Local dependency (parts/line.ts) compiled into the plugin bundle artifact'\n")
await app.kernel.plugins.register({
  id: 'test:client-acceptance', name: 'Web acceptance client.tsx sample', version: '1.0.0', clientRoot: clientSrcDir, definePlugin(ctx) {
    ctx.ui.sidebarItem({ id: 'client-demo', label: 'client.tsx acceptance', icon: 'code', target: 'screen:test:client-acceptance/demo' })
    ctx.ui.screen({ id: 'demo', label: 'client.tsx dynamic component', client: { module: 'client.tsx', export: 'Panel' } })
  },
})

void app.kernel.createAsk({ conversationId: chat.id, title: 'Browser acceptance: please confirm', description: 'Approval card for the acceptance server; does not control a real terminal.', fields: [{ name: 'allow', label: 'Continue test', type: 'confirm', required: true }] }).catch(console.error)
const hub = await startHub({ kernel: app.kernel, workflows: app.workflows, port: 3202 })
const infoPath = process.env.HELM_WEB_ACCEPTANCE_INFO ?? join(dataDir, 'browser.json')
await writeFile(infoPath, JSON.stringify({ dataDir, chatId: chat.id, historyId: history.id, url: hub.url, token: issued.token }), { mode: 0o600 })
console.log(`Standalone acceptance server ready: ${hub.url}; conversation ${chat.id}, history ${history.id}; data dir ${dataDir}`)
console.log(`Test login password: ${testPassword} (scoped to this temporary data dir only)`)
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await hub.close(); await app.close(); process.exit(0) })
