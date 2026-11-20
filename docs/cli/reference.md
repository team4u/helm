# CLI 命令参考

`helmx` 用来管理 Hub、会话和插件。`helmx-node` 运行在参与执行的机器上。首次安装或连接远端 Hub 时，先配置地址和登录凭据。 [安装与配置](../getting-started/installation.md)

`helmx` 先匹配内置命令，再从 Hub 的 `GET /api/actions` 查询插件命令。`workflows`、`worktrees`、`swarm` 等命令需要对应插件启用。内置命令以 `packages/cli/src/commands/` 和 `CORE_CLI_COMMAND_PATHS` 为准。

## 全局选项与环境变量

| 标志 / 变量 | 说明 |
| :--- | :--- |
| `--json` | 全局生效：成功 stdout 输出 JSON；失败 stderr 输出错误信封并返回非零退出码。`helmx --json` 单独使用属非法组合（帮助是纯文本） |
| `--help`, `-h` | 打印帮助。内置命令的帮助可离线查看，插件命令的帮助需要连接 Hub。 |
| `HELMX_HUB_URL` | Hub 基地址，默认 `http://127.0.0.1:3202` |
| `HELMX_TOKEN` | 显式 Bearer 令牌，优先于凭据文件（用户自己保证其属于目标 Hub；指向另一 Hub 时不携带旧 token） |
| `HELMX_DATA_DIR` | 数据目录，默认 `~/.helmx` |
| `HELMX_CONVERSATION_ID` | 供 `--current` 解析会话目标 |
| `HELMX_NODE_ID` | 供 `nodes upgrade --current` 解析节点目标 |
| `HERDR_SOCKET_PATH` | 覆盖 Herdr IPC 管道路径（helmx-node doctor 检查项之一） |

**凭据优先级**：`HELMX_TOKEN` 环境变量（显式给出即短路磁盘，不触碰凭据文件）> `<dataDir>/cli-token` 登录态文件（0600 JSON `{ hubUrl, token }`，`helmx login` 写入；损坏显式报错不静默当无凭据）> 默认 3202。`hubUrl` 与目标 endpoint 不一致时不携带旧 token。内核凭据保险库 `<dataDir>/credentials.json` 仅供 Hub 托管模型密钥与插件配置，CLI 命令绝不直接读写。

**HTTP 错误信封**：所有失败输出 `{ error: { code, message, details? } }`（与 Hub HTTP 错误信封同构），CLI 侧另有 `code` 面向机器消费、`exitCode` 非零即失败；`--json` 模式下错误信封走 stderr。

---

## 核心命令

### 鉴权与全局

**`helmx setup [--password <str>]`** — 初始化管理员密码并登录（`POST /api/auth/setup`）。缺省 `--password` 且 stdin 非 TTY 时读一行。

**`helmx login [--password <str>]`** — 登录并保存凭据（`POST /api/auth/login`）。

**`helmx status`** — 查看鉴权状态与 Hub 连通性（`GET /api/auth/status`，无 token 也可探测）。

**`helmx events watch`** — 订阅全局 SSE（`GET /api/events`）。首帧 `snapshot` 含会话、待答提问、插件、UI 贡献与 `pluginDocs` 公共文档；此后逐条增量。`--json` 模式逐帧 NDJSON。

**`helmx search <query>`** — 会话条目全库全文检索（`GET /api/search?q=`，FTS5）。

**`helmx api <method> <path> [--input <json>] [--field <k=v>]`** — 原始 HTTP 逃生舱。method 为 `GET|POST|PUT|PATCH|DELETE`（大小写不敏感）；path 自动补齐前导 `/`；`--field` 可重复且值按 JSON boolean/number 解析，与 `--input` 混用时仅对象基底可合并；GET 不接受请求体。

### 本机 Hub 生命周期（npm 制品）

