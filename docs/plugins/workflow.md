# 工作流与子代理编排插件

`builtin:workflow` 为需要多智能体协作的使用者提供确定性编排：把「派一个子代理」「跑一个多阶段流水线」「在隔离 Git Worktree 里写代码并跑门禁」变成可重放、可恢复、可观测的运行记录。适合编写编排脚本的开发者、需要委派任务的会话使用者，以及排查子代理/工作树状态的维护者。本文是该插件的权威文档；DSL 语法与执行模型的完整参考另见[原生 JavaScript DSL 手册](../workflows/dsl-guide.md)。

## 当前状态

默认启用、非 `locked` 可停用。三个模型工具（`subagent` / `SubagentWorkflow` / `cleanup_worktree`）、DSL 编排引擎（journal 重放 + 前缀缓存）与受管 Git Worktree 生命周期全部归属本插件——内核对 Git 零语义，无本插件时 `isolation: 'worktree'` 等执行环境要求无插件兑现而原样到达原生执行行时显式返回 `unsupported_runtime`。引擎为插件自有资产（`packages/plugins/src/workflow/engine/`），内核不 import 本目录。

## 能力和入口

### 模型工具（3 个）

- **`subagent`**：派生子代理。支持 `fork: true` 从父会话上下文分叉、`isolation: 'worktree'` 隔离工作树、`resume` 续接（凭 `execution.conversationId` / `executionId`）、`schema` 结构化输出、`gate` 验收命令、`model` / `effort` 覆盖、`maxSubagentDepth` 显式授予派生深度；
- **`SubagentWorkflow`**：确定性 DSL 编排（内联 `script` / `scriptPath` / 已保存 `name`），journal 账本支持 `resumeFromRunId` 断点恢复；
- **`cleanup_worktree`**：清理受管隔离 Git Worktree（错误分支绝不伪造 metadata）。

后台策略按**当前会话归属**判定：human 会话缺省后台（终态后幂等汇报自动到达父会话，禁止 sleep 轮询）、显式 `background: false` 同步等待；`bot` / `helm` 自动化会话缺省同步、显式 `background: true` 拒绝。`helm workflows run` 动作与模型工具的 `background` 是不同参数、不同入口。

### 动作（13 个，五端复用）

| 动作 | CLI 映射 | 说明 |
| :--- | :--- | :--- |
| `list` | `helm workflows list` | 列出已保存定义（每条携带真实文件事实 `updatedAt` / `size`；元数据非法条目保留并附 `metadataError`） |
| `get` | `helm workflows get <name>` | 读取完整定义（只读源码 + 元数据；Web/AI 只读，不提供编辑） |
| `save` | `helm workflows save [nameOrFile]` | `script`（位置参数为本地脚本文件时自动读入）或 `--from-run-id` 二选一；缺省名用 `meta.name`；默认拒绝覆盖，`--overwrite` 才覆盖；保存前语法预检，原子写入 |
| `delete` | `helm workflows delete <name>` | 删除定义文件（历史运行记录不受影响）；防目录外符号链接 |
| `run` | `helm workflows run [nameOrFile]` | 启动运行；新 run 必须显式指定会话（CLI `--current` 或 `--conversation-id`）；`--wait` 同步等终态 |
| `runs` | `helm workflows runs` | 列出运行记录，支持按会话过滤 |
| `inspect` | `helm workflows inspect <runId>` | 单个运行详情（节点状态 + 进度时间线） |
| `abort` | `helm workflows abort <runId>` | 中止运行中的工作流或后台子代理 |
| `steer` | `helm workflows steer <runId> --text` | 向在途后台子代理插话纠偏；原生执行经内核 guarded 端口按归属与 CAS 水位提交，外部执行按节点 `controls.steer` 委托目标插件并如实返回 `guardLevel`（`preflight` / `cas`）；`steered=true` 仅代表投递成功 |
| `detach` | `helm workflows detach <runId>` | 把运行中的**前台同步** run 转入后台：阻塞中的工具调用立即返回后台句柄，终态 followUp 汇报；仅 running 且前台同步标记的 run 可转，run 发起会话必须 human-owned |
| `cleanup_worktree` | `helm worktrees cleanup` | 与工具同款；选择器 `--worktree-id` / `--conversation-id` / `--path [--node-id]` 三选一互斥 |
| `list_worktrees` | `helm worktrees list` | 受管工作树登记（含已清理记录的元数据） |
| `inspect_worktree` | `helm worktrees inspect <worktreeId>` | 只读检视：登记元数据 + 目标节点真实 git 只读探测（状态/统计/有上限 diff 预览）；仅登记记录可检视 |

`run` 与 `cleanup_worktree` 对会话目标有显式冲突校验：输入 `conversationId` 与调用上下文同时存在且不一致时显式 `400 validation_error`。

### 前端贡献

- `toolView`：`subagent-card`（`replaceRow: true`）与 `workflow-card`（`replaceRow: true`，含「保存为工作流」「断点恢复」「重放」入口）；
- `timelineRenderer` `background-report`：后台结算汇报折叠卡；
- `slot` `active-tray`（Composer 停靠区）与 `workbenchPanel` `tasks`（badge 绑定 `run-badges`）；
- `sidebarItem` + `screen` `library`：工作流库全屏视图（只读浏览、显式选择目标会话运行、两步确认删除；无编辑器，「让 AI 修改」仅提供可复制请求文本）。

