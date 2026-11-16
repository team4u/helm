import * as React from 'react'

export interface OverlayLayer {
  overlayZIndex: number
  contentZIndex: number
}

export const OverlayLayerContext = React.createContext<OverlayLayer | null>(null)

const overlayStack = new Set<symbol>()
const overlayStackListeners = new Set<() => void>()
const useOverlayStackEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect

function subscribeOverlayStack(listener: () => void): () => void {
  overlayStackListeners.add(listener)
  return () => overlayStackListeners.delete(listener)
}

function notifyOverlayStack(): void {
  for (const listener of overlayStackListeners) listener()
}

/**
 * Global overlay stack shared by all Dialog / AlertDialog components.
 * Each open overlay occupies 100 z-index levels, splitting one more level
 * between its inner content and its own backdrop, so nesting depth never
 * depends on hand-written fixed layers.
 */
export function useOverlayLayer(open: boolean): OverlayLayer | null {
  const [id] = React.useState(() => Symbol('overlay-layer'))
  const subscribe = React.useCallback((listener: () => void) => subscribeOverlayStack(listener), [])
  const getSnapshot = React.useCallback(() => [...overlayStack].indexOf(id), [id])
  const getServerSnapshot = React.useCallback(() => -1, [])
  const index = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  useOverlayStackEffect(() => {
    if (!open) return
    overlayStack.add(id)
    notifyOverlayStack()
    return () => {
      overlayStack.delete(id)
      notifyOverlayStack()
    }
  }, [id, open])

  // Before the first commit finishes registration, hand out the base layer;
  // it is swapped for the real stack position before the browser paints.
  const base = 1000 + Math.max(index, 0) * 100
  return open ? { overlayZIndex: base, contentZIndex: base + 1 } : null
}

/** Keeps menus, dropdowns and bubbles rendered through Portals inside an overlay above the current overlay layer. */
export function useOverlayChildStyle(style?: React.CSSProperties): React.CSSProperties | undefined {
  const layer = React.useContext(OverlayLayerContext)
  if (layer === null) return style
  return { ...style, zIndex: layer.contentZIndex + 1 }
}
