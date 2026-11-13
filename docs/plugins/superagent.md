# SuperAgent 双层中枢与看门狗插件

`builtin:superagent` 是实验性双层中枢（可选启用）：一个常驻 SuperAgent 中枢会话承担 0 阻塞总控路由，点名任意 Profile 专家派生后台驻留 Worker 执行长任务；一个常驻巡检看门狗会话配合插件自管服务完成两层巡检与自愈。角色全部经 `profileId` 表达（`superagent` / `watchdog`），不重复打角色 Tag，内核零角色硬编码。

## 常驻会话与自举资产

首次启用时动态创建并持久化两个专属会话（ID 记录于公开文档 `index`，不硬编码）：

| 会话 | profileId | 职责 |
| :--- | :--- | :--- |
| SuperAgent 中枢 | `superagent` | 承接综合需求，识别意图并派工；`skills: []` 禁用全部技能（只做路由调度，不消费排障手册） |
| 巡检看门狗 | `watchdog` | 接收异常事实、按技能规则推理处置；`skills: ['watchdog-playbooks']` 仅可见本插件自举的排障手册 |

插件启动时经 `ctx.host.manageConversation` 接管两个会话（启用期间删除保护，`409 conversation_managed_by_plugin`）并标记归属权 `ownedBy: 'helm'`；停用时自动释放。自举资产（`superagent` / `watchdog` Profile 的 profile.json + SYSTEM.md、`watchdog-playbooks` 技能含 `references/herdr-stalled.md` 与 `references/ci-failure.md`）逐文件幂等补齐，既有文件一律不覆盖。归属冲突防护：记录的会话当前 `profileId` 与期望不符时显式 `409 superagent_resident_conversation_conflict` 拒绝占用，请人工核对。

启用期间还补偿停用遗漏的 `helm.rewind` 联动：分页重放全部有召回节点会话的 rewind 标记，删除 `omittedInputIds` 命中的 RecallGraph 节点；运行期则经 `conversation.entry` 事件实时联动。

## 0 阻塞总控路由

中枢的核心工具经 `ctx.tool` 注册（`scope: { profileIds: ['superagent'] }` 会话过滤 + 执行期二次校验双保险），同名 `ctx.action` 复用同一 handler 供 HTTP / CLI 五端调用：

| 能力 | 形态 | 说明 |
| :--- | :--- | :--- |
| `dispatch_worker` | 工具 + 动作 | 非阻塞派生后台 Worker：`createConversation`（`tags: ['worker']`、父会话为中枢、可选 `profileId` / `title` / `threadKey` / `cwd` / `nodeId`）+ `submitInput(origin: 'agent')` 后立即返回 `workerConversationId`，绝不同步等待模型回合。禁止派生中枢/看门狗 Profile（防自激）；提交失败显式回滚登记与订阅 |
| `inspect_worker` | 工具 + 动作 | 读取 Worker 最近时间线摘要与产物列表 |
| `recall_context` | 工具 + 动作 | 检索 RecallGraph 召回图谱（多词 AND 过滤，limit 1..100） |
| `subscribe_thread` | 工具 + 动作 | 将 threadKey 订阅绑定到指定 Worker（已被活跃 Worker 订阅时显式 `409` 拒绝抢占） |
| `archive_worker` | 动作 | 归档已完成 Worker：`worker` 标签换 `worker-archived`、解绑订阅、移出登记；运行中（working/blocked）或正在结算的 Worker 拒绝归档 |
| `set_router_mode` | 动作 | 持久修改中枢路由收敛模式（写插件配置 `routerMode`，即时生效） |

**路由收敛模式**（`routerMode`，默认开启）下，`before_turn` 对中枢会话剥离重度阻塞工具（`edit / write / bash / subagent / SubagentWorkflow`）并注入 `<active_workers>` 态势段落；`tool_call` 钩子对被剥离工具二次守卫 block（提示改用 `dispatch_worker` 派工）。中枢因此保持轻量回合——所有耗时执行都发生在 Worker 会话。`mutedSources` 配置（逗号/换行分隔的精确 source 名）命中的触发事件在 `trigger` 钩子 0-Token 丢弃。

边界：`dispatch_worker` 是本插件专属的非阻塞 Worker 协议（`createConversation` + `origin: 'agent'` 输入，不经 `agent_spawn` 管道），与 `builtin:workflow` `subagent` 的 `background` 参数无关、不得当作通用后台派生入口使用，也绝不同步等待模型回合；Worker 结果经独立 `turn_settled` → 中枢汇报链回传（见「输入 origin 追踪与自动汇报」）。Worker 会话属 `ownedBy: 'helm'` 自动化会话，其派生任务按归属策略缺省同步。

## 输入 origin 追踪与自动汇报

每次提交的输入携带来源 `origin: 'human' | 'agent' | 'trigger'`。Worker 回合结算时（`turn_settled` 统一覆盖 `completed / failed / aborted` 三态），插件先无条件把结算摘要写入 RecallGraph；随后检查本回合消费输入的来源——只要含任一 `agent` 或 `trigger` 来源，即向中枢投递结构化汇报卡片（`submitInput` 携带 `meta.renderer: 'superagent:worker-report'`，前端经 timelineRenderer 渲染为汇报卡）；纯 `human` 回合仅静默更新图谱，不打扰中枢。汇报失败显式上报错误（reportError 通道同步投递中枢），不吞。

