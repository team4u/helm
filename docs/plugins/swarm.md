# Swarm 对等协同插件

`builtin:swarm` 面向「按任务动态拆解角色的多智能体横向对等交接与序号黑板协同」场景（支持根据任务规模动态招募读写成员、并按需搭配只读 Verifier 交叉审改验收），与纵向确定性脚本编排（`builtin:workflow`）和常驻值守中枢（`builtin:superagent`）保持单一职责正交解耦：

- **零全局常驻会话、零后台轮询定时器**：插件启动时不创建任何全局会话，不挂载轮询看门狗；所有协作组均在目标顶层会话按需开启（谁派生、谁负责），异常自愈与静默归因 100% 由 `turn_settled` 事件驱动。
- **100% 复用 `builtin:workflow` 受管 Worktree**：组内成员物理隔离分配（`acquire_worktree`）、跨回合持久持有锁（`ManagedWorktreeHold`）、只读变更快照（`inspect_worktree`）、释放锁（`release_worktree_hold`）与清理（`cleanup_worktree`）经 `ctx.host.invokeAction` 复用 `builtin:workflow`；插件自身不声明静态 `dependencies: ['builtin:workflow']`，空闲时不阻塞停用 `builtin:workflow`，持锁工作树则由 `ManagedWorktreeHold` 自动提供 `409 plugin_in_use` 与 `409 worktree_in_use` 保护。

## 当前状态与自举资产

默认启用，随 Hub 启动加载。启用时幂等自举受管技能 `swarm`（`managedByPlugin: 'builtin:swarm'`，停用插件后即时消失，不留幻影提示词），沉淀四条实战协同准则：

1. **何时使用与如何开启**：顶层人类会话输入 `/skill:swarm <任务>` 时由 `onInput` 自动建组并同回合解锁 `swarm_*` 工具；普通对话中由模型在 `<available_skills>` 主动发现或按用户自然语言请求先调用 `swarm_create_group` 建组再调度；
2. **主控职责边界（Skill 约束、零剥离业务工具）**：主控专注任务切分、具名派工、冲突裁决与最终合入收尾，允许快速只读探查以划分边界，不直接写业务代码或跑长时构建阻塞看板调度；
3. **动态拆角 + 按需只读交叉验收**：主控按任务本身动态决定成员数量、小写角色名、权限语义（`readwrite` / `readonly`，由 `<active_swarm_group>` 与 `swarm` 技能约束职责，不强制剥离或硬拦截工具）、隔离方式（并发写代码必须 `worktree` 防冲突；只读检索或交叉验收可选 `inherit` 搭配 `readonly`）及 `profileId` / `model` / `channels`；
4. **`#seq` 指针、`wake` 门铃与两阶段收尾**：跨成员交接统一通过 `refs: [seq]` 与 `#seq` 引用黑板记录（`worktree` 成员发 `handoff / done` 自动内联 `worktreeSnapshot`）；`wake: true` 仅唤醒下一跳责任人（不抄送闲人、不发空确认）；关闭前确认 `activeWorkingMembers` 为空，未合入分支可合并后 `swarm_close_group()` 或传 `keepWorktree: true` 释放锁并保留分支（会话内经 `swarm_*` 工具驱动，对应主机 CLI 为 `helm swarm <subcommand>`）。

## 能力和入口

### 四层单真源存储与投影去重

- **组权威账本与黑板日志**：`<dataDir>/groups/<groupId>/{meta.json, board.jsonl}`，`meta.json` 经 `atomicWriteFile` 原子替换，`board.jsonl` 按组串行队列与 `withFileLock` 脱敏追加单行 JSON，不受全局 `ctx.doc` 2 MiB 上限约束。
- **全局轻量路由索引**：公开 `ctx.doc('index')`，仅存活跃成员反查指针（`{ conversationId, coordinatorConversationId, profileId, groupId, name, createdAt }`）与 `CollabGroupSummary[]`。
- **会话级实时看板投影**：公开 `ctx.sessionDoc('board-view')`，按 `coordinatorConversationId` 键控并以 `(headSeq, memberStateDigest)` 指纹去重，合成一句话态势 `headline`、成员实时状态、聚合有向边 `edges` 及最近 `boardPreviewLimit` 条流转记录。
- **顶栏双向角标**：公开 `ctx.doc('board-badges')`，为主控会话与全体组内活跃成员提供 O(1) 数量与异常告警角标。

