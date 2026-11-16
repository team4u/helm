/**
 * Web i18n core invariants and the canonical locale-switching behavior test:
 * - catalog completeness: every message declares non-empty `en` and `zh-CN`
 *   copy; no cross-table key collisions (a spread merge would silently shadow);
 * - translator behavior: interpolation, unknown placeholders, missing-key echo,
 *   per-locale memoized identity;
 * - `useWebLocale` consumers (reference: SplitControls) render the active
 *   store locale and switch en -> zh-CN -> en immediately on setLocale
 *   (no remount, no storage re-read).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { HelmLocale } from '@helm/protocol/browser'
import { formatMessage, translateMessage, type MessageTable } from '../src/i18n/messages.js'
import {
  createWebTranslator,
  englishWebTranslator,
  webMessages,
} from '../src/i18n/catalog.js'
import { commonMessages } from '../src/i18n/resources/common.js'
import { composerMessages } from '../src/i18n/resources/composer.js'
import { conversationMessages } from '../src/i18n/resources/conversation.js'
import { modalsMessages } from '../src/i18n/resources/modals.js'
import { modelsMessages } from '../src/i18n/resources/models.js'
import { nodesMessages } from '../src/i18n/resources/nodes.js'
import { profilesMessages } from '../src/i18n/resources/profiles.js'
import { shellMessages } from '../src/i18n/resources/shell.js'
import { skillsMessages } from '../src/i18n/resources/skills.js'
import { uiMessages } from '../src/i18n/resources/ui.js'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { makeTestStore } from './helpers/store.js'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const DOMAIN_TABLES: Array<[name: string, table: MessageTable]> = [
  ['common', commonMessages],
  ['conversation', conversationMessages],
  ['composer', composerMessages],
  ['shell', shellMessages],
  ['ui', uiMessages],
  ['models', modelsMessages],
  ['nodes', nodesMessages],
  ['profiles', profilesMessages],
  ['skills', skillsMessages],
  ['modals', modalsMessages],
]

test('catalog completeness: non-empty en and zh-CN for every message', { timeout: 60_000 }, () => {
  const entries = Object.entries(webMessages)
  assert.ok(entries.length >= 20, 'catalog must be seeded with the common table')
  for (const [key, entry] of entries) {
    assert.equal(typeof entry.en, 'string', `${key}.en must be a string`)
    assert.equal(typeof entry['zh-CN'], 'string', `${key}.zh-CN must be a string`)
    assert.ok(entry.en.trim() !== '', `${key}.en must not be empty`)
    assert.ok(entry['zh-CN'].trim() !== '', `${key}.zh-CN must not be empty`)
  }
})

test('catalog uniqueness: no key is declared by two domain tables', { timeout: 60_000 }, () => {
  const owners = new Map<string, string>()
  const collisions: string[] = []
  for (const [name, table] of DOMAIN_TABLES) {
    for (const key of Object.keys(table)) {
      const previous = owners.get(key)
      if (previous !== undefined) collisions.push(`${key} in ${previous} + ${name}`)
      else owners.set(key, name)
    }
  }
  assert.deepEqual(collisions, [], 'domain tables must not collide; later spreads would silently shadow')
  assert.equal(Object.keys(webMessages).length, owners.size, 'merged catalog keys must equal the union of domain tables')
})

test('translator: locale resolution, memoized identity, interpolation, missing-key echo', { timeout: 60_000 }, () => {
  const en = createWebTranslator('en')
  const zh = createWebTranslator('zh-CN')
  assert.equal(en('ui.split.sideBySide'), 'Side-by-side split')
  assert.equal(zh('ui.split.sideBySide'), '并排分屏')
  assert.equal(createWebTranslator('en'), en, 'translators are memoized per locale (stable identity)')
  assert.equal(englishWebTranslator('ui.split.closeView'), 'Close split view', 'English bridge translator defaults to en')

  assert.equal(formatMessage('Conversation #{id} failed: {reason}', { id: 7, reason: 'gone' }), 'Conversation #7 failed: gone')
  assert.equal(formatMessage('Keep {unknown} verbatim', { known: 'x' }), 'Keep {unknown} verbatim')
  assert.equal(formatMessage('No params'), 'No params')

  const handMade: MessageTable = {}
  assert.equal(translateMessage(handMade, 'en', 'not.a.key'), 'not.a.key', 'missing keys echo the key instead of an empty string')
})

test('useWebLocale consumers switch en -> zh-CN -> en immediately via setLocale', { timeout: 60_000 }, async () => {
  const { SplitToggleButton } = await import('../src/ui/SplitControls.js')

  let committedLocale: HelmLocale = 'en'
  function Harness(): React.JSX.Element {
    const [locale, setLocale] = React.useState<HelmLocale>('en')
    committedLocale = locale
    const store = React.useMemo(
      () => makeTestStore({ locale, setLocale: (next: HelmLocale) => setLocale(next) }),
      [locale],
    )
    return React.createElement(
      HelmStoreContext.Provider,
      { value: store },
      React.createElement(SplitToggleButton, { isSplitActive: false, onToggleSplit: () => {} }),
      React.createElement(
        'button',
        { type: 'button', onClick: () => setLocale(locale === 'en' ? 'zh-CN' : 'en') },
        'switch-locale',
      ),
    )
  }

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  try {
    await act(async () => { root.render(React.createElement(Harness)) })
    const toggle = host.querySelector<HTMLButtonElement>('.split-toggle-btn')
    assert.ok(toggle !== null, 'split toggle renders')
    assert.equal(toggle.getAttribute('aria-label'), 'Side-by-side split', 'renders the en catalog copy by default')
    assert.equal(toggle.getAttribute('title'), 'Open / close the split view on the right')

    const switchButton = [...host.querySelectorAll('button')].find((b) => b.textContent === 'switch-locale')
    assert.ok(switchButton !== undefined, 'locale switch harness button must exist')
    const switchBtn = switchButton as HTMLButtonElement
    await act(async () => { switchBtn.click() })
    assert.equal(committedLocale, 'zh-CN')
    const toggleZh = host.querySelector<HTMLButtonElement>('.split-toggle-btn')
    assert.ok(toggleZh !== null)
    const toggleZhBtn: HTMLButtonElement = toggleZh
    assert.equal(toggleZhBtn.getAttribute('aria-label'), '并排分屏', 'locale switch re-renders consumers in place')
    assert.equal(toggleZhBtn.getAttribute('title'), '在右屏并排打开 / 关闭分屏')

    await act(async () => { switchBtn.click() })
    assert.equal(committedLocale, 'en')
    assert.equal(host.querySelector('.split-toggle-btn')!.getAttribute('aria-label'), 'Side-by-side split', 'switching back to en restores English immediately')
  } finally {
    await act(async () => { root.unmount() })
    host.remove()
  }
})
