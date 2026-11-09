/**
 * 严格 SemVer 与节点升级结果边界校验（独立小模块，零 SDK 依赖）。
 *
 * 从 runtime.ts 拆出：版本比较是纯函数，升级结果校验只依赖 @helm/protocol
 * 的错误类型；独立成文件便于单测（node-upgrade.test 直接引用）。
 */
import { HelmError, type NodeUpgradeCheckResult, type NodeUpgradeResult } from '@helm/protocol'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/** 严格 SemVer 判定（不接受 v 前缀/宽松格式）。 */
export function isStrictSemVer(text: string): boolean {
  return STRICT_SEMVER.test(text)
}

/** 规范化显式目标版本：trim 后允许去掉单个 v 前缀（Web 输入容错），再严格校验。 */
export function normalizeExplicitVersion(raw: string): string {
  const trimmed = raw.trim()
  const bare = trimmed.startsWith('v') || trimmed.startsWith('V') ? trimmed.slice(1) : trimmed
  if (!isStrictSemVer(bare)) {
    throw new HelmError(
      'validation_error',
      `targetVersion 需为严格 SemVer（可带单个 v 前缀，如 1.2.3 / v1.2.3），实得 "${raw}"`,
      400,
      { targetVersion: raw },
    )
  }
  return bare
}

/** 比较两个严格 SemVer：-1 / 0 / 1；prerelease 排序按 SemVer 规范。 */
export function compareStrictSemVer(a: string, b: string): number {
  const pa = parseSemVer(a)
  const pb = parseSemVer(b)
  for (let i = 0; i < 3; i++) {
    if (pa.numeric[i] !== pb.numeric[i]) return pa.numeric[i]! < pb.numeric[i]! ? -1 : 1
  }
  const ap = pa.prerelease
  const bp = pb.prerelease
  if (ap === undefined && bp === undefined) return 0
  // 无预发布 > 有预发布。
  if (ap === undefined) return 1
  if (bp === undefined) return -1
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i]
    const y = bp[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff < 0 ? -1 : 1
    } else {
      if (x === y) continue
      // 数字标识 < 字母数字标识。
      if (xn) return -1
      if (yn) return 1
      return x < y ? -1 : 1
    }
  }
  return 0
}

function parseSemVer(v: string): { numeric: [number, number, number]; prerelease?: string[] } {
  const m = STRICT_SEMVER.exec(v)
  if (m === null) throw new HelmError('validation_error', `内部错误：非严格 SemVer 进入比较：${v}`, 500)
  return {
    numeric: [Number(m[1]), Number(m[2]), Number(m[3])],
    ...(m[4] !== undefined ? { prerelease: m[4].split('.') } : {}),
  }
}

/**
 * Hub（kernel 包）自身版本：读当前包 package.json；HELM_VERSION_OVERRIDE 优先（测试用）。
 * 诚实性纪律：读失败或版本非法显式抛 version_unavailable（500，附原错误诊断），
 * 绝不静默返回 0.0.0 伪装成合法版本参与比较/自动升级决策。
 */