**`helmx start [-d] [--channel <tag>] [--port <n>] [--host <addr>] [--data-dir <dir>] ...`** — 启动本机 Hub（`npm install -g @helmx/cli` 制品；生命周期面实现于 `@helmx/cli` 内的 launcher 模块 `packages/cli/src/launcher/`，不单独发布 bin）。本机尚无已提交 release 时先安装所选通道最新版。默认前台运行（流式日志，`Ctrl+C` 优雅停止自己启动的 Hub）；`-d` 后台常驻（detached、写 `hub.pid`、日志落 `~/.helmx-hub/logs/hub.log`），`--json` 仅支持 `-d`。安装根 `~/.helmx-hub`（`HELMX_HUB_INSTALL_ROOT`）与用户数据 `~/.helmx` 严格分离。

| 调用 | 说明 |
| :--- | :--- |
| `helmx start` | 安装（如需）+ 前台启动；已有 Hub 在跑时显式拒绝（`start_refuses_existing_hub`，提示 restart/stop） |
| `helmx start -d` | 安装（如需）+ 后台常驻启动 |
| `helmx stop` | 优雅停止：优先 Hub 控制通道（`~/.helmx/hub-control.json` + instanceId 校验，三平台一致），不可达时退回 pid 记录 `/proc` 身份证明；验证失败显式报错绝不盲发信号 |
| `helmx restart` | 优雅停止后按粘性 launch 配置后台重启 |
| `helmx service <install\|uninstall\|status>` | 注册/卸载/查询开机自启系统服务（launchd / systemd --user / schtasks），以前台 `helmx start` 运行、OS 监督器负责重启 |
| `helmx status` | 登录态 + 本机 Hub 快照（`--json` 附加 `localHub`：current/running/blocked/launch/日志路径；本机无安装根时不附加） |

**`helmx update [--check] [--channel <tag>] [--version <ver>] [--tarball <path> --version <ver>]`** — 主动更新（`claude update` 语义：检查 → 校验暂存 → 空闲时切换重启；未安装时先安装并启动）。`--check` 只读查询不改状态；`--tarball` 从本地 payload tgz 安装（离线/内网，`--version` 必填）；`--force` 跳过空闲门控/重装/降级守卫。忙时（在跑会话、工具、压缩、排队输入）候选版本先暂存、当前版本继续服务，下次确认空闲再切。

后台静默备包：npm 管理的 Hub 进程内建更新检查器（默认 15 分钟一次；`HELMX_HUB_UPDATE_INTERVAL_MS`，`0` 关闭；`HELMX_HUB_UPDATE_TAG` 选通道），发现新版本静默下载校验暂存，Web 总览页出现「立即切换」卡片，`POST /api/hub-update/apply` 一键切换（busy 门控 + `force` 显式绕过；handoff 负责停旧→提交→起新→失败回滚）。通道与启动配置（`HELMX_PORT` / `HELMX_HOST` / `HELMX_DATA_DIR` / `HELMX_MODEL` > `launch.json` 粘性配置 > 默认值）详见[安装与配置指南](../getting-started/installation.md)。

### 会话与输入

**`helmx conversations list [--profile <id>] [--status <st>] [--tag <tag>] [--all | --parent <id>]`** — 列出会话。`--status` 取值 `working|blocked|done|idle|error`。默认仅顶层会话；`--all` 全量；`--parent <id>` 仅列出直接子会话（与 `--all` 互斥）。

**`helmx conversations get [id] [--current] [--limit <n>] [--cursor <str>]`** — 会话详情与分页时间线；`--limit` 缺省 50。详情对超长纯文本 tool-result 做头尾截断（携带 `truncated/totalChars/totalLines`），过滤 `pi.system` 与剥离供应商签名载荷。

**`helmx conversations entry [id] <entryId> [--current]`** — 单条时间线条目全文（详情投影截断后的未截断原文；被 rewind 隐藏的条目 404）。

**`helmx conversations create [--title] [--profile-id] [--node <id>] [--cwd] [--model] [--tags]`** — 创建会话；`--node` 绑定计算节点（缺省继承 Profile 或 `local`）；`--tags` 接受 JSON 数组或逗号分隔。

