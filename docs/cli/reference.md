# CLI 命令参考

本手册覆盖 `helm`（控制端客户端）与 `helm-node`（受控节点守护进程）的全量命令，面向在终端操作 Helm 的使用者和编写自动化脚本的工程师。所有命令与 Web API 严格同权；`helm-hub` 为内核 Hub 服务端入口（`HELM_PORT=3202 pnpm dev:kernel` 同源），三者的全局命令挂载（`pnpm link:bins` 源码模式）见[安装与配置指南](../getting-started/installation.md)。命令清单以 `packages/cli/src/commands/` 源码与 `@helm/protocol` 的 `CORE_CLI_COMMAND_PATHS` 双向锁定为准，本手册不枚举未在代码中存在的命令。

## 当前状态与命令分发模型

命令分两层：

- **核心静态命令**：编译进 CLI 的固定命令表（下文「核心命令」各节），与 `CORE_CLI_COMMAND_PATHS` 全等校验。静态表优先精确匹配执行，**管理面永不因坏插件 manifest 或 Hub 插件故障而不可用**；
- **动态插件命令**：仅当无核心匹配时才拉取 `GET /api/actions` 动作清单生成（`helm <plugin> <action>`）。插件停用后其动态命令随清单一并消失。

## 全局选项与环境变量

| 标志 / 变量 | 说明 |
| :--- | :--- |
| `--json` | 全局生效：成功 stdout 输出 JSON；失败 stderr 输出错误信封并返回非零退出码。`helm --json` 单独使用属非法组合（帮助是纯文本） |
| `--help`, `-h` | 打印帮助；`helm <command> --help` 只依赖静态声明，不依赖 Hub 可用 |
| `HELM_HUB_URL` | Hub 基地址，默认 `http://127.0.0.1:3202` |
| `HELM_TOKEN` | 显式 Bearer 令牌，优先于凭据文件（用户自己保证其属于目标 Hub；指向另一 Hub 时不携带旧 token） |
| `HELM_DATA_DIR` | 数据目录，默认 `~/.helm` |
| `HELM_CONVERSATION_ID` | 供 `--current` 解析会话目标 |
| `HELM_NODE_ID` | 供 `nodes upgrade --current` 解析节点目标 |
| `HERDR_SOCKET_PATH` | 覆盖 Herdr IPC 管道路径（helm-node doctor 检查项之一） |

**凭据优先级**：`HELM_TOKEN` 环境变量（显式给出即短路磁盘，不触碰凭据文件）> `<dataDir>/cli-token` 登录态文件（0600 JSON `{ hubUrl, token }`，`helm login` 写入；损坏显式报错不静默当无凭据）> 默认 3202。`hubUrl` 与目标 endpoint 不一致时不携带旧 token。内核凭据保险库 `<dataDir>/credentials.json` 仅供 Hub 托管模型密钥与插件配置，CLI 命令绝不直接读写。

**HTTP 错误信封**：所有失败输出 `{ error: { code, message, details? } }`（与 Hub HTTP 错误信封同构），CLI 侧另有 `code` 面向机器消费、`exitCode` 非零即失败；`--json` 模式下错误信封走 stderr。

---

## 核心命令

### 鉴权与全局

**`helm setup [--password <str>]`** — 初始化管理员密码并登录（`POST /api/auth/setup`）。缺省 `--password` 且 stdin 非 TTY 时读一行。

**`helm login [--password <str>]`** — 登录并保存凭据（`POST /api/auth/login`）。

**`helm status`** — 查看鉴权状态与 Hub 连通性（`GET /api/auth/status`，无 token 也可探测）。

**`helm events watch`** — 订阅全局 SSE（`GET /api/events`）。首帧 `snapshot` 含会话、待答提问、插件、UI 贡献与 `pluginDocs` 公共文档；此后逐条增量。`--json` 模式逐帧 NDJSON。

**`helm search <query>`** — 会话条目全库全文检索（`GET /api/search?q=`，FTS5）。

**`helm api <method> <path> [--input <json>] [--field <k=v>]`** — 原始 HTTP 逃生舱。method 为 `GET|POST|PUT|PATCH|DELETE`（大小写不敏感）；path 自动补齐前导 `/`；`--field` 可重复且值按 JSON boolean/number 解析，与 `--input` 混用时仅对象基底可合并；GET 不接受请求体。

