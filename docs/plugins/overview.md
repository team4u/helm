# 插件系统设计与契约

本文面向两类读者：想理解 Helmx 插件宿主如何工作的内核/插件贡献者，以及准备为自己的能力选择承载形态（内置插件、外部插件还是全栈微应用）的开发者。读完你应当能回答：插件能拿到哪些宿主能力、一次 `ctx.action` 声明如何映射到五个消费端、插件的状态存放在哪里、停用一个插件会发生什么。插件开发的上手教程见[插件开发实战](plugin-development.md)，Hook 与 UI 扩展点的逐项契约见[扩展点详解](../architecture/extension-points.md)。

## 当前状态

插件系统是 Helmx 的核心生产能力：内核（`@helmx/kernel`）只保留持久会话、跨节点执行底座、Model/Auth 与插件宿主四块通用机制，其余一切业务能力由插件承载。官方插件实现与资产位于 `packages/plugins`，由产品组合根 `packages/hub/src/app.ts` 的 `createHelmx` 注册，共 14 个内置插件：

| 插件 ID | 名称 | 职责一句话 | 默认状态 | locked |
| :--- | :--- | :--- | :--- | :--- |
| `builtin:profile` | 角色与技能底座 | 按会话 Profile 注入 SYSTEM.md / AGENTS.md 与技能目录，提供 `load_skill` 工具 | 启用 | 是（常驻不可停用） |
| `builtin:workflow` | 工作流与子代理编排 | `subagent` / `SubagentWorkflow` 工具、DSL 引擎与账本恢复 | 启用 | 否 |
| `builtin:worktree` | 受管工作树 | 受管 Git Worktree 分配、持久租约与持有锁、`cleanup_worktree` 工具与 `worktrees` CLI | 启用 | 否 |
| `builtin:swarm` | Swarm 对等协同看板 | 扁平对等序号黑板、正交唤醒、`turn_settled` 纯事件防掉棒自愈与自适应协同看板 | 启用 | 否 |
| `builtin:memory` | 长期记忆 | 按 Profile 管理 MEMORY.md 注入与启停，提供 `update_memory` 工具 | 启用 | 否 |
| `builtin:json-render` | JSON 卡片渲染 | 接管 ```ui 代码围栏渲染声明式 JSON Spec 卡片，自举 `generative-ui` 技能 | 启用 | 否 |
| `builtin:mermaid` | Mermaid 图表 | 接管 ```mermaid 围栏，把 Mermaid 文本渲染为矢量图表 | 启用 | 否 |
| `builtin:apps` | 应用中心 | 全栈微应用目录与 `validate/publish/list/update_meta/remove` 动作 | 启用 | 否 |
| `builtin:triggers` | 触发器 | Cron 定时与 Webhook 签名入站连接器 | 启用 | 否 |
| `builtin:herdr` | Herdr 终端 | 拦截 `agent_spawn` 驱动本机/远端 Herdr CLI Agent，带 CAS 审批桥 | 停用 | 否 |
| `builtin:superagent` | SuperAgent 中枢 | 双层中枢（总控路由 + 驻留 Worker）与两层巡检看门狗 | 停用 | 否 |
| `builtin:magpie` | Magpie 网关 | 动态模型网关接入：目录、配额与路由组诊断 | 启用 | 否 |
| `builtin:token-speed` | Token 速率 | 输入区状态行实时解码速率（只读展示，内核零速率计算） | 启用 | 否 |
| `builtin:tasks` | 任务看板 | 把工作单元派发到独立顶层执行会话并在四列看板上跟踪：依赖链自动接棒、交卷/验收/返工闭环与事件驱动防沉默 | 启用 | 否 |

内核包自身不注册任何插件；同一注册点还会调用 `loadExternalPlugins` 从 `<dataDir>/plugins/` 目录加载用户放入的外部插件（默认停用）。各插件的深度文档见文末「相关文档」。

插件是**可信代码**，宿主不提供权限沙箱：隔离是状态与配置层面的（专属数据目录、文档命名空间、凭据命名空间），任意插件天然可读环境变量与进程内数据。文档涉及机密边界处均以此前提如实陈述。

