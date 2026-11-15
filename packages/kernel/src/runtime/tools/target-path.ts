/**
 * 目标路径词法解析（read/write/edit/register_artifact 共用）。
 *
 * 跨平台路径形状：目标路径一律按其自身形状（POSIX 绝对 / Windows 盘符绝对 /
 * UNC）选用纯 posix/win32 规则做词法解析，绝不用 Hub 宿主 node:path 默认
 * 规则解析远端路径（Linux Hub 上 resolve('C:\\workspace') 会得到错误结果，
 * Windows/mac/Linux 跨平台承诺即不成立）；盘符相对路径（C:relative）语义
 * 依赖进程当前目录，一律显式拒绝。
 *
 * 形状判定与词法规则子集（normalize/join/dirname/basename）已收口
 * @helm/protocol（浏览器安全纯函数，内核与 @helm/plugins 共享）；依赖
 * node:path 完整实现的 resolve 语义（进程 cwd / 大小写规则）留在内核
 * （Node 环境）；isAbsoluteTargetPath/targetPathShape 由 tools.ts 再导出
 * 供既有相对路径引用保持稳定。
 */
import { isAbsoluteTargetPath, normalizeTargetPath, targetPathShape, type TargetPlatform } from '@helm/protocol'
import { posix, win32 } from 'node:path'

/** Windows 盘符（不区分大小写）：C: / c: 等。 */
const WINDOWS_DRIVE = /^[A-Za-z]:/
/** Windows 盘符相对（C:relative / 裸 C:）：语义依赖进程当前目录，靶点执行拒绝。 */
const WINDOWS_DRIVE_RELATIVE = /^[A-Za-z]:($|[^\\/])/

/**
 * 按形状选 node:path 完整规则（内核 Node 环境专用：resolve/relative 等
 * 语义依赖 Node 实现；词法子集见 @helm/protocol pathRulesForShape）。
 */
export function nodePathForShape(shape: 'posix' | 'win32' | undefined): typeof posix | typeof win32 {
  return shape === 'win32' ? win32 : posix
}

/**
 * 按目标形状解析绝对路径：base（会话 cwd）仅作相对路径基准，绝对路径与
 * ../ 跨目录均合法；盘符相对路径（C:relative / 裸 C:）一律拒绝（依赖进程
 * cwd，语义不可预测）。
 *
 * platform === 'win32'（目标节点平台已知为 Windows）：base 与绝对 raw 先经
 * protocol normalizeTargetPath 做确定性规范化（WSL /mnt/<盘符>、Git Bash
 * /<盘符>、//server/share POSIX 视图转规范 Windows 路径；无法映射的裸
 * POSIX 根显式拒绝并保留原始路径），再按 win32 规则解析相对段。platform
 * 缺省（远端平台未知）：沿用按形状选规则的既有语义（不猜平台），
 * Linux/macOS 与远端 POSIX 语义不变。
 */
export function resolveTargetPath(
  raw: string,
  base: string,
  platform?: TargetPlatform,
): { ok: true; abs: string } | { ok: false; reason: string } {
  if (WINDOWS_DRIVE.test(raw) && WINDOWS_DRIVE_RELATIVE.test(raw)) {
    return { ok: false, reason: `盘符相对路径依赖进程当前目录，拒绝：${raw}` }
  }
  if (platform === 'win32') {
    const baseN = normalizeTargetPath(base, 'win32')
    if (!baseN.ok) return { ok: false, reason: baseN.reason }
    const rawN = isAbsoluteTargetPath(raw) ? normalizeTargetPath(raw, 'win32') : undefined
    if (rawN !== undefined && !rawN.ok) return { ok: false, reason: rawN.reason }
    return { ok: true, abs: win32.resolve(baseN.path, rawN !== undefined ? rawN.path : raw) }
  }
  const shape = targetPathShape(raw) ?? targetPathShape(base)
  const rules = nodePathForShape(shape)
  return { ok: true, abs: rules.resolve(base, raw) }
}