## ThreadKey 0ms 直通路由

`trigger` 钩子实现事件直通：入站信封携带 `threadKey` 且订阅表命中活跃 Worker 时，`transform` 改写 `targetConversationId` 直投该 Worker，跳过中枢意图识别实现零延迟直达；订阅指向已失活的 Worker 时清理失效订阅后回落常规路由。无 threadKey 且无显式目标的信封缺省路由中枢（`superagent` 插件未启用时回落内核缺省策略）。`mutedSources` 命中检查先于一切。

## RecallGraph 召回图谱

公开文档 `recall-graph` 持久化结算节点：每节点含会话 ID、profileId、completionSeq、本回合消费的 inputIds、outcome、摘要、产物元数据与关键词。中枢接受新需求时经 `recall_context` 检索历史任务摘要，优先复用已有上下文的 Worker，减少重复冷启动。`helm.rewind` 回退输入时（`conversation.entry` 事件实时捕获 + 启用期分页重放补偿），`omittedInputIds` 命中的节点即时删除，图谱与会话历史保持一致。

## 两层巡检看门狗

巡检周期完全由插件自有 `ctx.service`（`superagent-watchdog`）驱动——内核不内置巡检定时器、不存在 `watchdog_tick` Hook。singleflight 定时 tick（默认 15s）的流程：

**Layer 1 机械探针（0-Token 规则表）**：先经 `ctx.host` 只读端口（`listConversations` / `getConversationActivity` / `getConversationOwnership`）构造原生会话事实，再以 `diagnostics.collect` 进程内事件（`broadcast: false`，await 全部监听器）采集外部探针——`builtin:herdr` 监听该事件追加自有窗格的真实探针。汇总后按确定性规则表分类处置：

| 异常形态 | 处置 |
| :--- | :--- |
| owned 会话 blocked 且无待答 Ask | `bridge_to_ask`：创建恢复/中止确认 AskDoc |
| owned 会话超长停滞（≥ `abortAfterMs`，默认 30 分钟） | `auto_abort_and_notify` + 唤醒 L2 |
| 持续 error 或连续错误达阈值（`errorThreshold`，默认 3） | `wake_watchdog` 交认知层判断 |
| 停滞达唤醒阈值（`stalledAfterMs`，默认 5 分钟） | `wake_watchdog` |
| human 归属异常 / 外部窗格无权威 seq | 仅只读通知 |
| 外部窗格连续不可达达阈值 | 唤醒 L2 + 通知 |

去重状态持久化于私有 doc：同 `(targetKind, nodeId, targetId, stateChangeSeq)` 同类动作恰好一次，未达阈值绝不预先占坑，跨重启不重复危险动作；文档损坏显式报错拒绝巡检（回空会令已处理动作重放）。

**Layer 2 认知推理**：Layer 1 判定需认知排障时，把异常事实（XML 转义防逃逸，不用反引号围栏杜绝 prompt 注入面）合并投递到看门狗会话（`origin: 'agent'` / `followUp`）。模型结合 `watchdog-playbooks` 技能手册推理根因与处置，经专属工具落地：`watchdog_inspect`（现查目标真实详情，只读）、`watchdog_recover`（向 owned 会话提交恢复提示）、`watchdog_abort`（中止 owned 会话，human/中枢/看门狗自身拒绝）。三个工具 `scope` 限定 watchdog Profile 且执行期核对实际 watchdog 会话 ID（防同 Profile 人类直聊滥用）；同名 `ctx.action` 供 HTTP/CLI（`helm superagent watchdog_*`）。

### 归属权红线（内核执行层强制）

`ownedBy: 'human'` 的人类直连会话与 Herdr 终端窗格**严禁发送任何按键或中止指令**，仅允许只读诊断与通知（未标记一律按 human 处理）。一切自动化中止与输入提交统一走内核 guarded 端口（`ctx.host.abortConversationGuarded` / `submitInputGuarded`）：探针观测的 `ownedBy` 与 `stateChangeSeq` 随调用传入，内核在会话串行域内、于第一个不可逆动作前同步复核，human 红线在执行层原子兑现，不再依赖插件侧 check-then-act。外部窗格的中止只能经核对 `facts.parentConversationId` 指向的 owned 原生工作会话后由 L2/规则对该会话 abort，由 Herdr 原取消链清理。外部探针的 `stalledBasis` 口径只反映状态翻转间隔、不含 working 内部活动——绝不单独作为自动中止证据。看门狗自身（含同 Profile 直聊会话）绝不做探针目标，其 failed/aborted 仅经 `turn_settled` 通知，防自巡检死循环。

## UI 扩展

插件注册较完整的前端贡献面：左栏三个导航（中枢与看门狗会话站位、`记忆与订阅图谱` 全屏 Screen）、两个按 `filterTag` 过滤的会话分组（`后台 Worker`、默认折叠的 `已归档 Worker`）、中枢会话的 composer 态势挂件与路由模式药丸、`dispatch_worker` 工具视图、`superagent:worker-report` 时间线渲染器、召回图谱全屏 Screen 与设置面板。
