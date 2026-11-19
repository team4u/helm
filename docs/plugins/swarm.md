# Swarm 插件

Swarm 在会话里提供一个共享看板。主控会话负责分工，成员把进度、问题和审查意见发给需要处理的人。协作组按需创建，插件启动时不会创建常驻会话。第一次使用可以从一次代码交接开始。 [Swarm 实战](../getting-started/orchestration-guide.md)

## 建组和派工

`builtin:swarm` 默认启用。给顶层人类会话发送 `/skill:swarm` 或 `/skill:swarm <任务>`，会在当前回合建立或复用一个活跃组。也可以让助理调用 `swarm_create_group`。人工从 CLI 建组时，传入目标会话 ID。把示例里的 `42` 换成你的会话 ID。

```bash
helmx swarm create-group --conversation-id 42 --title '检查导出模块' --json
```

主控分配具体任务，协调接口和分支合入。成员可单独指定 Profile、模型、思考档位和频道。并发写代码的成员应各有独立的 Git worktree。Swarm 通过 `builtin:worktree` 分配工作树，并在协作期间持有租约，避免被清理。`readonly` 是任务约定，成员仍保有原来的工具权限。 [Git Worktree 的隔离范围](../workflows/worktree-and-gate.md)

## 看板消息

`board_post` 的 `to` 决定谁收到消息。可以填 `coordinator`、成员名或 `#频道名`。只有主控和人工调用可以用 `all`。`main` 是默认频道，`#main` 不作收件地址。找不到或已归档的收件人会使操作失败。

每条消息都有 `seq`。在回复里可以用 `refs: [12]` 和正文里的 `#12` 引用前一条意见。带 worktree 的成员发 `handoff` 或 `done` 时，看板会附上 `worktreeSnapshot`，包含分支、领先提交数和改动文件预览，供接手的人查对应工作树。

`wake` 决定是否让收件人继续跑一个回合。`comment` 默认只留记录，其他类型默认唤醒。交给审查人时通常需要唤醒，给主控补一条进度说明时可以只留记录。成员多条待处理消息会合成一个唤醒请求，主控收到的汇报也会合并。

## 在会话里跟进

- 时间线显示派工、交接和审查。点成员相关的记录可打开成员会话。
- 主控会话里还有「进行中」区域，有成员正在执行或受阻时才显示。展开后可以查看成员或中止当前回合。
- 右侧「Swarm 协同编组」面板显示任务目标、成员状态、分支和最近的看板消息。「查看完整记录」会加载更多消息。结单后仍可在工作台回看。
- 输入框支持 `@成员` 和 `#频道` 补全。切换成员模型需要等它空闲。中止当前回合会保留成员会话与工作树租约。

## 结单和清理

默认结单会先确认成员已停止，再检查工作树。发现未提交改动或未合入提交时，返回 `swarm_worktree_unmerged`。用 `keepWorktree: true` 结单会释放租约，保留有改动或尚未合入的工作树，并在 `retainedWorktrees` 里列出路径和分支。通过清理检查的其他工作树仍会被清理。结单后可以在同一会话开始新组。

需要停止整个协作组时，用 `--abort-running` 中止在跑的成员。把环境变量 `group_id` 设为建组命令返回的 `groupId`。

```bash
helmx swarm close-group --group-id "$group_id" --abort-running --keep-worktree
```

## 动作和命令

| 动作 ID | 模型工具 | CLI | 用途 |
| --- | --- | --- | --- |
| `create_group` | `swarm_create_group` | `helmx swarm create-group` | 在顶层会话建立协作组 |
| `update_group` | `swarm_update_group` | `helmx swarm update-group` | 改标题或目标 |
| `manage_channel` | 经 `run_action` | `helmx swarm channel` | 创建、订阅、退订或归档子频道。`main` 不可退订或归档 |
| `dispatch_worker` | `swarm_dispatch_worker` | `helmx swarm dispatch-worker` | 派工并唤醒成员。可选 worktree、会话分叉和模型 |
| `board_post` | `swarm_board_post` | `helmx swarm board-post` | 发消息，指定收件人和是否唤醒 |
| `board_read` | `swarm_board_read` | `helmx swarm board-read` | 分页读消息 |
| `board_status` | `swarm_board_status` | `helmx swarm board-status` | 查组和成员状态，包括历史编组 |
| `abort_worker` | `swarm_abort_worker` | `helmx swarm abort-worker` | 中止成员当前回合 |
| `switch_worker_model` | `swarm_switch_worker_model` | `helmx swarm switch-model` | 为闲置成员更换模型 |
| `inspect_worker` | `swarm_inspect_worker` | `helmx swarm inspect-worker` | 查成员的近期记录、产物和工作树 |
| `archive_worker` | `swarm_archive_worker` | `helmx swarm archive-worker` | 归档成员并处理工作树租约 |
| `close_group` | `swarm_close_group` | `helmx swarm close-group` | 结单、清理或保留工作树 |

`complete_board_members` 和 `complete_board_channels` 给输入框提供候选。模型可用的工具取决于当前会话的组内身份。成员侧用 `swarm_board_read` 和 `swarm_board_post` 交接，派工、换模型和结单由主控处理。 [CLI 参数参考](../cli/reference.md)

## 失败和恢复

成员回合失败后，插件把脱敏错误写成 `blocker` 并报给主控。收到派工、交接或审查后完成回合却没发帖的成员，最多收到一次补发提醒。再没有回应时，插件会记录受阻情况。全组符合空闲条件却没有交付时，`stall` 记录会给出已知线索，例如某条交接没有唤醒收件人。检查由回合结束事件触发。

协作组保存于 `<dataDir>/groups/<groupId>/`。`board.jsonl` 先追加并同步写盘，再以 `meta.json` 的 `headSeq` 提交。重启会截掉单条未提交尾记录，已提交记录损坏会报 `swarm_doc_corrupt`。启动时会核对会话标签、归属和遗留的工作树租约，再根据已有提交记录补送需要恢复的唤醒和汇报。建组、派工与发帖按会话和工具调用 ID 去重。

停用插件时，在途任务会触发 `plugin_has_live_tasks`。仍有活跃协作组时会触发 `plugin_in_use`。持有受管 worktree 的组员同时占用 [`builtin:worktree`](worktree.md) 插件的工作树资源。

## 配置与实现

| 配置 | 默认 | 范围 |
| --- | --- | --- |
| `maxWorkersPerGroup` | `12` | 每组同时活跃的成员数，`2..32` |
| `boardPreviewLimit` | `80` | 看板投影内近期消息数，`20..200` |

全局 `index` 和 `board-badges` 提供成员索引和界面计数。看板明细通过按主控会话分片的 `board-view` 提供，前端在查看编组时订阅。主控和成员通过 `swarm-coordinator`、`swarm-worker` 及各自的 `-archived` 标签区分。回合提示只包含稳定的组或成员信息，实时状态按需从看板读。

[插件入口](../../packages/plugins/src/swarm.ts) · [Swarm 实现](../../packages/plugins/src/swarm/) · [插件集成测试](../../packages/plugins/test/swarm.integration.test.ts) · [界面测试](../../packages/web/test/swarm-client-interactions.test.tsx)
