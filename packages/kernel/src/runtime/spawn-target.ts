/**
 * spawn target parse unique right threat chain (kernel inside pure function; original generate execute row and
 * ctx.host.resolveSpawnTarget shared use, plugin must not self row duplicate rule).
 *
 * on demand seek value is moment intent form while non- entry pre- archive one:agent_spawn around chain can via
 * next(finalRequest) change write request, entry snapshot will expired;resume semantics dependency
 * request.cwd === undefined(explicit inherit chain fall back), pre- fill i.e. break
 * (complete argument verify see protocol/plugin.ts  resolveSpawnTarget port note release).
 *
 * semantics:
 * - ordinary or across role fork:
 *   - node chain: explicit profile.nodeId > parent conversation bind set node > 'local';
 *   - cwd chain:request.cwd > profile.cwd > parent conversation cwd > host default directory;
 * - same role fork(forkSameProfile=true):
 *   - node chain: parent conversation bind set node > profile.nodeId > 'local';
 *   - cwd chain:request.cwd > parent conversation cwd > profile.cwd > host default directory;
 * - cwd by target node platform unify consolidate (normalizeSessionCwd:win32 target on cannot mapping
 *    POSIX cwd explicit reject; remote platform without can message information when pass-through), by caller inject
 *   normalize closed package (carry its trustedPlatform fact source).
 */

export interface SpawnTargetChainInput {
  /** Profile explicit declaration target node (default inherit parent conversation). */
  profileNodeId?: string
  /** parent conversation bind set node mirror. */
  parentNodeId?: string
  /** request explicit cwd(takes precedence at Profile/parent conversation cwd). */
  requestCwd?: string
  /** Profile explicit cwd. */
  profileCwd?: string
  /** parent conversation cwd mirror. */
  parentCwd?: string
  /** host default cwd(cwd chain tail). */
  defaultCwd: string
  /** is otherwise is same Profile fork (true when parent conversation nodeId/cwd takes precedence at Profile default). */
  forkSameProfile?: boolean
  /** platform consolidate closed package:normalize(rawCwd, nodeId) -> specification cwd(illegal i.e. throw). */
  normalize: (cwd: string, nodeId: string) => string
}

export interface SpawnTargetChain {
  nodeId: string
  sourceCwd: string
}

/** node chain pure parse (herdr etc. external runtime and kernel same source consume tail segment semantics). */
export function resolveSpawnTargetNodeId(
  profileNodeId: string | undefined,
  parentNodeId: string | undefined,
  forkSameProfile?: boolean,
): string {
  return forkSameProfile === true
    ? (parentNodeId ?? profileNodeId ?? 'local')
    : (profileNodeId ?? parentNodeId ?? 'local')
}

/** complete chain parse: node + platform consolidate after source cwd. */
export function resolveSpawnTargetChain(input: SpawnTargetChainInput): SpawnTargetChain {
  const nodeId = resolveSpawnTargetNodeId(input.profileNodeId, input.parentNodeId, input.forkSameProfile)
  const rawCwd =
    input.forkSameProfile === true
      ? (input.requestCwd ?? input.parentCwd ?? input.profileCwd ?? input.defaultCwd)
      : (input.requestCwd ?? input.profileCwd ?? input.parentCwd ?? input.defaultCwd)
  return { nodeId, sourceCwd: input.normalize(rawCwd, nodeId) }
}
