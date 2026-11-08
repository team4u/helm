import { useEffect, useState } from 'react'

/** 根据是否处于移动端或小屏幕模式生成 Composer 占位符提示文案 */
export function getComposerPlaceholder(working: boolean, isMobile: boolean): string {
  if (working) {
    // 移动端占位符保持极短，避免窄屏折行撑高输入区
    return isMobile ? '补充说明或排队指令…' : '补充说明或输入下一条指令（Enter 排队发送 · ⌘/Ctrl+Enter 插话引导）'
  }
  return isMobile ? '输入消息…' : '输入消息；/ 命令与技能，@ 引用产物，⌘V 粘贴附件'
}

/** 监听视口宽度是否在移动端阈值内（默认 <= 680px） */
export function useIsMobile(maxWidth = 680): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(`(max-width: ${maxWidth}px)`).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(`(max-width: ${maxWidth}px)`)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handler)
      return () => mql.removeEventListener('change', handler)
    } else if (typeof (mql as unknown as { addListener?: (cb: (e: MediaQueryListEvent) => void) => void }).addListener === 'function') {
      (mql as unknown as { addListener: (cb: (e: MediaQueryListEvent) => void) => void }).addListener(handler)
      return () => {
        (mql as unknown as { removeListener: (cb: (e: MediaQueryListEvent) => void) => void }).removeListener(handler)
      }
    }
  }, [maxWidth])

  return isMobile
}
