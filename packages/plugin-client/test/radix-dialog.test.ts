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

test('Dialog inline parameter: explicit forced inline rendering and custom class inheritance', { timeout: 60_000 }, () => {
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
              e('h1', { className: 'modal-title custom-title' }, 'Fullscreen title'),
            ),
          ),
        ),
      ),
    ),
  )

  assert.ok(html.includes('class="modal-backdrop modal-fullscreen-backdrop"'))
  assert.ok(html.includes('class="modal modal-fullscreen"'))
  assert.ok(html.includes('Fullscreen title'))
})

test('Dialog DOM interaction contract: role="dialog", accessibility associations and the onOpenChange full chain', { timeout: 60_000 }, async () => {
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
              e(DialogTitle, { id: 'test-title' }, 'Compute node management'),
              e(
                DialogClose,
                { asChild: true },
                e('button', { type: 'button', id: 'test-close-btn', 'aria-label': 'Close' }, 'Close'),
              ),
            ),
            e(DialogDescription, { id: 'test-description' }, 'Manage connected compute nodes and their configuration'),
            e(
              'div',
              { className: 'modal-body' },
              e('button', { type: 'button', id: 'test-inner-btn' }, 'Inner action button'),
            ),
          ),
        ),
      ),
    )
  }

  // First render open
  await act(async () => {
    root.render(e(TestApp, { open: true }))
  })

  const content = document.getElementById('test-content')
  assert.ok(content, 'DialogContent must be mounted into the DOM')
  assert.equal(content.getAttribute('role'), 'dialog', 'must carry role="dialog"')
  assert.equal(content.getAttribute('data-state'), 'open', 'must show the open state')

  const title = document.getElementById('test-title')
  assert.ok(title, 'DialogTitle must exist')

  const desc = document.getElementById('test-description')
  assert.ok(desc, 'DialogDescription must exist')

  // Clicking an inner button must not close
  const innerBtn = document.getElementById('test-inner-btn')
  assert.ok(innerBtn, 'the inner button must exist')
  await act(async () => {
    innerBtn.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  })
  assert.equal(lastOpenState, true, 'interacting with the inner button must not trigger onOpenChange(false)')

  // Clicking the close button must trigger onOpenChange(false)
  const closeBtn = document.getElementById('test-close-btn')
  assert.ok(closeBtn, 'the close button must exist')
  await act(async () => {
    closeBtn.click()
  })
  assert.equal(lastOpenState, false, 'clicking DialogClose must trigger onOpenChange(false)')
  assert.ok(openChanges.includes(false), 'the event stream must include a false record')

  // Re-render open to verify Escape listening
  lastOpenState = true
  await act(async () => {
    root.render(e(TestApp, { open: true }))
  })

  const reopenedContent = document.getElementById('test-content')
  assert.ok(reopenedContent, 'DialogContent exists after reopening')
  await act(async () => {
    reopenedContent.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  assert.equal(lastOpenState, false, 'pressing Escape must trigger onOpenChange(false)')

  // Re-render open to verify closing via overlay click
  lastOpenState = true
  await act(async () => {
    root.render(e(TestApp, { open: true }))
  })

  const overlay = document.getElementById('test-overlay')
  assert.ok(overlay, 'the overlay must exist')
  await act(async () => {
    overlay.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  })
  assert.equal(lastOpenState, false, 'clicking outside on the overlay must trigger onOpenChange(false)')

  // Unmount and cleanup
  await act(async () => {
    root.unmount()
  })
  assert.ok(document.getElementById('test-content') === null, 'DialogContent is destroyed from the DOM after unmount')
  container.remove()
})

test('Dialog maintains unbounded nesting levels automatically: a newly opened overlay and content always sit above the parent Dialog', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  function StackApp() {
    return e(React.Fragment, null,
      e(Dialog, { open: true },
        e(DialogPortal, { inline: true },
          e(DialogOverlay, { id: 'stack-parent-overlay', className: 'modal-backdrop' },
            e(DialogContent, { id: 'stack-parent-content', className: 'conversation-drawer' },
              e(DialogTitle, null, 'Parent drawer'),
            ),
          ),
        ),
      ),
      e(Dialog, { open: true, onOpenChange: () => {} },
        e(DialogPortal, { inline: true },
          e(DialogOverlay, { id: 'stack-child-overlay', className: 'modal-backdrop' },
            e(DialogContent, { id: 'stack-child-content', className: 'conversation-drawer' },
              e(DialogTitle, null, 'Child drawer'),
            ),
          ),
        ),
      ),
    )
  }

  try {
    await act(async () => { root.render(e(StackApp)) })
    const parentOverlay = document.getElementById('stack-parent-overlay')!
    const parentContent = document.getElementById('stack-parent-content')!
    assert.ok(parentOverlay && parentContent)

    await act(async () => { await Promise.resolve() })
    const childOverlay = document.getElementById('stack-child-overlay')!
    const childContent = document.getElementById('stack-child-content')!
    assert.ok(childOverlay && childContent)
    assert.ok(
      Number(childOverlay.style.zIndex) > Number(parentContent.style.zIndex),
      'the new Dialog overlay must cover the parent Dialog content',
    )
    assert.ok(
      Number(childContent.style.zIndex) > Number(childOverlay.style.zIndex),
      'the new Dialog content must cover its own overlay',
    )

    await act(async () => { root.unmount() })
  } finally {
    container.remove()
  }
})

test('Dialog with open=false renders no content initially', { timeout: 60_000 }, async () => {
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
            e(DialogTitle, null, 'Must not render'),
          ),
        ),
      ),
    )
  })

  assert.ok(document.getElementById('should-not-exist') === null, 'DialogContent must not exist in the DOM when initially open=false')

  await act(async () => {
    root.unmount()
  })
  container.remove()
})
