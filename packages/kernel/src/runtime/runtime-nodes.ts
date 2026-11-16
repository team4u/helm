/**
 * RuntimeNodeOperations: node manage and remote daemon orchestration (from KernelRuntime split out).
 *
 * responsibility:
 * - concentrate manage many node operation (listNodes, issueNodeToken, removeNode, checkNodeUpgrade, upgradeNode, execEnv);
 * - maintain node on take offline event delivery and automatically upgrade trigger;
 * - warm up and initialize node bottom seat which must asset (nodeTokens, cliBinDir, localDiskStats).
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
   * bind set underlying node connect change event:
   * - node on take offline -> delivery node.changed SSE event (Web/CLI real-time aware);
   * - removeNode trigger assert connect when because already first delete index, does not resend publish offline event;
   * - node enable and version after Hub when, if HELM_AUTO_UPGRADE_NODES=1 then async trigger upgrade.
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
   * initialize node bottom seat environment:
   * 1. load config.json node sign table;
   * 2. generate helm CLI wrap script;
   * 3. warm up local disk count.
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
