# helmx 开发约定

**helmx** 是极简持久微内核个人助理、多智能体确定性编排与 Herdr 协同主控台系统。本文件约束所有参与开发的智能体与人类；按需深入的文档路标见文末第 7 节。

## 1. 环境、隔离与破坏性变更授权（最高优先级）

- **工作目录**：主仓位于 `/root/code/helm`，改代码开发必须在同级独立 worktree（`../helm-worktrees/<name>`，禁用 `/tmp`）中完成（纯文档等轻量例外见第 6 节）；开发智能体的继承 `cwd` 可能位于旧仓库，每次开工先显式 `cd`。
- **历史仓库严格只读**：`/root/code/botx`、`/root/code/botd`、`/root/code/herdr` 仅可参考代码与 `node_modules` 验证 SDK / 协议行为，**绝不修改**。
- **运行数据隔离**：数据目录仅限 `~/.helmx`（或 `HELMX_DATA_DIR` 覆盖值），与 `~/.botx`、`~/.botd` 完全隔离，不得读写旧系统运行数据。
- **端口铁律**：Web dev 固定 `3201`（`strictPort: true`，代理 `/api`、`/ws`），内核 Hub 固定 `3202`（`HELMX_PORT=3202`）。**永不占用 `3000`（外部）、`3001/3002`（botd）、`3101/3102`（botx）**。
- **开发阶段：不兼容、不迁移**：
  - 允许对 helmx 代码、公共接口、配置、数据库结构和开发数据**直接进行破坏性修改、删除或重建**，以最新设计为准。
  - **严禁编写向后兼容层、旧格式读取、迁移脚本、双写或兼容适配**；旧开发数据直接清理按新结构重建，测试同步采用新契约。此授权限于 helmx 项目与开发数据；历史仓库只读、数据隔离与端口约束继续有效。

```bash
HELMX_PORT=3202 pnpm dev        # 前后端一起（Web 3201 -> Hub 3202）
HELMX_PORT=3202 pnpm dev:kernel # 只起内核
pnpm dev:web                   # 只起前端（需内核已在 3202）
pnpm link:bins                 # 可选：在 /usr/local/bin 挂载 helmx / helmx-node / helmx-hub 源码命令
pnpm build && pnpm typecheck && pnpm lint && pnpm check:hygiene && pnpm test:all # 全量验收（增量异常可加 HELMX_CLEAN_DIST=1）
```

## 2. 架构边界与设计原则

**设计原则**：第一性原理推导最简正确实现（感觉笨重先怀疑设计，不打补丁）；KISS / YAGNI；命名自解释、注释只写 Why；一个模块只做好一件事；**机制与策略分离**（内核给机制，策略由插件/配置/用户层给）。

1. **单向包依赖**：`@helmx/kernel` 提供机制，`@helmx/plugins` 承载内置插件，`@helmx/hub` 是连接两者的产品组合根并提供 `helmx-hub` 命令；内核不得依赖插件或组合根。`@helmx/plugin-client` 是独立浏览器 SDK，`@helmx/web` 通过宿主端口向它注入应用能力；SDK 不得反向依赖 Web 应用。`@helmx/plugin-build` 提供构建实现，由产品层通过端口注入宿主。`@helmx/protocol` 只放通用跨包契约，零运行时重依赖；插件业务契约归属插件包，跨包变更必须普查全部消费方。
2. **内核只保留四块通用机制**（`@helmx/kernel`，零业务角色硬编码）：
   - `pi-durable` 持久会话：通用 `Conversation(nodeId, cwd)` 五态状态机、`state.sqlite` + FTS5（**纯可重建派生索引，禁写 `pi_*` 表语义**）、`AskDoc`、`SecretStash`、`Artifacts`、纯文件资产热重载、原生 `spawnAgent` 子会话派生（`agent_spawn` Hook 管道 + 默认执行行）；
   - `EnvFabric` + `NodeRegistry`：`/ws/node` 反向控制网关、`/ws/node-tunnel` 任意 TCP 透传隧道（`openTunnel` 原语 + `nodeFetch` 适配层 + `helmx nodes forward` 端口转发），内建 `local` 节点 + 远端 `@helmx/node` 守护进程，驱动 `bash / read / write / edit / gate / env exec` 与按 `nodeId + canonicalPath` 的文件互斥（与任何插件是否启用正交）；
   - `Model 与 Auth`：模型供应商接入、模型禁用过滤、凭据与令牌管理；
   - `PluginHost`：`definePlugin(ctx)` 唯一强类型宿主、受管包生命周期（`doctor / install / update / remove / reload`）、插件间 `dependencies` 拓扑启停与 `ctx.host` 运行时端口。
