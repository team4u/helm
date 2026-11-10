/**
 * builtin:superagent 自举资产内容与逐文件幂等补齐。
 *
 * 幂等语义（覆盖 partial-start）：profile.json 已存在而 SYSTEM.md 缺失时
 * 仍补齐缺文件；既有文件（含用户同名资产）一律不覆盖、不回填标记。
 * MEMORY.md 长期记忆归 builtin:memory 插件自治：本模块绝不创建/补齐
 * 记忆文件（memory 插件停用时不得造记忆；已初始化文件被删后也不得在
 * superagent 重启自举时悄悄补回掩盖丢失）。
 * 读取只以 ENOENT 视为缺失，损坏 / 权限错误如实传播（不吞、不伪造）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HelmError } from '@helm/protocol'
import { atomicWriteFile, atomicWriteJson } from '../../services/index.js'
import { renderSkillTemplate } from '../profile/assets.js'

/** 托管本插件自举资产的插件 ID（managedByPlugin 标记值）。 */
export const SUPERAGENT_MANAGED_BY = 'builtin:superagent'

/** 解析 superagent 资产目录（兼容 src 与 dist 运行时）。 */
export function resolveSuperagentAssetsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidate1 = join(here, 'assets')
  if (existsSync(candidate1)) return candidate1

  const pkgRoot = resolve(here, '../../..')
  const candidate2 = join(pkgRoot, 'src', 'builtin-plugins', 'superagent', 'assets')
  if (existsSync(candidate2)) return candidate2

  throw new HelmError(
    'superagent_asset_missing',
    `内置 superagent 资产目录未找到（tried: "${candidate1}", "${candidate2}"）`,
    500,
    { paths: [candidate1, candidate2] },
  )
}

const assetsDir = resolveSuperagentAssetsDir()
const superagentVars = {
  MANAGED_BY: SUPERAGENT_MANAGED_BY,
}

export const SUPERAGENT_PROFILE_SYSTEM_MD = renderSkillTemplate(
  readFileSync(join(assetsDir, 'profiles', 'superagent-system.md'), 'utf-8'),
  superagentVars,
)

export const WATCHDOG_PROFILE_SYSTEM_MD = renderSkillTemplate(
  readFileSync(join(assetsDir, 'profiles', 'watchdog-system.md'), 'utf-8'),
  superagentVars,
)

export const WATCHDOG_PLAYBOOK_SKILL_MD = renderSkillTemplate(
  readFileSync(join(assetsDir, 'skill', 'SKILL.md'), 'utf-8'),
  superagentVars,
)

export const WATCHDOG_PLAYBOOK_HERDR_STALLED_MD = renderSkillTemplate(
  readFileSync(join(assetsDir, 'skill', 'references', 'herdr-stalled.md'), 'utf-8'),
  superagentVars,
)

export const WATCHDOG_PLAYBOOK_CI_FAILURE_MD = renderSkillTemplate(
  readFileSync(join(assetsDir, 'skill', 'references', 'ci-failure.md'), 'utf-8'),
  superagentVars,
)

/** 读取缺失文件检测：ENOENT → false（缺失）；损坏/权限错误原样抛出。 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return false
    throw err
  }
}

export interface ProfileAsset {
  id: string
  profileJson: Record<string, unknown>
  systemMd: string
}

/** 逐文件幂等补齐 Profile 目录（profile.json / SYSTEM.md；不含 MEMORY.md）。
 *
 * 仅补缺失文件（partial-start 场景）；已存在文件（含用户同名资产与全部
 * 字段）一律原样保留，不做任何回填改写。 */
export async function ensureProfileDir(dataDir: string, asset: ProfileAsset): Promise<void> {
  const dir = join(dataDir, 'profiles', asset.id)
  await mkdir(dir, { recursive: true })
  if (!(await fileExists(join(dir, 'profile.json')))) {
    await atomicWriteJson(join(dir, 'profile.json'), asset.profileJson)
  }
  if (!(await fileExists(join(dir, 'SYSTEM.md')))) {
    await atomicWriteFile(join(dir, 'SYSTEM.md'), asset.systemMd)
  }
}

export interface SkillAsset {
  id: string
  skillMd: string
  references: Record<string, string>
}

/** 逐文件幂等补齐技能包（SKILL.md + references/*.md）。
 *
 * 仅补缺失文件；已存在文件一律原样保留，不改写 frontmatter。 */
export async function ensureSkillDir(dataDir: string, asset: SkillAsset): Promise<void> {
  const dir = join(dataDir, 'skills', asset.id)
  await mkdir(join(dir, 'references'), { recursive: true })
  if (!(await fileExists(join(dir, 'SKILL.md')))) {
    await atomicWriteFile(join(dir, 'SKILL.md'), asset.skillMd)
  }
  for (const [name, content] of Object.entries(asset.references)) {
    if (!(await fileExists(join(dir, 'references', name)))) {
      await atomicWriteFile(join(dir, 'references', name), content)
    }
  }
}

export const SUPERAGENT_PROFILE_ASSET: ProfileAsset = {
  id: 'superagent',
  profileJson: {
    id: 'superagent',
    name: 'SuperAgent 中枢',
    managedByPlugin: SUPERAGENT_MANAGED_BY,
    humanSelectable: false,
    // 中枢只做路由与调度，不直接消费技能（含排障手册）；空数组禁用全部。
    skills: [],
  },
  systemMd: SUPERAGENT_PROFILE_SYSTEM_MD,
}

export const WATCHDOG_PROFILE_ASSET: ProfileAsset = {
  id: 'watchdog',
  profileJson: {
    id: 'watchdog',
    name: '巡检看门狗',
    managedByPlugin: SUPERAGENT_MANAGED_BY,
    humanSelectable: false,
    // 看门狗仅按需加载本插件自举的排障手册，其余技能一律不可见。
    skills: ['watchdog-playbooks'],
  },
  systemMd: WATCHDOG_PROFILE_SYSTEM_MD,
}

export const WATCHDOG_PLAYBOOK_SKILL_ASSET: SkillAsset = {
  id: 'watchdog-playbooks',
  skillMd: WATCHDOG_PLAYBOOK_SKILL_MD,
  references: {
    'herdr-stalled.md': WATCHDOG_PLAYBOOK_HERDR_STALLED_MD,
    'ci-failure.md': WATCHDOG_PLAYBOOK_CI_FAILURE_MD,
  },
}
