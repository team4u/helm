/**
 * builtin:herdr: intercepts agent_spawn to drive local/remote Herdr CLI agents.
 *
 * Responsibilities (design doc §4.2):
 * - "terminal runs the process, files deliver the result": background panes + .helm/wf-out-* handoff with in-place follow-up self-healing;
 * - blocked <-> AskDoc single-flight approval bridge (expectedStateSeq CAS optimistic lock, async authoritative
 *   agent.get queries the real seq live; never returns the snapshot taken at creation);
 * - $helm status token projection (self-excitation-proof heartbeat suppression + bounded renewal tied to service lifecycle);
 * - dual-track keepalive cleanup (workflowRunId -> workflow.settled event; single turn -> parent turn_settled);
 * - startup reconciliation reclaims helm-wf-* orphan panes (only confirmed own resources; failed keeps the diagnostic scene;
 *   panes genuinely still working/blocked are kept and reported, never faked as finished; keepalive orphans are reclaimable;
 *   exact agent.name === recorded-ownership verification; mismatched identity gives up ownership);
 * - ctx.action list/read/focus (HTTP/CLI equal footing with --json; read redacts to the last 40 lines;
 *   focus is an explicit user action; read/focus support nodeId disambiguation, ambiguity returns explicit 409).
 *
 * Lazy-loading discipline:
 * - Heavy runtime submodules (executor, transport, asks, metadata, overview, probes, rpc, spawn-rules)
 *   live in ./herdr/runtime-bootstrap.ts and are imported on demand only when the plugin is enabled
 *   (service prepare/start). Disabled registration never evaluates heavy runtime code.
 */

import { HelmError, type PluginDefinition } from '@helm/protocol'
import { resolvePluginClientAssets, type PluginClientAssets } from './asset-paths.js'
import { registerHerdrActions } from './herdr/actions.js'
import type { HerdrPluginDependencies } from './herdr/contracts.js'
import type { OverviewDoc } from './herdr/overview.js'
import type { ManagedDoc } from './herdr/panes.js'
import type { HerdrRuntimeController, HerdrRuntimeModule } from './herdr/runtime-bootstrap.js'

/** client / dist-client asset resolution converges to the shared asset path (src / dist dual tracks; missing is an explicit error, never silently degraded). */
function resolveHerdrClientAssets(): PluginClientAssets {
  return resolvePluginClientAssets('builtin:herdr', 'herdr', 'herdr_plugin_client_missing')
}

/** The 23 Herdr CLI agent.start kinds (full detect::agent_label set); candidates for ProfileRuntimeUiSpec. */
const HERDR_AGENT_SUGGESTIONS: ReadonlyArray<string> = [
  'pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline',
  'omp', 'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid',
  'amp', 'grok', 'hermes', 'kilo', 'qodercli', 'qwen', 'maki', 'muse',
]

let runtimeModulePromise: Promise<HerdrRuntimeModule> | undefined

function loadHerdrRuntimeModule(): Promise<HerdrRuntimeModule> {
  runtimeModulePromise ??= import('./herdr/runtime-bootstrap.js').catch((err) => {
    runtimeModulePromise = undefined
    throw err
  })
  return runtimeModulePromise
}