### 会话与输入

**`helm conversations list [--profile <id>] [--status <st>] [--tag <tag>] [--all | --parent <id>]`** — 列出会话。`--status` 取值 `working|blocked|done|idle|error`。默认仅顶层会话；`--all` 全量；`--parent <id>` 仅列出直接子会话（与 `--all` 互斥）。

**`helm conversations get [id] [--current] [--limit <n>] [--cursor <str>]`** — 会话详情与分页时间线；`--limit` 缺省 50。详情对超长纯文本 tool-result 做头尾截断（携带 `truncated/totalChars/totalLines`），过滤 `pi.system` 与剥离供应商签名载荷。

**`helm conversations entry [id] <entryId> [--current]`** — 单条时间线条目全文（详情投影截断后的未截断原文；被 rewind 隐藏的条目 404）。

**`helm conversations create [--title] [--profile-id] [--node <id>] [--cwd] [--model] [--tags]`** — 创建会话；`--node` 绑定计算节点（缺省继承 Profile 或 `local`）；`--tags` 接受 JSON 数组或逗号分隔。

**`helm conversations update [id] [--current] [--title] [--model] [--thinking] [--profile-id] [--node] [--cwd] [--pinned] [--unread]`** — 部分更新。`--model`/`--thinking` 传空串清除覆盖并重算继承链；`--thinking` 取值 `off|minimal|low|medium|high|xhigh|max`。

**`helm conversations delete [id] [--current]`** — 删除会话。插件受管会话返回 `409 conversation_managed_by_plugin`。

**`helm conversations reset [id] [--current] [--handoff <str>]`** — 重置上下文，新上下文以 handoff 文本开始。

**`helm conversations compact [id] [--current] [--instructions <str>]`** — 触发后台压缩摘要任务。

**`helm conversations fork [id] [--current] --entry-id <n> [--title <str>]`** — 从指定条目分叉（`--entry-id` 必填正整数）。

**`helm conversations withdraw [id] [--current] --submission-id <n>`** — 撤回排队中的输入。

**`helm send [id] <text> [--current]`** — 提交输入（`POST /api/conversations/:id/input`）：

| 标志 | 说明 |
| :--- | :--- |
| `--current` | 读 `HELM_CONVERSATION_ID` 解析会话目标，可省略位置 `id` |
| `--wait` | 同步等待回答（`?wait=1`，无超时）；人类模式直出 assistant 文本 |
| `--when-busy <mode>` | `steer`（默认）/ `followUp` / `reject` |
| `--origin <src>` | `human`（默认）/ `agent` / `trigger` |
| `--meta <json>` | 自由元数据，透传至 `turn_settled` |
| `--attach <ids>` | 挂载产物 ID，逗号分隔 |
| `--replace-from <n>` | 从指定历史条目截断并覆盖重发 |

**`helm abort [id] [--current]`** — 中止会话当前回合。

**`helm ask [text]`** — 一次性问答（内部创建会话、提交输入并等待回答，无新增端点）。stdout 默认只输出回答文本（脚本管道友好），`--json` 输出 `{conversationId, submissionId, entryId, answer, deleted}`。stdin 管道内容（非 TTY）自动并入 prompt。

| 标志 | 说明 |
| :--- | :--- |
| `--profile <id>` / `--title <str>` / `--tags <t>` | 会话归属与追溯 |
| `--cwd <dir>` / `--model <m>` | 工作目录（绝对路径）/ 模型覆盖 |
| `--timeout <ms>` | 等待超时（缺省无限等待）；超时后会话保留并给出 ID |
| `--delete-on-success` | 仅在成功取得回答后删除会话；任一失败均保留诊断会话 |

### 审批（AskDoc）

**`helm asks list`** — 列出待答提问。

**`helm asks answer <id> --answers <json> [--expected-state-seq <n>]`** — 提交答案；`--expected-state-seq` 为 CAS 水位线，终端侧已推进时自动流转 `superseded` 销单。

**`helm asks cancel <id>`** — 取消提问。

### Profile 与技能白名单

**`helm profiles list / get <id> / delete <id>`** — 常规管理。

