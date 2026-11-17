/**
 * Spawn request and Profile boundary validation: agentType parsing (herdr:<kind>[@nodeId] and
 * Profile.runtime.kind=herdr dual entries), the nodeId priority chain, the cwd resolution chain, and strict
 * validation of env and startup parameters.
 * All invalid inputs throw HelmError explicitly here (validation_error / not_found / unsupported_runtime),
 * never silently ignoring fields or guessing private CLI flags.
 *
 * nodeId priority chain (high -> low; an explicit 'local' overrides with "local" semantics and folds into
 * an explicitLocal marker instead of collapsing to undefined -- child spawns of remote parent conversations do not silently inherit):
 * 1. explicit agentType prefix `herdr:<kind>@<node>` (incl. @local);
 * 2. Profile.runtime.nodeId (incl. 'local');
 * 3. Profile top-level nodeId (the Profile's regular node binding);
 * 4. the parent conversation's bound node (injected by the Executor as parentNodeId; defaults to local).
 */

import { HelmError, isAbsoluteTargetPath, normalizeTargetPath, type Profile, type TargetPlatform } from '@helm/protocol'
import { isValidNodeId } from './transport.js'
import { OUTPUT_FILE_PATTERN } from './transport-output.js'

/** Herdr CLI Agent kind identifier (e.g. agy/claude/codex/pi; no hardcoded enumeration -- validated by Herdr). */
const KIND_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/

export interface SpawnRouting {
  kind: string
  /**
   * Target compute node ID: undefined = fall back along the chain (runtime/Profile/parent node);
   * 'local' = explicitly local (overrides a remote parent node; never silently inherited).
   */
  nodeId?: string
  /** CLI private arguments: only from Profile.runtime.args (passed through as-is). */
  args: string[]
  /** Profile-configured working directory (absolute-path semantics, incl. runtime.workspace and Profile.cwd). */
  workspace?: string
  /** Profile-declared environment variable overrides (explicit non-secret configuration). */
  profileEnv: Record<string, string>
  /** The matched profileId (present for Profile entry; used for diagnostics). */
  profileId?: string
}

/** nodeId validation (uniform strict token; 'local' is legal). */
function assertNodeId(nodeId: string, source: { profileId?: string; agentType?: string }): string {
  if (!isValidNodeId(nodeId)) {
    const where = source.agentType !== undefined
      ? `the nodeId '${nodeId}' of agentType '${source.agentType}'`
      : `the nodeId '${nodeId}' of Profile '${source.profileId}'`
    throw new HelmError(
      'validation_error',
      `${where} is invalid (single safe token: starts alphanumeric, may contain . _ -, length 1..128; empty string rejected)`,
      400,
      { nodeId },
    )
  }
  return nodeId
}

/**
 * Resolve the agentType dual entries:
 * 1. explicit prefix 'herdr:<kind>' or 'herdr:<kind>@<nodeId>';
 * 2. agentType is an existing Profile ID with profile.runtime.kind === 'herdr'.
 * Neither of the above (a plain Profile / unknown prefix) returns undefined to hand back to the kernel's default execution line;
 * a Profile that exists but has an invalid runtime config throws explicitly (not swallowed).
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
    // Non-herdr runtime goes back to the kernel (room for other runtime plugins to take over in the future).
    return undefined
  }
  const kind = runtime.agent
  if (!KIND_PATTERN.test(kind)) {
    throw new HelmError(
      'validation_error',
      `Profile '${agentType}' runtime.agent '${kind}' is invalid (expected a lowercase alphanumeric-plus-hyphen CLI kind)`,
      400,
      { profileId: agentType, agent: kind },
    )
  }
  let nodeId: string | undefined
  if (runtime.nodeId !== undefined) {
    nodeId = assertNodeId(runtime.nodeId, { profileId: agentType })
  } else if (profile.nodeId !== undefined) {
    // Profile top-level node binding (shared by sessions and child executions; 'local' likewise explicitly means local).
    nodeId = assertNodeId(profile.nodeId, { profileId: agentType })
  }
  const args = runtime.args ?? []
  if (!args.every((a) => typeof a === 'string')) {
    throw new HelmError('validation_error', `Profile '${agentType}' runtime.args must all be strings`, 400, {
      profileId: agentType,
    })
  }
  // workspace resolution: runtime.workspace > Profile.cwd (the latter is also the session default cwd).
  const workspace = runtime.workspace ?? profile.cwd
  if (workspace !== undefined && !isAbsolutePath(workspace)) {
    throw new HelmError(
      'validation_error',
      `Profile '${agentType}' working directory must be absolute (runtime.workspace / cwd; got '${workspace}')`,
      400,
      { profileId: agentType, workspace },
    )
  }
  const profileEnv = runtime.env ?? {}
  for (const [key, value] of Object.entries(profileEnv)) {
    if (!isValidEnvName(key) || typeof value !== 'string') {
      throw new HelmError(
        'validation_error',
        `Profile '${agentType}' runtime.env has an invalid entry '${key}' (names must be legal env variable names and values strings)`,
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
      `agentType '${agentType}' has invalid kind '${kind}' (expected e.g. herdr:agy, herdr:claude@node-a)`,
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
 * Path absoluteness (pure rules, independent of the Hub platform's resolve): POSIX `/...`, Windows drive
 * `C:\...` / `C:/...` and UNC `\\server\\share\\...` are absolute; `C:relative`
 * (a drive-relative form without a separator) is rejected.
 */
