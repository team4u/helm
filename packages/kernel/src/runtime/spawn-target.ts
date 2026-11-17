/**
 * Single authoritative resolution chain for spawn targets (pure internal kernel helper; shared by native
 * execution and `ctx.host.resolveSpawnTarget` so plugins never duplicate resolution rules).
 *
 * Must be resolved lazily at actual invocation time rather than pre-normalized up front: `agent_spawn`
 * around hooks can rewrite the request via `next(finalRequest)`, invalidating any pre-input snapshot;
 * resume semantics also rely on `request.cwd === undefined` (explicit inheritance fallback) which pre-filling
 * would break (see `resolveSpawnTarget` docstring in `protocol/plugin.ts` for full contract).
 *
 * Semantics:
 * - Normal or cross-profile fork:
 *   - node chain: explicit `profile.nodeId` > parent conversation bound node > `'local'`;
 *   - cwd chain: `request.cwd` > `profile.cwd` > parent conversation `cwd` > host default directory;
 * - Same-profile fork (`forkSameProfile=true`):
 *   - node chain: parent conversation bound node > `profile.nodeId` > `'local'`;
 *   - cwd chain: `request.cwd` > parent conversation `cwd` > `profile.cwd` > host default directory;
 * - `cwd` is normalized consistently per target node platform (`normalizeSessionCwd`: unmappable POSIX
 *   `cwd` on win32 targets is explicitly rejected; passed through when remote platform is unknown), via a
 *   caller-supplied `normalize` closure (carrying its `trustedPlatform` fact source).
 */

export interface SpawnTargetChainInput {
  /** Target node explicitly declared by Profile (defaults to inheriting parent conversation). */
  profileNodeId?: string
  /** Parent conversation's bound node snapshot. */
  parentNodeId?: string
  /** Explicit cwd from request (takes precedence over Profile/parent conversation cwd). */
  requestCwd?: string
  /** Explicit cwd from Profile. */
  profileCwd?: string
  /** Parent conversation's cwd snapshot. */
  parentCwd?: string
  /** Host default cwd (tail of the cwd fallback chain). */
  defaultCwd: string
  /** Whether this is a same-Profile fork (if true, parent conversation nodeId/cwd take precedence over Profile defaults). */
  forkSameProfile?: boolean
  /** Platform normalization closure: `normalize(rawCwd, nodeId) -> normalizedCwd` (throws if invalid). */
  normalize: (cwd: string, nodeId: string) => string
}

export interface SpawnTargetChain {
  nodeId: string
  sourceCwd: string
}

/** Pure node-chain resolution (shared by external runtimes such as Herdr and kernel for identical fallback semantics). */
export function resolveSpawnTargetNodeId(
  profileNodeId: string | undefined,
  parentNodeId: string | undefined,
  forkSameProfile?: boolean,
): string {
  return forkSameProfile === true
    ? (parentNodeId ?? profileNodeId ?? 'local')
    : (profileNodeId ?? parentNodeId ?? 'local')
}

/** Full chain resolution: node + platform-normalized source cwd. */
export function resolveSpawnTargetChain(input: SpawnTargetChainInput): SpawnTargetChain {
  const nodeId = resolveSpawnTargetNodeId(input.profileNodeId, input.parentNodeId, input.forkSameProfile)
  const rawCwd =
    input.forkSameProfile === true
      ? (input.requestCwd ?? input.parentCwd ?? input.profileCwd ?? input.defaultCwd)
      : (input.requestCwd ?? input.profileCwd ?? input.parentCwd ?? input.defaultCwd)
  return { nodeId, sourceCwd: input.normalize(rawCwd, nodeId) }
}
