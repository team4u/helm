/**
 * Composer stable-callback and await-snapshot discipline tests (real DOM: createRoot + act, happy-dom):
 * - after an attachment-upload await completes, state syncs from liveDraftRef live values:
 *   the stale text/anchor from the render snapshot that started the upload must never
 *   flow back into the live draft (the subsequent send carries the full text + attachments);
 * - switching A -> B while A's upload is in flight (production remounts on the `composer-<id>`
 *   key): the upload still targets A and never leaks attachments into B's draft;
 * - switching A -> B while A's send is in flight: the submit lands on A only (with A's draft
 *   snapshot); B's draft is not polluted by the write-back;
 * - after switching A -> B, B's draft is fresh: B's prefill lands normally; onlyIfEmpty
 *   refusals never leak A residue;
 * - unrelated re-renders while the slash popover is open never re-bind its global keyboard
 *   listeners (onPick/onClose/visible identities stay stable).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { HostStoreProviders } from './helpers/host-store.js'
import { makeTestStore } from './helpers/store.js'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
import type { ArtifactMetadata, ConversationSummary } from '@helm/protocol'
import { conversationsApi } from '../src/lib/api.js'
import type { HelmExternalStore } from '../src/lib/helm-store.js'
import type { ToastNotice } from '../src/lib/types.js'

const { Composer } = await import('../src/conversation/Composer.js')

const conv = (id: number): ConversationSummary => ({
  id, title: `会话 ${id}`, profileId: 'coder', tags: [], cwd: '/w', model: 'p/m',
  thinkingLevel: 'off', status: 'idle', stateChangeSeq: 1, completionSeq: 0,
  unread: false, pinned: false, pendingAskCount: 0, createdAt: 0, updatedAt: 0,
})
const convA = conv(1)
const convB = conv(2)

function makeStore(opts?: { detail?: boolean }): { store: HelmExternalStore; notices: () => ToastNotice[] } {
  const store = makeTestStore({
    conversations: [convA, convB],
    // Empty entries + idle: the empty conversation shows the starting-environment bar (SessionEnvBar)
    conversationDetails: opts?.detail === true ? { 1: { ...convA, entries: [] } } : {},
    conversationArtifacts: { 1: [], 2: [] },
    primaryTarget: { kind: 'conversation', conversationId: 1 },
  })
  return { store, notices: () => store.getNotices() }
}

type Prefill = NonNullable<React.ComponentProps<typeof Composer>['prefill']>

interface Harness {
  host: HTMLElement
  show: (key: string, conversation: ConversationSummary, prefill?: Prefill | null) => void
  ta: () => HTMLTextAreaElement
  chips: () => HTMLElement[]
  slashPopover: () => HTMLElement | null
  unmount: () => void
}

function mountComposer(store: HelmExternalStore, onSendingChange?: (sending: boolean) => void): Harness {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const show = (key: string, conversation: ConversationSummary, prefill: Prefill | null = null): void => {
    act(() => {
      root.render(
        React.createElement(
          HostStoreProviders,
          { value: store },
          React.createElement(Composer, {
            key,
            conversation,
            prefill,
            ...(onSendingChange !== undefined ? { onSendingChange } : {}),
          }),
        ),
      )
    })
  }
  return {
    host,
    show,
    ta: () => host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!,
    chips: () => Array.from(host.querySelectorAll('.attachment-chip')),
    slashPopover: () => host.querySelector('.composer-popover'),
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

function typeInto(ta: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  const tracker = (ta as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
  const prev = tracker?.getValue() ?? ''
  setter.call(ta, text)
  tracker?.setValue(prev)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

const type = async (ta: HTMLTextAreaElement, text: string): Promise<void> => {
  await act(async () => { typeInto(ta, text) })
}

const enter = async (ta: HTMLTextAreaElement): Promise<void> => {
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  await act(async () => {})
}

/** Synthesize a pasted file: React synthetic ClipboardEvents read clipboardData.files off the native event. */
function pasteFiles(ta: HTMLTextAreaElement, files: File[]): void {
  const ev = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clipboardData', { value: { files } })
  ta.dispatchEvent(ev)
}