**`helmx conversations update [id] [--current] [--title] [--model] [--thinking] [--profile-id] [--node] [--cwd] [--pinned] [--unread]`** — 部分更新。`--model`/`--thinking` 传空串清除覆盖并重算继承链；`--thinking` 取值 `off|minimal|low|medium|high|xhigh|max`。

**`helmx conversations delete [id] [--current]`** — 删除会话。插件受管会话返回 `409 conversation_managed_by_plugin`。

**`helmx conversations reset [id] [--current] [--handoff <str>]`** — 重置上下文，新上下文以 handoff 文本开始。

**`helmx conversations compact [id] [--current] [--instructions <str>]`** — 触发后台压缩摘要任务。

**`helmx conversations fork [id] [--current] --entry-id <n> [--title <str>]`** — 从指定条目分叉（`--entry-id` 必填正整数）。

**`helmx conversations watch <id> [--timeout <ms>] [--quiet]`** — 阻塞观察一个会话直到当前回合 settle（订阅全局 SSE 并按 id 过滤），类似 `gh run watch`。实时打印 `doing` 动作行与状态迁移行；`done/idle` settle 退出码 `0`，`error` settle 退出码 `1`（两种模式都仍输出最终结果），`--timeout <ms>` 超时退出码 `124`（`watch_timeout`）。观察中会话被删除显式报错 `conversation_deleted`；流在 snapshot 前中断或未 settle 即断开报 `stream_closed`，绝不静默猜测状态。`blocked`（等待人类审批）不算 settle，继续等待。`--quiet` 只输出最终一行；`--json` 输出 NDJSON 进度帧（`watch`/`status`/`doing`）加最终 `result` 对象（`--quiet` 时仅 `result`）；Ctrl-C 干净退出。适合脚本串联：`helmx conversations watch 42 --quiet && next-step`。

  **自指保护**：`<id>` 必填、无 `--current`——观察「正在执行本命令的会话」是循环等待死锁（回合 settle 要等本工具调用返回）。托管执行环境（`HELMX_ENV=1`）内 watch 自己的会话 id 会被立即拒绝（`self_watch_forbidden`，含人类终端误仿场景的 `unset HELMX_ENV` 逃生提示）；agent 应以显式 id 观察子会话或其他会话。普通终端手动 `export HELMX_CONVERSATION_ID` 不受影响（无 `HELMX_ENV` 锚，不做门禁）。

**`helmx conversations withdraw [id] [--current] --submission-id <n>`** — 撤回排队中的输入。

**`helmx send [id] <text> [--current]`** — 提交输入（`POST /api/conversations/:id/input`）：

| 标志 | 说明 |
| :--- | :--- |
| `--current` | 读 `HELMX_CONVERSATION_ID` 解析会话目标，可省略位置 `id` |
| `--wait` | 同步等待回答（`?wait=1`，无超时）；人类模式直出 assistant 文本 |
| `--when-busy <mode>` | `steer`（默认）/ `followUp` / `reject` |
| `--origin <src>` | `human`（默认）/ `agent` / `trigger` |
| `--meta <json>` | 自由元数据，透传至 `turn_settled` |
| `--attach <ids>` | 挂载产物 ID，逗号分隔 |
| `--replace-from <n>` | 从指定历史条目截断并覆盖重发 |

**`helmx abort [id] [--current]`** — 中止会话当前回合。

**`helmx ask [text]`** — 一次性问答（内部创建会话、提交输入并等待回答，无新增端点）。stdout 默认只输出回答文本（脚本管道友好），`--json` 输出 `{conversationId, submissionId, entryId, answer, deleted}`。stdin 管道内容（非 TTY）自动并入 prompt。

| 标志 | 说明 |
| :--- | :--- |
| `--profile <id>` / `--title <str>` / `--tags <t>` | 会话归属与追溯 |
| `--cwd <dir>` / `--model <m>` | 工作目录（绝对路径）/ 模型覆盖 |
| `--timeout <ms>` | 等待超时（缺省无限等待）；超时后会话保留并给出 ID |
| `--delete-on-success` | 仅在成功取得回答后删除会话；任一失败均保留诊断会话 |

