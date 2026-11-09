import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { renderToString } from 'react-dom/server'
import * as ReactDOMClient from 'react-dom/client'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  ConfirmDialog,
} from '../src/ui/AlertDialog.js'

const e = React.createElement
const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url))

function getAllSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...getAllSourceFiles(fullPath))
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name.endsWith('.js'))) {
      files.push(fullPath)
    }
  }
  return files
}

test('静态扫描铁律：packages/web/src 下所有源码文件 0 处 window.confirm', { timeout: 60_000 }, () => {
  const files = getAllSourceFiles(SRC_DIR)
  assert.ok(files.length > 10, `扫描到的源码文件数量应大于 10，实际为 ${files.length}`)

  const violations: Array<{ file: string; line: number; text: string }> = []

  for (const file of files) {
    const content = readFileSync(file, 'utf8')
    const lines = content.split('\n')
    lines.forEach((lineText, idx) => {
      if (lineText.includes('window.confirm')) {
        violations.push({
          file: file.replace(SRC_DIR, 'src'),
          line: idx + 1,
          text: lineText.trim(),
        })
      }
    })
  }

  assert.deepEqual(
    violations,
    [],
    `全仓 packages/web/src 必须彻底淘汰原生 window.confirm，发现违规点：\n${violations.map((v) => `  - ${v.file}:${v.line} -> ${v.text}`).join('\n')}`,
  )
})

test('ConfirmDialog SSR (renderToString)：inline={true} 或纯 Node 环境自动内联降级，渲染 role="alertdialog" 与 Quiet Surface 样式', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(ConfirmDialog, {
      open: true,
      inline: true,
      onOpenChange: () => {},
      title: '删除已存密钥？',
      description: '环境变量中的凭据不会被删除。',
      confirmText: '删除密钥',
      cancelText: '取消',
      danger: true,
      onConfirm: () => {},
    }),
  )

  assert.ok(html.length > 0, 'SSR 渲染结果不得为空串')
  assert.ok(html.includes('role="alertdialog"'), '必须具备 role="alertdialog" 无障碍语义')
  assert.ok(html.includes('class="modal-backdrop"'), '必须包含 .modal-backdrop 遮罩')
  assert.ok(html.includes('class="modal"'), '必须包含 .modal 弹窗容器')
  assert.ok(html.includes('max-width:440px') || html.includes('max-width: 440px'), '必须包含 max-width: 440px 约束')
  assert.ok(html.includes('删除已存密钥？'), '必须直出标题文案')
  assert.ok(html.includes('环境变量中的凭据不会被删除。'), '必须直出描述文案')
  assert.ok(html.includes('btn-danger'), 'danger=true 时确认按钮具备 .btn-danger 样式')
  assert.ok(html.includes('btn-ghost'), '取消按钮具备 .btn-ghost 样式')
  assert.ok(html.includes('删除密钥'), '确认按钮文案正确')
  assert.ok(html.includes('取消'), '取消按钮文案正确')
})

test('ConfirmDialog DOM 结构与无障碍契约：role="alertdialog"、标题与描述关联、按钮样式', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  await act(async () => {
    root.render(
      e(ConfirmDialog, {
        open: true,
        inline: true,
        onOpenChange: () => {},
        title: '重置会话上下文？',
        description: '历史消息保留，模型将从全新上下文开始。',
        confirmText: '重置上下文',
        cancelText: '放弃操作',
        danger: false,
        onConfirm: () => {},
      }),
    )
  })

  const alertContent = document.querySelector('[role="alertdialog"]')
  assert.ok(alertContent, '必须挂载 role="alertdialog" 容器')
  assert.equal(alertContent.getAttribute('data-state'), 'open')

  // 标题与描述
  const titleEl = alertContent.querySelector('.modal-title')
  assert.ok(titleEl, '必须包含 .modal-title')
  assert.equal(titleEl.textContent, '重置会话上下文？')

  const descEl = alertContent.querySelector('.modal-body')
  assert.ok(descEl, '必须包含描述容器')
  assert.equal(descEl.textContent, '历史消息保留，模型将从全新上下文开始。')

  // 按钮与文案
  const buttons = Array.from(alertContent.querySelectorAll('button'))
  assert.equal(buttons.length, 2, '包含确认与取消两个按钮')

  const cancelBtn = buttons.find((b) => b.textContent === '放弃操作')
  assert.ok(cancelBtn, '取消按钮文案为放弃操作')
  assert.ok(cancelBtn.classList.contains('btn-ghost'), '取消按钮具备 btn-ghost')

  const confirmBtn = buttons.find((b) => b.textContent === '重置上下文')
  assert.ok(confirmBtn, '确认按钮文案为重置上下文')
  assert.ok(confirmBtn.classList.contains('btn-primary'), 'danger=false 时确认按钮具备 btn-primary')

  await act(async () => {
    root.unmount()
  })
  container.remove()
})