const paste = async (ta: HTMLTextAreaElement, files: File[]): Promise<void> => {
  await act(async () => { pasteFiles(ta, files) })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

interface SubmitCall { id: number; payload: Record<string, unknown> }

function stubApi(opts?: { uploadGate?: Promise<void>; submitGate?: Promise<void> }): {
  uploads: Array<{ id: number; name: string }>
  submits: SubmitCall[]
  restore: () => void
} {
  const originalUpload = conversationsApi.uploadArtifact
  const originalSubmit = conversationsApi.submitInput
  const uploadsSeen: Array<{ id: number; name: string }> = []
  const submitsSeen: SubmitCall[] = []
  conversationsApi.uploadArtifact = (async (id: number, file: File) => {
    uploadsSeen.push({ id, name: file.name })
    if (opts?.uploadGate !== undefined) await opts.uploadGate
    const meta: ArtifactMetadata = {
      id: `art-${id}`, conversationId: id, kind: 'upload', name: file.name,
      path: `artifacts/${id}/${file.name}`, mimeType: file.type || 'application/octet-stream',
      size: file.size, createdAt: 1,
    }
    return meta
  }) as typeof conversationsApi.uploadArtifact
  conversationsApi.submitInput = (async (id: number, payload: Record<string, unknown>) => {
    submitsSeen.push({ id, payload })
    if (opts?.submitGate !== undefined) await opts.submitGate
    return { submissionId: 's1' }
  }) as unknown as typeof conversationsApi.submitInput
  return {
    uploads: uploadsSeen,
    submits: submitsSeen,
    restore: () => {
      conversationsApi.uploadArtifact = originalUpload
      conversationsApi.submitInput = originalSubmit
    },
  }
}

const flush = async (): Promise<void> => {
  await act(async () => {})
}

const testFile = (): File => new File(['x'], '笔记.txt', { type: 'text/plain' })

test('upload completion syncs the live draft: stale snapshot text never flows back after the await; the next send carries full text and attachments', { timeout: 60_000 }, async () => {
  const gate = deferred<void>()
  const api = stubApi({ uploadGate: gate.promise })
  const { store } = makeStore()
  const app = mountComposer(store)
  try {
    app.show('composer-1', convA)
    await type(app.ta(), 'hello')
    await paste(app.ta(), [testFile()])
    // Keep typing while the upload is in flight: the stale text in the upload callback closure must never overwrite this live draft
    await type(app.ta(), 'hello world')
    await act(async () => { gate.resolve() })
    await flush()
    assert.equal(app.chips().length, 1, 'the attachment chip appears once the upload completes')
    assert.equal(app.ta().value, 'hello world', 'the live draft text is not overwritten by the stale snapshot from upload start')
    await enter(app.ta())
    assert.equal(api.submits.length, 1, 'a complete draft sends')
    assert.equal(api.submits[0]!.id, 1)
    assert.deepEqual(
      {
        text: api.submits[0]!.payload.text,
        origin: api.submits[0]!.payload.origin,
        attachments: api.submits[0]!.payload.attachments,
      },
      { text: 'hello world', origin: 'human', attachments: ['art-1'] },
      'the send carries the full text and the uploaded attachment',
    )
  } finally {
    api.restore()
    app.unmount()
  }
})

test('switching A -> B mid-upload: the upload stays bound to A and never leaks attachments into B', { timeout: 60_000 }, async () => {
  const gate = deferred<void>()
  const api = stubApi({ uploadGate: gate.promise })
  const { store } = makeStore()
  const app = mountComposer(store)
  try {
    app.show('composer-1', convA)
    await type(app.ta(), 'a 草稿')
    await paste(app.ta(), [testFile()])
    // Production mounts on the composer-<id> key: switching conversations remounts; B is a fresh instance
    app.show('composer-2', convB)
    assert.equal(app.ta().value, '', 'B starts with a fresh blank draft')
    await act(async () => { gate.resolve() })
    await flush()
    assert.deepEqual(api.uploads, [{ id: 1, name: '笔记.txt' }], 'the upload still targets conversation A where it started')
    assert.equal(app.chips().length, 0, 'A in-flight attachments never pollute B draft')
    assert.equal(app.ta().value, '', 'B text is untouched by A instance write-backs')
    await type(app.ta(), 'b 草稿')
    await enter(app.ta())
    assert.equal(api.submits.length, 1)
    assert.equal(api.submits[0]!.id, 2, 'B send lands on B only')
    assert.equal(api.submits[0]!.payload.text, 'b 草稿')
    assert.equal(api.submits[0]!.payload.attachments, undefined, 'B submit carries none of A attachments')
  } finally {
    api.restore()
    app.unmount()
  }
})

test('switching A -> B mid-send: the submit lands on A only; B draft stays unpolluted by A write-backs', { timeout: 60_000 }, async () => {
  const gate = deferred<void>()
  const api = stubApi({ submitGate: gate.promise })
  const { store } = makeStore()
  const sending: boolean[] = []
  const app = mountComposer(store, (s) => { sending.push(s) })
  try {
    app.show('composer-1', convA)
    await type(app.ta(), 'msg-a')
    await enter(app.ta())
    assert.deepEqual(sending, [true], 'in-flight feedback opens honestly')
    app.show('composer-2', convB)
    await act(async () => { gate.resolve() })
    await flush()
    assert.equal(api.submits.length, 1)
    assert.equal(api.submits[0]!.id, 1, 'the submit targets conversation A where it started, never re-routed to B')
    assert.equal(api.submits[0]!.payload.text, 'msg-a')
    assert.deepEqual(sending, [true, false], 'in-flight feedback closes honestly, never dangling')
    assert.equal(app.ta().value, '', 'B draft stays blank')
    assert.equal(app.chips().length, 0)
  } finally {
    api.restore()
    app.unmount()
  }
})

test('after switching A -> B the B draft is fresh: prefill lands normally; onlyIfEmpty refusals never leak A residue', { timeout: 60_000 }, async () => {
  const api = stubApi()
  const { store, notices: readNotices } = makeStore()
  const app = mountComposer(store)
  try {
    app.show('composer-1', convA)
    await type(app.ta(), 'a 草稿')
    // Switch to B (the production Pane also remounts on the conversation key; prefill state resets to null with it)
    app.show('composer-2', convB)
    assert.equal(app.ta().value, '', 'B inherits nothing of the A draft')
    // Trigger a starter prefill inside B
    app.show('composer-2', convB, { text: 'B 引导词', tick: 1, onlyIfEmpty: true })
    await flush()
    assert.equal(app.ta().value, 'B 引导词', 'the B prefill lands normally')
    // With a non-empty draft the onlyIfEmpty prefill is refused: the warning belongs to B; the text stays
    app.show('composer-2', convB, { text: '另一个引导词', tick: 2, onlyIfEmpty: true })
    await flush()
    assert.equal(app.ta().value, 'B 引导词', 'the non-empty draft is not overwritten')
    const notices = readNotices()
    assert.equal(notices.length, 1)
    assert.equal(notices[0]!.conversationId, 2, 'the refusal warning belongs to the current conversation B')
    assert.match(String(notices[0]!.title), /Handle the current draft before picking a starter/)
    // Switch back to A: a fresh draft, no old A text nor B residue
    app.show('composer-1', convA)
    assert.equal(app.ta().value, '', 'switching back to A also yields a fresh draft (remounted on the conversation key)')
    assert.equal(app.chips().length, 0)
  } finally {
    api.restore()
    app.unmount()
  }
})

test('the env-bar block state never loops on unrelated re-renders: the blocker callback outlet keeps a stable identity', { timeout: 60_000 }, async () => {
  const api = stubApi()
  const { store } = makeStore({ detail: true })
  const app = mountComposer(store)
  try {
    app.show('composer-1', convA)
    const envBar = app.host.querySelector('.composer-env-bar')
    assert.notEqual(envBar, null, 'the empty conversation shows the starting-environment bar')
    // Editing the cwd draft -> dirty -> blocker={blocked:true}, a fresh object per render:
    // if onBlockerChange were unstable, SessionEnvBar's blocker effect would re-run every render and loop
    const cwdInput = envBar!.querySelector<HTMLInputElement>('input[aria-label="Conversation working directory"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      const tracker = (cwdInput as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
      const prev = tracker?.getValue() ?? ''
      setter.call(cwdInput, '/tmp/work')
      tracker?.setValue(prev)
      cwdInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    const sendBtn = app.host.querySelector<HTMLButtonElement>('button.btn-send')!
    assert.equal(sendBtn.disabled, true, 'sending is blocked while environment edits are unsaved')
    // Unrelated re-renders (text input) must not re-run/loop the blocker effect; a loop would throw Maximum update depth exceeded
    await type(app.ta(), 'hello')
    await type(app.ta(), 'hello world')
    assert.equal(app.host.querySelector<HTMLButtonElement>('button.btn-send')!.disabled, true, 'the block persists and the state stays stable')
    // Escape cancels -> the block lifts
    await act(async () => {
      cwdInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await flush()
    assert.equal(app.host.querySelector<HTMLButtonElement>('button.btn-send')!.disabled, false, 'sending recovers after cancel')
  } finally {
    api.restore()
    app.unmount()
  }
})

test('unrelated re-renders while the slash popover is open never re-bind its global keyboard listeners (boundary callback identities stay stable)', { timeout: 60_000 }, async () => {
  const gate = deferred<void>()
  const api = stubApi({ uploadGate: gate.promise })
  const { store } = makeStore()
  const app = mountComposer(store)
  // Count only after mounting: observe the popover own listeners, excluding unrelated mount-time ones
  const originalAdd = window.addEventListener.bind(window)
  const originalRemove = window.removeEventListener.bind(window)
  let keydownAdds = 0
  ;(window as unknown as Record<string, unknown>).addEventListener = function patchedAdd(
    this: Window, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions,
  ) {
    if (type === 'keydown') keydownAdds += 1
    return originalAdd(type, listener, options)
  } as unknown as typeof window.addEventListener
  ;(window as unknown as Record<string, unknown>).removeEventListener = function patchedRemove(
    this: Window, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions,
  ) {
    return originalRemove(type, listener, options)
  } as unknown as typeof window.removeEventListener
  try {
    app.show('composer-1', convA)
    await type(app.ta(), '/')
    assert.notEqual(app.slashPopover(), null, 'the slash popover is open')
    assert.equal(keydownAdds, 1, 'the popover global keyboard listener binds exactly once')
    // Unrelated state updates (upload count) trigger re-renders: the item set is unchanged, so listeners must not re-bind
    await paste(app.ta(), [testFile()])
    await flush()
    assert.equal(keydownAdds, 1, 'unrelated re-renders never re-bind the keyboard listeners (onPick/onClose/visible identities stay stable)')
    await act(async () => { gate.resolve() })
    await flush()
  } finally {
    ;(window as unknown as Record<string, unknown>).addEventListener = originalAdd as unknown as typeof window.addEventListener
    ;(window as unknown as Record<string, unknown>).removeEventListener = originalRemove as unknown as typeof window.removeEventListener
    api.restore()
    app.unmount()
  }
})
