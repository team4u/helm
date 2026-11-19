# 工作流与子代理编排插件

`builtin:workflow` 默认启用。委派一个子任务时用 `subagent`，要固定一连串步骤时用 `SubagentWorkflow` 或 `helmx workflows run`。运行记录可在会话工作台查看。需要执行真实测试来验收代码时，可以为子代理分配 Git worktree，并指定一条测试命令。 [第一个工作流](../getting-started/first-workflow.md) · [JavaScript 编排 API](../workflows/dsl-guide.md)

插件负责创建和清理受管工作树。`isolation: 'worktree'` 到达原生执行路径时若仍未由插件处理，会返回 `unsupported_runtime`。 [工作树与门禁](../workflows/worktree-and-gate.md)

### 模型工具（3 个）

- **`subagent`**：派生子代理。支持 `fork: true` 从父会话上下文分叉、`isolation: 'worktree'` 隔离工作树、`resume` 续接（凭 `execution.conversationId` / `executionId`）、`schema` 结构化输出、`gate` 验收命令、`model` / `effort` 覆盖、`maxSubagentDepth` 显式授予派生深度；
- **`SubagentWorkflow`**：确定性 DSL 编排（内联 `script` / `scriptPath` / 已保存 `name`），journal 账本支持 `resumeFromRunId` 断点恢复；
- **`cleanup_worktree`**：清理受管隔离 Git Worktree（错误分支绝不伪造 metadata）。

后台策略按**当前会话归属**判定：human 会话缺省后台（终态后幂等汇报自动到达父会话，禁止 sleep 轮询）、显式 `background: false` 同步等待；`bot` / `helmx` 自动化会话缺省同步、显式 `background: true` 拒绝。`helmx workflows run` 动作与模型工具的 `background` 是不同参数、不同入口。

### 动作（14 个，五端复用）

| 动作 | CLI 映射 | 说明 |
| :--- | :--- | :--- |
| `list` | `helmx workflows list` | 列出已保存定义（每条携带真实文件事实 `updatedAt` / `size`；元数据非法条目保留并附 `metadataError`） |
| `get` | `helmx workflows get <name>` | 读取完整定义（只读源码 + 元数据；Web/AI 只读，不提供编辑） |
| `save` | `helmx workflows save [nameOrFile]` | `script`（位置参数为本地脚本文件时自动读入）或 `--from-run-id` 二选一；缺省名用 `meta.name`；默认拒绝覆盖，`--overwrite` 才覆盖；保存前语法预检，原子写入 |
| `delete` | `helmx workflows delete <name>` | 删除定义文件（历史运行记录不受影响）；防目录外符号链接 |
| `run` | `helmx workflows run [nameOrFile]` | 启动运行；新 run 必须显式指定会话（CLI `--current` 或 `--conversation-id`）；`--wait` 同步等终态；`--resume-from-run-id` 同时支持失败 DSL 工作流与具可续接句柄的 `failed/aborted` 单子代理 |
| `runs` | `helmx workflows runs` | 列出运行记录，支持按会话过滤 |
| `inspect` | `helmx workflows inspect <runId>` | 单个运行详情（节点状态 + 进度时间线） |
| `abort` | `helmx workflows abort <runId>` | 中止运行中的工作流或后台子代理 |
| `steer` | `helmx workflows steer <runId> --text` | 向在途后台子代理插话纠偏；原生执行经内核 guarded 端口按归属与 CAS 水位提交，外部执行按节点 `controls.steer` 委托目标插件并如实返回 `guardLevel`（`preflight` / `cas`）；`steered=true` 仅代表投递成功 |
| `detach` | `helmx workflows detach <runId>` | 把运行中的**前台同步** run 转入后台：阻塞中的工具调用立即返回后台句柄，终态 followUp 汇报；仅 running 且前台同步标记的 run 可转，run 发起会话必须 human-owned |
| `resume_failed` | `helmx workflows resume-failed` | 批量续接指定会话（`--conversation-id` / `--current`）或全局（`--all`）下所有可恢复的 `failed` 工作流与后台单子代理；不可恢复项如实记入 `skipped` |
| `cleanup_worktree` | `helmx worktrees cleanup` | 与工具同款；选择器 `--worktree-id` / `--conversation-id` / `--path [--node-id]` 三选一互斥 |
| `list_worktrees` | `helmx worktrees list` | 受管工作树登记（含已清理记录的元数据） |
| `inspect_worktree` | `helmx worktrees inspect <worktreeId>` | 只读检视：登记元数据 + 目标节点真实 git 只读探测（状态/统计/有上限 diff 预览）；仅登记记录可检视 |