### 作用域标签与恒定提示词注入（零破 KV Cache、零剥离业务工具）

- **作用域标签**：`swarm-coordinator`（主控）、`swarm-worker`（活跃组员）、`swarm-worker-archived`（已归档组员）、`swarm-coordinator-archived`（结单历史主控：仅放行工作台编排面板访问已完成编组，不进入任何工具/动作 scope，不复活 `<active_swarm_group>` 注入；同会话重新建组时原地摘除）。
- **同回合无缝切换**：未建组普通会话隐藏黑板工具，仅暴露 `swarm_create_group` 与常规工具；通过 `/skill:swarm <任务>`（`onInput` 建组并保留用户原文不变）或 `swarm_create_group` / `create_group` 挂载 `swarm-coordinator` 标签后，当前回合 `before_turn` 即刻注入字节恒定的 `<active_swarm_group>` 主控引导（包含动态拆角、调用 `load_skill({ skillId: "swarm" })` 与空参询问提示）并解锁主控工具（`swarm_*`），不剥离或拦截主控与成员的常规工具（职责边界由 `<active_swarm_group>` 与 `swarm` 技能约束）。
- **恒定 `turn.sections` 保 Cache**：`before_turn` 注入的 `<active_swarm_group>` 仅含不可变 `groupId`（或成员固定属性）与静态协作铁律，不含可变成员名册或实时状态，中途扩缩容 0 次重写首条系统消息。

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
| `update_group` | `swarm_update_group` | `helm swarm update-group` | 主控独享：修改组 `title / objective` |
| `manage_channel` | 仅 `ctx.action` | `helm swarm channel` | 主控独享动作：子频道 `create / subscribe / unsubscribe / archive`（`main` 禁归档/退订） |
| `dispatch_worker` | `swarm_dispatch_worker` | `helm swarm dispatch-worker` | 主控独享：招募具名对等成员（支持 `profileId`、`access`、`isolation: 'worktree'` 持锁、`forkFrom` 干净锚点分叉、`forkEntryId`、`model`、`effort`、`channels`），写入首条 `brief` 并唤醒 |
| `board_post` | `swarm_board_post` | `helm swarm board-post` | 主控/成员/人工向黑板发帖（结构化 `to` + 正交 `wake`；绑有工作树且发 `handoff / done` 时自动内联 `worktreeSnapshot`） |
| `board_read` / `board_status` | `swarm_board_read` / `swarm_board_status` | `helm swarm board-read` / `board-status` | 幂等分页读取黑板记录 / 读取完整 `BoardViewDoc` 态势快照（覆盖 `active`、`closed` 与 `coordinatorDetached` 组） |
| `abort_worker` | `swarm_abort_worker` | `helm swarm abort-worker` | 主控独享：经 `abortConversationGuarded` 原地刹停成员当前回合，保留上下文与 Worktree 锁 |
| `switch_worker_model` | `swarm_switch_worker_model` | `helm swarm switch-model` | 主控独享：对空闲成员调用 `updateConversation` 原地切换模型续跑 |
| `inspect_worker` / `archive_worker` | `swarm_inspect_worker` / `swarm_archive_worker` | `helm swarm inspect-worker` / `archive-worker` | 幂等读取成员最近时间线摘要、产物与绑定 `worktreeId` / 校验工作树干净后释放锁并归档成员 |
| `close_group` | `swarm_close_group` | `helm swarm close-group` | 主控独享：两态结单（默认要求工作树干净并全清，未合入返 `409 swarm_worktree_unmerged`；`keepWorktree: true` 释放锁、保留待合入分支写入 `retainedWorktrees`，并将 `swarm-coordinator` 标签原地替换为 `swarm-coordinator-archived` 历史 tag——保留工作台面板回看已完成编组并允许重新建组） |
| `complete_board_members` / `complete_board_channels` | 仅 `ctx.action` | 隐藏内部动作 | 幂等补全源：为组内会话输入框提供 `@` 活跃成员与 `#` 活跃子频道候选 |