### 审批（AskDoc）

**`helmx asks list`** — 列出待答提问。

**`helmx asks answer <id> --answers <json> [--expected-state-seq <n>]`** — 提交答案；`--expected-state-seq` 为 CAS 水位线，终端侧已推进时自动流转 `superseded` 销单。

**`helmx asks cancel <id>`** — 取消提问。

### Profile 与技能白名单

**`helmx profiles list / get <id> / delete <id>`** — 常规管理。

**`helmx profiles create [id]` / `helmx profiles update <id>`** — 语义化标志或 `--input`：

| 标志 | 说明 |
| :--- | :--- |
| `--name / --model / --thinking / --node / --cwd` | 基础字段 |
| `--system <str>` / `--system-file <f>` | SYSTEM.md 全文（内联优先） |
| `--skills <json>` | 技能白名单字符串数组；`[]` 禁用全部；与 `--all-skills` 互斥 |
| `--all-skills` | 删除 `skills` 键恢复加载全部；与 `--skills` 互斥 |
| `--starters <json>` | 空白会话引导词数组（`[{label, prompt}]`，最多 6 项） |
| `--restrict-to-cwd` | 目录护栏布尔开关：文件工具（read/write/edit/register_artifact）与子代理显式 `cwd` 限定在会话工作目录内（`--restrict-to-cwd=false` 关闭；是模型护栏而非 OS 沙箱，bash 保持自身权限边界） |
| `--input <json>` | 整体 Profile JSON；update 单独使用 = 全量替换，与语义化标志组合时作为合并层 |

PUT 为整体替换契约：update 走语义化标志时 CLI 先 GET 完整 Profile 合并后 PUT，未触及字段不丢。MEMORY.md 长期记忆由 `builtin:memory` 管理（见下文 memory 命令）。

### 模型与网关

**`helmx models list`** — 可用模型目录。**`helmx models providers`** — PI 供应商与认证方式。**`helmx models default [--set <model>] [--thinking <level>] [--model-thinking <provider/model=level>] [--compaction <model>] [--compaction-thinking <level>]`** — 查看或设置全局默认（空串清除；`--model-thinking` 设置按模型思考默认，modelId 可含斜杠，空档位如 `provider/model=` 清除单项）。**`helmx models refresh [--provider <id>]`** — 刷新动态供应商目录。**`helmx models filter [--provider <id> [--disable <modelId>... | --clear]]`** — 查看或设置模型禁用集。

**`helmx providers list` / `helmx providers set --input <json>`** — 模型网关列表查看与整体替换（`ProviderConfig[]`，密钥置于环境变量，严禁写入配置体）。

**`helmx credentials list / set <id> --value <str> / delete <id>`** — 服务端凭据管理。明文持久化于 `credentials.json` 并注册 SecretStash 脱敏，不提供明文回读。

### 节点与跨节点执行

**`helmx nodes list`** — 节点列表（id/kind/online/version/hostname/platform 与健康快照）。

**`helmx nodes issue <nodeId>`** — 签发接入令牌，明文 `<nodeId>:<secret>` 仅返回一次。

**`helmx nodes remove <nodeId>`** — 注销节点并断开连接。

**`helmx nodes upgrade [<nodeId>] [--check] [--version <v>] [--registry <url>] [--force] [--current]`** — 检查或执行节点自升级（远端首次安装走 `npm install -g @helmx/node`）；`--current` 读 `HELMX_NODE_ID`；执行禁用客户端超时。

**`helmx nodes forward [<nodeId> | --current] <listenHost:listenPort> [<targetHost>:]<targetPort>`** — 前台本地 TCP 端口转发：Hub 主机按需监听并将连接经节点隧道转发到目标节点视角的 `host:port`（目标 host 缺省 `127.0.0.1`），Ctrl-C 退出即关闭。

