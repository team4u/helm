/**
 * builtin:profile 自举的系统级内置技能资产（三层渐进式披露的 Layer 1/2）。
 *
 * Layer 1（SKILL.md）：helm CLI 黄金法则、核心命令全景与 references 下钻索引，
 * 由 SkillService.ensureSkill 在插件启动时同步为源码版本（受管覆盖，常规接口只读）。
 * Layer 2（references/*.md）：确定性工作流、技能/插件自举开发、client.tsx 代码分割三个专题手册，
 * 模型经 load_skill({ skillId, path }) 按需读取，正文不常驻。
 * 生成式 UI（```ui 代码块）手册由 builtin:json-render 插件自举的
 * generative-ui 技能提供，随插件启停进入/离开可用技能目录。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HelmError,
  PLUGIN_UI_METHOD_NAMES,
  RESERVED_SLASH_COMMANDS,
  PLUGIN_HOOK_NAMES,
  type PluginSkillAsset,
} from '@helm/protocol'

/** 托管本技能资产与自举 Profile 的插件 ID（SKILL.md frontmatter managedByPlugin 值）。 */
export const PROFILE_MANAGED_BY = 'builtin:profile'

/** 系统级内置技能 ID（SYSTEM.md Layer 0 指引的 load_skill 目标）。 */
export const HELM_CLI_SKILL_ID = 'helm-cli'

/**
 * 技能文本模板插值引擎：将 `{{KEY}}` 严格替换为 `vars[KEY]`。
 * 遇未定义 key 或替换后残留任何 `{{...}}` 占位符一律显式抛出 HelmError('unreplaced_skill_placeholder')。
 */
export function renderSkillTemplate(
  template: string,
  vars: Readonly<Record<string, string>>,
): string {
  const rendered = template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const val = vars[key]
    if (val === undefined) {
      throw new HelmError(
        'unreplaced_skill_placeholder',
        `技能模板存在未定义占位符: {{${key}}}`,
        500,
        { key },
      )
    }
    return val
  })

  const remaining = rendered.match(/\{\{[^}]*\}\}/)
  if (remaining !== null) {
    throw new HelmError(
      'unreplaced_skill_placeholder',
      `技能模板渲染后仍残留未替换占位符: ${remaining[0]}`,
      500,
      { placeholder: remaining[0] },
    )
  }

  return rendered
}

/** 解析 profile skill 资产目录（兼容 src 与 dist 运行时）。 */
export function resolveProfileSkillDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidate1 = join(here, 'skill')
  if (existsSync(candidate1)) return candidate1

  const pkgRoot = resolve(here, '../../..')
  const candidate2 = join(pkgRoot, 'src', 'builtin-plugins', 'profile', 'skill')
  if (existsSync(candidate2)) return candidate2

  throw new HelmError(
    'profile_skill_asset_missing',
    `内置 profile 技能资产目录未找到（tried: "${candidate1}", "${candidate2}"）`,
    500,
    { paths: [candidate1, candidate2] },
  )
}

const skillDir = resolveProfileSkillDir()

const skillVars: Record<string, string> = {
  SKILL_ID: HELM_CLI_SKILL_ID,
  MANAGED_BY: PROFILE_MANAGED_BY,
  HOOK_COUNT: String(PLUGIN_HOOK_NAMES.length),
  HOOK_NAMES: PLUGIN_HOOK_NAMES.join('、'),
  UI_METHOD_COUNT: String(PLUGIN_UI_METHOD_NAMES.length),
  RESERVED_SLASH_COMMANDS: RESERVED_SLASH_COMMANDS.join('/'),
}

export const HELM_CLI_SKILL_MD = renderSkillTemplate(
  readFileSync(join(skillDir, 'SKILL.md'), 'utf-8'),
  skillVars,
)

export const HELM_CLI_WORKFLOWS_AND_AGENTS_MD = renderSkillTemplate(
  readFileSync(join(skillDir, 'references', 'workflows-and-agents.md'), 'utf-8'),
  skillVars,
)

export const HELM_CLI_SKILL_AND_PLUGIN_DEV_MD = renderSkillTemplate(
  readFileSync(join(skillDir, 'references', 'skill-and-plugin-dev.md'), 'utf-8'),
  skillVars,
)

export const HELM_CLI_PLUGIN_CLIENT_CODE_SPLITTING_MD = renderSkillTemplate(
  readFileSync(join(skillDir, 'references', 'plugin-client-code-splitting.md'), 'utf-8'),
  skillVars,
)

/** 汇总资产：id + SKILL.md + 3 个 references。SkillService.ensureSkill 受管覆盖同步。 */
export const HELM_CLI_SKILL_ASSET: PluginSkillAsset = {
  id: HELM_CLI_SKILL_ID,
  skillMd: HELM_CLI_SKILL_MD,
  references: {
    'workflows-and-agents.md': HELM_CLI_WORKFLOWS_AND_AGENTS_MD,
    'skill-and-plugin-dev.md': HELM_CLI_SKILL_AND_PLUGIN_DEV_MD,
    'plugin-client-code-splitting.md': HELM_CLI_PLUGIN_CLIENT_CODE_SPLITTING_MD,
  },
}