3. **零角色枚举**：严禁在内核硬编码 `'router' | 'worker' | 'watchdog'`；会话身份由 `profileId` 表达，运行态标记由 `tags` 表达。
4. **不在内核的能力**：`subagent / SubagentWorkflow` 工具与 DSL 编排引擎归属 `builtin:workflow`，`cleanup_worktree` 工具与 `WorktreeAllocator`（Worktree 分配/租约/持有锁/清理）归属 `builtin:worktree`；内核无巡检定时器、无 `watchdog_tick` Hook、无内置声明式 JSON 渲染轨道（分别由 `builtin:superagent` 自管服务与 `builtin:json-render` 提供）。
5. **扩展面契约（零 `if/else` 插件 ID 业务特判）**：
   - **后端 7 个生命周期 Hook**（`continue | transform | handled | block`，`block` 仅限 `tool_call` 与 `input`）：`trigger`、`input`、`before_turn`、`tool_call`、`tool_result`、`agent_spawn`（额外支持 `next` around 包装）、`turn_settled`（统一覆盖 `completed | failed | aborted`）；
   - **前端 16 个 `ctx.ui` 扩展点**（`client.tsx` React 单轨）：`sidebarItem`、`sidebarSection`、`screen`、`timelineRenderer`、`markdownCodeBlock`、`toolView`、`composerPill`、`composerWidget`、`composerCompleter`、`artifactPreviewer`、`workbenchPanel`、`command`、`settingsPanel`、`profileRuntime`、`action`（`conversation:header | row | timeline:entry`）、`slot`。
6. **14 个内置插件**（实现位于 `@helmx/plugins`，由 `@helmx/hub` 注册；深度文档见 `docs/plugins/<name>.md`）：
   - **默认启用（12 个）**：`builtin:profile`（`locked` 常驻；SYSTEM.md / 技能目录（含 `~/.agents/skills` 机器级共享技能来源合入）/ `load_skill` / `@` 补全 / `helmx-cli` 受管技能）、`builtin:workflow`（`subagent` / `SubagentWorkflow` 两工具 + DSL 引擎；Hub 组合根须先于 `builtin:worktree` 注册，保证 `runtime.started` 先收敛遗留子会话再回收崩溃租约）、`builtin:worktree`（`WorktreeAllocator` / 持久租约与 `ManagedWorktreeHold` / `agent_spawn` around priority 200 / `cleanup_worktree` 工具与 `worktrees` CLI；与 workflow 零静态依赖）、`builtin:swarm`（扁平对等序号黑板、正交唤醒、`turn_settled` 纯事件自愈与自适应协同看板；零常驻会话，按需复用 `builtin:worktree` Worktree）、`builtin:memory`（单 Profile `MEMORY.md` 64k 文件锁与开关）、`builtin:apps`（全栈微应用 `catalog`、`validate/publish` 与 `app-builder` 技能）、`builtin:json-render`（`ui` 围栏卡片与 `generative-ui` 技能）、`builtin:mermaid`（`mermaid` 围栏图表）、`builtin:triggers`（Cron 与 Webhook `defang` 入站）、`builtin:magpie`（动态模型网关）、`builtin:token-speed`（输入区实时解码速率；滑动窗口 / TTFT / 终态对账全在插件，内核只透传 `ConversationLive.generation` 通用流式事实）、`builtin:tasks`（任务看板、`tasks` 受管技能、独立执行会话与人工验收）；
   - **默认停用（2 个）**：`builtin:herdr`（拦截 `agent_spawn` 驱动 23 种终端 CLI、`.helmx/wf-out-*` 文件交接自愈、CAS 审批桥、`$helmx` 状态 Token）、`builtin:superagent`（双层中枢路由、驻留 Worker、RecallGraph、自管两层 Watchdog）。
   - **插件通用铁律**：① 停用后其工具、动作、CLI 命令、受管技能与 UI 贡献**即时消失，不留幻影提示词**；② 高频会话级状态（如 workflow `runs`）必须用 `ctx.sessionDoc` 专用 SSE 按需订阅，严禁进全局 `ctx.doc` 造成首帧/广播写放大（单文档上限 2 MiB，超限 `413`）；③ 全局启动先按依赖拓扑对全体服务执行 `prepare()` 再依次 `start()`（如 `builtin:workflow` 先于 SDK 调度器标记中断任务取消）；④ 停用/重载遇在途任务经 `liveTasks` 硬阻断（`409 plugin_has_live_tasks`，不可 force），遇持久占用或被依赖返回 `409 plugin_in_use`（可 `--force`）。
