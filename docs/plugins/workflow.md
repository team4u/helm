# 工作流与子代理编排插件

`builtin:workflow` 是 Helm 确定性多智能体编排与受管 Git Worktree 的权威承载插件（默认启用、非 locked 可停用）。内核不持有任何编排语义：DSL 运行时、journal 重放、`WorktreeAllocator` 全量生命周期（租约分配、断点续接与安全清理）都是本插件的私有资产，跨 spawn 的通用边界才留在内核侧 `runtime/spawn`。本文给出插件的能力面、状态持久化设计与崩溃恢复时序；DSL 语法、账本重放与 Worktree/Gate 的深度指南见 `docs/workflows/` 三篇（[dsl-guide](../workflows/dsl-guide.md) · [worktree-and-gate](../workflows/worktree-and-gate.md) · [journaling-recovery](../workflows/journaling-recovery.md)）。

## 模型工具（3 个）

| 工具 | 核心入参 | 语义 |
| :--- | :--- | :--- |
| `subagent` | `prompt` 必填；`agentType`（Profile ID 或 `herdr:agy` 等外部运行时标识）、`cwd`、`background`、`isolation: 'worktree'`、`schema`、`gate`、`resume`、`model`、`effort`、`attachments`、`maxSubagentDepth`（显式授予子树深度上限，1..5，缺省继承 2） | 派生单个子代理。缺省同步等待最终结果；`background: true` 在执行环境就绪后立即返回 `runId`，后台完成后向父会话汇报 |
| `SubagentWorkflow` | `script / scriptPath / name` 三择一；`args` 任意 JSON（字符串形 JSON 自动解包）；`resumeFromRunId` | 在当前会话执行确定性编排脚本，返回真实执行 summary（runId/status/nodes/result） |
| `cleanup_worktree` | `worktreeId`（`node:path`）/ `conversationId` / `path`（可附 `nodeId` 消歧）三择一；`deleteBranch`、`force` | 清理一个受管隔离 Git Worktree；无任何显式选择器时以当前会话为选择器（`--current` 语义） |

三个工具均返回结构化输出（`structuredOutput`），失败分支显式 `isError` 并附完整错误信息，绝不伪造空元数据。`subagent` 的 `resume` 凭上次执行的 `execution.conversationId` 或 `execution.executionId` 续接同一执行上下文；后台汇报经 `submitInput` 携带幂等 `requestId`（`helm:subagent-report:<runId>`），跨重启不重复投递。

后台子代理的汇报链路有完整的诚实性设计：父会话已被删除时，汇报降级为全局 notification 通知（「后台任务已结束，可在任务列表检查结果」）；其余故障（store/IO/权限）如实上抛，由引擎 outbox（`notifiedAt` 不置位）在下次 `init` 时补发，绝不吞错。

## 五端动作（11 个）

工作流定义是跨会话可复用资产，唯一存储真源是 `<ctx.dataDir>/workflows/<name>.js` 文件目录（无 catalog/state 副本）；`get` / `save` / `delete` 是这组资产的完整管理面，创建与修改全部由 AI / CLI 经动作完成，Web 端只读。

