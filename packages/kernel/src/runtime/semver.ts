/**
 * Node upgrade version and result boundary validation (standalone small module, zero SDK dependencies).
 *
 * Extracted from `runtime.ts`: upgrade result validation depends only on `@helm/protocol` error types;
 * strict SemVer parsing/comparison lives in one place (`@helm/protocol/semver`), while this file preserves
 * kernel-side error wrappers (`HelmError`) and external signatures for direct consumption by `node-upgrade.test`.
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

/** Strict SemVer predicate (rejects `v` prefix and loose formats). */
export function isStrictSemVer(text: string): boolean {
  return isStrictSemverShared(text)
}

/** Normalize explicit target version: trims and optionally strips a single leading `v`/`V` (Web input tolerance), then strictly validates. */
export function normalizeExplicitVersion(raw: string): string {
  const bare = stripSemverVPrefix(raw)
  if (!isStrictSemverShared(bare)) {
    throw new HelmError(
      'validation_error',
      `targetVersion must be strict SemVer (optional single 'v' prefix allowed, e.g. 1.2.3 or v1.2.3), got "${raw}"`,
      400,
      { targetVersion: raw },
    )
  }
  return bare
}

/** Compare two strict SemVers: `-1` / `0` / `1`; prerelease ordering follows the SemVer spec; invalid input is a kernel internal error (`500`). */
export function compareStrictSemVer(a: string, b: string): number {
  // Inputs should already be validated at boundaries; invalid values here are internal errors, checked per-arg for diagnostics.
  for (const v of [a, b]) {
    if (!isStrictSemverShared(v)) {
      throw new HelmError('validation_error', `Internal error: non-strict SemVer passed to compare: ${v}`, 500)
    }
  }
  return compareStrictSemverShared(a, b)
}

/**
 * Hub (kernel package) version: reads current package's `package.json`; `HELM_VERSION_OVERRIDE` takes precedence (for tests).
 * Honesty discipline: read failures or invalid versions throw `version_unavailable` (`500` with diagnostic cause);
 * never silently falls back to `0.0.0` as a valid version baseline for comparisons or auto-upgrade decisions.
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
    // Non-empty invalid override must fail explicitly rather than falling back to package.json
    // (otherwise typos in tests would be silently swallowed and mask real intent).
    throw new HelmError(
      'version_unavailable',
      `HELM_VERSION_OVERRIDE is set but invalid (must be strict SemVer, got "${override}")`,
      500,
      { override },
    )
  }
  // dist/runtime/semver.ts -> packages/kernel/<x>; same layout for src/runtime/semver.ts.
  const kernelDir = dirname(fileURLToPath(import.meta.url))
  const pkgPath = join(dirname(dirname(kernelDir)), 'package.json')
  try {
    // Sync read: version never changes after startup; read once on first invocation.
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
    if (typeof pkg.version !== 'string' || !isStrictSemVer(pkg.version)) {
      throw new HelmError(
        'version_unavailable',
        `Kernel package.json version is invalid (must be strict SemVer, got ${JSON.stringify(pkg.version)}): ${pkgPath}`,
        500,
        { pkgPath, version: pkg.version },
      )
    }
    cachedHubVersion = pkg.version
  } catch (error) {
    if (error instanceof HelmError) throw error
    throw new HelmError(
      'version_unavailable',
      `Failed to read kernel package.json: ${error instanceof Error ? error.message : String(error)} (${pkgPath})`,
      500,
      { pkgPath, cause: error instanceof Error ? error.message : String(error) },
    )
  }
  return cachedHubVersion
}

/** Diagnostic helper: safe JSON serialization (falls back to `String()` for circular or unserializable objects, never throws). */
export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** `RpcResult` boundary shape: must be an object with boolean `ok`; `ok: false` must include an `error` object. */
function isRpcResultShape(value: unknown): value is { ok: boolean; value?: unknown; error?: unknown } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (typeof v['ok'] !== 'boolean') return false
  if (v['ok'] === false && (v['error'] === null || typeof v['error'] !== 'object' || Array.isArray(v['error']))) return false
  return true
}

