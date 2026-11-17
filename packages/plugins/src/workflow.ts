/**
 * builtin:workflow: the subagent / SubagentWorkflow / cleanup_worktree orchestration plugin.
 *
 * Responsibilities:
 * - Wrap the orchestration engine (engine/: DSL runtime + journal replay + WorkflowService);
 *   the engine is plugin-owned (the kernel never imports this directory); the generic cross-spawn
 *   boundary lives in runtime/spawn (kernel side);
 * - private state goes through the ctx.doc private document `records` (the plugin docs namespace,
 *   persisted in state.sqlite); the public `runs` projection is sharded per conversation (ctx.sessionDoc,
 *   each shard holding runs started by itself and its descendants -- following the real conversation
 *   parent chain against loops/missing parents; run.conversationId keeps the original ownership;
 *   never enters the global first frame / global SSE; conversation additions/deletions re-project via
 *   host events); globally only a compact `run-badges` badge document is kept (per-conversation
 *   aggregated count/tone/footerText, deduped by run.id, no full run summaries);
 *   no in-process Map fallback, no kernel.documentStore injection;
 * - background run settlement (kind=subagent is always background; kind=workflow started via the tool's
 *   background flag likewise sets notifyParentOnSettle) delivers the report to the parent conversation via
 *   submitInput(requestId) (idempotent across restarts; a notification when the parent conversation is
 *   deleted); descendant parent conversations inside a cascade-cancel boundary get no delivery (preventing
 *   revival after cancellation); a single settle report goes only to owners outside the boundary;
 *   the background default uses the kernel's authoritative ownership=human judgment (no profileId/
 *   runtime role hardcoding): human interactive sessions default to background; automated sessions
 *   (bot/helm) default to synchronous with an explicit background=true explicitly rejected (preventing
 *   early settlement of subagents/resident workers);
 * - cascade cancellation: on turn_settled (outcome=aborted), cancel all in-flight runs of that
 *   conversation subtree belonging to it (completed/failed do not cancel legitimate background tasks);
 *   managed sub-conversation aborts always go through ctx.host.abortConversationGuarded for the kernel's
 *   atomic recheck (the human red line), never falling back to plain abortConversation;
 * - lifecycle: service.prepare runs prepareRecovery (only laying abort markers, waking no scheduler;
 *   must run before any service start -- guaranteed by the host's global prepare barrier);
 *   service.start runs init (terminate leftover tasks, mark failed, re-deliver notifications) and close;
 *   liveTasks declares in-flight tasks (disable is hard-blocked);
 * - nesting depth contract: managed subagents (native/external sub-conversations derived via this plugin)
 *   may nest DEFAULT_MAX_SUBAGENT_DEPTH (2) levels by default -- the main conversation derives one
 *   level directly, a level-1 subagent may derive level-2 by default, and a conversation at the subtree
 *   cap is an orchestration leaf. The private registry persists depth / parentConversationId / subtree-cap
 *   facts; three lines of defense -- before_turn tool stripping, tool/action entry pre-rejection, and the
 *   highest-priority agent_spawn backstop -- explicitly report subagent_depth_exceeded; explicit extension
 *   to deeper levels goes through the plugin config and the spawn meta's maxSubagentDepth field of this
 *   plugin's namespace (both validated within HARD_MAX_SUBAGENT_DEPTH; managed subagents cannot raise an
 *   inherited cap) (fork / SuperAgent workers are not in the table and are unaffected).
 *
 * Modular split architecture (the entry only assembles; registration order and dependency injection in definePlugin):
 * - ./workflow/config.ts: plugin config schema and read-time validation (validated at startup, never run sick)
 * - ./workflow/depth.ts: managed-subagent registry and nesting-depth guard (shared facts of the three defense lines)
 * - ./workflow/projection.ts: runs conversation-shard projection and the global compact badges (idempotent writes)
 * - ./workflow/background.ts: background default policy and background settle report delivery
 * - ./workflow/engine-host.ts: HelmHostApi ports -> WorkflowServiceHost adaptation
 *   (two safety disciplines: guarded aborts / emitEvent convergence)
 * - ./workflow/hooks.ts: the dual agent_spawn hooks (depth guard 300 / worktree isolation 200),
 *   before_turn tool stripping, turn_settled cascade cancellation and host event subscriptions
 * - ./workflow/tools.ts: the subagent / SubagentWorkflow / cleanup_worktree tools
 * - ./workflow/actions.ts: the 13 actions (reused across five ends)
 * - ./workflow/ui.ts: frontend UI extension point declarations
 */
