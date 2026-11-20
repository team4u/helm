/**
 * builtin:profile 节点技能库：会话坐标 (nodeId, cwd) 指向的节点在工作区
 * `<cwd>/.helmx/skills/<id>/SKILL.md` 下提供的只读技能来源（策略归插件层；
 * 内核只提供 executionEnv / nodeIpc / redact 机制端口，本模块零内核改动）。
 *
 * 契约与诚实性纪律（对齐仓库 AGENTS.md 第 3 节红线与 agents-md.ts 先例）：
 * - 只读发现与加载：节点技能永远留在节点事实来源上，绝不复制进 Hub
 *   SkillService 的 dataDir；每回合 before_turn 重新发现、load_skill 每次都读
 *   节点当前内容（节点技能更新下一回合即生效，不回写历史上下文）；
 * - 同名优先级契约（明确、不依赖 listDir 顺序）：Hub dataDir（含受管技能，
 *   永远最高）> 机器级共享根 ~/.agents/skills > 节点 .helmx/skills。节点技能
 *   只能补充、不能覆盖：同名时 catalog 不收录节点版本，load_skill 无来源
 *   参数、永远解析到高优先级版本，Agent 不面对 namespace skill id；
 * - 工作区无 .helmx/skills（不存在 / 是普通文件）属常态，按空处理；节点
 *   离线、宿主能力未接线、权限或 IO 故障绝不静默降级为「无节点技能」，
 *   显式返回 unavailable 诊断（before_turn 注入显式说明段，load_skill 显式
 *   报错）；单个技能条目内容缺失（无 SKILL.md）或 frontmatter 非法按
 *   第三方常态跳过该条目，与机器级共享根的 skippable 语义一致；
 * - 读取全程使用 ExecutionEnv 安全原语封死 TOCTOU 与无界读取（同
 *   agents-md 口径）：canonicalPath 解析后以 openBinaryReader(realPath,
 *   { noFollow: true }) 打开，kind/size 以同句柄 reader.info 为权威，正文只经
 *   reader.read(0, MAX_NODE_SKILL_FILE_BYTES + 1) 有界定位读，读后同句柄
 *   二次复核，绝不 readTextFile 无界整读；frontmatter 的 name/description
 *   进入系统提示前经宿主脱敏（机密不进系统提示词），load_skill 工具输出走
 *   宿主统一工具输出脱敏管道；
 * - 技能内相对路径与 id 共用 @helmx/protocol skill-contract 契约（与 Hub
 *   技能完全同一词汇）：穿越 / 绝对路径 / 反斜杠 / 非法字符一律拒绝；
 * - 节点文件的软链组织是节点本地事实（Windows junction 同理）：发现时
 *   listDir 把软链列为 symlink 而不跟随（技能目录为软链即跳过），读取时
 *   noFollow 拒最终组件软链；模型可请求的路径被相对路径词汇限制在技能
 *   目录树内。本模块不做 OS 沙箱，与 Hub 技能口径一致。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  HelmxError,
  assertSafeSkillRelativePath,
  assertSkillId,
  escapeXml,
  parseSkillFrontmatter,
  pathRulesForShape,
  targetPathShape,
  type SkillSummary,
} from '@helmx/protocol'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'

/** 节点技能库在工作区内的相对目录（POSIX 分隔符；路径合成按 cwd 形状选规则）。 */
export const NODE_SKILLS_RELATIVE_DIR = '.helmx/skills'

/**
 * 节点技能单文件读取前置字节上限（有界保护，与 AGENTS.md 读取同口径）：
 * SKILL.md 与 references 文件超过该字节数即不读正文——发现层令整库显式
 * unavailable（哪个技能超限写进诊断）、load_skill 显式 502 拒绝。
 */
export const MAX_NODE_SKILL_FILE_BYTES = 256 * 1024

/** 单工作区节点技能条目上限：超过按病态目录显式不可用，绝不静默截断。 */
export const MAX_NODE_SKILLS = 256

/** 单个节点技能 references 文件数上限：超过按病态技能跳过，绝不静默截断。 */
export const MAX_NODE_SKILL_REFERENCES = 512

/** 节点技能正文按 UTF-8 解码（非法序列替换为 U+FFFD，与 Hub readTextFile 同口径）。 */
const NODE_SKILL_UTF8_DECODER = new TextDecoder('utf-8')

