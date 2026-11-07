# helm 开发约定

**helm** 是极简持久微内核个人助理、多智能体确定性编排与 Herdr 协同主控台系统（见 `docs/20261106 helm极简微内核与双7扩展点设计文档.md`）。本文件约束所有参与开发的智能体与人类。

## 工作目录与历史仓库隔离（重要）

- **必须在 `/root/code/helm` 下工作**：开发智能体的继承 `cwd` 可能位于 `/root/code/botx` 或 `/root/code/botd`（旧仓库），禁止沿用；每次开工先显式 `cd /root/code/helm`（或专属 worktree 路径）。
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
pnpm build && pnpm typecheck && pnpm test
```

## 架构铁律（微内核 + 双 7 扩展点 + 四大内置插件）

1. **内核极度精简（零业务角色硬编码）**：
   - `@helm/kernel` 仅包含四大通用机制：① `pi-durable` 持久会话增强（通用 `Conversation` 五态状态机、`state.sqlite` + FTS5、`AskDoc`、`SecretStash`、`Artifacts`、纯文件资产热重载）；② `subagent` 与 `SubagentWorkflow` 确定性编排引擎；③ 唯一强类型插件宿主 `PluginHost`（`definePlugin(ctx)`）；④ 同构 Web 外壳与 CLI。
   - **严禁在内核硬编码 `'router' | 'worker' | 'watchdog'` 枚举**；会话职责一律通过 `profileId` 与 `tags` 表达。
2. **前后端对称「双 7 扩展点」，零 `if/else` 业务特判**：
   - **后端 7 大可组合生命周期 Hook**（支持 `continue | transform | handled | block`）：`trigger`、`input`、`before_turn`、`tool_call / tool_result`、`agent_spawn`、`turn_settled`（统一覆盖 `completed | failed | aborted`）、`watchdog_tick`。
   - **前端 7 大全界面扩展点**（同时支持 `@json-render` JSON Spec 与 `client.tsx` React 组件）：`sidebar.item/section`、`screen`（全屏自定义视图，支持左右 Split View 并排展示）、`timeline.renderer`、`tool.view`、`composer.pill/widget`、`workbench.panel`、`commandPalette (⌘K) / settings.panel`。
3. **四大内置插件正交职责**：
   - `builtin:assistant`（**常驻不可卸载**）：为所有会话按其绑定的 `profileId` 注入独立的 `SYSTEM.md` 与 `MEMORY.md`（提供按 `profileId` 原子写回的 `update_memory` 与支持按需加载 `references/*.md` 子文件的 `load_skill`），并守护常驻根会话 `Conversation #1` 作为单兵个人助理主入口。
   - `builtin:herdr`：拦截 `agent_spawn` 驱动本机 Herdr 的 23 种 CLI 工具（`herdr:agy`、`herdr:claude`、`herdr:codex`、`herdr:pi` 等），执行「后台标签页 + `.helm/wf-out-*` 文件交接与原地追问自愈」；监听 `herdr.sock` 实现带 `expectedStateSeq` CAS 乐观锁的 `blocked ↔ AskDoc` 远程审批桥；向终端侧栏投射 `$helm` 状态 Token。
   - `builtin:superagent`（实验性双层中枢）：首次启用时动态创建并持久化两个专属常驻会话——`routerConversationId`（`SuperAgent 中枢`，`profileId: 'superagent'`）与 `watchdogConversationId`（`巡检看门狗`，`profileId: 'watchdog'`）；角色由 `profileId` 表达，不重复打角色 Tag；通过挂载 `trigger / before_turn / turn_settled / watchdog_tick` 钩子与自有 `ctx.doc`，实现 0 阻塞总控路由、点名调用任意 `Profile` 专家 Bot 派生后台驻留 Worker、一键归档（`archive_worker`）、按 `origin` 自动向中枢汇报、`ThreadKey` 0ms 直通、`RecallGraph` 召回图谱与基于 `Skill(references/)` 的两层 Watchdog 巡检。
   - `builtin:triggers`：`cron` 与 `webhook` 入站连接器，经 `defang` 防逃逸信封投入 `trigger` 管道。
4. **明确不做的事**：
   - 不做 `PiExtensionAdapter` 服务端 TUI 兼容层（真正的 `pi` 直接在 Herdr 终端窗格中运行）；
   - 不自建 BYOM 远端节点守护进程与 `Space` 管理（跨机器通过 `ssh <machine>` 驱动远端 Herdr）；
   - 不在 Web 端重复造 `Worktree Diff` 三键合入状态机（Git Worktree 交由 Herdr 与终端工具管理）；
   - 不在 `Conversation` / `ModelProvider` 底层伪装终端 CLI Agent。

## 设计原则

- **第一性原理**：从问题本质推导最简正确实现；感觉笨重时先怀疑设计，不是打补丁。
- **KISS / YAGNI / 最小惊讶**：用最少的代码解决问题；不实现用不到的能力；接口行为符合使用者预期。
- **可读性优先**：代码是写给人看的。命名表达意图，结构自解释；注释只解释 Why（为什么这么做），不复述 What。
- **UNIX 原则**：一个模块只做好一件事；组合优于聚合；**机制与策略分离**（内核提供机制，策略由配置/插件/用户层给）。
- **边界清晰**：依赖方向单向——`@helm/web` / `@helm/node` → `@helm/protocol` ← `@helm/kernel`；`protocol` 是唯一共享契约包，零运行时重依赖。跨包公共接口先改 `protocol` 并同步所有消费方。
- **边界处校验**：所有外部输入（HTTP body、插件产物、DSL、事件载荷、Herdr `.helm/wf-out-*` 交接文件）在边界做类型/Schema 校验。
- **公共接口消费方普查**：改动任何导出符号前，先全仓搜索引用（`kernel/node/web/CLI/测试`），漏改即事故。

## 诚实性纪律（禁止造假）

- **禁止静默降级**：任何能力不支持或外部交接失败（例如 `herdr:<kind>` 未生成 `.helm/wf-out-*` 或 JSON Schema 校验失败）必须给出显式错误与诊断（附终端最后 40 行快照），**绝不静默截取终端脏屏幕文本冒充成功结果**，绝不编造 fallback 数据或 mock 完成结果。
- **机密边界如实**：`SecretStash` 保证「不落库、不进模型上下文」；但任意 shell 命令与进程内插件（可信代码，拥有宿主权限）天然可读环境变量与内存——**不承诺对它们的零泄漏**，文档不得夸大。
- **看门狗归属权红线**：Watchdog 对 `ownedBy: 'bot' | 'helm'` 的后台会话允许自动恢复或中止；对 `ownedBy: 'human'` 的人类直连会话或 Herdr 终端窗格**严禁发送任何按键或中止指令**，仅允许只读诊断与通知。

## 并发与正确性

- SDK 根会话 `ROOT_CONVERSATION_ID = 1` 固定作为常驻个人助理主入口（保护不可删除，`403 root_conversation_protected`）；`superagent` 插件的 `routerConversationId`（SuperAgent 中枢）与 `watchdogConversationId`（巡检看门狗）在插件首次启用时动态分配并持久化于 `SuperAgentIndexDoc`（不硬编码 ID，启用期间同样受删除保护，`409 conversation_managed_by_plugin`）。
- 会话正忙时 `whenBusy` 仅有 `steer | followUp | reject`；批处理用 `settings.followUpMode = 'all'`。
- 输入来源（`origin: 'human' | 'agent' | 'trigger'`）附着在每次提交的 `helm.input` entry 上；`turn_settled` 钩子统一覆盖 `completed | failed | aborted` 三种终态，后台 Worker 本回合消费的输入只要含任一 `agent / trigger` 来源即向 `routerConversationId`（SuperAgent 中枢）投递汇报卡片，纯 `human` 回合仅静默更新召回图谱。
- `AskDoc` 支持 `expectedStateSeq` CAS 乐观锁：当终端窗格 `stateChangeSeq` 已推进（人类已在终端按键处理）时，Web 端对应的 `AskDoc` 自动流转为 `superseded` 销单，防止向终端重复发送回车。
- 插件卸载遇在途任务（自定义任务、执行中 Tool、挂起 `agent_spawn`）时，显式拒绝并返回 `409 plugin_has_live_tasks`。
- FTS5 是**可重建的派生索引**，不得写入 `pi_*` 表语义。

## API 与 CLI 同权（重要）

- Hub 新增/变更任何面向用户的 HTTP 接口时，**同一次改动**必须补齐 `helm` CLI 映射（`packages/node/src/cli/`，含 `--json` 输出与 `--current` 当前会话自动感知）。
- 插件通过 `ctx.action({ id, inputSchema, outputSchema })` 声明的动作，自动映射为 HTTP 端点、顶层语义化 CLI 命令 `helm <plugin> <action>`（剥离 `builtin:` 前缀）、Agent Tool、`SubagentWorkflow` `action()` 与 Web UI 动作。

## 测试与前端规范

- **UI 极简无 Emoji 规范（重要）**：Web 界面与所有内置/外置插件 UI 遵循极简克制风格，**严禁在界面文案、左栏导航项、分组标题、按钮、状态徽章或卡片中使用任何 Emoji 表情图标**；图标统一使用 `lucide-react` 线性矢量图标或纯文本排版。
- **单测防死锁**：单测显式声明 `{ timeout: 60_000 }`（runner 为 `tsx --test`）；测试命令必须加总超时（如 `timeout 50s ...`），保留完整日志，不用过滤管道隐藏失败。
- **前端保 Fast Refresh**：`.tsx` 组件文件**只导出组件**；纯函数/常量放独立模块。

## 开发流程与安全

- **主代理职责**：负责拆分任务、确定接口、协调子代理、审查结果与最终验收。重实现、大范围开发和成套测试交给子代理。
- **子代理模型**：所有子代理统一使用 GLM（`glm-agent`），包括调查、审查、规划、实现与验收；除非用户明确变更此偏好。
- **Worktree 隔离**：首 commit 之后并行开发一律在 `git worktree` 隔离目录进行；委派子代理提示词中必须附带本文件的核心约束（`cd /root/code/helm`、旧仓只读、诚实性纪律、API/CLI 同步）；启动与续接子代理时不设置 `max_turns`。
- **Git 提交**：中文 Conventional Commits（如 `feat(kernel): ...`），不加 `Co-Authored-By`。