### Web 会话内协同界面（对齐 `builtin:workflow` 心智模型）

Swarm 不再拥有独立的全屏 Board 控制台或顶栏入口：所有 UI 都是会话内编排事实的薄渲染，状态全部来自既有公开文档与动作（`index`、`board-badges`、按主控会话键控的 `sessionDoc('board-view')`，以及 `board_status` / `board_read` 回退），React 层零私有状态模型：

- **26px 工具轨迹行（`ctx.ui.toolView({ replaceRow: true })`）**：`swarm_create_group / swarm_update_group / swarm_dispatch_worker / swarm_board_post / swarm_board_read / swarm_board_status / swarm_abort_worker / swarm_switch_worker_model / swarm_inspect_worker / swarm_archive_worker / swarm_close_group` 的每次调用在 timeline 中渲染为一行自然语言摘要（派工 / 交接 / 审阅 / 已交付 / 受阻等动词 + 目标 + 一句正文）+ 状态灯 + 耗时；成员类调用点击打开 `openConversationDrawer`，编组类调用打开协同工作台面板，无法确定目标的行展开原始工具数据（宽对象守卫解析输入与结果 JSON，绝不伪造目标或状态）。
- **Composer「进行中」活动托盘（`COMPOSER_DOCK_SLOT`）**：仅当当前会话关联的活跃编组存在执行中 / 受阻成员时渲染 32px HUD（人数、已交付进度、最新一条自然语言动态、编组时长）；整条横栏为真实 toggle 按钮可展开成员行（点击打开子会话抽屉），主控视角对执行中与受阻成员均提供真实 `abort_worker` 中止动作；无在途事项返回 null 占 0px，与 `WorkflowActiveTray` 同构并列。
- **右侧 Workbench 编排面板（`ctx.ui.workbenchPanel` id `groups`，`swarm-coordinator` / `swarm-worker` / `swarm-coordinator-archived` 会话可见）**：当前会话只展示自己所在的编组（主控会话显示自己的组，成员会话显示所属组的同一事实视图，结单历史主控仍可回看已完成编组，不跨会话列全局索引）。一张编排卡：协同目标、自然状态（进行中 / 需要关注 / 已完成）、成员列表（每成员一句最新真实进展 + 实时 doing + worktree 分支事实，点击整行打开子会话抽屉）、最近交接动态（自然 kind 标签 + `#seq` 辅助信息）与结单后保留待合入分支清单；活跃组经 session doc 实时更新，closed / coordinatorDetached 或无投影时显式退避一次性 `board_status`（失败展示错误并可重试，绝不白屏或伪造「运行中」），「查看完整记录」按需 `board_read`。
- **单行回执胶囊（`timelineRenderer`）**：后端仍真实写入的 `swarm:board-report` / `swarm:board-wakeup` durable 输入收敛为单行回执（计数 + 动态 + `#seq`），点击打开协同工作台面板；不注册 `screen`、`conversation:header` action、sidebar 或 `ui.command`，人类干预统一走当前 coordinator 对话 Composer（`@` 成员 / `#` 频道补全保留）。
- **文案与协议分层**：用户可见文案统一 `LocalizedText` 双语；协议词汇（`#seq`、`wake`、原始频道名）仅作辅助信息呈现，不作为用户必须学习的主控件。

## 配置与数据边界

| 配置 | 类型 | 缺省 | 说明 |
| :--- | :--- | :--- | :--- |
| `maxWorkersPerGroup` | number | `12` | 单个协作组同时处于活跃态的对等成员上限（整数 `2..32`） |
| `boardPreviewLimit` | number | `80` | `sessionDoc('board-view')` 保留的最近流转消息条数上限（整数 `20..200`） |

