# Swarm 对等协同看板插件

`builtin:swarm` 面向「多角色横向对等审改与序号黑板交接」场景（如 `Author <-> Verifier` 多轮交叉审改、多角色无重叠分片攻坚），与纵向确定性脚本编排（`builtin:workflow`）和常驻值守中枢（`builtin:superagent`）保持单一职责正交解耦：

- **零全局常驻会话、零后台轮询定时器**：插件启动时不创建任何全局会话，不挂载轮询看门狗；所有协作组均在目标顶层会话按需开启（谁派生、谁负责），异常自愈与静默归因 100% 由 `turn_settled` 事件驱动。
- **100% 复用 `builtin:workflow` 受管 Worktree**：组内成员物理隔离分配（`acquire_worktree`）、跨回合持久持有锁（`ManagedWorktreeHold`）、只读变更快照（`inspect_worktree`）、释放锁（`release_worktree_hold`）与清理（`cleanup_worktree`）经 `ctx.host.invokeAction` 复用 `builtin:workflow`；插件自身不声明静态 `dependencies: ['builtin:workflow']`，空闲时不阻塞停用 `builtin:workflow`，持锁工作树则由 `ManagedWorktreeHold` 自动提供 `409 plugin_in_use` 与 `409 worktree_in_use` 保护。

## 当前状态与自举资产

默认启用，随 Hub 启动加载。启用时幂等自举受管技能 `swarm-collab`（`managedByPlugin: 'builtin:swarm'`，停用插件后即时消失，不留幻影提示词），沉淀四条实战协同准则：

1. **主控零编码铁律**：主控只做任务切分、具名派工、冲突裁决与最终合入收尾，不直接改业务代码或跑长时构建阻塞看板调度；
2. **无重叠切分 + 审改分离**：并行改代码成员分配 `isolation: 'worktree'`；读写 Author 配备 `access: 'readonly'` 的 Verifier 交叉跑测并打回 `review`；
3. **`#seq` 指针零搬运**：跨成员交接统一通过 `refs: [seq]` 与正文 `#seq` 引用黑板记录，禁止复制粘贴其他成员的 Diff 或长篇日志；
4. **`wake` 门铃与解锁合入纪律**：`wake: true` 是唤醒门铃而非抄送，对等流水线仅唤醒下一跳责任人，仅遇阻塞（`blocker`）或最终交付（`done`）时唤醒 `coordinator`；全员审过且存在待合入分支时调用 `swarm_close_group({ keepWorktree: true })`（动作 ID `close_group`）解锁主控合入收尾。

## 能力和入口

### 四层单真源存储与投影去重

- **组权威账本与黑板日志**：`<dataDir>/groups/<groupId>/{meta.json, board.jsonl}`，`meta.json` 经 `atomicWriteFile` 原子替换，`board.jsonl` 按组串行队列与 `withFileLock` 脱敏追加单行 JSON，不受全局 `ctx.doc` 2 MiB 上限约束。
- **全局轻量路由索引**：公开 `ctx.doc('index')`，仅存活跃成员反查指针（`{ conversationId, coordinatorConversationId, profileId, groupId, name, createdAt }`）与 `CollabGroupSummary[]`。
- **会话级实时看板投影**：公开 `ctx.sessionDoc('board-view')`，按 `coordinatorConversationId` 键控并以 `(headSeq, memberStateDigest)` 指纹去重，合成一句话态势 `headline`、成员实时状态、聚合有向边 `edges` 及最近 `boardPreviewLimit` 条流转记录。
- **顶栏双向角标**：公开 `ctx.doc('board-badges')`，为主控会话与全体组内活跃成员提供 O(1) 数量与异常告警角标。

### 互斥工具集、零破 KV Cache 与写门控

- **作用域标签**：`swarm-coordinator`（主控）、`swarm-worker`（活跃组员）、`swarm-worker-archived`（已归档组员）。
- **同回合无缝切换**：未建组普通会话隐藏黑板工具，仅暴露 `swarm_create_group` 与常规 `subagent / SubagentWorkflow`；调用 `swarm_create_group`（或 Web/CLI `create_group` 动作）挂载 `swarm-coordinator` 标签后，下一拍 LLM 请求立即解锁主控工具（`swarm_*`），并在 `coordinatorGuard: true` 时剥离并拦截 `edit / write / bash / subagent / SubagentWorkflow`。
- **只读成员门控**：`access: 'readonly'` 成员剥离并拦截 `write / edit / cleanup_worktree`，保留 `bash` 供测试验收。
- **恒定 `turn.sections` 保 Cache**：`before_turn` 注入的 `<active_swarm_group>` 仅含不可变 `groupId` 与静态协作铁律，不含可变成员名册或实时状态，中途扩缩容 0 次重写首条系统消息。

