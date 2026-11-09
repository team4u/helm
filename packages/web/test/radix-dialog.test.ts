import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import { test } from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { renderToString } from 'react-dom/server'
import * as ReactDOMClient from 'react-dom/client'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from '../src/ui/Dialog.js'

const e = React.createElement

test('Dialog inline 参数：显式强制内联渲染与自定义类名继承', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(
      Dialog,
      { open: true, inline: true },
      e(
        DialogPortal,
        null,
        e(
          DialogOverlay,
          { className: 'modal-backdrop modal-fullscreen-backdrop' },
          e(
            DialogContent,
            { className: 'modal modal-fullscreen' },
            e(
              DialogTitle,
              { asChild: true },
              e('h1', { className: 'modal-title custom-title' }, '全屏标题'),
            ),
          ),
        ),
      ),
    ),
  )

  assert.ok(html.includes('class="modal-backdrop modal-fullscreen-backdrop"'))
  assert.ok(html.includes('class="modal modal-fullscreen"'))
  assert.ok(html.includes('全屏标题'))
})

test('Dialog DOM 交互契约：role="dialog"、无障碍关联与 onOpenChange 触发全链路', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  let lastOpenState = true
  const openChanges: boolean[] = []

  function TestApp({ open }: { open: boolean }) {
    return e(
      Dialog,
      {
        open,
        inline: true,
        onOpenChange: (v: boolean) => {
          lastOpenState = v
          openChanges.push(v)
        },
      },
      e(
        DialogPortal,
        null,
        e(
          DialogOverlay,
          { className: 'modal-backdrop', id: 'test-overlay' },
          e(
            DialogContent,
            { className: 'modal', id: 'test-content' },
            e(
              'div',
              { className: 'modal-header' },
              e(DialogTitle, { id: 'test-title' }, '计算节点管理'),
              e(
                DialogClose,
                { asChild: true },
                e('button', { type: 'button', id: 'test-close-btn', 'aria-label': '关闭' }, '关闭'),
              ),
            ),
            e(DialogDescription, { id: 'test-description' }, '管理已连接的计算节点与配置'),
            e(
              'div',
              { className: 'modal-body' },
              e('button', { type: 'button', id: 'test-inner-btn' }, '内部操作按钮'),
            ),
          ),
        ),
      ),
    )
  }

  // 首次渲染打开
  await act(async () => {
    root.render(e(TestApp, { open: true }))
  })

  const content = document.getElementById('test-content')
  assert.ok(content, 'DialogContent 必须挂载入 DOM')
  assert.equal(content.getAttribute('role'), 'dialog', '必须具备 role="dialog"')
  assert.equal(content.getAttribute('data-state'), 'open', '必须展示 open 状态')

  const title = document.getElementById('test-title')
  assert.ok(title, 'DialogTitle 必须存在')

  const desc = document.getElementById('test-description')
  assert.ok(desc, 'DialogDescription 必须存在')

  // 验证点击内部按钮不触发关闭
  const innerBtn = document.getElementById('test-inner-btn')
  assert.ok(innerBtn, '内部按钮必须存在')
  await act(async () => {
    innerBtn.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  })
  assert.equal(lastOpenState, true, '内部按钮交互不触发 onOpenChange(false)')

  // 验证点击关闭按钮触发 onOpenChange(false)
  const closeBtn = document.getElementById('test-close-btn')
  assert.ok(closeBtn, '关闭按钮必须存在')
  await act(async () => {
    closeBtn.click()
  })
  assert.equal(lastOpenState, false, '点击 DialogClose 必须触发 onOpenChange(false)')
  assert.ok(openChanges.includes(false), '事件流必须包含 false 记录')

  // 重新渲染为打开状态，验证 Escape 监听
  lastOpenState = true
  await act(async () => {
    root.render(e(TestApp, { open: true }))
  })

  const reopenedContent = document.getElementById('test-content')
  assert.ok(reopenedContent, '重开后 DialogContent 存在')
  await act(async () => {
    reopenedContent.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  assert.equal(lastOpenState, false, '按下 Escape 键必须触发 onOpenChange(false)')

  // 重新渲染为打开状态，验证遮罩点击关闭
  lastOpenState = true
  await act(async () => {
    root.render(e(TestApp, { open: true }))
  })

  const overlay = document.getElementById('test-overlay')
  assert.ok(overlay, '遮罩必须存在')
  await act(async () => {
    overlay.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  })
  assert.equal(lastOpenState, false, '点击遮罩外部区域必须触发 onOpenChange(false)')

  // 卸载与清理
  await act(async () => {
    root.unmount()
  })
  assert.equal(document.getElementById('test-content'), null, '卸载后 DialogContent 已从 DOM 中销毁')
  container.remove()
})

test('Dialog open=false 初始状态不渲染内容', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  await act(async () => {
    root.render(
      e(
        Dialog,
        { open: false, inline: true },
        e(
          DialogPortal,
          null,
          e(
            DialogContent,
            { id: 'should-not-exist' },
            e(DialogTitle, null, '不应渲染'),
          ),
        ),
      ),
    )
  })

  assert.equal(document.getElementById('should-not-exist'), null, '初始 open=false 时 DOM 中不得存在 DialogContent')

  await act(async () => {
    root.unmount()
  })
  container.remove()
})
