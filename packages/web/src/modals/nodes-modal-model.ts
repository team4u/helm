/**
 * Pure-function model for the compute node modal:
 * node ID validation, controlled-machine enrollment command generation,
 * usage and uptime formatting, SemVer comparison and node self-upgrade
 * gating. All side-effect free for easy unit testing and Fast Refresh
 * isolation.
 *
 * Display-copy functions take an optional `t` and default to the English
 * bridge translator: the owning UI (nodes partition) and other consumers
 * keep rendering English until they migrate and pass their own translator.
 */

import type { NodeInfo, NodeUpgradeCheckResult } from '@helmx/protocol/browser'
import { formatBytes } from '../lib/format.js'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'

export { formatBytes }

/** Node ID constraint (same source as the kernel issueNodeToken validation: starts alphanumeric, may contain . _ -, max 128). */
export const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export type NodeIdValidation = { ok: true; nodeId: string } | { ok: false; error: string }

/** Validate an enrollment node ID input: trim, reserved names and charset rules. */
export function validateNodeIdInput(raw: string, t?: WebMessageTranslator): NodeIdValidation {
  const tt = t ?? englishWebTranslator
  const nodeId = raw.trim()
  if (nodeId === '') return { ok: false, error: tt('modals.nodeId.empty') }
  if (nodeId === 'local') return { ok: false, error: tt('modals.nodeId.localReserved') }
  if (!NODE_ID_PATTERN.test(nodeId)) {
    return { ok: false, error: tt('modals.nodeId.invalidChars') }
  }
  return { ok: true, nodeId }
}

export interface NodeConnectGuide {
  /** Foreground connection (debug): binds the JOIN token and stays in the foreground; Ctrl+C exits; no daemon installed. */
  connectCommand: string
  /** Start the daemon in the background: reuses the identity already bound on disk, no token needed. */
  startDaemonCommand: string
  /** One-line enrollment: binds the node identity with --token and starts detached in the background (recommended). */
  oneLineCommand: string
  serviceInstallCommand: string
  doctorCommand: string
}

/** Build the controlled-machine enrollment command set (hubOrigin e.g. http://192.168.1.10:3202). */
export function buildNodeConnectGuide(
  hubOrigin: string,
  issued: { nodeId: string; token: string },
): NodeConnectGuide {
  // connect stays in the foreground (only Ctrl/Cmd+C exits), so chaining with
  // && would never run the rest; one-line enrollment uses start -d: its
  // detach path supports binding the identity with --token and then spawning
  // the background daemon, and the child argv carries no token (avoiding
  // token leaks from long-running process command lines).
  return {
    connectCommand: `helmx-node connect ${hubOrigin} --token ${issued.token}`,
    startDaemonCommand: 'helmx-node start -d',
    oneLineCommand: `helmx-node start -d --hub ${hubOrigin} --token ${issued.token}`,
    serviceInstallCommand: 'helmx-node service install',
    doctorCommand: 'helmx-node doctor',
  }
}

/** Uptime formatting (days/hours/minutes; compact locale-neutral units). */
export function formatUptime(uptimeSec: number | undefined): string {
  if (uptimeSec === undefined || !Number.isFinite(uptimeSec) || uptimeSec < 0) return '--'
  const totalMin = Math.floor(uptimeSec / 60)
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const minutes = totalMin % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (parts.length < 2) parts.push(`${minutes}m`)
  return parts.join(' ')
}

export interface NodeUsageInfo {
  usedBytes: number
  totalBytes: number
  percent: number
  label: string
}

/** Node option label for conversation/profile pickers: id + local/offline annotation. */
export function nodeOptionLabel(node: NodeInfo, t?: WebMessageTranslator): string {
  const tt = t ?? englishWebTranslator
  if (node.kind === 'local') return tt('modals.nodeOption.local', { id: node.id })
  return node.online ? node.id : tt('modals.nodeOption.offline', { id: node.id })
}

