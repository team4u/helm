# builtin:tasks 任务看板

`builtin:tasks` 把定义清晰的工作单元从当前对话**派发到独立执行会话**，并在一块四列看板（待办 Backlog / 进行中 In Progress / 待验收 In Review / 已完成 Done）上诚实跟踪。默认启用、可停用；零内核改动、零常驻角色、零启动常驻会话。定位是**纯台账**：任务卡 + 1:1 独立顶层执行会话 + 人工验收闭环（submit/approve/rework）——不做 Git 合并编排、不做依赖调度、不做方案审批系统、不做服务端子树监控。

## 设计动机与形态选型

| 场景 | 选型 |
| :--- | :--- |
| 快速问答、小改动 | 直接在当前会话做，不建卡 |
| 固定可重复的流水线（严格 gate/Schema 检查点） | `SubagentWorkflow` |
| 需要切片间实时互通的对等协作 | `builtin:swarm` |
| 需要跨任务依赖编排 / 并发槽调度 | 规划者自己排（一次一卡，或用 workflow）——看板不做 |
| **值得独立执行上下文 + 人工验收闭环的工作单元** | `builtin:tasks` |

与 Swarm 的关键差异：任务执行者是**独立顶层 human-owned 会话**（无 `parentConversationId`、不标 `helmx` 归属），完整保留 `subagent` / `SubagentWorkflow` / `Swarm` 编排决策权——执行者可以按复杂度自主再派生。Swarm worker 是父会话派生的子会话，生命周期挂在协作组上；任务执行会话是平等的顶层会话，生命周期由看板管理。

## 核心概念

- **任务卡 `TaskRecord`**：`T-1`、`T-2` 单调递增短号；自包含任务书 `brief`（背景/范围/验收标准/坐标）、执行角色 `assigneeProfileId`、可选 `nodeId` / `cwd` / `model` / `thinkingLevel` 覆写。
- **执行会话**：开工时由插件创建的独立顶层会话，贴 `task` 标签（侧栏「任务执行」分组收口）；验收通过或归档后换 `task-archived` 标签，仍留在「任务执行」分组内沉底（`keptAliveTag` 单分组收口，不另设归档抽屉）。**绝不删除底层会话历史**。
- **受管技能 `tasks`**：随插件启停自举/消失，教会任意 Profile 角色做「需求规划者」——收清需求产出高质量 brief、不亲自下场写业务代码。
- **双轨数据**：私有持久 doc `records`（`{ nextSeq, tasks }`）是单一真源；公开瞬态 doc `board`（`public: true, durable: false`）是前端实时投影，仅含未归档任务 + 最近 50 条已完成/归档历史（归档即收离看板主视图，前端默认只渲染未归档卡，「已归档」开关打开时附带展示已归档卡并淡化沉底）。公开 doc 单值受宿主 **2 MiB 上限**（超限显式 413 拒绝写入），投影截断即为体积控制手段；全量历史经 `list({ includeArchived: true })` 动作按需查询。
- **徽标聚合随板携带**：`board` 投影顶层携带诚实注意汇总——`attentionCount`（需人工介入任务数：全部未归档 in_review + 携注意信号的未归档 in_progress）、`reviewCount`（待验收数）、`runningCount`（健康在跑数）、`hasRunning`（`attentionCount === 0 && runningCount > 0`，安静圆点）、`badgeTone`（`error` > `warn` > `accent` > `neutral` 最高严重度）与 `badgeSummary`（双语摘要，如「2 个待验收 · 1 个需处理」）。in_progress 的注意信号只看**主会话事实**：conversationMissing（或绑定会话不在实时会话表）/ 主会话 `error` / `blocked` / 待答 Ask（`pendingAskCount > 0`）。徽标实时感知订阅真实内核事件（`conversation.upsert` / `ask.upsert` / `ask.resolved`，仅存在未归档活跃卡时重投影），并按徽标元组脏检查落笔——元组不变不写 doc，高频流式事件零 SSE 写放大。sidebarItem 徽标声明常量 `TASK_BOARD_SIDEBAR_BADGE`（`contracts.ts` 导出）与宿主通用 `SidebarItemBadgeSpec` 字段一一对应，`ui.ts` 注册处已声明 `badge: TASK_BOARD_SIDEBAR_BADGE`——宿主订阅本插件公开 doc `board`，在活动 Rail 快捷入口、移动端 MobileQuickNav 与侧栏视图行渲染计数徽标 / 安静圆点 / tooltip 摘要（零插件 ID 特判，停用即随贡献消失）。
- **持久化输入脱敏**：brief / title / project / summary / verification / branch / worktreePath / feedback 等用户文本写入 doc 前统一过 `ctx.host.redact`（宿主唯一脱敏入口，已登记机密替换为标记），不落明文机密。
- **并发串行**：全部任务写经 `enqueueMutation` 串行队列（读-改-写 + 投影刷新原子完成），杜绝竞态重复创会话。