**`helm profiles create [id]` / `helm profiles update <id>`** — 语义化标志或 `--input`：

| 标志 | 说明 |
| :--- | :--- |
| `--name / --model / --thinking / --node / --cwd` | 基础字段 |
| `--system <str>` / `--system-file <f>` | SYSTEM.md 全文（内联优先） |
| `--skills <json>` | 技能白名单字符串数组；`[]` 禁用全部；与 `--all-skills` 互斥 |
| `--all-skills` | 删除 `skills` 键恢复加载全部；与 `--skills` 互斥 |
| `--starters <json>` | 空白会话引导词数组（`[{label, prompt}]`，最多 6 项） |
| `--input <json>` | 整体 Profile JSON；update 单独使用 = 全量替换，与语义化标志组合时作为合并层 |

PUT 为整体替换契约：update 走语义化标志时 CLI 先 GET 完整 Profile 合并后 PUT，未触及字段不丢。MEMORY.md 长期记忆由 `builtin:memory` 管理（见下文 memory 命令）。

### 模型与网关

**`helm models list`** — 可用模型目录。**`helm models providers`** — PI 供应商与认证方式。**`helm models default [--set <model>] [--thinking <level>] [--compaction <model>] [--compaction-thinking <level>]`** — 查看或设置全局默认（空串清除）。**`helm models refresh [--provider <id>]`** — 刷新动态供应商目录。**`helm models filter [--provider <id> [--disable <modelId>... | --clear]]`** — 查看或设置模型禁用集。

**`helm providers list` / `helm providers set --input <json>`** — 模型网关列表查看与整体替换（`ProviderConfig[]`，密钥置于环境变量，严禁写入配置体）。

**`helm credentials list / set <id> --value <str> / delete <id>`** — 服务端凭据管理。明文持久化于 `credentials.json` 并注册 SecretStash 脱敏，不提供明文回读。

### 节点与跨节点执行

**`helm nodes list`** — 节点列表（id/kind/online/version/hostname/platform 与健康快照）。

**`helm nodes issue <nodeId>`** — 签发接入令牌，明文 `<nodeId>:<secret>` 仅返回一次。

**`helm nodes remove <nodeId>`** — 注销节点并断开连接。

**`helm nodes upgrade [<nodeId>] [--check] [--version <v>] [--registry <url>] [--force] [--current]`** — 检查或执行节点自升级；`--current` 读 `HELM_NODE_ID`；执行禁用客户端超时。

**`helm nodes forward [<nodeId> | --current] <listenHost:listenPort> [<targetHost>:]<targetPort>`** — 前台本地 TCP 端口转发：Hub 主机按需监听并将连接经节点隧道转发到目标节点视角的 `host:port`（目标 host 缺省 `127.0.0.1`），Ctrl-C 退出即关闭。

**`helm nodes forwards` / `helm nodes forward-inspect <forwardId>` / `helm nodes forward-stop <forwardId>`** — 活动转发的列出、详情与停止（`forwardId` 形如 `fwd-<uuid>`）。

**`helm env exec -- <command...>`** — 跨节点执行命令：

| 标志 | 说明 |
| :--- | :--- |
| `--node <id>` | 目标节点（缺省继承当前会话或 `local`） |
| `--cwd <path>` | 目标节点工作目录（绝对路径） |
| `--timeout <ms>` | 超时上限 600000 |
| `--stream` | NDJSON 逐帧回传 stdout/stderr 与终态 |
| `--current` | 读 `HELM_CONVERSATION_ID` 解析节点 |

命令非零退出透传为 CLI 退出码；流式中断于终态前报 `stream_incomplete`。

### 插件系统

**`helm plugins list`** — 插件清单（`status: active|disabled|failed`，失败携带结构化 `error`：阶段 `scan|load|define|enable`）。

**`helm plugins enable <id>` / `helm plugins disable <id> [--force]`** — 启停。停用预检：locked 插件 `403`；在途任务（自定义任务、执行中 Tool、挂起 `agent_spawn`）`409 plugin_has_live_tasks` 不可 force；持久资源占用（cron 规则、webhook 端点、Profile 运行时绑定）默认 `409 plugin_in_use` 列出占用清单，`--force` 知情越过（磁盘配置保留）。