`run`、`resume_failed` 与 `cleanup_worktree` 对会话目标有显式冲突校验：输入 `conversationId` 与调用上下文同时存在且不一致时显式 `400 validation_error`；`resume_failed` 同时要求 `conversationId` 与 `all: true` 互斥。

### 前端贡献

- `toolView`：`subagent-card`（`replaceRow: true`）与 `workflow-card`（`replaceRow: true`，含「保存为工作流」「断点恢复」「重放」入口）；时间线单行与折叠 `SubagentLiveCard` 通过 `includeDetail: false` 跳过子会话全量详情拉取，仅展开态按需加载；子代理结果优先读取宿主 `pluginToolResult` 镜像到 `details` 的结构化 `structuredOutput`（零 `[subagent ...]` 尾注文本刮取），并使用宿主共享 1Hz 时钟 `useSharedNowMs`；
- `timelineRenderer` `background-report`：后台结算汇报折叠卡，直接解析入口 `data.meta.report` 结构化载荷；
- `slot` `active-tray`（Composer 停靠区）与 `workbenchPanel` `tasks`（badge 绑定 `run-badges`，工作台与停靠区统一以 `runs` 为唯一执行树根来源，人类 `fork` 与 SuperAgent 驻留 Worker 不进入工作流树；运行卡折叠仅渲染 `resultPreview`，点击展开才调 `inspect` 按需拉取并缓存完整 `result`）；
- `sidebarItem` + `screen` `library`：工作流库全屏视图（只读浏览、显式选择目标会话运行、两步确认删除；无编辑器，「让 AI 修改」仅提供可复制请求文本）。

## 配置与数据边界

| 配置 | 类型 | 缺省 | 说明 |
| :--- | :--- | :--- | :--- |
| `maxConcurrentAgents` | integer | 按 CPU 并行度计算（2..32） | 单个 run 的并发 agent 上限（1..128） |
| `maxSubagentDepth` | integer | 2 | 受管子代理嵌套深度上限（1..5）；主会话为第 0 层，变更只影响新派生任务树 |
| `autoRecoverOnRestart` | boolean | `true` | Hub 重启后尝试恢复在途任务。设为 `false` 或 `HELMX_AUTO_RECOVER=0` 时，关停会中止任务，启动时会把遗留的运行标为失败。 |

状态分布在五个文档，按消费面精确划分：

| 文档 | 类型 | 内容 |
| :--- | :--- | :--- |
| `records` | 私有 `ctx.doc` | run 索引 + 每 run 完整记录（引擎唯一持久层，重启恢复同一命名空间） |
| `worktree-state` | 私有 `ctx.doc` | Worktree 登记表 + durable 租约表 + agentId 绑定表；停用期间不清除 |
| `subagent-conversations` | 私有 `ctx.doc` | 受管子代理登记表（`depth` / `parentConversationId` / 子树上限），深度契约唯一事实来源 |
| `runs` | 公开 `ctx.sessionDoc`（`durable: false`） | 纯内存瞬态投影：当前会话及后代发起的 run 分片（专有 SSE 订阅，单分片 `MAX_PROJECTED_RUNS_PER_CONVERSATION = 100` 保留全部 `running` + 最新终态，剥离完整 `result` 仅保留 `hasResult`/`resultPreview` 并附带 `errorCode`/`resumable`）；启动时自 `records` 重建，停用不落盘 |
| `run-badges` | 公开 `ctx.doc`（`durable: false`） | 纯内存瞬态投影：基于全量运行态聚合的每会话紧凑角标（`count / tone / footerText`，不受 100 条分片滑窗影响）；启动时自 `records` 重建，停用不落盘 |

