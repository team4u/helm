# helm 开发约定

**helm** 是极简持久微内核个人助理、多智能体确定性编排与 Herdr 协同主控台系统。本文件约束所有参与开发的智能体与人类；按需深入的文档路标见文末第 7 节。

## 1. 环境、隔离与破坏性变更授权（最高优先级）

- **工作目录**：必须在 `/root/code/helm`（或同级 worktree `../helm-worktrees/<name>`）下工作；开发智能体的继承 `cwd` 可能位于旧仓库，每次开工先显式 `cd`。
- **历史仓库严格只读**：`/root/code/botx`、`/root/code/botd`、`/root/code/herdr` 仅可参考代码与 `node_modules` 验证 SDK / 协议行为，**绝不修改**。
- **运行数据隔离**：数据目录仅限 `~/.helm`（或 `HELM_DATA_DIR` 覆盖值），与 `~/.botx`、`~/.botd` 完全隔离，不得读写旧系统运行数据。
- **端口铁律**：Web dev 固定 `3201`（`strictPort: true`，代理 `/api`、`/ws`），内核 Hub 固定 `3202`（`HELM_PORT=3202`）。**永不占用 `3000`（外部）、`3001/3002`（botd）、`3101/3102`（botx）**。
- **开发阶段：不兼容、不迁移**：
  - 允许对 helm 代码、公共接口、配置、数据库结构和开发数据**直接进行破坏性修改、删除或重建**，以最新设计为准。
  - **严禁编写向后兼容层、旧格式读取、迁移脚本、双写或兼容适配**；旧开发数据直接清理按新结构重建，测试同步采用新契约。此授权限于 helm 项目与开发数据；历史仓库只读、数据隔离与端口约束继续有效。

```bash
HELM_PORT=3202 pnpm dev        # 前后端一起（Web 3201 -> Hub 3202）
HELM_PORT=3202 pnpm dev:kernel # 只起内核
pnpm dev:web                   # 只起前端（需内核已在 3202）
pnpm link:bins                 # 可选：在 /usr/local/bin 挂载 helm / helm-node / helm-hub 源码命令
pnpm build && pnpm typecheck && pnpm test:all   # 全量验收；日常按第 5 节分层执行
```

## 2. 架构边界与设计原则

**设计原则**：第一性原理推导最简正确实现（感觉笨重先怀疑设计，不打补丁）；KISS / YAGNI；命名自解释、注释只写 Why；一个模块只做好一件事；**机制与策略分离**（内核给机制，策略由插件/配置/用户层给）。

1. **五包单向依赖**：`@helm/web` / `@helm/cli` → `@helm/protocol` ← `@helm/kernel` / `@helm/node`。`protocol` 是唯一共享契约包，零运行时重依赖；跨包公共接口先改 `protocol` 再同步全部消费方。
2. **内核只保留四块通用机制**（`@helm/kernel` / `helm-hub`，零业务角色硬编码）：
   - `pi-durable` 持久会话：通用 `Conversation(nodeId, cwd)` 五态状态机、`state.sqlite` + FTS5（**纯可重建派生索引，禁写 `pi_*` 表语义**）、`AskDoc`、`SecretStash`、`Artifacts`、纯文件资产热重载、原生 `spawnAgent` 子会话派生（`agent_spawn` Hook 管道 + 默认执行行）；
   - `EnvFabric` + `NodeRegistry`：`/ws/node` 反向控制网关、`/ws/node-tunnel` 任意 TCP 透传隧道（`openTunnel` 原语 + `nodeFetch` 适配层 + `helm nodes forward` 端口转发），内建 `local` 节点 + 远端 `@helm/node` 守护进程，驱动 `bash / read / write / edit / gate / env exec` 与按 `nodeId + canonicalPath` 的文件互斥（与任何插件是否启用正交）；
   - `Model 与 Auth`：模型供应商接入、模型禁用过滤、凭据与令牌管理；
   - `PluginHost`：`definePlugin(ctx)` 唯一强类型宿主、受管包生命周期（`doctor / install / update / remove / reload`）、插件间 `dependencies` 拓扑启停与 `ctx.host` 运行时端口。
