# Helm

Helm 是以 `pi-durable` 为底座的持久会话微内核。共享契约位于 `@helm/protocol`，运行时与插件宿主位于 `@helm/kernel`，`@helm/node` 通过 HTTP 提供 CLI。

核心、常驻 `builtin:assistant` 和 CLI 已实现；`builtin:herdr` 按需启用，负责终端 Agent 委派；实验性 `builtin:superagent` 按需启用，提供独立中枢、后台 Worker 与两层巡检；`builtin:triggers` 按需启用，提供 `cron` 与 `webhook` 入站触发器。Web 外壳后续接入。架构约束见 [AGENTS.md](./AGENTS.md)，目标设计见 [设计文档](./docs/20261106%20helm极简微内核与双7扩展点设计文档.md)。当前验收记录见 [Triggers 开发交接](./docs/20261107-Triggers开发交接.md)，此前记录见 [SuperAgent 开发交接](./docs/20261107-SuperAgent开发交接.md)、[Herdr 开发交接](./docs/20261107-Herdr开发交接.md) 与 [核心开发交接](./docs/20261106-核心开发交接.md)。

需要 Node.js 24.12 或更新版本及 pnpm。

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

启动内核：

```bash
HELM_PORT=3202 pnpm dev:kernel
```

默认监听 `127.0.0.1:3202`，数据目录为 `~/.helm`。通过 `HELM_DATA_DIR` 可指定独立数据目录。会话模型按“会话显式覆盖 > 所属 Profile 的 `model` > 全局默认”解析；全局默认按启动参数、`HELM_MODEL`、`config.json.model` 顺序读取。`PATCH { "model": "" }` 清除会话覆盖并恢复继承，切换 Profile 时同步更新继承模型。模型凭据使用凭据服务配置，未配置模型时提交输入会返回显式错误。

自定义兼容网关目前按模型 ID 配置。SDK 所需的上下文窗口、输出上限和计价字段使用配置缺省值，未探测网关的实际能力，不能据此估算费用。官方模型目录由 SDK 提供。

```bash
pnpm helm --help
pnpm helm setup --password '请替换为至少八位的管理员密码'
pnpm helm status --json
pnpm helm conversations list --json
```

`setup` 只允许首次初始化；后续终端使用 `pnpm helm login` 登录。CLI 将登录凭据 JSON（Hub 地址与 Token）写入数据目录中的 `cli-token`，权限为 `0600`；模型和插件密钥保存在 `credentials.json`。`HELM_TOKEN` 优先于磁盘凭据，显式提供时不读取凭据文件。

CLI 使用 `HELM_HUB_URL` 指定 Hub，默认 `http://127.0.0.1:3202`。支持指定会话的命令可通过 `--current` 读取 `HELM_CONVERSATION_ID`。内核受管 Shell 自动获得仅本进程有效的 `HELM_TOKEN` 和当前会话环境，可直接调用 CLI；该 Token 随进程关闭失效，其回显通过统一出站脱敏处理。

读取会话不会自动清除未读状态。`conversations list --profile <id> --status <state>` 可按角色和状态筛选；`conversations get` 返回会话摘要和最近一页时间线，可用 `--limit`、`--cursor` 继续读取。`send --meta '<JSON 对象>' --wait` 将元数据附着在本次输入上，等待本次提交的回答并输出结果。删除会话会清理产物和搜索索引，并阻止后续访问；受 SDK 接口限制，SQLite 内部历史记录仍保留。根会话和启用插件登记托管的常驻会话受删除保护。

工作流在独立 Worker 中执行，使用 `vm` 约束确定性。所有外部操作通过宿主原语发起；`vm` 不作为恶意脚本的安全隔离边界。`workflows run <nameOrFile> --wait` 等待终态并返回结果。工作流恢复会复用成功的调用前缀；如果动作留下开始记录但没有完成记录，恢复会显式报告不确定状态。

`SecretStash` 将审批中的机密答案保存在内存中，持久状态和模型上下文使用脱敏引用。审批创建返回 `{ id, status, answers }`，明确区分回答、取消和已在其他界面处理；调用方可预分配 ID 来绑定外部状态监听。Shell 和进程内插件拥有宿主权限，可以访问其执行环境；此边界不承诺对可信执行代码隐藏机密。