| 动作 | CLI 映射 | 说明 |
| :--- | :--- | :--- |
| `list` | `helm workflows list` | 列出已保存的工作流定义（每条携带真实文件事实 `updatedAt` / `size`；元数据非法的条目保留并附 `metadataError`） |
| `get` | `helm workflows get <name>` | 读取完整定义（只读源码 + 元数据 + 文件事实）；供 Web 只读展示与 AI 读取，不构成编辑能力；不存在 404 |
| `save` | `helm workflows save [nameOrFile]` | 保存定义：`script`（位置参数为本地脚本文件时自动读入）或 `--from-run-id` 二选一；缺省名用脚本 `meta.name`，显式 `--name` 与 `meta.name` 不一致时拒绝；名称安全校验（`SAFE_NAME` 防路径穿越）；保存前做 validateScript 全量检查与 worker 同形状的 compile-only 语法预检（零副作用）；重复保存默认拒绝（`409 workflow_already_exists`），`--overwrite` 才覆盖；原子写入（同目录临时文件 + fsync，新建经 link 原子占位、并发同名创建恰好一个成功，覆盖经 rename 原子替换）；既有目标为越界符号链接时拒绝；返回保存后按真实 fs 重建的摘要（`created` + `workflow`）。`fromRunId` 把持久 RunRecord 中的脚本源固化为定义（内联 run 保存 `script`、文件 run 重读 `scriptPath`）；subagent run 与无脚本源的 run 显式拒绝 |
| `delete` | `helm workflows delete <name>` | 删除定义文件（历史运行记录不受影响）；不存在 404；lstat/realpath 防目录外符号链接，目录条目拒绝 |
| `run` | `helm workflows run [nameOrFile]` | 在指定或当前会话启动运行；新 run 必须显式指定会话（CLI `--current` 或 `--conversation-id`）；位置参数为已保存名或本地脚本文件（自动读入 `script`）；`--wait` 同步等终态 |
| `runs` | `helm workflows runs` | 列出运行记录；支持 `conversationId` 过滤，CLI `--current` 缺省按当前会话过滤 |
| `inspect` | `helm workflows inspect <runId>` | 查看单个运行详情（含节点状态与进度时间线；已保存定义发起的 run 携带 `savedName`） |
| `abort` | `helm workflows abort <runId>` | 中止运行中工作流 |
| `cleanup_worktree` | `helm worktrees cleanup` | 与工具同款语义；选择器三择一互斥，`--force` 清理脏工作树（不可越过占用/归属/locked 校验） |
| `list_worktrees` | `helm worktrees list` | 列出受管工作树登记（含已清理记录的元数据；新建在前） |
| `inspect_worktree` | `helm worktrees inspect <worktreeId>` | 只读检视受管工作树：登记元数据 + 目标节点真实 git 只读探测（未提交文件清单、领先基线提交数、diff 统计与有上限预览）；仅登记记录可检视，不支持任意目录；已清理/目录缺失如实返回 `unavailableReason`，git 失败显式报错（附截断诊断，绝不静默当成功）；diff 固定 `--no-ext-diff --no-textconv` 且仅覆盖 tracked 改动（untracked 文件内容不进 diff，仍完整见于状态清单与 `dirtyFileCount` 真实总数）；预览/统计/状态清单在采集阶段即限内存，超出置 `diffTruncated`/`dirtyFilesTruncated` 或统计末尾截断说明，不假装完整；成功输出与错误诊断均经机密脱敏 |

`run` 与 `cleanup_worktree` 对会话目标有显式冲突校验：输入 `conversationId` 与调用上下文（`--current` / `run_action` / workflow）同时存在且不一致时，显式 `400 validation_error` 拒绝——静默选边等于在调用方不知情下改投目标。

## 状态持久化设计

插件的状态分布在四个层次，按「谁消费、进不进全局流」精确划分：

| 文档 | 类型 | 内容 | 流通范围 |
| :--- | :--- | :--- | :--- |
| `records` | 私有 `ctx.doc` | run 索引 + 每 run 完整记录（引擎唯一持久层） | 仅插件内部，重启恢复读同一命名空间 |
| `worktree-state` | 私有 `ctx.doc` | WorktreeAllocator 登记表 + durable 租约表 + agentId 绑定表 | 仅插件内部；停用期间不清除，重新启用后 cleanup 仍可定位 |
| `subagent-conversations` | 私有 `ctx.doc` | 受管子代理登记表：`depth` / `parentConversationId` / `maxSubagentDepth`（子树上限快照）等派生事实 | 仅插件内部；跨重启持久，是深度契约的唯一事实来源 |
| `runs` | 公开 `ctx.sessionDoc` | 当前会话及其后代发起的 run 列表投影，保留每个 run 的直接发起者 | 不进全局首帧/全局 SSE；前端经专用 SSE 按会话订阅 |
| `run-badges` | 公开 `ctx.doc` | 每会话紧凑角标（`count / tone / footerText`，如「2 运行中 · 1 失败」） | 有意全局：工作台导航角标需要跨会话可见；完整 run 摘要绝不进入 |

不存在内存降级或内核私有存储注入：所有运行态经 `records` 落 state.sqlite，重启后恢复。runs 投影带值缓存（JSON 直比，值不变跳过写入、不发重复事件）；已删除的父会话不重建孤儿分片（store 级联清理），无 runs 的已持久会话清到空而非保留旧投影。