3. **零角色枚举**：严禁在内核硬编码 `'router' | 'worker' | 'watchdog'`；会话身份由 `profileId` 表达，运行态标记由 `tags` 表达。
4. **不在内核的能力**：`subagent / SubagentWorkflow / cleanup_worktree` 工具、DSL 编排引擎与 `WorktreeAllocator`（Worktree 租约/续接/清理）完整归属 `builtin:workflow`；内核无巡检定时器、无 `watchdog_tick` Hook、无内置声明式 JSON 渲染轨道（分别由 `builtin:superagent` 自管服务与 `builtin:json-render` 提供）。
5. **扩展面契约（零 `if/else` 插件 ID 业务特判）**：
   - **后端 7 个生命周期 Hook**（`continue | transform | handled | block`，`block` 仅限 `tool_call`）：`trigger`、`input`、`before_turn`、`tool_call`、`tool_result`、`agent_spawn`（额外支持 `next` around 包装）、`turn_settled`（统一覆盖 `completed | failed | aborted`）；
   - **前端 16 个 `ctx.ui` 扩展点**（`client.tsx` React 单轨）：`sidebarItem`、`sidebarSection`、`screen`、`timelineRenderer`、`markdownCodeBlock`、`toolView`、`composerPill`、`composerWidget`、`composerCompleter`、`artifactPreviewer`、`workbenchPanel`、`command`、`settingsPanel`、`profileRuntime`、`action`（`conversation:header | row | timeline:entry`）、`slot`。
6. **10 个内置插件**（深度文档见 `docs/plugins/<name>.md`）：
   - **默认启用（7 个）**：`builtin:profile`（`locked` 常驻；SYSTEM.md / 技能目录（含 `~/.agents/skills` 机器级共享技能来源合入）/ `load_skill` / `@` 补全 / `helm-cli` 受管技能）、`builtin:workflow`（子代理三工具 + DSL 引擎 + Worktree 租约）、`builtin:memory`（单 Profile `MEMORY.md` 64k 文件锁与开关）、`builtin:apps`（全栈微应用 `catalog`、`validate/publish` 与 `app-builder` 技能）、`builtin:json-render`（`ui` 围栏卡片与 `generative-ui` 技能）、`builtin:mermaid`（`mermaid` 围栏图表）、`builtin:triggers`（Cron 与 Webhook `defang` 入站）；
   - **默认停用（3 个）**：`builtin:herdr`（拦截 `agent_spawn` 驱动 23 种终端 CLI、`.helm/wf-out-*` 文件交接自愈、CAS 审批桥、`$helm` 状态 Token）、`builtin:superagent`（双层中枢路由、驻留 Worker、RecallGraph、自管两层 Watchdog）、`builtin:magpie`（动态模型网关）。
   - **插件通用铁律**：① 停用后其工具、动作、CLI 命令、受管技能与 UI 贡献**即时消失，不留幻影提示词**；② 高频会话级状态（如 workflow `runs`）必须用 `ctx.sessionDoc` 专用 SSE 按需订阅，严禁进全局 `ctx.doc` 造成首帧/广播写放大（单文档上限 2 MiB，超限 `413`）；③ 全局启动先按依赖拓扑对全体服务执行 `prepare()` 再依次 `start()`（如 `builtin:workflow` 先于 SDK 调度器标记中断任务取消）；④ 停用/重载遇在途任务经 `liveTasks` 硬阻断（`409 plugin_has_live_tasks`，不可 force），遇持久占用或被依赖返回 `409 plugin_in_use`（可 `--force`）。
7. **明确不做**：不做服务端 TUI 兼容层（真正的 `pi` 直接在 Herdr 终端窗格运行）；不建独立 `Space` CRUD 中间表（会话与 Profile 直接用 `(nodeId, cwd)` 物理坐标）；不写内嵌 Python 的 SSH 桥接脚本（跨节点统一走 `EnvFabric`）；不把 `helm`（控制 CLI）与 `helm-node`（节点守护进程）混装在同一包/命令；不造第二套微应用子宿主（全栈微应用即携带 `ctx.ui.screen` 的标准受管外部插件）；不在 Web 端重复造 Worktree Diff 合入状态机；不在 `Conversation` / `ModelProvider` 底层伪装终端 CLI Agent。

## 3. 诚实性红线与安全不变量（禁止造假）