SSE 首帧包含会话、审批、启用插件 UI 和工作流运行摘要；随后推送时间线条目、流式状态、公开插件文档和工作流更新。插件文档必须显式声明 `public: true` 才能通过 `helm plugins doc <id> <name>` 读取，仍需 Hub 鉴权。`helm workflows runs --json` 可查看运行摘要。

项目处于开发阶段，不考虑向后兼容，不做数据迁移。代码、接口、配置和数据库结构可直接按最新设计调整；结构变化时可以清理开发数据并重新初始化。同一结构下的会话、记忆和工作流重启恢复仍需保证。Web 外壳和外部插件的 `client.tsx` 编译交付后续实现；内置插件的轻量 UI 使用 JSON Spec，复杂 Screen 留给 Web 内置组件表映射。

`builtin:superagent` 默认停用。启用时自举 `superagent`、`watchdog` Profile 和 `watchdog-playbooks` 技能包，保留已有用户资产，并动态创建「SuperAgent 中枢」与「巡检看门狗」两个常驻会话。它们的 ID 保存在公开插件文档 `index` 中，启用期间受删除保护；`#1` 继续作为个人助理入口。

```bash
pnpm helm plugins enable builtin:superagent --json
pnpm helm plugins doc builtin:superagent index --json
pnpm helm superagent dispatch_worker --prompt '检查项目并汇报结果' --profile-id assistant --json
pnpm helm superagent set_router_mode --input '{"enabled":false}' --json
pnpm helm superagent archive_worker --worker-conversation-id <会话ID> --json
```

中枢的 `dispatch_worker` 创建持久 Worker 并提交任务后立即返回，不等待 Worker 回合完成。Worker 可绑定用户的专家 Profile，并在回合内使用 `subagent` 或 `SubagentWorkflow` 调用 Herdr。路由模式开启时，中枢移除重度执行工具；普通助理和专家单聊保持原有工具集。Worker 回合包含 `agent` 或 `trigger` 来源时，结算后向中枢汇报；纯 `human` 回合仅更新 `recall-graph`。归档保留历史与产物，并解除 `threadKey` 订阅。公开文档 `subscriptions` 与 `recall-graph` 可通过同一 `plugins doc` 命令读取。

Watchdog 根据权威状态序号去重，对异常先执行确定性规则，再按需唤醒独立排障会话。自动恢复和中止在执行前复核持久归属；人类会话与窗格只允许诊断和通知。缺少权威水位的目标只通知；Herdr 状态持续很久不能单独作为自动中止依据。Watchdog 的模型工具受声明与执行双重约束，不能通过 Shell 或 `run_action` 绕过归属检查。插件管理动作自动提供 HTTP、CLI 和工作流入口；UI 贡献先经 SSE 发布，实际界面渲染仍待 Web 外壳交付。

SuperAgent 的编译后冒烟使用临时数据目录、真实 HTTP 与 CLI 子进程，验证启停、常驻保护、路由开关和重启恢复，不调用模型：

```bash
pnpm build
timeout 50s node scripts/superagent-smoke.mjs
```

`builtin:triggers` 同样默认停用，显式启用后提供 `cron` 与 `webhook` 两个入站连接器：事件经 `defang` 防逃逸信封进入 `trigger` 管道，缺省投递根会话，启用 SuperAgent 后由中枢路由；显式目标在没有订阅命中时直达。webhook 接收端点免 Hub token，用 `x-helm-signature: sha256=<HMAC-SHA256>` 对原始字节验签，secret 保存在 `credentials.json`（0600），动作输出与公开文档只返回 `hasSecret` 等元数据。cron 为每计划点至多一次尝试、`catchUp` 合并补跑，不承诺 exactly-once；手动触发是独立新事件。

```bash
pnpm helm plugins enable builtin:triggers --json
pnpm helm cron create --id nightly --schedule '0 3 * * *' --text '请汇总今日工作并汇报' --timezone Asia/Shanghai --json
pnpm helm cron list --json
pnpm helm webhook create --id ci --secret '请随机生成并仅经人工通道配置' --json
pnpm helm plugins doc builtin:triggers crons --json
```

字段、签名生成、curl 示例与交付语义见 [Triggers 开发交接](./docs/20261107-Triggers开发交接.md)。

