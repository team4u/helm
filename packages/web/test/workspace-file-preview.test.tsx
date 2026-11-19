import assert from 'node:assert/strict'
import test, { describe } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationSummary } from '@helmx/protocol'
import type { ActiveModal } from '../src/lib/types.js'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'
import { setStoredToken } from '../src/lib/api.js'

GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as Record<string, unknown>).React = React

const { MarkdownView } = await import('../src/conversation/MarkdownView.js')
const { WorkspaceFilePreviewModal } = await import('../src/conversation/WorkspaceFilePreviewModal.js')
const { makeTestStore } = await import('./helpers/store.js')
const { HostStoreProviders } = await import('./helpers/host-store.js')

const e = React.createElement

function conv(id: number, cwd: string): ConversationSummary {
  return {
    id,
    title: `Conv ${id}`,
    profileId: 'assistant',
    nodeId: 'local',
    cwd,
    tags: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as unknown as ConversationSummary
}

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
  }
}

function resetBody(): void {
  for (const node of [...document.body.children]) {
    if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') continue
    node.remove()
  }
}

function installObjectUrlShim(): { active: () => string[]; created: () => string[]; restore: () => void } {
  const origCreate = URL.createObjectURL
  const origRevoke = URL.revokeObjectURL
  const created: string[] = []
  const live = new Set<string>()
  let seq = 0
  URL.createObjectURL = (() => {
    seq += 1
    const url = `blob:ws-test-${seq}`
    created.push(url)
    live.add(url)
    return url
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = ((url: string) => {
    live.delete(url)
  }) as typeof URL.revokeObjectURL
  return {
    active: () => [...live],
    created: () => [...created],
    restore: () => {
      URL.createObjectURL = origCreate
      URL.revokeObjectURL = origRevoke
    },
  }
}

function mount(element: React.ReactElement): { host: HTMLElement; root: Root; unmount: () => void } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(element)
  })
  return {
    host,
    root,
    unmount: () => {
      act(() => {
        root.unmount()
      })
      host.remove()
    },
  }
}

/** 记录真实 setActiveModal 调用序列（委托真实动作）。 */
function spyActiveModal(store: HelmxExternalStore, opened: ActiveModal[]): void {
  const real = store.actions.setActiveModal
  ;(store.actions as unknown as { setActiveModal: (modal: ActiveModal) => void }).setActiveModal = (modal) => {
    opened.push(modal)
    real(modal)
  }
}

