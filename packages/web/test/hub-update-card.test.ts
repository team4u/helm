/**
 * HubUpdateCard：仅在有就绪更新时渲染；apply 走 /api/hub-update/*；hub_busy 展示计数并
 * 提供强制路径；202 后进入切换中并在新版本上线后提示刷新。DOM 行为断言（不锁 CSS）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ensureHappyDom } from '../test/helpers/dom-harness.js'
ensureHappyDom()

import * as React from 'react'
const { act } = await import('react') as typeof import('react')
const { HubUpdateCard } = await import('../src/overview/HubUpdateCard.js')

interface FetchLog { method: string; path: string; body?: Record<string, unknown> }

function makeEnv(responses: Array<{ match: (log: FetchLog) => boolean; status: number; body: unknown }>) {
  const calls: FetchLog[] = []
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input)
    const body = init?.body !== undefined ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    const log: FetchLog = { method: init?.method ?? 'GET', path, body }
    calls.push(log)
    const hit = responses.find((r) => r.match(log))
    const status = hit?.status ?? 200
    const payload = hit?.body ?? {}
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return {
    calls,
    impl,
    replace(statusMatcher: { match: (log: FetchLog) => boolean; status: number; body: unknown }): void {
      responses[0] = statusMatcher
    },
  }
}

async function renderCard(): Promise<{ container: HTMLElement; rerender: () => Promise<void>; unmount: () => void }> {
  const { mountDomRoot } = await import('./helpers/dom-harness.js')
  const element: React.ReactElement = React.createElement(HubUpdateCard, { pollMs: 80 })
  const mounted = await mountDomRoot(element)
  return {
    container: mounted.host,
    rerender: () => mounted.rerender(React.createElement(HubUpdateCard, { pollMs: 80 })),
    unmount: mounted.unmount,
  }
}

test('HubUpdateCard stays absent without a staged update and renders the ready line when one exists', { timeout: 60_000 }, async (t) => {
  const env = makeEnv([{ match: (l) => l.path === '/api/hub-update/status', status: 200, body: { active: true, currentVersion: '1.0.0', readyVersion: null, lastError: null, blocked: null } }])
  const originalFetch = globalThis.fetch
  globalThis.fetch = env.impl as typeof fetch
  try {
    const { container, rerender, unmount } = await renderCard()
    t.after(unmount)
    assert.ok(container.firstElementChild === null, 'no ready update -> nothing rendered')

    // A staged update appears on the next poll cycle.
    env.replace({ match: (l: FetchLog) => l.path === '/api/hub-update/status', status: 200, body: { active: true, currentVersion: '1.0.0', readyVersion: '1.1.0', lastError: null, blocked: null } })
    await new Promise((resolve) => setTimeout(resolve, 250))
    await rerender()
    const card = container.querySelector('.hub-update-card')
    assert.ok(card !== null, 'card renders when a staged update exists')
    assert.match(card.textContent ?? '', /1\.0\.0 -> 1\.1\.0/)
    const action = card.querySelector('.hub-update-card-action') as HTMLButtonElement
    assert.ok(action !== null)
    assert.match(action.textContent ?? '', /Switch now|立即切换/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('apply posts to /api/hub-update/apply and hub_busy surfaces counts with a force path', { timeout: 60_000 }, async (t) => {
  const env = makeEnv([
    { match: (l) => l.path === '/api/hub-update/status', status: 200, body: { active: true, currentVersion: '1.0.0', readyVersion: '1.1.0', lastError: null, blocked: null } },
    { match: (l) => l.path === '/api/hub-update/apply' && l.body?.force !== true, status: 409, body: { error: { code: 'hub_busy', message: 'busy', details: { counts: { activeConversations: 2 } } } } },
    { match: (l) => l.path === '/api/hub-update/apply' && l.body?.force === true, status: 202, body: { ok: true, switching: true, targetVersion: '1.1.0', handoffPid: 11 } },
  ])
  const originalFetch = globalThis.fetch
  globalThis.fetch = env.impl as typeof fetch
  try {
    const { container, rerender, unmount } = await renderCard()
    t.after(unmount)
    const card = container.querySelector('.hub-update-card') as HTMLElement
    assert.ok(card !== null)
    const apply = card.querySelector('.hub-update-card-action') as HTMLButtonElement
    await act(async () => {
      apply.click()
    })
    await rerender()
    const busy = container.querySelector('.hub-update-card-busy')
    assert.ok(busy !== null, 'busy counts are surfaced, not swallowed')
    assert.match(busy.textContent ?? '', /activeConversations=2/)
    const force = container.querySelector('.hub-update-card-action') as HTMLButtonElement
    assert.match(force.textContent ?? '', /Switch anyway|仍要切换/)
    await act(async () => {
      force.click()
    })
    await rerender()
    const applied = env.calls.filter((c) => c.path === '/api/hub-update/apply')
    assert.equal(applied.length, 2)
    assert.deepEqual(applied[1]!.body, { force: true })
    assert.ok(container.querySelector('.hub-update-card-switching') !== null, 'accepted switch enters switching state')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('HubUpgradedNotice appears once per version and opens the sliced changelog', { timeout: 60_000 }, async (t) => {
  const { HubUpgradedNotice } = await import('../src/overview/HubUpgradedNotice.js'
  ) as typeof import('../src/overview/HubUpgradedNotice.js')
  const { act } = await import('react') as typeof import('react')
  const { mountDomRoot } = await import('./helpers/dom-harness.js')
  const { makeTestStore, HelmxExternalStoreContext } = await import('./helpers/store.js')

  let statusBody: Record<string, unknown> = {
    currentVersion: '0.1.2',
    upgradedFrom: '0.1.1',
    changelogAvailable: true,
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === '/api/hub-update/status') return Response.json(statusBody)
    return Response.json({})
  }) as typeof fetch
  const storage = globalThis.localStorage
  t.after(() => {
    globalThis.fetch = originalFetch
    storage?.removeItem('helmx:hub-changelog-seen')
  })
  const store = makeTestStore()
  const element = (): React.ReactElement =>
    React.createElement(
      HelmxExternalStoreContext.Provider,
      { value: store },
      React.createElement(HubUpgradedNotice, { pollMs: 80 }),
    )
  const mounted = await mountDomRoot(element())
  t.after(mounted.unmount)

  const notice = mounted.host.querySelector('.hub-upgraded-notice') as HTMLElement | null
  assert.ok(notice !== null, 'notice renders when an upgrade is pending')
  assert.match(notice.textContent ?? '', /v0\.1\.1 更新到 v0\.1\.2|v0\.1\.1 to v0\.1\.2/)
  const actions = [...notice.querySelectorAll('button')] as HTMLButtonElement[]
  const view = actions.find((button) => /查看更新内容|What's changed/.test(button.textContent ?? ''))
  assert.ok(view !== undefined, 'view-changes action present when the changelog is available')

  await act(async () => {
    view!.click()
  })
  assert.equal(storage?.getItem('helmx:hub-changelog-seen') ?? null, '0.1.2', 'opening the changelog marks the version as seen')

  await mounted.rerender(element())
  assert.ok(mounted.host.querySelector('.hub-upgraded-notice') === null, 'notice stays dismissed for the same version')

  statusBody = { currentVersion: '0.1.3', upgradedFrom: '0.1.2', changelogAvailable: false }
  await new Promise((resolve) => setTimeout(resolve, 250))
  await mounted.rerender(element())
  const next = mounted.host.querySelector('.hub-upgraded-notice') as HTMLElement | null
  assert.ok(next !== null, 'a newer upgrade shows the notice again')
  assert.equal(next.querySelectorAll('button').length, 1, 'without a changelog only the dismiss action remains')
})

test('HubChangelogModal renders sliced sections and honest absent states', { timeout: 60_000 }, async (t) => {
  const { HubChangelogModal } = await import('../src/modals/HubChangelogModal.js')
  const { mountDomRoot } = await import('./helpers/dom-harness.js')
  const { HelmxExternalStoreContext } = await import('./helpers/store.js')
  const calls: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input)
    calls.push(path)
    if (path.startsWith('/api/hub-update/changelog')) {
      return Response.json({
        available: true,
        version: '0.1.2',
        from: '0.1.1',
        fromMatched: true,
        sections: [
          { version: '0.1.2', date: '2026-11-22', markdown: '- feat(web): changelog 界面' },
          { version: '0.1.1', date: '2026-11-19', markdown: '- ci(release): Trusted Publishing' },
        ],
      })
    }
    return Response.json({})
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const store = (await import('./helpers/store.js')).makeTestStore()
  const mounted = await mountDomRoot(
    React.createElement(
      HelmxExternalStoreContext.Provider,
      { value: store },
      React.createElement(HubChangelogModal, { from: '0.1.1', onClose: () => {}, inline: true }),
    ) satisfies React.ReactElement as React.ReactElement,
  )
  t.after(mounted.unmount)
  assert.deepEqual(calls, ['/api/hub-update/changelog?from=0.1.1'])
  await new Promise((resolve) => setTimeout(resolve, 100))
  const host = mounted.host
  assert.ok(host.querySelector('.hub-changelog-modal') !== null)
  const versions = [...host.querySelectorAll('.hub-changelog-version')].map((el) => el.textContent)
  assert.deepEqual(versions, ['v0.1.2', 'v0.1.1'])
  assert.match(host.textContent ?? '', /0\.1\.1 以来 · 2 个版本|2 versions/)
  assert.match(host.textContent ?? '', /changelog 界面/)

  // Absent changelog: honest callout, no fabricated sections.
  globalThis.fetch = (async () => Response.json({ available: false, version: '0.1.2' })) as typeof fetch
  const absentMounted = await mountDomRoot(
    React.createElement(
      HelmxExternalStoreContext.Provider,
      { value: store },
      React.createElement(HubChangelogModal, { onClose: () => {}, inline: true }),
    ) satisfies React.ReactElement as React.ReactElement,
  )
  t.after(absentMounted.unmount)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.match(absentMounted.host.textContent ?? '', /未随附变更日志|did not ship a changelog/)
})

test('sidebar footer carries the changelog entry', { timeout: 60_000 }, async (t) => {
  const { Sidebar } = await import('../src/shell/Sidebar.js')
  const { mountDomRoot } = await import('./helpers/dom-harness.js')
  const { makeTestStore, HelmxExternalStoreContext } = await import('./helpers/store.js')
  const store = makeTestStore()
  const mounted = await mountDomRoot(
    React.createElement(
      HelmxExternalStoreContext.Provider,
      { value: store },
      React.createElement(Sidebar),
    ) satisfies React.ReactElement as React.ReactElement,
  )
  t.after(mounted.unmount)
  const railButton = mounted.host.querySelector('.sidebar-changelog-toggle') as HTMLElement | null
  assert.ok(railButton !== null, 'rail changelog entry exists below the theme toggle')
  assert.match(railButton.getAttribute('title') ?? '', /版本与更新|Version & updates/)
  assert.equal(mounted.host.querySelector('.sidebar-footer'), null, 'the bottom-row footer is gone')
})