/** 读取依赖的最小宿主形状（真实 ctx.host 天然满足；测试可注入受控实现）。 */
export interface NodeSkillsHostPort {
  executionEnv(nodeId: string, cwd: string): ExecutionEnv
  redact(text: string): string
  nodeIpc: { isOnline(nodeId: string): boolean }
}

/** 发现结果：ok=可用技能摘要（按 id 排序，只含未被 Hub 同名覆盖的补充技能）；unavailable=显式诊断（已脱敏、未转义）。 */
export type NodeSkillScan =
  | { kind: 'ok'; skills: SkillSummary[] }
  | { kind: 'unavailable'; reason: string }

/** 有界读取结果：absent=常态缺失；refused=显式不可读（已脱敏、未转义）；content=同句柄稳定读到的 UTF-8 正文。 */
type NodeFileRead =
  | { kind: 'absent' }
  | { kind: 'refused'; reason: string }
  | { kind: 'content'; text: string }

function errorCodeOf(err: unknown): string {
  return err instanceof HelmxError ? err.code : 'unknown'
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 目录与缺失（含 is_directory）属常态；其余错误显式不可读。 */
function isAbsentFileError(error: { code: string; message: string }): boolean {
  return error.code === 'not_found' || error.code === 'is_directory' || error.message.includes('EISDIR')
}

/** 工作区路径合成：按 cwd 自身形状选择词法规则（POSIX 与 Windows 靶点均安全，不假设远端 home）。 */
function joinUnderCwd(cwd: string, ...segments: string[]): string {
  return pathRulesForShape(targetPathShape(cwd)).join(cwd, ...segments)
}

/**
 * 有界安全读取节点上的一个文件（local 与 remote ExecutionEnv 共用同一契约，
 * 均在 BACKGROUND_CONTEXT 下调用；同 agents-md 的读取纪律，见模块头注释）。
 */
async function readNodeFileBounded(
  env: ExecutionEnv,
  path: string,
  redact: (text: string) => string,
): Promise<NodeFileRead> {
  const canonical = await env.canonicalPath(path, BACKGROUND_CONTEXT)
  if (!canonical.ok) {
    if (isAbsentFileError(canonical.error)) return { kind: 'absent' }
    return {
      kind: 'refused',
      reason: `解析 ${path} 真实路径失败（${canonical.error.code}）：${redact(canonical.error.message)}`,
    }
  }
  const realPath = canonical.value

  const openedR = await env.openBinaryReader(realPath, { noFollow: true }, BACKGROUND_CONTEXT)
  if (!openedR.ok) {
    // 打开失败即止步：绝无 readTextFile 等无界回退。
    if (isAbsentFileError(openedR.error)) return { kind: 'absent' }
    return {
      kind: 'refused',
      reason: `读取 ${path} 失败（${openedR.error.code}）：${redact(openedR.error.message)}`,
    }
  }
  const reader = openedR.value
  try {
    const infoR = await reader.info(BACKGROUND_CONTEXT)
    if (!infoR.ok) {
      return { kind: 'refused', reason: `读取 ${path} 元信息失败（${infoR.error.code}）：${redact(infoR.error.message)}` }
    }
    const info = infoR.value
    if (info.kind !== 'file') {
      return { kind: 'refused', reason: `${path} 在打开后不是普通文件（kind=${info.kind}），拒绝读取` }
    }
    if (info.size > MAX_NODE_SKILL_FILE_BYTES) {
      return { kind: 'refused', reason: `${path} 为 ${info.size} 字节，超过 ${MAX_NODE_SKILL_FILE_BYTES} 字节读取上限，正文未读取` }
    }

    const readR = await reader.read(0, MAX_NODE_SKILL_FILE_BYTES + 1, BACKGROUND_CONTEXT)
    if (!readR.ok) {
      return { kind: 'refused', reason: `读取 ${path} 失败（${readR.error.code}）：${redact(readR.error.message)}` }
    }
    const bytes = readR.value
    if (bytes.byteLength > MAX_NODE_SKILL_FILE_BYTES) {
      return { kind: 'refused', reason: `${path} 读取到 ${bytes.byteLength} 字节，超过 ${MAX_NODE_SKILL_FILE_BYTES} 字节上限，正文不采用` }
    }

    const afterR = await reader.info(BACKGROUND_CONTEXT)
    if (!afterR.ok) {
      return { kind: 'refused', reason: `读取 ${path} 后复核元信息失败（${afterR.error.code}）：${redact(afterR.error.message)}` }
    }
    const after = afterR.value
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
      return { kind: 'refused', reason: `${path} 读取期间发生变化（size ${info.size} -> ${after.size}），不采用可能不完整的快照` }
    }
    if (bytes.byteLength !== after.size) {
      return { kind: 'refused', reason: `${path} 实读 ${bytes.byteLength} 字节与稳定大小 ${after.size} 不一致，不采用可能不完整的快照` }
    }
    return { kind: 'content', text: NODE_SKILL_UTF8_DECODER.decode(bytes) }
  } finally {
    await reader.close(BACKGROUND_CONTEXT)
  }
}

