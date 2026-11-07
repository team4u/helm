/**
 * spawn 请求与 Profile 边界校验：agentType 解析（herdr:<kind>[@machine] 与
 * Profile.runtime.kind=herdr 双入口）、cwd 解析链、env 与启动参数的严格验证。
 * 所有非法输入在此显式抛 HelmError（validation_error / not_found / unsupported_runtime），
 * 绝不静默忽略字段或猜测私有 CLI flag。
 */

import { HelmError, type Profile } from '@helm/protocol'

/** Herdr CLI Agent kind 标识（如 agy/claude/codex/pi；不做枚举硬编码，交由 Herdr 校验）。 */
const KIND_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/
const MACHINE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,255}$/

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
  if (runtime.machine !== undefined && !MACHINE_PATTERN.test(runtime.machine)) {
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
  if (machine !== undefined && !MACHINE_PATTERN.test(machine)) {
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
  if (!/^[wf-out-]?[A-Za-z0-9_.-]{1,64}$/.test(name)) {
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
 * 远端可达性过滤：远端窗格默认剥除指向本机 loopback 的 HELM_HUB_URL/HELM_TOKEN，
 * 除非 Profile.runtime.env.HELM_HUB_URL 显式配置了非 localhost 地址。
 * loopback 判定覆盖 127.x、localhost 与 ::1（防 127.0.0.1 绕过）。
 */
export function buildRemoteSpawnEnv(
  baseEnv: Record<string, string>,
  profileEnv: Record<string, string>,
): { env: Record<string, string>; stripped: string[] } {
  const stripped: string[] = []
  const env: Record<string, string> = { ...baseEnv, ...profileEnv }
  const explicitUrl = profileEnv['HELM_HUB_URL']
  const urlIsRemoteReachable = explicitUrl !== undefined && !isLoopbackUrl(explicitUrl)
  if (!urlIsRemoteReachable) {
    if ('HELM_HUB_URL' in env) {
      stripped.push('HELM_HUB_URL')
      delete env['HELM_HUB_URL']
    }
    if ('HELM_TOKEN' in env) {
      stripped.push('HELM_TOKEN')
      delete env['HELM_TOKEN']
    }
  } else if ('HELM_TOKEN' in env && explicitUrl !== undefined) {
    // 显式远端可达 URL 时保留 token（远端经该 URL 回连 hub）。
  }
  return { env, stripped }
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
