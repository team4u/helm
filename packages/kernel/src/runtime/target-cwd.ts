/**
 * 会话 / spawn cwd 按目标节点平台统一规范化收口（kernel 内唯一实现）。
 *
 * 所有进入持久化（会话镜像 / 子会话登记）或执行环境（SDK agent cwd /
 * worktree 源目录 / Herdr 窗格 cwd）的 cwd，都经 normalizeSessionCwd：
 * - 相对路径（含 Windows 盘符相对 C:relative）显式拒绝（既有契约）；
 * - 平台已知：复用 @helm/protocol normalizeTargetPath（win32 目标上把
 *   WSL /mnt/<盘符>、Git Bash /<盘符>、//server/share 视图确定性转换为
 *   规范 Windows 路径；POSIX 目标仅词法归一，绝不反向改写）；
 * - 目标节点平台无可信信息（远端未注册 / 未上报）：不猜、不改写，原样
 *   透传（绝对性校验仍然生效）。
 *
 * 平台事实来源（诚实性红线）：local 默认用 process.platform，测试可通过
 * trustedPlatformFromEnvFabric 注入 Hub 平台；远端只用 NodeRegistry 注册时
 * 上报的可信 platform，绝不探测、绝不用路径形状倒推目标平台。
 */

import { HelmError, isAbsoluteTargetPath, normalizeTargetPath, targetPlatformOf, type TargetPlatform } from '@helm/protocol'
import type { EnvFabric } from '../env/index.js'

/**
 * 可信节点平台来源：返回节点上报的原始 platform 字符串（如 'linux' /
 * 'win32' / 'darwin'）；unknown / 未上报返回 undefined。
 */
export type TrustedNodePlatformSource = (nodeId: string) => string | undefined

/**
 * EnvFabric 的平台事实最小结构（结构性依赖：测试可注入轻量 stub，
 * 不必构造完整 NodeRegistry）。生产 EnvFabric 提供 nodePlatformOf 只读
 * 端口时优先使用（唯一事实出口，见 env/fabric.ts）；仅有 registry 的
 * 结构性 stub 退回直读注册表，语义与端口一致。
 */
export interface TrustedPlatformHost {
  registry: { get(nodeId: string): { platform: string } | undefined }
  /** 可选 Hub 平台事实端口（测试可注入，生产缺省回退 process.platform）。 */
  hubPlatform?(): string | undefined
  /** 可选最小只读平台端口（EnvFabric.nodePlatformOf）；远端平台优先使用。 */
  nodePlatformOf?(nodeId: string): string | undefined
}

/**
 * 生产可信来源：local 优先 EnvFabric.hubPlatform（测试注入），缺省回退
 * process.platform；远端优先 EnvFabric.nodePlatformOf 只读端口（NodeRegistry
 * 注册上报的 platform，未注册 / 未上报 = undefined）；仅有 registry 的结构性
 * stub 退回直读注册表（同一语义）。
 */
export function trustedPlatformFromEnvFabric(
  envFabric: EnvFabric | TrustedPlatformHost | undefined,
): TrustedNodePlatformSource {
  return (nodeId) => {
    if (nodeId === 'local') {
      return envFabric?.hubPlatform?.() || envFabric?.nodePlatformOf?.('local') || process.platform
    }
    if (envFabric?.nodePlatformOf !== undefined) return envFabric.nodePlatformOf(nodeId)
    return envFabric?.registry.get(nodeId)?.platform || undefined
  }
}

/**
 * 解析目标节点平台语义：undefined 表示无可信信息（调用方不得猜测）。
 * nodeId 缺省 / 空串视为 'local'；local 默认使用 process.platform，显式
 * trustedPlatform 来源可提供测试用 Hub 平台事实；远端只用来源上报。
 */
export function resolveTargetPlatform(
  nodeId: string | undefined,
  source?: TrustedNodePlatformSource,
): TargetPlatform | undefined {
  const id = nodeId === undefined || nodeId === '' ? 'local' : nodeId
  if (id === 'local') {
    const raw = source?.(id) || process.platform
    return targetPlatformOf(raw)
  }
  const raw = source?.(id)
  return raw !== undefined && raw !== '' ? targetPlatformOf(raw) : undefined
}

/** normalizeSessionCwd 入参。 */
export interface NormalizeSessionCwdOptions {
  /** 目标计算节点（缺省 / 空串 = 'local'）。 */
  nodeId?: string
  /** 可信平台来源（缺省仅 local 可解析）。 */
  trustedPlatform?: TrustedNodePlatformSource
  /** 诊断用入口名（如 'conversation.create'）。 */
  entry: string
}

/**
 * 按已解析平台规范化 cwd（纯词法，零磁盘访问）：
 * - 拒绝相对路径（POSIX 相对、Windows 盘符相对），保持既有绝对路径契约；
 * - platform undefined（目标平台无可信信息）：透传，不猜不改写；
 * - 平台已知：normalizeTargetPath；win32 目标上的不可映射 POSIX 根显式
 *   失败（unmappable_posix_root，绝不静默落库坏 POSIX cwd）。
 */
export function normalizeCwdForPlatform(cwd: string, platform: TargetPlatform | undefined, entry: string): string {
  if (!isAbsoluteTargetPath(cwd)) {
    throw new HelmError(
      'validation_error',
      `${entry}: cwd 需为绝对路径（POSIX / 开头、Windows 盘符 C:\\ 或 UNC \\\\server\\share；拒绝盘符相对与相对路径）：收到 '${cwd}'`,
      400,
      { cwd, entry },
    )
  }
  if (platform === undefined) return cwd
  const result = normalizeTargetPath(cwd, platform)
  if (!result.ok) {
    throw new HelmError(result.code, `${entry}: ${result.reason}`, 400, { cwd, entry })
  }
  return result.path
}

/**
 * cwd 收口（按目标节点平台）：绝对性校验 + resolveTargetPlatform +
 * normalizeCwdForPlatform 的组合（语义见上方各函数）。
 */
export function normalizeSessionCwd(cwd: string, options: NormalizeSessionCwdOptions): string {
  const platform = resolveTargetPlatform(options.nodeId, options.trustedPlatform)
  return normalizeCwdForPlatform(cwd, platform, options.entry)
}
