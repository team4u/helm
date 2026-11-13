/**
 * 跨平台目标路径形状判定与词法规则子集（内核与插件共享的唯一实现，
 * 浏览器安全纯函数）。
 *
 * 目标节点可能与 Hub 异平台，路径形状按路径自身形式判定，
 * 不得用宿主 node:path 规则判定。本模块不得依赖 Node 内置模块
 * （protocol 被 Web 端按源码打包）。
 *
 * 另提供 normalizeTargetPath：按目标平台做确定性规范化——win32 目标上把
 * WSL / Git Bash 的 POSIX 视图（/mnt/<盘符>、/<盘符>、//server/share）转换为
 * 规范 Windows 路径，无盘符 POSIX 根显式结构化失败（零探测、零猜测）；
 * 非 win32 目标保持 POSIX 语义。
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

// ---------------------------------------------------------------------------
// 目标平台路径规范化（win32 目标上的 POSIX 视图确定性转换）
// ---------------------------------------------------------------------------

/**
 * 目标平台语义：'win32' 触发 Windows 规范化（含 POSIX 视图转换），
 * 其余一切平台按 POSIX 语义保持（darwin / linux 等共享 POSIX 规则）。
 */
export type TargetPlatform = 'win32' | 'posix'

/** 宿主平台标识（如 process.platform）→ 目标平台语义（仅 win32 特判）。 */
export function targetPlatformOf(platform: string): TargetPlatform {
  return platform === 'win32' ? 'win32' : 'posix'
}

/** 规范化所循输入视图（诊断用：路径以何种形式被识别与转换）。 */
export type TargetPathView =
  /** 原生 Windows 形状（盘符绝对 / 根反斜杠 / UNC，分隔符可混用）或相对路径。 */
  | 'win32'
  /** POSIX 目标平台：POSIX 语义原样保持（仅词法归一，绝不反向转换）。 */
  | 'posix'
  /** 恰两前导斜杠的 POSIX 拼写 UNC 视图（//server/share/…）。 */
  | 'unc'
  /** WSL 挂载视图（/mnt/<盘符>/…）。 */
  | 'wsl-mount'
  /** 盘符根视图（/<盘符>/…，Git Bash / MSYS 约定）。 */
  | 'drive'

/** normalizeTargetPath 结果：成功携带规范路径与识别视图；失败为机器可读码 + 人读原因。 */
export type NormalizeTargetPathResult =
  | { ok: true; path: string; view: TargetPathView }
  | {
      /**
       * POSIX 绝对路径在 win32 目标上无确定性盘符对应（裸 '/'、/home、/tmp、
       * /mnt、/mnt/<非单字母段>、越出盘符根的 '..' 等）：WSL 发行版根的真实
       * 位置在 \\wsl$\… 下，不经探测不可知，拒绝猜测（诚实性红线）。
       */
      ok: false
      code: 'unmappable_posix_root'
      reason: string
    }

/** 单字母段（A-Z / a-z）才是盘符视图的合法盘符段（'cd' / '一' 等一律拒绝）。 */
function isSingleDriveSegment(segment: string): boolean {
  return segment.length === 1 && isDriveLetter(segment.charCodeAt(0))
}

/** 盘符统一大写规范拼写（纯词法；UNC 与无盘符路径原样返回）。 */
function canonicalWin32Drive(p: string): string {
  return p.length >= 2 && isDriveLetter(p.charCodeAt(0)) && p.charCodeAt(1) === COLON
    ? p.charAt(0).toUpperCase() + p.slice(1)
    : p
}

function unmappablePosixRoot(input: string, normalized: string): NormalizeTargetPathResult {
  return {
    ok: false,
    code: 'unmappable_posix_root',
    reason:
      `win32 目标上无法确定 POSIX 绝对路径 ${input}（词法归一为 ${normalized}）的 Windows 盘符对应：` +
      '仅支持 /mnt/<盘符>/…（WSL 挂载视图）、/<盘符>/…（Git Bash / MSYS 盘符根视图）与 ' +
      '//server/share/…（UNC 视图）三种确定性映射；其余 POSIX 根属于 WSL 发行版文件系统' +
      '（真实位置在 \\\\wsl$\\… 下，不经探测不可知），拒绝静默猜测',
  }
}

