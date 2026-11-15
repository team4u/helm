/**
 * plugins init 脚手架模板（纯数据模块）：minimal 仅后端 / full 通用插件面板 /
 * app 全栈微应用（产物直接过 helm apps validate 预检）三档的全部文件内容模板。
 * 与命令逻辑解耦：本模块只负责「给定插件名产出文件文本」，不做任何 IO 与校验。
 */

export type ScaffoldTemplate = 'minimal' | 'full' | 'app'

export const SCAFFOLD_TEMPLATES: readonly ScaffoldTemplate[] = ['minimal', 'full', 'app']

export const SCAFFOLD_PLUGIN_JSON = (id: string, template: ScaffoldTemplate) => `${JSON.stringify(
  {
    id,
    name: template === 'app' ? `${id} 应用` : `${id} 插件`,
    version: '0.1.0',
    main: 'index.ts',
    ...(template === 'app' || template === 'full' ? { clientRoot: './client' } : {}),
  },
  null,
  2,
)}\n`

/** 插件本地 tsconfig：与宿主后端转译器习惯对齐（.js 说明符映射、ESM）。 */
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
 * 外部插件后端入口（id: ${id}）：export default PluginDefinition。
 * 修改后可用 helm plugins reload ${id} 受控热重载（预检失败时旧实例保持可用）。
 */
import type { PluginDefinition } from '@helm/protocol'

