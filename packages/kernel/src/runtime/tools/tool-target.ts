/**
 * Conversation target resolution (shared by `write`/`edit`/`register_artifact`).
 *
 * Resolves `(nodeId, cwd, platform)` for the conversation. Preserves the conversation `cwd` in its native
 * POSIX/Windows form without polluting it with the Hub host's path rules (e.g. a remote node may run Windows
 * while the Hub runs Linux); `platform` is the target node's platform (`undefined` when unknown remotely,
 * sharing the exact same platform lookup source as `bash`/`runShell`).
 */
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import { isAbsoluteTargetPath, type TargetPlatform } from '@helm/protocol'
import { targetPlatformForNode } from '../target-platform.js'
import type { HelmToolDeps } from '../tool-deps.js'

/** Minimal SDK `ToolApi` subset needed by `write`/`edit`/`register_artifact` (satisfied structurally by both
 * test `makeApi` fakes and real SDK APIs; agent and tool share the same SDK `Context` so cancellation propagates). */
interface ToolTargetApi {
  agent(context: Context): Promise<{ cwd?: string }>
  conversationId: number | string
}

/** Resolved conversation target. */
interface ToolTarget {
  nodeId: string
  base: string
  platform: TargetPlatform | undefined
}

/** Resolve conversation target; returns `{ error }` when `cwd` is not absolute (tools surface this with `*_failed`). */
export async function resolveToolTarget(
  deps: HelmToolDeps,
  api: ToolTargetApi,
  context: Context = BACKGROUND_CONTEXT,
): Promise<ToolTarget | { error: string }> {
  const agent = await api.agent(context)
  const base = agent.cwd ?? deps.defaultCwd
  if (!isAbsoluteTargetPath(base)) {
    return { error: `Conversation cwd is not an absolute path (${base}); file operation rejected` }
  }
  const nodeId = deps.nodeIdOf?.(api.conversationId as number) ?? 'local'
  const platformInfo = targetPlatformForNode(deps.envFabric, nodeId)
  return {
    nodeId,
    base,
    platform: platformInfo.known ? platformInfo.platform : undefined,
  }
}
