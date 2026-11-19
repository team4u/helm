/**
 * RuntimeNodeOperations: node management and remote daemon orchestration (extracted from KernelRuntime).
 *
 * Responsibilities:
 * - Centralize node operations (listNodes, issueNodeToken, removeNode, checkNodeUpgrade, upgradeNode, execEnv);
 * - Emit node online/offline events and trigger eligible auto-upgrades;
 * - Initialize underlying node prerequisites (nodeTokens, cliBinDir, localDiskStats).
 */

import type {
  EnvExecRequest,
  EnvExecResponse,
  NodeInfo,
  NodeIssuedToken,
  NodeUpgradeCheckInput,
  NodeUpgradeCheckResult,
  NodeUpgradeResult,
} from '@helmx/protocol'
import type { EnvFabric } from '../env/index.js'
import type { EventHub } from './events.js'
import type { NodeManager } from './node-manager.js'

interface RuntimeNodeOperationsDeps {
  readonly nodes: NodeManager
  readonly envFabric: EnvFabric
  readonly events: EventHub
}

export class RuntimeNodeOperations {
  constructor(private readonly deps: RuntimeNodeOperationsDeps) {}

  /**
   * Bind underlying node connection change events:
   * - Node connects/disconnects -> publish node.changed SSE event (real-time Web/CLI awareness);
   * - When removeNode severs a connection, it clears the index first so the offline callback is skipped;
   * - If a newly connected node lags behind Hub version and HELMX_AUTO_UPGRADE_NODES=1 is set, trigger auto-upgrade asynchronously.
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
   * Initialize node substrate prerequisites:
   * 1. Load config.json node token registry;
   * 2. Generate helmx CLI wrapper script;
   * 3. Warm up local disk stats cache.
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