**`helm plugins config <id> [--input <json>] [--set <k=v>] [--unset <key>]`** — 无修改标志时查看 `{values, schema, sources}`；`--set`/`--unset` 可重复，值按 JSON boolean/number 解析。secret 字段自动分离至 credentials.json。

**`helm plugins doc <pluginId> <name> [--conversation <id> | --current] [--watch]`** — 读取公开文档；会话文档必须给会话目标（互斥标志）；`--watch` 订阅专用 SSE（首帧快照 + 增量，Ctrl-C 退出）；私有文档、停用插件与不存在文档不可读。

**`helm plugins client <id> [--module <m>] [--chunk <name>] [--output <f>]`** — 获取 client.tsx 编译产物；缺省模块 `client.tsx`；响应携带 `x-helm-client-hash` 内容哈希。

**`helm plugins doctor [<id> | <dir>] [--path <dir>] [--dir <dir>] [--id <id>]`** — 外部插件源码静态自检：真实代际导入 + 临时宿主真实注册 + 前端模块真实编译，检查链 `manifest -> backend -> register -> client` 后继依赖前驱。位置参数为绝对路径时视为目录目标。预检失败报告仍完整输出但退出码非零。doctor 是静态自检：`definePlugin` 顶层依赖 `ctx.host.*` 的插件在 register 阶段如实失败。

**`helm plugins reload <id>`** — 受控热重载：在途任务预检（409）→ dry-run doctor 预检（失败旧实例保持不动，`422 plugin_reload_preflight_failed`）→ 新代际切换（失败回滚）→ 启用状态保持。内置插件禁止热重载（403）。

**`helm plugins rescan`** — 增量重扫描插件目录：只注册新外部插件（默认停用），已注册插件不重载。

**`helm plugins init [name] [--dir <dir>] [--name <str>] [--template minimal|full|app] [--force]`** — 本地脚手架（不访问 Hub）。名称需匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` 且禁止 `builtin:` 前缀；目标目录非空默认拒绝，`--force` 继续（同名文件被覆盖，不删除现有文件）。

**`helm plugins install <source> [--enable]`** — 从 npm/Git/本地路径安装。source 四种写法：`npm:<spec>`、`git:<repo>[@<ref>]`（可含子目录）、HTTPS Git URL（`#<ref>` 可选）、本地路径（相对 Hub 主机解析）。**安装并启用即在 Hub 进程内执行可信插件代码（无沙箱），仅装可信来源**。

**`helm plugins update <id>` / `helm plugins remove <id> [--yes]`** — 更新（源未变时 `changed: false` 幂等回报）与移除（破坏性：停用 + 清理 Hub 主机安装目录与记录；TTY 需输入 yes，非交互环境无 `--yes` 显式拒绝 `confirmation_required`）。

**`helm actions list`** — 全部插件动作清单（`GET /api/actions`）。

### 产物与技能

**`helm artifacts list [id] [--current]`** — 列出会话产物。

**`helm artifacts put <filePath> [id] [--current] [--name <str>] [--mime-type <str>]`** — 上传本地文件为产物。相对路径一律按**调用方 cwd** 解析（绝不按 `HELM_CWD` 静默切换）；失败给出 `read_failed` 附 `requestedPath` / `resolvedPath` / `cliCwd` 诊断。

**`helm artifacts get <id> [--output <path>]`** — 读取产物内容；文本直出，二进制必须 `--output` 落盘；实际写入后回显绝对路径与实际字节数；传输中断返回 `download_failed`，已有目标文件保持原样。

**`helm skills list` / `helm skills read <id> [--path <rel>]`** — 技能目录浏览；`--path` 读子文件，缺省 SKILL.md。

---

## 动态插件命令

插件动作自动映射为顶层 `helm <plugin> <action>` 命令（`builtin:` 前缀剥离，`cli.command` 可覆写）。参数转换：inputSchema 的 camelCase 属性映射为 kebab-case 选项（类型按 schema 自动转换：number/integer 转数字、boolean 严格 true/false、object/array/无类型按 JSON 解析）；`cli.positional` 按序消费位置参数并按 schema 类型转换；`cli.timeoutMs: 0` 表示无超时（供 `workflows run --wait` 等长耗时动作）；与保留名（`--json/--help/--input/--current/-h`）冲突的属性降级为整体 `--input` 提交。动作命令遮蔽核心命令路径时显式拒绝（`command_conflict`），绝不静默放行冒名执行。