function isAbsolutePath(p: string): boolean {
  if (p.startsWith('/')) return true
  if (p.startsWith('\\\\')) return p.length > 2
  return /^[A-Za-z]:[\\/]/.test(p)
}

/**
 * Converge by the target node's platform (a composition of protocol primitives, zero self-rolled regex):
 * an unknown platform (no trusted remote report) passes through unchanged; an unmappable POSIX root on a win32
 * target is rejected explicitly. Same semantics as the kernel's runtime/target-cwd.ts (@helm/plugins must not
 * import @helm/kernel's private dirs cross-boundary; the convergence primitives all come from @helm/protocol).
 */
function normalizeCwdForPlatform(cwd: string, platform: TargetPlatform | undefined, entry: string): string {
  if (!isAbsoluteTargetPath(cwd)) {
    throw new HelmError(
      'validation_error',
      `${entry}: cwd must be absolute (POSIX leading /, Windows drive C:\\ or UNC \\\\server\\share; drive-relative and relative paths rejected): got '${cwd}'`,
      400,
      { cwd },
    )
  }
  if (platform === undefined) return cwd
  const result = normalizeTargetPath(cwd, platform)
  if (!result.ok) {
    throw new HelmError(result.code, `${entry}: ${result.reason}`, 400, { cwd })
  }
  return result.path
}

export function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

/**
 * cwd resolution chain: request.cwd (must be absolute) > Profile.workspace (runtime.workspace
 * > Profile.cwd) > the parent conversation's cwd (fetched live via getConversation).
 * Returning '' (empty string) means the chain ended without a real cwd; the caller rejects explicitly (never guess the process cwd).
 *
 * The hit result is converged by the target node's platform before any pane-creation side effect (platform undefined means
 * no trusted info about the target node's platform: pass through, no guessing or rewriting; local is resolved by
 * the caller with process.platform). An unmappable POSIX cwd on a win32 target is rejected explicitly (no pane is created).
 */
export function resolveCwd(
  requestCwd: string | undefined,
  routing: SpawnRouting | undefined,
  parentCwd: string | undefined,
  platform?: TargetPlatform,
): string {
  let cwd: string
  if (requestCwd !== undefined) {
    if (!isAbsolutePath(requestCwd)) {
      throw new HelmError('validation_error', `spawn cwd must be an absolute path: '${requestCwd}'`, 400, { cwd: requestCwd })
    }
    cwd = requestCwd
  } else if (routing?.workspace !== undefined) {
    cwd = routing.workspace
  } else if (parentCwd !== undefined && isAbsolutePath(parentCwd)) {
    cwd = parentCwd
  } else {
    return ''
  }
  return normalizeCwdForPlatform(cwd, platform, 'herdr.spawn')
}

/**
 * Explicit model/effort on the request is rejected explicitly: neither kernel nor plugin does implicit
 * guessed mappings from model/effort to the 23 CLI's private flags (explicitly forbidden by the design doc);
 */
export function assertNoUnsupportedOverrides(model: string | undefined, effort: string | undefined): void {
  if (model !== undefined && model !== '') {
    throw new HelmError(
      'unsupported_runtime',
      `the herdr terminal execution line does not support an explicit model='${model}' (declare CLI private arguments via Profile runtime.args; no implicit mapping)`,
      400,
      { model },
    )
  }
  if (effort !== undefined) {
    throw new HelmError(
      'unsupported_runtime',
      `the herdr terminal execution line does not support an explicit effort='${effort}' (declare CLI private arguments via Profile runtime.args; no implicit mapping)`,
      400,
      { effort },
    )
  }
}

/** Agent name: helm-wf-<shorthash>; Herdr caps names at 32 chars. */
export function buildAgentName(unique: string): string {
  const hash = HashShort.of(unique)
  const name = `helm-wf-${hash}`
  if (name.length > 32) throw new HelmError('validation_error', `agent name too long: ${name}`, 400, { name })
  return name
}

/** Dependency-free short hash (FNV-1a 32bit -> base36); for naming dedup only, not for security. */
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

/** Handoff file name: wf-out-<safeId>.json|.md (aligned with transport's OUTPUT_FILE_PATTERN). */
export function buildOutputFileName(safeId: string, ext: 'json' | 'md'): string {
  const name = `wf-out-${safeId}.${ext}`
  if (!OUTPUT_FILE_PATTERN.test(name)) {
    throw new HelmError('validation_error', `invalid handoff file name: ${name}`, 400, { name })
  }
  return name
}