公开文档：`index`、`board-badges`；公开会话文档：`board-view`。文件存储：`<dataDir>/groups/<groupId>/{meta.json, board.jsonl}`。

## 停用、重启与强杀恢复语义

- **以 `meta.json` (`headSeq`) 为唯一事务提交点**：`board.jsonl` 先追加并 `datasync`，再经 `atomicWriteFile` 原子替换 `meta.json`。重启加载若遇单条未提交 WAL 尾（`headSeq + 1` 完整待提交行或尾行半截截断）自动原子回滚截断回 `headSeq`；多行越界或已提交前缀损坏仍严格抛 `swarm_doc_corrupt`。
- **启动屏障孤儿回收（`service.start`）**：加载组状态后、调度器恢复前，按 `meta.json` 单真源收敛孤儿/错配的会话标签与归属权，并释放回收半途强杀遗留的 `builtin:swarm` 孤儿 Worktree 锁（不影响 `keepWorktree: true` 已主动释放锁的分支）。
- **工具 `replay: 'safe'` 幂等重放**：全部 `swarm_*` 工具声明 `replay: 'safe'`，建组（`createKey`）、派工（`dispatchKey`）、发帖（`idempotencyKey`）凭 `${conversationId}:${callId}` 幂等重放，归档与结单先落盘 `meta.json` 再切标签。
- **`runtime.started` 恢复对账**：内核恢复在途 `pi-durable` 回合后，对账 `inflightWakeup` / `inflightNudge` / `inflightReport` 提交意图（区分仍在跑 / 已完成未刷盘 / 未提交），幂等补发未送达唤醒与汇总信封，并对已停机未回帖成员补跑一次失败 `[blocker]`、哑巴退场续催或全组 `[stall]` 检查。
- **停用与人工刹停**：遇在途任务、对账或微批投递经 `liveTasks` 硬阻断（`409 plugin_has_live_tasks`）；存在活跃协作组时经 `inUse` 返回 `409 plugin_in_use`。任意时刻可执行 `helm swarm close-group --group-id <id> --abort-running --keep-worktree` 刹停成员、保留代码分支并解锁主控会话。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口与 UI 注册 | `packages/plugins/src/swarm.ts`、`packages/plugins/src/swarm/ui.ts` |
| 单真源黑板存储 / 寻址 / 静默归因 / 恢复对账 / 动作 / 钩子 | `packages/plugins/src/swarm/`（`contracts.ts`、`action-schemas.ts`、`worktree-bridge.ts`、`group-store.ts`、`board-router.ts`、`board-stall.ts`、`recovery.ts`、`settlement.ts`、`actions.ts`、`hooks.ts`、`assets.ts`、`assets/`） |
| Web 客户端组件与纯模型 | `packages/plugins/src/swarm/client/`（`index.tsx`、`SwarmToolView.tsx`、`SwarmActiveTray.tsx`、`SwarmWorkbenchPanel.tsx`、`BoardReceipts.tsx`、`board-model.ts`、`model-tool-view.ts`、`model-tray.ts`、`model-panel.ts`、`hooks.ts`、`models.ts`、`copy.ts`、`styles.css`） |
| 测试 | `packages/plugins/test/swarm.test.ts`、`packages/plugins/test/swarm.integration.test.ts`、`packages/web/test/swarm-client-interactions.test.tsx` |

## 相关文档

- [工作流与子代理编排](workflow.md)：受管工作树 `ManagedWorktreeHold`、`acquire_worktree / release_worktree_hold` 与 `inspect_worktree`
- [SuperAgent 双层中枢](superagent.md)：常驻自治路由、RecallGraph 与两层定时看门狗
- [Web 前端设计系统](../conventions/web-frontend.md) · [Web 导航与 URL Hash 约定](../conventions/web-navigation.md)