Herdr 插件默认停用，显式启用后才连接终端服务。插件开关写入 `config.json.pluginEnabled`，重启后沿用。先配置连接，再启用；修改连接配置后需停用并重新启用。在途执行和等待续接的窗格会阻止停用。

```bash
pnpm helm plugins config builtin:herdr --input '{"socketPath":"/绝对路径/herdr.sock","startupTimeoutMs":30000}' --json
pnpm helm plugins enable builtin:herdr --json
pnpm helm herdr list --json
```

本机通过 Herdr 官方 Unix socket API 创建终端并订阅状态。Socket 路径按插件 `socketPath`、`HERDR_SOCKET_PATH`、插件 `session` 对应目录、XDG/默认配置目录依次解析。一次启用周期固定连接目标；更改连接配置后重新启用才生效。`startupTimeoutMs` 必须为 3001 到 300000 的整数，默认 30000；投递前按权威 `interactive_ready` 确认终端可输入。

`subagent` 和工作流可以指定 `herdr:<kind>`，或使用绑定 Herdr 的 Profile。CLI 专属参数通过 `runtime.args` 明确配置，`model`、`effort` 不自动翻译为各 CLI 的私有选项。例如：

```bash
pnpm helm profiles create --input '{"id":"terminal-coder","runtime":{"kind":"herdr","agent":"pi","args":["--provider","magpie","--model","zhipu/glm-5.3"]}}' --json
```

终端 Agent 必须将最终结果写入 `.helm/wf-out-*` 文件。插件读取、校验并删除交接文件；首次缺失或格式错误会在原窗格追问一次，仍失败则保留现场并报告脱敏诊断。Gate 在实际工作目录执行一次。成功窗格保活供同一工作流或父回合续接，结算后关闭；Worktree 的磁盘目录和分支保留。插件不自动按键或中止人类窗格。

`pnpm helm plugins doc builtin:herdr overview --json` 可读取本机全部窗格的状态、目录与归属。`agentStatus` 保留 Herdr 的 `idle / working / blocked / done / unknown`，普通 Shell 显示真实的 `unknown`，仅 Agent 记录提供 `stateChangeSeq`。窗格状态、焦点和位置通过事件更新，目录等没有事件的变化由现有服务端巡检周期校准。采集或订阅失败时，文档通过 `stale` 与 `error` 标明异常，并保留最后成功采集的数据和时间。总览中的人类窗格仅用于只读诊断；`herdr list/read/focus` 继续使用受管记录及原有权限。

总览可单独运行真实协议验收：在 Herdr 环境中执行 `pnpm build`，再运行 `timeout 50s node scripts/herdr-overview-smoke.mjs`。脚本自建临时命名会话，只操作自己的普通 Shell 窗格，验证 HTTP/CLI、创建／移动／关闭事件和启停清理，不调用模型。输出包含验收项、清理结果和临时日志目录。

`herdr:<kind>@<machine>` 和 Profile 的 `runtime.machine` 使用 SSH。远端需要已运行的 Herdr、Python 3 和非交互 SSH 认证。请求和环境通过 stdin 脚本传递，环境值进入 RPC 请求体；文件交接和 Gate 在远端执行，失败时显式报错。远端默认不接收本机 Hub 地址与 Token，只有 Profile 显式声明远端可达的 `runtime.env.HELM_HUB_URL` 时才注入访问环境。机密通过 SecretStash 注入，不要写入 Profile JSON。Helm 在自己的交接、事件和诊断出口脱敏，外部 CLI 的工具输出和模型上下文遵循其自身策略。

手工真实冒烟需先执行 `pnpm build`，再运行 `node scripts/herdr-smoke.mjs`。脚本使用独立命名 Herdr 会话、临时 Git 仓库和真实 GLM 模型，验证委派、结构化交接、Worktree、Gate、同窗格续接与重放；它不纳入默认单测。Herdr 阶段在 `50be88c` 上完成全仓 677/677 与真实本机模型冒烟 28/28；本阶段的当前验收记录见 [SuperAgent 开发交接](./docs/20261107-SuperAgent开发交接.md)。远端生产 Python 通道已有受控回归，SSH 实机端到端尚未验证。
