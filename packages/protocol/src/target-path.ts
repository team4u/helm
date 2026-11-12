/**
 * 跨平台目标路径形状判定与词法规则子集（内核与插件共享的唯一实现，
 * 浏览器安全纯函数）。
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

// ---------------------------------------------------------------------------
// 目标路径词法规则（按形状选择的纯函数子集）
// ---------------------------------------------------------------------------

const FORWARD_SLASH = 47
const BACKWARD_SLASH = 92
const COLON = 58

const isWinSeparator = (code: number): boolean => code === FORWARD_SLASH || code === BACKWARD_SLASH
const isDriveLetter = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122) // A-Z / a-z

/**
 * 目标路径词法规则子集：normalize / join / dirname / basename。
 *
 * 语义对齐 node:path 的 posix / win32 同名函数（结尾分隔符保留、dirname
 * 不消解 '..'、win32 双分隔符与设备根（盘符 / UNC）等行为一致），但实现为
 * 浏览器安全纯函数——本包被 Web 端按源码打包，禁止依赖 Node 内置模块。
 * resolve / relative 等依赖进程 cwd / 大小写规则的语义不在此子集，留在
 * 内核（Node 环境）。内核测试以 node:path 为 oracle 做逐用例对齐校验。
 */
export interface TargetPathRules {
  /** 词法归一化：折叠重复分隔符、消解 '.' 与 '..' 段（保留单个结尾分隔符）。 */
  normalize(p: string): string
  /** 连接多段后归一化（忽略空段；全空返回 '.'）。 */
  join(...parts: string[]): string
  /** 截到最后一个路径段之前（不消解 '..'；仅剩根时返回根）。 */
  dirname(p: string): string
  /** 取最后一个路径段（剥离结尾分隔符；仅有根时返回 '' 或设备前缀语义）。 */
  basename(p: string): string
}

/** 按目标路径形状选择词法规则（形状未知按 POSIX；不依赖 Hub 宿主平台）。 */
export function pathRulesForShape(shape: 'posix' | 'win32' | undefined): TargetPathRules {
  return shape === 'win32' ? win32Rules : posixRules
}

const posixRules: TargetPathRules = {
  normalize(p: string): string {
    if (p.length === 0) return '.'
    const isAbsolute = p.charCodeAt(0) === FORWARD_SLASH
    const trailing = p.charCodeAt(p.length - 1) === FORWARD_SLASH
    const segments: string[] = []
    for (const segment of p.split('/')) {
      if (segment === '' || segment === '.') continue
      if (segment === '..') {
        if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop()
        else if (!isAbsolute) segments.push('..')
        continue
      }
      segments.push(segment)
    }
    const joined = segments.join('/')
    if (joined.length === 0) return isAbsolute ? '/' : trailing ? './' : '.'
    return (isAbsolute ? '/' : '') + joined + (trailing ? '/' : '')
  },

  join(...parts: string[]): string {
    let joined: string | undefined
    for (const part of parts) {
      if (part.length === 0) continue
      joined = joined === undefined ? part : `${joined}/${part}`
    }
    return joined === undefined ? '.' : posixRules.normalize(joined)
  },

  dirname(p: string): string {
    if (p.length === 0) return '.'
    let end = p.length
    while (end > 1 && p.charCodeAt(end - 1) === FORWARD_SLASH) end -= 1
    const q = p.slice(0, end)
    const i = q.lastIndexOf('/')
    if (i < 0) return '.'
    // POSIX 恰好两个前导斜杠（'//x'）为实现自定义根：dirname 保留 '//'。
    if (
      i === 1 &&
      q.charCodeAt(0) === FORWARD_SLASH &&
      q.charCodeAt(1) === FORWARD_SLASH &&
      q.charCodeAt(2) !== FORWARD_SLASH
    ) {
      return '//'
    }
    if (i === 0) return '/'
    return q.slice(0, i)
  },

  basename(p: string): string {
    let end = p.length
    while (end > 0 && p.charCodeAt(end - 1) === FORWARD_SLASH) end -= 1
    if (end === 0) return ''
    let start = end
    while (start > 0 && p.charCodeAt(start - 1) !== FORWARD_SLASH) start -= 1
    return p.slice(start, end)
  },
}

/** win32 根解析结果：设备前缀 + 根长度（设备 + 根分隔符）。 */
interface Win32Root {
  /** 盘符（'C:'）或 UNC 设备（'\\\server\share'，分隔符统一为 '\'）；无设备为 ''。 */
  device: string
  /** 设备 + 根分隔符长度（盘符无根分隔符时为 2；无根为 0）。 */
  rootLen: number
  isAbsolute: boolean
}

