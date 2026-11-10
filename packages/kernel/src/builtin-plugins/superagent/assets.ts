/**
 * builtin:superagent 自举资产内容与逐文件幂等补齐。
 *
 * 幂等语义（覆盖 partial-start）：profile.json 已存在而 SYSTEM.md 缺失时
 * 仍补齐缺文件；既有文件（含用户同名资产）一律不覆盖、不回填标记。
 * MEMORY.md 长期记忆归 builtin:memory 插件自治：本模块绝不创建/补齐
 * 记忆文件（memory 插件停用时不得造记忆；已初始化文件被删后也不得在
 * superagent 重启自举时悄悄补回掩盖丢失）。
 * 读取只以 ENOENT 视为缺失，损坏 / 权限错误如实传播（不吞、不伪造）。
 *
 * 目录定位经公开 host 端口（profiles.directory / skills.directory，仅坐标
 * 返回、宿主不 mkdir），写入经 host.atomicWriteFile；插件不 import 内核
 * 私有 services，不做 dataDir ../.. 相对推测。
 */
import { existsSync, readFileSync } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HelmError, type Profile } from '@helm/protocol'

/** 托管本插件自举资产的插件 ID（managedByPlugin 标记值）。 */
export const SUPERAGENT_MANAGED_BY = 'builtin:superagent'

/**
 * 技能模板插值引擎（与 profile 插件同语义的私有实现）：{{KEY}} 严格替换；
 * 未定义 key 或替换后残留占位符一律显式抛错（不静默输出半渲染文本）。
 */
export function renderSkillTemplate(
  template: string,
  vars: Readonly<Record<string, string>>,
): string {
  const rendered = template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const val = vars[key]
    if (val === undefined) {
      throw new HelmError('unreplaced_skill_placeholder', `技能模板存在未定义占位符: {{${key}}}`, 500, { key })
    }
    return val
  })
  const remaining = rendered.match(/\{\{[^}]*\}\}/)
  if (remaining !== null) {
    throw new HelmError(
      'unreplaced_skill_placeholder',
      `技能模板渲染后仍残留未替换占位符 ${remaining[0]}`,
      500,
      { placeholder: remaining[0] },
    )
  }
  return rendered
}

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

/** host 端口最小面（目录坐标 + 原子写；definePlugin 内由 ctx.host 提供）。 */
export interface AssetHostPorts {
  /** Profile 资产目录坐标（宿主不 mkdir，仅返回路径）。 */
  profileDirectory(id: string): Promise<string>
  /** 技能目录坐标（宿主不 mkdir，仅返回路径）。 */
  skillDirectory(id: string): Promise<string>
  /** 原子写文件（临时文件 + rename）。 */
  atomicWriteFile(path: string, content: string): Promise<void>
}

export interface ProfileAsset {
  id: string
  /** 公开 Profile 形状（ProfileService 保存契约同形）。 */
  profileJson: Profile
  systemMd: string
}

/** 逐文件幂等补齐 Profile 目录（profile.json / SYSTEM.md；不含 MEMORY.md）。
 *
 * 仅补缺失文件（partial-start 场景）；已存在文件（含用户同名资产与全部
 * 字段）一律原样保留，不做任何回填改写。目录坐标经 host.profiles.directory。 */
export async function ensureProfileDir(host: AssetHostPorts, asset: ProfileAsset): Promise<void> {
  const dir = await host.profileDirectory(asset.id)
  await mkdir(dir, { recursive: true })
  if (!(await fileExists(join(dir, 'profile.json')))) {
    // Profile 是纯 JSON 数据（profile.json 持久形状）；原子写保持排序稳定。
    await host.atomicWriteFile(join(dir, 'profile.json'), `${JSON.stringify(asset.profileJson, null, 2)}\n`)
  }
  if (!(await fileExists(join(dir, 'SYSTEM.md')))) {
    await host.atomicWriteFile(join(dir, 'SYSTEM.md'), asset.systemMd)
  }
}

export interface SuperAgentSkillAsset {
  id: string
  skillMd: string
  references: Record<string, string>
}

/** 逐文件幂等补齐技能包（SKILL.md + references/*.md）。
 *
 * 仅补缺失文件；已存在文件一律原样保留，不改写 frontmatter。目录坐标经
 * host.skills.directory。 */
export async function ensureSkillDir(host: AssetHostPorts, asset: SuperAgentSkillAsset): Promise<void> {
  const dir = await host.skillDirectory(asset.id)
  await mkdir(join(dir, 'references'), { recursive: true })
  if (!(await fileExists(join(dir, 'SKILL.md')))) {
    await host.atomicWriteFile(join(dir, 'SKILL.md'), asset.skillMd)
  }
  for (const [name, content] of Object.entries(asset.references)) {
    if (!(await fileExists(join(dir, 'references', name)))) {
      await host.atomicWriteFile(join(dir, 'references', name), content)
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

export const WATCHDOG_PLAYBOOK_SKILL_ASSET: SuperAgentSkillAsset = {
  id: 'watchdog-playbooks',
  skillMd: WATCHDOG_PLAYBOOK_SKILL_MD,
  references: {
    'herdr-stalled.md': WATCHDOG_PLAYBOOK_HERDR_STALLED_MD,
    'ci-failure.md': WATCHDOG_PLAYBOOK_CI_FAILURE_MD,
  },
}
