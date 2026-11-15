/**
 * 严格 SemVer 契约（semver.org 官方语法的严格子集，全仓唯一实现）。
 *
 * 消费方：kernel 升级边界校验（runtime/semver.ts、http/node-routes.ts）
 * 与 helm-node 自升级引擎（daemon/upgrader.ts）——各自保留自己的错误
 * 信封（HelmError / UpgradeRejectedError），解析与优先级比较只此一份。
 * desktop 不依赖工作区包，保留同构本地实现（runners.ts），契约以本文件为准。
 *
 * 语义：不接受 v 前缀与宽松格式；build metadata 语法允许但按规范不参与
 * 优先级比较；预发布优先级为 正式版 > 预发布、数字标识 < 字母数字标识、
 * 字母段按 ASCII 字典序。非法输入显式抛错，绝不静默吞掉（诚实性纪律）。
 */

/** 官方 SemVer 语法（严格 x.y.z[-pre][+build]；不允许 v 前缀）。 */
const STRICT_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

/** 严格 SemVer 的结构化解析结果（build metadata 按规范不参与比较，不保留）。 */
export interface StrictSemver {
  readonly core: readonly [number, number, number]
  readonly prerelease: readonly string[]
}

/** 非法版本号进入需要严格 SemVer 的路径时抛出；由各消费方映射为自己的错误信封。 */
export class SemverFormatError extends Error {
  constructor(text: string) {
    super(`非法严格 SemVer："${text}"（要求 x.y.z[-pre][+build]，不允许 v 前缀）`)
    this.name = 'SemverFormatError'
  }
}

/** 是否为严格 SemVer（不抛错版本，供「是否合法」判断场景）。 */
export function isStrictSemver(text: string): boolean {
  return STRICT_SEMVER_PATTERN.test(text)
}

/** 解析严格 SemVer；非法返回 null（需要显式拒绝语义时用 compareStrictSemver / SemverFormatError）。 */
export function parseStrictSemver(text: string): StrictSemver | null {
  const match = STRICT_SEMVER_PATTERN.exec(text)
  if (match === null) return null
  const [, major, minor, patch, prerelease] = match
  return {
    core: [Number(major), Number(minor), Number(patch)],
    prerelease: prerelease === undefined ? [] : prerelease.split('.'),
  }
}

/** 剥离首尾空白与单个 v/V 前缀（Web/UI 输入容错口径），不校验剩余部分。 */
export function stripSemverVPrefix(raw: string): string {
  const trimmed = raw.trim()
  return trimmed.startsWith('v') || trimmed.startsWith('V') ? trimmed.slice(1) : trimmed
}

/**
 * 严格 SemVer 优先级比较：-1 / 0 / 1。任一侧非法抛 SemverFormatError
 * （显式拒绝，绝不静默当作相等或按 0 处理）。
 */
export function compareStrictSemver(a: string, b: string): number {
  const pa = parseStrictSemver(a)
  const pb = parseStrictSemver(b)
  if (pa === null) throw new SemverFormatError(a)
  if (pb === null) throw new SemverFormatError(b)
  for (let i = 0; i < 3; i++) {
    if (pa.core[i]! > pb.core[i]!) return 1
    if (pa.core[i]! < pb.core[i]!) return -1
  }
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0
  // 无预发布（正式版）> 有预发布。
  if (pa.prerelease.length === 0) return 1
  if (pb.prerelease.length === 0) return -1
  const len = Math.max(pa.prerelease.length, pb.prerelease.length)
  for (let i = 0; i < len; i++) {
    const sa = pa.prerelease[i]
    const sb = pb.prerelease[i]
    if (sa === undefined) return -1
    if (sb === undefined) return 1
    if (sa === sb) continue
    const na = /^\d+$/.test(sa) ? Number(sa) : undefined
    const nb = /^\d+$/.test(sb) ? Number(sb) : undefined
    if (na !== undefined && nb !== undefined) return na > nb ? 1 : -1
    if (na !== undefined) return -1 // 数字标识符 < 字母数字标识符
    if (nb !== undefined) return 1
    return sa < sb ? -1 : 1 // ASCII 字典序，不用 localeCompare
  }
  return 0
}