## 动作与模型工具

`ctx.action` 十个动作（CLI 自动映射 `helmx tasks <cmd>`）：

| 动作 | CLI | 模型工具 | 说明 |
| :--- | :--- | :--- | :--- |
| `create` | `helmx tasks create` | `task_create` | 建卡（仅用户明确要求建单/委派时调用，裸 go-ahead 不构成委派）；可选 `idempotencyKey` 幂等键（同键重复 create 返回已建任务，双击防抖兜底）；`autoStart`（默认 true）时立即经单会话原子化启动起独立执行会话并投递任务书 |
| `list` | `helmx tasks list` | `task_list` | 按 `column / project / assigneeProfileId / nodeId / includeArchived` 过滤，附实时主会话状态 |
| `inspect` | `helmx tasks inspect <id>` | `task_inspect` | 单卡全量：会话实况、近期摘要（脱敏）、产物列表 |
| `update` | `helmx tasks update <id>` | — | 改标题/简报/项目等；`project` / `nodeId` / `cwd` / `model` / `thinkingLevel` 传 null 或空串显式清空回默认链；已启动任务锁死执行角色/节点/目录（执行角色修改与 create 同口径校验可指派性） |
| `start` | `helmx tasks start <id>` | `task_start` | 启动 backlog 卡：创建独立顶层执行会话并投递任务书；已启动拒 `409 task_already_started` |
| `submit` | `helmx tasks submit` | `task_submit` | 执行者交卷（`scope: tags ['task']`——仅任务执行会话可见可调；会话内按 `conversationId` 反查绑定卡，显式 `taskId` 时校验归属防串单）。进入 `in_review` 等待人工验收时发一条 `info` 级 `notification` 事件（全局 Toast 即时可见、附看板深链；通知失败仅记日志绝不影响交卷） |
| `approve` | `helmx tasks approve <id>` | `task_approve` | 验收通过：置 done + 会话换归档标签（对 done 幂等返回当前事实）；主会话 working/blocked 在途时拒 `409 task_still_running`；in_progress 任务需显式 `confirmStopped: true` 才允许人工收尾 |
| `rework` | `helmx tasks rework <id>` | `task_rework` | 打回返工：回 `in_progress`、`reworkCount + 1`、意见投回原会话（保留上下文与分支）；原会话被删时显式 `409 task_conversation_missing`（或 `recreateConversation: true` 重建，新会话收到**单条合成任务书**：原 brief + 返工意见） |
| `archive` | `helmx tasks archive <id>` | — | 归档 backlog/done 卡即收离看板主视图（进行中拒 `409 task_in_progress`；重复归档幂等返回 `alreadyArchived`，历史经看板「已归档」开关或 `list --include-archived` 查看） |
| `delete` | `helmx tasks delete <id>` | — | 删除任务记录（执行中且会话忙碌拒 `409 task_in_progress`；**绑定会话已被删除的死卡允许直接删除**）；绝不删除会话历史 |

模型工具用独立 `ctx.tool` 注册以获得契约约定的精确短名（`exposeAsTool` 派生名带哈希后缀，不满足）。

### 规划/执行工具隔离（before_turn）

