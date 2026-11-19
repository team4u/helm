# builtin:tasks 任务看板

`builtin:tasks` 把定义清晰的工作单元从当前对话**派发到独立执行会话**，并在一块四列看板（待办 Backlog / 进行中 In Progress / 待验收 In Review / 已完成 Done）上诚实跟踪。默认启用、可停用；零内核改动、零常驻角色、零启动常驻会话。

## 设计动机与形态选型

| 场景 | 选型 |
| :--- | :--- |
| 快速问答、小改动 | 直接在当前会话做，不建卡 |
| 固定可重复的流水线（严格 gate/Schema 检查点） | `SubagentWorkflow` |
| 需要切片间实时互通的对等协作 | `builtin:swarm` |
| **值得独立执行上下文 + 人工验收闭环的工作单元** | `builtin:tasks` |

与 Swarm 的关键差异：任务执行者是**独立顶层 human-owned 会话**（无 `parentConversationId`、不标 `helmx` 归属），完整保留 `subagent` / `SubagentWorkflow` / `Swarm` 编排决策权——执行者可以按复杂度自主再派生。Swarm worker 是父会话派生的子会话，生命周期挂在协作组上；任务执行会话是平等的顶层会话，生命周期由看板管理。

## 核心概念

- **任务卡 `TaskRecord`**：`T-1`、`T-2` 单调递增短号；自包含任务书 `brief`（背景/范围/验收标准/坐标）、执行角色 `assigneeProfileId`、可选 `nodeId` / `cwd` / `model` / `thinkingLevel` 覆写。
- **执行会话**：开工时由插件创建的独立顶层会话，贴 `task` 标签（侧栏「任务执行」分组收口）；验收通过或归档后换 `task-archived` 标签（「已完成任务」分组）。**绝不删除底层会话历史**。
- **受管技能 `tasks`**：随插件启停自举/消失，教会任意 Profile 角色做「需求规划者」——收清需求产出高质量 brief、按需拆分带依赖的任务组、不亲自下场写业务代码。
- **双轨数据**：私有持久 doc `records`（`{ nextSeq, tasks }`）是单一真源；公开瞬态 doc `board`（`public: true, durable: false`）是前端实时投影，仅含未归档任务 + 最近 50 条已完成/归档历史。公开 doc 单值受宿主 **2 MiB 上限**（超限显式 413 拒绝写入），投影截断即为体积控制手段；全量历史经 `list({ includeArchived: true })` 动作按需查询。
- **依赖真值随卡携带**：投影的每张卡附带 `blockedBy: string[]`（未 done 的前置 ID，按真源全量计算）——板书截断后前端无法看到被截掉的依赖卡状态，UI 必须消费该字段判定阻塞，不得自行从截断板书推导（契约见 `TaskBoardEntry`）。
- **持久化输入脱敏**：brief / title / project / summary / verification / branch / worktreePath / feedback / note 等用户文本写入 doc 前统一过 `ctx.host.redact`（宿主唯一脱敏入口，已登记机密替换为标记），不落明文机密。
- **并发串行**：全部任务写经 `enqueueMutation` 串行队列（读-改-写 + 投影刷新原子完成），杜绝竞态重复创会话。

## 动作与模型工具

`ctx.action` 十个动作（CLI 自动映射 `helmx tasks <cmd>`）：