- **边界处强校验**：所有外部输入（HTTP body、插件产物、工作流 DSL、事件载荷、Herdr `.helm/wf-out-*` 交接文件、RPC 响应）在入口边界做类型/Schema 校验，非法输入显式拒绝。
- **禁止静默降级**：任何能力不支持、节点离线（`409 node_offline`）、升级排空拒新（`node_draining`）或交接失败（如 `.helm/wf-out-*` 缺失或 Schema 校验失败）必须显式报错并附诊断（Herdr 附终端尾部 40 行脱敏快照），**绝不静默回退本机、绝不截取终端脏屏幕文本冒充成功结果、绝不编造 fallback/mock 数据**。
- **看门狗归属权红线（内核执行层强制）**：对 `ownedBy: 'human'`（缺省值）的人类直连会话或 Herdr 终端窗格**严禁发送任何按键或中止指令**，仅允许只读诊断与通知；对 `bot / helm` 归属的后台会话允许自动恢复或中止。一切自动化中止/提交统一走内核 `abortConversationGuarded` / `submitInputGuarded`，在会话串行域内原子复核 `expectedOwnership` 与 `expectedStateSeq`。
- **CAS 乐观锁纪律**：`AskDoc` 携带 `expectedStateSeq`——终端 `stateChangeSeq` 已推进（人类已在终端按键）时，Web 端审批自动流转 `superseded` 销单，绝不重复发键；Herdr `agent.send_keys` 强制要求服务端 `send_keys_expected_state_seq` 能力门禁。
- **机密边界如实**：`SecretStash` 保证「不落库、不进模型上下文」；但任意 shell 命令与进程内插件（含全栈微应用，属可信代码、拥有宿主权限）天然可读环境变量与内存——**不承诺对可信代码的零泄漏**，文档不得夸大。
- **会话与路由不变量**：初始会话 `#1` 无 ID 级删除豁免（删除后重启凭 tombstone 不复活、不补种）；受管会话由 `ctx.host.manageConversation` 保护（`409 conversation_managed_by_plugin`），产品逻辑不依赖固定会话 ID。无显式目标的 `trigger` 在钩子链后选最新无父链 human-owned assistant 会话；失效的显式目标不得被 ThreadKey 路由掩盖；工作流新 run 必须显式指定会话或 `--current`，resume 沿用原 run 目标。忙时策略仅 `steer | followUp | reject`（内核默认 `steer`，批处理用 `followUp`）；输入来源 `origin: human | agent | trigger` 附着于 `helm.input`，后台 Worker 回合含 `agent / trigger` 输入即向 SuperAgent 中枢汇报，纯 `human` 回合仅静默更新召回图谱。

## 4. 高频改动联动检查单（改 X 必须同步 Y）

- **改动跨包类型 / 接口 / 导出符号** → 先改 `@helm/protocol`，再全仓搜索（`rg`）普查 `kernel / node / cli / web / 测试` 全部消费方并同步，漏改即事故。
- **新增 / 变更面向用户的 HTTP 接口** → 同一次改动必须补齐 `helm` CLI 映射（`packages/cli/src/commands/`，含 `--json` 与 `--current` 会话/节点自动感知），并同步 `@helm/protocol` 的 `CORE_CLI_COMMAND_PATHS` 与 `builtin:profile` 的 `helm-cli` 技能文档（`services.test.ts` 双向锁定校验）。
- **插件暴露业务能力** → 用 `ctx.action({ id, inputSchema, outputSchema })` 单点声明，自动获得五端映射：HTTP（`POST /api/actions/<pluginId>/<actionId>`）、CLI（`helm <plugin> <action>`，剥离 `builtin:` 前缀，`cli.command` 可覆写）、Agent Tool（`exposeAsTool` 或 `run_action`）、Workflow `action()` 与 Web UI。
- **编写 / 重构 Web 界面或插件 `client.tsx`** → 先读 [`docs/conventions/web-frontend.md`](docs/conventions/web-frontend.md)（布局/组件/样式/移动端）与 [`docs/conventions/web-navigation.md`](docs/conventions/web-navigation.md)（路由/深链/分屏/待命页/弹窗），并遵守五条硬铁律：
  1. **零 Emoji**：界面文案、导航、标题、按钮、徽章、卡片严禁 Emoji；图标统一 `lucide-react`（`HelmIcon`）或纯文本；
  2. **视图形态三级**：海量项 / 多维检索 / 管理与市场类必须用「全屏一级主舞台卡片网格 + 右侧 520px~560px 详情抽屉」，严禁塞居中弹窗；
  3. **Radix UI 唯一交互原语**：一律基于 `packages/web/src/ui/` 封装（全仓禁原生 `<select>` 与手写无障碍浮层）；插件优先复用 `@helm/plugin-client` 的 `Screen / ScreenSection / DataTable / KvGrid` 与宿主原语类，禁大面积内联样式或复制通用 CSS；正文 13/14px，移动端（≤680px）与分屏下禁输入框字号突兀放大；
  4. **唯一 Hash 导航**：全站位置由 `url-hash-model.ts` + `HelmStoreProvider` 唯一管理（`#/a/<profileId>` 待命真草稿、`#/c/<id>` 会话、`#/s/<pluginId>/<screenId>` 视图、`sp.*`/`ssp.*` 参数、`split` 分屏、`sidebar` 空间）；组件统一调 `store.openTarget / setScreenParams / setSidebarSpace` 等，**新建对话进待命页、首次发送才落库**，严禁自建平行路由或直接操作 `history.*`；
  5. **Fast Refresh**：`.tsx` 组件文件只导出组件与 TS 类型，纯函数/常量剥离至独立模块。

## 5. 测试分层与执行规范