以下命令**仅在对应插件启用时存在**（`helm actions list` 实时反映）：

| 命令 | 来源插件 | 说明 |
| :--- | :--- | :--- |
| `helm workflows list / get <name> / runs / inspect <runId> / abort <runId>` | builtin:workflow | 工作流资产与运行管理；`runs` 支持 `--current` 按会话过滤 |
| `helm workflows run [nameOrFile]` | builtin:workflow | 启动运行：位置参数为已保存名或本地脚本文件（自动读入）；缺省启动即返回，`--wait` 同步等终态；`--args` JSON 入参、`--resume-from-run-id` 断点重放、`--conversation-id`/`--current` 指定目标会话（新 run 必须显式指定） |
| `helm workflows save [nameOrFile]` / `delete <name>` | builtin:workflow | 保存 / 删除工作流定义（`save` 可 `--from-run-id` 固化既有运行；重复默认 409，`--overwrite` 覆盖） |
| `helm workflows steer <runId> --text "<指导>"` | builtin:workflow | 向运行中的后台子代理插话纠偏；原生执行按归属与 CAS 水位经内核 guarded 提交，外部执行按节点委托对应插件并如实返回守卫级别；插话成功不代表指导已执行 |
| `helm workflows detach <runId>` | builtin:workflow | 把运行中的前台同步运行转入后台（阻塞中的工具调用立即返回后台句柄）；仅前台同步标记且 running 的运行可转 |
| `helm worktrees list / inspect / cleanup` | builtin:workflow | 受管 Git 工作树登记、只读检视（含有上限 diff 预览）与清理（选择器三选一互斥，`--delete-branch` / `--force`） |
| `helm memory get / set / configure` | builtin:memory | 长期记忆管理；均以 `--profile-id <id>` 或 `--current` 选目标，皆缺 `400 validation_error`；`set --text <str> [--mode replace\|append]`；`configure --enabled <bool> [--text <str>]` |
| `helm apps validate / publish / list / update_meta / remove` | builtin:apps | 全栈微应用生命周期（见[应用中心](../plugins/apps.md)） |
| `helm profile list_mentionable` | builtin:profile | 列出可 `@` 点名协作的 Profile 候选（`--current` / `--conversation-id` / `--profile-id` 选上下文） |
| `helm cron list / create / delete / trigger` | builtin:triggers | cron 任务管理；create 必填 `--id --schedule --text`（标准五字段，timezone 默认 UTC），支持 `--target-conversation-id` / `--target-profile-id` / `--thread-key` 定向 |
| `helm webhook create / list / delete` | builtin:triggers | webhook 端点管理（HMAC-SHA256 验签）；create 必填 `--id --secret`，**secret 仅允许人工 HTTP/CLI 配置**（会话上下文调用被 403 拒绝） |
| `helm herdr list / read / focus` | builtin:herdr | 窗格管理；read 返回 40 行脱敏终端尾部快照，`--node-id` 消歧跨节点同 ID（歧义 409） |
| `helm herdr steer` | builtin:herdr | 向受管且由 workflow run 派生的窗格插话（`guardLevel=preflight` 发送前预检）；通常用 `helm workflows steer <runId> --text` 自动路由 |
| `helm superagent <action>` | builtin:superagent | `dispatch_worker / inspect_worker / recall_context / subscribe_thread / archive_worker / set_router_mode` 与 `watchdog_*` |
| `helm magpie status / refresh / quota / groups / group <id>` | builtin:magpie | 网关状态、目录刷新、配额查询与路由组 |

---

## helm-node 守护进程命令

`helm-node` 部署于受控机器，经出站 WebSocket 反向连接 Hub。后台控制不依赖 `/proc`、不向任意 PID 发信号：每次后台启动生成随机 `instanceId`，控制指令仅发往经 instanceId 验证的本机控制端点（Unix Socket 或 Named Pipe，单行 JSON，带空闲超时）。