| 动作 | CLI | 模型工具 | 说明 |
| :--- | :--- | :--- | :--- |
| `create` | `helmx tasks create` | `task_create` | 建卡（仅用户明确要求建单/委派时调用，裸 go-ahead 不构成委派）；无阻塞且 `autoStart`（默认 true）时经两阶段启动起独立执行会话并投递任务书 |
| `list` | `helmx tasks list` | `task_list` | 按 `column / project / assigneeProfileId / nodeId / includeArchived` 过滤，附实时会话状态与 `blockedBy` |
| `inspect` | `helmx tasks inspect <id>` | `task_inspect` | 单卡全量：依赖状态、会话实况、近期摘要（脱敏）、产物列表 |
| `update` | `helmx tasks update <id>` | — | 改标题/简报/项目/依赖等；已启动任务锁死执行角色/节点/目录；依赖图必须无环 |
| `start` | `helmx tasks start <id>` | `task_start` | 启动 backlog 卡（依赖未全 done 拒 `409 task_blocked_by_dependencies`；并发超限拒 `409 task_concurrency_limit`） |
| `submit` | `helmx tasks submit` | `task_submit` | 执行者交卷（`scope: tags ['task']`——仅任务执行会话可见可调；会话内按 `conversationId` 反查绑定卡，显式 `taskId` 时校验归属防串单） |
| `approve` | `helmx tasks approve <id>` | `task_approve` | `close_only`（默认）置 done + 会话换归档标签 + 自动解锁下游依赖；`merge_and_close` 置 `mergePending` 并向执行会话投递合并收尾指令 |
| `rework` | `helmx tasks rework <id>` | `task_rework` | 打回返工：回 `in_progress`、`reworkCount + 1`、意见投回原会话（保留上下文与分支）；原会话被删时显式 `409 task_conversation_missing`（或 `recreateConversation: true` 重建，新会话收到任务书 + 返工意见两条输入） |
| `request_plan_approval` | `helmx tasks request-plan-approval` | `task_request_plan_approval` | planFirst 方案审批（真实 AskDoc confirm 卡片，阻塞至用户作答）；批准决定持久化到 `planApproval` 后 `task_submit` 才放行 |
| `archive` | `helmx tasks archive <id>` | — | 归档 backlog/done 卡（进行中拒 `409 task_in_progress`） |
| `delete` | `helmx tasks delete <id>` | — | 删除任务记录（进行中且会话忙碌拒 `409 task_in_progress`；仍被其他任务 `dependsOn` 引用时拒 `409 task_dependency_referenced`，先解除引用）；绝不删除会话历史 |

模型工具用独立 `ctx.tool` 注册以获得契约约定的精确短名（`exposeAsTool` 派生名带哈希后缀，不满足）。

### 规划/执行工具隔离（before_turn）

| 会话形态 | 可见工具 |
| :--- | :--- |
| 任务执行会话（绑定 in_progress/in_review 卡） | `task_submit` + `task_request_plan_approval` + 只读 `task_list` / `task_inspect`；**隐藏** `task_create` / `task_start` / `task_approve` / `task_rework`（防执行者套娃建卡或自审自批） |
| 顶层人类会话（规划者） | `task_create` / `task_list` / `task_inspect` / `task_start` / `task_approve` / `task_rework`；**隐藏** `task_submit` |
| 子会话 / 自动化会话 | 只读 `task_list` / `task_inspect`；隐藏全部规划工具与交卷工具 |

同时任务执行会话每个回合注入 100% 字节恒定的 `<active_task id="T-N" ...>` 系统段落（仅含任务生命周期不变事实：ID、标题、`planFirst`、`autoMerge`、交卷纪律与编排自主权声明），与 swarm 的 `<active_swarm_group>` 同一纪律。

### 动作硬边界（防绕过）

规划动作（`create / start / approve / rework / update / archive / delete`）在 handler 内再校验：任务执行会话、子会话、自动化会话（`ownedBy !== 'human'`）调用一律 `403 task_scope_violation`——`before_turn` 过滤只挡工具列表，`run_action` 与 Workflow `action()` 路径由这层兜底。人工 CLI/UI（无 `conversationId`）不受限。

## planFirst 的真实 AskDoc 审批门禁

`planFirst: true` 的任务在交卷前必须获得**用户的明确方案批准**，机制是真实 AskDoc 闭环
（`task_request_plan_approval` 工具 + 动作五端同权）：

1. 执行者调研后在任务执行会话内调用 `task_request_plan_approval({ plan })`；
2. 插件经 `ctx.host.createAsk` 向该会话发 **confirm 类型 Ask 卡片**（方案全文经宿主统一
   脱敏后展示），工具执行阻塞等待用户作答——期间 `pendingAskCount > 0`、会话 `blocked`，
   看板单灯如实显示「等待人类决策」（不会被误判为停滞）；
