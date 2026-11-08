# Helm

Helm 是以 `pi-durable` 为底座的持久会话微内核。五个包分别负责共享契约（`@helm/protocol`）、Hub 与插件宿主（`@helm/kernel`，命令 `helm-hub`）、HTTP/SSE 客户端（`@helm/cli`，命令 `helm`）、受控节点守护进程（`@helm/node`，命令 `helm-node`）和 Web 界面（`@helm/web`）。

核心、常驻 `builtin:assistant` 和 CLI 已实现；`builtin:herdr` 按需启用，负责终端 Agent 委派；实验性 `builtin:superagent` 按需启用，提供独立中枢、后台 Worker 与两层巡检；`builtin:triggers` 按需启用，提供 `cron` 与 `webhook` 入站触发器；`builtin:magpie` 按需启用，提供动态模型目录、原生协议分发及网关配额与路由视图。Web 外壳提供会话画布、审批和插件视图。架构约束见 [AGENTS.md](./AGENTS.md)，目标设计见 [设计文档](./docs/20261106%20helm极简微内核与双7扩展点设计文档.md)。本轮验收记录见 [插件收口与界面隔离验收](./docs/20261108-插件收口与界面隔离验收.md)，此前记录见 [Triggers 开发交接](./docs/20261107-Triggers开发交接.md)、 [SuperAgent 开发交接](./docs/20261107-SuperAgent开发交接.md)、[Herdr 开发交接](./docs/20261107-Herdr开发交接.md) 与 [核心开发交接](./docs/20261106-核心开发交接.md)。

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

构建后，Hub 默认直接托管 `packages/web/dist`，浏览器可从同一个端口打开 Web 界面。通过 `HELM_WEB_DIST_DIR=/绝对路径/dist` 指定静态目录，或设为 `false` 禁用托管。静态资源与 SPA 路由由 Hub 提供，`/api` 仍使用原有鉴权与错误契约。

默认监听 `127.0.0.1:3202`，数据目录为 `~/.helm`。通过 `HELM_DATA_DIR` 可指定独立数据目录。部署时可通过反向代理转发 HTTP 与 `/ws/node`，或设置 `HELM_HOST=0.0.0.0` 接受远端连接；节点的 Hub URL 应指向其实际可达地址。会话模型按“会话显式覆盖 > 所属 Profile 的 `model` > 全局默认”解析；全局默认按启动参数、`HELM_MODEL`、`config.json.model` 顺序读取。`PATCH { "model": "" }` 清除会话覆盖并恢复继承，切换 Profile 时同步更新继承模型。模型凭据使用凭据服务配置，未配置模型时提交输入会返回显式错误。

自定义兼容网关按模型 ID 配置。SDK 所需的上下文窗口、输出上限和计价字段使用配置缺省值，未探测网关的实际能力，不能据此估算费用。官方模型目录由 SDK 提供。动态供应商使用 SDK 的 `refreshModels` 协议，目录缓存在独立的 `~/.helm/models-store.json` 中，可通过 `helm models refresh --provider <id> --json` 或供应商界面的刷新按钮更新；错误会明确返回，上次目录可保留供排查。

```bash
pnpm helm --help
pnpm helm setup --password '请替换为至少八位的管理员密码'
pnpm helm status --json
pnpm helm conversations list --json
```

`setup` 只允许首次初始化；后续终端使用 `pnpm helm login` 登录。CLI 将登录凭据 JSON（Hub 地址与 Token）写入数据目录中的 `cli-token`，权限为 `0600`；模型和插件密钥保存在 `credentials.json`。`HELM_TOKEN` 优先于磁盘凭据，显式提供时不读取凭据文件。

CLI 使用 `HELM_HUB_URL` 指定 Hub，默认 `http://127.0.0.1:3202`。支持指定会话的命令可通过 `--current` 读取 `HELM_CONVERSATION_ID`。内核受管 Shell 自动获得进程内有效的 `HELM_TOKEN` 和当前会话环境，可通过 `PATH` 直接调用 `helm`；该 Token 随进程关闭失效，其回显通过统一出站脱敏处理。

