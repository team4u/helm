/**
 * builtin:tasks 客户端占位出口（Slice 2 仅保证构建通过；完整看板 UI 由 Slice 3 实现）。
 *
 * Fast Refresh 铁律：本文件只导出组件与 TS 类型；纯函数/常量随后续实装剥离至
 * models.ts / copy.ts。占位实现读公开投影 doc `board` 渲染最小只读列表，
 * 不伪造任何状态。
 */
import React from 'react'
import { usePluginDoc } from '@helmx/plugin-client'

interface PlaceholderTask {
  id: string
  title: string
  column: string
}

interface PlaceholderBoardDoc {
  tasks: PlaceholderTask[]
  updatedAt: number
}

export function TaskBoardScreen(): React.ReactElement {
  const board = usePluginDoc<PlaceholderBoardDoc>('board')
  const tasks = board?.tasks ?? []
  if (tasks.length === 0) {
    return <div className="tasks-board-placeholder">No tasks yet.</div>
  }
  return (
    <div className="tasks-board-placeholder">
      <ul>
        {tasks.map((task) => (
          <li key={task.id}>
            {task.id} [{task.column}] {task.title}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function TaskToolView(): React.ReactElement | null {
  return null
}
