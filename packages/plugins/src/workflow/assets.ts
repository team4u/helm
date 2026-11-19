/** builtin:workflow managed skill asset loader. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HelmxError, type PluginSkillAsset } from '@helmx/protocol'
import { WORKFLOW_PLUGIN_ID, WORKFLOW_SKILL_ID } from '../contracts.js'

export function resolveWorkflowSkillDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const local = join(here, 'skill')
  if (existsSync(local)) return local

  const pkgRoot = resolve(here, '../..')
  const source = join(pkgRoot, 'src', 'workflow', 'skill')
  if (existsSync(source)) return source

  throw new HelmxError(
    'workflow_skill_asset_missing',
    `Built-in plugin ${WORKFLOW_PLUGIN_ID} cannot find its skill asset directory (tried: "${local}", "${source}")`,
    500,
    { pluginId: WORKFLOW_PLUGIN_ID, paths: [local, source] },
  )
}

export function readWorkflowSkillAsset(): PluginSkillAsset {
  const dir = resolveWorkflowSkillDir()
  const read = (path: string): string => readFileSync(join(dir, path), 'utf-8')
  return {
    id: WORKFLOW_SKILL_ID,
    skillMd: read('SKILL.md'),
    references: {
      'dsl.md': read('references/dsl.md'),
      'subagents.md': read('references/subagents.md'),
    },
  }
}
