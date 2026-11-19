/**
 * builtin:herdr's consumption of host public ports (ctx.host generic mechanisms -> plugin-internal dependencies).
 *
 * Division discipline (mechanism vs policy separation):
 * - The host exposes generic mechanisms on ctx.host: profiles / buildSpawnEnv / redact /
 *   runGate / getArtifact / completeText / nodeIpc / executionEnv -- with no
 *   Herdr semantics whatsoever;
 * - this module only does "dependency assembly": reads from ctx.host's real types (HelmxHostApi;
 *   since core db1e447b, ports like nodeIpc/executionEnv are typed in protocol) and assembles
 *   HerdrPluginDependencies and HerdrNodeChannel (the Context semantics converge into the
 *   public port's AbortSignal); optional ports are omitted when absent (no degradation, no fabrication).
 */

import type { HelmxHostApi } from '@helmx/protocol'
import type { HerdrNodeChannel, HerdrNodeEnv, HerdrPluginDependencies, HerdrTransport } from './contracts.js'
import { createBlockedSnapshotAnalyzer } from './snapshot-analysis.js'

export function nodeChannelFromHost(host: HelmxHostApi): HerdrNodeChannel {
  return {
    isOnline: (nodeId) => host.nodeIpc.isOnline(nodeId),
    getNodeHubUrl: (nodeId) => host.nodeIpc.getNodeHubUrl?.(nodeId),
    ...(host.nodeIpc.nodePlatform !== undefined
      ? { nodePlatform: (nodeId: string) => host.nodeIpc.nodePlatform?.(nodeId) }
      : {}),
    ipcCall: (nodeId, input, signal) => host.nodeIpc.call(nodeId, input, signal),
    envFor: (nodeId, cwd) => host.executionEnv(nodeId, cwd),
    ipcSubscribe: (nodeId, input, onLine, onClosed, signal) =>
      host.nodeIpc.subscribe(nodeId, input, onLine, onClosed, signal),
  }
}

/**
 * ctx.host -> HerdrPluginDependencies (the assembly point of the zero-arg factory).
 * runLocalGate pins nodeId:'local' (local gate semantics; remote gates go through transport.runGate).
 * analyzeBlockedSnapshot is assembled only when completeText is available (AI snapshot enhancement is optional).
 * transport is injectable (test fixtures); production builds createHerdrTransport in the plugin entry.
 */
export function assembleHerdrDepsFromHost(
  host: HelmxHostApi,
  options: { transport?: HerdrTransport } = {},
): HerdrPluginDependencies {
  const analyzer = createBlockedSnapshotAnalyzer({ completeConversationText: (input) => host.completeText(input) })
  return {
    profiles: { get: (id) => host.profiles.get(id) },
    buildSpawnEnv: (conversationId, cwd, nodeId, options) => host.buildSpawnEnv(conversationId, cwd, nodeId, options),
    redact: (text) => host.redact(text),
    runLocalGate: (command, opts) => host.runGate(command, { ...opts, nodeId: 'local' }),
    getArtifact: (id, conversationId) => host.getArtifact(id, conversationId),
    nodeChannel: nodeChannelFromHost(host),
    analyzeBlockedSnapshot: (input) => analyzer.analyze(input),
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
  }
}
