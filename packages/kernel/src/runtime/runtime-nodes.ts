/**
 * RuntimeNodeOperations：节点管理与远端守护进程编排（从 KernelRuntime 拆出）。
 *
 * 职责：
 * - 集中管理多节点操作（listNodes, issueNodeToken, removeNode, checkNodeUpgrade, upgradeNode, execEnv）；
 * - 维护节点上下线事件投递与自动升级触发；
 * - 预热与初始化节点底座所需资源（nodeTokens, cliBinDir, localDiskStats）。
 */

import type {
  EnvExecRequest,
  EnvExecResponse,
  NodeInfo,
  NodeIssuedToken,
  NodeUpgradeCheckInput,
  NodeUpgradeCheckResult,
  NodeUpgradeResult,
} from '@helm/protocol'
import type { EnvFabric } from '../env/index.js'
import type { EventHub } from './events.js'
import type { NodeManager } from './node-manager.js'

export interface RuntimeNodeOperationsDeps {
  readonly nodes: NodeManager
  readonly envFabric: EnvFabric
  readonly events: EventHub
}

export class RuntimeNodeOperations {
  constructor(private readonly deps: RuntimeNodeOperationsDeps) {}

  /**
   * 绑定底层节点连接变更事件：
   * - 节点上下线 -> 投递 node.changed SSE 事件（Web/CLI 实时感知）；
   * - removeNode 触发断连时由于已先删索引，不重复发布离线事件；
   * - 节点上线且版本落后 Hub 时，若 HELM_AUTO_UPGRADE_NODES=1 则异步触发升级。
   */
  bindEvents(): void {
    this.deps.envFabric.registry.onNodeChanged((nodeId, online) => {
      if (!online && !this.deps.nodes.hasNode(nodeId)) return
      const conn = online ? this.deps.envFabric.registry.get(nodeId) : undefined
      this.deps.events.publish('node.changed', {
        type: 'node.changed',
        node: this.deps.nodes.byomNodeInfo(nodeId, conn),
      })
      if (online && conn !== undefined) {
        void this.deps.nodes.autoUpgradeIfEligible(nodeId, conn.version)
      }
    })
  }

  /**
   * 初始化节点底座环境：
   * 1. 加载 config.json 节点签发表；
   * 2. 生成 helm CLI 包装脚本；
   * 3. 预热 local 磁盘统计。
   */
  async initialize(): Promise<void> {
    await this.deps.nodes.loadNodeTokens()
    await this.deps.nodes.ensureCliBinDir()
    await this.deps.nodes.ensureLocalDiskStats()
  }

  async listNodes(): Promise<NodeInfo[]> {
    return this.deps.nodes.listNodes()
  }

  async issueNodeToken(nodeId: string): Promise<NodeIssuedToken> {
    return this.deps.nodes.issueNodeToken(nodeId)
  }

  async removeNode(nodeId: string): Promise<void> {
    return this.deps.nodes.removeNode(nodeId)
  }

  async checkNodeUpgrade(nodeId: string, input?: NodeUpgradeCheckInput): Promise<NodeUpgradeCheckResult> {
    return this.deps.nodes.checkNodeUpgrade(nodeId, input)
  }

  async upgradeNode(
    nodeId: string,
    input?: { targetVersion?: string; registryUrl?: string; force?: boolean },
  ): Promise<NodeUpgradeResult> {
    return this.deps.nodes.upgradeNode(nodeId, input)
  }

  async execEnv(
    req: EnvExecRequest,
    onChunk?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void,
    signal?: AbortSignal,
  ): Promise<EnvExecResponse> {
    return this.deps.nodes.execEnv(req, onChunk, signal)
  }
}