引擎经 `emitEvent` 发布两个事件：`workflow.updated`（全局只发状态失效提示 `{run: {id, conversationId, status}}`，详情走会话投影订阅）与 `workflow.settled`（完整 summary，`broadcast: false` 进程内分发，`builtin:herdr` 的双轨保活清理监听它）。

## 嵌套深度契约

受管子代理（经 `subagent` 工具 / 编排引擎 / 任何 `agent_spawn` 管道派生、`onResolved` 回传 `conversationId` 的子会话）默认可嵌套 `DEFAULT_MAX_SUBAGENT_DEPTH`（2）层：主会话直接派生一层，一层子代理默认可继续派生二层，达到子树上限的会话即编排叶子。fork 会话与 SuperAgent worker（经 `createConversation` 创建，不经 spawn 管道）不进登记表，不受限制。

三道防线共用登记表事实：`before_turn` 对叶子回合剥离 `subagent` / `SubagentWorkflow`（一层子代理保留派工工具与协作目录）；工具与 `run` 动作入口在创建任何 run 记录前拒绝（`403 subagent_depth_exceeded`，携带 `depth` / `maxSubagentDepth` 事实）；`agent_spawn` 钩子（priority 300，先于 worktree 分配）兜底拒绝并登记新事实。

`maxSubagentDepth` 表示相对受管任务树根的绝对层级上限，主会话为第 0 层。默认值为 2，可在插件中心配置，或通过现有 `helm plugins config` 命令读写（范围 1..5 的整数）。配置变更影响新派生的任务树，已有子代理继续沿用登记上限。

主会话可以在 `subagent({ maxSubagentDepth: 3 })` 或 DSL `agent(prompt, { maxSubagentDepth: 3 })` 中为大型任务显式开放到第 3 层。受管子代理只能继承或降低其上限，不能自行提高授权；设置值不得小于本次目标子代理的实际层级。续接不改变父子归属与层级，未传上限时保留原授权，显式设置时重新校验。所有入口均校验硬上限 5，越界或登记损坏时报错，不做兼容读取或猜测。

这项限制只约束受管子代理派生。DSL `workflow()` 的脚本组合深度仍保持原有一层限制，与子代理层级分别计数。

## 两阶段崩溃恢复

重启恢复分两个阶段完成，顺序由宿主全局 prepare 屏障保证：

**阶段一 `prepareRecovery`**（全部服务 `start` 之前）：只读遗留记录，对 running 状态的子会话调用 `prepareInterruptedConversations` 落持久 abort 标记。此阶段**不唤醒 SDK 调度器、不提交任何输入**——此刻其他插件的工具尚未注册，任何输入提交都会产生 orphan 回合。

**阶段二 `init`**（全部插件 prepare 完成后）：终止遗留子任务（等待真实终态，不先回报 interrupted 却让旧回合继续跑）、把遗留 `running` 显式标 `failed(interrupted)`（subagent 类附「可凭 conversationId/executionId 通过 resume 续接」提示；DSL 类附「账本完好，可经 resumeFromRunId 恢复」）、补发崩溃前已达终态但未通知的父会话汇报（outbox 机制，`notifiedAt` 防重复）。随后快照已持久分片集合并同步 runs 投影与角标。

受控停用（`stop`）同样有严格时序：先置 `stopping` 拦截运行期后台回调，`await` 引擎 `close`（在途 run 终态写入私有 records，写入经宿主受控停止窗口放行），再做最终 runs 分片与角标投影并 `await records.flush()` 真实落盘。最终投影是派生观察面——若持久层损坏导致读取失败，发布显式 notification 诊断后不阻断拆毁（引擎终态已在 records，业务读取路径会显式报错，不静默）。

## 在途保护：liveTasks 与 liveWorktrees

`liveTasks()` 返回运行中 run 的 `workflow:<runId>` 标签——停用插件时宿主据此 `409 plugin_has_live_tasks` 硬阻断（不可 force）。

`liveWorktrees()` 返回运行中 run 各节点占用的 `{nodeId, path}`，供本插件 cleanup 链（及未来其他清理方）拒绝误清理在途工作树。它不阻断停用本身，是清理安全机制而非生命周期门禁。