## 能力和入口

### `definePlugin(ctx)` 契约

每个插件实现 `definePlugin(ctx)`（`PluginDefinition`，见 `@helmx/protocol` 的 `packages/protocol/src/plugin.ts`）。内置插件经 TypeScript 工厂函数构造；外部插件在 `plugin.json` 声明入口后 `export default` 定义对象。上下文能力面：

| 接口 | 职责 | 关键约束 |
| :--- | :--- | :--- |
| `ctx.pluginId` / `ctx.dataDir` | 只读身份与专属数据目录 | `<dataDir>/plugins/<id>/` |
| `ctx.getConfig()` / `ctx.configSchema(schema)` | 读取与声明配置 | `type: string/number/boolean`；`secret: true` 分离至 `credentials.json` |
| `ctx.hook` | 注册 7 个生命周期 Hook | `trigger / input / before_turn / tool_call / tool_result / agent_spawn / turn_settled`，支持 `priority` |
| `ctx.action(spec)` | 注册五端复用动作 | 强类型 `inputSchema` / `outputSchema`；可选 `cli.command` / `exposeAsTool` / `promptSnippet` / `promptGuidelines` / `scope` / `idempotent` |
| `ctx.tool(spec)` | 注册仅对模型可见的工具 | 同样支持 `scope` 与提示词投射字段 |
| `ctx.route(spec)` | 挂载 Web Standard 原始 HTTP 路由 | `public: true` 跳过 Token 鉴权（webhook 回调用） |
| `ctx.doc(name, initial, opts)` | 声明全局持久文档 | state.sqlite；`public: true` 进全局首帧与 SSE 广播 |
| `ctx.sessionDoc(name, initial, opts)` | 按会话分片的持久文档 | 不进全局首帧/全局 SSE，专用 SSE 按需订阅 |
| `ctx.service(spec)` | 注册后台长驻服务 | `prepare / start / stop / liveTasks / inUse` |
| `ctx.provider(provider)` | 注册模型供应商网关 | 启用时挂载、停用后注销，宿主统一协调 |
| `ctx.ui` | 前端扩展点注册表（16 个 surface） | 见[扩展点详解](../architecture/extension-points.md) |
| `ctx.host` | 宿主运行时能力（`HelmxHostApi`） | 见下文 |

启动时序遵守**全局 prepare 后 start 屏障**：`PluginHost.start` 先对全体已启用服务执行 `prepare()`，全部完成后才依次 `start()`，最后恢复会话调度。热启用单个插件同样先 prepare 后 start。`stop()` 返回后本周期 doc 句柄失效；宿主在 await `stop()` 链期间开放受控停止窗口，允许本插件当前周期的 doc 句柄完成最终写入（`builtin:workflow` 在此窗口做最终 runs 投影并 `await flush()`）。

### 动作五端映射

`ctx.action()` 是插件对外暴露业务能力的唯一入口，宿主按声明自动映射到五个消费端：

| 消费端 | 映射形态 |
| :--- | :--- |
| HTTP | `POST /api/actions/:pluginId/:actionId`（pluginId 含 `:` 时 URI 编码） |
| CLI | `helmx <plugin> <action>` 顶层动态命令（`builtin:` 前缀剥离，`cli.command` 可整体覆写） |
| Agent Tool | `exposeAsTool: true` 直接注入工具列表；否则经 `run_action` 元工具按需调用 |
| Workflow | 编排脚本 `action('pluginId.actionId', input, options)` |
| Web UI | 声明式 Spec `{ type: 'helmx:action', pluginId, actionId, input }` 或 `ctx.callAction` |

输入输出在边界处统一 JSON Schema 强校验；输出经宿主统一脱敏。启用且匹配会话 `scope`、未 `exposeAsTool` 的动作会投射进系统提示 `<available_actions>` 目录，随插件启停即时增删，不留幻影提示词。`idempotent: true` 是作者对安全重试的承诺：工作流账本在成功后进入前缀缓存复用，中断恢复可安全重跑；缺省 `false` 的动作一旦执行状态不确定，账本标记 `workflow_action_uncertain`，恢复时显式交由人类确认。