**`helmx nodes forwards` / `helmx nodes forward-inspect <forwardId>` / `helmx nodes forward-stop <forwardId>`** — 活动转发的列出、详情与停止（`forwardId` 形如 `fwd-<uuid>`）。

**`helmx env exec -- <command...>`** — 跨节点执行命令：

| 标志 | 说明 |
| :--- | :--- |
| `--node <id>` | 目标节点（缺省继承当前会话或 `local`） |
| `--cwd <path>` | 目标节点工作目录（绝对路径） |
| `--timeout <ms>` | 超时上限 600000 |
| `--stream` | NDJSON 逐帧回传 stdout/stderr 与终态 |
| `--current` | 读 `HELMX_CONVERSATION_ID` 解析节点 |

命令非零退出透传为 CLI 退出码；流式中断于终态前报 `stream_incomplete`。

### 插件系统

**`helmx plugins list`** — 插件清单（`status: active|disabled|failed`，失败携带结构化 `error`：阶段 `scan|load|define|enable`）。

**`helmx plugins enable <id>` / `helmx plugins disable <id> [--force]`** — 启停。停用预检：locked 插件 `403`；在途任务（自定义任务、执行中 Tool、挂起 `agent_spawn`）`409 plugin_has_live_tasks` 不可 force；持久资源占用（cron 规则、webhook 端点、Profile 运行时绑定）默认 `409 plugin_in_use` 列出占用清单，`--force` 知情越过（磁盘配置保留）。

**`helmx plugins config <id> [--input <json>] [--set <k=v>] [--unset <key>]`** — 无修改标志时查看 `{values, schema, sources}`；`--set`/`--unset` 可重复，值按 JSON boolean/number 解析。secret 字段自动分离至 credentials.json。

**`helmx plugins doc <pluginId> <name> [--conversation <id> | --current] [--watch]`** — 读取公开文档；会话文档必须给会话目标（互斥标志）；`--watch` 订阅专用 SSE（首帧快照 + 增量，Ctrl-C 退出）；私有文档、停用插件与不存在文档不可读。

**`helmx plugins client <id> [--module <m>] [--chunk <name>] [--output <f>]`** — 获取 client.tsx 编译产物；缺省模块 `client.tsx`；响应携带 `x-helmx-client-hash` 内容哈希。

**`helmx plugins doctor [<id> | <dir>] [--path <dir>] [--id <id>]`** — 外部插件源码静态自检：真实代际导入 + 临时宿主真实注册 + 前端模块真实编译，检查链 `manifest -> backend -> register -> client` 后继依赖前驱。位置参数为绝对路径时视为目录目标。预检失败报告仍完整输出但退出码非零。doctor 是静态自检：`definePlugin` 顶层依赖 `ctx.host.*` 的插件在 register 阶段如实失败。

**`helmx plugins reload <id>`** — 受控热重载：在途任务预检（409）→ dry-run doctor 预检（失败旧实例保持不动，`422 plugin_reload_preflight_failed`）→ 新代际切换（失败回滚）→ 启用状态保持。内置插件禁止热重载（403）。

**`helmx plugins rescan`** — 增量重扫描插件目录：只注册新外部插件（默认停用），已注册插件不重载。

**`helmx plugins init [name] [--dir <dir>] [--name <str>] [--template minimal|full|app] [--force]`** — 本地脚手架（不访问 Hub）。名称需匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` 且禁止 `builtin:` 前缀；目标目录非空默认拒绝，`--force` 继续（同名文件被覆盖，不删除现有文件）。

**`helmx plugins build [dir] [--dir <dir>] [--out <dir>] [--module <m>]`** — 本地预编译插件前端为静态 `dist-client/`（不访问 Hub）。编译器（`@helmx/plugin-build`，含平台原生 esbuild）按运行位置解析：源码模式/Hub payload 布局内由同级 `node_modules` 提供；npm 制品全局 CLI 需要本机已安装 Helmx 管理的 payload release（其 release 目录依赖闭包含该编译器），不可解析时显式报 `plugin_build_unavailable`（诚实边界：编译器无法零依赖交付）。

**`helmx plugins install <source> [--enable]`** — 从 npm/Git/本地路径安装。source 四种写法：`npm:<spec>`、`git:<repo>[@<ref>]`（可含子目录）、HTTPS Git URL（`#<ref>` 可选）、本地路径（相对 Hub 主机解析）。**安装并启用即在 Hub 进程内执行可信插件代码（无沙箱），仅装可信来源**。