describe('MarkdownView workspace file links and inline images', { timeout: 60_000 }, () => {
  test('clicking a relative workspace link opens workspace-file modal with line range', { timeout: 60_000 }, async () => {
    const opened: ActiveModal[] = []
    const store = makeTestStore({
      conversations: [conv(12, '/repo')],
    })
    spyActiveModal(store, opened)

    resetBody()
    const mounted = mount(
      e(
        HostStoreProviders,
        { value: store },
        e(MarkdownView, {
          text: 'See [App](src/App.tsx#L10-L25) and [External](github.com/foo/bar)',
          conversationId: 12,
        }),
      ),
    )

    try {
      const chip = mounted.host.querySelector<HTMLButtonElement>('button.attachment-chip')
      assert.ok(chip !== null, 'relative link renders as attachment-chip button')
      assert.match(chip.textContent ?? '', /App/)

      // Bare web host remains a normal <a>
      const external = mounted.host.querySelector<HTMLAnchorElement>('a')
      assert.ok(external !== null, 'bare domain stays an <a> tag')
      assert.match(external.textContent ?? '', /External/)

      await act(async () => {
        chip.click()
      })
      assert.deepEqual(opened, [
        {
          kind: 'workspace-file',
          conversationId: 12,
          path: 'src/App.tsx',
          startLine: 10,
          endLine: 25,
        },
      ])
    } finally {
      mounted.unmount()
      resetBody()
    }
  })

  test('clicking a bare absolute link inside conversationCwd opens workspace-file modal while outside paths stay safe', { timeout: 60_000 }, async () => {
    const opened: ActiveModal[] = []
    const store = makeTestStore({
      conversations: [conv(15, '/root/code/helm')],
    })
    spyActiveModal(store, opened)

    resetBody()
    const mounted = mount(
      e(
        HostStoreProviders,
        { value: store },
        e(MarkdownView, {
          text: [
            '在 [SKILL.md](/root/code/helm/packages/plugins/src/profile/skill/SKILL.md#L12) 查看索引，',
            '外置路径 [Etc](/etc/passwd) 与 [WinOutside](C:/secret.txt)。',
          ].join(''),
          conversationId: 15,
        }),
      ),
    )

    try {
      const chip = mounted.host.querySelector<HTMLButtonElement>('button.attachment-chip')
      assert.ok(chip !== null, 'cwd-contained bare absolute link renders as attachment-chip')
      assert.match(chip.textContent ?? '', /SKILL\.md/)

      const outsidePosix = mounted.host.querySelector<HTMLAnchorElement>('a[href="/etc/passwd"]')
      assert.ok(outsidePosix !== null, 'outside POSIX path keeps default <a>')

      const disallowedWin = mounted.host.querySelector('.msg-md-disallowed-file')
      assert.ok(disallowedWin !== null, 'outside Windows drive path renders disallowed span')
      assert.equal(disallowedWin.textContent, 'WinOutside')

      await act(async () => {
        chip.click()
      })
      assert.deepEqual(opened, [
        {
          kind: 'workspace-file',
          conversationId: 15,
          path: 'packages/plugins/src/profile/skill/SKILL.md',
          startLine: 12,
        },
      ])
    } finally {
      mounted.unmount()
      resetBody()
    }
  })

  test('non-streaming relative image fetches with auth header and renders thumbnail; disallowed file:// emits no <a> or fetch', { timeout: 60_000 }, async () => {
    const requests: Array<{ url: string; auth: string | null }> = []
    const origFetch = globalThis.fetch
    const shim = installObjectUrlShim()
    setStoredToken('secret-token-42')
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      requests.push({ url, auth: headers.get('Authorization') })
      return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), { status: 200 })
    }) as typeof fetch

    const opened: ActiveModal[] = []
    const store = makeTestStore({
      conversations: [conv(9, '/repo')],
    })
    spyActiveModal(store, opened)

    resetBody()
    const mounted = mount(
      e(
        HostStoreProviders,
        { value: store },
        e(MarkdownView, {
          text: [
            '![Diagram](docs/arch.png)',
            '',
            '[Outside](file:///etc/passwd)',
            '',
            '![OutsideImg](file:///etc/secret.png)',
          ].join('\n'),
          conversationId: 9,
          streaming: false,
        }),
      ),
    )

    try {
      await flush()
      assert.equal(requests.length, 1, 'only workspace-relative image triggers fetch')
      assert.equal(requests[0]!.url, '/api/conversations/9/files/content?path=docs%2Farch.png&inline=1')
      assert.equal(requests[0]!.auth, 'Bearer secret-token-42')

      const thumb = mounted.host.querySelector<HTMLButtonElement>('button.attachment-image-thumb')
      assert.ok(thumb !== null, 'image thumbnail renders after blob load')
      const thumbImg = thumb.querySelector('img')
      assert.ok(thumbImg !== null)
      assert.match(thumbImg.getAttribute('src') ?? '', /^blob:ws-test-/)

      const disallowed = mounted.host.querySelector('.msg-md-disallowed-file')
      assert.ok(disallowed !== null, 'disallowed file:// link renders span')
      assert.equal(disallowed.textContent, 'Outside')
      assert.ok(mounted.host.querySelector('a[href^="file:"]') === null, 'must never emit <a href="file:...">')
      assert.ok(mounted.host.querySelector('img[src^="file:"]') === null, 'must never emit <img src="file:...">')

      await act(async () => {
        thumb.click()
      })
      assert.deepEqual(opened, [{ kind: 'workspace-file', conversationId: 9, path: 'docs/arch.png' }])
    } finally {
      mounted.unmount()
      assert.equal(shim.active().length, 0, 'ObjectURL revoked on unmount')
      shim.restore()
      globalThis.fetch = origFetch
      setStoredToken(null)
      resetBody()
    }
  })

  test('streaming tail block defers workspace image fetch until block settles or streaming ends', { timeout: 60_000 }, async () => {
    const requests: string[] = []
    const origFetch = globalThis.fetch
    const shim = installObjectUrlShim()
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return new Response(new Blob([new Uint8Array([1, 2])], { type: 'image/png' }), { status: 200 })
    }) as typeof fetch

    const store = makeTestStore({
      conversations: [conv(5, '/repo')],
    })

    resetBody()
    const mounted = mount(
      e(
        HostStoreProviders,
        { value: store },
        e(MarkdownView, {
          text: '![Prefix](prefix.png)\n\n![Tail](tail.png)',
          conversationId: 5,
          streaming: true,
        }),
      ),
    )

    try {
      await flush()
      assert.deepEqual(
        requests,
        ['/api/conversations/5/files/content?path=prefix.png&inline=1'],
        'prefix block fetches immediately while trailing streaming block defers fetch',
      )

      // Streaming completes -> trailing block now fetches
      await act(async () => {
        mounted.root.render(
          e(
            HostStoreProviders,
            { value: store },
            e(MarkdownView, {
              text: '![Prefix](prefix.png)\n\n![Tail](tail.png)',
              conversationId: 5,
              streaming: false,
            }),
          ),
        )
      })
      await flush()
      assert.equal(requests.length, 2)
      assert.equal(requests[1], '/api/conversations/5/files/content?path=tail.png&inline=1')
    } finally {
      mounted.unmount()
      shim.restore()
      globalThis.fetch = origFetch
      resetBody()
    }
  })
})