### Fail-Closed 寻址、双向批合并与纯事件自愈

- **`board_post.to` 严格解析**：支持 `'coordinator'`、`'all'`（仅主控或人工可用，成员调用返 `403`）、`'#<channel>'`（`#main` 返 `400`，未知或已归档频道返 `404 / 409`）与精确活跃成员名（未知或已归档返 `404`），自动剔除发帖者防自回声；`wake` 与 `to` 正交分离（`comment` 缺省 `false`，其余缺省 `true`）。
- **双向游标批合并**：Worker 侧将 `(readCursorSeq, pendingWakeupSeq]` 合并为单封 `swarm:board-wakeup`，经 `submitInputGuarded(..., { expectedOwnership: 'helm', whenBusy: 'followUp' })` 投递；主控侧经 `50ms` 微批与忙时合并投递单封 `swarm:board-report`（携带协作组 `objective`、`activeWorkingMembers` 与反回声守则）。
- **`turn_settled` 纯事件自愈**：
  1. **失败即上板**：成员回合 `outcome === 'failed'` 时自动追加 `system -> coordinator` 的 `kind: 'blocker'`（含脱敏错误与模型名）并排队汇报主控；
  2. **防哑巴退场单次续催**：成员因 `brief / handoff / review` 唤醒后零发帖完成回合，触发最多 1 次确定性续催（`silentExitNudgeSeq`）；二次仍沉默则摘取末条回复脱敏摘要代发 `kind: 'blocker'` 上板，绝不死循环；
  3. **6 条件 0-Token 静默守卫**：全组静默且未结单时纯代码归因（未唤醒悬空产出 `#seq`、已读未回帖 `@name`、全员空闲未交付 `done`）写入 `kind: 'stall'`。

### 动作与工具（五端复用）

`ctx.action` 动作 ID 与 CLI（`helm swarm <cmd>`）使用插件命名空间短名；面向模型的 11 个 `ctx.tool` 统一带 `swarm_` 前缀，确保与 `builtin:superagent`（`dispatch_worker / inspect_worker / archive_worker`）或外部插件同时启用时满足全局工具名唯一性（零 `duplicate_tool_name`）：

| 动作 ID (`ctx.action`) | 模型工具名 (`ctx.tool`) | CLI 命令 | 作用域与核心说明 |
| :--- | :--- | :--- | :--- |
| `create_group` | `swarm_create_group` | `helm swarm create-group` | 在顶层会话创建活跃协作组（同会话限 1 个活跃组），挂载 `swarm-coordinator` 标签 |
| `update_group` | `swarm_update_group` | `helm swarm update-group` | 主控独享：修改组 `title / objective` 或切换 `coordinatorGuard` |
| `manage_channel` | 仅 `ctx.action` | `helm swarm channel` | 主控独享动作：子频道 `create / subscribe / unsubscribe / archive`（`main` 禁归档/退订） |
| `dispatch_worker` | `swarm_dispatch_worker` | `helm swarm dispatch-worker` | 主控独享：招募具名对等成员（支持 `profileId`、`access`、`isolation: 'worktree'` 持锁、`forkFrom` 干净锚点分叉、`forkEntryId`、`model`、`effort`、`channels`），写入首条 `brief` 并唤醒 |
| `board_post` | `swarm_board_post` | `helm swarm board-post` | 主控/成员/人工向黑板发帖（结构化 `to` + 正交 `wake`；绑有工作树且发 `handoff / done` 时自动内联 `worktreeSnapshot`） |
| `board_read` / `board_status` | `swarm_board_read` / `swarm_board_status` | `helm swarm board-read` / `board-status` | 幂等分页读取黑板记录 / 读取完整 `BoardViewDoc` 态势快照（覆盖 `active`、`closed` 与 `coordinatorDetached` 组） |
| `abort_worker` | `swarm_abort_worker` | `helm swarm abort-worker` | 主控独享：经 `abortConversationGuarded` 原地刹停成员当前回合，保留上下文与 Worktree 锁 |
| `switch_worker_model` | `swarm_switch_worker_model` | `helm swarm switch-model` | 主控独享：对空闲成员调用 `updateConversation` 原地切换模型续跑 |
| `inspect_worker` / `archive_worker` | `swarm_inspect_worker` / `swarm_archive_worker` | `helm swarm inspect-worker` / `archive-worker` | 幂等读取成员最近时间线摘要、产物与绑定 `worktreeId` / 校验工作树干净后释放锁并归档成员 |
| `close_group` | `swarm_close_group` | `helm swarm close-group` | 主控独享：两态结单（默认要求工作树干净并全清，未合入返 `409 swarm_worktree_unmerged`；`keepWorktree: true` 释放锁、保留待合入分支写入 `retainedWorktrees`，并摘除 `swarm-coordinator` 标签解锁主控合入） |
| `complete_board_members` / `complete_board_channels` | 仅 `ctx.action` | 隐藏内部动作 | 幂等补全源：为组内会话输入框提供 `@` 活跃成员与 `#` 活跃子频道候选 |