**`helmx plugins update <id>` / `helmx plugins remove <id> [--yes]`** — 更新（源未变时 `changed: false` 幂等回报）与移除（破坏性：停用 + 清理 Hub 主机安装目录与记录；TTY 需输入 yes，非交互环境无 `--yes` 显式拒绝 `confirmation_required`）。

**`helmx actions list`** — 全部插件动作清单（`GET /api/actions`）。

### 产物与技能

**`helmx artifacts list [id] [--current]`** — 列出会话产物。

**`helmx artifacts put <filePath> [id] [--current] [--name <str>] [--mime-type <str>]`** — 上传本地文件为产物。相对路径一律按**调用方 cwd** 解析（绝不按 `HELMX_CWD` 静默切换）；失败给出 `read_failed` 附 `requestedPath` / `resolvedPath` / `cliCwd` 诊断。

**`helmx artifacts get <id> [--output <path>]`** — 读取产物内容；文本直出，二进制必须 `--output` 落盘；实际写入后回显绝对路径与实际字节数；传输中断返回 `download_failed`，已有目标文件保持原样。

**`helmx skills list` / `helmx skills read <id> [--path <rel>]`** — 技能目录浏览；`--path` 读子文件，缺省 SKILL.md。

---

## 动态插件命令

插件动作自动映射为顶层 `helmx <plugin> <action>` 命令（`builtin:` 前缀剥离，`cli.command` 可覆写）。参数转换：inputSchema 的 camelCase 属性映射为 kebab-case 选项（类型按 schema 自动转换：number/integer 转数字、boolean 严格 true/false、object/array/无类型按 JSON 解析）；`cli.positional` 按序消费位置参数并按 schema 类型转换；`cli.timeoutMs: 0` 表示无超时（供 `workflows run --wait` 等长耗时动作）；与保留名（`--json/--help/--input/--current/-h`）冲突的属性降级为整体 `--input` 提交。动作命令遮蔽核心命令路径时显式拒绝（`command_conflict`），绝不静默放行冒名执行。

以下命令**仅在对应插件启用时存在**（`helmx actions list` 实时反映）：