7. **明确不做**：不做服务端 TUI 兼容层（真正的 `pi` 直接在 Herdr 终端窗格运行）；不建独立 `Space` CRUD 中间表（会话与 Profile 直接用 `(nodeId, cwd)` 物理坐标）；不写内嵌 Python 的 SSH 桥接脚本（跨节点统一走 `EnvFabric`）；不把 `helmx`（控制 CLI）与 `helmx-node`（节点守护进程）混装在同一包/命令；不造第二套微应用子宿主（全栈微应用即携带 `ctx.ui.screen` 的标准受管外部插件）；不在 Web 端重复造 Worktree Diff 合入状态机；不在 `Conversation` / `ModelProvider` 底层伪装终端 CLI Agent。

## 3. 诚实性红线与安全不变量（禁止造假）

- **边界处强校验**：所有外部输入（HTTP body、插件产物、工作流 DSL、事件载荷、Herdr `.helmx/wf-out-*` 交接文件、RPC 响应）在入口边界做类型/Schema 校验，非法输入显式拒绝。
- **禁止静默降级**：任何能力不支持、节点离线（`409 node_offline`）、升级排空拒新（`node_draining`）或交接失败（如 `.helmx/wf-out-*` 缺失或 Schema 校验失败）必须显式报错并附诊断（Herdr 附终端尾部 40 行脱敏快照），**绝不静默回退本机、绝不截取终端脏屏幕文本冒充成功结果、绝不编造 fallback/mock 数据**。
- **看门狗归属权红线（内核执行层强制）**：对 `ownedBy: 'human'`（缺省值）的人类直连会话或 Herdr 终端窗格**严禁发送任何按键或中止指令**，仅允许只读诊断与通知；对 `bot / helmx` 归属的后台会话允许自动恢复或中止。一切自动化中止/提交统一走内核 `abortConversationGuarded` / `submitInputGuarded`，在会话串行域内原子复核 `expectedOwnership` 与 `expectedStateSeq`。
- **CAS 乐观锁纪律**：`AskDoc` 携带 `expectedStateSeq`——终端 `stateChangeSeq` 已推进（人类已在终端按键）时，Web 端审批自动流转 `superseded` 销单，绝不重复发键；Herdr `agent.send_keys` 强制要求服务端 `send_keys_expected_state_seq` 能力门禁。
- **机密边界如实**：`SecretStash` 保证「不落库、不进模型上下文」；但任意 shell 命令与进程内插件（含全栈微应用，属可信代码、拥有宿主权限）天然可读环境变量与内存——**不承诺对可信代码的零泄漏**，文档不得夸大。
- **会话与路由不变量**：初始会话 `#1` 无 ID 级删除豁免（删除后重启凭 tombstone 不复活、不补种）；受管会话由 `ctx.host.manageConversation` 保护（`409 conversation_managed_by_plugin`），产品逻辑不依赖固定会话 ID。无显式目标的 `trigger` 在钩子链后选最新无父链 human-owned assistant 会话；失效的显式目标不得被 ThreadKey 路由掩盖；工作流新 run 必须显式指定会话或 `--current`，resume 沿用原 run 目标。忙时策略仅 `steer | followUp | reject`（内核默认 `steer`，批处理用 `followUp`）；输入来源 `origin: human | agent | trigger` 附着于 `helmx.input`，后台 Worker 回合含 `agent / trigger` 输入即向 SuperAgent 中枢汇报，纯 `human` 回合仅静默更新召回图谱。

