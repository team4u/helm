/**
 * spawn 请求与 Profile 边界校验：agentType 解析（herdr:<kind>[@nodeId] 与
 * Profile.runtime.kind=herdr 双入口）、nodeId 优先级链、cwd 解析链、env 与
 * 启动参数的严格验证。
 * 所有非法输入在此显式抛 HelmError（validation_error / not_found / unsupported_runtime），
 * 绝不静默忽略字段或猜测私有 CLI flag。
 *
 * nodeId 优先级链（高 → 低；'local' 显式覆盖为「本机」语义，折叠为
 * explicitLocal 标记而不丢成 undefined——远端父会话的子 spawn 不静默继承）：
 * 1. 显式 agentType 前缀 `herdr:<kind>@<node>`（含 @local）；
 * 2. Profile.runtime.nodeId（含 'local'）；
 * 3. Profile 顶层 nodeId（Profile 常规节点绑定）；
 * 4. 父会话绑定节点（由 Executor 注入 parentNodeId；缺省本机）。
 */

import { HelmError, type Profile } from '@helm/protocol'
import { isValidNodeId } from './transport.js'

/** Herdr CLI Agent kind 标识（如 agy/claude/codex/pi；不做枚举硬编码，交由 Herdr 校验）。 */
const KIND_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/

export interface SpawnRouting {
  kind: string
  /**
   * 目标计算节点 ID：undefined = 按链回退（runtime/Profile/父节点）；
   * 'local' = 显式本机（覆盖远端父节点，绝不静默继承）。
   */
  nodeId?: string
  /** CLI 私有参数：仅来自 Profile.runtime.args（原样透传）。 */
  args: string[]
  /** Profile 配置工作目录（绝对路径语义，含 runtime.workspace 与 Profile.cwd）。 */
  workspace?: string
  /** Profile 声明的环境变量覆盖（非机密显式配置）。 */
  profileEnv: Record<string, string>
  /** 命中的 profileId（Profile 入口时存在，用于诊断）。 */
  profileId?: string
}

/** nodeId 校验（统一严格 token；'local' 合法）。 */
function assertNodeId(nodeId: string, source: { profileId?: string; agentType?: string }): string {
  if (!isValidNodeId(nodeId)) {
    const where = source.agentType !== undefined
      ? `agentType '${source.agentType}' 的 nodeId '${nodeId}'`
      : `Profile '${source.profileId}' 的 nodeId '${nodeId}'`
    throw new HelmError(
      'validation_error',
      `${where} 非法（单一安全 token：字母数字开头，可含 . _ -，长度 1..128；空串拒绝）`,
      400,
      { nodeId },
    )
  }
  return nodeId
}

/**
 * 解析 agentType 双入口：
 * 1. 显式前缀 'herdr:<kind>' 或 'herdr:<kind>@<nodeId>'；
 * 2. agentType 为已存在的 Profile ID 且 profile.runtime.kind === 'herdr'。
 * 非上述两种（普通 Profile / 未知前缀）返回 undefined 交还内核默认执行行；
 * Profile 存在但 runtime 配置非法时显式抛错（不吞）。
 */
export async function resolveSpawnRouting(
  agentType: string | undefined,
  profiles: { get(id: string): Promise<Profile | undefined> },
): Promise<SpawnRouting | undefined> {
  if (agentType !== undefined && agentType.startsWith('herdr:')) {
    return parseHerdrPrefix(agentType)
  }
  if (agentType === undefined || agentType === '') return undefined
  const profile = await profiles.get(agentType)
  if (profile === undefined) return undefined
  const runtime = profile.runtime
  if (runtime === undefined) return undefined
  if (runtime.kind !== 'herdr') {
    // 非 herdr runtime 交还内核（未来其他运行时插件的接管空间）。
    return undefined
  }
  const kind = runtime.agent
  if (!KIND_PATTERN.test(kind)) {
    throw new HelmError(
      'validation_error',
      `Profile '${agentType}' runtime.agent '${kind}' 非法（期望小写字母数字与连字符的 CLI kind）`,
      400,
      { profileId: agentType, agent: kind },
    )
  }
  let nodeId: string | undefined
  if (runtime.nodeId !== undefined) {
    nodeId = assertNodeId(runtime.nodeId, { profileId: agentType })
  } else if (profile.nodeId !== undefined) {
    // Profile 顶层节点绑定（会话与子执行共用；'local' 同样显式表达本机）。
    nodeId = assertNodeId(profile.nodeId, { profileId: agentType })
  }
  const args = runtime.args ?? []
  if (!args.every((a) => typeof a === 'string')) {
    throw new HelmError('validation_error', `Profile '${agentType}' runtime.args 必须全为字符串`, 400, {
      profileId: agentType,
    })
  }
  // workspace 解析：runtime.workspace > Profile.cwd（后者同时是会话默认 cwd）。
  const workspace = runtime.workspace ?? profile.cwd
  if (workspace !== undefined && !isAbsolutePath(workspace)) {
    throw new HelmError(
      'validation_error',
      `Profile '${agentType}' 工作目录必须是绝对路径（runtime.workspace / cwd，当前为 '${workspace}'）`,
      400,
      { profileId: agentType, workspace },
    )
  }
  const profileEnv = runtime.env ?? {}
  for (const [key, value] of Object.entries(profileEnv)) {
    if (!isValidEnvName(key) || typeof value !== 'string') {
      throw new HelmError(
        'validation_error',
        `Profile '${agentType}' runtime.env 含非法项 '${key}'（名称须为合法环境变量名且值为字符串）`,
        400,
        { profileId: agentType, key },
      )
    }
  }
  return {
    kind,
    nodeId,
    args,
    ...(workspace !== undefined ? { workspace } : {}),
    profileEnv,
    profileId: agentType,
  }
}