| 会话形态 | 可见工具 |
| :--- | :--- |
| 任务执行会话（绑定 in_progress/in_review 卡） | `task_submit` + 只读 `task_list` / `task_inspect`；**隐藏** `task_create` / `task_start` / `task_approve` / `task_rework`（防执行者套娃建卡或自审自批） |
| 顶层人类会话（规划者） | `task_create` / `task_list` / `task_inspect` / `task_start` / `task_approve` / `task_rework`；**隐藏** `task_submit` |
| 子会话 / 自动化会话 | 只读 `task_list` / `task_inspect`；隐藏全部规划工具与交卷工具 |

同时任务执行会话每个回合注入 100% 字节恒定的 `<active_task id="T-N" ...>` 系统段落（仅含任务生命周期不变事实：ID、标题、交卷纪律与编排自主权声明），与 swarm 的 `<active_swarm_group>` 同一纪律。

### 动作硬边界（防绕过）

规划动作（`create / start / approve / rework / update / archive / delete`）在 handler 内再校验：任务执行会话、子会话、自动化会话（`ownedBy !== 'human'`）调用一律 `403 task_scope_violation`——`before_turn` 过滤只挡工具列表，`run_action` 与 Workflow `action()` 路径由这层兜底。人工 CLI/UI（无 `conversationId`）不受限。

## 单会话原子化启动与崩溃恢复（副作用前落盘）

开工（create 即启 / start / rework 重建）统一走单会话原子化启动：

1. `createConversation`（内核自身持久化；坐标解析 / Profile 读取 / 建会话失败 → 任务留在 backlog，错误显式上抛，无需改状态）；
2. 串行 mutation：绑定 `conversationId` + `column='in_progress'` + `startedAt`（write+flush；绑定守卫——任务未绑定或绑定的正是本次会话才动，绝不误伤并发新绑定，后到并发启动显式 409）；
3. `submitInput` 任务书（`origin: 'agent'`、requestId 按 taskId 幂等、`whenBusy: 'reject'`——新会话必 idle，创建与投递之间被人类抢先输入时显式拒绝绝不串入）；
4. 任一步失败：干净回滚——任务回 backlog（清绑定）、已建会话换 `task-archived` 标签保留现场、错误显式上抛绝不静默（接管窗口的 `conversation_busy` 例外：会话已被人类接管，保留 `task` 标签避免分组跳变）。

崩溃窗口兜底是**启动恢复**（`service.start`）：扫描 in_progress 任务——
- 未绑定会话（recreate 绑定前崩溃）→ 诚实回滚 backlog；
- 已绑定会话但**零 `helmx.input`**（`getConversationDetail` limit 50 判断，与孤儿检测同法）→ 诚实回滚 backlog + 会话贴 `task-archived` 保留现场 + `console.error` 上报，**绝不自动重投**（尊重用户 reset 清空的意图，也不事件自唤醒）。

「绑定前崩溃遗留的孤儿会话」（task 标签 + 零输入 + 不绑任何任务）同样被启动恢复贴 `task-archived` 收口并上报（保留现场，绝不删除会话）。`rework` / `recreate` 的意见投递采用原子模式：状态变更与投递在同一串行 mutation 内，投递成功后才落盘；失败 draft 丢弃可干净重试，requestId 按 `reworkCount` 幂等。`approve` 与 `submit` 共用同一条终转链：`done` 核心事实先落盘（flush），衍生动作（会话换标签）失败容忍上报、不回滚验收事实。

插件投递的仅限**用户显式动作的直接延伸**（`origin: 'agent'`、requestId 幂等）：建卡/开工的任务书 kick off、rework 的返工意见——全部由用户显式调用对应动作触发，**对 human-owned 执行会话零自动输入投递**（AGENTS Watchdog 红线）。「会话已空闲 · 未交卷」是前端纯派生事实（主会话 idle 且无 SDK background 在途），继续工作由用户显式点「继续」（submitInput 通用继续语）或打开会话发言。

`conversation.deleted` 事件：受影响任务诚实标记 `conversationMissing: true`（不捏造、不自动删任务）。

## 配置

| 键 | 类型 | 默认 | 说明 |
| :--- | :--- | :--- | :--- |
| `defaultPlannerProfile` | string | `assistant` | 看板「聊一个新任务」跳转的规划角色 |
| `defaultAssigneeProfile` | string | `assistant` | 建卡未指定执行角色时的回退（不存在或不可选时逐级退到发起会话 Profile → `assistant`） |