let cachedHubVersion: string | undefined
export function hubVersion(): string {
  if (cachedHubVersion !== undefined) return cachedHubVersion
  const override = process.env['HELM_VERSION_OVERRIDE']
  if (override !== undefined && override.trim() !== '') {
    const trimmed = override.trim()
    if (isStrictSemVer(trimmed)) {
      cachedHubVersion = trimmed
      return cachedHubVersion
    }
    // 非空覆盖值非法时显式报错，不静默忽略回落 package.json
    //（否则测试注入拼写错误会被无声吞掉，掩盖真实意图）。
    throw new HelmError(
      'version_unavailable',
      `HELM_VERSION_OVERRIDE 显式设置但非法（需严格 SemVer，实得 "${override}"）`,
      500,
      { override },
    )
  }
  // dist/runtime/semver.ts → packages/kernel/<x>；src/runtime/semver.ts 同构。
  const kernelDir = dirname(fileURLToPath(import.meta.url))
  const pkgPath = join(dirname(dirname(kernelDir)), 'package.json')
  try {
    // 同步读：版本在启动后不变；仅首次调用读盘一次。
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
    if (typeof pkg.version !== 'string' || !isStrictSemVer(pkg.version)) {
      throw new HelmError(
        'version_unavailable',
        `kernel package.json version 非法（需严格 SemVer，实得 ${JSON.stringify(pkg.version)}）：${pkgPath}`,
        500,
        { pkgPath, version: pkg.version },
      )
    }
    cachedHubVersion = pkg.version
  } catch (error) {
    if (error instanceof HelmError) throw error
    throw new HelmError(
      'version_unavailable',
      `读取 kernel package.json 失败：${error instanceof Error ? error.message : String(error)}（${pkgPath}）`,
      500,
      { pkgPath, cause: error instanceof Error ? error.message : String(error) },
    )
  }
  return cachedHubVersion
}

/** 测试注入点：重置 hubVersion 缓存。 */
export function resetHubVersionCacheForTest(): void {
  cachedHubVersion = undefined
}

/** 诊断用：受限 JSON 序列化（循环/不可序列化对象退化为 String，绝不抛）。 */
export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** RpcResult 边界形状：必须是对象且 ok 为 boolean；ok:false 需带 error 对象。 */
function isRpcResultShape(value: unknown): value is { ok: boolean; value?: unknown; error?: unknown } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (typeof v['ok'] !== 'boolean') return false
  if (v['ok'] === false && (v['error'] === null || typeof v['error'] !== 'object' || Array.isArray(v['error']))) return false
  return true
}

/**
 * 节点 RpcResult 结构化失败 → HelmError（诚实性纪律：非法 error 形状按 502
 * node_upgrade_invalid_result 显式报错，绝不透传脏数据）。'invalid' 映射 400，
 * 'not_supported' 映射 501，其余 502。
 */
export function rpcFailureToHelmError(
  nodeId: string,
  action: string,
  error: { code: string; message: string },
): HelmError {
  if (
    error === null || typeof error !== 'object' || Array.isArray(error) ||
    typeof error.code !== 'string' || error.code === '' ||
    typeof error.message !== 'string'
  ) {
    return new HelmError(
      'node_upgrade_invalid_result',
      `节点 ${nodeId} ${action}返回非法错误信封：${safeJson(error)}`,
      502,
      { nodeId, nodeError: error },
    )
  }
  if (error.code === 'invalid') {
    return new HelmError('validation_error', `节点 ${nodeId} ${action}失败：${error.message}`, 400, {
      nodeId,
      nodeError: error,
    })
  }
  if (error.code === 'not_supported') {
    return new HelmError('node_upgrade_not_supported', `节点 ${nodeId} 不支持${action}（${error.message}）`, 501, {
      nodeId,
      nodeError: error,
    })
  }
  return new HelmError('node_upgrade_failed', `节点 ${nodeId} ${action}失败（${error.code}）：${error.message}`, 502, {
    nodeId,
    nodeError: error,
  })
}

/** 升级检查 RPC 结果信封校验（ok 且 value 合法才返回 value）。 */
export function unwrapUpgradeCheckRpc(nodeId: string, result: unknown): NodeUpgradeCheckResult {
  if (!isRpcResultShape(result)) {
    throw new HelmError(
      'node_upgrade_invalid_result',
      `节点 ${nodeId} 升级检查返回非法 RpcResult（非对象或 ok/error 形状错误）：${safeJson(result)}`,
      502,
      { nodeId },
    )
  }
  if (!result.ok) {
    throw rpcFailureToHelmError(nodeId, '检查', (result as { error: { code: string; message: string } }).error)
  }
  return validateUpgradeCheckResult(nodeId, result.value as NodeUpgradeCheckResult)
}