### `ctx.host` 能力面

`ctx.host`（`HelmxHostApi`）是插件调用内核机制的唯一受信通道，实现已绑定插件自身 ID。按职责分组：

| 分组 | 端口 |
| :--- | :--- |
| 外部事件 | `dispatchTrigger(envelope)`（统一 defang 防逃逸投递） |
| 输入与会话 | `submitInput` / `submitInputGuarded`（均支持 `attachments` 产物 ID 列表，按会话或祖先链授权挂载）、`createConversation / forkConversation / listConversations / getConversation / getConversationDetail / updateConversation / abortConversation / abortConversationGuarded`、`resetConversationGuarded / compactConversationGuarded`（插件自动化专用上下文维护：内核串行域内于 SDK reset/compact 前同步复核归属（human 一律拒绝）与可选 CAS 水位；handoff/instructions 过统一脱敏）、`manageConversation`（删除保护）、`markConversationOwnership` |
| 人机审批 | `createAsk / cancelAsk / registerAskSeqResolver`（CAS 水位解析器） |
| 子代理与执行 | `spawnAgent / runGate / execEnv / resolveSpawnTarget / listActiveSpawnExecutions / withFileMutationQueue` |
| 动作互调与治理 | `prepareAction / invokeAction / listActions / plugins`（受管包生命周期端口） |
| 资产端口 | `profiles / skills / secrets`（Profile 与 SYSTEM.md、技能受管自举、插件私有机密）、`listArtifacts / createArtifact / getArtifact`（会话产物列表、内存字节写入（与 HTTP 上传同链校验，返回 ID 供 `submitInput` 挂载）、授权读取） |
| 节点与文件 | `nodeIpc / nodeFetch / openTunnel / executionEnv / withFileLock / atomicWriteFile / buildSpawnEnv / inspectNodePathUsage` |
| 通用机制 | `redact / completeText / refreshModels / listPlugins / listUi / setConfig / isClosing / onEvent / emitEvent` |

三条使用纪律：受管 Git Worktree 清理不在 `ctx.host`——需要清理时调用 `builtin:worktree` 的 `cleanup_worktree` 动作；`execEnv` 目标节点或目录缺省继承请求会话坐标，节点离线显式报 `409 node_offline`，绝不静默回退本机。

第三条纪律：插件做「清理/重置会话上下文」必须走 `resetConversationGuarded` / `compactConversationGuarded`（或复用既有 HTTP/CLI 面向人类开放的语义），**不得**用 `createConversation` 另起会话冒充上下文清理，也不得经 `execEnv`/`executionEnv` 反向调用宿主 `helmx` CLI 绕过类型契约与归属红线（`execEnv` 是节点命令执行端口，不是宿主 API 通道）。

## 配置与数据边界

- **专属数据目录**：每个插件分配 `<dataDir>/plugins/<id>/`，`ctx.doc` / `ctx.sessionDoc` 在 state.sqlite 中按插件划分命名空间。文档是紧凑状态而非数据仓库：单文档 JSON 序列化超过 **2 MiB** 即显式拒绝（`413 plugin_doc_too_large`），大体量内容应落盘为文件资产。
- **公共与私有文档**：`public: true` 的 `ctx.doc` 进入全局 SSE 首帧 `pluginDocs` 并广播更新；`ctx.sessionDoc` 按会话分片、经专用 SSE 按需订阅（`builtin:workflow` 的 `runs` 与 `builtin:token-speed` 的 `speed` 即此形态）。公共文档禁止包含未脱敏机密。
- **配置与机密**：`ctx.configSchema` 声明 `secret: true` 的字段自动分离到 `credentials.json` 的 `pluginSecrets.<pluginId>`（恒 0600）并注册 SecretStash 脱敏；插件配置经插件中心或 `helmx plugins config <id>` 同权读写。
- **技能与 Profile 资产**：插件可经 `ctx.host.skills.ensureSkill` 自举受管技能（frontmatter `managedByPlugin` 绑定本插件 ID，随启停进出技能目录），经 `ctx.host.profiles` 读写 Profile 资产。

