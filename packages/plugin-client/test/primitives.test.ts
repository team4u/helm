/**
 * @helmx/plugin-client lightweight layout primitive tests (real React SSR
 * renderToString):
 * - Screen / ScreenSection / DataTable / KvGrid are really exported from the
 *   shared SDK and bidirectionally locked against the protocol
 *   PLUGIN_CLIENT_SHARED_EXPORTS single manifest (every listed symbol actually
 *   exists at runtime);
 * - SSR safe: renderToString renders directly, no Portal, no browser side effects;
 * - Host generic classes are reused (.screen-container / .helmx-table-wrap /
 *   .kv-grid etc.), no new CSS theme;
 * - DataTable unifies the loading / empty placeholders (role=status /
 *   .table-empty); the data state passes children through.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Window } from 'happy-dom'
import * as React from 'react'
import { Fragment } from 'react'
import { renderToString } from 'react-dom/server'
import { PLUGIN_CLIENT_SHARED_EXPORTS } from '@helmx/protocol'
import * as HelmxPluginClient from '../src/index.js'
import { Screen, ScreenSection, DataTable, KvGrid } from '../src/primitives.js'
import { StatusLight } from '../src/ui/StatusLight.js'
import { normalizeStatusLightTone, statusLightDotClass } from '../src/ui/status-light-model.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

test('layout primitives are in the shared SDK and the protocol manifest, and every manifest symbol is really exported (bidirectional locking)', { timeout: 60_000 }, () => {
  for (const name of ['Screen', 'ScreenSection', 'DataTable', 'KvGrid']) {
    assert.ok(
      (PLUGIN_CLIENT_SHARED_EXPORTS as readonly string[]).includes(name),
      `PLUGIN_CLIENT_SHARED_EXPORTS must include ${name}`,
    )
    assert.equal(typeof HelmxPluginClient[name as keyof typeof HelmxPluginClient], 'function', `the shared SDK must really export ${name}`)
  }
  // Every manifest symbol really exists in the SDK runtime namespace (guards
  // against manifest/implementation drift).
  const exportedNames = new Set(Object.keys(HelmxPluginClient))
  for (const name of PLUGIN_CLIENT_SHARED_EXPORTS) {
    assert.ok(exportedNames.has(name), `the shared SDK is missing manifest symbol ${name} (PLUGIN_CLIENT_SHARED_EXPORTS drifted from the implementation)`)
  }
})

test('Screen: header composition renders screen-container / screen-header / screen-heading(title+subtitle) / actions siblings (SSR)', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(
      Screen,
      {
        title: 'Task Center',
        subtitle: '3 items',
        actions: e('button', { type: 'button' }, 'Refresh'),
      },
      e('div', { 'data-testid': 'body' }, 'Body'),
    ),
  )
  assert.match(html, /screen-container/)
  assert.match(html, /screen-header/)
  assert.match(html, /screen-heading/)
  assert.match(html, /screen-title/)
  assert.match(html, /screen-subtitle/)
  assert.match(html, /Task Center/)
  assert.match(html, /3 items/)

  const win = new Window()
  win.document.body.innerHTML = html
  const header = win.document.body.querySelector('.screen-header')
  assert.ok(header !== null, '.screen-header must be rendered')
  const children = Array.from(header.children)
  assert.equal(children.length, 2, '.screen-header contains only two direct children: .screen-heading on the left and .stack-row on the right')
  assert.equal(children[0]!.className, 'screen-heading')
  assert.equal(children[1]!.className, 'stack-row')
  assert.equal(children[0]!.querySelector('.screen-title')?.textContent, 'Task Center')
  assert.equal(children[0]!.querySelector('.screen-subtitle')?.textContent, '3 items')
  assert.ok(children[0]!.querySelector('.stack-row') === null, 'actions must not be wrapped into .screen-heading')
  assert.equal(children[1]!.querySelector('button')?.textContent, 'Refresh')

  // Only subtitle + actions (title omitted): .screen-heading still wraps the
  // subtitle and no empty .screen-title is rendered
  const subOnly = renderToString(
    e(Screen, { subtitle: 'Subtitle only', actions: e('button', { type: 'button' }, 'Act') }),
  )
  win.document.body.innerHTML = subOnly
  const subHeader = win.document.body.querySelector('.screen-header')!
  assert.equal(subHeader.children[0]!.className, 'screen-heading')
  assert.ok(subHeader.children[0]!.querySelector('.screen-title') === null)
  assert.equal(subHeader.children[0]!.querySelector('.screen-subtitle')?.textContent, 'Subtitle only')
  assert.equal(subHeader.children[1]!.className, 'stack-row')

  // Only actions: keep the .screen-heading placeholder to preserve the
  // justify-content: space-between right alignment
  const actionsOnly = renderToString(
    e(Screen, { actions: e('button', { type: 'button' }, 'New') }),
  )
  win.document.body.innerHTML = actionsOnly
  const actHeader = win.document.body.querySelector('.screen-header')!
  assert.equal(actHeader.children.length, 2)
  assert.equal(actHeader.children[0]!.className, 'screen-heading')
  assert.equal(actHeader.children[1]!.className, 'stack-row')
  void win.close()
})

test('Screen: a passed header replaces the default header entirely; with everything omitted no header is rendered', { timeout: 60_000 }, () => {
  const custom = renderToString(
    e(Screen, { header: e('div', { className: 'my-header' }, 'Custom') }, e('div', null, 'x')),
  )
  assert.match(custom, /my-header/)
  assert.doesNotMatch(custom, /screen-header/, 'a custom header must not double-render the default header')

  const bare = renderToString(e(Screen, null, e('div', null, 'x')))
  assert.match(bare, /screen-container/)
  assert.doesNotMatch(bare, /screen-header/, 'no header is rendered without title/subtitle/actions/header')
})

test('ScreenSection: an optional title renders screen-section / screen-section-title', { timeout: 60_000 }, () => {
  const withTitle = renderToString(e(ScreenSection, { title: 'Cron Jobs', titleExtra: '2 items' }, e('div', null, 'x')))
  assert.match(withTitle, /screen-section(?!-)/)
  assert.match(withTitle, /screen-section-title/)
  assert.match(withTitle, /Cron Jobs/)
  const noTitle = renderToString(e(ScreenSection, null, e('div', null, 'x')))
  assert.doesNotMatch(noTitle, /screen-section-title/)
})

test('DataTable: the loading state renders the unified loading row (role=status) and not children', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(DataTable, {
      loading: true,
      loadingLabel: 'Loading rows…',
      columns: 3,
      children: e('thead', null, e('tr', null, e('th', null, 'a'))),
    }),
  )
  assert.match(html, /helmx-table-wrap/)
  assert.match(html, /helmx-table/)
  assert.match(html, /loading-state/)
  assert.match(html, /role="status"/)
  assert.match(html, /Loading rows…/)
  assert.doesNotMatch(html, /<thead/, 'the children thead is not rendered while loading')
})

test('DataTable: without explicit columns the colSpan is inferred from the single thead including Fragments (with cell colSpans)', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(
      DataTable,
      {
        loading: true,
        children: e(
          'thead',
          null,
          e('tr', null, e('th', { colSpan: 2 }, 'Group'), e(Fragment, { key: 'status' }, e('th', null, 'Status'))),
        ),
      },
    ),
  )
  assert.match(html, /<td colSpan="3">/, 'the colSpans of the first-row cells must be summed')
})

test('DataTable: the empty state renders the .table-empty placeholder row; the data state passes children through', { timeout: 60_000 }, () => {
  const empty = renderToString(
    e(DataTable, {
      empty: true,
      columns: 2,
      emptyLabel: 'No records',
      children: e('thead', null, 'h'),
    }),
  )
  assert.match(empty, /table-empty/)
  assert.match(empty, /No records/)
  assert.doesNotMatch(empty, /<thead/)

  const data = renderToString(
    e(DataTable, {
      label: 'Tasks',
      children: [
        e('thead', { key: 'head' }, e('tr', null, e('th', null, 'ID'), e('th', null, 'Name'))),
        e('tbody', { key: 'body' }, e('tr', null, e('td', null, '1'), e('td', null, 'Task one'))),
      ],
    }),
  )
  assert.match(data, /<thead/)
  assert.match(data, /Task one/)
  assert.match(data, /aria-label="Tasks"/)
})

test('KvGrid: items render as paired kv-grid direct children by key/value', { timeout: 60_000 }, () => {
  const html = renderToString(
    e(KvGrid, {
      items: [
        { key: 'Cron jobs', value: 2 },
        { key: 'Webhook endpoints', value: 1 },
      ],
    }),
  )
  assert.match(html, /kv-grid/)
  assert.match(html, /kv-key/)
  assert.match(html, /kv-val/)
  assert.match(html, /Cron jobs/)
  assert.match(html, /Webhook endpoints/)
})

// ---------------------------------------------------------------------------
// StatusLight: unified status light (visually dot-only)
// ---------------------------------------------------------------------------

test('StatusLight: renders dot-only; the label is a screen-reader accessible name, never visible text', { timeout: 60_000 }, () => {
  const html = renderToString(e(StatusLight, { status: 'running', label: 'Running' }))
  assert.match(html, /helmx-status-light helmx-status-light-working/)
  assert.match(html, /status-dot status-dot-working/)
  assert.equal((html.match(/status-dot /g) ?? []).length, 1, 'exactly one dot')
  // Accessible name: role=img + aria-label + sr-only text (no visible label node, no width cost).
  assert.match(html, /role="img"/)
  assert.match(html, /aria-label="Running"/)
  assert.match(html, /helmx-sr-only">Running</)
  assert.doesNotMatch(html, /helmx-status-light-label/, 'no visible label element')
})

test('StatusLight: settled and neutral tones map honestly (completed/aborted/skipped/offline/unknown)', { timeout: 60_000 }, () => {
  assert.match(renderToString(e(StatusLight, { status: 'completed' })), /helmx-status-light-done/)
  assert.match(renderToString(e(StatusLight, { status: 'error' })), /status-dot-error/)
  // Aborted is NOT the plain gray idle dot: it keeps the dedicated diamond class.
  const aborted = renderToString(e(StatusLight, { status: 'aborted', label: 'Aborted' }))
  assert.match(aborted, /status-dot-aborted/)
  assert.doesNotMatch(aborted, /helmx-status-light-idle/)
  assert.match(renderToString(e(StatusLight, { status: 'skipped' })), /status-dot-pending/)
  assert.match(renderToString(e(StatusLight, { status: 'offline' })), /helmx-status-light-idle/)
  // Unknown statuses never fabricate a done/failed verdict.
  assert.match(renderToString(e(StatusLight, { status: 'weird-state' })), /helmx-status-light-pending/)
})

test('StatusLight: without a label the raw status word becomes the accessible-name fallback; extra className is appended; non-string labels keep the sr-only text', { timeout: 60_000 }, () => {
  const html = renderToString(e(StatusLight, { status: 'blocked', className: 'tray-status' }))
  assert.match(html, /helmx-status-light helmx-status-light-blocked tray-status/)
  assert.match(html, /status-dot status-dot-blocked/)
  assert.match(html, /aria-label="blocked"/, 'role=img never ends up nameless: raw status fallback')
  assert.doesNotMatch(html, /helmx-sr-only/, 'no sr-only node without an explicit label')
  const richLabel = renderToString(e(StatusLight, { status: 'done', label: e('em', undefined, 'Done') }))
  assert.match(richLabel, /helmx-sr-only"><em[^>]*>Done<\/em>/, 'ReactNode labels render as sr-only content')
  assert.equal(typeof normalizeStatusLightTone, 'function')
  assert.equal(statusLightDotClass('failed'), 'status-dot status-dot-error')
})

test('normalizeStatusLightTone: alias families collapse into the seven honest tones', { timeout: 60_000 }, () => {
  assert.equal(normalizeStatusLightTone('RUNNING'), 'working')
  assert.equal(normalizeStatusLightTone('superseded'), 'aborted')
  assert.equal(normalizeStatusLightTone('queued'), 'pending')
  assert.equal(normalizeStatusLightTone(undefined), 'pending')
  assert.equal(normalizeStatusLightTone(''), 'pending')
})
