/**
 * Final anchor calibration for locate scrolls (pure DOM module, zero React, zero global state).
 *
 * Background: timeline historical-row render containment (content-visibility) turns neighbor
 * height estimates into real heights progressively during and after the smooth-scroll animation
 * (animations measured up to 2.6s; late shifts remain possible hundreds of ms after settling, and
 * releasing the target row can re-trigger an end-scrolled container's stick-to-bottom). The smooth
 * destination settles on the layout at call time; even with the browser's scroll-anchoring
 * compensation, an explicit locate target is not guaranteed to stay aligned once estimates converge,
 * hence bounded calibration.
 *
 * Mechanism: bounded bistable detection — watch the scroll position and target deviation frame by
 * frame; N consecutive unchanged frames (a plateau) triggers one correction and resets watching;
 * after alignment a quiet period keeps watching and corrects again on any shift; correction count
 * and frame count are both hard-capped — no infinite chasing, no sleep-based guessing. Active user
 * input (wheel/pointer/touch/keydown) cancels immediately. The returned cancel drops pending frames
 * and all listeners; the caller invokes it on new locates / conversation switches / unmount
 * (nothing survives a background tab's paused rAF).
 *
 * The module also provides `calibrateInitialStickToBottom` (see its docblock), reusing the same
 * "passive input listeners + bounded frame loop + cancel handle" lifecycle — no second scrolling
 * framework.
 */

/** Alignment convention between target and scroll container: start = top-to-top; center = target center to container center. */
export type AnchorAlignment = 'start' | 'center'

const ANCHOR_TOLERANCE_PX = 2
/** Plateau detection: scroll position and target deviation unchanged for N consecutive frames. */
const ANCHOR_SETTLE_STABLE_FRAMES = 3
/** Quiet watch period after alignment (frames): estimate-to-real late shifts were measured hundreds of ms after settling. */
const ANCHOR_WATCH_GRACE_FRAMES = 45
const ANCHOR_SETTLE_MAX_FRAMES = 450
const ANCHOR_MAX_CORRECTIONS = 3

const USER_CANCEL_EVENTS = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const

/**
 * Start the final anchor calibration for `target` inside `scroller`; returns an idempotent cancel.
 * Only call right after issuing `scrollIntoView({ behavior: 'smooth' })`.
 */
export function calibrateAnchorAfterSmoothScroll(opts: {
  scroller: HTMLElement
  target: HTMLElement
  alignment: AnchorAlignment
}): () => void {
  const { scroller, target, alignment } = opts
  let finished = false
  let corrections = 0
  let frame = 0
  const finish = (): void => {
    if (finished) return
    finished = true
    if (frame !== 0) cancelAnimationFrame(frame)
    for (const type of USER_CANCEL_EVENTS) scroller.removeEventListener(type, finish)
  }
  for (const type of USER_CANCEL_EVENTS) scroller.addEventListener(type, finish, { passive: true })

  const measureDelta = (): number => {
    const t = target.getBoundingClientRect()
    const s = scroller.getBoundingClientRect()
    return alignment === 'center' ? (t.top + t.height / 2) - (s.top + s.height / 2) : t.top - s.top
  }

  let lastTop = scroller.scrollTop
  let lastDelta = Number.NaN
  let quietFrames = 0
  let frames = 0
  const tick = (): void => {
    if (finished) return
    if (!target.isConnected) {
      finish()
      return
    }
    frames += 1
    if (frames > ANCHOR_SETTLE_MAX_FRAMES) {
      finish()
      return
    }
    const top = scroller.scrollTop
    const delta = measureDelta()
    const settled = top === lastTop && Math.abs(delta - lastDelta) <= 1
    lastTop = top
    lastDelta = delta
    quietFrames = settled ? quietFrames + 1 : 0
    if (quietFrames >= ANCHOR_SETTLE_STABLE_FRAMES) {
      if (Math.abs(delta) > ANCHOR_TOLERANCE_PX) {
        if (corrections >= ANCHOR_MAX_CORRECTIONS) {
          finish()
          return
        }
        corrections += 1
        quietFrames = 0
        scroller.scrollTop += delta
      } else if (quietFrames >= ANCHOR_WATCH_GRACE_FRAMES) {
        finish()
      }
    }
    if (!finished) frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
  return finish
}

// ---------------------------------------------------------------------------
// Initial bottom-stick calibration
// ---------------------------------------------------------------------------

/** Distance-to-bottom tolerance (px): |scrollHeight - scrollTop - clientHeight| within it counts as stuck. */
const BOTTOM_TOLERANCE_PX = 1
/** Plateau detection: scrollTop and scrollHeight unchanged for N consecutive frames (changing height = still settling). */
const BOTTOM_STABLE_FRAMES = 3
/** Quiet watch period after sticking (frames): late estimate-to-real shifts still get corrected. */
const BOTTOM_WATCH_GRACE_FRAMES = 48
/** Hard cap: total window frames; continuous height changes only exhaust the cap, never an unbounded rAF. */
const BOTTOM_MAX_FRAMES = 300
/** Hard cap: total stick corrections. */
const BOTTOM_MAX_CORRECTIONS = 8
/** Arrow keys treated as user takeover (including ArrowDown: any takeover during the window ends the initial stick). */
const SCROLL_NAV_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
])