## 4. 高频改动联动检查单（改 X 必须同步 Y）

- **改动跨包类型 / 接口 / 导出符号** → 先改契约所属包（通用契约为 `@helmx/protocol`，插件业务契约为 `@helmx/plugins`），再全仓搜索（`rg`）普查全部包与测试的消费方并同步，漏改即事故。生产源码不得通过相对路径跨包或导入其他包的私有 `src`；新增依赖必须声明，包依赖图必须无环。
- **新增 / 变更面向用户的 HTTP 接口** → 同一次改动必须补齐 `helmx` CLI 映射（`packages/cli/src/commands/`，含 `--json` 与 `--current` 会话/节点自动感知），并同步 `@helmx/protocol` 的 `CORE_CLI_COMMAND_PATHS` 与 `builtin:profile` 的 `helmx-cli` 技能文档（`services.test.ts` 双向锁定校验）。
- **插件暴露业务能力** → 用 `ctx.action({ id, inputSchema, outputSchema })` 单点声明，自动获得五端映射：HTTP（`POST /api/actions/<pluginId>/<actionId>`）、CLI（`helmx <plugin> <action>`，剥离 `builtin:` 前缀，`cli.command` 可覆写）、Agent Tool（`exposeAsTool` 或 `run_action`）、Workflow `action()` 与 Web UI。
- **编写 / 重构 Web 界面或插件 `client.tsx`** → 先读 [`docs/conventions/web-frontend.md`](docs/conventions/web-frontend.md)（布局/组件/样式/移动端）与 [`docs/conventions/web-navigation.md`](docs/conventions/web-navigation.md)（路由/深链/分屏/待命页/弹窗），并遵守五条硬铁律：
  1. **零 Emoji**：界面文案、导航、标题、按钮、徽章、卡片严禁 Emoji；图标统一 `lucide-react`（`HelmxIcon`）或纯文本；
  2. **视图形态三级**：海量项 / 多维检索 / 管理与市场类必须用「全屏一级主舞台卡片网格 + 右侧 520px~560px 详情抽屉」，严禁塞居中弹窗；
  3. **Radix UI 唯一交互原语**：共享组件使用 `@helmx/plugin-client` 的 Radix 封装；Web 专有组件位于 `packages/web/src/ui/`（全仓禁原生 `<select>` 与手写无障碍浮层）；插件优先复用 `@helmx/plugin-client` 的 `Screen / ScreenSection / DataTable / KvGrid` 与宿主原语类，禁大面积内联样式或复制通用 CSS；工作台正文 13/14px，会话正文、提问胶囊与 Composer 输入 15px（详见 `docs/conventions/web-frontend.md`），移动端（≤680px）与分屏下禁输入框字号突兀放大；
  4. **唯一 Hash 导航**：全站位置由 `url-hash-model.ts` + `HelmxStoreProvider` 唯一管理（`#/a/<profileId>` 待命真草稿、`#/c/<id>` 会话、`#/s/<pluginId>/<screenId>` 视图、`sp.*`/`ssp.*` 参数、`split` 分屏、`sidebar` 空间）；组件统一调 `store.openTarget / setScreenParams / setSidebarSpace` 等，**新建对话进待命页、首次发送才落库**，严禁自建平行路由或直接操作 `history.*`；
  5. **Fast Refresh**：`.tsx` 组件文件只导出组件与 TS 类型，纯函数/常量剥离至独立模块。

## 5. 测试分层与执行规范