## UI 贡献

- `sidebarItem` `task-board`（`order: 5`，先于 App Center；`quickEntry: true` 随宿主快捷入口体系直达）：Rail 视图图标一步直达看板；注册处声明 `badge: TASK_BOARD_SIDEBAR_BADGE`（count=`attentionCount` / tone=`badgeTone` / dot=`hasRunning` / summary=`badgeSummary`），驱动活动 Rail 快捷入口、移动端 MobileQuickNav 与侧栏视图行的通用徽标渲染；
- `screen` `board`：`TaskBoardScreen` 全屏看板（四列 + 移动端清零流，由前端切片实现）；
- `sidebarSection` `task-conversations`（`filterTag: task` + `keptAliveTag: task-archived`）：任务执行会话单一收口分组（结单/归档成员换标签后仍留组沉底），默认折叠；
- `toolView` `task-tool-card`：`task_create / task_start / task_submit / task_approve / task_rework` 的时间线活体回执卡；
- `slot` `overview-card-meta`（target `OVERVIEW_CARD_META_SLOT`，宿主会话总览卡片元数据区）：向任务执行会话的总览卡贡献一枚只读跳转胶囊（`TaskOverviewCardMeta`：任务号 + 状态词 + 可选项目短标记，点击 `stopPropagation` 后深链 `screen:builtin:tasks/board?task=<id>` 定位看板抽屉）。`scope.tags` 为 `task` / `task-archived` 的 OR 匹配——仅任务执行会话卡片挂载，普通对话零开销零订阅；查无匹配任务返回 `null` 零视觉残留；验收/返工/开工等重操作一律留在看板自身，胶囊坚持只读 + 跳转；插件停用后贡献即时消失。
- `action` `task-anchor`（target `conversation:header`，`placement: 'toolbar'`）：任务执行会话头部的任务锚点徽标（`TaskHeaderBadge`：图标 + 任务号 + 状态词，`data-column` 语义配色与总览胶囊同源；点击 `stopPropagation` 深链看板任务详情）。这是执行会话内**唯一**的任务回链——验收/返工等规划者动作留在看板抽屉（`assertPlannerAuthority` 防自审自批不变量），徽标本身是只读导航锚零动作权限面；`scope.tags` 同上 OR 匹配，结单换 `task-archived` 标签后徽标仍在；数据走 `board` 公开投影（`findTaskForConversation`：未归档 > `updatedAt` 新），任务被 >50 归档截断出投影或 doc 未加载时返回 `null` 零残留；窄屏（≤680px）收敛为图标 + 任务号，状态词进 `title`。

卡片实况行只看**主会话事实 + SDK background 快照**（零服务端子树遍历）：主会话 error / blocked（待答 Ask）/ doing / `lastError` 派生展示；`column==='in_progress'` 且主会话 idle 且无 background 在途时纯派生显示「会话已空闲 · 未交卷」并提供「继续」按钮（submitInput 通用继续语，人工显式触发）。

## 生命周期与诚实边界

- `inUse()`：存在 in_progress / in_review 任务时报告占用——停用被 `409 plugin_in_use` 拒绝（防静默丢看板）；验收/归档/删除全部活跃卡后方可停用。
- `liveTasks()`：在途任务写（`task:create` / `task:start` / `task:submit` / `task:approve` / `task:rework` 等动作标签）。
- 停用后：工具、动作、UI 贡献与受管技能即时消失（零幻影提示词）；`records` 持久 doc 与执行会话完整保留，重新启用即恢复看板。
- 远端节点目标必须有显式 `cwd`（或执行角色 Profile 绑定默认目录），缺省显式拒绝——绝不盲执行远端默认目录。
- 建卡/启动的会话创建或任务书投递失败时干净回滚：已建会话换 `task-archived` 标签保留现场，任务卡回 `backlog` 可重试，错误显式上抛。

## 相关文档

- [插件系统总纲](overview.md) · [Swarm 对等协同](swarm.md) · [工作流与子代理](workflow.md)
- [架构总览](../architecture/overview.md) · [扩展点详解](../architecture/extension-points.md)