| 命令 | 来源插件 | 说明 |
| :--- | :--- | :--- |
| `helmx workflows list / get <name> / runs / inspect <runId> / abort <runId>` | builtin:workflow | 工作流资产与运行管理；`runs` 支持 `--current` 按会话过滤 |
| `helmx workflows run [nameOrFile]` | builtin:workflow | 启动运行：位置参数为已保存名或本地脚本文件（自动读入）；缺省启动即返回，`--wait` 同步等终态；`--args` JSON 入参、`--resume-from-run-id` 断点重放、`--conversation-id`/`--current` 指定目标会话（新 run 必须显式指定） |
| `helmx workflows save [nameOrFile]` / `delete <name>` | builtin:workflow | 保存 / 删除工作流定义（`save` 可 `--from-run-id` 固化既有运行；重复默认 409，`--overwrite` 覆盖） |
| `helmx workflows steer <runId> --text "<指导>"` | builtin:workflow | 向运行中的后台子代理插话纠偏；原生执行按归属与 CAS 水位经内核 guarded 提交，外部执行按节点委托对应插件并如实返回守卫级别；插话成功不代表指导已执行 |
| `helmx workflows detach <runId>` | builtin:workflow | 把运行中的前台同步运行转入后台（阻塞中的工具调用立即返回后台句柄）；仅前台同步标记且 running 的运行可转 |
| `helmx workflows resume-failed [--conversation-id <id> \| --current \| --all]` | builtin:workflow | 续跑失败的工作流和后台子代理。可指定会话或用 `--all` 查全局，跳过的运行列在 `skipped`。 |
| `helmx worktrees list / inspect / cleanup` | builtin:worktree | 受管 Git 工作树登记、只读检视（含有上限 diff 预览）与清理（选择器三选一互斥，`--delete-branch` / `--force`） |
| `helmx swarm create-group / update-group / channel / dispatch-worker` | builtin:swarm | 建立或修改协作组、管理子频道、派工。派工时可指定工作树隔离、分叉来源和模型。 |
| `helmx swarm board-post / board-read / board-status` | builtin:swarm | 发看板消息、分页读消息、查看组和成员状态。发消息时用 `to` 指定收件人，用 `wake` 决定是否唤醒。 |
| `helmx swarm abort-worker / switch-model / inspect-worker / archive-worker / close-group` | builtin:swarm | 中止成员当前回合、给闲置成员换模型、查看或归档成员、结单。用 `--keep-worktree` 保留有改动或未合入的工作树。 |
| `helmx memory get / set / configure` | builtin:memory | 长期记忆管理；均以 `--profile-id <id>` 或 `--current` 选目标，皆缺 `400 validation_error`；`set --text <str> [--mode replace\|append]`；`configure --enabled <bool> [--text <str>]` |
| `helmx apps validate / publish / list / update_meta / remove` | builtin:apps | 全栈微应用生命周期（见[应用中心](../plugins/apps.md)） |
| `helmx profile list_mentionable` | builtin:profile | 列出可 `@` 点名协作的 Profile 候选（`--current` / `--conversation-id` / `--profile-id` 选上下文） |
| `helmx cron list / create / delete / trigger` | builtin:triggers | cron 任务管理；create 必填 `--id --schedule --text`（标准五字段，timezone 默认 UTC），支持 `--target-conversation-id` / `--target-profile-id` / `--thread-key` 定向 |
| `helmx webhook create / list / delete` | builtin:triggers | webhook 端点管理（HMAC-SHA256 验签）；create 必填 `--id --secret`，**secret 仅允许人工 HTTP/CLI 配置**（会话上下文调用被 403 拒绝） |
| `helmx herdr list / read / focus` | builtin:herdr | 窗格管理；read 返回 40 行脱敏终端尾部快照，`--node-id` 消歧跨节点同 ID（歧义 409） |
| `helmx herdr steer` | builtin:herdr | 向受管且由 workflow run 派生的窗格插话（`guardLevel=preflight` 发送前预检）；通常用 `helmx workflows steer <runId> --text` 自动路由 |
| `helmx superagent <action>` | builtin:superagent | `dispatch_worker / inspect_worker / recall_context / subscribe_thread / archive_worker / set_router_mode` 与 `watchdog_*` |
| `helmx magpie status / refresh / quota / groups / group <id>` | builtin:magpie | 网关状态、目录刷新、配额查询与路由组 |

---

## helmx-node 守护进程命令

`helmx-node` 部署于受控机器，经出站 WebSocket 反向连接 Hub。后台控制不依赖 `/proc`、不向任意 PID 发信号：每次后台启动生成随机 `instanceId`，控制指令仅发往经 instanceId 验证的本机控制端点（Unix Socket 或 Named Pipe，单行 JSON，带空闲超时）。

**`helmx-node connect <hubUrl> --token <token> [--once]`** — 前台运行并绑定接入令牌；`--once` 注册单次尝试后退出（开发调试与容器部署）。

**`helmx-node start [-d|--daemon] [--hub <url>] [--token <token>]`** — 启动守护进程。首次需传 hub 与 token（写入 0600 的 `node.json`）；`-d` 转入后台 detached；后续启动自动复用绑定配置；前台 start 成为稳定 launcher。