/**
 * 目标平台路径规范化（确定性纯函数，零探测、零猜测）：
 *
 * - platform 'posix'：POSIX 词法归一（/mnt/c/… 在 Linux 等目标上是真实路径，
 *   绝不做反向「智能」转换）。
 * - platform 'win32'：
 *   - win32 形状（盘符绝对 / 根反斜杠 / UNC，分隔符可混用）→ win32 词法归一；
 *   - 恰两前导斜杠（//server/share/…）→ POSIX 拼写的 UNC 视图，按 win32 词法
 *     归一（POSIX 把恰两前导斜杠语义留给实现，Git Bash / MSYS 同此把它传给
 *     UNC；三斜杠及以上先归一为单根，再走盘符视图判定）；
 *   - 其余 POSIX 形状先按 POSIX 词法归一（消解 '.'/'..'、折叠重复分隔符、保留
 *     单个结尾分隔符），再对归一结果做确定性判定：
 *     /mnt/<单字母盘符>/… → <大写盘符>:\…（WSL 挂载视图；挂载点大小写敏感，
 *     仅小写 'mnt' 是 WSL 约定）；
 *     /<单字母盘符>/… → <大写盘符>:\…（Git Bash / MSYS 盘符根视图）；
 *     其余 POSIX 根（含越出盘符根的 '..'、POSIX 视图内混入的反斜杠段）显式
 *     结构化失败（unmappable_posix_root），绝不静默猜测；
 *   - 相对路径（含盘符相对 C:relative）→ win32 词法归一（本原语不做绝对化，
 *     解析基准归调用方策略）。
 *
 * 盘符统一输出大写规范拼写（Windows 盘符大小写不敏感）；UNC server / share
 * 保留输入大小写（规范拼写不经网络探测不可知，如实保留）。
 */
export function normalizeTargetPath(p: string, platform: TargetPlatform): NormalizeTargetPathResult {
  if (platform !== 'win32') {
    return { ok: true, path: posixRules.normalize(p), view: 'posix' }
  }
  const shape = targetPathShape(p)
  if (shape !== 'posix') {
    // win32 形状与相对路径：win32 词法归一（相对路径含盘符相对，不做绝对化）。
    return { ok: true, path: canonicalWin32Drive(win32Rules.normalize(p)), view: 'win32' }
  }
  if (
    p.charCodeAt(0) === FORWARD_SLASH &&
    p.charCodeAt(1) === FORWARD_SLASH &&
    p.charCodeAt(2) !== FORWARD_SLASH
  ) {
    return { ok: true, path: canonicalWin32Drive(win32Rules.normalize(p)), view: 'unc' }
  }
  // 先按 POSIX 词法归一再判定盘符视图：'.'/'..' 在此消解（越出盘符根自然落回
  // 无盘符根而失败），重复分隔符折叠，单个结尾分隔符保留。
  const normalized = posixRules.normalize(p)
  const trailing = normalized.length > 1 && normalized.charCodeAt(normalized.length - 1) === FORWARD_SLASH
  const segments = (trailing ? normalized.slice(0, -1) : normalized).slice(1).split('/')
  const first = segments[0] ?? ''
  let drive: string
  let view: TargetPathView
  if (first === 'mnt') {
    const second = segments[1] ?? ''
    if (!isSingleDriveSegment(second)) return unmappablePosixRoot(p, normalized)
    drive = second
    view = 'wsl-mount'
    segments.splice(0, 2)
  } else if (isSingleDriveSegment(first)) {
    drive = first
    view = 'drive'
    segments.splice(0, 1)
  } else {
    return unmappablePosixRoot(p, normalized)
  }
  const tail = segments.join('\\')
  return {
    ok: true,
    path: `${drive.toUpperCase()}:\\${tail}${trailing && tail.length > 0 ? '\\' : ''}`,
    view,
  }
}
