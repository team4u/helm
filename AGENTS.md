# helm 开发约定

**helm** 是极简持久微内核个人助理、多智能体确定性编排与 Herdr 协同主控台系统。本文件约束所有参与开发的智能体与人类；架构详情见 `docs/architecture/` 与 `docs/plugins/`。

## 工作目录与历史仓库隔离（重要）

- **必须在 `/root/code/helm` 下工作**：开发智能体的继承 `cwd` 可能位于 `/root/code/botx` 或 `/root/code/botd`（旧仓库），禁止沿用；每次开工先显式 `cd /root/code/helm`（或同级专属 `../helm-worktrees/<name>` 路径）。
- `/root/code/botx`、`/root/code/botd` 与 `/root/code/herdr` **只读**：可参考其代码与 `node_modules` 验证 SDK / 协议行为，绝不修改。
- 数据目录为 `~/.helm`（可通过 `HELM_DATA_DIR` 覆盖），与 `~/.botx`、`~/.botd` 完全隔离；不得读写旧系统的运行数据。

## 开发阶段：不兼容、不迁移（重要）

- 当前项目处于开发阶段，**不考虑任何向后兼容性，不做数据迁移**。
- 按任务需要，**允许直接进行破坏性操作**：修改、删除或重建本项目代码、公共接口、配置、数据库结构和开发数据，以最新设计为准。
- 不保留旧接口、旧格式读取、迁移脚本、双写或兼容适配层；旧开发数据可以直接清理并按新结构重建，测试同步采用新契约。
- 上述授权限于 helm 项目与开发数据；历史仓库只读、旧系统运行数据隔离和端口约束继续有效。

## 端口约定（3000/3001/3002/3101/3102 均被占用）

- 前端 dev（Vite）：`3201`（`strictPort: true`），代理 `/api` 与 `/ws` 到 `3202`。
- 内核（Hub）：`3202`（`HELM_PORT=3202`）。
- 永不占用 `3000`（外部）、`3001/3002`（`botd`）、`3101/3102`（`botx`）。

```bash
HELM_PORT=3202 pnpm dev        # 前后端一起
HELM_PORT=3202 pnpm dev:kernel # 只起内核
pnpm dev:web                   # 只起前端（需内核已在 3202）
pnpm build && pnpm typecheck && pnpm test:all   # 全量；本地开发默认 pnpm test:unit，见「测试分层执行」
```

## 架构铁律（微内核 + Hook/UI 扩展点 + 内置插件）

1. **内核极度精简（零业务角色硬编码 + 跨平台节点底座 `EnvFabric`）**：
   - `@helm/kernel`（`helm-hub`）只保留四块通用机制：① `pi-durable` 持久会话增强（通用 `Conversation(nodeId, cwd)` 五态状态机、`state.sqlite` + FTS5、`AskDoc`、`SecretStash`、`Artifacts`、纯文件资产热重载）与原生 `spawnAgent` 子会话派生（`agent_spawn` Hook 管道 + 原生子会话默认行）；② 跨平台执行编排底座 `EnvFabric` + `NodeRegistry`（`/ws/node` 控制网关、`/ws/node-tunnel` 节点任意 TCP 透传隧道（`openTunnel` 原语 + `nodeFetch` HTTP/HTTPS 适配层），内建 `local` 节点 + 远端 `@helm/node` 守护进程，驱动 `bash / read / write / edit / gate / env exec` 与按 `nodeId + canonicalPath` 目标的文件互斥，与任何插件是否启用正交）；③ Model 与 Auth（模型供应商接入、凭据与令牌管理；Provider 的远端节点绑定不包含在核心隧道本次实现中）；④ 唯一强类型插件宿主 `PluginHost`（`definePlugin(ctx)`）。**Git Worktree 租约/续接/清理（`WorktreeAllocator`）不在内核**，完整迁入 `builtin:workflow`；内核不再提供 `watchdog` 定时器与 `watchdog_tick` Hook。**`subagent` / `SubagentWorkflow` / `cleanup_worktree` 模型工具与编排引擎不是内核能力**，由 `builtin:workflow` 插件提供（见第 3 点）。
   - **严禁在内核硬编码 `'router' | 'worker' | 'watchdog'` 枚举**；会话职责一律通过 `profileId` 与 `tags` 表达。
