/** Preserve one visible timeline row across content insertion above the viewport. */
export interface TimelineScrollAnchor {
  element: HTMLElement
  top: number
}

export function captureTimelineScrollAnchor(scroller: HTMLElement): TimelineScrollAnchor | undefined {
  const viewport = scroller.getBoundingClientRect()
  const x = viewport.left + viewport.width / 2
  const sampleYs = [
    viewport.top + Math.min(48, viewport.height / 4),
    viewport.top + viewport.height / 2,
    viewport.bottom - Math.min(24, viewport.height / 8),
  ]
  for (const y of sampleYs) {
    const hit = document.elementFromPoint(x, y)
    const row = hit instanceof HTMLElement ? hit.closest<HTMLElement>('[data-entry-id]') : null
    if (row !== null && scroller.contains(row)) {
      return { element: row, top: row.getBoundingClientRect().top }
    }
  }
  return undefined
}

export function restoreTimelineScrollAnchor(
  scroller: HTMLElement,
  anchor: TimelineScrollAnchor | undefined,
): void {
  if (anchor === undefined || !anchor.element.isConnected || !scroller.contains(anchor.element)) return
  const delta = anchor.element.getBoundingClientRect().top - anchor.top
  if (Math.abs(delta) > 1) scroller.scrollTop += delta
}
