/**
 * plugins init foot manually frame template (pure data module):minimal only backend / full through use plugin panel /
 * app full-stack micro app (artifact directly helm apps validate preflight) three Profile all file content template.
 * and command logic decouple: this module only negative duty to set plugin name produce out file text, does not any IO and validate.
 */

export type ScaffoldTemplate = 'minimal' | 'full' | 'app'

export const SCAFFOLD_TEMPLATES: readonly ScaffoldTemplate[] = ['minimal', 'full', 'app']

export const SCAFFOLD_PLUGIN_JSON = (id: string, template: ScaffoldTemplate) => `${JSON.stringify(
  {
    id,
    name: template === 'app' ? `${id} should use` : `${id} plugin`,
    version: '0.1.0',
    main: 'index.ts',
    ...(template === 'app' || template === 'full' ? { clientRoot: './client' } : {}),
  },
  null,
  2,
)}\n`

/** plugin local tsconfig: and host backend transpile habit align (.js note symbol mapping,ESM). */
export const SCAFFOLD_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      jsx: 'react-jsx',
    },
    include: ['index.ts', 'client/**/*.ts', 'client/**/*.tsx'],
  },
  null,
  2,
)}\n`

export const SCAFFOLD_INDEX_TS_MINIMAL = (id: string) => `/**
 * external plugin backend entry (id: ${id}):export default PluginDefinition.
 * modify after available helm plugins reload ${id} subject to control hot reload (preflight on failure old instance keep available).
 */
import type { PluginDefinition } from '@helm/protocol'

export default {
  id: '${id}',
  version: '0.1.0',
  description: 'external plugin (helm plugins init --template minimal generate)',
  definePlugin(ctx) {
    ctx.action({
      id: 'ping',
      description: 'connect through probe needle',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: { pong: { type: 'boolean' } },
        required: ['pong'],
        additionalProperties: false,
      },
      idempotent: true,
      handler: () => ({ pong: true }),
    })
  },
} satisfies PluginDefinition
`

export const SCAFFOLD_INDEX_TS_FULL = (id: string) => `/**
 * external plugin backend entry (id: ${id}):export default PluginDefinition.
 * modify after available helm plugins reload ${id} subject to control hot reload (preflight on failure old instance keep available).
 */
import type { PluginDefinition } from '@helm/protocol'

export default {
  id: '${id}',
  version: '0.1.0',
  description: 'example external plugin (helm plugins init generate)',
  clientRoot: './client',
  definePlugin(ctx) {
    const state = ctx.doc('state', { count: 0 }, { public: true })
    ctx.action({
      id: 'increment',
      description: 'counter add one',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: { count: { type: 'number' } },
        required: ['count'],
        additionalProperties: false,
      },
      idempotent: false,
      handler() {
        state.update((current) => ({ count: current.count + 1 }))
        return { count: state.get().count }
      },
    })
    ctx.ui.workbenchPanel({
      id: 'sample-panel',
      label: 'example panel',
      client: { module: 'index.tsx', export: 'SamplePanel' },
    })
  },
} satisfies PluginDefinition
`

export const SCAFFOLD_CLIENT_INDEX_TSX = `import React from 'react'
import { usePluginDoc, ScreenSection, DataTable, KvGrid } from '@helm/plugin-client'

