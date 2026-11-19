/**
 * builtin:worktree: the managed Git worktree plugin (13th built-in, default-enabled).
 *
 * Responsibilities (split out of builtin:workflow; the two stay zero-static-dependency
 * on each other and communicate only through the shared contracts module and the
 * execution-meta 'builtin:worktree' namespace):
 * - WorktreeAllocator / WorktreeStore / durable leases / ManagedWorktreeHold（跨回合
 *   持有锁）/ agentId 绑定 —— the full managed-worktree persistence layer;
 * - agent_spawn around hook（priority 200，continuation 包装整个派生）: allocation /
 *   resume / reattach / external-runtime registration; still after builtin:workflow's
 *   depth guard (300) and before external-runtime takers like builtin:herdr (100);
 * - the cleanup_worktree model tool and the worktrees CLI action family
 *   (cleanup / list / inspect) plus the internal hidden acquire/release actions;
 * - lifecycle: service 'worktree' flushes the private doc on stop and reports active
 *   holds via inUse()（409 plugin_in_use 保护）. Registration-order invariant: the
 *   composition root registers builtin:workflow BEFORE this plugin so that the
 *   runtime.started listeners run in that order（KernelRuntime awaits each listener）:
 *   workflow first converges leftover child conversations to idle, only then does
 *   this plugin reconcile crashed native leases（otherwise still-settling children
 *   would be misjudged as stopped and their leases wrongly reclaimed）.
 *
 * Disabling this plugin makes cleanup_worktree / worktrees CLI disappear immediately
 * （no phantom tools）; a spawn still requesting isolation: 'worktree' then fails
 * explicitly with unsupported_runtime at the kernel boundary（never silently degraded）.
 */
import type { PluginDefinition } from '@helmx/protocol'
import { WORKTREE_PLUGIN_ID } from './contracts.js'
import { WorktreeIsolation } from './worktree/isolation.js'
import { registerWorktreeActions } from './worktree/actions.js'
import { registerWorktreeTools } from './worktree/tools.js'

export { WORKTREE_PLUGIN_ID }

export function createWorktreePlugin(): PluginDefinition {
  return {
    id: WORKTREE_PLUGIN_ID,
    name: { en: 'Managed Worktrees', 'zh-CN': '受管工作树' },
    description: {
      en: 'Managed Git worktrees for isolated agent workspaces: allocation, durable leases and holds, read-only inspection, the cleanup_worktree tool and the worktrees CLI.',
      'zh-CN': '受管 Git 工作树：隔离工作区分配、持久租约与持有锁、只读检视、cleanup_worktree 工具与 worktrees CLI。',
    },
    icon: 'git-branch',
    version: '0.1.0',
    definePlugin(ctx) {
      // ---- Worktree isolation asset doc (managed registry + durable leases; kept on disable for re-reading) ----
      // Private doc (full key `builtin:worktree:worktree-state`): the allocator registry + lease table + agentId
      // binding table. Not cleared while the plugin is disabled; after re-enable, cleanup can still locate
      // them (no metadata loss).
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

      // ---- Worktree isolation lifecycle (this plugin's own Git capability) ----
      // The agent_spawn around (continuation) wrapper wraps the whole derivation: allocation/resume/occupancy/lease;
      // priority 200 (running after builtin:workflow's depth guard 300 and before external-runtime takers like
      // herdr's 100 = the outer layer), ensuring external executions are also wrapped by leases and registration;
      // Git commands run via ctx.host.execEnv (direct argv) on the real final node.
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

      // ---- agent_spawn around（continuation）：worktree 隔离完整生命周期 ----
      // priority 200：先于外部运行时接管器（如 herdr 的 100）执行 = 更外层，
      // 外部执行同样被租约与登记包裹；不调 next 的接管器（handled）不受影响。
      ctx.hook.onAgentSpawn(async (request, next) => {
        await isolation.aroundSpawn(request, next)
      }, { priority: 200 })

      // ---- 会话删除：裁剪绑定与已 removed 记录（保留 active 记录与租约） ----
      ctx.host.onEvent('conversation.deleted', (raw) => {
        const record = raw === null || typeof raw !== 'object' ? undefined : (raw as Record<string, unknown>)
        const candidate = record?.['conversationId'] ?? record?.['id']
        if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 1) {
          isolation.pruneConversation(candidate)
        }
      })

      // ---- 启动后回收可证明已无执行的原生 Worktree 崩溃租约 ----
      // Why注册顺序约束：组合根必须先注册 builtin:workflow 再注册本插件——
      // KernelRuntime.start() 按监听器注册顺序逐个 await；workflow 的监听器
      // 先等恢复收集的遗留子会话收敛 idle，本插件随后才扫崩溃租约（否则会把
      // 仍在收敛的子会话误判为已停止而漏回收/误回收）。
      ctx.host.onEvent('runtime.started', async () => {
        await isolation.reconcileStoppedNativeLeases()
      })

      // ---- service：受管工作树生命周期（flush 持久层；活跃 hold 阻止停用） ----
      ctx.service({
        id: 'worktree',
        start() {},
        async stop() {
          await worktreeDocs.flush()
        },
        inUse() {
          return isolation.allocator
            .list()
            .filter((r) => r.status === 'active' && r.hold !== undefined)
            .map((r) => ({
              kind: 'worktree_hold',
              id: r.id,
              label: `worktree "${ctx.host.redact(r.path)}" held by ${r.hold!.pluginId} (${ctx.host.redact(r.hold!.label)})`,
            }))
        },
      })

      // ---- Model tool: cleanup_worktree ----
      registerWorktreeTools(ctx, { isolation })

      // ---- Actions (reused across five ends: HTTP / CLI / run_action / Workflow / Web UI) ----
      registerWorktreeActions(ctx, { isolation })
    },
  }
}
