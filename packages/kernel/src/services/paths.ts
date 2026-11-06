/**
 * 数据目录解析与布局：默认 `~/.helm`，可被 `HELM_DATA_DIR` 覆盖，
 * 与旧系统（~/.botx / ~/.botd）完全隔离。
 */
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export const HELM_DATA_DIR_ENV = 'HELM_DATA_DIR'

export function resolveDataDir(override?: string): string {
  if (override !== undefined) {
    if (override.trim() === '') {
      throw new Error('dataDir 覆盖值不能为空字符串')
    }
    if (!isAbsolute(override)) {
      throw new Error(`dataDir 覆盖值必须是绝对路径: ${override}`)
    }
    return override
  }
  const fromEnv = process.env[HELM_DATA_DIR_ENV]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(homedir(), '.helm')
}

/** 设计文档约定的数据目录子目录布局。 */
export const DATA_SUBDIRS = [
  'profiles',
  'skills',
  'workflows',
  'plugins',
  'artifacts',
  'cache',
] as const

/** 幂等创建数据目录及全部设计子目录（已存在则保持不动）。 */
export async function ensureDataDir(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  for (const sub of DATA_SUBDIRS) {
    await mkdir(join(dataDir, sub), { recursive: true })
  }
}