- **入口与卫生门禁**：分档跑 `pnpm test:unit` / `test:integration` / `test:all`（`scripts/test-suites.mjs`，AST 纯单测自动 `--test-isolation=none` 合片，其余进程隔离；默认最多 16 个测试 worker（不超过可用 CPU 数），`TEST_CONCURRENCY` 可覆写）；日常快速反馈优先跑 `pnpm test:unit` 或 `pnpm check:changed`，均不替代合并前 `pnpm test:all`；单跑指定文件用 `node scripts/run-tests.mjs <file...>`（禁裸跑 `node/tsx --test` 绕过超时看门狗与 `safe-test-assert`），不用过滤管道隐藏失败日志，不依赖 Unix `timeout`。`pnpm check:hygiene` AST 门禁强制四条红线：① 每个 `test/it` 显式 `{ timeout: 60_000 }`；② `skip` 必附理由字符串；③ **禁设 `HELMX_TEST_SUITE_TIMEOUT_MS`**（触发 `env-registry-races` 误报）；④ **禁对 DOM 节点 / `Window` 调 `assert.equal` / `deepEqual`**（防 Fiber 树 `util.inspect` OOM，改用 `assert.ok(a === b)` 或断言标量属性）。
- **分档与执行规则**：
  - `unit` = `protocol + env-io + test-kit + cli + web + plugin-client`（纯内存 / happy-dom，不起真实服务）——改协议、测试基座、CLI、Web 或浏览器 SDK 必跑；
  - `integration` = `kernel + plugins + hub + plugin-build + node + payload`（真实进程、SQLite、Git、WS、构建、`createHelmx`、daemon、launcher 进程生命周期、共享更新引擎与 payload）——改执行、插件、产品或构建包必跑。**路径级例外**：`packages/cli/test/launcher/`（Hub 生命周期面）与 `packages/env-io/test/update/`（共享更新引擎）两组真实进程测试位于 unit 档包内，但以路径级条目固定归属 `integration` 档（`SUITES` 枚举支持子目录）；
  - 跨档变更两档都跑，合并前跑 `test:all`（不变量 `all = unit ∪ integration` 不重不漏）；新测试文件须落在已登记包的 `test/`，新包同步更新 `scripts/test-suites.mjs`（`SUITES`）与 `scripts/lib/workspace-meta.mjs`（`PACKAGE_TIERS`）。
  - **文档例外**：仅修改独立文档（如 `AGENTS.md`、`docs/`、`README.md` 等，不涉及 `packages/` 代码、脚本、构建配置或受测试校验的内置资产）时，跳过构建与测试跑批，避免无效耗时。
- **共享基座、防抖与防散沙**：复用 `@helmx/test-kit`（仅限 `devDependencies` 与 `test/`，`package-boundaries` 锁死零生产泄漏）及包级 harness（`cli-harness`、`dom-harness`、`plugin-test-env`、`hub-test-env`、`host-backend-stub`）：临时目录用 `useTempDir`，Git 仓库用 `createGitTemplate().cloneTo()`，子进程环境用 `sanitizedHostEnv` / `makeCliEnv`，Web DOM 用 `ensureHappyDom()`。同步等待用 `deferred` / `waitFor` / 可注入计时参数，禁长固定 `sleep` 与无余量的硬编码墙钟上界断言（超时逃逸须拉大阻塞时长与阈值之比以抗高并发抖动）；纯内存单测保持零全局副作用以便 `test-sharding.mjs` 合片。**三禁**：禁已删功能的历史墓碑测试、禁正则扫描 CSS/TSX 源码的脆弱断言（测 DOM 行为、导出模型或结构不变量）、禁按零散问题新建一两行碎片测试文件（并入对应领域测试）。
- **快速反馈门（补充而非替代）**：`pnpm check:changed` 按变更集（已提交 ∪ 暂存/未暂存 ∪ 未跟踪；`--base <ref>` 优先，默认取 upstream 或 `origin/HEAD` 的 merge-base，均无则报错要求 `--base`，绝不退化 `HEAD~1`；传参如 `pnpm check:changed -- --base main --list`）选反向闭包受影响包（锁文件/根配置/`scripts/**/*.mjs` 触发全档），顺序执行 `pnpm typecheck` → 受影响包测试；配合 `pnpm check:hygiene` 提供增量快速反馈，不替代分档必跑与合并前 `test:all`。
- **进程 kill 纪律**：只允许终止**自己 spawn 并持有 PID/句柄**的进程（POSIX：独立进程组 `kill(-pid)`，宽限后 SIGKILL；Windows：`taskkill /PID <pid> /T /F` 杀 owned `ChildProcess` 整棵树，参考 `scripts/run-tests.mjs`）；确需按端口清理时，必须先核验监听进程的 cwd 与实际归属再终止。**严禁按模糊名称/路径发信号（如 `pkill -f`、`pgrep | xargs kill`、`taskkill /IM`）**（会误杀他人会话、其他 worktree 的 dev 服务与无关系统进程），严禁猜测 PID。

