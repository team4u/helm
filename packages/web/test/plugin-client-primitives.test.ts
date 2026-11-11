/**
 * @helm/plugin-client 轻量布局原语测试（真实 React SSR renderToString）：
 * - Screen / ScreenSection / DataTable / KvGrid 从共享 SDK 真实导出，且与 protocol
 *   PLUGIN_CLIENT_SHARED_EXPORTS 唯一清单双向锁定（清单内全部符号运行时真实存在）；
 * - SSR 安全：renderToString 直接渲染，无 Portal、无浏览器副作用；
 * - 复用宿主通用类（.screen-container / .helm-table-wrap / .kv-grid 等），不新增 CSS 主题；
 * - DataTable 统一 loading / empty 占位（role=status / .table-empty），数据态透传 children。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import { PLUGIN_CLIENT_SHARED_EXPORTS } from '@helm/protocol'
import * as HelmPluginClient from '../src/lib/plugin-client-sdk.js'
import { Screen, ScreenSection, DataTable, KvGrid } from '../src/lib/plugin-client-primitives.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

test('布局原语进入共享 SDK 与 protocol 清单，且清单内全部符号真实导出（双向锁定）', { timeout: 60_000 }, () => {
  for (const name of ['Screen', 'ScreenSection', 'DataTable', 'KvGrid']) {
    assert.ok(
      (PLUGIN_CLIENT_SHARED_EXPORTS as readonly string[]).includes(name),
      `PLUGIN_CLIENT_SHARED_EXPORTS 必须包含 ${name}`,
    )
    assert.equal(typeof HelmPluginClient[name as keyof typeof HelmPluginClient], 'function', `共享 SDK 必须真实导出 ${name}`)
  }
  // 清单内每个符号在 SDK 运行时命名空间中真实存在（防清单与实现漂移）。
  const exportedNames = new Set(Object.keys(HelmPluginClient))
  for (const name of PLUGIN_CLIENT_SHARED_EXPORTS) {
    assert.ok(exportedNames.has(name), `共享 SDK 缺少清单符号 ${name}（PLUGIN_CLIENT_SHARED_EXPORTS 与实现漂移）`)
  }
})

test('Screen：header 组合渲染 screen-container / screen-header / title / subtitle（SSR）', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(
      Screen,
      { title: '任务中心', subtitle: '共 3 条' },
      e('div', { 'data-testid': 'body' }, '内容'),
    ),
  )
  assert.match(html, /screen-container/)
  assert.match(html, /screen-header/)
  assert.match(html, /screen-title/)
  assert.match(html, /screen-subtitle/)
  assert.match(html, /任务中心/)
  assert.match(html, /共 3 条/)
})

test('Screen：传 header 时整体替换默认页头；全部缺省时不渲染页头', { timeout: 60_000 }, () => {
  const custom = renderToString(
    e(Screen, { header: e('div', { className: 'my-header' }, '自定义') }, e('div', null, 'x')),
  )
  assert.match(custom, /my-header/)
  assert.doesNotMatch(custom, /screen-header/, '自定义 header 时不重复渲染默认页头')

  const bare = renderToString(e(Screen, null, e('div', null, 'x')))
  assert.match(bare, /screen-container/)
  assert.doesNotMatch(bare, /screen-header/, '无 title/subtitle/actions/header 时不渲染页头')
})

test('ScreenSection：可选标题渲染 screen-section / screen-section-title', { timeout: 60_000 }, () => {
  const withTitle = renderToString(e(ScreenSection, { title: 'Cron 任务', titleExtra: '2 条' }, e('div', null, 'x')))
  assert.match(withTitle, /screen-section(?!-)/)
  assert.match(withTitle, /screen-section-title/)
  assert.match(withTitle, /Cron 任务/)
  const noTitle = renderToString(e(ScreenSection, null, e('div', null, 'x')))
  assert.doesNotMatch(noTitle, /screen-section-title/)
})

test('DataTable：loading 态渲染统一加载行（role=status），不渲染 children', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(DataTable, {
      loading: true,
      loadingLabel: '读取中…',
      columns: 3,
      children: e('thead', null, e('tr', null, e('th', null, 'a'))),
    }),
  )
  assert.match(html, /helm-table-wrap/)
  assert.match(html, /helm-table/)
  assert.match(html, /loading-state/)
  assert.match(html, /role="status"/)
  assert.match(html, /读取中…/)
  assert.doesNotMatch(html, /<thead/, 'loading 时不渲染 children 表头')
})

test('DataTable：empty 态渲染 .table-empty 占位行；数据态透传 children', { timeout: 60_000 }, () => {
  const empty = renderToString(
    e(DataTable, {
      empty: true,
      columns: 2,
      emptyLabel: '暂无记录',
      children: e('thead', null, 'h'),
    }),
  )
  assert.match(empty, /table-empty/)
  assert.match(empty, /暂无记录/)
  assert.doesNotMatch(empty, /<thead/)

  const data = renderToString(
    e(DataTable, {
      label: '任务表',
      children: [
        e('thead', null, e('tr', null, e('th', null, 'ID'), e('th', null, '名称'))),
        e('tbody', null, e('tr', null, e('td', null, '1'), e('td', null, '任务一'))),
      ],
    }),
  )
  assert.match(data, /<thead/)
  assert.match(data, /任务一/)
  assert.match(data, /aria-label="任务表"/)
})

test('KvGrid：items 按 key/value 成对渲染 kv-grid 直接子项', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(KvGrid, {
      items: [
        { key: 'Cron 任务数', value: 2 },
        { key: 'Webhook 端点数', value: 1 },
      ],
    }),
  )
  assert.match(html, /kv-grid/)
  assert.match(html, /kv-key/)
  assert.match(html, /kv-val/)
  assert.match(html, /Cron 任务数/)
  assert.match(html, /Webhook 端点数/)
})