### Web 协同流转看板（`#/views/builtin:swarm/board`）

- **对话 `/swarm` 入口与双向顶栏**：通过 `ctx.ui.command` 注册 `slash: 'swarm', insert: '/swarm '`（不设 `scope`，待命新对话与顶层人类会话输入 `/` 均可补全回填，体验与 `/skill:` 一致）；发送 `/swarm <任务>` 后由 `onInput` 钩子自动在当前顶层会话建组（`coordinatorGuard: true`）、挂载 `swarm-coordinator` 标签并展开主控协同引导。活跃协同会话（主控与组内成员）在顶栏工具栏渲染双向定位「协同看板」角标按钮（不占用 `COMPOSER_DOCK_SLOT`，与 `WorkflowActiveTray` 零冲突）；看板空态仅展示 `/swarm <任务>` 只读提示，移除侧边栏入口与弹窗表单；时间线将 `swarm:board-report` 与 `swarm:board-wakeup` 收敛为单行回执胶囊（点击 `#seq` 分屏定位流转卡）。
- **自适应主舞台与 `540px` 成员抽屉**：宽屏全屏渲染正交 SVG 角色协同拓扑图，分屏或窄屏（`<= 680px`）自动收敛为紧凑横排角色胶囊条；异常态挂载 `<Callout>` 一键唤醒/切模/解锁合入急救按钮；底部提供 `<MultiSelect>` 目标选择、正交 `wake` 开关与 `15px` 输入栏；点击成员滑出右侧 `540px` 详情抽屉（支持 `abort_worker`、空闲模型 `<Select>`、跨插件调用 `builtin:workflow` `inspect_worktree` 快照与一键向主控提交合入请求、打开子会话抽屉与归档）。历史 `closed` 或 `coordinatorDetached` 组自动退避 `board_status + board_read` 无白屏展示。

## 配置与数据边界

| 配置 | 类型 | 缺省 | 说明 |
| :--- | :--- | :--- | :--- |
| `maxWorkersPerGroup` | number | `12` | 单个协作组同时处于活跃态的对等成员上限（整数 `2..32`） |
| `boardPreviewLimit` | number | `80` | `sessionDoc('board-view')` 保留的最近流转消息条数上限（整数 `20..200`） |

公开文档：`index`、`board-badges`；公开会话文档：`board-view`。文件存储：`<dataDir>/groups/<groupId>/{meta.json, board.jsonl}`。

## 停用与失败语义

服务启动阶段幂等补发重启前挂起的未送达唤醒/汇总信封。停用遇在途任务或微批投递经 `liveTasks` 硬阻断（`409 plugin_has_live_tasks`）；存在活跃协作组时经 `inUse` 返回 `409 plugin_in_use`。任意时刻可执行 `helm swarm close-group --group-id <id> --abort-running --keep-worktree` 刹停成员、保留代码分支并解锁主控会话。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口与 UI 注册 | `packages/plugins/src/swarm.ts`、`packages/plugins/src/swarm/ui.ts` |
| 单真源黑板存储 / 寻址 / 静默归因 / 动作 / 钩子 | `packages/plugins/src/swarm/`（`contracts.ts`、`action-schemas.ts`、`worktree-bridge.ts`、`group-store.ts`、`board-router.ts`、`board-stall.ts`、`settlement.ts`、`actions.ts`、`hooks.ts`、`assets.ts`、`assets/`） |
| Web 客户端组件与纯模型 | `packages/plugins/src/swarm/client/`（`index.tsx`、`BoardScreen.tsx`、`BoardTopology.tsx`、`MemberDrawer.tsx`、`HeaderBoardAction.tsx`、`board-model.ts`、`models.ts`、`copy.ts`、`styles.css`） |
| 测试 | `packages/plugins/test/swarm.test.ts`、`packages/plugins/test/swarm.integration.test.ts`、`packages/web/test/swarm-client-interactions.test.tsx` |

## 相关文档

- [工作流与子代理编排](workflow.md)：受管工作树 `ManagedWorktreeHold`、`acquire_worktree / release_worktree_hold` 与 `inspect_worktree`
- [SuperAgent 双层中枢](superagent.md)：常驻自治路由、RecallGraph 与两层定时看门狗
- [Web 前端设计系统](../conventions/web-frontend.md) · [Web 导航与 URL Hash 约定](../conventions/web-navigation.md)
