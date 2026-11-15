/**
 * 会话 Composer 本地草稿脏状态桥接（模块级外部 store，无组件）：
 *
 * - 单一事实来源仍是 useComposerSend 的 React state（text / 编辑锚点 / 附件 /
 *   发送与上传在途）；本桥接只汇聚「是否存在未提交本地现场」这一个布尔事实，
 *   供版本自动刷新挂起判定（use-version-watcher）订阅，不引入平行草稿系统；
 * - 上报键为组件实例级唯一标识（React useId）：主屏 / 分屏 / 抽屉可同时渲染
 *   同一会话的 Composer，实例键防止互相覆盖脏状态；卸载即清除；
 * - 订阅回调只在聚合布尔值变化时触发（getSnapshot 为原始值，天然稳定）。
 */
export interface ComposerDirtySnapshot {
  /** 草稿文本非空（按发送同样的 trim 语义）。 */
  hasDraftText: boolean
  /** 历史编辑锚点在身（编辑目标尚未落库）。 */
  editingEntry: boolean
  /** 待发送附件在身。 */
  hasAttachments: boolean
  /** 发送或附件上传在途。 */
  busy: boolean
}

const reports = new Map<string, ComposerDirtySnapshot>()
const listeners = new Set<() => void>()

function notifyIfChanged(before: boolean): void {
  if (composerDirty() !== before) {
    for (const listener of listeners) listener()
  }
}

/** 聚合判定：任一在挂 Composer 存在未提交本地现场。 */
export function composerDirty(): boolean {
  for (const snapshot of reports.values()) {
    if (isComposerDirtySnapshot(snapshot)) return true
  }
  return false
}

/** 纯函数：单份快照是否携带未提交本地现场。 */
export function isComposerDirtySnapshot(snapshot: ComposerDirtySnapshot): boolean {
  return snapshot.hasDraftText || snapshot.editingEntry || snapshot.hasAttachments || snapshot.busy
}

/** 上报（或更新）一个 Composer 实例的脏状态快照。 */
export function setComposerDirty(key: string, snapshot: ComposerDirtySnapshot): void {
  const before = composerDirty()
  reports.set(key, snapshot)
  notifyIfChanged(before)
}

/** 清除一个 Composer 实例的上报（组件卸载）。 */
export function clearComposerDirty(key: string): void {
  if (!reports.has(key)) return
  const before = composerDirty()
  reports.delete(key)
  notifyIfChanged(before)
}

/** 订阅聚合脏状态变化（getSnapshot 用 composerDirty）。 */
export function subscribeComposerDirty(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
