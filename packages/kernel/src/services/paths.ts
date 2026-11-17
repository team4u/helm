/**
 * Data directory resolution and layout: defaults to `~/.helm`, can be overridden by `HELM_DATA_DIR`,
 * and is completely isolated from legacy systems (~/.botx / ~/.botd).
 */
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export const HELM_DATA_DIR_ENV = 'HELM_DATA_DIR'

export function resolveDataDir(override?: string): string {
  if (override !== undefined) {
    if (override.trim() === '') {
      throw new Error('dataDir override must not be an empty string')
    }
    if (!isAbsolute(override)) {
      throw new Error(`dataDir override must be an absolute path: ${override}`)
    }
    return override
  }
  const fromEnv = process.env[HELM_DATA_DIR_ENV]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(homedir(), '.helm')
}

/** Data directory subdirectory layout defined by the design specification. */
export const DATA_SUBDIRS = [
  'profiles',
  'skills',
  'workflows',
  'plugins',
  'artifacts',
  'cache',
] as const

/** Idempotently create the data directory and all design subdirectories (leave existing ones untouched). */
export async function ensureDataDir(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  for (const sub of DATA_SUBDIRS) {
    await mkdir(join(dataDir, sub), { recursive: true })
  }
}
