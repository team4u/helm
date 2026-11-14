/**
 * 会话血统纯函数（builtin 插件共享；零插件代码互相 import）。
 *
 * builtin:workflow 的 steer 与 builtin:herdr 的 steer 动作都需要沿真实会话
 * 父链证明「caller 是目标会话的自身或祖先」；把该纯函数抽到本共享模块，
 * 两侧各自独立校验（herdr 直调路径不因 workflow 委托而豁免授权）。
 */

/**
 * 沿真实会话父链上行：ancestor 是否为 start 的自身或祖先。
 * 环（visited 防护）与缺父/不可读（parentOf 返回 undefined 断链）一律按
 * 「不可证明」处理返回 false，绝不虚构祖先关系。
 */
export function isAncestorOrSelf(
  start: number,
  ancestor: number,
  parentOf: (id: number) => number | undefined,
  maxHops = 1_024,
): boolean {
  let current: number | undefined = start
  const visited = new Set<number>()
  for (let hops = 0; current !== undefined && hops < maxHops; hops++) {
    if (current === ancestor) return true
    if (visited.has(current)) return false
    visited.add(current)
    current = parentOf(current)
  }
  return false
}
