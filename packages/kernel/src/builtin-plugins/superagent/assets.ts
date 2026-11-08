/**
 * builtin:superagent 自举资产内容与逐文件幂等补齐。
 *
 * 幂等语义（覆盖 partial-start）：profile.json 已存在而 SYSTEM.md / MEMORY.md
 * 缺失时仍补齐缺文件；既有用户文件一律不覆盖。读取失败仅 ENOENT 视为缺失，
 * 损坏 / 权限错误如实传播（不吞、不用空内容假装修复）。
 *
 * 托管标记回填：旧版自举资产无 managedByPlugin 字段；存在且缺失时自动补写
 * 'builtin:superagent'（Profile 保留用户其余全部字段；SKILL.md 仅在 frontmatter
 * 内插入一行，正文不动）。用户已显式写入其他插件 ID 则原样保留，不覆盖。
 */
import { access, mkdir, readFile } from 'node:fs/promises'
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
 * 旧版 profile.json 无 managedByPlugin 时自动补写本插件标记：保留既有全部
 * 字段（含用户手工修改），仅添加一个键；SYSTEM.md / MEMORY.md 不动。 */
export async function ensureProfileDir(dataDir: string, asset: ProfileAsset): Promise<void> {
  const dir = join(dataDir, 'profiles', asset.id)
  await mkdir(dir, { recursive: true })
  if (!(await fileExists(join(dir, 'profile.json')))) {
    await atomicWriteJson(join(dir, 'profile.json'), asset.profileJson)
  } else {
    await backfillProfileManagedBy(join(dir, 'profile.json'))
  }
  if (!(await fileExists(join(dir, 'SYSTEM.md')))) {
    await atomicWriteFile(join(dir, 'SYSTEM.md'), asset.systemMd)
  }
  if (!(await fileExists(join(dir, 'MEMORY.md')))) {
    await atomicWriteFile(join(dir, 'MEMORY.md'), '# Memory\n\n')
  }
}

/** 已存在 profile.json 的托管标记回填（仅缺字段时写入；解析失败如实上抛）。 */
async function backfillProfileManagedBy(path: string): Promise<void> {
  const raw = await readFile(path, 'utf8')
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (err) {
    throw new Error(`托管标记回填前解析 profile.json 失败：${path}：${String(err)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`托管标记回填前发现 profile.json 结构非法：${path}`)
  }
  const record = value as Record<string, unknown>
  if (record['managedByPlugin'] !== undefined) return
  await atomicWriteJson(path, { ...record, managedByPlugin: SUPERAGENT_MANAGED_BY })
}

export interface SkillAsset {
  id: string
  skillMd: string
  references: Record<string, string>
}

/** 逐文件幂等补齐技能包（SKILL.md + references/*.md）。
 *
 * 旧版 SKILL.md frontmatter 不含 managedByPlugin: 行时，在闭合 '---' 前
 * 插入一行本插件标记；正文与其余 frontmatter 字段原样保留。 */
export async function ensureSkillDir(dataDir: string, asset: SkillAsset): Promise<void> {
  const dir = join(dataDir, 'skills', asset.id)
  await mkdir(join(dir, 'references'), { recursive: true })
  if (!(await fileExists(join(dir, 'SKILL.md')))) {
    await atomicWriteFile(join(dir, 'SKILL.md'), asset.skillMd)
  } else {
    await backfillSkillManagedBy(join(dir, 'SKILL.md'))
  }
  for (const [name, content] of Object.entries(asset.references)) {
    if (!(await fileExists(join(dir, 'references', name)))) {
      await atomicWriteFile(join(dir, 'references', name), content)
    }
  }
}

/** 已存在 SKILL.md 的托管标记回填：frontmatter 含该键（两种拼写）即跳过。
 * 无 frontmatter 的 SKILL.md 不动（非本插件形状，不越权改造）。 */
async function backfillSkillManagedBy(path: string): Promise<void> {
  const text = await readFile(path, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (match === null) return
  const frontmatter = match[1] ?? ''
  for (const line of frontmatter.split(/\r?\n/)) {
    if (/^(managedByPlugin|managed_by_plugin)\s*:/i.test(line.trim())) return
  }
  // 在闭合 '---' 行之前插入标记行：正文与既有 frontmatter 字段原样保留。
  const closeStart = match[0].length - 3
  const lineBreak = text.slice(0, closeStart).endsWith('\r\n') ? '\r\n' : '\n'
  const updated =
    text.slice(0, closeStart) + `managedByPlugin: ${SUPERAGENT_MANAGED_BY}${lineBreak}` + text.slice(closeStart)
  await atomicWriteFile(path, updated)
}

export const SUPERAGENT_PROFILE_ASSET: ProfileAsset = {
  id: 'superagent',
  profileJson: { id: 'superagent', name: 'SuperAgent 中枢', managedByPlugin: SUPERAGENT_MANAGED_BY },
  systemMd: SUPERAGENT_PROFILE_SYSTEM_MD,
}

export const WATCHDOG_PROFILE_ASSET: ProfileAsset = {
  id: 'watchdog',
  profileJson: { id: 'watchdog', name: '巡检看门狗', managedByPlugin: SUPERAGENT_MANAGED_BY },
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