function parseHerdrPrefix(agentType: string): SpawnRouting {
  const body = agentType.slice('herdr:'.length)
  const at = body.indexOf('@')
  const kind = at >= 0 ? body.slice(0, at) : body
  const nodeIdRaw = at >= 0 ? body.slice(at + 1) : undefined
  if (!KIND_PATTERN.test(kind)) {
    throw new HelmError(
      'validation_error',
      `agentType '${agentType}' 的 kind '${kind}' 非法（期望如 herdr:agy、herdr:claude@node-a）`,
      400,
      { agentType, kind },
    )
  }
  let nodeId: string | undefined
  if (nodeIdRaw !== undefined) {
    nodeId = assertNodeId(nodeIdRaw, { agentType })
  }
  return { kind, nodeId, args: [], profileEnv: {} }
}

/**
 * 路径绝对性（纯规则，不依赖 Hub 平台 resolve）：POSIX `/...`、Windows 盘符
 * `C:\...` / `C:/...` 与 UNC `\\server\share\...` 均为绝对；`C:relative`
 *（无分隔符的盘符相对形态）拒绝。
 */
export function isAbsolutePath(p: string): boolean {
  if (p.startsWith('/')) return true
  if (p.startsWith('\\\\')) return p.length > 2
  return /^[A-Za-z]:[\\/]/.test(p)
}

export function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

/**
 * cwd 解析链：request.cwd（必须绝对路径）> Profile.workspace（runtime.workspace
 * > Profile.cwd）> 父会话 cwd（getConversation 现取）> defaultCwd。
 * 返回 undefined 表示用 defaultCwd。
 */
export function resolveCwd(
  requestCwd: string | undefined,
  routing: SpawnRouting | undefined,
  parentCwd: string | undefined,
): string {
  if (requestCwd !== undefined) {
    if (!isAbsolutePath(requestCwd)) {
      throw new HelmError('validation_error', `spawn cwd 必须是绝对路径：'${requestCwd}'`, 400, { cwd: requestCwd })
    }
    return requestCwd
  }
  if (routing?.workspace !== undefined) return routing.workspace
  if (parentCwd !== undefined && isAbsolutePath(parentCwd)) return parentCwd
  return ''
}

/**
 * 请求显式 model/effort 时显式拒绝：内核与插件不做 model/effort 到 23 种 CLI
 * 私有 flag 的隐式猜测映射（设计文档明令禁止）；需要定制时用 Profile.runtime.args。
 */
export function assertNoUnsupportedOverrides(model: string | undefined, effort: string | undefined): void {
  if (model !== undefined && model !== '') {
    throw new HelmError(
      'unsupported_runtime',
      `herdr 终端执行行不支持显式 model='${model}'（CLI 私有参数请经 Profile runtime.args 声明，不做隐式映射）`,
      400,
      { model },
    )
  }
  if (effort !== undefined) {
    throw new HelmError(
      'unsupported_runtime',
      `herdr 终端执行行不支持显式 effort='${effort}'（CLI 私有参数请经 Profile runtime.args 声明，不做隐式映射）`,
      400,
      { effort },
    )
  }
}

/** agent 名称：helm-wf-<短hash>，Herdr 侧名称长度上限 32。 */
export function buildAgentName(unique: string): string {
  const hash = HashShort.of(unique)
  const name = `helm-wf-${hash}`
  if (name.length > 32) throw new HelmError('validation_error', `agent 名称超长：${name}`, 400, { name })
  return name
}

/** 无依赖短哈希（FNV-1a 32bit → base36）；仅用于命名去重，不做安全用途。 */
export const HashShort = {
  of(input: string): string {
    let h = 0x811c9dc5
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(36)
  },
}

/** 交接文件名：wf-out-<safeId>.json|.md（与 transport 的 OUTPUT_FILE_PATTERN 对齐）。 */
export function buildOutputFileName(safeId: string, ext: 'json' | 'md'): string {
  const name = `wf-out-${safeId}.${ext}`
  if (!/^wf-out-[A-Za-z0-9_.-]{1,64}\.(json|md)$/.test(name)) {
    throw new HelmError('validation_error', `交接文件名非法：${name}`, 400, { name })
  }
  return name
}

/** startupTimeoutMs 严格 3001..300000（Herdr 服务端约束），默认 30000。 */
export function normalizeStartupTimeoutMs(value: unknown): number {
  const n = value === undefined ? 30_000 : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 3001 || n > 300_000) {
    throw new HelmError(
      'validation_error',
      `startupTimeoutMs 必须是 3001..300000 的整数（收到 ${String(n)}）`,
      400,
      { startupTimeoutMs: n },
    )
  }
  return n
}