export function SamplePanel(): React.JSX.Element {
  const state = usePluginDoc<{ count: number }>('state')
  const loading = state === undefined
  return (
    <ScreenSection title="example panel">
      {loading ? (
        <div className="loading-state" role="status">counter read in...</div>
      ) : (
        <KvGrid
          items={[
            { key: 'when before counter', value: state.count },
            { key: 'update way', value: 'invoke increment action update counter' },
          ]}
        />
      )}
      <DataTable columns={1} empty={!loading && state !== undefined && state.count === 0} emptyLabel="counter is zero">
        <thead>
          <tr>
            <th>counter record</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>count = {state === undefined ? '-' : state.count}</td>
          </tr>
        </tbody>
      </DataTable>
    </ScreenSection>
  )
}
`

/**
 * app template backend:public doc durable item + two double Schema action + screen main view + sidebar direct reach entry.
 * and app-builder skill fullstack-template.md keep the same shape;
 * write after flush(honest: do not lie report persisted); without Emoji; action also declaration input/outputSchema
 * (single point Schema contract, missing will in doctor register phase by refuse).
 */
export const SCAFFOLD_INDEX_TS_APP = (id: string, label: string) => `/**
 * full-stack micro app backend entry (id: ${id}):export default PluginDefinition.
 * modify after use helm apps validate re- inspect, again helm apps publish hot update publish.
 */
import { randomUUID } from 'node:crypto'
import type { PluginDefinition } from '@helm/protocol'

interface Item {
  id: string
  title: string
  done: boolean
  createdAt: number
}

export default {
  id: '${id}',
  name: '${label}',
  description: 'most small full-stack micro app: durable item + new increase/check action + main view.',
  version: '0.1.0',
  clientRoot: './client',
  definePlugin(ctx) {
    // durable business data:public doc supply frontend usePluginDoc real-time subscribe
    const items = ctx.doc<{ list: Item[] }>('items', { list: [] }, { public: true })

    // sharing outputSchema: action unify return { ok: true }
    const okSchema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    } as const

    ctx.action<{ title: string }, { ok: boolean }>({
      id: 'add_item',
      description: 'new increase a item',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string', minLength: 1 } },
        required: ['title'],
        additionalProperties: false,
      },
      outputSchema: okSchema,
      exposeAsTool: true,
      async handler(input) {
        items.update((current) => ({
          list: [
            { id: randomUUID(), title: input.title, done: false, createdAt: Date.now() },
            ...current.list,
          ],
        }))
        await items.flush()
        return { ok: true }
      },
    })

    ctx.action<{ id: string; done: boolean }, { ok: boolean }>({
      id: 'set_done',
      description: 'check/cancel check item',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, done: { type: 'boolean' } },
        required: ['id', 'done'],
        additionalProperties: false,
      },
      outputSchema: okSchema,
      exposeAsTool: true,
      async handler(input) {
        items.update((current) => ({
          list: current.list.map((it) => (it.id === input.id ? { ...it, done: input.done } : it)),
        }))
        await items.flush()
        return { ok: true }
      },
    })

    // full-stack should use hard want seek: at least a ctx.ui.screen(apps validate  missing_app_screen check items)
    ctx.ui.screen({
      id: 'main',
      label: '${label}',
      client: { module: 'index.tsx', export: 'MainScreen' },
    })

    // sidebar direct reach entry (protocol allows screen:<pluginId>/<screenId> target; does not need can directly delete this segment,
    // should use still can from app center open)
    ctx.ui.sidebarItem({
      id: 'open-main',
      label: '${label}',
      icon: 'layout-grid',
      target: 'screen:${id}/main',
    })
  },
} satisfies PluginDefinition
`

/**
 * app template frontend: only use @helm/plugin-client host original language (Screen/ScreenSection/KvGrid/
 * DataTable/Checkbox)+ host CSS variable and .btn button; without Emoji;13px body text.
 */
export const SCAFFOLD_CLIENT_APP_TSX = `import { useState, type ReactNode } from 'react'
import {
  usePluginContext,
  usePluginDoc,
  Screen,
  ScreenSection,
  DataTable,
  KvGrid,
  Checkbox,
} from '@helm/plugin-client'
import './styles.css'

interface Item {
  id: string
  title: string
  done: boolean
  createdAt: number
}