describe('WorkspaceFilePreviewModal', { timeout: 60_000 }, () => {
  test('renders Markdown with workspaceBaseDir so nested relative links resolve recursively', { timeout: 60_000 }, async () => {
    const opened: ActiveModal[] = []
    const origFetch = globalThis.fetch
    const shim = installObjectUrlShim()
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('path=docs%2Fguide.md')) {
        return new Response(
          new Blob(['# Guide\n\nSee [API](./api.md#L3) and [Root](../README.md)'], { type: 'text/markdown' }),
          { status: 200 },
        )
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const store = makeTestStore({
      conversations: [conv(3, '/repo')],
    })
    spyActiveModal(store, opened)

    resetBody()
    const mounted = mount(
      e(
        HostStoreProviders,
        { value: store },
        e(WorkspaceFilePreviewModal, {
          conversationId: 3,
          path: 'docs/guide.md',
          onClose: () => {},
          inline: true,
        }),
      ),
    )

    try {
      await flush()
      const chips = [...document.querySelectorAll<HTMLButtonElement>('button.attachment-chip')]
      const apiChip = chips.find((c) => (c.textContent ?? '').includes('API'))
      const rootChip = chips.find((c) => (c.textContent ?? '').includes('Root'))
      assert.ok(apiChip !== undefined, 'nested ./api.md chip rendered')
      assert.ok(rootChip !== undefined, 'nested ../README.md chip rendered')

      await act(async () => {
        apiChip.click()
      })
      await act(async () => {
        rootChip.click()
      })
      assert.deepEqual(opened, [
        { kind: 'workspace-file', conversationId: 3, path: 'docs/api.md', startLine: 3 },
        { kind: 'workspace-file', conversationId: 3, path: 'README.md' },
      ])
    } finally {
      mounted.unmount()
      assert.equal(shim.active().length, 0)
      shim.restore()
      globalThis.fetch = origFetch
      resetBody()
    }
  })

  test('renders code file with octet-stream mime fallback and highlights target line range', { timeout: 60_000 }, async () => {
    const origFetch = globalThis.fetch
    const shim = installObjectUrlShim()
    globalThis.fetch = (async () =>
      new Response(
        new Blob(['line 1\nline 2\nline 3\nline 4\n'], { type: 'application/octet-stream' }),
        { status: 200 },
      )) as typeof fetch

    const store = makeTestStore({ conversations: [conv(8, '/repo')] })
    resetBody()
    const mounted = mount(
      e(
        HostStoreProviders,
        { value: store },
        e(WorkspaceFilePreviewModal, {
          conversationId: 8,
          path: 'src/index.ts',
          startLine: 2,
          endLine: 3,
          onClose: () => {},
          inline: true,
        }),
      ),
    )

    try {
      await flush()
      const rows = [...document.querySelectorAll<HTMLElement>('.code-line')]
      assert.equal(rows.length, 4)
      assert.equal(rows[0]!.dataset.highlighted, undefined)
      assert.equal(rows[1]!.dataset.highlighted, 'true')
      assert.equal(rows[2]!.dataset.highlighted, 'true')
      assert.equal(rows[3]!.dataset.highlighted, undefined)
      assert.match(document.body.textContent ?? '', /L2-3/)
    } finally {
      mounted.unmount()
      shim.restore()
      globalThis.fetch = origFetch
      resetBody()
    }
  })

  test('renders explicit error callout when file fetch fails', { timeout: 60_000 }, async () => {
    const origFetch = globalThis.fetch
    const shim = installObjectUrlShim()
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: 'not_found', message: 'File missing' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch

    const store = makeTestStore({ conversations: [conv(8, '/repo')] })
    resetBody()
    const mounted = mount(
      e(
        HostStoreProviders,
        { value: store },
        e(WorkspaceFilePreviewModal, {
          conversationId: 8,
          path: 'missing.txt',
          onClose: () => {},
          inline: true,
        }),
      ),
    )

    try {
      await flush()
      const errCallout = document.querySelector('.callout--error')
      assert.ok(errCallout !== null, 'error callout rendered')
      assert.match(errCallout.textContent ?? '', /File missing/)
    } finally {
      mounted.unmount()
      shim.restore()
      globalThis.fetch = origFetch
      resetBody()
    }
  })
})
