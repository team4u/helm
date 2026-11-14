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
 * 所有 Dialog / AlertDialog 共用的全局浮层栈。
 * 每个打开的浮层占用 100 个 z-index，内部内容与自身遮罩再分 1 层，
 * 因此嵌套深度不依赖手写的固定层级。
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

  // 首次提交尚未完成注册时先给基础层；浏览器绘制前会换成真实栈位。
  const base = 1000 + Math.max(index, 0) * 100
  return open ? { overlayZIndex: base, contentZIndex: base + 1 } : null
}

/** 让浮层内部通过 Portal 渲染的菜单、下拉框和气泡位于当前浮层之上。 */
export function useOverlayChildStyle(style?: React.CSSProperties): React.CSSProperties | undefined {
  const layer = React.useContext(OverlayLayerContext)
  if (layer === null) return style
  return { ...style, zIndex: layer.contentZIndex + 1 }
}
