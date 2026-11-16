# SuperAgent 双层中枢插件

`builtin:superagent` 解决「人类不想逐条回答派工问题、系统要有人兜底巡检」的问题：双层中枢 = 总控路由会话（Router）+ 驻留后台 Worker + RecallGraph 记忆图谱，外加一套自管的两层巡检看门狗（Watchdog）。适合把批量任务、长期值守和自动恢复交给中枢的使用者。它与 `builtin:workflow` 的受管子代理是两套并行机制：Worker 经 `dispatch_worker` 派生（`createConversation`，不经 `agent_spawn` 管道），不进深度登记表。

## 当前状态

默认停用，显式 `helm plugins enable builtin:superagent` 启用。启用时自举两个常驻 Profile（`superagent` 中枢、`watchdog` 看门狗，含 SYSTEM.md 资产与 `watchdog-playbooks` 技能包），创建两个受管会话（`manageConversation` 删除保护、归属标记 `helm`）。停用期间 `helm.rewind` 造成的 RecallGraph 漂移在下次启用时分页重放补偿。

## 能力和入口

### 路由与 Worker

- **L0 确定性路由（`trigger` 钩子）**：`mutedSources` 命中的事件 0-Token 丢弃；`threadKey` 命中活跃 Worker 订阅时 `transform` 直投该 Worker（0ms 直通）；失效订阅清理后回落常规路由；无显式目标的信封缺省路由中枢会话。
- **路由收敛模式**（`routerMode`，默认开启）：`before_turn` 对中枢会话剥离重度阻塞工具（`edit / write / bash / subagent / SubagentWorkflow`）并注入 `<active_workers>` 态势段落；`tool_call` 钩子二次守卫。中枢保持轻量回合，耗时执行全部发生在 Worker 会话。
- **输入 origin 追踪与自动汇报**：Worker 回合 `turn_settled` 时先写 RecallGraph；本回合消费输入含 `agent` / `trigger` 来源即向中枢投递结构化汇报卡（`meta.renderer: 'superagent:worker-report'`，前端 timelineRenderer 渲染）；纯 `human` 回合仅静默更新图谱。
- **RecallGraph**：公开文档 `recall-graph` 持久化结算节点（会话 / profileId / completionSeq / inputIds / outcome / 摘要 / 产物元数据 / 关键词）。`helm.rewind` 回退输入时（实时事件 + 启用期重放补偿）`omittedInputIds` 命中节点即时删除。

### 动作与工具（五端复用）

| 入口 | 形态 | 说明 |
| :--- | :--- | :--- |
| `dispatch_worker` | 动作（仅 superagent Profile 会话） | 非阻塞派生后台 Worker（立即返回 `workerConversationId`，绝不同步等待模型回合） |
| `inspect_worker` | 动作 | 读取 Worker 最近时间线摘要与产物列表 |
| `recall_context` | 动作 | 检索 RecallGraph（多词 AND） |
| `subscribe_thread` / `archive_worker` | 动作 | threadKey 订阅绑定（冲突显式拒绝不抢占）/ 归档已完成 Worker（解绑订阅、标签换 `worker-archived`；运行中拒绝） |
| `set_router_mode` | 动作 | 持久修改路由收敛模式（写插件配置，即时生效） |
| `watchdog_inspect` / `watchdog_recover` / `watchdog_abort` | 工具 + 同名动作 | L2 认知排障专属工具；`scope` 限定 watchdog Profile 且执行期核对会话 ID；`inspect` 附会话 cwd 进程占用快照（`activeProcesses`，探测失败不伪造空清单） |
| `watchdog_tick` | 动作 | 手动触发一次巡检 |

`dispatch_worker` 是本插件专属协议，与 `subagent` 的 `background` 参数无关、不得当作通用后台派生入口。Worker 会话属 `ownedBy: 'helm'` 自动化会话，其派生任务按归属策略缺省同步。

### 两层巡检看门狗

巡检完全由插件自有 `ctx.service` 驱动（内核无巡检定时器、无 `watchdog_tick` Hook）。singleflight 定时 tick（默认 15s）流程：

- **Layer 1 机械探针（0-Token 规则表）**：经 `ctx.host` 只读端口与真实事件驱动的会话活动统计构造原生会话事实，再以 `diagnostics.collect` 进程内事件（`broadcast: false`，await 全部监听器）采集外部探针——`builtin:herdr` 监听该事件追加自有窗格探针。按确定性规则表处置：

