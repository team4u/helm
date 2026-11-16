/**
 * data directory parse and layout: by default `~/.helm`, can by `HELM_DATA_DIR` override,
 * and old system (~/.botx / ~/.botd) fully isolated.
 */
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export const HELM_DATA_DIR_ENV = 'HELM_DATA_DIR'

export function resolveDataDir(override?: string): string {
  if (override !== undefined) {
    if (override.trim() === '') {
      throw new Error('dataDir override value cannot be empty string')
    }
    if (!isAbsolute(override)) {
      throw new Error(`dataDir override value must be absolute path: ${override}`)
    }
    return override
  }
  const fromEnv = process.env[HELM_DATA_DIR_ENV]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(homedir(), '.helm')
}

/** design document convention data directory subdirectory layout. */
export const DATA_SUBDIRS = [
  'profiles',
  'skills',
  'workflows',
  'plugins',
  'artifacts',
  'cache',
] as const

/** idempotent create data directory and all design subdirectory (already exists then keep do not motion). */
export async function ensureDataDir(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  for (const sub of DATA_SUBDIRS) {
    await mkdir(join(dataDir, sub), { recursive: true })
  }
}
