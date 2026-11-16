// only supply browser verify: real kernel/SQLite/HTTP, model output by SDK faux provider provide.
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
const chat = await app.kernel.createConversation({ title: 'Web verify: message and attachment' })
const history = await app.kernel.createConversation({ title: 'history page verify' })
const example = [
  'this is a **Web verify use fixed model response**, used to check real durable conversation and browser render connect.',
  '',
  '| items item | state |', '| --- | --- |', '| real tool execute | completed |', '| multimodal attachment | already register |',
  '', '```typescript', 'const message = "Helm Web"', 'console.log(message)', '```',
  '', '```mermaid', 'flowchart LR', '  A[user input] --> B[durable conversation]', '  B --> C[tool execute]', '  C --> D[result render]', '```',
  '', '```ui', JSON.stringify({ component: 'Card', title: 'declaration style message card', children: [{ component: 'Text', text: 'use and plugin identical original language component.' }, { component: 'Button', label: 'open person assist', action: { type: 'helm:open', target: 'conversation:1', split: true } }] }), '```',
].join('\n')
faux.setResponses(Array.from({ length: 90 }, (_, i) => fauxAssistantMessage(`page check ${i + 1}`)))
for (let index = 0; index < 85; index++) {
  await app.kernel.submitInput(history.id, `history record ${index + 1}:${index === 0 ? 'unique most early search mark record HelmHistoryNeedle' : 'check page'}`)
  await app.kernel.waitForIdle(history.id)
}
faux.setResponses([
  fauxAssistantMessage([fauxToolCall('bash', { command: "printf 'helm-web-tool-ok\\n'" })], { stopReason: 'toolUse' }),
  fauxAssistantMessage(example),
  ...Array.from({ length: 40 }, () => fauxAssistantMessage(example)),
])
await app.kernel.submitInput(chat.id, 'please execute once local test command, again render Markdown, diagram table and declaration style card.')
await app.kernel.waitForIdle(chat.id)
await app.kernel.artifacts.writeUploaded(chat.id, { name: 'verify note.md', mimeType: 'text/markdown', bytes: new TextEncoder().encode('# Helm Web verify\n\nreal artifact file.') })
await app.kernel.plugins.register({
  id: 'test:web-acceptance', name: 'Web verify component example', version: '1.0.0', definePlugin(ctx) {
    const doc = ctx.doc('catalog', { enabled: false, rows: [{ conversationId: chat.id, label: 'message and attachment' }, { conversationId: history.id, label: 'history record' }] }, { public: true })
    ctx.action({ id: 'toggle', description: 'verify Switch original boolean parameter', inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'], additionalProperties: false }, outputSchema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] }, handler(input) { doc.update((old) => ({ ...old, enabled: input.enabled })); return { enabled: input.enabled } } })
    ctx.ui.sidebarItem({ id: 'catalog', label: 'component verify example', icon: 'layers', target: 'screen:test:web-acceptance/catalog' })
    ctx.ui.screen({ id: 'catalog', label: 'component verify example', docs: ['catalog'], json: { component: 'Stack', children: [
      { component: 'Callout', title: 'test dedicated use', text: 'this page only in independent verify service in register.' },
      { component: 'KeyValueList', items: [{ label: 'original boolean value', key: '/$docs/catalog/enabled' }, { label: 'conversation amount', key: '/$docs/catalog/rows/length' }] },
      { component: 'Switch', label: 'enable example', value: '{$docs.catalog.enabled}', action: { type: 'helm:action', actionId: 'toggle', input: { enabled: '{$value}' } } },
      { component: 'Table', columns: [{ key: 'conversationId', label: 'conversation' }, { key: 'label', label: 'purpose' }], rows: '{$docs.catalog.rows}', rowActions: [{ label: 'in right screen open', action: { type: 'helm:open', target: 'conversation:{$row.conversationId}', split: true } }] },
    ] } })
  },
})
// client.tsx second track path verify fixture: real clientRoot + motion state compile load (browser verify use)
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
    '        <strong>client.tsx motion state component verify</strong>',
    '      </div>',
    '      <p style={{ margin: 0, fontSize: 12.5 }}>screenId: {props.screenId}; point strike counter:{count}</p>',
    '      <p style={{ margin: 0, fontSize: 12.5 }}>{statusLine()}</p>',
    '      <p style={{ margin: 0, fontSize: 12.5 }}>docs.catalog: {JSON.stringify(catalog)}</p>',
    '      <button className="btn btn-sm" onClick={() => setCount(count + 1)}>client component inside counter</button>',
    '    </div>',
    '  )',
    '}',
    '',
  ].join('\n'),
)
await writeFile(join(clientSrcDir, 'parts', 'line.ts'), "export const statusLine = () => 'local dependency (parts/line.ts) already follow plugin closed package compile enter artifact'\n")
await app.kernel.plugins.register({
  id: 'test:client-acceptance', name: 'Web verify client.tsx example', version: '1.0.0', clientRoot: clientSrcDir, definePlugin(ctx) {
    ctx.ui.sidebarItem({ id: 'client-demo', label: 'client.tsx verify', icon: 'code', target: 'screen:test:client-acceptance/demo' })
    ctx.ui.screen({ id: 'demo', label: 'client.tsx motion state component', client: { module: 'client.tsx', export: 'Panel' } })
  },
})

void app.kernel.createAsk({ conversationId: chat.id, title: 'browser verify: please confirm', description: 'this is verify service approval card, do not control real terminal.', fields: [{ name: 'allow', label: 'continue test', type: 'confirm', required: true }] }).catch(console.error)
const hub = await startHub({ kernel: app.kernel, workflows: app.workflows, port: 3202 })
const infoPath = process.env.HELM_WEB_ACCEPTANCE_INFO ?? join(dataDir, 'browser.json')
await writeFile(infoPath, JSON.stringify({ dataDir, chatId: chat.id, historyId: history.id, url: hub.url, token: issued.token }), { mode: 0o600 })
console.log(`independent verify service ready:${hub.url}; conversation ${chat.id}, history ${history.id}; data directory ${dataDir}`)
console.log(`test login password:${testPassword}(only used to this time temporary data directory)`)
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await hub.close(); await app.close(); process.exit(0) })