会话和 Profile 通过 `(nodeId, cwd)` 指定执行位置。`local` 是 Hub 进程内的执行环境；其他节点由 `helm-node` 主动连接 Hub 的 `/ws/node`，不要求开放入站 SSH，也不依赖 Herdr。先在 Hub 侧签发令牌，再在受控机器上绑定身份：

```bash
# Hub 客户端：签发令牌，明文仅本次返回。
pnpm helm nodes issue build-box --json

# 受控机器：将令牌保存到本机 node.json 并连接 Hub。
pnpm helm-node connect https://hub.example.com --token '<nodeId:secret>'
# 后续从本机身份文件启动，无需再次提供令牌。
pnpm helm-node start -d
pnpm helm-node status --json
pnpm helm-node stop --json

# Hub 客户端：指定节点运行命令，或绑定持久会话。
pnpm helm env exec --node build-box --cwd /workspace --stream -- git status
# 检视或合入后清理受管工作树；默认拒绝在用、脏工作区和未合入提交
pnpm helm worktrees cleanup --conversation <id> --json
pnpm helm worktrees cleanup --path /srv/.helm-worktrees/<repo>-<id> --node build-box --delete-branch --json
pnpm helm conversations create --node build-box --cwd /workspace --json
```

受控机器需部署 `helm-node` 和独立的 `helm` 客户端，受管 Shell 才能调用 Hub API。节点身份保存在 `node.json`（`0600`），与人类 CLI 的 `cli-token`、Hub 的 `credentials.json` 分开。节点断线后，在途命令返回结果未知错误；重连仅恢复后续调度，不重放命令，也不改在 Hub 本机执行。`helm nodes remove <nodeId>` 撤销身份并关闭现有连接。macOS、Linux、Windows 的开机服务由 `helm-node service install|uninstall|status` 管理；Windows 的字符串 Shell 命令需要 Git Bash 或 PATH 中可用的 Bash，缺失时返回 `shell_unavailable`。

Web 的「计算节点」入口提供节点版本、更新检查和升级确认。`helm` 是控制 Hub 的客户端；`helm-node` 管理受控机器本机的守护进程，两者职责保持分离：

```bash
# 从 Hub 控制指定的在线节点；检查不会执行升级。
pnpm helm nodes upgrade build-box --check --json
pnpm helm nodes upgrade build-box --version 0.2.0 --json

# 在受控机器上检查、升级本机受管守护进程。
pnpm helm-node upgrade --check --json
pnpm helm-node upgrade --version 0.2.0 --json
```

升级将同版本的 `@helm/node` 和 `@helm/cli` 安装到独立候选目录，校验两个安装包的 SHA-512 完整性，停止受理新命令并等待已受理命令结束。新进程完成注册和本机激活后，向 Hub 提交接管确认；仅注册或旧连接断开不会被当作升级成功。确认前的启动失败会保留旧版本；激活指令已发出但确认丢失时，返回「结果未确认」，不盲目杀候选或回滚。可用节点详情和 `helm-node status --json` 排查当前状态。`local` 与 Hub 同进程，不通过节点接口升级。

默认不自动升级。显式设置 Hub 的 `HELM_AUTO_UPGRADE_NODES=1` 后，版本落后的节点上线时会尝试对齐 Hub 版本。节点的 `HELM_NPM_REGISTRY` 可指定可信私有源；远程请求不能将节点切到未在本机信任的源，本机 `helm-node upgrade --registry <url>` 则允许显式指定。失败版本默认冷却 30 分钟，`--force` 可重试或强制重装。前台 `helm-node start` 作为稳定启动器跟踪当前守护进程，开机服务重启时按 `current.json` 选择已激活入口。

**分发前提**：目标版本必须已发布到节点可访问的 npm 源。当前仓库包仍标记为 `private`，这项功能不会自动发布 npm 包；未发布的版本会明确报错。安装包哈希校验依赖所信任源提供的元数据，不等同于独立发布者签名，也不对所有传递依赖提供同一校验保证。