import type { PluginDefinition } from '@helm/protocol'
import { resolvePluginClientAssets } from './asset-paths.js'
import {
  WORKFLOW_PLUGIN_ID,
  WORKFLOW_RUNS_DOC,
  WORKFLOW_RUN_BADGES_DOC,
  type WorkflowRunBadgesDocState,
  type WorkflowRunSessionDocState,
} from './contracts.js'
import { WorkflowService } from './workflow/engine/index.js'
import { WorktreeIsolation } from './workflow/isolation.js'
import {
  isEffectiveAutoRecover,
  readAutoRecoverOnRestart,
  readMaxConcurrentAgents,
  readMaxSubagentDepth,
  registerWorkflowConfigSchema,
} from './workflow/config.js'
import { createManagedSubagentRegistry, type ManagedSubagentEntry } from './workflow/depth.js'
import { createRunsProjection } from './workflow/projection.js'
import { createBackgroundPolicy, createBackgroundReporter } from './workflow/background.js'
import { createWorkflowEngineHost } from './workflow/engine-host.js'
import { registerWorkflowHooks } from './workflow/hooks.js'
import { registerWorkflowTools } from './workflow/tools.js'
import { registerWorkflowActions } from './workflow/actions.js'
import { registerWorkflowUi } from './workflow/ui.js'

export { WORKFLOW_PLUGIN_ID }

