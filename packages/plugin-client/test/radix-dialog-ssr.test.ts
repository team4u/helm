import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToString } from 'react-dom/server'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '../src/ui/Dialog.js'

const e = React.createElement

test('Dialog SSR (renderToString)：纯 Node 环境下 DialogPortal 自动降级内联，不返回空字符串', { timeout: 60_000 }, () => {
  assert.equal(typeof window, 'undefined', '测试初始运行于纯 Node / SSR 环境')

  const html = renderToString(
    e(
      Dialog,
      { open: true },
      e(
        DialogPortal,
        null,
        e(
          DialogOverlay,
          { className: 'modal-backdrop' },
          e(
            DialogContent,
            { className: 'modal', 'aria-label': 'SSR 对话框' },
            e(
              'div',
              { className: 'modal-header' },
              e(DialogTitle, { className: 'modal-title' }, '标题文案'),
              e(
                DialogClose,
                { asChild: true },
                e('button', { type: 'button', className: 'btn btn-ghost btn-sm', 'aria-label': '关闭' }, '关闭'),
              ),
            ),
            e(DialogDescription, { className: 'modal-desc' }, '这是一段对话框详细描述文案'),
            e('div', { className: 'modal-body' }, e('p', null, '主体内容')),
          ),
        ),
      ),
    ),
  )

  // 验证不为空字符串
  assert.ok(html.length > 0, 'SSR 渲染结果不得为空串')
  // 验证基础类名与属性
  assert.ok(html.includes('class="modal-backdrop"'), '必须包含 .modal-backdrop 遮罩类名')
  assert.ok(html.includes('class="modal"'), '必须包含 .modal 弹窗类名')
  assert.ok(html.includes('role="dialog"'), '必须包含 role="dialog" 无障碍语义')
  assert.ok(html.includes('data-state="open"'), '必须包含 data-state="open" 状态标记')
  assert.ok(html.includes('标题文案'), '必须正确直出标题文本')
  assert.ok(html.includes('这是一段对话框详细描述文案'), '必须正确直出描述文本')
  assert.ok(html.includes('主体内容'), '必须正确直出主体内容')
})

test('Dialog 复合属性（Dialog.Portal, Dialog.Content 等）风格在 SSR 下行为一致', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(
      Dialog,
      { open: true },
      e(
        Dialog.Portal,
        null,
        e(
          Dialog.Overlay,
          { className: 'modal-backdrop' },
          e(
            Dialog.Content,
            { className: 'modal modal-lg' },
            e(Dialog.Title, { className: 'modal-title' }, '复合标题'),
            e(Dialog.Description, null, '复合描述'),
          ),
        ),
      ),
    ),
  )

  assert.ok(html.includes('class="modal modal-lg"'), '必须支持复合类名')
  assert.ok(html.includes('role="dialog"'))
  assert.ok(html.includes('复合标题'))
  assert.ok(html.includes('复合描述'))
})