节点链路的编译后黑盒验收使用临时数据目录和独立 CLI/守护进程，不调用模型，也不安装系统服务：

```bash
pnpm build
timeout 50s node scripts/env-node-smoke.mjs
```

读取会话不会自动清除未读状态。`conversations list --profile <id> --status <state>` 可按角色和状态筛选；`conversations get` 返回会话摘要和最近一页时间线，可用 `--limit`、`--cursor` 继续读取。`send --meta '<JSON 对象>' --wait` 将元数据附着在本次输入上，等待本次提交的回答并输出结果。删除会话会清理产物和搜索索引，并阻止后续访问；受 SDK 接口限制，SQLite 内部历史记录仍保留。根会话和启用插件登记托管的常驻会话受删除保护。

工作流在独立 Worker 中执行，使用 `vm` 约束确定性。所有外部操作通过宿主原语发起；`vm` 不作为恶意脚本的安全隔离边界。`workflows run <nameOrFile> --wait` 等待终态并返回结果。工作流恢复会复用成功的调用前缀；如果动作留下开始记录但没有完成记录，恢复会显式报告不确定状态。

模型工具 `subagent` 与工作流脚本的 `agent()` 共用 `agent_spawn` 执行接口，普通 Profile 使用原生子会话，声明外部运行时的 Profile 交给插件接管。`subagent({ prompt, background: true })` 在执行环境就绪后返回 `runId`，父会话可继续执行；任务完成 Schema 校验和 gate 后向父会话汇报。用 `helm workflows inspect <runId> --json` 查询、`helm workflows abort <runId>` 取消。后台单代理没有 DSL 账本，续接应使用返回的 `execution.conversationId/executionId` 作为 `subagent` 的 `resume`，不能使用 `resumeFromRunId`。工作流脚本中的 `agent()` 始终等待真实结果，并发由 `pipeline()` / `parallel()` 表达。

`isolation: 'worktree'` 在实际目标节点创建独立 Git 工作树，基于源目录当前提交，不包含未提交修改；普通原生 Profile 和实现该能力的插件使用同一上层契约。不支持的后端明确拒绝，不回落到共享目录。任务结束、失败或取消默认保留工作树和分支，返回的 `execution.worktree.id` 可用于 `cleanup_worktree` 工具或 `helm worktrees cleanup --id <id>`。删除子会话时仅尝试安全回收；无法确认归属、仍在用、存在未提交文件或未合入提交时保留并通知。Hub 重启后的中断执行需要先确认现场再续接；未确认停止的持久执行租约会阻止清理，`force` 不绕过此检查。

`SecretStash` 将审批中的机密答案保存在内存中，持久状态和模型上下文使用脱敏引用。审批创建返回 `{ id, status, answers }`，明确区分回答、取消和已在其他界面处理；调用方可预分配 ID 来绑定外部状态监听。Shell 和进程内插件拥有宿主权限，可以访问其执行环境；此边界不承诺对可信执行代码隐藏机密。

SSE 首帧包含会话、审批、启用插件 UI、计算节点和工作流运行摘要；随后推送时间线条目、流式状态、节点在线状态、公开插件文档和工作流更新。插件文档必须显式声明 `public: true` 才能通过 `helm plugins doc <id> <name>` 读取，仍需 Hub 鉴权。`helm workflows runs --json` 可查看运行摘要。

项目处于开发阶段，不考虑向后兼容，不做数据迁移。代码、接口、配置和数据库结构可直接按最新设计调整；结构变化时可以清理开发数据并重新初始化。同一结构下的会话、记忆和工作流重启恢复仍需保证。插件 UI 支持 JSON Spec 与 `client.tsx` 双轨；客户端源码在插件根目录内编译，复用宿主 React，可用 `helm plugins client <id> --module client.tsx --json` 查看编译信息。

插件停用时，Web 撤下其导航、视图与输入区贡献，并隐藏带 `managedByPlugin` 标记的专属 Profile 和 Skill。Herdr 的 Profile 运行时表单仅在插件启用时显示；已有运行时配置保留，可显式清除。插件创建的托管会话和子会话不会回落到“我的对话”。这些显示规则不删除资产，也不根据名称猜测用户自建角色的归属。

