/**
 * builtin:herdr's ctx.action registrations (list / read / focus / steer) and pane disambiguation.
 *
 * Split out of herdr.ts (behavior line-for-line equivalent to before the split); dependencies injected via HerdrActionsDeps:
 * - HTTP/CLI equal footing with --json; read redacts to the last 40 lines; focus is an explicit user action;
 * - read/focus support nodeId disambiguation, ambiguity returns explicit 409;
 * - steer is the delegation target of onResolved.controls.steer: direct calls still independently perform
 *   caller-ancestor-chain authorization, parent conversation/run strict matching and exact managed (nodeId, paneId) targeting (no authorization exemption for direct calls).
 */

import { HelmxError, type HelmxPluginContext } from '@helmx/protocol'
import type { ExternalSteerRequest, ExternalSteerResult } from '../contracts.js'
import { HERDR_STEER_CONTROLS, targetNodeId, type HerdrTransport } from './contracts.js'
import type { HerdrExecutor } from './executor.js'
import type { ManagedPane, PaneRegistry } from './panes.js'

interface HerdrActionHelpers {
  isValidNodeId: (id: string) => boolean
  parseAgentResult: typeof import('./rpc.js').parseAgentResult
  parsePaneRead: typeof import('./rpc.js').parsePaneRead
  isAncestorOrSelf: typeof import('../lineage.js').isAncestorOrSelf
}

let actionHelpersPromise: Promise<HerdrActionHelpers> | undefined

function loadActionHelpers(): Promise<HerdrActionHelpers> {
  actionHelpersPromise ??= Promise.all([
    import('./transport.js'),
    import('./rpc.js'),
    import('../lineage.js'),
  ])
    .then(([transport, rpc, lineage]) => ({
      isValidNodeId: transport.isValidNodeId,
      parseAgentResult: rpc.parseAgentResult,
      parsePaneRead: rpc.parsePaneRead,
      isAncestorOrSelf: lineage.isAncestorOrSelf,
    }))
    .catch((err) => {
      actionHelpersPromise = undefined
      throw err
    })
  return actionHelpersPromise
}

/** The actions' minimal dependency surface on the plugin main (herdr.ts). */
interface HerdrActionsDeps {
  /** The registry's current value (undefined when not enabled: list is empty, others report unmanaged/not-connected). */
  registry(): PaneRegistry | undefined
  executor(): HerdrExecutor | undefined
  transport(): HerdrTransport
  redact(text: string): string
  /**
   * Conversation parent-chain resolution (host getConversation bridge; not_found folds to undefined,
   * other errors propagate as-is) -- for the steer caller-ancestor-chain authorization.
   */
  parentOfConversation(id: number): number | undefined
}

/** Pane disambiguation resolution: an explicit 409 when the registry hits same-ID panes on multiple nodes. */
function resolvePane(
  registry: PaneRegistry,
  input: { paneId: string; nodeId?: string },
  isValidNodeId: (id: string) => boolean,
): ManagedPane {
  if (input.nodeId !== undefined && input.nodeId !== '') {
    if (!isValidNodeId(input.nodeId)) {
      throw new HelmxError('validation_error', `nodeId '${input.nodeId}' is invalid`, 400, { nodeId: input.nodeId })
    }
    const pane = registry.get(input.nodeId === 'local' ? undefined : input.nodeId, input.paneId)
    if (pane === undefined) {
      throw new HelmxError('not_found', `pane ${input.paneId}@${input.nodeId} is not managed by builtin:herdr`, 404, {
        paneId: input.paneId,
        nodeId: input.nodeId,
      })
    }
    return pane
  }
  const candidates = registry.all().filter((p) => p.paneId === input.paneId)
  if (candidates.length === 0) {
    throw new HelmxError('not_found', `pane ${input.paneId} is not managed by builtin:herdr`, 404, { paneId: input.paneId })
  }
  if (candidates.length > 1) {
    throw new HelmxError(
      'pane_ambiguous',
      `pane ${input.paneId} exists on multiple nodes (${candidates.map((p) => targetNodeId(p.target) ?? 'local').join(', ')}); disambiguate with the nodeId field`,
      409,
      { paneId: input.paneId, nodeIds: candidates.map((p) => targetNodeId(p.target) ?? 'local') },
    )
  }
  return candidates[0]!
}

