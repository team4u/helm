import { randomUUID } from 'node:crypto'
import type { PluginDefinition } from '@helm/protocol'

interface TodoItem {
  id: string
  title: string
  done: boolean
  createdAt: number
}

interface TodoState {
  list: TodoItem[]
}

export default {
  id: 'todo-demo',
  name: 'TODO 示例',
  description: '最小 TODO 全栈微应用：新增、勾选完成、删除，数据持久化。',
  version: '0.1.0',
  clientRoot: './client',
  definePlugin(ctx) {
    // 共享 outputSchema：四个动作统一返回 { ok: true }
    const okSchema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    } as const

    // 持久业务数据：public doc 供前端 usePluginDoc 实时订阅
    const todos = ctx.doc<TodoState>('todos', { list: [] }, { public: true })

    ctx.action<{ title: string }, { ok: boolean }>({
      id: 'add_todo',
      description: '新增一条待办',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string', minLength: 1 } },
        required: ['title'],
        additionalProperties: false,
      },
      outputSchema: okSchema,
      exposeAsTool: true,
      async handler(input) {
        const now = Date.now()
        todos.update((current) => ({
          list: [
            { id: randomUUID(), title: input.title, done: false, createdAt: now },
            ...current.list,
          ],
        }))
        await todos.flush()
        return { ok: true }
      },
    })

    ctx.action<{ id: string; done: boolean }, { ok: boolean }>({
      id: 'set_done',
      description: '勾选/取消勾选待办',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, done: { type: 'boolean' } },
        required: ['id', 'done'],
        additionalProperties: false,
      },
      outputSchema: okSchema,
      exposeAsTool: true,
      async handler(input) {
        todos.update((current) => ({
          list: current.list.map((it) => (it.id === input.id ? { ...it, done: input.done } : it)),
        }))
        await todos.flush()
        return { ok: true }
      },
    })

    ctx.action<{ id: string; title: string }, { ok: boolean }>({
      id: 'update_todo',
      description: '编辑待办标题',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, title: { type: 'string', minLength: 1 } },
        required: ['id', 'title'],
        additionalProperties: false,
      },
      outputSchema: okSchema,
      exposeAsTool: true,
      async handler(input) {
        todos.update((current) => ({
          list: current.list.map((it) =>
            it.id === input.id ? { ...it, title: input.title } : it,
          ),
        }))
        await todos.flush()
        return { ok: true }
      },
    })

    ctx.action<{ id: string }, { ok: boolean }>({
      id: 'remove_todo',
      description: '删除一条待办',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      outputSchema: okSchema,
      exposeAsTool: true,
      async handler(input) {
        todos.update((current) => ({
          list: current.list.filter((it) => it.id !== input.id),
        }))
        await todos.flush()
        return { ok: true }
      },
    })

    // 全栈应用硬性要求：至少一个 screen；默认不注册 sidebarItem
    ctx.ui.screen({
      id: 'main',
      label: 'TODO 示例',
      client: { module: 'index.tsx', export: 'MainScreen' },
    })
  },
} satisfies PluginDefinition