/** 递归收集技能目录内 references 相对路径（listDir 不跟随软链：symlink 条目跳过且不下钻；
 * 跳过隐藏项与 node_modules / __pycache__ / dist，与 Hub collectFiles 同语义；只收通过
 * 契约校验的相对路径）。返回排序后的安全相对路径列表。 */
async function collectNodeReferences(
  env: ExecutionEnv,
  redact: (text: string) => string,
  dir: string,
  rel = '',
): Promise<string[]> {
  const listed = await env.listDir(rel === '' ? dir : joinUnderCwd(dir, ...rel.split('/')), BACKGROUND_CONTEXT)
  if (!listed.ok) {
    if (listed.error.code === 'not_found') return [] // 并发删除：该层按空处理
    throw new HelmxError(
      'node_skill_read_failed',
      `列出节点技能目录 ${rel === '' ? dir : `${dir}/${rel}`} 失败（${listed.error.code}）：${redact(listed.error.message)}`,
      502,
    )
  }
  const out: string[] = []
  for (const entry of listed.value) {
    if (entry.name.startsWith('.')) continue
    const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.kind === 'directory') {
      if (entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === 'dist') continue
      out.push(...(await collectNodeReferences(env, redact, dir, relPath)))
    } else if (entry.kind === 'file' && entry.name !== 'SKILL.md') {
      try {
        out.push(assertSafeSkillRelativePath(relPath))
      } catch {
        // Invalid relative paths cannot be read via load_skill; exclude from catalog (same as Hub collectFiles).
      }
    }
  }
  return out.sort()
}

/**
 * 发现会话靶点工作区（nodeId ?? 'local' + cwd）`.helmx/skills/` 下的技能：
 * - 目录不存在属常态 → ok([])；
 * - 单条目缺 SKILL.md / frontmatter 非法 / 目录为软链 / id 非法 → 跳过该条目
 *   （第三方内容常态，与共享根 skippable 语义一致）；
 * - 节点离线（isOnline === false，不进入 executionEnv 以免阻塞在重连窗口）、
 *   宿主能力未接线、listDir / 读取的真实 IO 故障、条目数超上限 → 显式
 *   unavailable（绝不静默当作空）；
 * - frontmatter 强制剥离 managedByPlugin：节点文件不得冒充宿主受管插件技能
 *   （与机器级共享根同规则）；
 * - 结果按 id 排序（不依赖 listDir 返回顺序）；name/description 已脱敏。
 */
export async function scanNodeSkills(
  host: NodeSkillsHostPort,
  nodeIdInput: string | undefined,
  cwd: string,
): Promise<NodeSkillScan> {
  try {
    return await scanNodeSkillsInner(host, nodeIdInput, cwd)
  } catch (err) {
    // 意外异常（宿主端口未接线 / 远端连接中途丢失等）同样显式不可用，绝不静默当作空。
    return {
      kind: 'unavailable',
      reason: `发现节点技能失败（${errorCodeOf(err)}）：${host.redact(errorMessageOf(err))}`,
    }
  }
}

