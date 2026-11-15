/**
 * 远端执行前置守卫（统一助手）：EnvFabric 缺失（env_fabric_missing）与
 * 节点离线（node_offline）在 runShell 与 read/write/edit/register_artifact
 * 共 6 处重复出现，此处收口为两族文案 + 守卫函数，保证「绝不静默回退
 * local」的显式失败语义与文案单一来源。
 *
 * 两族文案有意不同（不是遗漏）：
 * - shell 族（runShell / bash / runGate）：面向命令执行；
 * - 文件族（read/write/edit/register_artifact）：按操作动词（读取/写入/编辑）
 *   给出针对性文案，与既有行为逐字一致。
 */
import type { EnvFabric } from '../../env/index.js'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'

/** 文件工具操作动词（守卫文案用，与各工具既有文案逐字对齐）。 */
export type FileOpAction = '读取' | '写入' | '编辑'

/** shell 族：EnvFabric 缺失（无法建立远端执行）。 */
export function shellEnvFabricMissingText(nodeId: string): string {
  return `env_fabric_missing: 节点 ${nodeId} 为远端但 EnvFabric 未注入（无法建立远端执行，绝不回退本机）`
}

/** shell 族：节点离线或未接入。 */
export function shellNodeOfflineText(nodeId: string): string {
  return `node_offline: 节点 ${nodeId} 离线或未接入，无法在远端执行命令（绝不回退本机执行）`
}

/**
 * runShell 远端前置守卫：EnvFabric 缺失或节点已知晓离线时返回显式失败文本，
 * 通过返回 undefined。
 *
 * isOnline 仅是「调用时已知晓离线」的快速失败提示；检查后到 RPC 之间断连的
 * 行为由 RemoteExecutionEnv 统一决定：等待节点重连（尊重 context 取消，见
 * env/remote-env.ts 的离线韧性语义）。两条路径语义有意不同（前者已知的确定
 * 离线立即报错，后者在途韧性等待），不是遗漏。
 */
export function remoteShellGuardText(envFabric: EnvFabric | undefined, nodeId: string): string | undefined {
  if (envFabric === undefined) return shellEnvFabricMissingText(nodeId)
  if (!envFabric.isOnline(nodeId)) return shellNodeOfflineText(nodeId)
  return undefined
}

/** 文件族：EnvFabric 缺失（按操作动词）。 */
export function envFabricMissingFileText(nodeId: string, action: FileOpAction): string {
  return `env_fabric_missing: 节点 ${nodeId} 为远端但 EnvFabric 未注入（无法${action}远端文件，绝不回退本机）`
}

/** 文件族：节点离线（按操作动词）。 */
export function nodeOfflineFileText(nodeId: string, action: FileOpAction): string {
  return `node_offline: 节点 ${nodeId} 离线，无法${action}远端文件（绝不回退本机）`
}

/**
 * 文件工具远端前置守卫：EnvFabric 缺失或节点离线时返回显式失败文本，
 * 通过返回 undefined。绝不回退本机读写 Hub 磁盘。
 */
export function remoteFileGuardText(
  envFabric: EnvFabric | undefined,
  nodeId: string,
  action: FileOpAction,
): string | undefined {
  if (envFabric === undefined) return envFabricMissingFileText(nodeId, action)
  if (!envFabric.isOnline(nodeId)) return nodeOfflineFileText(nodeId, action)
  return undefined
}

/**
 * 文件工具远端守卫 + 底座获取（read/write/edit/register_artifact 共用）：
 * EnvFabric 缺失或节点离线返回显式失败文本，通过则返回该 (nodeId, cwd)
 * 靶点的 ExecutionEnv。绝不回退本机。
 */
export function requireRemoteEnv(
  envFabric: EnvFabric | undefined,
  nodeId: string,
  base: string,
  action: FileOpAction,
): { error: string } | { env: ExecutionEnv } {
  const guard = remoteFileGuardText(envFabric, nodeId, action)
  if (guard !== undefined) return { error: guard }
  return { env: envFabric!.envFor(nodeId, base) }
}
