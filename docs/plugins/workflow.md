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

## 五端动作（8 个）

| 动作 | CLI 映射 | 说明 |
| :--- | :--- | :--- |
| `list` | `helm workflows list` | 列出已保存的工作流定义 |
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
| `config` | 私有 `ctx.doc` | 预留的显式扩展配置（`maxSubagentDepth?`，缺省 2；启动即校验 1..5，非法值显式失败） | 仅插件内部；当前无写入端，为配置面预留 |
| `runs` | 公开 `ctx.sessionDoc` | 每父会话自身的 run 列表投影 | 不进全局首帧/全局 SSE；前端经专用 SSE 按会话订阅 |
| `run-badges` | 公开 `ctx.doc` | 每会话紧凑角标（`count / tone / footerText`，如「2 运行中 · 1 失败」） | 有意全局：工作台导航角标需要跨会话可见；完整 run 摘要绝不进入 |

不存在内存降级或内核私有存储注入：所有运行态经 `records` 落 state.sqlite，重启后恢复。runs 投影带值缓存（JSON 直比，值不变跳过写入、不发重复事件）；已删除的父会话不重建孤儿分片（store 级联清理），无 runs 的已持久会话清到空而非保留旧投影。

引擎经 `emitEvent` 发布两个事件：`workflow.updated`（全局只发状态失效提示 `{run: {id, conversationId, status}}`，详情走会话投影订阅）与 `workflow.settled`（完整 summary，`broadcast: false` 进程内分发，`builtin:herdr` 的双轨保活清理监听它）。

## 嵌套深度契约

受管子代理（经 `subagent` 工具 / 编排引擎 / 任何 `agent_spawn` 管道派生、`onResolved` 回传 `conversationId` 的子会话）默认可嵌套 `DEFAULT_MAX_SUBAGENT_DEPTH`（2）层：主会话直接派生一层，一层子代理默认可继续派生二层，达到子树上限的会话即编排叶子。fork 会话与 SuperAgent worker（经 `createConversation` 创建，不经 spawn 管道）不进登记表，不受限制。

三道防线共用登记表事实：`before_turn` 对叶子回合剥离 `subagent` / `SubagentWorkflow`（一层子代理保留派工工具与协作目录）；工具与 `run` 动作入口在创建任何 run 记录前拒绝（`403 subagent_depth_exceeded`，携带 `depth` / `maxSubagentDepth` 事实）；`agent_spawn` 钩子（priority 300，先于 worktree 分配）兜底拒绝并登记新事实。

显式扩展到更深层：插件配置（私有 `config` doc 的 `maxSubagentDepth`，1..5）改全局缺省；派生请求（`subagent` 工具入参 / DSL `agent({ maxSubagentDepth })` / `AgentSpawnRequest.maxSubagentDepth`）显式授予子树上限——该字段只授予子树空间，不能为发起方自己解限，且统一钻制在 `HARD_MAX_SUBAGENT_DEPTH`（5）内；协议不要求每次传参，缺省零参数可用。旧登记记录缺省 `depth` / 上限字段时按 `depth=1`、默认上限兼容解读。

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

插件注册三个 client.tsx 视图（组件经 `usePluginSessionDoc` 自行订阅 runs 分片，动作经 `ctx.callAction`，零宿主私有依赖）：

- `toolView` `subagent-card`（`replaceRow: true`）：时间线内 subagent 工具调用的双层胶囊实时卡，多次 resume 折叠展示；
- `toolView` `workflow-card`（`replaceRow: true`）：时间线内 SubagentWorkflow 调用的工作流运行卡；已保存定义发起的已完成 run 提供「重跑」（全新运行，非断点恢复），失败/中止 run 提供「断点恢复」（仅同 run journal 前缀重放，沿用原脚本与 args）；
- `workbenchPanel` `tasks`：工作台面板（工作流库 + 当前会话工作流运行 + 子代理列表），`badge` 绑定 `run-badges` 文档驱动动态角标。工作流库经 `list` 动作展示已保存定义并支持在当前会话选择运行（args 输入严格 JSON 解析）；有 worktree 的节点卡提供可折叠只读改动概览（`inspect_worktree`）与「让主会话审阅并合入」（仅向父会话提交审阅请求文本，Web 端不执行 git 写操作）。

## 延伸阅读

- [原生 JavaScript DSL 手册](../workflows/dsl-guide.md)：`agent` / `parallel` / `pipeline` / `phase` 语法与确定性约束
- [Git Worktree 与自动化门禁](../workflows/worktree-and-gate.md)：代码沙箱隔离与测试门禁验收
- [状态流水与意外恢复](../workflows/journaling-recovery.md)：执行账本、前缀重放与断点续跑语义
