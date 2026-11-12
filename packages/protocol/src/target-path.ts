/**
 * 跨平台目标路径形状判定（内核与插件共享的唯一实现，浏览器安全纯函数）。
 *
 * 目标节点可能与 Hub 异平台，路径形状按路径自身形式判定，
 * 不得用宿主 node:path 规则判定。本模块不得依赖 Node 内置模块
 * （protocol 被 Web 端按源码打包）。
 */

/**
 * 目标路径形状（按路径自身形式判定，与 Hub 宿主平台无关）：
 * - 'posix'：以 / 开头的 POSIX 绝对路径；
 * - 'win32'：Windows 盘符绝对（C:\x / C:/x）或 UNC / 根反斜杠（\\server\share）；
 * - undefined：相对路径（跟随会话 cwd 靶点的形状）。
 */
export function targetPathShape(p: string): 'posix' | 'win32' | undefined {
  if (p.startsWith('/')) return 'posix'
  if (p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p)) return 'win32'
  return undefined
}

/** 目标路径是否绝对（POSIX / 开头、Windows 盘符绝对或 UNC / 根反斜杠）。 */
export function isAbsoluteTargetPath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p)
}
