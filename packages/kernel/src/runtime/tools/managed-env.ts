/**
 * Managed environment assembly (outer tool assembly layer atop the sole source of truth `ScopedExecutionEnv` in
 * `env/scoped-env.ts`): local inherits `process.env` (real PATH/HOME) while stripping all managed `HELMX_*`
 * variables (case-insensitively), applies pinned overrides via `buildManagedEnv` (`HELMX_ENV` / `HELMX_HUB_URL` /
 * `HELMX_CONVERSATION_ID` / `HELMX_CWD` / `HELMX_DATA_DIR` / `HELMX_NODE_ID` / `HELMX_EXECUTION_SCOPE` / managed
 * `HELMX_TOKEN`), and prepends `deps.cliBinDir` to `PATH`. Remote nodes never inherit Hub host env or default PATH
 * (node daemons merge node PATH/HOME themselves and strip node host `HELMX_TOKEN`); remote `HELMX_HUB_URL` uses only
 * the real `hubUrl` reported at node registration (omitted if unreported; never falls back to Hub's local address).
 * Never introduce a second env assembly path here.
 */
import { createHash } from 'node:crypto'
import { composeExecutionEnv, MANAGED_EXEC_ENV_VARS } from '../../env/scoped-env.js'
import type { HelmxToolDeps } from '../tool-deps.js'

/** Assemble tool env: `process.env < options.env < managed vars` (pinned overrides; see `buildManagedEnv`). */
export function buildToolEnv(
  deps: HelmxToolDeps,
  cwd: string,
  conversationId?: number,
  extraEnv?: Record<string, string>,
  nodeId: string = 'local',
): Record<string, string> {
  return composeExecutionEnv(nodeId, buildManagedEnv(deps, cwd, conversationId, nodeId), extraEnv, {
    cliBinDir: deps.cliBinDir,
  })
}

/**
 * Execution scope anchor: `HELMX_EXECUTION_SCOPE = helmx-<first 24 hex chars of sha256>`.
 * Inputs contain only non-secret execution coordinates (Helmx instance `dataDir`, conversation ID, node ID,
 * actual `cwd`; JSON-serialized array avoids delimiter ambiguity). Identical across commands within the same
 * conversation and target, distinct across conversations/nodes/worktrees/Helmx instances. Intended as a stable
 * naming hint for tools adopting lock files, temp dirs, or cache prefixes — not an OS sandbox or automatic
 * isolation mechanism for third-party daemons; never contains any secret.
 */
export function executionScopeHash(
  dataDir: string,
  conversationId: number | undefined,
  nodeId: string,
  cwd: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([dataDir, conversationId ?? 0, nodeId, cwd]))
    .digest('hex')
  return `helmx-${digest.slice(0, 24)}`
}

/** Uppercase set of managed identity var names: neither stash nor profile may supply them in any casing
 * (Windows env names are case-insensitive, so lowercase aliases could hijack canonical reads in children). */
const MANAGED_ENV_UPPER = new Set<string>(MANAGED_EXEC_ENV_VARS.map((name) => name.toUpperCase()))

/**
 * Host-managed env vars (excluding `process.env`): conversation `SecretStash` injections + pinned overrides
 * for `HELMX_ENV` / `HELMX_HUB_URL` / `HELMX_CONVERSATION_ID` / `HELMX_CWD` / `HELMX_EXECUTION_SCOPE` /
 * `HELMX_DATA_DIR` (local only) / managed `HELMX_TOKEN` (omitted when no managed token exists).
 * Any stash keys matching managed identity vars (case-insensitively) are stripped; managed values are injected
 * solely under canonical uppercase names. Shared by local and remote assembly.
 * `options.stashEnv` can override default conversation secrets (used by external spawns for least privilege:
 * passing `{}` omits all conversation secrets while keeping `HELMX_*`).
 * Remote-specific semantics:
 * - `HELMX_HUB_URL` uses only the node's reported callback URL (omits key when unreported rather than falling
 *   back to `deps.hubUrl`, which may be local 127.0.0.1 and unreachable remotely);
 * - `HELMX_DATA_DIR` is Hub's local path and is omitted on remote nodes;
 * - `HELMX_TOKEN` is Hub's process-managed token so remote children can authenticate HTTP callbacks to Hub
 *   (honesty boundary: tokens exist in remote child memory/env just like local children — zero-leakage is not promised).
 */
export function buildManagedEnv(
  deps: HelmxToolDeps,
  cwd: string,
  conversationId?: number,
  nodeId: string = 'local',
  options: { stashEnv?: Record<string, string> } = {},
): Record<string, string> {
  const stashEnv =
    options.stashEnv !== undefined
      ? options.stashEnv
      : conversationId === undefined
        ? {}
        : deps.stashEnvFor(conversationId)
  // Stash must never carry managed identity variables in any casing; strip aliases like `helmx_execution_scope`
  // or `Helmx_Cwd` before injecting canonical overrides. Uses object spread (`DefineOwnProperty`) + `delete`
  // to avoid prototype pollution on `__proto__`.
  const safeStashEnv: Record<string, string> = { ...stashEnv }
  for (const key of Object.keys(stashEnv)) {
    if (MANAGED_ENV_UPPER.has(key.toUpperCase())) delete safeStashEnv[key]
  }
  const managedToken = deps.processToken?.()
  // Guard remote callback URL: use only registered node's reported hubUrl, else omit (never fall back to local Hub URL).
  const nodeHubUrl = nodeId !== 'local' ? deps.envFabric?.getNodeHubUrl(nodeId) : undefined
  const hubUrl = nodeId === 'local' ? deps.hubUrl : nodeHubUrl
  const env: Record<string, string> = {
    ...safeStashEnv,
    HELMX_ENV: '1',
    ...(hubUrl !== undefined ? { HELMX_HUB_URL: hubUrl } : {}),
    HELMX_CONVERSATION_ID: String(conversationId ?? 0),
    HELMX_CWD: cwd,
    ...(nodeId === 'local' ? { HELMX_DATA_DIR: deps.dataDir } : {}),
    HELMX_NODE_ID: nodeId,
    HELMX_EXECUTION_SCOPE: executionScopeHash(deps.dataDir, conversationId, nodeId, cwd),
  }
  if (managedToken === undefined) delete env['HELMX_TOKEN']
  else env['HELMX_TOKEN'] = managedToken
  return env
}