外部插件放在 `<HELM_DATA_DIR>/plugins/<目录>/`（缺省 `~/.helm/plugins/`）。Hub 启动时读取 `plugin.json` 的 `main`，或依次探测 `index.mjs`、`index.js`、`plugin.mjs`、`plugin.js`。无清单与入口的目录视为插件数据目录并跳过；损坏清单、非法入口与加载错误明确报错。入口导出 `default` 或具名 `plugin` 对象，使用与内置插件相同的 `definePlugin(ctx)` 契约；客户端源根目录缺省为该插件目录。

例如，将以下内容保存为 `~/.helm/plugins/example/index.mjs` 后重启 Hub：

```js
export default {
  id: 'example',
  name: '示例插件',
  definePlugin(ctx) {
    ctx.action({
      id: 'ping',
      description: '检查示例动作',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: {
        type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'],
      },
      handler() { return { ok: true } },
    })
  },
}
```

外部插件首次注册时停用；运行 `helm plugins enable example --json` 后即可调用 `helm example ping --json`。启停状态跨重启保留。插件是可信的进程内代码，导入时即可执行顶层代码，停用不提供代码沙箱。

`builtin:magpie` 默认停用。通过「插件与设置」配置网关地址与 API Key，再启用插件；缺省地址为 Hub 所在机器的 `http://127.0.0.1:3425`。插件按网关目录中的 `native_endpoints` 为每个模型选择 Responses、Anthropic Messages 或 Chat Completions，保留思考档位与 Claude 自适应思考元数据。网关未提供模型价格，目录中的零价格不代表实际调用免费。远端网关可提供模型与路由请求，本机专属的配额和路由诊断能力会明确报告是否可用。

```bash
pnpm helm plugins enable builtin:magpie --json
pnpm helm magpie refresh --json
pnpm helm magpie status --json
pnpm helm magpie quota --json
pnpm helm magpie groups --json
pnpm helm magpie group --id '<路由组ID>' --json
```

供应商由插件的 `ctx.provider()` 声明，配置表单、设置面板、输入区状态及命令面板动作均由同一个插件提供。Web 只根据通用的供应商归属字段挂载插件面板；插件停用后撤下供应商、模型与 UI，在途执行受生命周期保护。这里提供的是 Helm 原生插件，不会加载 Pi TUI 的扩展入口，也不共享 `~/.pi/agent` 的凭据或模型缓存。

`builtin:superagent` 默认停用。启用时自举 `superagent`、`watchdog` Profile 和 `watchdog-playbooks` 技能包，保留已有用户资产，并动态创建「SuperAgent 中枢」与「巡检看门狗」两个常驻会话。它们的 ID 保存在公开插件文档 `index` 中，启用期间受删除保护；`#1` 继续作为个人助理入口。

```bash
pnpm helm plugins enable builtin:superagent --json
pnpm helm plugins doc builtin:superagent index --json
pnpm helm superagent dispatch_worker --prompt '检查项目并汇报结果' --profile-id assistant --json
pnpm helm superagent set_router_mode --input '{"enabled":false}' --json
pnpm helm superagent archive_worker --worker-conversation-id <会话ID> --json
```

中枢的 `dispatch_worker` 创建持久 Worker 并提交任务后立即返回，不等待 Worker 回合完成。Worker 可绑定用户的专家 Profile，通过 `--node-id <节点>` 与 `--cwd <目标节点绝对路径>` 指定执行位置，支持 POSIX、Windows 盘符和 UNC 路径，并在回合内使用 `subagent` 或 `SubagentWorkflow` 调用 Herdr。路由模式开启时，中枢移除重度执行工具；普通助理和专家单聊保持原有工具集。Worker 回合包含 `agent` 或 `trigger` 来源时，结算后向中枢汇报；纯 `human` 回合仅更新 `recall-graph`。归档保留历史与产物，并解除 `threadKey` 订阅。公开文档 `subscriptions` 与 `recall-graph` 可通过同一 `plugins doc` 命令读取。

