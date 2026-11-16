/**
 * conversation target parse (write/edit/register_artifact shared use).
 *
 * parse conversation target (nodeId, cwd, platform). conversation cwd by its itself shape
 * (POSIX/Windows) keep original, never use Hub host resolve pollute (remote node may is
 * Windows target,Hub in Linux on resolve will obtain to error result);platform is target
 * node platform (remote unknown when undefined, by shape choose rule - - and bash/runShell platform
 * source the same original language, do not in this another write rule).
 */
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import { isAbsoluteTargetPath, type TargetPlatform } from '@helm/protocol'
import { targetPlatformForNode } from '../target-platform.js'
import type { HelmToolDeps } from '../tool-deps.js'

/** write/edit/register_artifact for SDK ToolApi most small dependency side (test makeApi
 *  replace body and real SDK api all structure satisfy;agent and tool sharing the same SDK Context,cancel
 *  pass broadcast to remote). */
export interface ToolTargetApi {
  agent(context: Context): Promise<{ cwd?: string }>
  conversationId: number | string
}

/** parse out conversation target. */
export interface ToolTarget {
  nodeId: string
  base: string
  platform: TargetPlatform | undefined
}

/** parse conversation target; conversation cwd non- absolute path when return error(tool original through out is *_failed). */
export async function resolveToolTarget(
  deps: HelmToolDeps,
  api: ToolTargetApi,
  context: Context = BACKGROUND_CONTEXT,
): Promise<ToolTarget | { error: string }> {
  const agent = await api.agent(context)
  const base = agent.cwd ?? deps.defaultCwd
  if (!isAbsoluteTargetPath(base)) {
    return { error: `conversation cwd non- absolute path (${base}), reject file operation` }
  }
  const nodeId = deps.nodeIdOf?.(api.conversationId as number) ?? 'local'
  const platformInfo = targetPlatformForNode(deps.envFabric, nodeId)
  return {
    nodeId,
    base,
    platform: platformInfo.known ? platformInfo.platform : undefined,
  }
}