**`helmx-node stop`** — 经控制通道验证身份后优雅停止；控制通道不可达且 pid 存活时显式失败并保留 pid 文件。

**`helmx-node restart`** — 先确认旧实例安全终止再拉新进程。

**`helmx-node status`** — 节点绑定信息、后台进程 PID、`instanceId` 与运行态摘要。

**`helmx-node upgrade [--check] [--version <v>] [--registry <url>] [--force]`** — 自升级：`@helmx/node` 自升级 → 双阶段 SHA-512 校验 → 离线安装至不可变候选目录 → 金丝雀握手 → `upgradeCommit` 唯一提交点 → 失败自动回滚并写 `update-blocked.json` 隔离。

**`helmx-node doctor`** — 无副作用只读自检：`node.json` 权限（0600）、工作空间磁盘写入权限、Hub 端口连通性、Herdr 本地 IPC 管道状态。

**`helmx-node service install / uninstall / status [--hub <url>]`** — 开机自启服务管理，跨平台映射：Linux `systemd --user`、macOS `launchd` Agent、Windows `schtasks`。

---

## Shell 自动化范例

```bash
#!/usr/bin/env bash
# 范例 1：轮询并自动回答挂起审批（CAS 防竞态）
set -euo pipefail
ASK=$(helmx asks list --json | jq -r '.[0] // empty | select(.status=="pending")')
if [ -n "$ASK" ]; then
  ID=$(echo "$ASK" | jq -r '.id')
  SEQ=$(echo "$ASK" | jq -r '.expectedStateSeq // empty')
  helmx asks answer "$ID" --answers '{"approved":true,"reason":"CI 自动核准"}' \
    ${SEQ:+--expected-state-seq "$SEQ"}
fi
```

```bash
#!/usr/bin/env bash
# 范例 2：同步执行工作流并按产物评分门禁
set -euo pipefail
RESULT=$(helmx workflows run code-review.workflow.js --args '{"branch":"main"}' --wait --current --json)
STATUS=$(echo "$RESULT" | jq -r '.run.status')
SCORE=$(echo "$RESULT" | jq -r '.run.result.qualityScore')
echo "终态: $STATUS，评分: $SCORE"
[ "$STATUS" = "completed" ] && [ "$SCORE" -ge 80 ] || exit 1
```

```bash
#!/usr/bin/env bash
# 范例 3：跨节点批量健康巡检
set -euo pipefail
for NODE in $(helmx nodes list --json | jq -r '.[] | select(.online == true) | .id'); do
  echo "=== $NODE ==="
  helmx env exec --node "$NODE" --cwd /tmp -- df -h /
done
```

```bash
#!/usr/bin/env bash
# 范例 4：批量导出会话产物
set -euo pipefail
CONV=42; OUT=./artifacts_export; mkdir -p "$OUT"
helmx artifacts list "$CONV" --json | jq -r '.[].id' | while read -r ART; do
  helmx artifacts get "$ART" --output "$OUT/${ART}"
done
```

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| CLI 主入口与分发 | `packages/cli/src/index.ts` |
| 核心命令表 | `packages/cli/src/commands/`（与 `@helmx/protocol` `CORE_CLI_COMMAND_PATHS` 双向锁定） |
| 动态命令生成 | `packages/cli/src/actions.ts` |
| 登录态与端点解析 | `packages/cli/src/credentials.ts`、`hub-client.ts` |
| 测试 | `packages/cli/test/`（命令行为、`--json` 输出与错误信封） |

## 相关文档

- [安装与配置指南](../getting-started/installation.md)：三命令分工、端口与数据目录
- [插件系统设计与契约](../plugins/overview.md)：动作五端映射与停用预检
- [Swarm 对等协同](../plugins/swarm.md)：`helmx swarm` 动态命令与序号黑板语义
- [工作流与子代理编排](../plugins/workflow.md)：`workflows` 动态命令的语义
- [受管工作树](../plugins/worktree.md)：`worktrees` 动态命令的语义