export function MainScreen(): ReactNode {
  const { callAction, notify } = usePluginContext()
  const doc = usePluginDoc<{ list: Item[] }>('items')
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)

  const list = doc?.list ?? []
  const doneCount = list.filter((it) => it.done).length

  const add = async () => {
    const title = draft.trim()
    if (title === '') return
    setPending(true)
    try {
      await callAction('add_item', { title })
      setDraft('')
    } catch (err) {
      notify('new increase failed:' + (err instanceof Error ? err.message : String(err)), 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <Screen title="item workbench" subtitle={'completed ' + doneCount + ' / ' + list.length}>
      <ScreenSection title="new increase item">
        <div className="app-form">
          <input
            className="app-input"
            value={draft}
            placeholder="input target subject after carriage return..."
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add()
            }}
          />
          <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void add()}>
            new increase
          </button>
        </div>
      </ScreenSection>

      <ScreenSection title="concept view">
        <KvGrid
          items={[
            { key: 'item total count', value: list.length },
            { key: 'completed', value: doneCount },
            { key: 'data source', value: "public doc 'items'(usePluginDoc real-time subscribe)" },
          ]}
        />
      </ScreenSection>

      <ScreenSection title="item list">
        <DataTable
          loading={doc === undefined}
          empty={list.length === 0}
          emptyLabel="temporary without item, input title new increase a"
          columns={2}
          label="item list"
        >
          <thead>
            <tr>
              <th>state</th>
              <th>content</th>
            </tr>
          </thead>
          <tbody>
            {list.map((it) => (
              <tr key={it.id}>
                <td className="app-col-check">
                  <Checkbox
                    checked={it.done}
                    onChange={(checked) => {
                      void callAction('set_done', { id: it.id, done: checked }).catch((err: unknown) =>
                        notify('update failed:' + (err instanceof Error ? err.message : String(err)), 'error'),
                      )
                    }}
                  />
                </td>
                <td className={it.done ? 'app-done' : ''}>{it.title}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </ScreenSection>
    </Screen>
  )
}
`

/** app template patch fill style: only layout micro tune, color one rule away host CSS variable. */
export const SCAFFOLD_CLIENT_APP_CSS = `.app-form { display: flex; gap: 8px; }
.app-input { flex: 1; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; color: var(--fg); }
.app-input:focus { outline: none; border-color: var(--accent); }
.app-col-check { width: 48px; }
.app-done { text-decoration: line-through; color: var(--fg-muted); }
`

export const SCAFFOLD_README = (template: ScaffoldTemplate) =>
  template === 'app'
    ? `# full-stack micro app (helm plugins init --template app generate)

- backend entry:\`index.ts\`(public doc 'items' + add_item/set_done double Schema action + ctx.ui.screen + sidebar entry)
- frontend component:\`client/index.tsx\`(clientRoot is ./client, only use @helm/plugin-client host original language)
- manifest:\`plugin.json\`; local type check:\`tsconfig.json\`(host runtime transpile independent of it, only supply edit/CI)

## development closed ring (no need to publish to host i.e. can verify)

\`\`\`bash
helm plugins doctor <this directory absolute path>   # four phase self inspect:manifest/backend/register/client
helm apps validate <this directory absolute path>   # doctor + full-stack should use Screen force check
helm apps publish <this directory absolute path>    # preflight via after managed install and enable, register app center
helm apps remove <pluginId>           # unload (local source code directory do not subject to affect)
\`\`\`

sidebar entry (ctx.ui.sidebarItem) can delete; after deletion should use still can from app center open.
`
    : `# external plugin (helm plugins init generate)

- backend entry:\`index.ts\`(export default PluginDefinition)${template === 'full' ? '\n- frontend component:\`client/index.tsx\`(clientRoot declaration is ./client)' : ''}
- manifest:\`plugin.json\`; local type check:\`tsconfig.json\`(host runtime transpile independent of it, only supply edit/CI)

## development closed ring

\`\`\`bash
helm plugins doctor <this directory absolute path>     # static self inspect (real load+real register+client compile)
helm plugins rescan                      # Hub incremental discover new directory (by default deactivate)
helm plugins enable <id>                 # enable
helm plugins reload <id>                 # modify code after subject to control hot reload (preflight failed old instance keep)
\`\`\`
`