/** 解析 win32 路径的设备与根：恰好两个前导分隔符 + 非空 server + 分隔符 + 非空 share 才算 UNC。 */
function win32ParseRoot(p: string): Win32Root {
  const len = p.length
  if (len === 0) return { device: '', rootLen: 0, isAbsolute: false }
  const first = p.charCodeAt(0)
  if (isWinSeparator(first)) {
    if (isWinSeparator(p.charCodeAt(1))) {
      let j = 2
      while (j < len && !isWinSeparator(p.charCodeAt(j))) j += 1
      if (j > 2 && j < len) {
        let k = j + 1
        while (k < len && !isWinSeparator(p.charCodeAt(k))) k += 1
        if (k > j + 1) {
          return {
            device: `\\\\${p.slice(2, j)}\\${p.slice(j + 1, k)}`,
            rootLen: k + (k < len ? 1 : 0),
            isAbsolute: true,
          }
        }
      }
    }
    return { device: '', rootLen: 1, isAbsolute: true }
  }
  if (len >= 2 && isDriveLetter(first) && p.charCodeAt(1) === COLON) {
    const rootLen = len > 2 && isWinSeparator(p.charCodeAt(2)) ? 3 : 2
    return { device: p.slice(0, 2), rootLen, isAbsolute: rootLen === 3 }
  }
  return { device: '', rootLen: 0, isAbsolute: false }
}

const win32Rules: TargetPathRules = {
  normalize(p: string): string {
    if (p.length === 0) return '.'
    const { device, rootLen, isAbsolute } = win32ParseRoot(p)
    const trailing = isWinSeparator(p.charCodeAt(p.length - 1))
    const rawSegments = p.slice(rootLen).split(/[\\/]/)
    const segments: string[] = []
    for (const segment of rawSegments) {
      if (segment === '' || segment === '.') continue
      if (segment === '..') {
        if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop()
        else if (!isAbsolute) segments.push('..')
        // 绝对路径在根处钳制：'..' 不越根也不保留（与 node:path win32 一致）。
        continue
      }
      segments.push(segment)
    }
    const joined = segments.join('\\')
    if (isAbsolute) {
      const base = device.length > 0 ? `${device}\\` : '\\'
      return joined.length === 0 ? base : `${base}${joined}${trailing ? '\\' : ''}`
    }
    if (device.length > 0) {
      // 盘符相对（C:relative）：不引入根分隔符；空段结果补 '.'（node 行为）。
      return joined.length === 0 ? `${device}.` : `${device}${joined}${trailing ? '\\' : ''}`
    }
    // 相对结果若可被再解析为设备路径（首段盘符，或任一原始段以 ':' 结尾
    //——含已被 '..' 抵消的段），加 '.\' 前缀消歧（与 node:path
    // win32.normalize 一致）。
    const body = joined.length === 0 ? (trailing ? '.\\' : '.') : `${joined}${trailing ? '\\' : ''}`
    if (joined.charCodeAt(1) === COLON || rawSegments.some((s) => s.endsWith(':'))) {
      return `.\\${body}`
    }
    return body
  },

  join(...parts: string[]): string {
    let joined: string | undefined
    for (const part of parts) {
      if (part.length === 0) continue
      joined = joined === undefined ? part : `${joined}\\${part}`
    }
    return joined === undefined ? '.' : win32Rules.normalize(joined)
  },

  dirname(p: string): string {
    if (p.length === 0) return '.'
    const { device, rootLen } = win32ParseRoot(p)
    let end = p.length
    while (end > Math.max(rootLen, 1) && isWinSeparator(p.charCodeAt(end - 1))) end -= 1
    const q = p.slice(0, end)
    let i = -1
    for (let k = q.length - 1; k >= 0; k -= 1) {
      if (isWinSeparator(q.charCodeAt(k))) {
        i = k
        break
      }
    }
    if (i < 0) {
      // 无分隔符：盘符（含盘符相对 'C:a' 的父目录）返回设备，其余返回 '.'。
      return device.length > 0 ? device : '.'
    }
    if (i < rootLen) return p.slice(0, rootLen)
    return q.slice(0, i)
  },

  basename(p: string): string {
    let end = p.length
    while (end > 0 && isWinSeparator(p.charCodeAt(end - 1))) end -= 1
    const q = p.slice(0, end)
    // 盘符前缀（C:）之后即名称边界：'C:a' 的 basename 是 'a'、'C:' 是 ''。
    const floor = q.length >= 2 && isDriveLetter(q.charCodeAt(0)) && q.charCodeAt(1) === COLON ? 2 : 0
    let start = q.length
    while (start > floor && !isWinSeparator(q.charCodeAt(start - 1))) start -= 1
    return q.slice(start)
  },
}
