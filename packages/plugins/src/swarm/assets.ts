/**
 * builtin:swarm 受管技能资产加载（兼容 tsx 源码、tsc 构建产物与 @helm/payload 运行形态）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HelmError, type PluginSkillAsset } from '@helm/protocol'
import { SWARM_PLUGIN_ID, SWARM_SKILL_ID } from './contracts.js'

export function resolveSwarmAssetsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidate1 = join(here, 'assets')
  if (existsSync(candidate1)) return candidate1

  const pkgRoot = resolve(here, '../..')
  const candidate2 = join(pkgRoot, 'src', 'swarm', 'assets')
  if (existsSync(candidate2)) return candidate2

  throw new HelmError(
    'swarm_asset_missing',
    `内置插件 ${SWARM_PLUGIN_ID} 资产目录未找到（tried: "${candidate1}", "${candidate2}"）`,
    500,
    { pluginId: SWARM_PLUGIN_ID, paths: [candidate1, candidate2] },
  )
}

export function readSwarmSkillAsset(): PluginSkillAsset {
  const assetsDir = resolveSwarmAssetsDir()
  const skillMd = readFileSync(join(assetsDir, SWARM_SKILL_ID, 'SKILL.md'), 'utf-8')
  return {
    id: SWARM_SKILL_ID,
    skillMd,
    references: {},
  }
}
