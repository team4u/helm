/**
 * node upgrade version and result boundary validate (independent small module, zero SDK dependency).
 *
 * from runtime.ts split out: upgrade result validate only dependency @helm/protocol error type;
 * strictly SemVer parse/compare only this a (@helm/protocol/semver), this file keep
 * kernel side error message seal (HelmError) and for outside signature do not change, convenient at node-upgrade.test directly reference.
 */
import {
  HelmError,
  compareStrictSemver as compareStrictSemverShared,
  isStrictSemver as isStrictSemverShared,
  stripSemverVPrefix,
  type NodeUpgradeCheckResult,
  type NodeUpgradeResult,
} from '@helm/protocol'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** strictly SemVer decide (do not accept v prefix/loosely format). */
export function isStrictSemVer(text: string): boolean {
  return isStrictSemverShared(text)
}

/** specification explicit target version:trim after allows remove single v/V prefix (Web input fault tolerance), again strictly validate. */
export function normalizeExplicitVersion(raw: string): string {
  const bare = stripSemverVPrefix(raw)
  if (!isStrictSemverShared(bare)) {
    throw new HelmError(
      'validation_error',
      `targetVersion must be strictly SemVer(can carries single v prefix, such as 1.2.3 / v1.2.3), got "${raw}"`,
      400,
      { targetVersion: raw },
    )
  }
  return bare
}

/** compare two strictly SemVer:-1 / 0 / 1;prerelease sort by SemVer specification, invalid input is kernel internal error (500). */
export function compareStrictSemVer(a: string, b: string): number {
  // enter compare before already boundary validate, illegal belong internal error; one by one reference re-check keep errors can locate.
  for (const v of [a, b]) {
    if (!isStrictSemverShared(v)) {
      throw new HelmError('validation_error', `internal error: non- strictly SemVer enter compare:${v}`, 500)
    }
  }
  return compareStrictSemverShared(a, b)
}

/**
 * Hub(kernel package) itself version: read when before package package.json;HELM_VERSION_OVERRIDE takes precedence (test use).
 * honest discipline: read failed or version illegal explicit throw version_unavailable(500, attach original error diagnose),
 * never static default return 0.0.0 disguise into legal version reference and compare/automatically upgrade decide policy.
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
    // non-empty override value illegal when explicit errors, not silently ignore back package.json
    //(otherwise test inject piece together write error will by without sound swallow, mask real intent).
    throw new HelmError(
      'version_unavailable',
      `HELM_VERSION_OVERRIDE explicit settings but illegal (must strictly SemVer, got "${override}")`,
      500,
      { override },
    )
  }
  // dist/runtime/semver.ts → packages/kernel/<x>;src/runtime/semver.ts same construct.
  const kernelDir = dirname(fileURLToPath(import.meta.url))
  const pkgPath = join(dirname(dirname(kernelDir)), 'package.json')
  try {
    // sync read: version in after startup do not change; only first time invoke read once.
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
    if (typeof pkg.version !== 'string' || !isStrictSemVer(pkg.version)) {
      throw new HelmError(
        'version_unavailable',
        `kernel package.json version illegal (must strictly SemVer, got ${JSON.stringify(pkg.version)}):${pkgPath}`,
        500,
        { pkgPath, version: pkg.version },
      )
    }
    cachedHubVersion = pkg.version
  } catch (error) {
    if (error instanceof HelmError) throw error
    throw new HelmError(
      'version_unavailable',
      `read kernel package.json failed:${error instanceof Error ? error.message : String(error)}(${pkgPath})`,
      500,
      { pkgPath, cause: error instanceof Error ? error.message : String(error) },
    )
  }
  return cachedHubVersion
}

/** test inject point: reset hubVersion cache. */
export function resetHubVersionCacheForTest(): void {
  cachedHubVersion = undefined
}

/** diagnose use: subject to limit JSON serialization (loop/cannot serialization object retreat is String, never throw). */
export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** RpcResult boundary shape: must be object and ok is boolean;ok:false must carries error object. */
function isRpcResultShape(value: unknown): value is { ok: boolean; value?: unknown; error?: unknown } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (typeof v['ok'] !== 'boolean') return false
  if (v['ok'] === false && (v['error'] === null || typeof v['error'] !== 'object' || Array.isArray(v['error']))) return false
  return true
}