/** Register the four actions list / read / focus / steer (called once at herdr.ts definePlugin). */
export function registerHerdrActions(ctx: HelmxPluginContext, deps: HerdrActionsDeps): void {
  // ---- actions (HTTP/CLI equal footing; read redacts to 40 lines; focus is an explicit action) ----
  ctx.action<Record<string, never>, { panes: Array<Record<string, unknown>> }>({
    id: 'list',
    description: 'List Herdr panes managed by this plugin (nodeId/pane/status/ownership)',
    idempotent: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { panes: { type: 'array', items: { type: 'object' } } },
      required: ['panes'],
      additionalProperties: false,
    },
    handler() {
      const registry = deps.registry()
      return {
        panes: registry
          ? registry.all().map((p) => ({
              nodeId: targetNodeId(p.target) ?? 'local',
              paneId: p.paneId,
              agentName: p.agentName,
              outcome: p.outcome,
              effectiveCwd: p.effectiveCwd,
              parentConversationId: p.parentConversationId,
              ...(p.workflowRunId !== undefined ? { workflowRunId: p.workflowRunId } : {}),
            }))
          : [],
      }
    },
  })

  ctx.action<{ paneId: string; nodeId?: string }, { paneId: string; nodeId: string; text: string }>({
    id: 'read',
    description: 'Read the terminal tail snapshot of a pane managed by this plugin (40 lines, redacted; use nodeId to disambiguate same-ID panes across nodes)',
    idempotent: true,
    inputSchema: {
      type: 'object',
      properties: {
        paneId: { type: 'string', minLength: 1 },
        nodeId: { type: 'string', description: 'Target node (defaults to local; required for disambiguation when the same ID exists on multiple nodes)' },
      },
      required: ['paneId'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { paneId: { type: 'string' }, nodeId: { type: 'string' }, text: { type: 'string' } },
      required: ['paneId', 'nodeId', 'text'],
      additionalProperties: false,
    },
    async handler(input) {
      const registry = deps.registry()
      if (registry === undefined) {
        throw new HelmxError('not_found', `pane ${input.paneId} is not managed by builtin:herdr`, 404, { paneId: input.paneId })
      }
      const { isValidNodeId, parsePaneRead } = await loadActionHelpers()
      const pane = resolvePane(registry, input, isValidNodeId)
      const read = parsePaneRead(
        await deps.transport().call(pane.target, 'agent.read', {
          target: pane.paneId,
          source: 'recent_unwrapped',
          lines: 40,
          format: 'text',
        }),
      )
      return { paneId: pane.paneId, nodeId: targetNodeId(pane.target) ?? 'local', text: deps.redact(read.text) }
    },
  })

  ctx.action<{ paneId: string; nodeId?: string }, { paneId: string; nodeId: string; focused: boolean }>({
    id: 'focus',
    description: 'Focus a pane in the Herdr terminal (explicit user action; use nodeId to disambiguate same-ID panes across nodes)',
    inputSchema: {
      type: 'object',
      properties: {
        paneId: { type: 'string', minLength: 1 },
        nodeId: { type: 'string', description: 'Target node (defaults to local; required for disambiguation when the same ID exists on multiple nodes)' },
      },
      required: ['paneId'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { paneId: { type: 'string' }, nodeId: { type: 'string' }, focused: { type: 'boolean' } },
      required: ['paneId', 'nodeId', 'focused'],
      additionalProperties: false,
    },
    async handler(input) {
      const registry = deps.registry()
      if (registry === undefined) {
        throw new HelmxError('not_found', `pane ${input.paneId} is not managed by builtin:herdr`, 404, { paneId: input.paneId })
      }
      const { isValidNodeId, parseAgentResult } = await loadActionHelpers()
      const pane = resolvePane(registry, input, isValidNodeId)
      // Real protocol (server source agents.rs:35-41): agent.focus returns
      // ResponseResult::AgentInfo { agent } (agent_info), not ok.
      const info = parseAgentResult(
        await deps.transport().call(pane.target, 'agent.focus', { target: pane.paneId }),
        'agent.focus',
        'agent_info',
      )
      if (info.focused !== true) {
        throw new HelmxError(
          'herdr_focus_failed',
          `agent.focus returned focused=false (pane ${pane.paneId}@${targetNodeId(pane.target) ?? 'local'})`,
          502,
          { paneId: pane.paneId, nodeId: targetNodeId(pane.target) ?? 'local' },
        )
      }
      return { paneId: pane.paneId, nodeId: targetNodeId(pane.target) ?? 'local', focused: true }
    },
  })

  // ---- action steer: in-flight steer for a managed pane (onResolved.controls.steer delegation target) ----
  // Usually builtin:workflow.steer routes here dynamically per node controls; it can also be
  // called directly via HTTP/CLI/run_action; direct calls still independently perform
  // caller-ancestor-chain authorization, parent conversation/run strict matching and exact
  // managed (nodeId, paneId) targeting (no authorization exemption for direct calls). The single delivery
  // entry is executor.steerPane: after the managed task-phase precheck it calls the existing agent.prompt;
  ctx.action<ExternalSteerRequest, ExternalSteerResult>({
    id: HERDR_STEER_CONTROLS.actionId,
    description:
      'Supplement guidance to a Herdr pane managed by this plugin and derived from a workflow run. Sent only when the task-phase precheck is working, using the native Herdr agent.prompt; a submission that just turned idle between precheck and delivery is allowed to continue for one round. blocked goes to the original approval bridge; closing, handoff and Gate phases are rejected. guardLevel=preflight means a pre-send check with no commit-point CAS guarantee; steered=true only means delivered. Timeouts or disconnects are not auto-retried.',
    inputSchema: {
      type: 'object',
      properties: {
        executionId: { type: 'string', minLength: 1, description: 'Managed execution identifier (onResolved.executionId, i.e. the paneId)' },
        nodeId: { type: 'string', description: "Actual execution node ('local' or a node ID; must match the pane registration)" },
        workflowRunId: { type: 'string', minLength: 1, description: 'The workflow run ID that derived the pane (strict match; only for panes managed under a run)' },
        parentConversationId: { type: 'number', minimum: 1, description: 'The parent conversation ID that derived the pane (strict match)' },
        text: { type: 'string', minLength: 1, description: 'Steer guidance text (non-empty; redacted and injected into the terminal with a handoff-contract reminder)' },
      },
      required: ['executionId', 'nodeId', 'workflowRunId', 'parentConversationId', 'text'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        steered: { type: 'boolean', const: true },
        executionId: { type: 'string' },
        nodeId: { type: 'string' },
        stateChangeSeq: { type: 'number', minimum: 0, description: 'The authoritative watermark observed by the pre-send precheck' },
        ownership: { type: 'string', const: 'helmx' },
        guardLevel: { type: 'string', const: 'preflight', description: 'Pre-send check; no commit-point CAS promise' },
      },
      required: ['steered', 'executionId', 'nodeId', 'stateChangeSeq', 'ownership', 'guardLevel'],
      additionalProperties: false,
    },
    cli: {
      command: ['herdr', 'steer'],
      description: 'Supplement guidance to a managed Herdr pane (usually auto-routed via helmx workflows steer <runId>)',
      timeoutMs: 15_000,
    },
    async handler(input, context) {
      const registry = deps.registry()
      const executor = deps.executor()
      if (registry === undefined || executor === undefined) {
        throw new HelmxError(
          'herdr_not_connected',
          'The Herdr service is not started (target server not connected); cannot steer',
          409,
        )
      }
      const { isValidNodeId, isAncestorOrSelf } = await loadActionHelpers()
      // Exact managed-node targeting: an explicit nodeId must match the registration (the same pane on a
      // different node is not accepted; 'local' folds to the local default).
      if (input.nodeId !== 'local' && !isValidNodeId(input.nodeId)) {
        throw new HelmxError('validation_error', `nodeId '${input.nodeId}' is invalid`, 400, { nodeId: input.nodeId })
      }
      const pane = registry.get(input.nodeId === 'local' ? undefined : input.nodeId, input.executionId)
      if (pane === undefined) {
        throw new HelmxError(
          'not_found',
          `pane ${input.executionId}@${input.nodeId} is not managed by builtin:herdr`,
          404,
          { executionId: input.executionId, nodeId: input.nodeId },
        )
      }
      // Caller-ancestor-chain authorization, independent: a call carrying conversation context must be the
      // run's parent conversation itself or an ancestor. The conversation context is injected by the kernel on
      // the model path; a self-reported HTTP conversationId is a scope hint only (not authentication) and mismatches are rejected too.
      const caller = context.conversationId
      if (caller !== undefined) {
        if (!isAncestorOrSelf(input.parentConversationId, caller, deps.parentOfConversation)) {
          throw new HelmxError(
            'herdr_steer_out_of_scope',
            `conversation ${caller} is not allowed to steer pane ${input.executionId}: the pane belongs to a run of parent conversation ${input.parentConversationId}; only itself or its ancestors (or manual HTTP/CLI) may steer`,
            403,
            { callerConversationId: caller, parentConversationId: input.parentConversationId, executionId: input.executionId },
          )
        }
      }
      // Delivery (ownership, phase and run state are independently rechecked inside the executor).
      const { stateChangeSeq } = await executor.steerPane(pane, {
        workflowRunId: input.workflowRunId,
        parentConversationId: input.parentConversationId,
        text: input.text,
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
      })
      return {
        steered: true as const,
        executionId: pane.paneId,
        nodeId: targetNodeId(pane.target) ?? 'local',
        stateChangeSeq,
        ownership: 'helmx' as const,
        guardLevel: 'preflight' as const,
      }
    },
  })
}
