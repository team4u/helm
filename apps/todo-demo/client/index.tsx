import { useState, type ReactNode } from 'react'
import { usePluginContext, usePluginDoc, HelmIcon, Checkbox } from '@helm/plugin-client'
import './styles.css'

interface TodoItem {
  id: string
  title: string
  done: boolean
  createdAt: number
}

export function MainScreen(): ReactNode {
  const { callAction, notify } = usePluginContext()
  const doc = usePluginDoc<{ list: TodoItem[] }>('todos')
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')

  const list = doc?.list ?? []

  const add = async () => {
    const title = draft.trim()
    if (!title) return
    setPending(true)
    try {
      await callAction('add_todo', { title })
      setDraft('')
    } catch (err) {
      notify('新增失败：' + (err instanceof Error ? err.message : String(err)), 'error')
    } finally {
      setPending(false)
    }
  }

  const startEdit = (it: TodoItem) => {
    setEditingId(it.id)
    setEditDraft(it.title)
  }

  const saveEdit = async () => {
    if (editingId == null) return
    const title = editDraft.trim()
    if (!title) return
    const id = editingId
    setEditingId(null)
    try {
      await callAction('update_todo', { id, title })
    } catch (err) {
      notify('保存失败：' + (err instanceof Error ? err.message : String(err)), 'error')
    }
  }

  const remove = async (id: string) => {
    try {
      await callAction('remove_todo', { id })
    } catch (err) {
      notify('删除失败：' + (err instanceof Error ? err.message : String(err)), 'error')
    }
  }

  return (
    <div className="td-wrap">
      <header className="td-header">
        <HelmIcon name="list-checks" />
        <h2>TODO 示例</h2>
        <span className="td-count">
          {list.filter((it) => it.done).length} / {list.length} 完成
        </span>
      </header>

      <div className="td-form">
        <input
          className="td-input"
          value={draft}
          placeholder="想做什么？"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
        />
        <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void add()}>
          新增
        </button>
      </div>

      {list.length === 0 ? (
        <p className="td-empty">还没有待办，输入一条试试</p>
      ) : (
        <ul className="td-list">
          {list.map((it) => (
            <li key={it.id} className="td-item">
              <Checkbox
                id={`td-${it.id}`}
                checked={it.done}
                onChange={() => {
                  void callAction('set_done', { id: it.id, done: !it.done }).catch((err: unknown) =>
                    notify('更新失败：' + (err instanceof Error ? err.message : String(err)), 'error'),
                  )
                }}
              />
              {editingId === it.id ? (
                <input
                  className="td-input td-edit"
                  value={editDraft}
                  autoFocus
                  onChange={(e) => setEditDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveEdit()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  onBlur={() => void saveEdit()}
                />
              ) : (
                <label
                  htmlFor={`td-${it.id}`}
                  className={it.done ? 'td-done' : ''}
                  onDoubleClick={() => startEdit(it)}
                >
                  {it.title}
                </label>
              )}
              <button
                type="button"
                className="td-remove"
                title={editingId === it.id ? '保存（回车）' : '编辑'}
                onClick={() => {
                  if (editingId === it.id) void saveEdit()
                  else startEdit(it)
                }}
              >
                <HelmIcon name={editingId === it.id ? 'check' : 'pencil'} size={14} />
              </button>
              <button
                type="button"
                className="td-remove"
                title="删除"
                onClick={() => void remove(it.id)}
              >
                <HelmIcon name="x" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
