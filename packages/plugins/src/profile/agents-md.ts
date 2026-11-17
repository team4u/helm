/**
 * builtin:profile 工作区 AGENTS.md 自动读取与 before_turn 注入段计算
 * （策略归插件层；内核只提供 executionEnv / nodeIpc / redact 机制端口，
 * 本模块零内核改动）。
 *
 * 诚实性纪律（对齐仓库 AGENTS.md 第 3 节红线）：
 * - 工作区无 AGENTS.md（不存在 / 同名目录 / 悬空软链）或内容纯空白属常态，
 *   本回合不注入任何段落；
 * - 读取全程使用 ExecutionEnv 安全原语，封死 TOCTOU 与无界读取：
 *   canonicalPath 解析软链后以 openBinaryReader(realPath, { noFollow: true })
 *   打开——noFollow 拒绝预检后被换成软链的最终组件，节点实现以 O_NONBLOCK
 *   打开使被换成 FIFO 等特殊文件时既不阻塞也过不了普通文件检查；kind/size
 *   以同一已打开句柄上的 reader.info 为权威（打开的是什么就读什么，与路径
 *   此刻指向无关，路径再换也无法劫持本次读取）；正文只经
 *   reader.read(0, MAX_AGENTS_MD_BYTES + 1) 有界定位读，超限即实证拒绝，
 *   绝不调用 readTextFile 无界整读；读后同句柄二次 info 复核 size/mtime
 *   与实读字节数，读取期间发生变化显式注入不可用说明，绝不把旧前缀当
 *   完整快照注入；所有路径 finally 显式关闭句柄；
 * - 特殊文件与超过字节上限的文件绝不读取正文，显式注入
 *   <project_instructions_unavailable> 说明原因；
 * - 远端节点离线、宿主能力未接线（nodeIpc / executionEnv 抛 unsupported
 *   等）、权限或 IO 故障绝不静默降级为「文件不存在」，一律注入显式说明段
 *   告知模型本回合缺失及原因；
 * - 文件内容与错误信息先经宿主全局脱敏（SecretStash 机密不进系统提示词），
 *   超 64k 字符上限显式截断并附说明，绝不静默截断。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { HelmError, escapeXml, pathRulesForShape, targetPathShape } from '@helm/protocol'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'


/** 工作区项目约定文件名（跨工具社区约定，逐回合实时重读）。 */
export const AGENTS_MD_FILENAME = 'AGENTS.md'

/**
 * AGENTS.md 注入字符上限（与长期记忆 MEMORY.md 同口径的 64k 防线）：
 * 项目约定逐回合全量注入系统提示，超限截断并显式说明。
 */
export const MAX_AGENTS_MD_CHARS = 64_000

/**
 * AGENTS.md 读取前置字节上限（有界保护）：同句柄 info 报告超过该字节数
 * 即不读正文，或一次有界 read 读到超过该字节数即实证拒绝，均显式注入
 * 不可用说明。MAX_AGENTS_MD_CHARS 的最坏 UTF-8 编码约 3 字节/字符（192k），
 * 256k 覆盖极限正文仍有余量；超界文件即使注入也只能取不到四分之一内容，
 * 属病态用法，绝不整读进内存与系统提示。
 */
export const MAX_AGENTS_MD_BYTES = 256 * 1024

/** 超限截断显式说明（附在截断内容之后，绝不静默截断）。 */
const AGENTS_MD_TRUNCATION_NOTE = `\n[ helm 提示：AGENTS.md 超过 ${MAX_AGENTS_MD_CHARS} 字符上限，以上为前 ${MAX_AGENTS_MD_CHARS} 字符 ]`

/** AGENTS.md 正文按 UTF-8 解码（非法序列替换为 U+FFFD，与 readTextFile 同口径）。 */
const AGENTS_MD_UTF8_DECODER = new TextDecoder('utf-8')

/** 计算结果：none=本回合无注入；section=注入 profile.agents / profile.agents-unavailable。 */
export type AgentsMdInjection =
  | { kind: 'none' }
  | { kind: 'section'; id: 'profile.agents' | 'profile.agents-unavailable'; text: string }

/** 读取依赖的最小宿主形状（真实 ctx.host 天然满足；测试可注入受控实现）。 */
export interface AgentsMdHostPort {
  executionEnv(nodeId: string, cwd: string): ExecutionEnv
  redact(text: string): string
  nodeIpc: { isOnline(nodeId: string): boolean }
}

function unavailableSection(agentsPath: string, nodeId: string, body: string): AgentsMdInjection {
  return {
    kind: 'section',
    id: 'profile.agents-unavailable',
    text: `<project_instructions_unavailable path="${escapeXml(agentsPath)}" node="${escapeXml(nodeId)}">\n${body}\n</project_instructions_unavailable>`,
  }
}