async function scanNodeSkillsInner(
  host: NodeSkillsHostPort,
  nodeIdInput: string | undefined,
  cwd: string,
): Promise<NodeSkillScan> {
  if (cwd === '') return { kind: 'ok', skills: [] }
  const nodeId = nodeIdInput ?? 'local'
  const redact = (text: string): string => host.redact(text)

  if (nodeId !== 'local') {
    try {
      if (!host.nodeIpc.isOnline(nodeId)) {
        return { kind: 'unavailable', reason: `目标节点 ${nodeId} 当前离线，未能读取其工作区 ${NODE_SKILLS_RELATIVE_DIR} 技能库。` }
      }
    } catch (err) {
      return {
        kind: 'unavailable',
        reason: `检查目标节点 ${nodeId} 在线状态失败（${errorCodeOf(err)}）：${redact(errorMessageOf(err))}`,
      }
    }
  }

  let env: ExecutionEnv
  try {
    env = host.executionEnv(nodeId, cwd)
  } catch (err) {
    return {
      kind: 'unavailable',
      reason: `获取节点 ${nodeId} 执行环境失败（${errorCodeOf(err)}）：${redact(errorMessageOf(err))}`,
    }
  }

  const skillsRoot = joinUnderCwd(cwd, ...NODE_SKILLS_RELATIVE_DIR.split('/'))
  let listed: Awaited<ReturnType<ExecutionEnv['listDir']>>
  try {
    listed = await env.listDir(skillsRoot, BACKGROUND_CONTEXT)
  } catch (err) {
    return {
      kind: 'unavailable',
      reason: `列出节点技能目录 ${skillsRoot} 失败（${errorCodeOf(err)}）：${redact(errorMessageOf(err))}`,
    }
  }
  if (!listed.ok) {
    if (listed.error.code === 'not_found') return { kind: 'ok', skills: [] }
    return {
      kind: 'unavailable',
      reason: `列出节点技能目录 ${skillsRoot} 失败（${listed.error.code}）：${redact(listed.error.message)}`,
    }
  }
  const candidates = listed.value.filter(
    (entry) => entry.kind === 'directory' && !entry.name.startsWith('.'),
  )
  if (candidates.length > MAX_NODE_SKILLS) {
    return {
      kind: 'unavailable',
      reason: `节点技能目录 ${skillsRoot} 含 ${candidates.length} 个条目，超过 ${MAX_NODE_SKILLS} 上限，本回合未发现节点技能。`,
    }
  }

  const skills: SkillSummary[] = []
  for (const entry of candidates.sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      assertSkillId(entry.name)
    } catch {
      continue // 非法 id 的目录不进目录清单（第三方内容常态）
    }
    const skillDir = joinUnderCwd(skillsRoot, entry.name)
    const skillMdR = await readNodeFileBounded(env, joinUnderCwd(skillDir, 'SKILL.md'), redact)
    if (skillMdR.kind === 'absent') continue // 无 SKILL.md：不是技能，常态跳过
    if (skillMdR.kind === 'refused') {
      return { kind: 'unavailable', reason: `节点技能 ${entry.name} 读取失败：${skillMdR.reason}` }
    }
    let frontmatter: ReturnType<typeof parseSkillFrontmatter>
    try {
      frontmatter = parseSkillFrontmatter(skillMdR.text)
    } catch {
      continue // frontmatter 非法：跳过该条目（第三方内容，与共享根 skippable 语义一致）
    }
    let references: string[]
    try {
      references = await collectNodeReferences(env, redact, skillDir)
    } catch (err) {
      if (err instanceof HelmxError) return { kind: 'unavailable', reason: err.message }
      throw err
    }
    if (references.length > MAX_NODE_SKILL_REFERENCES) {
      return {
        kind: 'unavailable',
        reason: `节点技能 ${entry.name} 含 ${references.length} 个 references 文件，超过 ${MAX_NODE_SKILL_REFERENCES} 上限，本回合未发现节点技能。`,
      }
    }
    skills.push({
      id: entry.name,
      name: frontmatter.name || entry.name,
      ...(frontmatter.description !== '' ? { description: redact(frontmatter.description) } : {}),
      references,
      // managedByPlugin deliberately stripped: a node may only host normal skills, never host-managed plugin skills.
      source: 'node',
    })
  }
  return { kind: 'ok', skills }
}

/**
 * load_skill 的节点分支：读取节点事实来源上的最新文件内容（无缓存；每回合
 * 发现亦同源重扫）。调用方保证该 skillId 已确认不在 Hub 任一根（同名优先级：
 * Hub 版本永远先被解析，节点版本无法被绕过读到）。
 * - 边界校验先行：skill id 与包内相对路径共用 @helmx/protocol 契约；
 * - 节点离线 → 409 node_offline；读取 / 越界 / 超限 / 稳定性复核失败 →
 *   502 node_skill_read_failed（含脱敏诊断）；文件不存在 → 404 not_found。
 */
