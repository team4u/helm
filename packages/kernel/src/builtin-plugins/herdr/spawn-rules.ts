/**
 * spawn 请求与 Profile 边界校验：agentType 解析（herdr:<kind>[@machine] 与
 * Profile.runtime.kind=herdr 双入口）、cwd 解析链、env 与启动参数的严格验证。
 * 所有非法输入在此显式抛 HelmError（validation_error / not_found / unsupported_runtime），
 * 绝不静默忽略字段或猜测私有 CLI flag。
 */

import { HelmError, type Profile } from '@helm/protocol'
import { isValidMachineName } from './transport.js'

/** Herdr CLI Agent kind 标识（如 agy/claude/codex/pi；不做枚举硬编码，交由 Herdr 校验）。 */
const KIND_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/

export interface SpawnRouting {
  kind: string
  machine?: string
  /** CLI 私有参数：仅来自 Profile.runtime.args（原样透传）。 */
  args: string[]
  /** Profile 配置工作目录（绝对路径语义，由 ProfileService 保证）。 */
  workspace?: string
  /** Profile 声明的环境变量覆盖（非机密显式配置）。 */
  profileEnv: Record<string, string>
  /** 命中的 profileId（Profile 入口时存在，用于诊断）。 */
  profileId?: string
}

/**
 * 解析 agentType 双入口：
 * 1. 显式前缀 'herdr:<kind>' 或 'herdr:<kind>@<machine>'；
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
  if (runtime.machine !== undefined && !isValidMachineName(runtime.machine)) {
    throw new HelmError(
      'validation_error',
      `Profile '${agentType}' runtime.machine '${runtime.machine}' 非法（ssh 目标机单一 argv，拒绝注入）`,
      400,
      { profileId: agentType, machine: runtime.machine },
    )
  }
  const args = runtime.args ?? []
  if (!args.every((a) => typeof a === 'string')) {
    throw new HelmError('validation_error', `Profile '${agentType}' runtime.args 必须全为字符串`, 400, {
      profileId: agentType,
    })
  }
  if (runtime.workspace !== undefined && !isAbsolutePath(runtime.workspace)) {
    throw new HelmError(
      'validation_error',
      `Profile '${agentType}' runtime.workspace 必须是绝对路径（当前为 '${runtime.workspace}'）`,
      400,
      { profileId: agentType, workspace: runtime.workspace },
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
    ...(runtime.machine !== undefined ? { machine: runtime.machine } : {}),
    args,
    ...(runtime.workspace !== undefined ? { workspace: runtime.workspace } : {}),
    profileEnv,
    profileId: agentType,
  }
}

function parseHerdrPrefix(agentType: string): SpawnRouting {
  const body = agentType.slice('herdr:'.length)
  const at = body.indexOf('@')
  const kind = at >= 0 ? body.slice(0, at) : body
  const machine = at >= 0 ? body.slice(at + 1) : undefined
  if (!KIND_PATTERN.test(kind)) {
    throw new HelmError(
      'validation_error',
      `agentType '${agentType}' 的 kind '${kind}' 非法（期望如 herdr:agy、herdr:claude@remote）`,
      400,
      { agentType, kind },
    )
  }
  if (machine !== undefined && !isValidMachineName(machine)) {
    throw new HelmError(
      'validation_error',
      `agentType '${agentType}' 的 machine '${machine}' 非法（ssh 单一 argv 目标，拒绝空白与选项注入）`,
      400,
      { agentType, machine },
    )
  }
  return { kind, ...(machine !== undefined ? { machine } : {}), args: [], profileEnv: {} }
}

export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/')
}

export function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

/**
 * cwd 解析链：request.cwd（必须绝对路径）> Profile.runtime.workspace > 父会话
 * cwd（getConversation 现取）> defaultCwd。返回 undefined 表示用 defaultCwd。
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
 * 语义见 buildRemoteSpawnEnv：远端窗格只允许 Profile 显式配置的有效可达地址。
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
 *   有效可达的 http(s) 地址（此时显式 URL 也覆盖受管值）。
 */
export function buildSpawnPaneEnv(
  managedEnv: Record<string, string>,
  profileEnv: Record<string, string>,
  options: { remote: boolean },
): { env: Record<string, string>; stripped: string[]; hubUrlOverridden: boolean } {
  const stripped: string[] = []
  const managed = { ...managedEnv }
  const env: Record<string, string> = {}

  // 显式远端可达 HELM_HUB_URL：远端回连唯一合法覆盖（本机窗格不接受 Profile 覆盖）。
  const explicitUrl = profileEnv['HELM_HUB_URL']
  const explicitReachable = explicitUrl !== undefined && isValidRemoteHubUrl(explicitUrl)
  if (options.remote) {
    if (explicitReachable) {
      env['HELM_HUB_URL'] = explicitUrl
      delete managed['HELM_HUB_URL']
    } else {
      if (explicitUrl !== undefined && !isHttpUrl(explicitUrl)) {
        throw new HelmError(
          'validation_error',
          `Profile runtime.env.HELM_HUB_URL 必须是 http(s) URL（收到 '${explicitUrl}'），远端窗格拒绝注入无效回连地址`,
          400,
          { hubUrl: explicitUrl },
        )
      }
      delete managed['HELM_HUB_URL']
      delete managed['HELM_TOKEN']
      stripped.push('HELM_HUB_URL', 'HELM_TOKEN')
    }
  }

  // 其余受管 HELM_* 最后固定覆盖（内核约定：managed/stash 权威）。
  for (const [key, value] of Object.entries(profileEnv)) {
    if (key === 'HELM_HUB_URL' && explicitReachable) continue
    if (key === 'HELM_TOKEN' && explicitReachable) continue
    if (MANAGED_ENV_KEYS.includes(key) || key === 'HELM_HUB_URL') continue
    env[key] = value
  }
  Object.assign(env, managed)
  const hubUrlOverridden = explicitReachable && options.remote
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