**`helm-node connect <hubUrl> --token <token> [--once]`** — 前台运行并绑定接入令牌；`--once` 注册单次尝试后退出（开发调试与容器部署）。

**`helm-node start [-d|--daemon] [--hub <url>] [--token <token>]`** — 启动守护进程。首次需传 hub 与 token（写入 0600 的 `node.json`）；`-d` 转入后台 detached；后续启动自动复用绑定配置；前台 start 成为稳定 launcher。

**`helm-node stop`** — 经控制通道验证身份后优雅停止；控制通道不可达且 pid 存活时显式失败并保留 pid 文件。

**`helm-node restart`** — 先确认旧实例安全终止再拉新进程。

**`helm-node status`** — 节点绑定信息、后台进程 PID、`instanceId` 与运行态摘要。

**`helm-node upgrade [--check] [--version <v>] [--registry <url>] [--force]`** — 自升级：双包同版本绑定 → 双阶段 SHA-512 校验 → 离线安装至不可变候选目录 → 金丝雀握手 → `upgradeCommit` 唯一提交点 → 失败自动回滚并写 `update-blocked.json` 隔离。

**`helm-node doctor`** — 无副作用只读自检：`node.json` 权限（0600）、工作空间磁盘写入权限、Hub 端口连通性、Herdr 本地 IPC 管道状态。

**`helm-node service install / uninstall / status [--hub <url>]`** — 开机自启服务管理，跨平台映射：Linux `systemd --user`、macOS `launchd` Agent、Windows `schtasks`。

---

## Shell 自动化范例

```bash
#!/usr/bin/env bash
# 范例 1：轮询并自动回答挂起审批（CAS 防竞态）
set -euo pipefail
ASK=$(helm asks list --json | jq -r '.[0] // empty | select(.status=="pending")')
if [ -n "$ASK" ]; then
  ID=$(echo "$ASK" | jq -r '.id')
  SEQ=$(echo "$ASK" | jq -r '.expectedStateSeq // empty')
  helm asks answer "$ID" --answers '{"approved":true,"reason":"CI 自动核准"}' \
    ${SEQ:+--expected-state-seq "$SEQ"}
fi
```

```bash
#!/usr/bin/env bash
# 范例 2：同步执行工作流并按产物评分门禁
set -euo pipefail
RESULT=$(helm workflows run code-review.workflow.js --args '{"branch":"main"}' --wait --current --json)
STATUS=$(echo "$RESULT" | jq -r '.run.status')
SCORE=$(echo "$RESULT" | jq -r '.run.result.qualityScore')
echo "终态: $STATUS，评分: $SCORE"
[ "$STATUS" = "completed" ] && [ "$SCORE" -ge 80 ] || exit 1
```

```bash
#!/usr/bin/env bash
# 范例 3：跨节点批量健康巡检
set -euo pipefail
for NODE in $(helm nodes list --json | jq -r '.[] | select(.online == true) | .id'); do
  echo "=== $NODE ==="
  helm env exec --node "$NODE" --cwd /tmp -- df -h /
done
```

```bash
#!/usr/bin/env bash
# 范例 4：批量导出会话产物
set -euo pipefail
CONV=42; OUT=./artifacts_export; mkdir -p "$OUT"
helm artifacts list "$CONV" --json | jq -r '.[].id' | while read -r ART; do
  helm artifacts get "$ART" --output "$OUT/${ART}"
done
```

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| CLI 主入口与分发 | `packages/cli/src/index.ts` |
| 核心命令表 | `packages/cli/src/commands/`（与 `@helm/protocol` `CORE_CLI_COMMAND_PATHS` 双向锁定） |
| 动态命令生成 | `packages/cli/src/actions.ts` |
| 登录态与端点解析 | `packages/cli/src/credentials.ts`、`hub-client.ts` |
| 测试 | `packages/cli/test/`（命令行为、`--json` 输出与错误信封） |

## 相关文档

- [安装与配置指南](../getting-started/installation.md)：三命令分工、端口与数据目录
- [插件系统设计与契约](../plugins/overview.md)：动作五端映射与停用预检
- [工作流与子代理编排](../plugins/workflow.md)：`workflows` / `worktrees` 动态命令的语义
