/**
 * In-plugin workbench run focus bus for the builtin:workflow plugin (pure
 * in-memory state + subscription, zero React/DOM dependencies).
 *
 * After a timeline one-line trace (WorkflowToolView / SubagentToolView
 * external run) or a bottom activity tray click, precisely notifies
 * WorkflowWorkbenchPanel to open and expand the full detail view of a given
 * run.id; if the workbench is not mounted yet the request is cached and
 * consumed on the first mounted frame — compatible with React StrictMode.
 */

export interface WorkbenchRunFocusRequest {
  conversationId: number
  runId: string
  seq: number
}

type FocusListener = (request: WorkbenchRunFocusRequest) => void

let pendingFocus: WorkbenchRunFocusRequest | undefined
let focusSeq = 0
const listeners = new Set<FocusListener>()

/** Request the right workbench to focus and expand a run.id of a conversation. */
export function requestWorkbenchRunFocus(conversationId: number, runId: string): void {
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0 || runId === '') return
  focusSeq += 1
  const request: WorkbenchRunFocusRequest = { conversationId, runId, seq: focusSeq }
  pendingFocus = request
  for (const listener of [...listeners]) {
    listener(request)
  }
}

/** Non-destructive peek at a pending run focus request for the current conversation (SSR safe). */
export function peekWorkbenchRunFocus(conversationId: number): WorkbenchRunFocusRequest | undefined {
  return pendingFocus?.conversationId === conversationId ? pendingFocus : undefined
}

/** Clear the pending focus request of a conversation (optionally matching runId exactly). */
export function clearWorkbenchRunFocus(conversationId: number, runId?: string): void {
  if (pendingFocus === undefined || pendingFocus.conversationId !== conversationId) return
  if (runId !== undefined && pendingFocus.runId !== runId) return
  pendingFocus = undefined
}

/** Subscribe to later focus requests (for a mounted WorkflowWorkbenchPanel to jump live). */
export function subscribeWorkbenchRunFocus(listener: FocusListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
