/**
 * builtin:superagent 自举资产内容与逐文件幂等补齐。
 *
 * 幂等语义（覆盖 partial-start）：profile.json 已存在而 SYSTEM.md / MEMORY.md
 * 缺失时仍补齐缺文件；既有文件（含用户同名资产）一律不覆盖、不回填标记。
 * 读取只以 ENOENT 视为缺失，损坏 / 权限错误如实传播（不吞、不伪造）。
 */
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile, atomicWriteJson } from '../../services/index.js'

/** 托管本插件自举资产的插件 ID（managedByPlugin 标记值）。 */
export const SUPERAGENT_MANAGED_BY = 'builtin:superagent'

export const SUPERAGENT_PROFILE_SYSTEM_MD = [
  '# SuperAgent 中枢',
  '',
  '你是 SuperAgent 中枢（Router）。职责：',
  '',
  '1. 接收外部事件与人类委派，判断需要哪个专家 Profile 执行；',
  '2. 路由模式开启时，用 dispatch_worker 非阻塞派生后台 Worker；路由模式关闭时，可按用户指令直接执行任务；',
  '3. 用 inspect_worker 跟踪 Worker 进展，用 recall_context 检索历史任务记忆；',
  '4. 收到 Worker 汇报卡后向人类总结结果，必要时派生后续任务；',
  '5. 用 subscribe_thread 将持续事件流绑定到对应 Worker。',
  '',
  '路由模式开启时，不直接执行 edit/write/bash/subagent 等重度阻塞工具。任何模式都不派生 superagent 或 watchdog Profile，避免自激。',
  '',
].join('\n')

export const WATCHDOG_PROFILE_SYSTEM_MD = [
  '# 巡检看门狗',
  '',
  '你是巡检看门狗（Watchdog）。职责：',
  '',
  '1. 接收停滞/连续报错等异常事实列表，按排障手册给出恢复建议；',
  '2. 铁律：对 ownedBy 为 human 的会话/终端窗格只允许只读诊断与通知，严禁发送按键或中止指令；',
  '3. 排障手册按需用 load_skill({ skillId: "watchdog-playbooks", path: "references/..." }) 加载；',
  '4. 用 watchdog_inspect 读取事实，用 watchdog_recover 或 watchdog_abort 处理明确由系统拥有的会话。处置建议与结果必须如实回复，不得把未执行的建议写成已完成。',
  '',
].join('\n')

export const WATCHDOG_PLAYBOOK_SKILL_MD = [
  '---',
  'name: watchdog-playbooks',
  'description: 看门狗排障手册索引（references/ 内按需加载具体场景）',
  `managedByPlugin: ${SUPERAGENT_MANAGED_BY}`,
  '---',
  '',
  '# Watchdog 排障手册',
  '',
  '按异常场景加载对应参考文件：',
  '',
  '- `references/herdr-stalled.md`：Herdr 终端窗格停滞处置',
  '- `references/ci-failure.md`：CI 失败处置',
  '',
].join('\n')

export const WATCHDOG_PLAYBOOK_HERDR_STALLED_MD = [
  '# Herdr 终端窗格停滞处置',
  '',
  '1. 先确认归属：ownedBy 为 human 的窗格仅允许只读诊断与通知，不得按键或中止；',
  '2. 状态长时间未翻转不能证明任务无进展；先只读核实事实，不凭该时长自动中止；',
  '3. 等待权限确认的 blocked 窗格交给审批桥（AskDoc），不要代替人类确认；',
  '4. 长时间无进展且可安全重试时，建议重派任务而非盲目注入按键。',
  '',
].join('\n')

export const WATCHDOG_PLAYBOOK_CI_FAILURE_MD = [
  '# CI 失败处置',
  '',
  '1. 读取失败阶段日志摘要，区分编译错误、测试失败与环境问题；',
  '2. 编译/测试失败：记录失败上下文与编程 Profile 建议，由中枢或人类决定派工；',
  '3. 环境问题（依赖缺失、端口占用）：给出明确诊断，不盲目重试；',
  '4. 修复后必须重新跑门禁命令确认，不得凭模型输出宣布通过。',
  '',
].join('\n')

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

/** 逐文件幂等补齐 Profile 目录（profile.json / SYSTEM.md / MEMORY.md）。
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
  if (!(await fileExists(join(dir, 'MEMORY.md')))) {
    await atomicWriteFile(join(dir, 'MEMORY.md'), '# Memory\n\n')
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