test('ConfirmDialog 交互：点击确认按钮触发 onConfirm 回调与 onOpenChange(false)', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  let confirmed = false
  let cancelled = false
  let openState = true

  await act(async () => {
    root.render(
      e(ConfirmDialog, {
        open: openState,
        inline: true,
        onOpenChange: (open) => {
          openState = open
        },
        title: '确认删除？',
        description: '此操作无法撤销。',
        confirmText: '确认删除',
        danger: true,
        onConfirm: () => {
          confirmed = true
        },
        onCancel: () => {
          cancelled = true
        },
      }),
    )
  })

  const alertContent = document.querySelector('[role="alertdialog"]')
  assert.ok(alertContent)

  const confirmBtn = Array.from(alertContent.querySelectorAll('button')).find((b) => b.textContent === '确认删除')
  assert.ok(confirmBtn, '找到确认按钮')

  await act(async () => {
    confirmBtn.click()
  })

  assert.equal(confirmed, true, '必须触发 onConfirm')
  assert.equal(cancelled, false, '不可触发 onCancel')
  assert.equal(openState, false, '必须触发 onOpenChange(false)')

  await act(async () => {
    root.unmount()
  })
  container.remove()
})

test('ConfirmDialog 交互：点击取消按钮触发 onCancel 回调与 onOpenChange(false)', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  let confirmed = false
  let cancelled = false
  let openState = true

  await act(async () => {
    root.render(
      e(ConfirmDialog, {
        open: openState,
        inline: true,
        onOpenChange: (open) => {
          openState = open
        },
        title: '确认放弃？',
        cancelText: '暂不放弃',
        onConfirm: () => {
          confirmed = true
        },
        onCancel: () => {
          cancelled = true
        },
      }),
    )
  })

  const alertContent = document.querySelector('[role="alertdialog"]')
  assert.ok(alertContent)

  const cancelBtn = Array.from(alertContent.querySelectorAll('button')).find((b) => b.textContent === '暂不放弃')
  assert.ok(cancelBtn, '找到取消按钮')

  await act(async () => {
    cancelBtn.click()
  })

  assert.equal(confirmed, false, '不可触发 onConfirm')
  assert.equal(cancelled, true, '必须触发 onCancel')
  assert.equal(openState, false, '必须触发 onOpenChange(false)')

  await act(async () => {
    root.unmount()
  })
  container.remove()
})

test('ConfirmDialog 交互：Esc 键盘响应触发 onCancel 回调与 onOpenChange(false)', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  let confirmed = false
  let cancelled = false
  let openState = true

  await act(async () => {
    root.render(
      e(ConfirmDialog, {
        open: openState,
        inline: true,
        onOpenChange: (open) => {
          openState = open
        },
        title: '未保存修改确认',
        description: '确定放弃吗？',
        onConfirm: () => {
          confirmed = true
        },
        onCancel: () => {
          cancelled = true
        },
      }),
    )
  })

  const alertContent = document.querySelector('[role="alertdialog"]')
  assert.ok(alertContent)

  await act(async () => {
    alertContent.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })

  assert.equal(confirmed, false, 'Esc 不得触发 onConfirm')
  assert.equal(cancelled, true, 'Esc 必须触发 onCancel')
  assert.equal(openState, false, 'Esc 必须触发 onOpenChange(false)')

  await act(async () => {
    root.unmount()
  })
  container.remove()
})

test('AlertDialog 原语与复合属性在 SSR 下行为一致', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(
      AlertDialog,
      { open: true, inline: true },
      e(
        AlertDialog.Portal,
        null,
        e(
          AlertDialog.Overlay,
          { className: 'modal-backdrop' },
          e(
            AlertDialog.Content,
            { className: 'modal' },
            e(AlertDialog.Title, { className: 'modal-title' }, '底层原语标题'),
            e(AlertDialog.Description, null, '底层原语描述'),
            e(AlertDialog.Cancel, { asChild: true }, e('button', null, '取消')),
            e(AlertDialog.Action, { asChild: true }, e('button', null, '确认')),
          ),
        ),
      ),
    ),
  )

  assert.ok(html.includes('role="alertdialog"'))
  assert.ok(html.includes('modal-backdrop'))
  assert.ok(html.includes('modal'))
  assert.ok(html.includes('底层原语标题'))
  assert.ok(html.includes('底层原语描述'))
  assert.ok(html.includes('取消'))
  assert.ok(html.includes('确认'))
})
