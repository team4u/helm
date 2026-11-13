/**
 * builtin:herdr 的宿主公共端口消费（ctx.host 通用机制 → 插件内部依赖）。
 *
 * 分工纪律（机制与策略分离）：
 * - 宿主在 ctx.host 上暴露通用机制：profiles / buildSpawnEnv / redact /
 *   runGate / getArtifact / completeText / nodeIpc / executionEnv——不含
 *   任何 Herdr 语义；
 * - 本模块只做「依赖装配」：从 ctx.host 真实类型（HelmHostApi，core
 *   db1e447b 起 nodeIpc/executionEnv 等端口已在 protocol 类型化）读取并
 *   组装 HerdrPluginDependencies 与 HerdrNodeChannel（Context 语义收敛为
 *   公开端口的 AbortSignal），可选端口缺席时省略（不降级、不伪造）。
 */

import type { HelmHostApi, HelmHostNodeIpcPort } from '@helm/protocol'
import type { HerdrNodeChannel, HerdrNodeEnv, HerdrPluginDependencies, HerdrTransport } from './contracts.js'
import { createBlockedSnapshotAnalyzer } from './snapshot-analysis.js'

/** 宿主 nodeIpc 端口可能携带的可选平台上报（内核后端能力；protocol 类型未声明）。 */
type NodeIpcWithPlatform = HelmHostNodeIpcPort & {
  nodePlatform?: (nodeId: string) => string | undefined
}

/**
 * 公共端口 → 内部 HerdrNodeChannel 适配（生产唯一通道来源）：
 * - envFor = executionEnv（ExecutionEnv 结构满足 HerdrNodeEnv 的 Pick 子集）；
 * - nodeIpc.subscribe 宿主为必需端口（core 已类型化），通道透传；
 * - nodePlatform 为内核后端可选能力（NodeRegistry 注册事实）：缺席时远端
 *   平台未知（resolveCwd 透传不改写，绝不猜）。
 */
export function nodeChannelFromHost(host: HelmHostApi): HerdrNodeChannel {
  const nodeIpc = host.nodeIpc as NodeIpcWithPlatform
  return {
    isOnline: (nodeId) => host.nodeIpc.isOnline(nodeId),
    getNodeHubUrl: (nodeId) => host.nodeIpc.getNodeHubUrl?.(nodeId),
    ...(nodeIpc.nodePlatform !== undefined
      ? { nodePlatform: (nodeId: string) => nodeIpc.nodePlatform?.(nodeId) }
      : {}),
    ipcCall: (nodeId, input, signal) => host.nodeIpc.call(nodeId, input, signal),
    envFor: (nodeId, cwd) => host.executionEnv(nodeId, cwd),
    ipcSubscribe: (nodeId, input, onLine, onClosed, signal) =>
      host.nodeIpc.subscribe(nodeId, input, onLine, onClosed, signal),
  }
}

/**
 * ctx.host → HerdrPluginDependencies（零参工厂的装配点）。
 * runLocalGate 固定 nodeId:'local'（本机 gate 语义；远端 gate 走 transport.runGate）。
 * analyzeBlockedSnapshot 仅在 completeText 可用时装配（AI 快照增强可选）。
 * transport 可注入（测试 fixture）；生产由插件入口建 createHerdrTransport。
 */
export function assembleHerdrDepsFromHost(
  host: HelmHostApi,
  options: { transport?: HerdrTransport } = {},
): HerdrPluginDependencies {
  const analyzer = createBlockedSnapshotAnalyzer({ completeConversationText: (input) => host.completeText(input) })
  return {
    profiles: { get: (id) => host.profiles.get(id) },
    buildSpawnEnv: (conversationId, cwd, nodeId) => host.buildSpawnEnv(conversationId, cwd, nodeId),
    redact: (text) => host.redact(text),
    runLocalGate: (command, opts) => host.runGate(command, { ...opts, nodeId: 'local' }),
    getArtifact: (id, conversationId) => host.getArtifact(id, conversationId),
    nodeChannel: nodeChannelFromHost(host),
    analyzeBlockedSnapshot: (input) => analyzer.analyze(input),
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
  }
}