工作流定义文件唯一存储真源是 `<ctx.dataDir>/workflows/<name>.js`。引擎经 `emitEvent` 发布 `workflow.updated`（全局仅状态失效提示）与 `workflow.settled`（完整 summary，`broadcast: false` 进程内分发，`builtin:herdr` 监听它做双轨保活清理）。

**嵌套深度契约**：受管子代理（经 `subagent` / 编排引擎 / 任何 `agent_spawn` 管道派生、`onResolved` 回传 `conversationId` 的子会话）默认可嵌套 2 层，达到子树上限即编排叶子。三道防线：`before_turn` 剥离叶子回合的派工工具、工具/动作入口前置拒绝（`403 subagent_depth_exceeded`）、`agent_spawn` 钩子（priority 300）兜底。会话级 `conversations fork` 与 SuperAgent Worker 不进登记表、不受限。DSL `workflow()` 脚本组合深度保持一层限制，与子代理层级分别计数。

## 停用与失败语义

- 有任务正在运行时，停用插件会返回 `409 plugin_has_live_tasks`，`--force` 也无法继续。
- Hub 重启时，默认保留可恢复的 `running` 任务。启动阶段会在调度器恢复前为无法原位恢复的子会话写入中止标记，再重新接上符合条件的后台子代理与工作流，并补发未送达的汇报。关闭自动恢复、连续崩溃超过上限或遇到未确认的动作副作用，都会改变恢复结果。 [Hub 重启恢复](../workflows/journaling-recovery.md#hub-重启恢复)
- 插件停用时先停止发布 `runs` 和 `run-badges`，再关闭引擎并等待 `records.flush()`。持久记录损坏时发出通知。
- 父会话中止后，`turn_settled` 会取消其子树里的在途运行。中止受管子会话前，内核用 `abortConversationGuarded` 复核会话归属。
- 工作树租约会在 `git worktree add` 前持久登记。崩溃后无法确认执行已经停止时，清理会返回 `worktree_execution_unknown` 并保留租约。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口（组装与文档声明） | `packages/plugins/src/workflow.ts` |
| 引擎 / 隔离 / 钩子 / 动作 / 工具 / UI | `packages/plugins/src/workflow/`（`engine/`、`isolation*.ts`、`hooks.ts`、`actions*.ts`、`tools*.ts`、`ui.ts`、`worktree*.ts`） |
| 插件配置 Schema | `packages/plugins/src/workflow/config.ts` |
| 共享契约（run/doc/worktree/meta 形状） | `packages/plugins/src/contracts.ts` |
| 主要测试 | `packages/plugins/test/workflow*.test.ts`（引擎、恢复重放、steer、detach、abort 级联、库管理及迁移至此的客户端模型/组件/样式/工作树检视测试）、`native-worktree.test.ts`、`worktree-process-usage.test.ts`、`workflow-shutdown.integration.test.ts`、`background-restart.integration.test.ts` |

## 相关文档

- [Swarm 对等协同](swarm.md)：复用了本插件受管 Worktree 租约的横向对等协同黑板
- [原生 JavaScript DSL 手册](../workflows/dsl-guide.md)：`agent` / `parallel` / `pipeline` / `phase` 语法与确定性约束
- [Git Worktree 与代码门禁](../workflows/worktree-and-gate.md)：Worktree 生命周期、租约与 Gate 验收
- [状态流水与故障恢复](../workflows/journaling-recovery.md)：journal 记账、前缀重放与断点续跑语义
- [Herdr 终端协同](herdr.md)：外部运行时执行体如何被编排消费
