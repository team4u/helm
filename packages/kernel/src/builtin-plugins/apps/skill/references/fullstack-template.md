# 全栈微应用最小可运行模板

直接参考本模板起步；替换 id、文案与数据结构即可。模板已通过 `apps_validate` 的全部检查点（含至少一个 screen）。

## 目录

```
apps/sample-desk/
  plugin.json
  index.ts
  client/index.tsx
  client/styles.css
```

## plugin.json

```json
{ "id": "sample-desk", "main": "index.ts", "clientRoot": "./client", "version": "0.1.0" }
```

## index.ts（后端）

```ts
import type { PluginDefinition } from '@helm/protocol'

export default {
  id: 'sample-desk',
  name: '示例工作台',
  description: '最小全栈微应用模板：持久条目 + 增删 + 主视图。',
  version: '0.1.0',
  clientRoot: './client',
  definePlugin(ctx) {
    // 持久业务数据：public doc 供前端 usePluginDoc 实时订阅
    const items = ctx.doc<{ list: Array<{ id: string; title: string; done: boolean; createdAt: number }> }>(
      'items',
      { list: [] },
      { public: true },
    )

    ctx.action<{ title: string }, { ok: boolean }>({
      id: 'add_item',
      description: '新增一条条目',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string', minLength: 1 } },
        required: ['title'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
      exposeAsTool: true,
      async handler(input) {
        items.update((current) => ({
          list: [
            { id: `${Date.now()}`, title: input.title, done: false, createdAt: Date.now() },
            ...current.list,
          ],
        }))
        await items.flush() // 写操作后冲刷（诚实性：不谎报已持久化）
        return { ok: true }
      },
    })

    ctx.action<{ id: string; done: boolean }, { ok: boolean }>({
      id: 'set_done',
      description: '勾选/取消勾选条目',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, done: { type: 'boolean' } },
        required: ['id', 'done'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
      exposeAsTool: true,
      async handler(input) {
        items.update((current) => ({
          list: current.list.map((it) => (it.id === input.id ? { ...it, done: input.done } : it)),
        }))
        await items.flush()
        return { ok: true }
      },
    })

    // 全栈应用硬性要求：至少一个 screen；默认不注册 sidebarItem
    ctx.ui.screen({
      id: 'main',
      label: '示例工作台',
      client: { module: 'index.tsx', export: 'MainScreen' },
    })
  },
} satisfies PluginDefinition
```

## client/index.tsx（前端）

```tsx
import { useState, type ReactNode } from 'react'
import { usePluginContext, usePluginDoc, HelmIcon } from '@helm/plugin-client'
import './styles.css'

interface Item { id: string; title: string; done: boolean; createdAt: number }

export function MainScreen(): ReactNode {
  const { callAction, notify } = usePluginContext()
  const doc = usePluginDoc<{ list: Item[] }>('items')
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)

  const add = async () => {
    const title = draft.trim()
    if (!title) return
    setPending(true)
    try {
      await callAction('add_item', { title })
      setDraft('')
    } catch (err) {
      void notify({ level: 'error', title: '新增失败', body: String(err) })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="sd-wrap">
      <header className="sd-header">
        <HelmIcon name="list-checks" />
        <h2>示例工作台</h2>
        <span className="sd-count">{doc?.list.length ?? 0} 项</span>
      </header>
      <div className="sd-form">
        <input
          className="sd-input"
          value={draft}
          placeholder="新增条目…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
        />
        <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void add()}>
          新增
        </button>
      </div>
      <ul className="sd-list">
        {(doc?.list ?? []).map((it) => (
          <li key={it.id} className="sd-item">
            <input
              id={`sd-${it.id}`}
              type="checkbox"
              checked={it.done}
              onChange={() => void callAction('set_done', { id: it.id, done: !it.done })}
            />
            <label htmlFor={`sd-${it.id}`} className={it.done ? 'sd-done' : ''}>{it.title}</label>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

## client/styles.css

```css
.sd-wrap { display: flex; flex-direction: column; gap: 12px; padding: 16px; max-width: 640px; }
.sd-header { display: flex; align-items: center; gap: 8px; }
.sd-header h2 { font-size: 16px; margin: 0; }
.sd-count { color: var(--text-muted); font-size: 12px; }
.sd-form { display: flex; gap: 8px; }
.sd-input { flex: 1; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; }
.sd-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.sd-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-elevated); }
.sd-done { text-decoration: line-through; color: var(--text-muted); }
```

## 检查点对照

- `index.ts`（及 `plugin.json`）显式声明 `clientRoot: './client'`（未声明时默认根为插件目录本身，会导致 `client/index.tsx` 找不到）；
- 后端 `ctx.doc('items', ..., { public: true })` + 写后 `flush()`；
- `ctx.action` 带 inputSchema/outputSchema，`exposeAsTool: true`；
- `ctx.ui.screen({ id: 'main', client: { module: 'index.tsx', export: 'MainScreen' } })` 且前端确实导出 `MainScreen`；
- 未注册 sidebarItem；无 Emoji；样式走宿主 CSS 变量。
