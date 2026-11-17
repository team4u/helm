import type { WorkflowPhaseSection } from './model-run.ts'

export const SPIN = 'spin-slow'
export const RUN_BADGE: Record<string, string> = {
  running: 'badge-accent', completed: 'badge-ok', failed: 'badge-err', aborted: 'badge-warn',
}
export const NODE_BADGE: Record<string, string> = {
  pending: 'badge-neutral', running: 'badge-accent', done: 'badge-ok', failed: 'badge-err', skipped: 'badge-neutral',
}
export const PHASE_ICON: Record<WorkflowPhaseSection['status'], string> = {
  pending: 'circle', running: 'loader', done: 'check', failed: 'x',
}
/** Badge classes for the unified execution-tree node status (five-value enum). */
export const EXECUTION_BADGE: Record<string, string> = {
  blocked: 'badge-warn', error: 'badge-err', working: 'badge-accent', done: 'badge-ok', pending: 'badge-neutral',
}
export const EXECUTION_ICON: Record<string, string> = {
  blocked: 'clock', error: 'x', working: 'loader', done: 'check', pending: 'circle',
}