## 6. 开发流程与多智能体协作

- **Worktree 隔离开发**：不强制使用子代理；无论单代理开发还是拆分子代理，所有代码开发必须在主仓同级独立 worktree（`/root/code/helm-worktrees/<name>`，即 `../helm-worktrees/<name>`）中完成，禁止直接在共享主工作树 `/root/code/helm` 改代码或使用 `/tmp`。开工前核实实际 worktree 绝对路径与基线；合回主干（`main`）前须先合入最新主干并在该 worktree 内跑通验证。
- **多子代理并行与集成合入**：多个子代理并行开发时，每个写代码的子代理必须独占各自的 `../helm-worktrees/<task>`（提示词写明绝对路径与允许修改范围），**严禁将子代理分支逐个直接合入主干**。必须按序执行：① 新建独立的集成 worktree（`../helm-worktrees/<integration>`），将各子代理改动先合并进该集成 worktree；② 再把最新主干（`main`）合入该集成 worktree 并解决冲突；③ 在集成 worktree 内跑通构建、门禁与测试且确认无误后，才允许合回主干。
- **合并后清理收尾**：改动合回主干（`main`）后必须完成清理：① 按第 5 节「进程 kill 纪律」停止本轮自己启动的所有服务与后台进程（如 `dev`、Hub `3202`、Web `3201`、临时 `helmx-node` 或测试验收服务，严禁误杀他人或其它 worktree 的进程）；② 确认各工作与集成 worktree 已合入且无保留未提交改动后，移除对应 `../helm-worktrees/<name>`（`git worktree remove`）并删除已合并临时分支（`git branch -d`）；③ 清理自建临时 `HELMX_DATA_DIR` 等测试目录，确认主仓 `git status` 干净。
- **轻量改动例外**：仅修改独立文档（如 `AGENTS.md`、`docs/`、`README.md` 等，不涉及源码、脚本、构建配置或受测试校验的包内资产）时，可直接在主仓修改并跳过独立 worktree 与构建/测试跑批。
- **改动所有权**：已有的修改、暂存和未跟踪文件默认属于用户或其他代理；先记录状态，所有权不明时保留并询问。禁止为清理或同步而重置、清除或覆盖这些改动。
- **恢复纪律**：禁止从移动中的 `HEAD` 盲目恢复文件，包括 `git show HEAD:<file> > <file>`；恢复前固定基线并核实文件来源，只按确认的文件操作。发现误覆盖时立即停止写入，保留现场并查找快照、reflog 或其他恢复来源。
- **Git 提交**：中文 Conventional Commits（如 `feat(kernel): ...`），不加 `Co-Authored-By`。

## 7. 文档中心速查（按需深入阅读）

- **总览与入门**：`docs/README.md` · `docs/getting-started/`（installation / first-workflow）· `docs/cli/reference.md`（全量命令字典）· `docs/releasing.md`（发版流程：`pnpm release` 本地编排、三制品契约与 GitHub Release notes）
- **架构机制**：`docs/architecture/overview.md`（微内核职责与单向包拓扑）· `extension-points.md`（Hook 与 16 个 UI 扩展点完整契约）· `envfabric.md`（反向 WS、隧道、文件互斥、自升级）· `pi-durable.md`（五态状态机、存储、机密、CAS 审批）
- **编排引擎**：`docs/workflows/dsl-guide.md`（JS DSL 权威参考）· `worktree-and-gate.md`（Worktree 生命周期与 Gate 门禁）· `journaling-recovery.md`（账本重放与断点恢复）
- **插件生态**：`docs/plugins/overview.md`（契约总纲）· `plugin-development.md`（外部插件开发实战）及各内置插件同名文档：`profile / workflow / worktree / swarm / memory / apps / herdr / superagent / triggers / magpie / json-render / mermaid / token-speed`
- **Web 约定**：`docs/conventions/web-frontend.md`（设计系统）· `docs/conventions/web-navigation.md`（URL Hash 与导航）