Watchdog 根据权威状态序号去重，对异常先执行确定性规则，再按需唤醒独立排障会话。自动恢复和中止在执行前复核持久归属；人类会话与窗格只允许诊断和通知。缺少权威水位的目标只通知；Herdr 状态持续很久不能单独作为自动中止依据。Watchdog 的模型工具受声明与执行双重约束，不能通过 Shell 或 `run_action` 绕过归属检查。插件管理动作自动提供 HTTP、CLI 和工作流入口；UI 贡献经 SSE 发布，由 Web 外壳渲染。

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

本机通过 Herdr 官方 IPC API（Unix Socket / Windows Named Pipe）创建终端并订阅状态。Socket 路径按插件 `socketPath`、`HERDR_SOCKET_PATH`、插件 `session` 对应目录、XDG/默认配置目录依次解析。一次启用周期固定连接目标；更改连接配置后重新启用才生效。`startupTimeoutMs` 必须为 3001 到 300000 的整数，默认 30000；投递前按权威 `interactive_ready` 确认终端可输入。

`subagent` 和工作流可以指定 `herdr:<kind>`，或使用绑定 Herdr 的 Profile。CLI 专属参数通过 `runtime.args` 明确配置，`model`、`effort` 不自动翻译为各 CLI 的私有选项。例如：

```bash
pnpm helm profiles create --input '{"id":"terminal-coder","runtime":{"kind":"herdr","agent":"pi","args":["--provider","magpie","--model","zhipu/glm-5.3"]}}' --json
```

终端 Agent 必须将最终结果写入 `.helm/wf-out-*` 文件。插件读取、校验并删除交接文件；首次缺失或格式错误会在原窗格追问一次，仍失败则保留现场并报告脱敏诊断。Gate 在实际工作目录执行一次。成功窗格保活供同一工作流或父回合续接，结算后关闭；Worktree 的磁盘目录和分支保留。插件不自动按键或中止人类窗格。

`pnpm helm plugins doc builtin:herdr overview --json` 可读取本机全部窗格的状态、目录与归属。`agentStatus` 保留 Herdr 的 `idle / working / blocked / done / unknown`，普通 Shell 显示真实的 `unknown`，仅 Agent 记录提供 `stateChangeSeq`。窗格状态、焦点和位置通过事件更新，目录等没有事件的变化由现有服务端巡检周期校准。采集或订阅失败时，文档通过 `stale` 与 `error` 标明异常，并保留最后成功采集的数据和时间。总览中的人类窗格仅用于只读诊断；`herdr list/read/focus` 继续使用受管记录及原有权限。

总览可单独运行真实协议验收：在 Herdr 环境中执行 `pnpm build`，再运行 `timeout 50s node scripts/herdr-overview-smoke.mjs`。脚本自建临时命名会话，只操作自己的普通 Shell 窗格，验证 HTTP/CLI、创建／移动／关闭事件和启停清理，不调用模型。输出包含验收项、清理结果和临时日志目录。

`herdr:<kind>@<nodeId>` 和 Profile 的 `runtime.nodeId` 使用内核 `EnvFabric` 节点通道。目标机器需运行 `helm-node` 和 Herdr；守护进程代为连接目标机器的 IPC、访问交接文件和执行 Gate。远端窗格使用该节点连接 Hub 的真实地址，环境变量通过 Herdr RPC JSON 传递。机密通过 SecretStash 注入，不要写入 Profile JSON。Helm 在自己的交接、事件和诊断出口脱敏，外部 CLI 的工具输出和模型上下文遵循其自身策略。

手工真实冒烟需先执行 `pnpm build`，再运行 `node scripts/herdr-smoke.mjs`。脚本使用独立命名 Herdr 会话、临时 Git 仓库和真实 GLM 模型，验证委派、结构化交接、Worktree、Gate、同窗格续接与重放；它不纳入默认单测。当前改动的验证以实际测试日志为准；跨平台模板与协议测试不能替代 macOS、Windows 实机验收。