## 插件间依赖与停用/失败语义

插件定义或清单可声明 `dependencies: string[]`（其他插件 ID，仅 ID 不做版本解析）：

- **启用门禁**：启用时逐项校验依赖已注册且已启用，缺失/未启用分别报 `409 plugin_dependency_missing` / `plugin_dependency_not_enabled`；
- **环路拒绝**：依赖图成环（含自依赖）在注册边界拒绝（`409 plugin_dependency_cycle`）；
- **拓扑时序**：全局启动屏障按依赖拓扑序 prepare/start，`stop` / `dispose` 按逆拓扑序；
- **依赖者保护**：停用被依赖插件时，依赖它的已启用插件（含传递依赖者）作为 `plugin_in_use` 占用项拦截；`--force` 停用后依赖者被显式标记为故障态（`status=failed` 附诊断），绝不静默潜伏。

停用一个插件要过三道关卡，顺序固定：

1. **locked 硬拒绝**：`locked: true` 的插件（仅 `builtin:profile`）永久禁止停用或卸载，返回 `403 plugin_locked`；
2. **在途任务硬阻断**：`liveTasks()` 非空（执行中的动作/工具/子代理派生/服务自声明任务）即 `409 plugin_has_live_tasks`，**不可 force**；`liveTasks()` 执行崩溃按 `500 plugin_live_tasks_check_failed` 拒绝，绝不默认放行；
3. **持久资源知情确认**：`inUse()` 声明持久生效资源（如已启用的 cron 任务、webhook 端点、Profile 运行时绑定、模型引用），非空默认 `409 plugin_in_use` 并列出占用清单；显式 `--force` 可越过（磁盘配置保留，重新启用后恢复）。

停用后该插件的工具、动作、动态 CLI 命令、受管技能、UI 贡献与事件订阅**即时消失，不留幻影提示词**。插件加载或启用失败不拖垮内核：`PluginSummary.status` 置 `failed` 并携带结构化 `error`（`code / message / stage / details`），`stage` 标明故障阶段（`scan` / `load` / `define` / `enable`）；失败插件在插件中心可见且诊断可读，修复源码后经 `reload` 或重启恢复。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 内置插件实现 | `packages/plugins/src/<name>.ts` 与同名子目录 |
| 插件契约（编排业务形状） | `packages/plugins/src/contracts.ts` |
| 插件宿主（PluginHost / 生命周期 / doctor / 受管包） | `packages/kernel/src/plugins/` |
| 宿主能力端口与 Hook/UI 契约类型 | `packages/protocol/src/plugin.ts` / `ui.ts` |
| 产品注册点 | `packages/hub/src/app.ts` |
| 契约锁定测试 | `packages/kernel/test/plugins-contract.test.ts`、`packages/plugins/test/contracts.test.ts` |
| 宿主测试 | `packages/kernel/test/plugins.test.ts`、`plugin-*.test.ts`（生命周期、依赖、doc 上限、受管包等） |
| 各插件测试 | `packages/plugins/test/<domain>*.test.ts`（见各插件文档「源码与测试入口」） |

## 相关文档

- 各内置插件深度文档：[workflow](workflow.md) · [worktree](worktree.md) · [swarm](swarm.md) · [profile](profile.md) · [memory](memory.md) · [apps](apps.md) · [herdr](herdr.md) · [superagent](superagent.md) · [triggers](triggers.md) · [magpie](magpie.md) · [json-render](json-render.md) · [mermaid](mermaid.md) · [token-speed](token-speed.md) · [tasks](tasks.md)
- [插件开发实战](plugin-development.md)：从 `helmx plugins init` 到 doctor / rescan / enable / reload 的完整闭环
- [生命周期 Hook 与全界面扩展点](../architecture/extension-points.md)：7 个 Hook 与 16 个 UI surface 的逐项契约
- [微内核架构总览](../architecture/overview.md)：内核四块机制与包依赖方向