export async function readNodeSkillFile(
  host: NodeSkillsHostPort,
  nodeIdInput: string | undefined,
  cwd: string,
  skillId: string,
  path: string,
): Promise<string> {
  try {
    return await readNodeSkillFileInner(host, nodeIdInput, cwd, skillId, path)
  } catch (err) {
    // HelmxError（校验 / 离线 / not_found / 已显式化的读取失败）原样上抛；
    // 意外异常（宿主端口未接线 / 远端连接中途丢失等）统一显式 502，绝不伪装成功。
    if (err instanceof HelmxError) throw err
    throw new HelmxError(
      'node_skill_read_failed',
      `reading node skill '${skillId}' on node '${nodeIdInput ?? 'local'}' failed unexpectedly (${errorCodeOf(err)}): ${host.redact(errorMessageOf(err))}`,
      502,
      { skillId },
    )
  }
}

async function readNodeSkillFileInner(
  host: NodeSkillsHostPort,
  nodeIdInput: string | undefined,
  cwd: string,
  skillId: string,
  path: string,
): Promise<string> {
  try {
    assertSkillId(skillId)
  } catch (err) {
    throw new HelmxError('validation_error', `Invalid skill id: ${err instanceof Error ? err.message : String(err)}`, 400, { skillId })
  }
  let rel: string
  try {
    rel = assertSafeSkillRelativePath(path)
  } catch (err) {
    throw new HelmxError('validation_error', `Invalid skill-relative path: ${err instanceof Error ? err.message : String(err)}`, 400, { skillId, path })
  }
  if (cwd === '') {
    throw new HelmxError('not_found', `skill does not exist: ${skillId}`, 404, { skillId })
  }
  const nodeId = nodeIdInput ?? 'local'
  const redact = (text: string): string => host.redact(text)

  if (nodeId !== 'local') {
    try {
      if (!host.nodeIpc.isOnline(nodeId)) {
        throw new HelmxError('node_offline', `node '${nodeId}' is offline; cannot read node skill '${skillId}' (refusing to fall back to Hub skills)`, 409, { nodeId, skillId })
      }
    } catch (err) {
      if (err instanceof HelmxError) throw err
      throw new HelmxError('node_offline', `checking node '${nodeId}' online state failed (${errorCodeOf(err)}): ${redact(errorMessageOf(err))}`, 409, { nodeId, skillId })
    }
  }

  let env: ExecutionEnv
  try {
    env = host.executionEnv(nodeId, cwd)
  } catch (err) {
    throw new HelmxError(
      'node_skill_read_failed',
      `acquiring execution env for node '${nodeId}' failed (${errorCodeOf(err)}): ${redact(errorMessageOf(err))}`,
      502,
      { nodeId, skillId },
    )
  }

  const target = joinUnderCwd(cwd, ...NODE_SKILLS_RELATIVE_DIR.split('/'), skillId, ...rel.split('/'))
  const read = await readNodeFileBounded(env, target, redact)
  if (read.kind === 'absent') {
    throw new HelmxError('not_found', `skill does not exist: ${skillId}`, 404, { skillId, path: rel })
  }
  if (read.kind === 'refused') {
    throw new HelmxError('node_skill_read_failed', `reading node skill '${skillId}' (${rel}) on node '${nodeId}' failed: ${read.reason}`, 502, {
      nodeId,
      skillId,
      path: rel,
    })
  }
  return read.text
}

/** before_turn 显式注入段（节点技能库不可用说明；reason 已脱敏，此处统一转义）。 */
export function nodeSkillsUnavailableSection(nodeId: string | undefined, cwd: string, reason: string): { id: 'profile.node-skills-unavailable'; text: string } {
  return {
    id: 'profile.node-skills-unavailable',
    text: `<node_skills_unavailable dir="${escapeXml(joinUnderCwd(cwd, ...NODE_SKILLS_RELATIVE_DIR.split('/')))}" node="${escapeXml(nodeId ?? 'local')}">\n${escapeXml(reason)}\n</node_skills_unavailable>`,
  }
}