Worktree 隔离经 `agent_spawn` around continuation（priority 200，先于外部运行时接管器如 herdr 的 100 执行 = 更外层）包裹完整派生：在 `next` 前分配/续接/登记租约，外部执行同样被租约与登记包裹。durable 租约 fail-closed：分配路径在 `git worktree add` 副作用**之前**持久登记占位，崩溃后该占位无在途执行即显式 `worktree_execution_unknown` 阻塞清理——不能证明停止就不能清理；释放仅两种（执行确认成功、或确认从未启动），一切未知状态保留租约。

## 前端扩展

插件注册五个 client.tsx 视图（组件经 `usePluginSessionDoc` 自行订阅 runs 分片，动作经 `ctx.callAction`，零宿主私有依赖）：

- `toolView` `subagent-card`（`replaceRow: true`）：时间线内 subagent 工具调用的双层胶囊实时卡，多次 resume 折叠展示；
- `toolView` `workflow-card`（`replaceRow: true`）：时间线内 SubagentWorkflow 调用的工作流运行卡。适合的 run（非 subagent 且非已保存定义发起）提供一键「保存为工作流」（`save fromRunId`，保存名取脚本 `meta.name`；重名 / 校验失败如实报错，绝不伪造成功）。已完成的 DSL run（含内联脚本）提供「重放」表单，经 `resumeFromRunId` 发起新 run，保留原会话；空白沿用原 args，显式 args 经 JSON 校验后覆盖。文件脚本重读最新内容，内联脚本沿用原源码。缓存仅复用调用载荷相同的前缀，首次失配起重新执行；副作用不确定时按引擎契约显式拒绝。失败/中止 run 提供「断点恢复」。重放、恢复和中止在途均防止重复提交。
- `sidebarItem` `workflow-library` + `screen` `library`：工作流库全屏视图（一级主舞台卡片网格 + 右侧标准详情抽屉）。工作流定义是跨会话资产、不属会话 workbench 管理范畴；Screen 只读浏览（`updatedAt` / `size` 文件事实）、`get` 只读源码（`pre`/`code` + 复制，无任何编辑器）、运行（Radix `Select` 显式选择目标会话 + args 严格 JSON 解析）、删除（两步确认）与刷新；「让 AI 修改」仅提供可复制的明确请求文本（经 AI 调用 `save` 写回），不在 Web 内改文件。选中项与搜索词写入 `sp.*` 深链参数（`setParams` 唯一导航）。
- `workbenchPanel` `tasks`：工作台面板（当前会话执行树 + 紧凑工作流库运行入口），`badge` 绑定 `run-badges` 文档。工作流库分节经 `list` 动作展示已保存定义并支持在当前会话运行（每行 args 草稿独立、按会话隔离、严格解析 JSON），并提供到工作流库 Screen 的导航；定义管理（源码/删除）不在此承担。有 worktree 的节点卡与独立子代理卡均提供只读改动概览（`inspect_worktree`），优先按登记 ID 定位，无 ID 时以 path 与节点消歧。审阅按钮仅向父会话提交请求，Web 不执行 git 写操作。Diff 仅覆盖已跟踪文件，未跟踪文件见状态列表；清理按钮使用同一精确选择器并在途禁用。

执行卡片统一使用 `ExecutionNode` 视图模型连接子会话、工作流、动作及外部执行。每个实际执行只计数一次；卡片汇总后代的运行、异常、审批状态，在当前层展示直系子项，深层任务通过抽屉继续查看。审批与后代活动作为独立摘要呈现，工作流自身的结算结果仍以引擎记录为准。

会话抽屉展示祖先路径。点击已在主屏或分屏展示的祖先只关闭抽屉；点击其他祖先在抽屉内切换，保持主屏上下文。`AskDock` 汇集当前会话及后代的待确认项，标注来源；提交仍针对原始 AskDoc 并携带其 CAS 水位线。

## 延伸阅读

- [原生 JavaScript DSL 手册](../workflows/dsl-guide.md)：`agent` / `parallel` / `pipeline` / `phase` 语法与确定性约束
- [Git Worktree 与自动化门禁](../workflows/worktree-and-gate.md)：代码沙箱隔离与测试门禁验收
- [状态流水与意外恢复](../workflows/journaling-recovery.md)：执行账本、前缀重放与断点续跑语义