/** startupTimeoutMs strictly 3001..300000 (Herdr server constraint), default 30000. */
export function normalizeStartupTimeoutMs(value: unknown): number {
  const n = value === undefined ? 30_000 : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 3001 || n > 300_000) {
    throw new HelmError(
      'validation_error',
      `startupTimeoutMs must be an integer in 3001..300000 (got ${String(n)})`,
      400,
      { startupTimeoutMs: n },
    )
  }
  return n
}

/**
 * Task prompt redaction: redact the full text first, then apply any truncation (truncating first could split a
 * secret in half and leak the prefix into model context); handoff file names and path segments are non-secret and kept as-is.
 * The same applies to the JSON Schema text inside the handoff contract (the schema is caller-provided, but the
 * central tool's persistent redaction cannot substitute for redacting the external CLI prompt itself).
 */
export function redactPromptText(text: string, redact: (t: string) => string, maxChars = 20_000): string {
  const redacted = redact(text)
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}\n[task description too long, truncated]` : redacted
}

/** Redact the serialized JSON Schema (same semantics as redactPromptText, for the handoff contract). */
export function redactSchemaText(schema: Record<string, unknown>, redact: (t: string) => string): string {
  return redact(JSON.stringify(schema))
}

/**
 * Managed environment variables (HELM_*): authoritatively constructed by the kernel's managed/stash; a Profile
 * must not override them (the same kernel convention as buildToolEnv's "managed variables pin-override last").
 * HELM_HUB_URL's exceptional semantics live in buildSpawnPaneEnv: a remote pane only allows an explicitly
 * configured valid reachable address, or the node channel's reported genuinely reachable hubUrl for that node.
 * HELM_EXECUTION_SCOPE is the execution-context scope anchor (kernel executionScopeHash synthesis,
 */
export const MANAGED_ENV_KEYS = Object.freeze([
  'HELM_ENV',
  'HELM_CONVERSATION_ID',
  'HELM_CWD',
  'HELM_DATA_DIR',
  'HELM_EXECUTION_SCOPE',
  'HELM_TOKEN',
])

/**
 * Pane env construction (shared entry for local and remote):
 * - managed HELM_* pin-overrides Profile injections (preventing hijack of call-home/identity variables);
 * - managed/stash values override Profile last, keeping the task at the same priority as local tools;
 * - remote strips HELM_HUB_URL/HELM_TOKEN pointing at the local Hub, unless the Profile explicitly
 *   configures a valid reachable http(s) address, or the node channel provides the node's genuinely
 *   reachable hubUrl (priority: Profile explicit > channel hubUrl > strip).
 */
export function buildSpawnPaneEnv(
  managedEnv: Record<string, string>,
  profileEnv: Record<string, string>,
  options: { remote: boolean; nodeHubUrl?: string },
): { env: Record<string, string>; stripped: string[]; hubUrlOverridden: boolean } {
  const stripped: string[] = []
  const managed = { ...managedEnv }
  const env: Record<string, string> = {}

  // Explicit remotely reachable HELM_HUB_URL: the legal source of the remote call-home (Profile explicit first, then the node channel).
  const explicitUrl = profileEnv['HELM_HUB_URL']
  const channelUrl = options.nodeHubUrl
  const explicitReachable = explicitUrl !== undefined && isValidRemoteHubUrl(explicitUrl)
  // That address comes from the node's own connection config; local BYOM or tunnels may legally use loopback.
  // Do not mistake "the Hub's loopback address is not replicable" for "the node's own loopback address is unusable".
  const channelReachable = channelUrl !== undefined && isHttpUrl(channelUrl)
  if (options.remote) {
    if (explicitUrl !== undefined && !isHttpUrl(explicitUrl)) {
      throw new HelmError(
        'validation_error',
        `Profile runtime.env.HELM_HUB_URL must be an http(s) URL (got '${explicitUrl}'); refusing to inject an invalid call-home address into a remote pane`,
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

  // The remaining managed HELM_* pin-override last (kernel convention: managed/stash are authoritative); managed keys
  // (incl. HELM_HUB_URL) strip Profile injections matched case-insensitively -- Windows env names are
  // case-insensitive, aliases like helm_execution_scope / Helm_Cwd must not escape and hijack later.
  const managedUpper = new Set(
    [...MANAGED_ENV_KEYS, 'HELM_HUB_URL'].map((key) => key.toUpperCase()),
  )
  for (const [key, value] of Object.entries(profileEnv)) {
    if (managedUpper.has(key.toUpperCase())) continue
    env[key] = value
  }
  Object.assign(env, managed)
  const hubUrlOverridden = options.remote && (explicitReachable || channelReachable)
  return { env, stripped, hubUrlOverridden }
}

/** Only an http(s) URL can be a call-home address (file:/unix: etc. are invalid). */
function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** Remotely reachable: explicit http(s) with a non-loopback host. */
function isValidRemoteHubUrl(url: string): boolean {
  return isHttpUrl(url) && !isLoopbackUrl(url)
}

function isLoopbackUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return true
  }
  const host = parsed.hostname
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host)
}