/**
 * 任务提示词脱敏：先全文 redact 再进入任何截断（先截断可能把秘密拆成两半，
 * 前缀泄漏进模型上下文）；交接文件名与路径段非机密，原样保留。
 * 同样适用于交接契约里的 JSON Schema 文本（Schema 由调用方给定，但中央
 * 工具的持久脱敏不能代替外部 CLI prompt 本身的脱敏）。
 */
export function redactPromptText(text: string, redact: (t: string) => string, maxChars = 20_000): string {
  const redacted = redact(text)
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}\n[任务描述起长，已截断]` : redacted
}

/** JSON Schema 序列化后脱敏（同 redactPromptText 语义，供交接契约）。 */
export function redactSchemaText(schema: Record<string, unknown>, redact: (t: string) => string): string {
  return redact(JSON.stringify(schema))
}

/**
 * 受管环境变量（HELM_*）：由内核 managed/stash 构造保持权威，Profile 不得覆盖
 * （与 buildToolEnv「受管变量最后固定覆盖」同一内核约定）。HELM_HUB_URL 例外
 * 语义见 buildSpawnPaneEnv：远端窗格只允许显式配置的有效可达地址，或节点通道
 * 报告的该节点真实可达 hubUrl。
 */
export const MANAGED_ENV_KEYS = Object.freeze([
  'HELM_ENV',
  'HELM_CONVERSATION_ID',
  'HELM_CWD',
  'HELM_DATA_DIR',
  'HELM_TOKEN',
])

/**
 * 窗格 env 构造（本机与远端共用入口）：
 * - 受管 HELM_* 固定覆盖 Profile 注入（防劫持回连/身份变量）；
 * - managed/stash 的值最后覆盖 Profile，保持任务与本机工具相同优先级；
 * - 远端剥除指向本机的 HELM_HUB_URL/HELM_TOKEN，除非 Profile 显式配置了
 *   有效可达的 http(s) 地址，或节点通道提供了该节点真实可达的 hubUrl
 *   （此时该地址优先级：Profile 显式 > 通道 hubUrl > 剥除）。
 */
export function buildSpawnPaneEnv(
  managedEnv: Record<string, string>,
  profileEnv: Record<string, string>,
  options: { remote: boolean; nodeHubUrl?: string },
): { env: Record<string, string>; stripped: string[]; hubUrlOverridden: boolean } {
  const stripped: string[] = []
  const managed = { ...managedEnv }
  const env: Record<string, string> = {}

  // 显式远端可达 HELM_HUB_URL：远端回连合法来源（Profile 显式优先，其次节点通道）。
  const explicitUrl = profileEnv['HELM_HUB_URL']
  const channelUrl = options.nodeHubUrl
  const explicitReachable = explicitUrl !== undefined && isValidRemoteHubUrl(explicitUrl)
  // 该地址来自节点自身的连接配置；本机 BYOM 或隧道可合法使用 loopback。
  // 不能把“Hub 的回环地址不可复制”误当成“节点自己的回环地址不可用”。
  const channelReachable = channelUrl !== undefined && isHttpUrl(channelUrl)
  if (options.remote) {
    if (explicitUrl !== undefined && !isHttpUrl(explicitUrl)) {
      throw new HelmError(
        'validation_error',
        `Profile runtime.env.HELM_HUB_URL 必须是 http(s) URL（收到 '${explicitUrl}'），远端窗格拒绝注入无效回连地址`,
        400,
        { hubUrl: explicitUrl },
      )
    }
    if (explicitReachable) {
      env['HELM_HUB_URL'] = explicitUrl
      delete managed['HELM_HUB_URL']
    } else if (channelReachable) {
      env['HELM_HUB_URL'] = channelUrl
      delete managed['HELM_HUB_URL']
    } else {
      delete managed['HELM_HUB_URL']
      delete managed['HELM_TOKEN']
      stripped.push('HELM_HUB_URL', 'HELM_TOKEN')
    }
  }

  // 其余受管 HELM_* 最后固定覆盖（内核约定：managed/stash 权威）。
  for (const [key, value] of Object.entries(profileEnv)) {
    if (key === 'HELM_HUB_URL' && (explicitReachable || channelReachable)) continue
    if (key === 'HELM_TOKEN' && (explicitReachable || channelReachable)) continue
    if (MANAGED_ENV_KEYS.includes(key) || key === 'HELM_HUB_URL') continue
    env[key] = value
  }
  Object.assign(env, managed)
  const hubUrlOverridden = options.remote && (explicitReachable || channelReachable)
  return { env, stripped, hubUrlOverridden }
}

/** http(s) URL 才可能是回连地址（file:/unix: 等一律无效）。 */
export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** 远端可达：显式 http(s) 且主机非 loopback。 */
export function isValidRemoteHubUrl(url: string): boolean {
  return isHttpUrl(url) && !isLoopbackUrl(url)
}

export function isLoopbackUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return true
  }
  const host = parsed.hostname
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host)
}
