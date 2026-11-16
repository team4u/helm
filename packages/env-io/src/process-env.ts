/**
 * 跨平台环境变量对象（Record<string, string | undefined>）读写原语。
 *
 * Node.js 的 `process.env` 在 Windows 下是大小写不敏感代理，但拷贝进普通 JS
 * 对象后按精确键名区分。`child_process.spawn(..., { env })` 在 Windows 上
 * 传给底层环境块时按大小写不敏感合并，后插入的 `'PATH'` 会整段覆盖先插入的
 * `'Path'`（直接清空宿主机原有 Path）。本模块提供平台感知的统一读写与前置操作。
 */

/** 在环境变量对象中查找键名（win32 大小写不敏感且取后插入者；POSIX 精确匹配）。 */
export function findEnvKey(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32') {
    return Object.hasOwn(env, key) ? key : undefined
  }
  const targetUpper = key.toUpperCase()
  const keys = Object.keys(env)
  for (let i = keys.length - 1; i >= 0; i--) {
    const candidate = keys[i]
    if (candidate !== undefined && candidate.toUpperCase() === targetUpper) {
      return candidate
    }
  }
  return undefined
}

/** 读取环境变量值（win32 先按大小写不敏感扫描自有键，再回退直接属性以兼容 process.env Proxy）。 */
export function getEnvEntry(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32') return env[key]
  const found = findEnvKey(env, key, 'win32')
  return found !== undefined ? env[found] : env[key]
}

/** 写入环境变量：win32 清理其他大小写变体键，确保对象中同一变量至多一个键。 */
export function setEnvEntry(
  env: Record<string, string | undefined>,
  key: string,
  value: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') {
    const targetUpper = key.toUpperCase()
    for (const existing of Object.keys(env)) {
      if (existing !== key && existing.toUpperCase() === targetUpper) {
        delete env[existing]
      }
    }
  }
  env[key] = value
}

/** 删除环境变量（win32 删除全部大小写变体键；POSIX 精确删除）。 */
export function deleteEnvEntry(
  env: Record<string, string | undefined>,
  key: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') {
    const targetUpper = key.toUpperCase()
    for (const existing of Object.keys(env)) {
      if (existing.toUpperCase() === targetUpper) {
        delete env[existing]
      }
    }
    return
  }
  delete env[key]
}

/**
 * 将 `prefixDir` 前置到环境变量的 PATH（win32 保留原有 `'Path'` 等大小写键名并
 * 合并清理其余变体，避免后插入的 `'PATH'` 在 Windows 上覆盖清零宿主 `'Path'`）。
 */
export function prependEnvPath(
  env: Record<string, string | undefined>,
  prefixDir: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const sep = platform === 'win32' ? ';' : ':'
  if (platform !== 'win32') {
    const current = env['PATH'] ?? ''
    env['PATH'] = current !== '' ? `${prefixDir}${sep}${current}` : prefixDir
    return
  }
  const matches = Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')
  if (matches.length === 0) {
    env['PATH'] = prefixDir
    return
  }
  const canonicalKey = matches[matches.length - 1]!
  const current = env[canonicalKey] ?? ''
  for (const existing of matches) {
    if (existing !== canonicalKey) {
      delete env[existing]
    }
  }
  env[canonicalKey] = current !== '' ? `${prefixDir}${sep}${current}` : prefixDir
}