/** How the initial bottom-stick window ended: natural settling / physical user input / explicit cancel. */
export type InitialBottomEndReason = 'settled' | 'user-input' | 'cancelled'

/**
 * One-shot initial bottom-stick calibration.
 *
 * Background: historical-row render containment (content-visibility estimates) makes the first
 * `scrollTop = scrollHeight` land on the estimated total; nearby rows then lay out for real and
 * the height shift leaves the initial position hanging. While the conversation is idle, the
 * stick ResizeObserver protection (which never disturbs history browsing) would never chase
 * that error.
 *
 * Mechanism: a bounded frame loop measuring "distance to bottom + total height" each frame. On a
 * plateau (both unchanged for N frames) with distance beyond tolerance, correct once
 * (`scrollTop = scrollHeight`, clamped by the browser); after sticking, keep watching a quiet
 * period and correct late shifts too. Frames and corrections are hard-capped; continuous height
 * change only exhausts the cap. Physical user input (wheel / pointerdown / touchstart / scroll
 * arrow keys) ends immediately reporting `'user-input'` so the caller releases bottom-stick
 * synchronously — without waiting for scroll (scroll fires async; streaming bottom-follow
 * writes may arrive first).
 *
 * Returns an idempotent cancel: drops pending frames and listeners, ending as `'cancelled'`;
 * used on conversation switch / unmount / supersede by an explicit locate — distinguishable
 * from a natural end so the caller can decide whether a restart is allowed.
 */
export function calibrateInitialStickToBottom(opts: {
  scroller: HTMLElement
  /** Fires exactly once no matter how the window ends. On `'user-input'` the caller must release the stick synchronously. */
  onEnd?: (reason: InitialBottomEndReason) => void
}): () => void {
  const { scroller, onEnd } = opts
  let finished = false
  let frame = 0
  const finish = (reason: InitialBottomEndReason): void => {
    if (finished) return
    finished = true
    if (frame !== 0) cancelAnimationFrame(frame)
    for (const type of USER_CANCEL_EVENTS) {
      if (type !== 'keydown') scroller.removeEventListener(type, onPhysical)
    }
    scroller.removeEventListener('keydown', onKeyDown)
    onEnd?.(reason)
  }
  const onPhysical = (): void => finish('user-input')
  const onKeyDown = (event: KeyboardEvent): void => {
    if (SCROLL_NAV_KEYS.has(event.key)) finish('user-input')
  }
  for (const type of USER_CANCEL_EVENTS) {
    if (type !== 'keydown') scroller.addEventListener(type, onPhysical, { passive: true })
  }
  scroller.addEventListener('keydown', onKeyDown, { passive: true })

  let corrections = 0
  let quietFrames = 0
  let frames = 0
  let lastTop = Number.NaN
  let lastHeight = Number.NaN
  const tick = (): void => {
    if (finished) return
    // The scroll container left the document (component unmount): treat as a natural end
    // (the effect cleanup's cancel arriving later is an idempotent no-op).
    if (!scroller.isConnected) {
      finish('settled')
      return
    }
    frames += 1
    if (frames > BOTTOM_MAX_FRAMES) {
      finish('settled')
      return
    }
    const top = scroller.scrollTop
    const height = scroller.scrollHeight
    const distanceFromBottom = height - top - scroller.clientHeight
    const settled = top === lastTop && height === lastHeight
    lastTop = top
    lastHeight = height
    quietFrames = settled ? quietFrames + 1 : 0
    if (quietFrames >= BOTTOM_STABLE_FRAMES) {
      if (distanceFromBottom > BOTTOM_TOLERANCE_PX) {
        if (corrections >= BOTTOM_MAX_CORRECTIONS) {
          finish('settled')
          return
        }
        corrections += 1
        quietFrames = 0
        // The browser clamps out-of-range writes to scrollHeight - clientHeight; read back to sync the baseline.
        scroller.scrollTop = scroller.scrollHeight
        lastTop = scroller.scrollTop
      } else if (quietFrames >= BOTTOM_WATCH_GRACE_FRAMES) {
        finish('settled')
        return
      }
    }
    if (!finished) frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
  return () => finish('cancelled')
}