export function createWorkflowPlugin(): PluginDefinition {
  return {
    id: WORKFLOW_PLUGIN_ID,
    name: { en: 'Workflows & Subagents', 'zh-CN': '工作流与子代理' },
    description: {
      en: 'Deterministic multi-agent orchestration: subagent / SubagentWorkflow tools, managed Git worktrees, run records and the task panel.',
      'zh-CN': '确定性多智能体编排：subagent / SubagentWorkflow 工具、受管 Git 工作树、运行记录与任务面板。',
    },
    icon: 'workflow',
    version: '0.1.0',
    ...resolvePluginClientAssets(WORKFLOW_PLUGIN_ID, 'workflow', 'workflow_plugin_client_missing'),
    definePlugin(ctx) {
      // ---- Conversation-sharded public doc: runs (transient in-memory projection; zero SQLite I/O) ----
      // Not in the global first frame / global SSE; the frontend pulls and incrementally updates per conversation via the dedicated subscription stream.
      const runsDoc = ctx.sessionDoc<WorkflowRunSessionDocState>(
        WORKFLOW_RUNS_DOC,
        { runs: [] },
        { public: true, durable: false },
      )

      // ---- Global compact badge doc: run-badges (transient in-memory projection; only count/tone/footerText, intentionally global) ----
      // Workbench navigation badges need cross-conversation visibility; full run summaries never enter this doc / the global stream.
      const badgesDoc = ctx.doc<WorkflowRunBadgesDocState>(
        WORKFLOW_RUN_BADGES_DOC,
        { byConversation: {} },
        { public: true, durable: false },
      )

      // ---- Engine-private records doc (key-value store: run index + per-run records) ----
      // Private doc: not in public snapshots/events; the engine persists through it, and restart recovery reads the same namespace.
      const records = ctx.doc<Record<string, unknown>>('records', {})

      // ---- Worktree isolation asset doc (managed registry + durable leases; kept on disable for re-reading) ----
      // Same layer as records: the allocator registry + lease table + agentId binding table. Not cleared
      // while the plugin is disabled; after re-enable, cleanup can still locate them (no metadata loss).
      const worktreeDocs = ctx.doc<Record<string, unknown>>('worktree-state', {})
      const worktreeDocStore = {
        get<T>(key: string, initial: T): T {
          const all = worktreeDocs.get()
          const raw = all[key]
          return raw === undefined ? initial : (structuredClone(raw) as T)
        },
        set<T>(key: string, value: T): void {
          worktreeDocs.update((current) => ({ ...current, [key]: structuredClone(value) }))
        },
        flush: (): Promise<void> => worktreeDocs.flush(),
      }

      // ---- Managed-subagent registry (private doc; the persistent source of facts across restarts) ----
      const subagentConvDoc = ctx.doc<Record<string, ManagedSubagentEntry>>('subagent-conversations', {})

      // ---- Plugin config: schema registration + validate at startup (invalid values fail explicitly at definition time) ----
      registerWorkflowConfigSchema(ctx)
      readMaxConcurrentAgents(ctx)
      readMaxSubagentDepth(ctx)
      readAutoRecoverOnRestart(ctx)

      // ---- Depth guard and managed-subagent registry (validating all persisted entries at construction) ----
      const registry = createManagedSubagentRegistry({
        doc: subagentConvDoc,
        configuredMaxSubagentDepth: () => readMaxSubagentDepth(ctx),
      })

      // ---- Background default policy and background settle reports (workflows injected lazily, acyclic) ----
      const backgroundPolicy = createBackgroundPolicy({
        getConversationOwnership: (id) => ctx.host.getConversationOwnership(id),
      })
      const backgroundReporter = createBackgroundReporter({
        getConversation: (id) => ctx.host.getConversation(id),
        emitEvent: (type, payload) => ctx.host.emitEvent(type, payload),
        submitInput: (conversationId, text, opts) => ctx.host.submitInput(conversationId, text, opts),
        isConversationCancelling: (id) => workflows.isConversationCancelling(id),
        listActiveRuns: () => workflows.listActiveRuns(),
      })

      // ---- runs conversation-shard projection and global badges (the stopping gate lives inside the projection) ----
      const projection = createRunsProjection({
        runsDoc,
        badgesDoc,
        listRuns: () => workflows.listRuns(),
        listConversations: () => ctx.host.listConversations(),
      })

      // Controlled stop ordering: teardown first sets deactivating, which deposes doc handles, but service.stop
      // belongs to the host's controlled call chain -- this plugin synchronously re-projects runs last inside stop.
      // For the final flush during stop to be writable, the engine holds a direct reference to this cycle's doc
      // handle (this closure guarantees no further external writes before stop returns); handles of old cycles
      // (epoch already advanced) are rejected at the ctx.doc boundary, preventing post-disable leftover writes.
      const stateStore = {
        get<T>(key: string, initial: T): T {
          const all = records.get()
          const raw = all[key]
          return raw === undefined ? initial : (structuredClone(raw) as T)
        },
        set<T>(key: string, value: T): void {
          records.update((current) => ({ ...current, [key]: structuredClone(value) }))
        },
        flush: (): Promise<void> => records.flush(),
      }

      // ---- Worktree isolation lifecycle (this plugin's own Git capability) ----
      // The agent_spawn around (continuation) wrapper wraps the whole derivation: allocation/resume/occupancy/lease;
      // priority 200 (running before external-runtime takers like herdr's 100 = the outer layer),
      // ensuring external executions are also wrapped by leases and registration; Git commands run via
      // ctx.host.execEnv (direct argv) on the real final node.
      const isolation = new WorktreeIsolation({
        host: {
          resolveSpawnTarget: (input) => ctx.host.resolveSpawnTarget(input),
          execEnv: (req, opts) => ctx.host.execEnv(req, opts),
          executionEnv: (nodeId, cwd) => ctx.host.executionEnv(nodeId, cwd),
          inspectNodePathUsage: (input) => ctx.host.inspectNodePathUsage(input),
          listActiveSpawnExecutions: () => ctx.host.listActiveSpawnExecutions(),
          redact: (text) => ctx.host.redact(text),
          getConversation: (id) => {
            const conv = ctx.host.getConversation(id)
            return { cwd: conv.cwd, nodeId: conv.nodeId, status: conv.status, profileId: conv.profileId }
          },
          profiles: {
            get: (id) => ctx.host.profiles.get(id),
          },
          get isClosing() {
            return ctx.host.isClosing
          },
        },
        docStore: worktreeDocStore,
      })

      // ---- WorkflowService instance (all host capabilities go through the ctx.host trusted channel) ----
      const workflows = new WorkflowService({
        dataDir: ctx.dataDir,
        state: stateStore,
        concurrency: readMaxConcurrentAgents(ctx),
        autoRecoverOnRestart: () => isEffectiveAutoRecover(ctx),
        deferExternalReattach: true,
        // Persistent value-level redaction hook (declared by contract, injected by the main app; the
        // actual sole source is the host's unified redact port): run records/ledger passes stash redaction before writes, preventing secrets from landing in storage.
        redact: (text) => ctx.host.redact(text),
        host: createWorkflowEngineHost({
          host: {
            spawnAgent: (request) => ctx.host.spawnAgent(request),
            invokeAction: (pluginId, actionId, input, invokeContext) =>
              ctx.host.invokeAction(pluginId, actionId, input, invokeContext),
            prepareAction: (pluginId, actionId, input, prepareContext) =>
              ctx.host.prepareAction(pluginId, actionId, input, prepareContext),
            execEnv: (req, opts) => ctx.host.execEnv(req, opts),
            listActions: () => ctx.host.listActions(),
            getConversation: (id) => ctx.host.getConversation(id),
            getConversationOwnership: (id) => ctx.host.getConversationOwnership(id),
            abortConversationGuarded: (id, guard) => ctx.host.abortConversationGuarded(id, guard),
            emitEvent: (type, payload, options) => ctx.host.emitEvent(type, payload, options),
            runGate: (command, options) => ctx.host.runGate(command, options),
            get isClosing() {
              return ctx.host.isClosing
            },
          },
          projection,
          deliverBackgroundReport: (run, info) => backgroundReporter.deliver(run, info),
        }),
      })

      // ---- Lifecycle hooks and host event subscriptions (agent_spawn 300/200, before_turn,
      //      turn_settled cascade cancellation, conversation re-projection, diagnostics probes) ----
      registerWorkflowHooks(ctx, { registry, isolation, workflows, projection })

      // ---- service: the workflow-engine lifecycle ----
      ctx.service({
        id: 'workflow-engine',
        async prepare() {
          // Recovery phase one (the global prepare barrier, before any service start and before the SDK
          // scheduler resume): only read leftover records and, via abortConversationGuarded (paused phase),
          // lay persistent abort markers; wake no SDK scheduler, submit no input -- other plugins
          // (assistant/herdr/external) and tools are not fully registered yet, and any input submission now
          // would produce orphan turns.
          await workflows.prepareRecovery()
        },
        async start() {
          // Recovery phase two (after all plugins finished prepare): init terminates leftover child tasks,
          // explicitly marks running as failed(interrupted), and re-delivers parent-conversation notifications
          // (tools are registered by now, so re-delivered input consumption is safe), then projects runs & badges in memory.
          await workflows.init()
          projection.sync()
        },
        async stop() {
          // Controlled stop: first set stopping to intercept runtime background callbacks, then await engine
          // suspend/close and flush durable private records. Public runs and run-badges are transient in-memory
          // projections (durable: false), so teardown performs zero SQLite projection writes.
          projection.beginStopping()
          if (ctx.host.isClosing && isEffectiveAutoRecover(ctx)) {
            await workflows.suspend()
          } else {
            await workflows.close()
          }
          await records.flush()
        },
        liveTasks() {
          return workflows
            .listActiveRuns()
            .filter((r) => r.status === 'running')
            .map((r) => `workflow:${r.id}`)
        },
      })

      // ---- Model tools: subagent / SubagentWorkflow / cleanup_worktree ----
      registerWorkflowTools(ctx, {
        workflows,
        isolation,
        assertCanSpawn: (conversationId) => registry.assertCanSpawn(conversationId),
        resolveBackground: (conversationId, explicit) => backgroundPolicy.resolveBackground(conversationId, explicit),
        syncRunsDoc: () => projection.sync(),
      })

      // ---- Actions (reused across five ends: HTTP / CLI / run_action / Workflow / Web UI) ----
      registerWorkflowActions(ctx, {
        workflows,
        isolation,
        assertCanSpawn: (conversationId) => registry.assertCanSpawn(conversationId),
        syncRunsDoc: () => projection.sync(),
      })

      // ---- UI extension points (client.tsx track; components subscribe to the runs shard themselves via usePluginSessionDoc) ----
      registerWorkflowUi(ctx)
    },
  }
}
