/**
 * 视口媒体查询 Hook（matchMedia 驱动，SSR 与测试环境安全降级为 false）。
 * 供侧栏区分移动抽屉与桌面常驻形态等响应式渲染语义；不承担业务判定。
 * 移动端断点复用 lib/types 的唯一事实源（COMPACT_MOBILE_MAX_WIDTH），
 * 与 responsive.css / isCompactMobileViewport 同口径。
 */
import { useSyncExternalStore } from 'react'
import { COMPACT_MOBILE_MAX_WIDTH, isCompactMobileViewport } from './types.js'

function subscribeMediaQuery(query: string, listener: () => void): () => void {
  const mql = window.matchMedia(query)
  mql.addEventListener('change', listener)
  return () => mql.removeEventListener('change', listener)
}

/** 当前视口是否匹配指定媒体查询（无 window 环境恒为 false；有 window 时服务端渲染同读现场）。 */
export function useMediaQuery(query: string): boolean {
  const snapshot = () => (typeof window === 'undefined' ? false : window.matchMedia(query).matches)
  return useSyncExternalStore(
    (listener) => subscribeMediaQuery(query, listener),
    snapshot,
    snapshot,
  )
}

/** 当前是否移动端视口（移动抽屉形态语义的总开关；与 isCompactMobileViewport 同口径）。 */
export function useIsMobileViewport(): boolean {
  return useSyncExternalStore(
    (listener) => subscribeMediaQuery(`(max-width: ${COMPACT_MOBILE_MAX_WIDTH}px)`, listener),
    isCompactMobileViewport,
    isCompactMobileViewport,
  )
}