3. 用户批准（`approve: 'true'`）→ 决定持久化到 `task.planApproval.decision = 'approved'`；
   拒绝 → `rejected`（执行者应修订方案再问）；取消 / 被顶替 → 不记录任何批准；
4. **`task_submit` 硬门禁**：planFirst 任务 `planApproval.decision !== 'approved'` 时一律
   `409 task_plan_not_approved`（含未发起审批与被拒绝两种情形）——审批事实以任务记录为准，
   不依赖模型自觉。

**门禁范围（如实声明）**：插件不硬拦截文件写入工具（bash/write 等仍可用——拦截会误伤
只读探查且无法穷举写入路径）；「未获批准不得交卷」由 submit 硬门禁强制，动工纪律由恒定
系统段落约束。`task_approve` 的调用指南同样明确：仅在用户显式验收后调用，工具可调用
不构成默认授权。

## 依赖链与自动接棒

- `dependsOn: ['T-1']`：引用必须存在、禁止自依赖、全图禁止成环（DFS 检测，写入前校验）。
- 被阻塞的卡停在 `backlog` 并记录 `autoStartOnUnblock`（创建时 `autoStart` 缺省 true）。
- 前置卡 `approve close_only` 后自动扫描下游：全部前置 `done` 即解锁（返回 `unblockedTaskIds`）；`autoStartOnUnblock === true` 且未超 `maxConcurrentTasks` 时自动开工（返回 `autoStartedTaskIds`）。

## 静止标记与输入投递边界（turn_settled 纯事件驱动，零定时器、零自动输入）

绑定 `in_progress` 卡的执行会话回合结算时：

- `outcome === 'failed'`：记录 `silenceState.lastError`（看板诚实展示报错，不伪造状态）。
- `outcome === 'completed'` 且完全静止仍未交卷（判定口径：无待答 Ask、整棵后代子树无
  working/blocked、`builtin:workflow` 名下无 running run——无静态依赖，运行时按需查询，
  查询故障时保守跳过标记宁漏报不误报）：记 `silenceState.stalledAt`，看板诚实标示
  「回合已停 · 未交卷」。
- **插件对 human-owned 执行会话零自动输入投递**（AGENTS Watchdog 红线：自动化提交
  统一走 guarded 而 guarded 拒绝 human 归属，也不得用普通 submitInput 实现事件自唤醒）。
  「停下未交卷」只呈现于看板；继续工作由用户显式打开执行会话发言（或规划者 rework 重派）。
- 插件投递的仅限**用户显式动作的直接延伸**（`origin: 'agent'`、requestId 幂等）：
  建卡/开工的任务书 kick off、`merge_and_close` 的合并收尾指令、rework 的返工意见——
  全部由用户显式调用对应动作触发。
- `conversation.deleted` 事件：受影响任务诚实标记 `conversationMissing: true`（不捏造、不自动删任务）。

## 启动两阶段与重启恢复（副作用前落盘）

开工（create 即启 / start / 验收后下游接棒 / rework 重建）统一走两阶段：

1. 串行 mutation 把任务占位为 `in_progress`（无 conversationId）并 `flush` 落盘——占位即计入并发额度，杜绝竞态双开会话；
2. `createConversation`（内核自身持久化）→ 串行 mutation 绑定 `conversationId` + `startedAt`（flush）→ 投递任务书（requestId 按 taskId 幂等）；
3. 任务书投递失败显式回滚：任务回 `backlog` 记 `lastError`（可重试 start），已建会话标 `task-archived` 保留现场，错误上抛绝不静默；
4. 两阶段之间服务重启：启动时 `recoverInterruptedStartups` 把 `in_progress` 无绑定会话的残留任务诚实回滚 `backlog` 并在 `lastError` 记录原因（绝不假装在跑）；「绑定成功但任务书未被接纳」的窗口（绑定 flush 后、投递前崩溃）由启动恢复**补投任务书**兜底——requestId 按会话幂等，重复补投被内核去重，安全。
5. 初始任务书投递 `whenBusy: 'reject'`：新会话必 idle；若创建与投递之间被人类抢先输入（接管窗口），显式拒绝绝不串入。返工 / 合并指令为已存会话的授权投递，用 `followUp` 排队不打断在途输入，绝不用 steer。