/**
 * node RpcResult structure failed → HelmError(honest discipline: illegal error shape by 502
 * node_upgrade_invalid_result explicit errors, never pass-through dirty data).'invalid' mapping 400,
 * 'not_supported' mapping 501, the rest 502.
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
      `node ${nodeId} ${action}return illegal error message seal:${safeJson(error)}`,
      502,
      { nodeId, nodeError: error },
    )
  }
  if (error.code === 'invalid') {
    return new HelmError('validation_error', `node ${nodeId} ${action}failed:${error.message}`, 400, {
      nodeId,
      nodeError: error,
    })
  }
  if (error.code === 'not_supported') {
    return new HelmError('node_upgrade_not_supported', `node ${nodeId} unsupported${action}(${error.message})`, 501, {
      nodeId,
      nodeError: error,
    })
  }
  return new HelmError('node_upgrade_failed', `node ${nodeId} ${action}failed (${error.code}):${error.message}`, 502, {
    nodeId,
    nodeError: error,
  })
}

/** upgrade check RPC result message seal validate (ok and value legal only then return value). */
export function unwrapUpgradeCheckRpc(nodeId: string, result: unknown): NodeUpgradeCheckResult {
  if (!isRpcResultShape(result)) {
    throw new HelmError(
      'node_upgrade_invalid_result',
      `node ${nodeId} upgrade check return illegal RpcResult(non- object or ok/error shape error):${safeJson(result)}`,
      502,
      { nodeId },
    )
  }
  if (!result.ok) {
    throw rpcFailureToHelmError(nodeId, 'check', (result as { error: { code: string; message: string } }).error)
  }
  return validateUpgradeCheckResult(nodeId, result.value as NodeUpgradeCheckResult)
}

/** boundary validate:nodeCheckUpgrade result field (honest discipline - - illegal result do not pass-through). */
export function validateUpgradeCheckResult(nodeId: string, value: NodeUpgradeCheckResult): NodeUpgradeCheckResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HelmError('node_upgrade_invalid_result', `node ${nodeId} upgrade check result illegal (non- object)`, 502, { nodeId })
  }
  const v = value as unknown as Record<string, unknown>
  if (typeof v['currentVersion'] !== 'string' || typeof v['latestVersion'] !== 'string' || typeof v['updateAvailable'] !== 'boolean') {
    throw new HelmError('node_upgrade_invalid_result', `node ${nodeId} upgrade check result field illegal`, 502, { nodeId })
  }
  // version field must be strictly SemVer(latestVersion will into is upgrade target, never let through dirty value).
  if (!isStrictSemVer(v['currentVersion']) || !isStrictSemVer(v['latestVersion'])) {
    throw new HelmError(
      'node_upgrade_invalid_result',
      `node ${nodeId} upgrade check result version non- strictly SemVer(currentVersion=${JSON.stringify(v['currentVersion'])},latestVersion=${JSON.stringify(v['latestVersion'])})`,
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
      throw new HelmError('node_upgrade_invalid_result', `node ${nodeId} upgrade check blocked field illegal`, 502, { nodeId })
    }
  }
  return value
}

/** upgrade RPC result message seal validate (ok and value legal only then return value). */
export function unwrapUpgradeRpc(nodeId: string, result: unknown): NodeUpgradeResult {
  if (!isRpcResultShape(result)) {
    throw new HelmError(
      'node_upgrade_invalid_result',
      `node ${nodeId} upgrade return illegal RpcResult(non- object or ok/error shape error):${safeJson(result)}`,
      502,
      { nodeId },
    )
  }
  if (!result.ok) {
    throw rpcFailureToHelmError(nodeId, 'upgrade', (result as { error: { code: string; message: string } }).error)
  }
  return validateUpgradeResult(nodeId, result.value as NodeUpgradeResult)
}

/** boundary validate:nodeUpgrade result field. */
export function validateUpgradeResult(nodeId: string, value: NodeUpgradeResult): NodeUpgradeResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HelmError('node_upgrade_invalid_result', `node ${nodeId} upgrade result illegal (non- object)`, 502, { nodeId })
  }
  const v = value as unknown as Record<string, unknown>
  if (
    typeof v['ok'] !== 'boolean' ||
    typeof v['previousVersion'] !== 'string' ||
    typeof v['targetVersion'] !== 'string' ||
    typeof v['upgraded'] !== 'boolean'
  ) {
    throw new HelmError('node_upgrade_invalid_result', `node ${nodeId} upgrade result field illegal`, 502, { nodeId })
  }
  if (v['pid'] !== undefined && (typeof v['pid'] !== 'number' || !Number.isInteger(v['pid']) || (v['pid'] as number) <= 0)) {
    throw new HelmError('node_upgrade_invalid_result', `node ${nodeId} upgrade result pid illegal`, 502, { nodeId })
  }
  if (!isStrictSemVer(v['previousVersion']) || !isStrictSemVer(v['targetVersion'])) {
    throw new HelmError(
      'node_upgrade_invalid_result',
      `node ${nodeId} upgrade result version non- strictly SemVer(previousVersion=${JSON.stringify(v['previousVersion'])},targetVersion=${JSON.stringify(v['targetVersion'])})`,
      502,
      { nodeId },
    )
  }
  return value
}
