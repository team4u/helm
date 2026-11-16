/**
 * across platform environment variable object (Record<string, string | undefined>) read write original language.
 *
 * Node.js  `process.env` in Windows under is large small write do not sensitive proxy, but copy enter ordinary JS
 * object after by precise key name zone.`child_process.spawn(..., { env })` in Windows on
 * pass to underlying environment chunk when by large small write do not sensitive merge, after insert `'PATH'` will whole segment override first insert
 * `'Path'`(directly empty host machine original has Path). this module provide platform aware unify read write and pre- operation.
 */

/** in environment variable object in find key name (win32 large small write do not sensitive and take after insert;POSIX precise match). */
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

/** read environment variable value (win32 first by large small write do not sensitive scan self has key, again fall back directly property with compatibility process.env Proxy). */
export function getEnvEntry(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32') return env[key]
  const found = findEnvKey(env, key, 'win32')
  return found !== undefined ? env[found] : env[key]
}

/** write environment variable:win32 clean up other large small write change body key, ensure object in the same variable at most a key. */
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

/** delete environment variable (win32 delete all large small write change body key;POSIX precise delete). */
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
 *  `prefixDir` pre- to environment variable PATH(win32 keep original has `'Path'` etc. large small write key name and
 * merge clean up the rest change body, avoid after insert `'PATH'` in Windows on override clean zero host `'Path'`).
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
