/**
 * 目标节点平台感知的路径规范化（kernel 执行链唯一入口）。
 *
 * 平台来源纪律（诚实性红线）：
 * - local 恒 Hub 宿主 process.platform（同进程，无需查询）；
 * - 远端仅取 NodeRegistry 注册登记的平台（EnvFabric.nodePlatformOf 最小
 *   只读端口）；节点离线或守护进程未上报平台时平台未知——绝不猜测、
 *   绝不 fallback Hub 宿主平台、绝不 access 探测候选路径；
 * - 平台未知时路径保持原样（沿用既有的按形状词法解析语义），Linux/macOS
 *   与远端 POSIX 语义不变（远端 POSIX 节点绝不被误判成 Windows）。
 *
 * 本模块不复制路径正则：形状判定、词法规则与 win32 目标上的确定性视图
 * 转换（/mnt/<盘符>、/<盘符>、//server/share）全部复用 @helm/protocol 的
 * normalizeTargetPath / targetPlatformOf 原语；业务入口（runShell /
 * resolveExecTarget / read/write/edit）一律经由本模块，不得各自另写规则。
 */
import { normalizeTargetPath, targetPlatformOf, type TargetPlatform } from '@helm/protocol'

/** 平台读取最小端口（EnvFabric.nodePlatformOf 的形状；测试可注入替身）。 */
export interface NodePlatformSource {
  nodePlatformOf?(nodeId: string): string | undefined
}

/** 目标平台解析结果：known 携带平台语义与原始上报值；unknown 携带显式原因。 */
export type TargetPlatformInfo =
  | { known: true; platform: TargetPlatform; reported: string }
  | { known: false; reason: string }

/**
 * 解析目标节点平台：local 恒 process.platform；远端仅取注册登记值
 * （未上报 / 离线 / 端口缺位 → unknown，绝不猜测、绝不 fallback Hub 宿主）。
 */
export function targetPlatformForNode(
  source: NodePlatformSource | undefined,
  nodeId: string,
): TargetPlatformInfo {
  if (nodeId === 'local') {
    return { known: true, platform: targetPlatformOf(process.platform), reported: process.platform }
  }
  const reported = source?.nodePlatformOf?.(nodeId)
  if (reported === undefined || reported === '') {
    return {
      known: false,
      reason: `节点 ${nodeId} 平台信息未知（离线或守护进程未上报），不猜测平台、不回退 Hub 宿主平台`,
    }
  }
  return { known: true, platform: targetPlatformOf(reported), reported }
}

/** 平台感知路径规范化结果：成功携带规范路径；失败保留原始路径（original）。 */
export type TargetPathNormalization =
  | { ok: true; path: string; platform: TargetPlatform | undefined; view: string }
  | { ok: false; code: 'invalid_path'; original: string; reason: string }

/**
 * 按目标平台规范化路径（cwd / 绝对路径的统一入口）：
 * - 平台未知：路径原样返回（不猜平台，view 'unknown-platform'）；
 * - 平台已知：normalizeTargetPath 确定性规范化——win32 目标上把 WSL /
 *   Git Bash 的 POSIX 视图转换为规范 Windows 路径，无法映射的裸 POSIX
 *   根显式失败并保留原始路径；posix 目标仅词法归一（语义不变）。
 */
export function normalizePathForTarget(path: string, info: TargetPlatformInfo): TargetPathNormalization {
  if (!info.known) return { ok: true, path, platform: undefined, view: 'unknown-platform' }
  const result = normalizeTargetPath(path, info.platform)
  if (result.ok) return { ok: true, path: result.path, platform: info.platform, view: result.view }
  return { ok: false, code: 'invalid_path', original: path, reason: result.reason }
}

/** invalid_path 失败的统一可读信息（protocol reason 已含原始路径；各入口不得另拼）。 */
export function invalidPathText(failure: Extract<TargetPathNormalization, { ok: false }>): string {
  return `invalid_path: ${failure.reason}`
}