- **分层入口**：`scripts/test-suites.mjs`（复用 `scripts/run-tests.mjs` 的跨平台超时与进程树清理），三档命令：`pnpm test:unit` / `pnpm test:integration` / `pnpm test:all`（`pnpm test` 等同 `test:all`）。
- **单测防死锁**：每个测试显式声明 `{ timeout: 60_000 }`（runner 为 `tsx --test`）；不依赖 Unix `timeout` 命令；不用过滤管道隐藏失败日志；**勿设 `HELM_TEST_SUITE_TIMEOUT_MS` 环境变量**（kernel 的 `env-registry-races` 会因宿主残留 HELM_* 变量误报）。
- **分档与执行规则**：
  - `unit` = `protocol + cli + web`（进程内 / happy-dom DOM 模拟，不起真实服务）——改协议、CLI、Web 时默认跑；
  - `integration` = `kernel + node + payload + desktop`（真实进程、SQLite、Git、WebSocket、`createHelm`、daemon、payload 组装与桌面壳 Hub 子进程监督，全部视为集成）——改 kernel / node / payload / desktop 时必跑；
  - 跨档契约变更两档都跑；合并前与全量验收跑 `test:all`。不变量 `all = unit ∪ integration` 不重不漏；新测试文件必须落在已登记包的 `test/` 目录，新包同步更新 `scripts/test-suites.mjs` 的 `SUITES` 分档。
- **快速反馈门（补充而非替代）**：`pnpm check:changed` 按变更集（`--base <ref>` 显式基线优先；默认取分支 upstream 或 origin/HEAD 的 merge-base，均无则报错要求 `--base`，绝不静默退化 HEAD~1；变更集 = 已提交 ∪ 暂存/未暂存 ∪ 未跟踪；pnpm 传参用 `--` 分隔，如 `pnpm check:changed -- --base main --list`）选受影响包（workspace 依赖反向闭包，锁文件/根配置/测试基础设施（含 `scripts/**/*.mjs`）变更触发全档），顺序跑 `pnpm typecheck` →（选中 desktop 测试时先 `pnpm --filter @helm/desktop run build`，typecheck 不产其 dist）→ 受影响包测试（复用 `run-tests.mjs`）；`--list` 先复核选集。`pnpm check:hygiene` 用 TypeScript AST 静态检查测试卫生（显式 timeout、skip 必附理由、禁设 `HELM_TEST_SUITE_TIMEOUT_MS`）。二者只提供增量快速反馈，不改变本节分档必跑与合并前 `test:all` 的规定。
- **进程 kill 纪律**：只允许终止**自己 spawn 并持有 PID/句柄**的进程（POSIX：独立进程组 `kill(-pid)`，宽限后 SIGKILL；Windows：`taskkill /PID <pid> /T /F` 杀 owned `ChildProcess` 整棵树，参考 `scripts/run-tests.mjs`）；确需按端口清理时，必须先核验监听进程的 cwd 与实际归属再终止。**严禁按模糊名称/路径发信号（如 `pkill -f`、`pgrep | xargs kill`、`taskkill /IM`）**（会误杀他人会话、其他 worktree 的 dev 服务与无关系统进程），严禁猜测 PID。

## 6. 开发流程与多智能体协作

- **主代理职责**：拆分任务、确定接口、协调子代理、审查结果与最终验收；重实现、大范围开发和成套测试交给子代理。
- **子代理模型**：所有子代理统一使用 GLM（`glm-agent`），覆盖调查、审查、规划、实现与验收；除非用户明确变更此偏好。
- **Worktree 隔离（严禁 `/tmp`）**：首 commit 后并行开发一律在主仓同级磁盘目录 `../helm-worktrees/<name>` 建 worktree（避开 tmpfs 内存盘）；委派子代理提示词须显式指定该路径及核心约束，不设 `max_turns`。
- **Git 提交**：中文 Conventional Commits（如 `feat(kernel): ...`），不加 `Co-Authored-By`。

## 7. 文档中心速查（按需深入阅读）

- **总览与入门**：`docs/README.md` · `docs/getting-started/`（installation / first-workflow）· `docs/cli/reference.md`（全量命令字典）
- **架构机制**：`docs/architecture/overview.md`（微内核哲学与五包拓扑）· `extension-points.md`（Hook 与 16 个 UI 扩展点完整契约）· `envfabric.md`（反向 WS、隧道、文件互斥、自升级）· `pi-durable.md`（五态状态机、存储、机密、CAS 审批）
- **编排引擎**：`docs/workflows/dsl-guide.md`（JS DSL 权威参考）· `worktree-and-gate.md`（Worktree 生命周期与 Gate 门禁）· `journaling-recovery.md`（账本重放与断点恢复）
- **插件生态**：`docs/plugins/overview.md`（契约总纲）· `plugin-development.md`（外部插件开发实战）及各内置插件同名文档：`profile / workflow / memory / apps / herdr / superagent / triggers / magpie / json-render / mermaid`
- **Web 约定**：`docs/conventions/web-frontend.md`（设计系统）· `docs/conventions/web-navigation.md`（URL Hash 与导航）