/**
 * Map a node `RpcResult` failure to `HelmError` (honesty discipline: invalid error shapes fail explicitly
 * with `502 node_upgrade_invalid_result`, never passing through dirty data). Maps `'invalid'` to `400`,
 * `'not_supported'` to `501`, and everything else to `502`.
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
      `Node ${nodeId} ${action} returned an invalid error envelope: ${safeJson(error)}`,
      502,
      { nodeId, nodeError: error },
    )
  }
  if (error.code === 'invalid') {
    return new HelmError('validation_error', `Node ${nodeId} ${action} failed: ${error.message}`, 400, {
      nodeId,
      nodeError: error,
    })
  }
  if (error.code === 'not_supported') {
    return new HelmError('node_upgrade_not_supported', `Node ${nodeId} does not support ${action} (${error.message})`, 501, {
      nodeId,
      nodeError: error,
    })
  }
  return new HelmError('node_upgrade_failed', `Node ${nodeId} ${action} failed (${error.code}): ${error.message}`, 502, {
    nodeId,
    nodeError: error,
  })
}

/** Validate upgrade-check RPC response envelope (returns `value` only if `ok` and `value` are valid). */
export function unwrapUpgradeCheckRpc(nodeId: string, result: unknown): NodeUpgradeCheckResult {
  if (!isRpcResultShape(result)) {
    throw new HelmError(
      'node_upgrade_invalid_result',
      `Node ${nodeId} upgrade check returned invalid RpcResult (non-object or malformed ok/error): ${safeJson(result)}`,
      502,
      { nodeId },
    )
  }
  if (!result.ok) {
    throw rpcFailureToHelmError(nodeId, 'check', (result as { error: { code: string; message: string } }).error)
  }
  return validateUpgradeCheckResult(nodeId, result.value as NodeUpgradeCheckResult)
}

/** Boundary validation for `nodeCheckUpgrade` result fields (honesty discipline — never pass through malformed results). */
export function validateUpgradeCheckResult(nodeId: string, value: NodeUpgradeCheckResult): NodeUpgradeCheckResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HelmError('node_upgrade_invalid_result', `Node ${nodeId} upgrade check result is invalid (non-object)`, 502, { nodeId })
  }
  const v = value as unknown as Record<string, unknown>
  if (typeof v['currentVersion'] !== 'string' || typeof v['latestVersion'] !== 'string' || typeof v['updateAvailable'] !== 'boolean') {
    throw new HelmError('node_upgrade_invalid_result', `Node ${nodeId} upgrade check result fields are invalid`, 502, { nodeId })
  }
  // Version fields must be strict SemVer (`latestVersion` feeds into upgrade target selection — never let dirty values through).
  if (!isStrictSemVer(v['currentVersion']) || !isStrictSemVer(v['latestVersion'])) {
    throw new HelmError(
      'node_upgrade_invalid_result',
      `Node ${nodeId} upgrade check result versions are not strict SemVer (currentVersion=${JSON.stringify(v['currentVersion'])}, latestVersion=${JSON.stringify(v['latestVersion'])})`,
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
      throw new HelmError('node_upgrade_invalid_result', `Node ${nodeId} upgrade check 'blocked' field is invalid`, 502, { nodeId })
    }
  }
  return value
}

/** Validate upgrade RPC response envelope (returns `value` only if `ok` and `value` are valid). */
export function unwrapUpgradeRpc(nodeId: string, result: unknown): NodeUpgradeResult {
  if (!isRpcResultShape(result)) {
    throw new HelmError(
      'node_upgrade_invalid_result',
      `Node ${nodeId} upgrade returned invalid RpcResult (non-object or malformed ok/error): ${safeJson(result)}`,
      502,
      { nodeId },
    )
  }
  if (!result.ok) {
    throw rpcFailureToHelmError(nodeId, 'upgrade', (result as { error: { code: string; message: string } }).error)
  }
  return validateUpgradeResult(nodeId, result.value as NodeUpgradeResult)
}

/** Boundary validation for `nodeUpgrade` result fields. */
export function validateUpgradeResult(nodeId: string, value: NodeUpgradeResult): NodeUpgradeResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HelmError('node_upgrade_invalid_result', `Node ${nodeId} upgrade result is invalid (non-object)`, 502, { nodeId })
  }
  const v = value as unknown as Record<string, unknown>
  if (
    typeof v['ok'] !== 'boolean' ||
    typeof v['previousVersion'] !== 'string' ||
    typeof v['targetVersion'] !== 'string' ||
    typeof v['upgraded'] !== 'boolean'
  ) {
    throw new HelmError('node_upgrade_invalid_result', `Node ${nodeId} upgrade result fields are invalid`, 502, { nodeId })
  }
  if (v['pid'] !== undefined && (typeof v['pid'] !== 'number' || !Number.isInteger(v['pid']) || (v['pid'] as number) <= 0)) {
    throw new HelmError('node_upgrade_invalid_result', `Node ${nodeId} upgrade result pid is invalid`, 502, { nodeId })
  }
  if (!isStrictSemVer(v['previousVersion']) || !isStrictSemVer(v['targetVersion'])) {
    throw new HelmError(
      'node_upgrade_invalid_result',
      `Node ${nodeId} upgrade result versions are not strict SemVer (previousVersion=${JSON.stringify(v['previousVersion'])}, targetVersion=${JSON.stringify(v['targetVersion'])})`,
      502,
      { nodeId },
    )
  }
  return value
}