| 异常形态 | 处置 |
| :--- | :--- |
| owned 会话 blocked 且无待答 Ask | `bridge_to_ask` 创建恢复/中止确认 |
| owned 会话超长停滞（≥ `abortAfterMs`，默认 30 分钟） | `auto_abort_and_notify` + 唤醒 L2 |
| 持续 error 或连续错误达 `errorThreshold`（默认 3） | `wake_watchdog` |
| 停滞达 `stalledAfterMs`（默认 5 分钟） | `wake_watchdog` |
| human 归属异常 / 外部窗格无权威 seq | 仅只读通知 |
| `workflow_run` 失败探针（helm 归属，冷却期满） | `auto_resume` 断点续跑 |

去重状态持久化于私有 doc：同 `(targetKind, nodeId, targetId, stateChangeSeq)` 同类动作恰好一次，跨重启不重复危险动作；文档损坏显式报错拒绝巡检。`workflow_run` 续跑链路：冷却退避按已续跑次数 0/1/2 → 2/5/15 分钟，达 3 次上限交人类；每 tick 最多恢复 1 个且最旧失败优先；经 `host.invokeAction('builtin:workflow', 'run', { resumeFromRunId, ... })` 从断点恢复。

- **Layer 2 认知推理**：把异常事实（XML 转义防逃逸）投递看门狗会话，结合 `watchdog-playbooks` 技能推理根因，经上述三个专属工具落地处置。

### 归属权红线（内核执行层强制）

`ownedBy: 'human'` 的人类直连会话与 Herdr 终端窗格**严禁发送任何按键或中止指令**，仅允许只读诊断与通知。一切自动化中止/提交统一走内核 `abortConversationGuarded` / `submitInputGuarded`：探针观测的 `ownedBy` 与 `stateChangeSeq` 随调用传入，内核在会话串行域内、第一个不可逆动作前原子复核。外部窗格的中止只能经核对 `facts.parentConversationId` 指向的 owned 原生工作会话后对该会话 abort。外部探针 `stalledBasis='since-last-state-change'` 只反映状态翻转间隔，绝不单独作为自动中止证据。看门狗自身绝不做探针目标，防自巡检死循环。

## 配置与数据边界

| 配置 | 类型 | 缺省 | 说明 |
| :--- | :--- | :--- | :--- |
| `routerMode` | boolean | true | 中枢路由收敛模式 |
| `mutedSources` | string | 空 | 逗号/换行分隔的精确事件源名，命中即 0-Token 丢弃 |
| `watchdogEnabled` | boolean | true | 关闭后不执行 Watchdog 巡检策略 |
| `stalledAfterMs` | number | 300000 | 停滞判定 |
| `abortAfterMs` | number | 1800000 | 自动中止（须 ≥ 停滞判定） |
| `errorThreshold` | number | 3 | 连续报错唤醒阈值 |

公开文档：`index`（workers + 常驻会话 ID）、`subscriptions`（threadKey 绑定）、`recall-graph`、`routing`（routerMode 只读镜像，UI 数据源；真实配置唯一来源是插件配置）。私有文档：看门狗去重状态。

## 停用与失败语义

停用后：中枢/看门狗工具与动作、UI 贡献、受管 Profile 会话站位即时消失；受管会话释放管理权（`manageConversation` 解除），已创建 Worker 会话不删除。`liveTasks` 声明在途后台任务与 working/blocked 的 Worker/常驻会话——停用遇在途即 `409 plugin_has_live_tasks`。常驻会话记录的 profileId 与实际不符时显式 `409 superagent_resident_conversation_conflict` 拒绝占用，要求人工核对。错误汇报链（reportError）投递失败如实记日志，不吞。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口 | `packages/plugins/src/superagent.ts` |
| 领域契约 / 路由钩子 / 动作 | `packages/plugins/src/superagent/contracts.ts`、`hooks.ts`、`actions.ts` |
| RecallGraph / 结算摘要 | `packages/plugins/src/superagent/recall.ts`、`settlement.ts` |
| 看门狗组合根与子模块 | `packages/plugins/src/superagent/watchdog.ts`、`watchdog-*.ts` |
| Profile / 技能资产 | `packages/plugins/src/superagent/assets/` |
| 测试 | `packages/plugins/test/superagent*.test.ts`（含 watchdog 巡检、resume、rewind、probe、tick shutdown 与 integration） |

## 相关文档

- [工作流与子代理编排](workflow.md)：受管子代理与 `auto_resume` 消费的 `run` 动作
- [Herdr 终端协同](herdr.md)：外部窗格探针的采集方
- [微内核架构总览](../architecture/overview.md)：内核无巡检定时器的架构边界