function errorCodeOf(err: unknown): string {
  return err instanceof HelmError ? err.code : 'unknown'
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 统一的读取失败说明（错误码 + 脱敏后的错误消息，均 XML 转义）。 */
function readFailureBody(
  agentsPath: string,
  code: string,
  message: string,
  redact: (text: string) => string,
): string {
  return `读取工作区 ${escapeXml(agentsPath)} 失败（${escapeXml(code)}）：${escapeXml(redact(message))}`
}

/**
 * 有界读取结果：absent=常态缺失（不注入）；refused=显式不可读（reason 已
 * 脱敏转义，直接进入不可用说明段）；content=同句柄稳定读到的 UTF-8 正文。
 */
type AgentsMdRead =
  | { kind: 'absent' }
  | { kind: 'refused'; reason: string }
  | { kind: 'content'; text: string }

/** 目录与缺失（含 EISDIR 消息）属常态；其余错误显式不可读。 */
function isAbsentFileError(error: { code: string; message: string }): boolean {
  return error.code === 'not_found' || error.code === 'is_directory' || error.message.includes('EISDIR')
}

/**
 * 有界安全读取（local 与 remote ExecutionEnv 共用同一契约，均在
 * BACKGROUND_CONTEXT 下调用）：
 * - canonicalPath 先解析软链：悬空软链按不存在处理（常态）；解析后的
 *   realPath 是本次读取的锚点；
 * - openBinaryReader(realPath, { noFollow: true }) 在锚点上打开普通文件做
 *   有界定位读：目录报 is_directory、其余非普通文件报 invalid（节点实现
 *   O_NONBLOCK 打开，FIFO 不阻塞）；noFollow 拒最终组件软链——封死预检后
 *   路径被换成软链的竞态窗口，被换目标绝不会以本路径身份被读取；
 * - 打开后 kind/size 以同句柄 reader.info 为权威（fd 视图而非路径视图）：
 *   非普通文件与超过 MAX_AGENTS_MD_BYTES 均不读正文，显式拒绝；
 * - 正文只经 reader.read(0, MAX_AGENTS_MD_BYTES + 1)（SDK 契约：至多
 *   length 字节、仅 EOF 处更短），超限即实证拒绝，绝无先无界整读后拒绝；
 * - 读后二次同句柄 info 复核：size/mtime 与打开时不一致，或实读字节数与
 *   稳定 size 不一致，均按读取期间变化显式拒绝，绝不把旧前缀当完整快照；
 * - 全部路径 finally 关闭句柄（远端 reader 生命周期与连接绑定，显式 close
 *   立即回收）。
 */
async function readAgentsMdBounded(
  env: ExecutionEnv,
  agentsPath: string,
  redact: (text: string) => string,
): Promise<AgentsMdRead> {
  const canonical = await env.canonicalPath(agentsPath, BACKGROUND_CONTEXT)
  if (!canonical.ok) {
    if (isAbsentFileError(canonical.error)) return { kind: 'absent' }
    return {
      kind: 'refused',
      reason: `解析工作区 ${escapeXml(agentsPath)} 真实路径失败（${escapeXml(canonical.error.code)}）：${escapeXml(redact(canonical.error.message))}`,
    }
  }
  const realPath = canonical.value

  const openedR = await env.openBinaryReader(realPath, { noFollow: true }, BACKGROUND_CONTEXT)
  if (!openedR.ok) {
    // 打开失败即止步：绝无 readTextFile 等无界回退（路径可能已被换成
    // FIFO / 软链，任何按路径整读都可能阻塞或读到劫持目标）。
    if (isAbsentFileError(openedR.error)) return { kind: 'absent' }
    return {
      kind: 'refused',
      reason: readFailureBody(agentsPath, openedR.error.code, openedR.error.message, redact),
    }
  }
  const reader = openedR.value
  try {
    // 同句柄权威元信息（fd 视图）：kind/size 以打开后的 reader 为准。
    const infoR = await reader.info(BACKGROUND_CONTEXT)
    if (!infoR.ok) {
      return {
        kind: 'refused',
        reason: readFailureBody(agentsPath, infoR.error.code, infoR.error.message, redact),
      }
    }
    const info = infoR.value
    if (info.kind !== 'file') {
      return {
        kind: 'refused',
        reason: `工作区 ${escapeXml(agentsPath)} 在打开后不是普通文件（kind=${escapeXml(info.kind)}），拒绝读取`,
      }
    }
    if (info.size > MAX_AGENTS_MD_BYTES) {
      return {
        kind: 'refused',
        reason: `工作区 ${escapeXml(agentsPath)} 为 ${info.size} 字节，超过 ${MAX_AGENTS_MD_BYTES} 字节读取上限，本回合未读取正文`,
      }
    }

    // 有界定位读：请求上限+1，读到上限+1 即实证超限（打开后文件仍可能增长）。
    const readR = await reader.read(0, MAX_AGENTS_MD_BYTES + 1, BACKGROUND_CONTEXT)
    if (!readR.ok) {
      return {
        kind: 'refused',
        reason: readFailureBody(agentsPath, readR.error.code, readR.error.message, redact),
      }
    }
    const bytes = readR.value
    if (bytes.byteLength > MAX_AGENTS_MD_BYTES) {
      return {
        kind: 'refused',
        reason: `工作区 ${escapeXml(agentsPath)} 读取到 ${bytes.byteLength} 字节，超过 ${MAX_AGENTS_MD_BYTES} 字节读取上限，本回合不注入正文`,
      }
    }

    // 读后同句柄二次复核：读取期间变化（增长 / 截断 / 改写）显式拒绝。
    const afterR = await reader.info(BACKGROUND_CONTEXT)
    if (!afterR.ok) {
      return {
        kind: 'refused',
        reason: readFailureBody(agentsPath, afterR.error.code, afterR.error.message, redact),
      }
    }
    const after = afterR.value
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
      return {
        kind: 'refused',
        reason: `工作区 ${escapeXml(agentsPath)} 读取期间文件发生变化（size ${info.size} -> ${after.size}，mtime ${info.mtimeMs} -> ${after.mtimeMs}），本回合不注入可能不完整的快照`,
      }
    }
    if (bytes.byteLength !== after.size) {
      return {
        kind: 'refused',
        reason: `工作区 ${escapeXml(agentsPath)} 读取到 ${bytes.byteLength} 字节与稳定大小 ${after.size} 不一致，本回合不注入可能不完整的快照`,
      }
    }
    return { kind: 'content', text: AGENTS_MD_UTF8_DECODER.decode(bytes) }
  } finally {
    // 成功 / 拒绝 / 异常路径一律显式关闭同一句柄。
    await reader.close(BACKGROUND_CONTEXT)
  }
}

