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
    assert.equal(container.firstElementChild, null, 'no ready update -> nothing rendered')

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