2. **生命周期 Hook + 全界面扩展点，零 `if/else` 业务特判**：
   - **后端可组合生命周期 Hook**（支持 `continue | transform | handled | block`）：`trigger`、`input`、`before_turn`、`tool_call / tool_result`、`agent_spawn`、`turn_settled`（统一覆盖 `completed | failed | aborted`）。内核不内置巡检定时器；周期性任务由插件自管服务调度（如 `builtin:superagent` 用自有 `ctx.service` 驱动巡检周期，`builtin:herdr` 通过通用进程内事件采集终端诊断）。
   - **前端全界面扩展点**（`client.tsx` 单轨；宿主核心不再内置声明式 JSON 渲染轨道）：`sidebar.item/section`、`screen`（全屏自定义视图，支持左右 Split View 并排展示）、`timeline.renderer`、`tool.view`、`composer.pill/widget`、`workbench.panel`、`commandPalette (⌘K) / settings.panel`，以及统一微操作 `ctx.ui.action({ target: 'conversation:header' | 'conversation:row' | 'timeline:entry' })`、`ctx.ui.markdownCodeBlock({ id, languages, priority?, client })` 与独立保留的 `composerCompleter / artifactPreviewer / profileRuntime / slot` 组合面（不为凑固定数量强行合并）。
3. **内置插件正交职责**：
   - `builtin:workflow`（**默认启用、非 locked 可停用**）：承载 `subagent` / `SubagentWorkflow` / `cleanup_worktree` 三个模型工具、DSL 编排引擎（`builtin-plugins/workflow/engine`）与完整的受管 Git Worktree 生命周期（`WorktreeAllocator` 全量迁入：租约分配、断点续接与安全清理），6 个动作（`list / run / runs / inspect / abort / cleanup_worktree`，映射为 `helm workflows …` 与 `helm worktrees cleanup` 动态命令）与工作流运行卡/任务面板 UI。私有 run 记录经 `ctx.doc('records')` 持久化，完整 `runs` 经 `ctx.sessionDoc` 按父会话分片存 `state.sqlite`，只通过对应元组的专用 SSE 按需订阅（不进入全局首帧或全局广播）；全局 `run-badges` 仅保留紧凑导航摘要，不包含运行详情。不使用内存降级或内核私有存储注入；运行中任务经 `liveTasks` 阻止停用（`409 plugin_has_live_tasks`），在途工作树经 `liveWorktrees` 声明占用、由本插件的清理链拒绝误清理；停用后其动作、CLI 命令与 UI 贡献即时消失。
   - `builtin:profile`（**常驻不可卸载**）：角色与技能底座——为所有会话按其绑定的 `profileId` 注入独立的 `SYSTEM.md`（`profile.system`）、可用技能目录（`profile.skills`，白名单 + 插件启停实时过滤）与 `load_skill` 工具，自举默认种子角色 `assistant` 与系统技能 `helm-cli`，并在左栏挂载 `conversation:profile:assistant` 站位（不依赖某一具体会话存在）。
   - `builtin:memory`（**默认启用、可停用**）：完全自治的长期记忆插件——`MemoryStore` 自管 `<dataDir>/profiles/<id>/MEMORY.md`（文件锁 + 64k 上限唯一权威点），单 Profile 开关与初始化标记持久化于插件私有 `ctx.doc`（磁盘全文是唯一权威，不进公共文档/全局首帧/SSE 广播），`before_turn` 按开关注入 `memory.content` / `memory.guide` / `memory.assets-missing` 并动态注入 `update_memory` 用法指引，提供 `get / set / configure` 三个动作（自动映射 `helm memory …`）；停用后工具/动作/UI 即时消失且不留幻影提示词。
   - `builtin:herdr`（**可选编程插件**）：拦截 `agent_spawn`，复用内核 `EnvFabric` 目标节点通道驱动当地 Herdr 的 23 种 CLI 工具（`herdr:agy`、`herdr:claude`、`herdr:codex`、`herdr:pi` 等），执行「后台标签页 + `.helm/wf-out-*` 文件交接与原地追问自愈」；监听节点 Herdr IPC（Unix Socket / Windows Named Pipe）实现带 `expectedStateSeq` CAS 乐观锁的 `blocked ↔ AskDoc` 远程审批桥；向终端侧栏投射 `$helm` 状态 Token。
   - `builtin:superagent`（实验性双层中枢）：首次启用时动态创建并持久化两个专属常驻会话——`routerConversationId`（`SuperAgent 中枢`，`profileId: 'superagent'`）与 `watchdogConversationId`（`巡检看门狗`，`profileId: 'watchdog'`）；角色由 `profileId` 表达，不重复打角色 Tag；通过挂载 `trigger / before_turn / turn_settled` 钩子、自有 `ctx.service` 自管巡检调度与自有 `ctx.doc`，实现 0 阻塞总控路由、点名调用任意 `Profile` 专家 Bot 派生后台驻留 Worker、一键归档（`archive_worker`）、按 `origin` 自动向中枢汇报、`ThreadKey` 0ms 直通、`RecallGraph` 召回图谱与基于 `Skill(references/)` 的两层 Watchdog 巡检（巡检周期由插件服务驱动，不依赖内核定时器或 `watchdog_tick` Hook）。
   - `builtin:json-render`（**默认启用、可停用**）：承接宿主剥离的声明式 JSON 渲染能力——JSON DSL、求值器（evaluator）、界面原语（primitives）与生成式技能全部归口本插件；停用后插件不再解析 JSON Spec，相关围栏回退为普通代码块展示。
   - `builtin:mermaid`（**默认启用、可停用**）：提供 Markdown 代码块中 Mermaid 图表的渲染能力；停用后 ```mermaid 围栏回退为普通代码块展示，不影响其他插件。
   - `builtin:triggers`：`cron` 与 `webhook` 入站连接器，经 `defang` 防逃逸信封投入 `trigger` 管道。
4. **明确不做的事**：
   - 不做 `PiExtensionAdapter` 服务端 TUI 兼容层（真正的 `pi` 直接在 Herdr 终端窗格中运行）；
   - 不做冗余的独立 `Space` CRUD 中间表（会话与 Profile 直接使用 `(nodeId, cwd)` 物理坐标），不在 `builtin:herdr` 中自建内嵌 Python 的 `ssh <machine>` 脚本（跨节点统一走 `EnvFabric` + `@helm/node` 守护进程）；
   - 不把控制 Hub 的客户端 CLI（`@helm/cli`，`helm`）与被控节点守护进程（`@helm/node`，`helm-node`）混装在同一个包或同一个命令中；
   - 不在 Web 端重复造 `Worktree Diff` 三键合入状态机（Git Worktree 交由 Herdr 与终端工具管理）；
   - 不在 `Conversation` / `ModelProvider` 底层伪装终端 CLI Agent。

## 设计原则

- **第一性原理**：从问题本质推导最简正确实现；感觉笨重时先怀疑设计，不是打补丁。
- **KISS / YAGNI / 最小惊讶**：用最少的代码解决问题；不实现用不到的能力；接口行为符合使用者预期。
- **可读性优先**：代码是写给人看的。命名表达意图，结构自解释；注释只解释 Why（为什么这么做），不复述 What。
- **UNIX 原则**：一个模块只做好一件事；组合优于聚合；**机制与策略分离**（内核提供机制，策略由配置/插件/用户层给）。
- **边界清晰**：五包依赖方向单向——`@helm/web` / `@helm/cli` → `@helm/protocol` ← `@helm/kernel` / `@helm/node`；`protocol` 是唯一共享契约包，零运行时重依赖。跨包公共接口先改 `protocol` 并同步所有消费方。
- **边界处校验**：所有外部输入（HTTP body、插件产物、DSL、事件载荷、Herdr `.helm/wf-out-*` 交接文件）在边界做类型/Schema 校验。
- **公共接口消费方普查**：改动任何导出符号前，先全仓搜索引用（`kernel/node/cli/web/测试`），漏改即事故。

## 诚实性纪律（禁止造假）

- **禁止静默降级**：任何能力不支持或外部交接失败（例如 `herdr:<kind>` 未生成 `.helm/wf-out-*` 或 JSON Schema 校验失败）必须给出显式错误与诊断（附终端最后 40 行快照），**绝不静默截取终端脏屏幕文本冒充成功结果**，绝不编造 fallback 数据或 mock 完成结果。
- **机密边界如实**：`SecretStash` 保证「不落库、不进模型上下文」；但任意 shell 命令与进程内插件（可信代码，拥有宿主权限）天然可读环境变量与内存——**不承诺对它们的零泄漏**，文档不得夸大。
- **看门狗归属权红线**：Watchdog 对 `ownedBy: 'bot' | 'helm'` 的后台会话允许自动恢复或中止；对 `ownedBy: 'human'` 的人类直连会话或 Herdr 终端窗格**严禁发送任何按键或中止指令**，仅允许只读诊断与通知。

## 并发与正确性

- 初始入口会话（SDK 保留 `#1` 承载，普通 assistant 会话语义）：首次启动播种，**无 id 级删除豁免**——删除后重启凭 tombstone 不复活、不补种；通用保护是插件管理权（`409 conversation_managed_by_plugin`）与归属权（`ownedBy`，human 会话严禁自动按键/中止），产品逻辑不依赖任何固定会话 ID。`superagent` 插件的 `routerConversationId`（SuperAgent 中枢）与 `watchdogConversationId`（巡检看门狗）在插件首次启用时动态分配并持久化于 `SuperAgentIndexDoc`（不硬编码 ID，启用期间同样受删除保护，`409 conversation_managed_by_plugin`）。
- 无显式目标的 trigger 在钩子链后选择最新的无父链、human-owned assistant 会话；没有候选时同进程并发共享一次在途创建。原始显式目标在 trigger 钩子前校验，失效目标不得由 ThreadKey 路由掩盖。工作流新 run 则必须提供显式会话或调用上下文（CLI `--current`），不使用 trigger 的缺省策略；resume 沿用原 run 目标。
- 会话正忙时 `whenBusy` 仅有 `steer | followUp | reject`；批处理用 `settings.followUpMode = 'all'`。
- 输入来源（`origin: 'human' | 'agent' | 'trigger'`）附着在每次提交的 `helm.input` entry 上；`turn_settled` 钩子统一覆盖 `completed | failed | aborted` 三种终态，后台 Worker 本回合消费的输入只要含任一 `agent / trigger` 来源即向 `routerConversationId`（SuperAgent 中枢）投递汇报卡片，纯 `human` 回合仅静默更新召回图谱。
- `AskDoc` 支持 `expectedStateSeq` CAS 乐观锁：当终端窗格 `stateChangeSeq` 已推进（人类已在终端按键处理）时，Web 端对应的 `AskDoc` 自动流转为 `superseded` 销单，防止向终端重复发送回车。
- 插件卸载遇在途任务（自定义任务、执行中 Tool、挂起 `agent_spawn`）时，显式拒绝并返回 `409 plugin_has_live_tasks`。
- **插件服务统一启动屏障**：`PluginServiceSpec.prepare?` 是通用生命周期阶段——所有插件定义/工具/动作注册完毕后，`PluginHost.start` 先对全体服务执行 `prepare`（如 `builtin:workflow` 在 `prepareRecovery` 中先于 SDK 调度器恢复持久标记中断任务取消），再依次 `start`；`KernelRuntime.start` 负责调用 `PluginHost.start`，保证恢复取消先于任何插件 `start` 提交输入。
- FTS5 是**可重建的派生索引**，不得写入 `pi_*` 表语义。

