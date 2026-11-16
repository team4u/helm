/**
 * 会话靶点解析（write/edit/register_artifact 共用）。
 *
 * 解析会话靶点 (nodeId, cwd, platform)。会话 cwd 按其自身形状
 * （POSIX/Windows）保留原样，绝不用 Hub 宿主 resolve 污染（远端节点可能是
 * Windows 靶点，Hub 在 Linux 上 resolve 会得到错误结果）；platform 为目标
 * 节点平台（远端未知时 undefined，按形状选规则——与 bash/runShell 的平台
 * 来源同一原语，不在此另写规则）。
 */
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import { isAbsoluteTargetPath, type TargetPlatform } from '@helm/protocol'
import { targetPlatformForNode } from '../target-platform.js'
import type { HelmToolDeps } from '../tool-deps.js'

/** write/edit/register_artifact 对 SDK ToolApi 的最小依赖面（测试 makeApi
 *  替身与真实 SDK api 均结构满足；agent 与工具共享同一 SDK Context，cancel
 *  传播到远端）。 */
export interface ToolTargetApi {
  agent(context: Context): Promise<{ cwd?: string }>
  conversationId: number | string
}

/** 解析出的会话靶点。 */
export interface ToolTarget {
  nodeId: string
  base: string
  platform: TargetPlatform | undefined
}

/** 解析会话靶点；会话 cwd 非绝对路径时返回 error（工具原样透出为 *_failed）。 */
export async function resolveToolTarget(
  deps: HelmToolDeps,
  api: ToolTargetApi,
  context: Context = BACKGROUND_CONTEXT,
): Promise<ToolTarget | { error: string }> {
  const agent = await api.agent(context)
  const base = agent.cwd ?? deps.defaultCwd
  if (!isAbsoluteTargetPath(base)) {
    return { error: `会话 cwd 非绝对路径（${base}），拒绝文件操作` }
  }
  const nodeId = deps.nodeIdOf?.(api.conversationId as number) ?? 'local'
  const platformInfo = targetPlatformForNode(deps.envFabric, nodeId)
  return {
    nodeId,
    base,
    platform: platformInfo.known ? platformInfo.platform : undefined,
  }
}