`rework` / `merge_and_close` 的意见与指令投递采用原子模式：状态变更与投递在同一串行 mutation 内，投递成功后才落盘；失败 draft 丢弃可干净重试，requestId 分别按 `reworkCount` / `submission.submittedAt`（无交付时 `reworkCount`）幂等（崩溃窗口内已投递的重试不重复投递）。rework 重建（`recreateConversation: true`）向新会话投递**单条合成任务书**（原 brief + 返工意见），不做 kickoff + 意见两条投递。`approve close_only` 与合并授权下的证据交付 `submit` 共用同一条终转链：`done` 核心事实先落盘（flush），衍生动作（会话换标签、下游接棒）失败容忍上报、不回滚验收事实。

### merge_and_close 的一步结单语义

`approve mergeAction: 'merge_and_close'` 表示**用户已验收并显式授权本次合并**（显式授权
覆盖任务 `autoMerge: false` 的默认隔离，合并指令文案如实注明）。插件向执行会话投递合并
收尾指令后任务回 `in_progress` 并标记 `mergePending`；执行者完成合并清理后调用
`task_submit` **携带合并证据（branch 或 verification）即一步终转 done**（会话归档、下游
依赖解锁）——不要求用户第二次人工点击。无证据的提交维持 `in_review` 待人工复核
（「不能证明合入，维持待复核」）。

## 配置

| 键 | 类型 | 默认 | 说明 |
| :--- | :--- | :--- | :--- |
| `defaultPlannerProfile` | string | `assistant` | 看板「聊一个新任务」跳转的规划角色 |
| `defaultAssigneeProfile` | string | `assistant` | 建卡未指定执行角色时的回退（不存在或不可选时逐级退到发起会话 Profile → `assistant`） |
| `maxConcurrentTasks` | number | `0`（不限） | 并发 in_progress 上限（0..50） |

## UI 贡献

- `sidebarItem` `task-board`（`order: 5`，先于 App Center）：Rail 视图图标一步直达看板；
- `screen` `board`：`TaskBoardScreen` 全屏看板（四列 + 移动端清零流，由前端切片实现）；
- `sidebarSection` `task-conversations`（`filterTag: task`）与 `task-archived-conversations`（`filterTag: task-archived`）：任务执行会话收口分组，默认折叠；
- `toolView` `task-tool-card`：`task_create / task_start / task_submit / task_approve / task_rework` 的时间线活体回执卡。

## 生命周期与诚实边界

- `inUse()`：存在 in_progress / in_review 任务时报告占用——停用被 `409 plugin_in_use` 拒绝（防静默丢看板）；验收/归档/删除全部活跃卡后方可停用。
- `liveTasks()`：在途任务写（`task:create` 等）与轻推投递（`task:nudge`）。
- 停用后：工具、动作、UI 贡献与受管技能即时消失（零幻影提示词）；`records` 持久 doc 与执行会话完整保留，重新启用即恢复看板。
- 远端节点目标必须有显式 `cwd`（或执行角色 Profile 绑定默认目录），缺省显式拒绝——绝不盲执行远端默认目录。
- 建卡/启动的会话创建或任务书投递失败时干净回滚：已建会话换 `task-archived` 标签保留现场，任务卡回 `backlog` 可重试，错误显式上抛。

## 相关文档

- [插件系统总纲](overview.md) · [Swarm 对等协同](swarm.md) · [工作流与子代理](workflow.md)
- [架构总览](../architecture/overview.md) · [扩展点详解](../architecture/extension-points.md)
