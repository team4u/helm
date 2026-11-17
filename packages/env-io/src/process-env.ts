/**
 * Cross-platform read/write primitives for environment variable maps (`Record<string, string | undefined>`).
 *
 * Node.js `process.env` is a case-insensitive proxy on Windows, but copying entries into a plain JS
 * object makes key lookup exact-case. Passing that object to `child_process.spawn(..., { env })` on
 * Windows merges keys case-insensitively, so appending `'PATH'` alongside `'Path'` overwrites the
 * host's `Path` entry. These helpers provide platform-aware lookups, writes, deletions, and PATH prepends.
 */

/** Find an existing key in `env` (case-insensitive on win32, returning the last match; exact on POSIX). */
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

/** Read an env variable (on win32, scans own keys case-insensitively before falling back to direct access for `process.env` proxies). */
export function getEnvEntry(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32') return env[key]
  const found = findEnvKey(env, key, 'win32')
  return found !== undefined ? env[found] : env[key]
}

/** Set an env variable, removing any other case variants on win32 so at most one key exists per variable. */
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

/** Delete an env variable (all case variants on win32; exact key on POSIX). */
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
 * Prepend `prefixDir` to `PATH` (preserving the host's existing key casing such as `'Path'` on win32
 * and removing duplicate case variants so a newly inserted `'PATH'` does not clobber `'Path'`).
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
