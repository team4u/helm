/**
 * builtin:tasks 受管技能资产加载（兼容 tsx 源码、tsc 构建产物与 @helmx/payload 运行形态）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HelmxError, type PluginSkillAsset } from '@helmx/protocol'
import { TASKS_PLUGIN_ID, TASKS_SKILL_ID } from './contracts.js'

export function resolveTasksAssetsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidate1 = join(here, 'assets')
  if (existsSync(candidate1)) return candidate1

  const pkgRoot = resolve(here, '../..')
  const candidate2 = join(pkgRoot, 'src', 'tasks', 'assets')
  if (existsSync(candidate2)) return candidate2

  throw new HelmxError(
    'tasks_asset_missing',
    `内置插件 ${TASKS_PLUGIN_ID} 资产目录未找到（tried: "${candidate1}", "${candidate2}"）`,
    500,
    { pluginId: TASKS_PLUGIN_ID, paths: [candidate1, candidate2] },
  )
}

export function readTasksSkillAsset(): PluginSkillAsset {
  const assetsDir = resolveTasksAssetsDir()
  const skillMd = readFileSync(join(assetsDir, TASKS_SKILL_ID, 'SKILL.md'), 'utf-8')
  return {
    id: TASKS_SKILL_ID,
    skillMd,
    references: {},
  }
}