/** 边界校验：nodeCheckUpgrade 结果字段（诚实性纪律——非法结果不透传）。 */
export function validateUpgradeCheckResult(nodeId: string, value: NodeUpgradeCheckResult): NodeUpgradeCheckResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HelmError('node_upgrade_invalid_result', `节点 ${nodeId} 升级检查结果非法（非对象）`, 502, { nodeId })
  }
  const v = value as unknown as Record<string, unknown>
  if (typeof v['currentVersion'] !== 'string' || typeof v['latestVersion'] !== 'string' || typeof v['updateAvailable'] !== 'boolean') {
    throw new HelmError('node_upgrade_invalid_result', `节点 ${nodeId} 升级检查结果字段非法`, 502, { nodeId })
  }
  // 版本字段必须是严格 SemVer（latestVersion 会成为升级目标，绝不放行脏值）。
  if (!isStrictSemVer(v['currentVersion']) || !isStrictSemVer(v['latestVersion'])) {
    throw new HelmError(
      'node_upgrade_invalid_result',
      `节点 ${nodeId} 升级检查结果版本非严格 SemVer（currentVersion=${JSON.stringify(v['currentVersion'])}，latestVersion=${JSON.stringify(v['latestVersion'])}）`,
      502,
      { nodeId },
    )
  }
  const blocked = v['blocked']
  if (blocked !== undefined) {
    if (
      blocked === null || typeof blocked !== 'object' || Array.isArray(blocked) ||
      typeof (blocked as Record<string, unknown>)['version'] !== 'string' ||
      typeof (blocked as Record<string, unknown>)['reason'] !== 'string' ||
      typeof (blocked as Record<string, unknown>)['at'] !== 'string'
    ) {
      throw new HelmError('node_upgrade_invalid_result', `节点 ${nodeId} 升级检查 blocked 字段非法`, 502, { nodeId })
    }
  }
  return value
}

/** 升级 RPC 结果信封校验（ok 且 value 合法才返回 value）。 */
export function unwrapUpgradeRpc(nodeId: string, result: unknown): NodeUpgradeResult {
  if (!isRpcResultShape(result)) {
    throw new HelmError(
      'node_upgrade_invalid_result',
      `节点 ${nodeId} 升级返回非法 RpcResult（非对象或 ok/error 形状错误）：${safeJson(result)}`,
      502,
      { nodeId },
    )
  }
  if (!result.ok) {
    throw rpcFailureToHelmError(nodeId, '升级', (result as { error: { code: string; message: string } }).error)
  }
  return validateUpgradeResult(nodeId, result.value as NodeUpgradeResult)
}

/** 边界校验：nodeUpgrade 结果字段。 */
export function validateUpgradeResult(nodeId: string, value: NodeUpgradeResult): NodeUpgradeResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HelmError('node_upgrade_invalid_result', `节点 ${nodeId} 升级结果非法（非对象）`, 502, { nodeId })
  }
  const v = value as unknown as Record<string, unknown>
  if (
    typeof v['ok'] !== 'boolean' ||
    typeof v['previousVersion'] !== 'string' ||
    typeof v['targetVersion'] !== 'string' ||
    typeof v['upgraded'] !== 'boolean'
  ) {
    throw new HelmError('node_upgrade_invalid_result', `节点 ${nodeId} 升级结果字段非法`, 502, { nodeId })
  }
  if (v['pid'] !== undefined && (typeof v['pid'] !== 'number' || !Number.isInteger(v['pid']) || (v['pid'] as number) <= 0)) {
    throw new HelmError('node_upgrade_invalid_result', `节点 ${nodeId} 升级结果 pid 非法`, 502, { nodeId })
  }
  if (!isStrictSemVer(v['previousVersion']) || !isStrictSemVer(v['targetVersion'])) {
    throw new HelmError(
      'node_upgrade_invalid_result',
      `节点 ${nodeId} 升级结果版本非严格 SemVer（previousVersion=${JSON.stringify(v['previousVersion'])}，targetVersion=${JSON.stringify(v['targetVersion'])}）`,
      502,
      { nodeId },
    )
  }
  return value
}