## 配置与数据边界

| 配置 | 类型 | 缺省 | 说明 |
| :--- | :--- | :--- | :--- |
| `maxConcurrentAgents` | integer | 按 CPU 并行度计算（2..32） | 单个 run 的并发 agent 上限（1..128） |
| `maxSubagentDepth` | integer | 2 | 受管子代理嵌套深度上限（1..5）；主会话为第 0 层，变更只影响新派生任务树 |

状态分布在五个文档，按消费面精确划分：

| 文档 | 类型 | 内容 |
| :--- | :--- | :--- |
| `records` | 私有 `ctx.doc` | run 索引 + 每 run 完整记录（引擎唯一持久层，重启恢复同一命名空间） |
| `worktree-state` | 私有 `ctx.doc` | Worktree 登记表 + durable 租约表 + agentId 绑定表；停用期间不清除 |
| `subagent-conversations` | 私有 `ctx.doc` | 受管子代理登记表（`depth` / `parentConversationId` / 子树上限），深度契约唯一事实来源 |
| `runs` | 公开 `ctx.sessionDoc` | 当前会话及后代发起的 run 投影；专用 SSE 按会话订阅，不进全局首帧 |
| `run-badges` | 公开 `ctx.doc` | 每会话紧凑角标（`count / tone / footerText`），有意全局 |

工作流定义文件唯一存储真源是 `<ctx.dataDir>/workflows/<name>.js`。引擎经 `emitEvent` 发布 `workflow.updated`（全局仅状态失效提示）与 `workflow.settled`（完整 summary，`broadcast: false` 进程内分发，`builtin:herdr` 监听它做双轨保活清理）。

**嵌套深度契约**：受管子代理（经 `subagent` / 编排引擎 / 任何 `agent_spawn` 管道派生、`onResolved` 回传 `conversationId` 的子会话）默认可嵌套 2 层，达到子树上限即编排叶子。三道防线：`before_turn` 剥离叶子回合的派工工具、工具/动作入口前置拒绝（`403 subagent_depth_exceeded`）、`agent_spawn` 钩子（priority 300）兜底。会话级 `conversations fork` 与 SuperAgent Worker 不进登记表、不受限。DSL `workflow()` 脚本组合深度保持一层限制，与子代理层级分别计数。

## 停用与失败语义

- **liveTasks**：运行中 run 以 `workflow:<runId>` 标签声明——停用本插件时 `409 plugin_has_live_tasks` 硬阻断，不可 force；
- **两阶段崩溃恢复**：阶段一 `prepareRecovery`（全局 prepare 屏障内，先于任何服务 start）只落持久 abort 标记，不唤醒 SDK 调度器、不提交输入；阶段二 `init`（全部插件 prepare 完成后）终止遗留子任务、把遗留 `running` 显式标 `failed(interrupted)`（subagent 类附 resume 提示、DSL 类附 `resumeFromRunId` 提示）、补发崩溃前未通知的父会话汇报；
- **受控停用**：先置 stopping 拦截后台回调，await 引擎 close，再做最终 runs 投影并 `await records.flush()`；投影是派生观察面，持久层损坏时发显式 notification 后不阻断拆毁；
- **级联取消**：`turn_settled`（outcome=aborted）取消该会话子树内在途 run；受管子会话中止一律经 `abortConversationGuarded` 内核原子复核（human 红线）；
- **Worktree 租约 fail-closed**：分配路径在 `git worktree add` 副作用之前持久登记占位，崩溃后不能证明停止就阻塞清理（`worktree_execution_unknown`），一切未知状态保留租约。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口（组装与文档声明） | `packages/plugins/src/workflow.ts` |
| 引擎 / 隔离 / 钩子 / 动作 / 工具 / UI | `packages/plugins/src/workflow/`（`engine/`、`isolation*.ts`、`hooks.ts`、`actions*.ts`、`tools*.ts`、`ui.ts`、`worktree*.ts`） |
| 插件配置 Schema | `packages/plugins/src/workflow/config.ts` |
| 共享契约（run/doc/worktree/meta 形状） | `packages/plugins/src/contracts.ts` |
| 主要测试 | `packages/plugins/test/workflow*.test.ts`（引擎、恢复重放、steer、detach、abort 级联、库管理）、`native-worktree.test.ts`、`worktree-process-usage.test.ts`、`workflow-shutdown.integration.test.ts`、`background-restart.integration.test.ts` |

## 相关文档

- [原生 JavaScript DSL 手册](../workflows/dsl-guide.md)：`agent` / `parallel` / `pipeline` / `phase` 语法与确定性约束
- [Git Worktree 与代码门禁](../workflows/worktree-and-gate.md)：Worktree 生命周期、租约与 Gate 验收
- [状态流水与故障恢复](../workflows/journaling-recovery.md)：journal 记账、前缀重放与断点续跑语义
- [Herdr 终端协同](herdr.md)：外部运行时执行体如何被编排消费