## API 与 CLI 同权（重要）

- Hub 新增/变更任何面向用户的 HTTP 接口时，**同一次改动**必须补齐 `helm` CLI 映射（`packages/cli/src/commands/`，含 `--json` 输出与 `--current` 当前会话自动感知）。
- 插件通过 `ctx.action({ id, inputSchema, outputSchema })` 声明的动作，自动映射为 HTTP 端点（`POST /api/actions/<pluginId>/<actionId>`，`pluginId` 含 `:` 时按 URI 编码）、顶层语义化 CLI 命令 `helm <plugin> <action>`（剥离 `builtin:` 前缀，由 `cli.command` 可覆写）、Agent Tool、`SubagentWorkflow` `action()` 与 Web UI 动作。
- `builtin:memory` 的 get/set/configure 由可选 `profileId` 显式选目标，省略时从调用会话上下文解析；两者都无则 `400 validation_error`，不猜测默认角色。开关影响后续调用与回合，不取消在途写入；删除 Profile 后同 ID 重建保留插件按 ID 持久化的状态。

## 测试与前端规范

- **Web 前端设计系统与开发约定（重要）**：编写、重构 Web 界面、新增主舞台/视图/弹窗/抽屉、排查移动端样式或字号问题时，**必须先阅读并遵守 [Web 前端设计系统与开发约定](docs/conventions/web-frontend.md)**。
  - **视图形态分级**：轻量交互用模态；海量项、多维检索、管理与市场类（插件/技能/模板）**必须升格为全屏一级视图（主舞台卡片网格 + 右侧 520px 详情抽屉）**，严禁把海量扩展内容塞入居中弹窗。
  - **Radix UI 唯一交互原语底座**：凡涉及浮层、对话框、下拉、标签页、提示等交互组件，**一律基于 `packages/web/src/ui/` 下的 Radix Primitives 封装**（`Dialog` / `AlertDialog` / `Select` / `DropdownMenu` / `Popover` / `Tabs` / `Tooltip`）；全仓严禁使用原生 `<select>`，严禁手写无 WAI-ARIA/Focus Trap 的简陋浮层；表单与布局严格使用 `.form-grid`、`.section-flat`、`.list-item-btn` 原语类，严禁大面积内联样式。
  - **移动端与自适应字号规范**：保持紧凑克制，正文 13/14px，移动端（≤680px）与分屏下严禁输入框字号突兀放大；移动端抽屉与弹窗自适应 100% 宽。
