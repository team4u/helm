/**
 * Hub-side foreground TCP port-forwarding contract (shared request/response types for
 * POST /api/nodes/:id/forward and /api/nodes/forward/*; `helm nodes forward*` CLI has the same access).
 *
 * Lifecycle (foreground lease):
 * - The listener exists only for the duration of an explicit command: if it is not bound to a
 *   monitoring event stream (a holder) within a bounded window after creation, it stops
 *   automatically; once bound, it stops when the last holder disconnects; an explicit
 *   DELETE / host close also stops it — never a leftover listener;
 * - Read-only list/get is not a holder; acquire/release is done implicitly via the events stream.
 */

/** POST /api/nodes/:id/forward request body. */
export interface NodeForwardInput {
  /** Hub-side listen address (e.g. 127.0.0.1 / 0.0.0.0; strictly validated). */
  listenHost: string
  /** Hub-side listen port (1..65535; 0 is not usable — only an explicit port can be forwarded). */
  listenPort: number
  /** Target host (from the node's perspective; defaults to 127.0.0.1 when omitted). */
  targetHost?: string
  /** Target port (1..65535). */
  targetPort: number
}

/** Forwarding session snapshot (GET /api/nodes/forward and /api/nodes/forward/:id). */
export interface NodeForwardSession {
  forwardId: string
  nodeId: string
  listenHost: string
  listenPort: number
  targetHost: string
  targetPort: number
  activeConnections: number
  totalConnections: number
  lastError?: string
}

/** NDJSON event frames of GET /api/nodes/forward/:id/events. */
export type NodeForwardEvent =
  | { type: 'started'; listenHost: string; listenPort: number }
  | { type: 'connection'; count: number }
  | { type: 'error'; message: string }
  /** Terminal frame: on stop this frame is sent first, then the listener shuts down (the monitoring stream ends normally instead of hanging). */
  | { type: 'stopped' }
