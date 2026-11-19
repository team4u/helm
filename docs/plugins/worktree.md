# 受管工作树插件

`builtin:worktree` 默认启用。子代理需要独立改代码时，请求 `isolation: 'worktree'`，本插件在 `agent_spawn` 管道上分配隔离树、登记租约，结束后安全清理。上层编排（Workflow 的 `subagent`、Swarm 的派工）对此透明，两个插件之间零静态依赖。 [Worktree 生命周期与清理规则](../workflows/worktree-and-gate.md)

## 分配与持有

- **分配**：`agent_spawn` around 钩子（priority 200）包裹整个派生。原生派生先在目标节点从主仓切出 `helmx/spawn-*` 分支再改写 `cwd`；外部运行时（如 `builtin:herdr`）自行创建，插件只在其回传时统一登记。目录建在主仓同级 `.helmx-worktrees/` 下，不嵌套。
- **租约**：`git worktree add` 执行前先持久登记占位。进程崩溃后无法证明执行已停止时，清理显式拒绝（`worktree_execution_unknown`），交人工确认。
- **持有锁（hold）**：跨插件长占用（如 Swarm 协作期）通过 `acquire_worktree` / `release_worktree_hold` 两个内部动作加 `ManagedWorktreeHold` 持久保护。这两个动作不进模型 `<available_actions>` 目录，仅供插件间互调。
- **执行描述**：派生结果把 worktree 描述写入 execution meta 的 `builtin:worktree` 命名空间，与 `builtin:workflow` 的 `controls` 正交，编排脚本可据此续接、合入或清理。

## 工具与动作

- **`cleanup_worktree` 工具**：清理受管隔离 Git Worktree。子代理可在任务收尾时自行清理；错误分支绝不伪造 metadata。

| 动作 | CLI | 说明 |
| :--- | :--- | :--- |
| `cleanup_worktree` | `helmx worktrees cleanup` | 清理（选择器 `--worktree-id` / `--conversation-id` / `--path [--node-id]` 三选一互斥，`--delete-branch` / `--merged-into` / `--force`） |
| `list_worktrees` | `helmx worktrees list` | 全部登记（含已清理记录的元数据） |
| `inspect_worktree` | `helmx worktrees inspect <worktreeId>` | 只读检视：登记元数据 + 目标节点真实 git 只读探测（状态/统计/有上限 diff 预览） |

`cleanup_worktree` 动作对会话目标有显式冲突校验：输入 `conversationId` 与调用上下文同时存在且不一致时显式 `400 validation_error`。无任何显式选择器时以当前会话为选择器。

## 停用语义

- 停用后 `cleanup_worktree` 工具与 `worktrees` CLI 即时消失，不留幻影提示词。
- 仍有活跃 `ManagedWorktreeHold` 时停用被拒（`409 plugin_in_use`）；`--force` 可越过，磁盘登记保留。
- 停用期间工作树登记与租约不清除，重新启用后 cleanup 仍可定位。此时请求 `isolation: 'worktree'` 在内核边界显式失败（`unsupported_runtime`），不静默降级；非隔离的 `subagent` 派生不受影响。

## 数据与恢复

登记表、租约表与 agentId 绑定存于私有文档（完整键 `builtin:worktree:worktree-state`），停用期间不清除。会话删除时裁剪对应绑定与已移除记录，活跃记录与租约保留。Hub 重启后在 `runtime.started` 阶段回收可证明已停止的原生崩溃租约——组合根把本插件注册在 `builtin:workflow` 之后，确保遗留子会话先收敛空闲，再扫描租约，避免误判在途执行。外部运行时租约无法证明停止，保持 fail-closed 保留。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口（组装与文档声明） | `packages/plugins/src/worktree.ts` |
| 隔离 / 分配 / 清理 / 检视 / 动作 / 工具 | `packages/plugins/src/worktree/`（`isolation*.ts`、`worktree*.ts`、`actions.ts`、`tools.ts`） |
| 共享契约（meta 命名空间与执行描述） | `packages/plugins/src/contracts.ts` |
| 主要测试 | `packages/plugins/test/native-worktree.test.ts`、`worktree-process-usage.test.ts`、`contracts.test.ts`、`packages/hub/test/worktree-inspect.integration.test.ts`、`worktree-runtime.integration.test.ts` |

## 相关文档

- [Git Worktree 与代码门禁](../workflows/worktree-and-gate.md)：分配时序、durable 租约、六道清理安全检查与进程占用探测
- [工作流与子代理编排](workflow.md)：`isolation: 'worktree'` 的请求方与 `gate` 验收
- [Swarm 对等协同](swarm.md)：跨插件持有锁的主要使用方
- [CLI 命令参考](../cli/reference.md)：`helmx worktrees` 命令族
