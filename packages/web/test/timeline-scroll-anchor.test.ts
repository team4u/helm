import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { captureTimelineScrollAnchor, restoreTimelineScrollAnchor } from '../src/conversation/timeline-scroll-anchor.js'

try {
  GlobalRegistrator.register()
} catch {
  // Already registered by another test module.
}

test('captureTimelineScrollAnchor selects the first row intersecting the viewport', { timeout: 60_000 }, () => {
  const scroller = document.createElement('div')
  const visible = document.createElement('div')
  visible.dataset.entryId = 'visible'
  scroller.append(visible)
  document.body.append(scroller)
  scroller.getBoundingClientRect = () => ({ top: 100, bottom: 300, left: 0, width: 200, height: 200 } as DOMRect)
  visible.getBoundingClientRect = () => ({ top: 120, bottom: 160 } as DOMRect)
  const originalElementFromPoint = document.elementFromPoint
  document.elementFromPoint = () => visible

  try {
    const anchor = captureTimelineScrollAnchor(scroller)
    assert.equal(anchor?.element, visible)
    assert.equal(anchor?.top, 120)
  } finally {
    document.elementFromPoint = originalElementFromPoint
  }
})

test('restoreTimelineScrollAnchor corrects only residual movement', { timeout: 60_000 }, () => {
  const scroller = document.createElement('div')
  const visible = document.createElement('div')
  visible.dataset.entryId = 'visible'
  scroller.append(visible)
  document.body.append(scroller)
  let top = 0
  const writes: number[] = []
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => { top = value; writes.push(value) },
  })
  let anchorTop = 100
  visible.getBoundingClientRect = () => ({ top: anchorTop, bottom: anchorTop + 40 } as DOMRect)

  const anchor = { element: visible, top: 100 }
  restoreTimelineScrollAnchor(scroller, anchor)
  assert.deepEqual(writes, [], 'native scroll anchoring already preserved the row')

  anchorTop = 145
  restoreTimelineScrollAnchor(scroller, anchor)
  assert.deepEqual(writes, [45], 'only the remaining 45px shift is corrected')
})

test('restoreTimelineScrollAnchor ignores an anchor detached before history loading completes', { timeout: 60_000 }, () => {
  const scroller = document.createElement('div')
  const detached = document.createElement('div')
  let writes = 0
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => 0,
    set: () => { writes += 1 },
  })
  detached.getBoundingClientRect = () => ({ top: 200, bottom: 240 } as DOMRect)

  restoreTimelineScrollAnchor(scroller, { element: detached, top: 100 })
  assert.equal(writes, 0)
})
