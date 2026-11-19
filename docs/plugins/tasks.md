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
- **双轨数据**：私有持久 doc `records`（`{ nextSeq, tasks }`）是单一真源；公开瞬态 doc `board`（`public: true, durable: false`）是前端实时投影，仅含未归档任务 + 最近 50 条已完成/归档历史（防 2 MiB 写放大）。全量历史经 `list({ includeArchived: true })` 动作按需查询。
- **并发串行**：全部任务写经 `enqueueMutation` 串行队列（读-改-写 + 投影刷新原子完成），杜绝竞态重复创会话。

## 动作与模型工具

`ctx.action` 十个动作（CLI 自动映射 `helmx tasks <cmd>`）：

| 动作 | CLI | 模型工具 | 说明 |
| :--- | :--- | :--- | :--- |
| `create` | `helmx tasks create` | `task_create` | 建卡；无阻塞且 `autoStart`（默认 true）时立即起独立执行会话并投递任务书 |
| `list` | `helmx tasks list` | `task_list` | 按 `column / project / assigneeProfileId / nodeId / includeArchived` 过滤，附实时会话状态与 `blockedBy` |
| `inspect` | `helmx tasks inspect <id>` | `task_inspect` | 单卡全量：依赖状态、会话实况、近期摘要（脱敏）、产物列表 |
| `update` | `helmx tasks update <id>` | — | 改标题/简报/项目/依赖等；已启动任务锁死执行角色/节点/目录；依赖图必须无环 |
| `start` | `helmx tasks start <id>` | `task_start` | 启动 backlog 卡（依赖未全 done 拒 `409 task_blocked_by_dependencies`；并发超限拒 `409 task_concurrency_limit`） |
| `submit` | `helmx tasks submit` | `task_submit` | 执行者交卷（`scope: tags ['task']`——仅任务执行会话可见可调；会话内按 `conversationId` 反查绑定卡，显式 `taskId` 时校验归属防串单） |
| `approve` | `helmx tasks approve <id>` | `task_approve` | `close_only`（默认）置 done + 会话换归档标签 + 自动解锁下游依赖；`merge_and_close` 置 `mergePending` 并向执行会话投递合并收尾指令 |
| `rework` | `helmx tasks rework <id>` | `task_rework` | 打回返工：回 `in_progress`、`reworkCount + 1`、意见投回原会话（保留上下文与分支）；原会话被删时显式 `409 task_conversation_missing`（或 `recreateConversation: true` 重建） |
| `archive` | `helmx tasks archive <id>` | — | 归档 backlog/done 卡（进行中拒 `409 task_in_progress`） |
| `delete` | `helmx tasks delete <id>` | — | 删除任务记录（进行中且会话忙碌拒 `409 task_in_progress`）；绝不删除会话历史 |

模型工具用独立 `ctx.tool` 注册以获得契约约定的精确短名（`exposeAsTool` 派生名带哈希后缀，不满足）。

### 规划/执行工具隔离（before_turn）

| 会话形态 | 可见工具 |
| :--- | :--- |
| 任务执行会话（绑定 in_progress/in_review 卡） | `task_submit` + 只读 `task_list` / `task_inspect`；**隐藏** `task_create` / `task_start` / `task_approve` / `task_rework`（防执行者套娃建卡或自审自批） |
| 顶层人类会话（规划者） | `task_create` / `task_list` / `task_inspect` / `task_start` / `task_approve` / `task_rework`；**隐藏** `task_submit` |
| 子会话 / 自动化会话 | 只读 `task_list` / `task_inspect`；隐藏全部规划工具与交卷工具 |

同时任务执行会话每个回合注入 100% 字节恒定的 `<active_task id="T-N" ...>` 系统段落（仅含任务生命周期不变事实：ID、标题、`planFirst`、`autoMerge`、交卷纪律与编排自主权声明），与 swarm 的 `<active_swarm_group>` 同一纪律。

### 动作硬边界（防绕过）

规划动作（`create / start / approve / rework / update / archive / delete`）在 handler 内再校验：任务执行会话、子会话、自动化会话（`ownedBy !== 'human'`）调用一律 `403 task_scope_violation`——`before_turn` 过滤只挡工具列表，`run_action` 与 Workflow `action()` 路径由这层兜底。人工 CLI/UI（无 `conversationId`）不受限。

## 依赖链与自动接棒

- `dependsOn: ['T-1']`：引用必须存在、禁止自依赖、全图禁止成环（DFS 检测，写入前校验）。
- 被阻塞的卡停在 `backlog` 并记录 `autoStartOnUnblock`（创建时 `autoStart` 缺省 true）。
- 前置卡 `approve close_only` 后自动扫描下游：全部前置 `done` 即解锁（返回 `unblockedTaskIds`）；`autoStartOnUnblock === true` 且未超 `maxConcurrentTasks` 时自动开工（返回 `autoStartedTaskIds`）。

## 防沉默（turn_settled 纯事件驱动，零定时器）

绑定 `in_progress` 卡的执行会话回合结算时：

- `outcome === 'failed'`：记录 `silenceState.lastError`（看板诚实展示报错，不伪造状态）。
- `outcome === 'completed'` 且完全静止（无待答 Ask、整棵后代子树无 working/blocked）仍未交卷：
  - 未轻推过 → 记 `nudgedAt` 并投递**一次**温和提醒（`origin: 'agent'`, `whenBusy: 'followUp'`，requestId 按 completionSeq 幂等）；
  - 已轻推过仍未交卷 → 记 `stalledAt`，看板诚实标示「回合已停 · 未交卷」。
- **绝不强杀会话、绝不伪造 in_review**。human-owned 会话的红线（严禁自动按键/中止）完整保留——轻推走普通 `submitInput`（与人工 HTTP 输入同链），followUp 语义不打断人类在途输入。
- `conversation.deleted` 事件：受影响任务诚实标记 `conversationMissing: true`（不捏造、不自动删任务）。

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
