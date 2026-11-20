/** 本浏览器已读的 Hub 升级版本（localStorage 读写，纯函数便于测试注入）。 */
const SEEN_STORAGE_KEY = 'helmx:hub-changelog-seen'

export function readSeenVersion(): string | null {
  try {
    return globalThis.localStorage?.getItem(SEEN_STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

export function markSeenVersion(version: string): void {
  try {
    globalThis.localStorage?.setItem(SEEN_STORAGE_KEY, version)
  } catch {
    // storage unavailable: the notice reappears next visit; honest, harmless
  }
}
