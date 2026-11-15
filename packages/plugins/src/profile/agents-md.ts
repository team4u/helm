/**
 * builtin:profile 工作区 AGENTS.md 自动读取与 before_turn 注入段计算
 * （策略归插件层；内核只提供 executionEnv / nodeIpc / redact 机制端口，
 * 本模块零内核改动）。
 *
 * 诚实性纪律（对齐仓库 AGENTS.md 第 3 节红线）：
 * - 工作区无 AGENTS.md 普通文件（not_found / is_directory）或内容纯空白
 *   属常态，本回合不注入任何段落；
 * - 远端节点离线、权限或 IO 故障绝不静默降级为「文件不存在」，注入显式
 *   <project_instructions_unavailable> 说明段告知模型本回合缺失及原因；
 * - 文件内容与错误信息先经宿主全局脱敏（SecretStash 机密不进系统提示词），
 *   超 64k 字符上限显式截断并附说明，绝不静默截断。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { HelmError, pathRulesForShape, targetPathShape } from '@helm/protocol'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { escapeXmlText } from './catalog.js'

/** 工作区项目约定文件名（跨工具社区约定，逐回合实时重读）。 */
export const AGENTS_MD_FILENAME = 'AGENTS.md'

/**
 * AGENTS.md 注入字符上限（与长期记忆 MEMORY.md 同口径的 64k 防线）：
 * 项目约定逐回合全量注入系统提示，超限截断并显式说明。
 */
export const MAX_AGENTS_MD_CHARS = 64_000

/** 超限截断显式说明（附在截断内容之后，绝不静默截断）。 */
const AGENTS_MD_TRUNCATION_NOTE = `\n[ helm 提示：AGENTS.md 超过 ${MAX_AGENTS_MD_CHARS} 字符上限，以上为前 ${MAX_AGENTS_MD_CHARS} 字符 ]`

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
    text: `<project_instructions_unavailable path="${escapeXmlText(agentsPath)}" node="${escapeXmlText(nodeId)}">\n${body}\n</project_instructions_unavailable>`,
  }
}

function errorCodeOf(err: unknown): string {
  return err instanceof HelmError ? err.code : 'unknown'
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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

  // 远端节点在线预检：isOnline === false 直接判定离线并显式注入说明——不
  // 进入 executionEnv（远端 RPC 会按重连窗口阻塞等待数十秒）。isOnline
  // 自身抛错（宿主未接线 nodeIpc 等 HelmError）时继续尝试执行环境，读取的
  // 真实结果/错误仍按下方规则如实处理。
  if (nodeId !== 'local') {
    try {
      if (!host.nodeIpc.isOnline(nodeId)) {
        return unavailableSection(
          agentsPath,
          nodeId,
          `目标节点 ${escapeXmlText(nodeId)} 当前离线，本回合未能读取工作区 ${escapeXmlText(agentsPath)}。`,
        )
      }
    } catch (err) {
      if (!(err instanceof HelmError)) throw err
    }
  }

  let env: ExecutionEnv
  try {
    // 短生命周期执行环境，用后即弃，绝不缓存（与内核约定一致）。
    env = host.executionEnv(nodeId, cwd)
  } catch (err) {
    // 测试夹具兼容：未覆写 executionEnv 的标准桩同步抛 unsupported（501），
    // 视为宿主未接线执行环境，本回合不注入；其余异常按读取失败显式注入。
    if (err instanceof HelmError && err.code === 'unsupported') return { kind: 'none' }
    return unavailableSection(
      agentsPath,
      nodeId,
      `读取工作区 ${escapeXmlText(agentsPath)} 失败（${escapeXmlText(errorCodeOf(err))}）：${escapeXmlText(host.redact(errorMessageOf(err)))}`,
    )
  }

  try {
    const result = await env.readTextFile(agentsPath, BACKGROUND_CONTEXT)
    if (result.ok) {
      // 纯空白文件＝无项目约定，不注入（与 SYSTEM.md 空白同口径）。
      if (result.value.trim() === '') return { kind: 'none' }
      // 脱敏先于长度检查与截断：工作区文件可能意外包含机密明文。
      const redacted = host.redact(result.value)
      const content =
        redacted.length > MAX_AGENTS_MD_CHARS
          ? `${redacted.slice(0, MAX_AGENTS_MD_CHARS)}${AGENTS_MD_TRUNCATION_NOTE}`
          : redacted
      return {
        kind: 'section',
        id: 'profile.agents',
        text: `<project_instructions path="${escapeXmlText(agentsPath)}">\n${content}\n</project_instructions>`,
      }
    }
    // 工作区无 AGENTS.md 普通文件（缺失或同名目录）属常态，不注入。
    if (
      result.error.code === 'not_found' ||
      result.error.code === 'is_directory' ||
      result.error.message.includes('EISDIR')
    ) {
      return { kind: 'none' }
    }
    // 权限 / 连接中断等真实错误：绝不静默吞掉，显式注入失败说明。
    return unavailableSection(
      agentsPath,
      nodeId,
      `读取工作区 ${escapeXmlText(agentsPath)} 失败（${escapeXmlText(result.error.code)}）：${escapeXmlText(host.redact(result.error.message))}`,
    )
  } catch (err) {
    return unavailableSection(
      agentsPath,
      nodeId,
      `读取工作区 ${escapeXmlText(agentsPath)} 失败（${escapeXmlText(errorCodeOf(err))}）：${escapeXmlText(host.redact(errorMessageOf(err)))}`,
    )
  }
}
