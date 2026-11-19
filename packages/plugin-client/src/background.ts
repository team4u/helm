/**
 * Read-only background in-flight facts for plugin clients (host-port driven).
 *
 * The host derives the per-conversation index from the generic
 * workbench.panel badge contract (panels of enabled plugins declaring
 * badge.byConversationField; tone = 'accent' entries are in flight, their
 * footerText is the honest summary) plus the kernel context-compaction state
 * — the same single source the sidebar attention group consumes. This hook
 * adds zero plugin-ID knowledge and zero side effects: it is a plain read of
 * the port slice, so a plugin view can honestly reflect "the execution
 * conversation is idle but a background run is still in flight".
 *
 * Absence is honest: when the host has not wired the slice yet (older host
 * or projection pending) the hook returns undefined and consumers must not
 * fabricate in-flight states.
 */
import { usePluginClientHost } from './host-port.js'
import type { PluginClientBackgroundFact } from './host-port.js'

/** Reactive per-conversation background in-flight facts (key: conversationId); undefined = not wired / no facts yet. */
export function useConversationBackground(): Readonly<Record<number, PluginClientBackgroundFact>> | undefined {
  const port = usePluginClientHost()
  return port.conversationBackground
}