export function createHerdrPlugin(
  timingOverrides?: Pick<
    HerdrPluginDependencies,
    | 'pollIntervalMs'
    | 'blockedBackoffBaseMs'
    | 'blockedBackoffCapMs'
    | 'askPollTransientBackoffBaseMs'
    | 'askPollTransientBackoffCapMs'
    | 'abortCancelBackoffCapMs'
    | 'mdStableRecheckMs'
    | 'subscriptionRetryBaseMs'
    | 'subscriptionRetryCapMs'
    | 'steerWaitBudgetMs'
  >,
): PluginDefinition {
  return {
    id: 'builtin:herdr',
    name: { en: 'Herdr Terminals', 'zh-CN': 'Herdr 终端' },
    description: {
      en: 'Cross-node Herdr coordination: drives remote CLI tool execution, terminal approval bridging (AskDoc CAS), and status-bar projection.',
      'zh-CN': '跨节点 Herdr 协同：驱动远端 CLI 工具执行、终端审批桥（AskDoc CAS）与状态栏投影。',
    },
    icon: 'terminal',
    version: '0.1.0',
    ...resolveHerdrClientAssets(),
    definePlugin(ctx) {
      let runtime: HerdrRuntimeController | undefined
      let runtimePromise: Promise<HerdrRuntimeController> | undefined

      async function ensureRuntime(): Promise<HerdrRuntimeController> {
        if (runtime !== undefined) return runtime
        runtimePromise ??= loadHerdrRuntimeModule()
          .then((mod) => {
            runtime = mod.createHerdrRuntime({
              ctx,
              managedDoc,
              overviewDoc,
              ...(timingOverrides !== undefined ? { timingOverrides } : {}),
            })
            return runtime
          })
          .catch((err) => {
            runtimePromise = undefined
            throw err
          })
        return runtimePromise
      }

      // ---- Docs and UI ----
      const managedDoc = ctx.doc<ManagedDoc>('managed', { version: 1, panes: [] })
      const overviewDoc = ctx.doc<OverviewDoc>(
        'overview',
        { version: 2, updatedAt: 0, stale: true, panes: [], asks: [] },
        { public: true },
      )

      ctx.ui.sidebarItem({
        id: 'herdr',
        label: { en: 'Herdr Terminals', 'zh-CN': 'Herdr 终端' },
        icon: 'terminal',
        target: 'screen:builtin:herdr/overview',
        order: 40,
      })
      ctx.ui.screen({
        id: 'overview',
        label: { en: 'Herdr Terminals Overview', 'zh-CN': 'Herdr 终端总览' },
        icon: 'terminal',
        client: { module: 'index.tsx', export: 'HerdrOverviewScreen' },
      })
      ctx.ui.profileRuntime({
        id: 'herdr',
        kind: 'herdr',
        label: { en: 'External Herdr Runtime', 'zh-CN': '外部 Herdr 运行时' },
        icon: 'terminal',
        description: {
          en: '(optional) bind to a Herdr CLI when used as a subagent',
          'zh-CN': '（可选）作为子代理使用时绑定 Herdr CLI',
        },
        agentSuggestions: [...HERDR_AGENT_SUGGESTIONS],
      })

      // ---- hooks ----
      ctx.hook.onAgentSpawn(async (request) => {
        if (runtime === undefined) return { action: 'continue' }
        return runtime.onAgentSpawn(request)
      }, { priority: 100 })

      ctx.hook.onTurnSettled(async (payload) => {
        await runtime?.onTurnSettled(payload)
      })

      // diagnostics.collect listener (rerouted from the old watchdog_tick priority-100 hook):
      // Registered synchronously in definePlugin; delegates to runtime probes once prepared/started.
      ctx.host.onEvent('diagnostics.collect', async (raw) => {
        await runtime?.collectDiagnostics(raw)
      })

      // ---- actions (list/read/focus/steer registration and pane disambiguation in herdr/actions.ts) ----
      registerHerdrActions(ctx, {
        registry: () => runtime?.getRegistry(),
        executor: () => runtime?.getExecutor(),
        transport: () => {
          if (runtime === undefined) {
            throw new HelmError('herdr_not_connected', 'The Herdr service is not started (target server not connected)', 409)
          }
          return runtime.getTransport()
        },
        redact: (text) => ctx.host.redact(text),
        parentOfConversation: (id) => {
          try {
            return ctx.host.getConversation(id).parentConversationId
          } catch (error) {
            if (error instanceof HelmError && error.code === 'not_found') return undefined
            throw error
          }
        },
      })

      // ---- config schema (configurable before enable; changes take effect on next enable) ----
      ctx.configSchema({
        session: {
          type: 'string',
          label: { en: 'Herdr session name', 'zh-CN': 'Herdr 会话名' },
          description: {
            en: 'Local herdr sessions/<name> subdirectory',
            'zh-CN': '本地 herdr sessions/<name> 子目录',
          },
          default: '',
        },
        socketPath: {
          type: 'string',
          label: { en: 'Socket path override', 'zh-CN': 'Socket 路径覆盖' },
          description: {
            en: 'Defaults to HERDR_SOCKET_PATH or the default session path',
            'zh-CN': '缺省取 HERDR_SOCKET_PATH 或默认会话路径',
          },
          default: '',
        },
        startupTimeoutMs: {
          type: 'number',
          label: { en: 'Agent startup timeout (ms)', 'zh-CN': 'Agent 启动超时（毫秒）' },
          description: { en: '3001..300000, default 30000', 'zh-CN': '3001..300000，默认 30000' },
          default: 30000,
        },
      })

      // ---- service：prepare 本地就位，start 连接（ack 先于对账），stop 按 isClosing 分流 ----
      ctx.service({
        id: 'herdr-connection',
        liveTasks() {
          return runtime ? runtime.liveTasks() : []
        },
        async prepare() {
          const rt = await ensureRuntime()
          rt.prepareLocalRuntime()
        },
        async start() {
          const rt = await ensureRuntime()
          await rt.start()
        },
        async stop() {
          if (runtime === undefined && runtimePromise !== undefined) {
            await runtimePromise.catch(() => undefined)
          }
          await runtime?.stop(true)
        },
      })
    },
  }
}

export type { OverviewDoc } from './herdr/overview.js'