/**
 * 读取会话靶点工作区（nodeId ?? 'local' + cwd）下的 AGENTS.md 并计算
 * before_turn 注入段。路径按 cwd 自身形状选择词法规则合成（POSIX 与
 * Windows 靶点路径均安全）；cwd 为空串直接跳过。
 */
export async function computeAgentsMdSection(
  host: AgentsMdHostPort,
  nodeIdInput: string | undefined,
  cwd: string,
): Promise<AgentsMdInjection> {
  if (cwd === '') return { kind: 'none' }
  const nodeId = nodeIdInput ?? 'local'
  const agentsPath = pathRulesForShape(targetPathShape(cwd)).join(cwd, AGENTS_MD_FILENAME)
  const redact = (text: string): string => host.redact(text)

  // 远端节点在线预检：isOnline === false 直接判定离线并显式注入说明——不
  // 进入 executionEnv（远端 RPC 会按重连窗口阻塞等待数十秒）。isOnline
  // 自身抛错（宿主未接线 nodeIpc 等能力故障）同样显式注入不可用说明，绝不
  // 静默当作「探测通过」继续，也不吞错降级。
  if (nodeId !== 'local') {
    try {
      if (!host.nodeIpc.isOnline(nodeId)) {
        return unavailableSection(
          agentsPath,
          nodeId,
          `目标节点 ${escapeXml(nodeId)} 当前离线，本回合未能读取工作区 ${escapeXml(agentsPath)}。`,
        )
      }
    } catch (err) {
      return unavailableSection(
        agentsPath,
        nodeId,
        `检查目标节点 ${escapeXml(nodeId)} 在线状态失败（${escapeXml(errorCodeOf(err))}）：${escapeXml(redact(errorMessageOf(err)))}`,
      )
    }
  }

  let env: ExecutionEnv
  try {
    // 短生命周期执行环境，用后即弃，绝不缓存（与内核约定一致）。
    env = host.executionEnv(nodeId, cwd)
  } catch (err) {
    // 宿主能力未接线（unsupported）与真实故障一视同仁：显式注入不可用说明，
    // 绝不静默降级为「无 AGENTS.md」。
    return unavailableSection(
      agentsPath,
      nodeId,
      readFailureBody(agentsPath, errorCodeOf(err), errorMessageOf(err), redact),
    )
  }

  try {
    const read = await readAgentsMdBounded(env, agentsPath, redact)
    if (read.kind === 'absent') return { kind: 'none' }
    if (read.kind === 'refused') return unavailableSection(agentsPath, nodeId, read.reason)
    // 纯空白文件＝无项目约定，不注入（与 SYSTEM.md 空白同口径）。
    if (read.text.trim() === '') return { kind: 'none' }
    // 脱敏先于长度检查与截断：工作区文件可能意外包含机密明文。
    const redacted = host.redact(read.text)
    const content =
      redacted.length > MAX_AGENTS_MD_CHARS
        ? `${redacted.slice(0, MAX_AGENTS_MD_CHARS)}${AGENTS_MD_TRUNCATION_NOTE}`
        : redacted
    return {
      kind: 'section',
      id: 'profile.agents',
      text: `<project_instructions path="${escapeXml(agentsPath)}">\n${content}\n</project_instructions>`,
    }
  } catch (err) {
    return unavailableSection(
      agentsPath,
      nodeId,
      readFailureBody(agentsPath, errorCodeOf(err), errorMessageOf(err), redact),
    )
  }
}
