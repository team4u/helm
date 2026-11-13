# 全栈微应用最小可运行模板

直接参考本模板起步；替换 id、文案与数据结构即可。模板已通过 `apps_validate` 的全部检查点（含至少一个 screen）。更快路径：`helm plugins init <name> --template app` 生成的骨架与本模板同形（额外附带可删除的侧栏直达入口），仓库 `apps/todo-demo` 是同形种子样本。

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
{ "id": "sample-desk", "name": "示例工作台", "main": "index.ts", "clientRoot": "./client", "version": "0.1.0" }
```

## index.ts（后端）

```ts
import { randomUUID } from 'node:crypto'
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

    // 共享 outputSchema：动作统一返回 { ok: true }
    const okSchema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    } as const

    ctx.action<{ title: string }, { ok: boolean }>({
      id: 'add_item',
      description: '新增一条条目',
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
      outputSchema: okSchema, // 单点 Schema 契约：input/output 必须同时声明
      exposeAsTool: true,
      async handler(input) {
        items.update((current) => ({
          list: current.list.map((it) => (it.id === input.id ? { ...it, done: input.done } : it)),
        }))
        await items.flush()
        return { ok: true }
      },
    })

    // 全栈应用硬性要求：至少一个 screen；默认不注册 sidebarItem（应用经应用中心打开；
    // 需要侧栏直达可声明 ctx.ui.sidebarItem({ target: 'screen:sample-desk/main', ... })）
    ctx.ui.screen({
      id: 'main',
      label: '示例工作台',
      client: { module: 'index.tsx', export: 'MainScreen' },
    })
  },
} satisfies PluginDefinition
```

## client/index.tsx（前端：直接复用 `@helm/plugin-client` 布局与控件原语）

```tsx
import { useState, type ReactNode } from 'react'
import {
  usePluginContext,
  usePluginDoc,
  Screen,
  ScreenSection,
  DataTable,
  Checkbox,
} from '@helm/plugin-client'
import './styles.css'

interface Item { id: string; title: string; done: boolean; createdAt: number }

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
      notify('新增失败：' + (err instanceof Error ? err.message : String(err)), 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <Screen title="示例工作台" subtitle={'已完成 ' + doneCount + ' / ' + list.length}>
      <ScreenSection title="新增条目">
        <div className="sd-form">
          <input
            className="sd-input"
            value={draft}
            placeholder="输入待办事项后回车…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
          />
          <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void add()}>
            新增
          </button>
        </div>
      </ScreenSection>

      <ScreenSection title="条目列表">
        <DataTable loading={doc === undefined} empty={list.length === 0} emptyLabel="暂无条目" columns={2}>
          <thead>
            <tr>
              <th>状态</th>
              <th>内容</th>
            </tr>
          </thead>
          <tbody>
            {list.map((it) => (
              <tr key={it.id}>
                <td className="sd-col-check">
                  <Checkbox
                    checked={it.done}
                    onChange={(checked) => void callAction('set_done', { id: it.id, done: checked })}
                  />
                </td>
                <td className={it.done ? 'sd-done' : ''}>{it.title}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </ScreenSection>
    </Screen>
  )
}
```

## client/styles.css

```css
.sd-form { display: flex; gap: 8px; }
.sd-input { flex: 1; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; color: var(--fg); }
.sd-col-check { width: 48px; }
.sd-done { text-decoration: line-through; color: var(--fg-muted); }
```

## 检查点对照

- `index.ts`（及 `plugin.json`）显式声明 `clientRoot: './client'`（未声明时默认根为插件目录本身，会导致 `client/index.tsx` 找不到）；
- 后端 `ctx.doc('items', ..., { public: true })` + 写后 `flush()`；
- `ctx.action` 同时声明 `inputSchema` 与 `outputSchema`（单点 Schema 契约，缺失在 register 阶段被拒），`exposeAsTool: true`；
- 前端优先复用 `@helm/plugin-client` 的 `Screen / ScreenSection / DataTable / KvGrid` 布局原语与无障碍控件（`Checkbox` 用 `onChange(checked)`；通知用 `notify(message, tone)`），不引入未声明的裸 npm 包；
- `ctx.ui.screen({ id: 'main', client: { module: 'index.tsx', export: 'MainScreen' } })` 且前端确实导出 `MainScreen`；
- 未注册 sidebarItem（避免左栏膨胀；`helm plugins init --template app` 骨架附带的侧栏入口可按需删除）；无 Emoji；样式走宿主 CSS 变量。