/** Node version display: ensure the v prefix ('0.1.0' -> 'v0.1.0'); blank returns null. */
export function formatNodeVersion(version?: string): string | null {
  const trimmed = (version ?? '').trim()
  if (trimmed === '') return null
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`
}

/** Parsed SemVer (build metadata ignored per the spec; not compared). */
export interface ParsedNodeSemver {
  major: number
  minor: number
  patch: number
  /** Pre-release identifier segments (e.g. ['beta', '1']); empty for stable releases. */
  prerelease: string[]
}

// Official semver.org grammar (numeric segments forbid leading zeros), v prefix tolerated.
const SEMVER_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** Parse SemVer; blank or invalid (e.g. 0.1, 01.2.3, garbage) returns null. */
export function parseNodeSemver(version: string): ParsedNodeSemver | null {
  const match = SEMVER_PATTERN.exec(version.trim())
  if (match === null) return null
  const major = match[1] ?? '0'
  const minor = match[2] ?? '0'
  const patch = match[3] ?? '0'
  const prerelease = match[4]
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease !== undefined ? prerelease.split('.') : [],
  }
}

/** Pre-release comparison: stable > pre-release; numeric segments compare numerically,
 * numeric < alphanumeric, more segments win. */
function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const da = a[i]
    const db = b[i]
    if (da === undefined) return -1
    if (db === undefined) return 1
    const na = /^\d+$/.test(da)
    const nb = /^\d+$/.test(db)
    if (na && nb) {
      if (Number(da) > Number(db)) return 1
      if (Number(da) < Number(db)) return -1
    } else if (na !== nb) {
      return na ? -1 : 1
    } else if (da > db) {
      return 1
    } else if (da < db) {
      return -1
    }
  }
  return 0
}

/** SemVer precedence: a > b returns 1, a < b returns -1, equal returns 0; an invalid side is incomparable and returns 0. */
export function compareNodeSemver(a: string, b: string): number {
  const pa = parseNodeSemver(a)
  const pb = parseNodeSemver(b)
  if (pa === null || pb === null) return 0
  const core: Array<[number, number]> = [
    [pa.major, pb.major],
    [pa.minor, pb.minor],
    [pa.patch, pb.patch],
  ]
  for (const [va, vb] of core) {
    if (va > vb) return 1
    if (va < vb) return -1
  }
  return comparePrerelease(pa.prerelease, pb.prerelease)
}

/** Whether the node (local node) version is behind the Hub: blank or invalid SemVer on either side counts as undecidable (false). */
export function isNodeBehindHub(nodeVersion?: string, hubVersion?: string): boolean {
  if (parseNodeSemver(nodeVersion ?? '') === null || parseNodeSemver(hubVersion ?? '') === null) return false
  return compareNodeSemver(hubVersion ?? '', nodeVersion ?? '') > 0
}

/** Upgrade confirm gating result: ok means clickable; hint is the disable reason (null when ok). */
export interface NodeUpgradeConfirmability {
  ok: boolean
  hint: string | null
}

/** Upgrade confirm gating: reject when offline, no check and no explicit valid
 * target, or already up to date without force/target. */
export function canConfirmNodeUpgrade(
  input: {
    online: boolean
    check: NodeUpgradeCheckResult | null
    targetVersion: string
    force: boolean
  },
  t?: WebMessageTranslator,
): NodeUpgradeConfirmability {
  const tt = t ?? englishWebTranslator
  if (!input.online) return { ok: false, hint: tt('modals.nodeUpgrade.offline') }
  const explicit = input.targetVersion.trim()
  if (explicit !== '' && parseNodeSemver(explicit) === null) {
    return { ok: false, hint: tt('modals.nodeUpgrade.invalidTarget') }
  }
  if (input.check === null) {
    return explicit === ''
      ? { ok: false, hint: tt('modals.nodeUpgrade.checkFirst') }
      : { ok: true, hint: null }
  }
  if (input.check.updateAvailable) return { ok: true, hint: null }
  if (explicit === '' && !input.force) {
    return { ok: false, hint: tt('modals.nodeUpgrade.upToDate') }
  }
  return { ok: true, hint: null }
}

/** Target the confirmed upgrade will install: explicit input wins; otherwise fixed to this check's latestVersion (null when no check and no input). */
export function resolveUpgradeTarget(
  check: NodeUpgradeCheckResult | null,
  targetVersion: string,
): string | null {
  const explicit = targetVersion.trim()
  if (explicit !== '') return explicit
  return check !== null && check.latestVersion.trim() !== '' ? check.latestVersion : null
}

/** Usage computation (free + total -> used / percent / label); missing data returns null. */
export function formatUsage(
  freeBytes: number | undefined,
  totalBytes: number | undefined,
  t?: WebMessageTranslator,
): NodeUsageInfo | null {
  if (
    freeBytes === undefined ||
    totalBytes === undefined ||
    !Number.isFinite(freeBytes) ||
    !Number.isFinite(totalBytes) ||
    totalBytes <= 0 ||
    freeBytes < 0 ||
    freeBytes > totalBytes
  ) {
    return null
  }
  const tt = t ?? englishWebTranslator
  const usedBytes = totalBytes - freeBytes
  const percent = Math.round((usedBytes / totalBytes) * 100)
  return {
    usedBytes,
    totalBytes,
    percent,
    label: tt('modals.nodeUsage.label', {
      used: formatBytes(usedBytes),
      total: formatBytes(totalBytes),
      percent,
    }),
  }
}