- **UI 极简无 Emoji 规范（重要）**：Web 界面与所有内置/外置插件 UI 遵循极简克制风格，**严禁在界面文案、左栏导航项、分组标题、按钮、状态徽章或卡片中使用任何 Emoji 表情图标**；图标统一使用 `lucide-react` 线性矢量图标或纯文本排版。
- **单测防死锁**：单测显式声明 `{ timeout: 60_000 }`（runner 为 `tsx --test`）；通过 `pnpm test:*` 运行，`scripts/run-tests.mjs` 内置跨平台单测超时、整套超时与进程树清理。不要依赖 Unix `timeout` 命令，也不要用过滤管道隐藏失败日志。
- **测试分层执行（重要）**：分层入口为 `scripts/test-suites.mjs`（复用 `scripts/run-tests.mjs` 的跨平台 spawn/超时/进程树清理），命令三档：`pnpm test:unit` / `pnpm test:integration` / `pnpm test:all`（`pnpm test` 兼容旧语义，等于 `test:all`）。
  - **执行规则**：本地改动默认跑 `test:unit`；改动 kernel/node 包跑 `test:integration`；改动同时影响两档契约时两档都跑；全量验收与 CI 跑 `test:all`。勿用 `HELM_TEST_SUITE_TIMEOUT_MS` 环境变量调总超时（kernel 的 `env-registry-races` 会因宿主残留 HELM_* 变量误报）。
  - **分类保守原则**：当前为包级切分——`unit` = protocol + cli + web（web 含 happy-dom/React 交互测试，属进程内 DOM 模拟，不起真实服务）；`integration` = kernel + node（**全部**视为集成，含真实进程、SQLite、Git、WebSocket、`createHelm`、`@helm/node` daemon）。分类存疑时一律入 integration；新增包或新增测试文件未登记套件时脚本会拒绝执行并报错。
  - **不变量**：`all` = unit ∪ integration，不重不漏（脚本内置断言）；新增测试文件必须落在已登记包的 test 目录下，新包需同步更新 `scripts/test-suites.mjs` 的 `SUITES` 分档。
- **前端保 Fast Refresh**：`.tsx` 组件文件**只导出组件与 TS 类型**；纯函数/常量放独立模块。

## Web 导航与 URL Hash（重要）

- 新增或修改会话入口、插件 Screen、分屏、工作台页签、管理弹窗或产物预览，以及排查刷新恢复、深链或浏览器前进/后退问题时，**必须先阅读并遵守 [Web 导航与 URL Hash 开发约定](docs/conventions/web-navigation.md)**。

## 开发流程与安全

- **主代理职责**：负责拆分任务、确定接口、协调子代理、审查结果与最终验收。重实现、大范围开发和成套测试交给子代理。
- **子代理模型**：所有子代理统一使用 GLM（`glm-agent`），包括调查、审查、规划、实现与验收；除非用户明确变更此偏好。
- **Worktree 隔离（严禁 `/tmp`）**：首 commit 后并行开发一律在主仓同级磁盘目录（`../helm-worktrees/<name>`）建 worktree，严禁建在 `/tmp`（避开 tmpfs 内存盘）；委派子代理提示词须显式指定该路径及核心约束，不设 `max_turns`。
- **Git 提交**：中文 Conventional Commits（如 `feat(kernel): ...`），不加 `Co-Authored-By`。
