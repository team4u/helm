import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToString } from 'react-dom/server'

;(globalThis as Record<string, unknown>).React = React
const { Switch } = await import('@helm/plugin-client')
const { Checkbox } = await import('@helm/plugin-client')

const e = React.createElement

// ---------------------------------------------------------------------------
// 1. Switch 组件 SSR 渲染与无障碍契约
// ---------------------------------------------------------------------------

test('Switch：基础状态、受控 checked、WAI-ARIA 属性与零 Emoji', { timeout: 60_000 }, () => {
  // 未激活状态
  const offHtml = renderToString(
    e(Switch, {
      checked: false,
      onChange: () => {},
      label: '网关状态',
      id: 'gateway-switch',
    }),
  )

  assert.match(offHtml, /class="helm-switch-wrap"/)
  assert.match(offHtml, /role="switch"/)
  assert.match(offHtml, /aria-checked="false"/)
  assert.match(offHtml, /id="gateway-switch"/)
  assert.match(offHtml, /class="helm-switch"/)
  assert.match(offHtml, /class="helm-switch-thumb"/)
  assert.match(offHtml, /class="helm-switch-label">网关状态<\/span>/)
  assert.doesNotMatch(offHtml, /is-checked/)
  // 零 Emoji 保证
  assert.doesNotMatch(offHtml, /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/u)

  // 激活状态
  const onHtml = renderToString(
    e(Switch, {
      checked: true,
      onChange: () => {},
      label: '已开启',
    }),
  )

  assert.match(onHtml, /aria-checked="true"/)
  assert.match(onHtml, /is-checked/)

  // 禁用态
  const disabledHtml = renderToString(
    e(Switch, {
      checked: true,
      disabled: true,
      onChange: () => {},
      label: '只读开关',
    }),
  )

  assert.match(disabledHtml, /class="helm-switch-wrap is-disabled"/)
  assert.match(disabledHtml, /disabled=""/)

  // 无 label 模式直接渲染 switchButton 容器
  const noLabelHtml = renderToString(
    e(Switch, {
      checked: false,
      onChange: () => {},
      'aria-label': '静默开关',
    }),
  )
  assert.match(noLabelHtml, /<span class="helm-switch-wrap">/)
  assert.match(noLabelHtml, /aria-label="静默开关"/)
  assert.doesNotMatch(noLabelHtml, /helm-switch-label/)
})

// ---------------------------------------------------------------------------
// 3. Checkbox 组件 SSR 渲染与半选状态契约
// ---------------------------------------------------------------------------

test('Checkbox：未选、勾选、半选（indeterminate）、无障碍与零 Emoji', { timeout: 60_000 }, () => {
  // 未勾选状态
  const uncheckedHtml = renderToString(
    e(Checkbox, {
      checked: false,
      onChange: () => {},
      label: '多选条目',
      id: 'item-chk',
    }),
  )

  assert.match(uncheckedHtml, /class="helm-checkbox-wrap"/)
  assert.match(uncheckedHtml, /role="checkbox"/)
  assert.match(uncheckedHtml, /aria-checked="false"/)
  assert.match(uncheckedHtml, /id="item-chk"/)
  assert.match(uncheckedHtml, /class="helm-checkbox"/)
  assert.match(uncheckedHtml, /class="helm-checkbox-label">多选条目<\/span>/)
  assert.doesNotMatch(uncheckedHtml, /is-checked/)
  assert.doesNotMatch(uncheckedHtml, /is-indeterminate/)
  assert.doesNotMatch(uncheckedHtml, /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/u)

  // 勾选状态：显示精细 check 图标
  const checkedHtml = renderToString(
    e(Checkbox, {
      checked: true,
      onChange: () => {},
      label: '强制重装/重试',
    }),
  )

  assert.match(checkedHtml, /aria-checked="true"/)
  assert.match(checkedHtml, /is-checked/)
  assert.match(checkedHtml, /<svg/) // lucide check 图标

  // 半选（indeterminate）状态：显示 minus 图标，aria-checked="mixed"
  const indHtml = renderToString(
    e(Checkbox, {
      checked: false,
      indeterminate: true,
      onChange: () => {},
      label: 'Select all（部分选中）',
    }),
  )

  assert.match(indHtml, /aria-checked="mixed"/)
  assert.match(indHtml, /is-indeterminate/)
  assert.match(indHtml, /<svg/) // lucide minus 图标

  // 禁用态
  const disabledHtml = renderToString(
    e(Checkbox, {
      checked: true,
      disabled: true,
      onChange: () => {},
      label: '受保护',
    }),
  )

  assert.match(disabledHtml, /class="helm-checkbox-wrap is-disabled"/)
  assert.match(disabledHtml, /disabled=""/)

  // 无 label 模式（例如侧栏批量选择框）
  const noLabelHtml = renderToString(
    e(Checkbox, {
      className: 'sidebar-batch-checkbox',
      checked: true,
      onChange: () => {},
      'aria-label': '选择会话',
    }),
  )
  assert.match(noLabelHtml, /class="helm-checkbox-wrap sidebar-batch-checkbox"/)
  assert.doesNotMatch(noLabelHtml, /helm-checkbox-label/)
})