export default {
  id: '${id}',
  version: '0.1.0',
  description: '外部插件（helm plugins init --template minimal 生成）',
  definePlugin(ctx) {
    ctx.action({
      id: 'ping',
      description: '连通性探针',
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
 * 外部插件后端入口（id: ${id}）：export default PluginDefinition。
 * 修改后可用 helm plugins reload ${id} 受控热重载（预检失败时旧实例保持可用）。
 */
import type { PluginDefinition } from '@helm/protocol'

export default {
  id: '${id}',
  version: '0.1.0',
  description: '示例外部插件（helm plugins init 生成）',
  clientRoot: './client',
  definePlugin(ctx) {
    const state = ctx.doc('state', { count: 0 }, { public: true })
    ctx.action({
      id: 'increment',
      description: '计数加一',
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
      label: '示例面板',
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
    <ScreenSection title="示例面板">
      {loading ? (
        <div className="loading-state" role="status">计数读取中…</div>
      ) : (
        <KvGrid
          items={[
            { key: '当前计数', value: state.count },
            { key: '更新方式', value: '调用 increment 动作更新计数' },
          ]}
        />
      )}
      <DataTable columns={1} empty={!loading && state !== undefined && state.count === 0} emptyLabel="计数为零">
        <thead>
          <tr>
            <th>计数记录</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>count = {state === undefined ? '—' : state.count}</td>
          </tr>
        </tbody>
      </DataTable>
    </ScreenSection>
  )
}
`

/**
 * app 模板后端：public doc 持久条目 + 两个双 Schema 动作 + screen 主视图 + 侧栏直达入口。
 * 与 app-builder 技能 fullstack-template.md 保持同一形状；
 * 写后 flush（诚实性：不谎报已持久化）；无 Emoji；动作同时声明 input/outputSchema
 * （单点 Schema 契约，缺失会在 doctor register 阶段被拒）。
 */
export const SCAFFOLD_INDEX_TS_APP = (id: string, label: string) => `/**
 * 全栈微应用后端入口（id: ${id}）：export default PluginDefinition。
 * 修改后用 helm apps validate 复检，再 helm apps publish 热更新发布。
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
  description: '最小全栈微应用：持久条目 + 新增/勾选动作 + 主视图。',
  version: '0.1.0',
  clientRoot: './client',
  definePlugin(ctx) {
    // 持久业务数据：public doc 供前端 usePluginDoc 实时订阅
    const items = ctx.doc<{ list: Item[] }>('items', { list: [] }, { public: true })

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
        await items.flush()
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

    // 全栈应用硬性要求：至少一个 ctx.ui.screen（apps validate 的 missing_app_screen 检查项）
    ctx.ui.screen({
      id: 'main',
      label: '${label}',
      client: { module: 'index.tsx', export: 'MainScreen' },
    })

    // 侧栏直达入口（协议允许 screen:<pluginId>/<screenId> 目标；不需要可直接删除本段，
    // 应用仍可从应用中心打开）
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
 * app 模板前端：仅用 @helm/plugin-client 宿主原语（Screen/ScreenSection/KvGrid/
 * DataTable/Checkbox）+ 宿主 CSS 变量与 .btn 按钮；无 Emoji；13px 正文。
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
      notify('新增失败：' + (err instanceof Error ? err.message : String(err)), 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <Screen title="条目工作台" subtitle={'已完成 ' + doneCount + ' / ' + list.length}>
      <ScreenSection title="新增条目">
        <div className="app-form">
          <input
            className="app-input"
            value={draft}
            placeholder="输入条目标题后回车…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add()
            }}
          />
          <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void add()}>
            新增
          </button>
        </div>
      </ScreenSection>

      <ScreenSection title="概览">
        <KvGrid
          items={[
            { key: '条目总数', value: list.length },
            { key: '已完成', value: doneCount },
            { key: '数据来源', value: "public doc 'items'（usePluginDoc 实时订阅）" },
          ]}
        />
      </ScreenSection>

      <ScreenSection title="条目列表">
        <DataTable
          loading={doc === undefined}
          empty={list.length === 0}
          emptyLabel="暂无条目，输入标题新增第一条"
          columns={2}
          label="条目列表"
        >
          <thead>
            <tr>
              <th>状态</th>
              <th>内容</th>
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
                        notify('更新失败：' + (err instanceof Error ? err.message : String(err)), 'error'),
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

/** app 模板补充样式：仅布局微调，颜色一律走宿主 CSS 变量。 */
export const SCAFFOLD_CLIENT_APP_CSS = `.app-form { display: flex; gap: 8px; }
.app-input { flex: 1; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; color: var(--fg); }
.app-input:focus { outline: none; border-color: var(--accent); }
.app-col-check { width: 48px; }
.app-done { text-decoration: line-through; color: var(--fg-muted); }
`

export const SCAFFOLD_README = (template: ScaffoldTemplate) =>
  template === 'app'
    ? `# 全栈微应用（helm plugins init --template app 生成）

- 后端入口：\`index.ts\`（public doc 'items' + add_item/set_done 双 Schema 动作 + ctx.ui.screen + 侧栏入口）
- 前端组件：\`client/index.tsx\`（clientRoot 为 ./client，仅用 @helm/plugin-client 宿主原语）
- 清单：\`plugin.json\`；本地类型检查：\`tsconfig.json\`（宿主运行时转译不依赖它，仅供编辑器/CI）

## 开发闭环（无需发布到宿主即可验证）

\`\`\`bash
helm plugins doctor <本目录绝对路径>   # 四阶段自检：manifest/backend/register/client
helm apps validate <本目录绝对路径>   # doctor + 全栈应用 Screen 强制检查
helm apps publish <本目录绝对路径>    # 预检通过后受管安装并启用，登记应用中心
helm apps remove <pluginId>           # 卸载（本地源码目录不受影响）
\`\`\`

侧栏入口（ctx.ui.sidebarItem）可删；删除后应用仍可从应用中心打开。
`
    : `# 外部插件（helm plugins init 生成）

- 后端入口：\`index.ts\`（export default PluginDefinition）${template === 'full' ? '\n- 前端组件：\`client/index.tsx\`（clientRoot 声明为 ./client）' : ''}
- 清单：\`plugin.json\`；本地类型检查：\`tsconfig.json\`（宿主运行时转译不依赖它，仅供编辑器/CI）

## 开发闭环

\`\`\`bash
helm plugins doctor <本目录绝对路径>     # 静态自检（真实加载+真实注册+client 编译）
helm plugins rescan                      # Hub 增量发现新目录（默认停用）
helm plugins enable <id>                 # 启用
helm plugins reload <id>                 # 修改代码后受控热重载（预检失败旧实例保持）
\`\`\`
`
