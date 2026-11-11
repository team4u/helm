# CLI 命令参考手册

本文汇集 `helm` 客户端与 `helm-node` 守护进程的全量命令。
所有命令与 Web 控制台 API 严格同权。
输出支持纯文本与机器可读 JSON 双格式。

---

## 全局选项与环境变量

### 全局选项

`helm` 与 `helm-node` 支持以下通用标志：

| 标志 | 类型 | 说明 |
| :--- | :--- | :--- |
| `--json` | 布尔 | 输出机器可读 JSON 数据。错误写入 stderr 并返回非零退出码。 |
| `--help`, `-h` | 布尔 | 打印当前命令帮助信息与参数说明。 |
| `--current` | 布尔 | 自动读取上下文环境变量。解析会话或节点 ID。 |
| `--data-dir <dir>` | 字符串 | 覆盖默认数据目录。缺省值为 `~/.helm`。 |

---

### 环境变量

命令行工具通过以下环境变量读取执行上下文：

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `HELM_HUB_URL` | `http://127.0.0.1:3202` | 控制中枢 Hub 服务访问基地址。 |
| `HELM_TOKEN` | 空 | 优先于凭据文件的 Bearer 鉴权令牌。 |
| `HELM_DATA_DIR` | `~/.helm` | 执行状态、日志与凭据保存目录。 |
| `HELM_CONVERSATION_ID` | 空 | 供 `--current` 自动绑定的会话 ID。 |
| `HELM_NODE_ID` | 空 | 供 `--current` 自动绑定的计算节点 ID。 |
| `HERDR_SOCKET_PATH` | 空 | 覆盖 Herdr IPC 通信管道路径。 |

---

### 凭据隔离机制

系统在数据目录下划分两类凭据文件：

1. **CLI 登录令牌**：保存于 `<dataDir>/cli-token`。文件权限为 `0600`。保存当前客户端登录态 `{ hubUrl, token }`。
2. **内核凭据保险库**：保存于 `<dataDir>/credentials.json`。仅供微内核托管模型密钥与插件配置。CLI 命令绝不直接读写该文件。

---

## helm 客户端命令参考

### 身份验证与系统管理

#### helm setup

初始化管理员主密码。系统首次部署时使用。

```bash
# 交互式初始化
helm setup

# 传入密码直接初始化
helm setup --password "your-admin-password"
```

| 参数 | 类型 | 说明 |
| :--- | :--- | :--- |
| `--password <str>` | 字符串 | 管理员密码。缺省且非 TTY 时自标准输入读取一行。 |

---

#### helm login

登录控制中枢。写入本地 `<dataDir>/cli-token` 凭据。

```bash
# 交互式登录
helm login

# 指定密码静默登录
helm login --password "your-admin-password"
```

| 参数 | 类型 | 说明 |
| :--- | :--- | :--- |
| `--password <str>` | 字符串 | 登录密码。缺省且非 TTY 时自标准输入读取一行。 |

---

#### helm status

检查当前鉴权状态与中枢连通性。

```bash
helm status
helm status --json
```

---

#### helm events watch

订阅全局服务端推送事件流（SSE）。首帧 `snapshot` 推送全量快照（含会话、待答提问、插件、UI 贡献与 `pluginDocs` 公共文档首帧），后续推送增量事件（如 `plugin.doc.updated`）。

```bash
helm events watch
```

---

#### helm search <query>

对历史会话条目执行全库全文检索。

```bash
helm search "syntax error"
helm search "部署脚本" --json
```

| 位置参数 | 类型 | 说明 |
| :--- | :--- | :--- |
| `<query>` | 字符串 | 全文检索关键词。基于 FTS5 引擎匹配。 |

---

#### helm api <method> <path>

原始 HTTP 请求逃生舱。直接调用未封装的控制接口。

```bash
# 调用原生接口获取节点详情
helm api GET /api/nodes

# 提交 JSON 请求体
helm api POST /api/plugins/custom-tool/reload --field force=true
```

| 标志 | 类型 | 说明 |
| :--- | :--- | :--- |
| `--input <json>` | JSON 对象 | 整体请求体 JSON 对象。 |
| `--field <k=v>` | 键值对 | 单项请求体赋值。可多次指定。自动解析布尔与数值。 |

---

### 会话与交互编排

#### helm conversations list

列出当前所有会话。支持多维度过滤。

```bash
helm conversations list
helm conversations list --status working
helm conversations list --profile researcher --tag urgent
```

| 标志 | 类型 | 说明 |
| :--- | :--- | :--- |
| `--status <st>` | 字符串 | 状态过滤：`working`、`blocked`、`done`、`idle`、`error`。 |
| `--profile <id>` | 字符串 | 按绑定的 Profile 标识过滤。 |
| `--tag <tag>` | 字符串 | 按关联标签过滤。 |

---

#### helm conversations get [id]

查看会话详情与分页时间线。

```bash
helm conversations get 42
helm conversations get --current --limit 20
```

| 参数 | 类型 | 说明 |
| :--- | :--- | :--- |
| `[id]` | 数值 | 目标会话 ID。缺省时需配合 `--current`。 |
| `--current` | 布尔 | 读取环境变量 `HELM_CONVERSATION_ID`。 |
| `--limit <num>` | 数值 | 时间线条数上限。默认 50。 |
| `--cursor <str>` | 字符串 | 分页游标。回传上次响应的 `nextCursor`。 |

---

#### helm conversations create

创建全新会话。可指定绑定节点与工作目录。

```bash
helm conversations create --title "重构认证模块"
helm conversations create --profile-id worker --node node-worker-1 --cwd /data/app
```

| 标志 | 类型 | 说明 |
| :--- | :--- | :--- |
| `--title <str>` | 字符串 | 会话标题。 |
| `--profile-id <id>` | 字符串 | 绑定的专家角色 ID。 |
| `--node <id>` | 字符串 | 绑定的计算节点 ID。缺省继承 Profile 或 `local`。 |
| `--cwd <path>` | 字符串 | 会话物理工作目录。 |
| `--model <str>` | 字符串 | 覆盖模型标识（格式：`provider/model`）。 |
| `--tags <tags>` | 字符串 | 标签集合。支持逗号分隔或 JSON 数组。 |

---

#### helm conversations update [id]

更新已有会话的元数据、计算节点或执行模型。

```bash
helm conversations update 42 --title "新标题" --pinned
helm conversations update --current --thinking high --model "anthropic/claude-3-7-sonnet"
helm conversations update 42 --model "" # 清除模型覆盖，恢复继承链
```

| 标志 | 类型 | 说明 |
| :--- | :--- | :--- |
| `[id]` | 数值 | 目标会话 ID。缺省时需配合 `--current`。 |
| `--current` | 布尔 | 读取环境变量 `HELM_CONVERSATION_ID`。 |
| `--title <str>` | 字符串 | 修改会话标题。 |
| `--model <str>` | 字符串 | 覆盖模型标识。传入空串清空覆盖。 |
| `--thinking <str>` | 字符串 | 思考档位：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。 |
| `--profile-id <id>` | 字符串 | 切换绑定的 Profile 标识。 |
| `--node <id>` | 字符串 | 切换绑定的计算节点。 |
| `--cwd <path>` | 字符串 | 切换目标节点工作目录。 |
| `--pinned` | 布尔 | 切换置顶状态。 |
| `--unread` | 布尔 | 标记未读状态。 |

---

#### helm conversations delete [id]

删除指定会话。插件托管（ownedBy 非 human）的会话不可删除；初始会话无 id 级豁免。

```bash
helm conversations delete 108
helm conversations delete --current
```

---

#### helm conversations reset [id]

重置会话上下文。历史记录归档，新上下文由交接说明起始。

```bash
helm conversations reset 42 --handoff "请基于新分支继续实现功能"
```

| 标志 | 类型 | 说明 |
| :--- | :--- | :--- |
| `--handoff <str>` | 字符串 | 重置后作为首条用户提示词的交接文本。 |

---

#### helm conversations compact [id]

触发会话上下文后台压缩摘要任务。

```bash
helm conversations compact 42 --instructions "重点保留架构改动与接口变更"
```

| 标志 | 类型 | 说明 |
| :--- | :--- | :--- |
| `--instructions <str>` | 字符串 | 自定义压缩摘要提取指引。 |

---

#### helm conversations fork [id]

从指定历史条目分叉出会话分支。

```bash
helm conversations fork 42 --entry-id 18 --title "算法替代分支"
```

| 标志 | 类型 | 说明 |
| :--- | :--- | :--- |
| `--entry-id <num>` | 数值（必填） | 分叉起点的历史条目 ID。 |
| `--title <str>` | 字符串 | 新分叉会话标题。缺省为「原标题 (分叉)」。 |

---

#### helm conversations withdraw [id]

撤回排队中的输入提交。

```bash
helm conversations withdraw 42 --submission-id 5
```

| 标志 | 类型 | 说明 |
| :--- | :--- | :--- |
| `--submission-id <n>` | 数值（必填） | 待撤回的排队输入唯一 ID。 |

---

#### helm send [id] <text>

向会话发送输入指令。支持原地覆盖与同步等待结果。

```bash
# 异步发送消息
helm send 42 "请检查当前目录下的编译错误"

# 同步等待模型回合结束
helm send --current "执行自动化回归测试" --wait

# 截断历史并从条目 15 覆盖重发
helm send 42 "改用内存缓存替代数据库" --replace-from 15 --wait
```

| 参数 | 类型 | 说明 |
| :--- | :--- | :--- |
| `[id]` | 数值 | 目标会话 ID。缺省时需配合 `--current`。 |
| `<text>` | 字符串 | 输入文本内容。 |
| `--current` | 布尔 | 使用环境变量 `HELM_CONVERSATION_ID`。 |
| `--wait` | 布尔 | 同步挂起等待回合终态。返回完整执行结果。 |
| `--when-busy <mode>` | 字符串 | 会话正忙时策略：`steer`、`followUp`、`reject`。默认 `steer`。 |
| `--origin <src>` | 字符串 | 输入来源：`human`、`agent`、`trigger`。默认 `human`。 |
| `--meta <json>` | JSON 对象 | 附带业务元数据。透传至 `turn_settled` 钩子。 |
| `--attach <ids>` | 字符串 | 关联挂载的产物 ID 列表。逗号分隔。 |
| `--replace-from <n>` | 数值 | 从指定历史条目截断并覆盖重发。 |

---

#### helm abort [id]

强制中止会话当前执行中的思考或工具调用。

```bash
helm abort 42
helm abort --current
```

---

### 人类审批与提问响应

#### helm asks list

列出当前所有挂起等待人类决策的提问条目。

```bash
helm asks list
helm asks list --json
```

---

#### helm asks answer <id>

回答指定提问。支持 CAS 乐观锁防竞态覆写。

```bash
# 提交表单答案
helm asks answer ask-789 --answers '{"approved":true,"reason":"已验证补丁"}'

# 带乐观锁版本提交
helm asks answer ask-789 --answers '{"approved":true}' --expected-state-seq 3
```

| 参数 | 类型 | 说明 |
| :--- | :--- | :--- |
| `<id>` | 字符串 | 提问唯一标识符。 |
| `--answers <json>` | JSON（必填） | 字段名至回答内容的 JSON 映射。 |
| `--expected-state-seq <n>` | 数值 | CAS 乐观锁水位线。人类在终端按键推进状态时自动销单。 |

---

#### helm asks cancel <id>

取消提问并恢复会话执行。

```bash
helm asks cancel ask-789
```

---

### 角色配置与模型网关

#### helm profiles list / get / delete

管理专家角色 Profile。

```bash
helm profiles list
helm profiles get coder
helm profiles delete temporary-bot
```

---

#### helm profiles create / update

创建或更新 Profile。支持语义化标志与本地文本文件导入。

```bash
# 从本地文件创建角色配置
helm profiles create reviewer \
  --name "代码审查员" \
  --model "anthropic/claude-3-7-sonnet" \
  --system-file ./prompts/system.md \
  --memory-file ./prompts/memory.md

# 增量修改已有角色工作目录
helm profiles update coder --cwd /workspace/helm

# 设置技能白名单（仅允许加载指定技能）
helm profiles update coder --skills '["git-commit","herdr"]'

# 清空白名单：禁用全部技能
helm profiles update coder --skills '[]'

# 删除 skills 键：恢复加载全部当前可用技能
helm profiles update coder --all-skills
```

| 标志 | 类型 | 说明 |
| :--- | :--- | :--- |
| `--name <str>` | 字符串 | 角色显示名称。 |
| `--model <str>` | 字符串 | 默认模型标识。 |
| `--thinking <str>` | 字符串 | 思考档位配置。 |
| `--node <id>` | 字符串 | 绑定的计算节点。 |
| `--cwd <path>` | 字符串 | 默认工作目录绝对路径。 |
| `--system <str>` | 字符串 | 系统提示词文本。 |
| `--system-file <f>` | 字符串 | 自本地文件载入系统提示词。 |
| `--memory <str>` | 字符串 | 长期记忆提示词文本。 |
| `--memory-file <f>` | 字符串 | 自本地文件载入长期记忆。 |
| `--skills <json>` | JSON 字符串数组 | 技能白名单，如 `'["git-commit"]'`；空数组 `[]` 禁用全部技能；未设置（键不存在）时加载全部可用技能；与 `--all-skills` 互斥。 |
| `--all-skills` | 布尔 | 删除 `skills` 键，恢复加载全部当前可用技能；与 `--skills` 互斥。 |
| `--input <json>` | JSON 对象 | 整体 Profile 结构体。update 单独使用代表全量覆盖。 |

---

#### helm models list / default / providers / refresh

查询可用模型、配置默认模型、列出供应商与刷新目录。

- `helm models list`：列出可用模型目录（`GET /api/models`）。
- `helm models providers`：列出当前可用的 PI 供应商与认证方式清单（`GET /api/models/providers`）。
- `helm models default`：查看或配置全局默认模型与思考档位（`GET/PUT /api/models/default`）。
- `helm models refresh`：刷新动态网关模型目录（`POST /api/models/refresh`）。

```bash
# 列出系统当前识别的模型
helm models list

# 列出当前可用的 PI 供应商与认证方式清单
helm models providers

# 查询当前全局默认模型
helm models default

# 配置全局默认模型与思考档位
helm models default --set "anthropic/claude-3-7-sonnet" --thinking high

# 刷新动态网关模型目录
helm models refresh --provider magpie
```

| 标志 | 类型 | 说明 |
| :--- | :--- | :--- |
| `--set <model>` | 字符串 | 配置默认模型标识。传入空字符串重置。 |
| `--thinking <level>` | 字符串 | 配置默认思考档位。传入空字符串重置。 |
| `--provider <id>` | 字符串 | 刷新指定供应商模型。缺省刷新全部动态供应商。 |

---

#### helm providers list / set

配置大语言模型网关。密钥请置于环境变量中，严禁硬编码在配置体内。

```bash
# 列出配置的网关列表
helm providers list

# 整体替换模型网关配置
helm providers set --input '[{"id":"deepseek","type":"deepseek","apiKeyEnv":"DEEPSEEK_API_KEY"}]'
```

---

#### helm credentials list / set / delete

管理服务端凭据。明文机密直接持久化于 `credentials.json` 并注册到 SecretStash，不提供明文回读。

- `helm credentials list`：列出服务端已配置凭据（`GET /api/credentials`，仅返回 keys 与 configured 状态，不包含明文机密）。
- `helm credentials set <id> [--value <str>]`：写入或更新服务端凭据（`PUT /api/credentials/:id`，明文机密直接持久化于 `credentials.json` 并注册到 SecretStash，不回读）。
- `helm credentials delete <id>`：删除指定的服务端凭据（`DELETE /api/credentials/:id`）。

```bash
# 列出服务端已配置凭据摘要
helm credentials list

# 写入或更新服务端凭据
helm credentials set deepseek_api_key --value "sk-..."

# 删除指定的服务端凭据
helm credentials delete deepseek_api_key
```

| 参数 / 标志 | 类型 | 说明 |
| :--- | :--- | :--- |
| `<id>` | 字符串 | 凭据标识符。对应环境变量键名或密钥标识。 |
| `--value <str>` | 字符串（必填） | 凭据明文内容。持久化后注册到 SecretStash。 |

---

### 节点管理与跨节点执行

#### helm nodes list

列出所有计算节点、连接状态、物理架构与发布版本。

```bash
helm nodes list
helm nodes list --json
```

---

#### helm nodes issue <nodeId>

为目标受控节点签发一次性连接令牌（Join Token）。

```bash
helm nodes issue node-worker-gpu
```

返回明文令牌格式为 `<nodeId>:<secret>`。该令牌仅在签发时显示一次。

---

#### helm nodes remove <nodeId>

注销计算节点并立即断开双向 WebSocket 连接。

```bash
helm nodes remove node-worker-gpu
```

---

#### helm nodes upgrade [<nodeId>]

检查或执行受控节点自升级。支持指定版本与跨源升级。

```bash
# 检查目标节点可用更新
helm nodes upgrade node-worker-gpu --check

# 执行升级至指定版本
helm nodes upgrade node-worker-gpu --version 0.2.0

# 配合环境变量直接升级当前节点
HELM_NODE_ID=node-worker-gpu helm nodes upgrade --current
```

| 标志 | 类型 | 说明 |
| :--- | :--- | :--- |
| `--check` | 布尔 | 仅查询远端可用版本。不触发实际安装。 |
| `--version <v>` | 字符串 | 目标 SemVer 版本号。缺省升级至 `latest`。 |
| `--registry <url>` | 字符串 | 自定义 npm Registry 镜像源。 |
| `--force` | 布尔 | 强制执行。绕过金丝雀保护与冷却期限制。 |
| `--current` | 布尔 | 读取环境变量 `HELM_NODE_ID`。 |

---

#### helm env exec -- <command...>

跨节点直接执行系统命令。复用 EnvFabric 底座通信。

```bash
# 在指定远程节点执行系统命令
helm env exec --node node-worker-gpu --cwd /data -- ls -la

# 启用逐帧输出流并配置超时
helm env exec --node node-worker-gpu --timeout 30000 --stream -- pnpm test
```

| 标志 | 类型 | 说明 |
| :--- | :--- | :--- |
| `--node <id>` | 字符串 | 目标计算节点 ID。缺省读取当前会话或 `local`。 |
| `--cwd <path>` | 字符串 | 目标节点上的工作目录。须为绝对路径。 |
| `--timeout <ms>` | 数值 | 命令超时时间（毫秒）。最大 600000。 |
| `--stream` | 布尔 | 逐帧回传 stdout 与 stderr 数据流。 |
| `--current` | 布尔 | 读取环境变量 `HELM_CONVERSATION_ID` 解析节点。 |

---

### 工作流与沙箱隔离

以下命令由 `builtin:workflow` 插件（默认启用）注册，经动作清单动态生成。插件停用后命令随动作清单一并消失。

#### helm workflows list / runs / inspect / abort

查看与管理多智能体确定性工作流。

```bash
# 列出内置与自定义工作流模板
helm workflows list

# 查询历史执行记录（--current 绑定当前会话过滤）
helm workflows runs
helm workflows runs --current

# 检查特定执行实例状态（runId 为必填位置参数）
helm workflows inspect run-1024

# 中止正在执行中的工作流
helm workflows abort run-1024
```

#### helm workflows run <nameOrFile>

启动工作流实例。支持断点重放与同步等待终态。

位置参数为已保存工作流名或本地脚本文件路径；传入本地文件时自动读取源码作为 `script` 提交。

```bash
# 执行内置工作流并同步等待完成
helm workflows run parallel-code-review.workflow.js --wait

# 传递输入参数
helm workflows run custom.js --args '{"targetBranch":"feature/auth"}'

# 从指定断点重放工作流
helm workflows run custom.js --resume-from-run-id run-1024 --wait
```

| 标志 | 类型 | 说明 |
| :--- | :--- | :--- |
| `--args <json>` | JSON | 传给脚本上下文的任意 JSON 入参。 |
| `--script <source>` | 字符串 | 内联编排脚本源码（与位置参数、`--name` 择一）。 |
| `--script-path <path>` | 字符串 | 脚本文件绝对路径。 |
| `--name <name>` | 字符串 | 已保存工作流名。 |
| `--resume-from-run-id <id>` | 字符串 | 断点重放模式下的旧执行实例 ID。 |
| `--conversation-id <id>` | 数值 | 目标会话 ID。 |
| `--wait` | 布尔 | 同步阻塞等待终态。失败或中止时返回非零退出码。该命令无超时限制。 |
| `--current` | 布尔 | 绑定当前环境变量对应的会话 ID。 |

#### helm worktrees cleanup

安全清理受管 Git Worktree 沙箱。系统严格检查元数据，绝不触碰非登记目录。

```bash
# 按受管登记 ID 清理（node:path 形式）
helm worktrees cleanup --worktree-id local:/workspace/helm/.helm-worktrees/repo-abc

# 按会话清理对应工作树
helm worktrees cleanup --conversation-id 42

# 按路径清理并删除专用分支
helm worktrees cleanup --path /workspace/helm/.helm-worktrees/repo-abc --delete-branch

# 强制清理未提交改动的脏工作树
helm worktrees cleanup --worktree-id local:/workspace/helm/.helm-worktrees/repo-89 --force
```

| 标志 | 类型 | 说明 |
| :--- | :--- | :--- |
| `--worktree-id <id>` | 字符串 | 受管工作树登记 ID（`node:path`）。与 `--conversation-id` / `--path` 互斥。 |
| `--conversation-id <id>` | 数值 | 子会话 ID。与 `--worktree-id` / `--path` 互斥。 |
| `--path <path>` | 字符串 | 工作树物理绝对路径。与 `--worktree-id` / `--conversation-id` 互斥。 |
| `--node-id <id>` | 字符串 | 计算节点 ID。仅可与 `--path` 搭配消歧。 |
| `--delete-branch` | 布尔 | 清理时一并删除 `helm/spawn-*` 分支。 |
| `--force` | 布尔 | 强制清理脏工作树。默认拒绝未提交目录。不可越过占用、归属与 locked 校验。 |

清理工作树同样暴露为插件动作 `builtin:workflow` 的 `cleanup_worktree`，可经标准动作端点或 `run_action` 调用。

---

### 插件系统与动态动作

#### helm plugins list / enable / disable / config

管理插件生命周期与运行时配置。

```bash
# 查看所有插件加载状态
helm plugins list

# 启用与停用插件
helm plugins enable herdr
helm plugins disable triggers

# 查看插件配置与 JSON Schema
helm plugins config herdr

# 动态修改插件配置键值
helm plugins config herdr --set socketPath=/var/run/herdr.sock
```

| 标志 | 类型 | 说明 |
| :--- | :--- | :--- |
| `--input <json>` | JSON 对象 | 整体配置值 JSON 对象。 |
| `--set <k=v>` | 键值对 | 单项配置赋值。支持多次指定。 |

---

#### helm plugins doc / client

读取插件公开状态文档，或导出前端 React 视图编译产物。私有文档、停用插件和不存在的文档不可读取。

```bash
# 全局轻量导航摘要
helm plugins doc builtin:workflow run-badges --json

# 指定会话的完整运行摘要
helm plugins doc builtin:workflow runs --conversation 42 --json

# 当前会话（从 HELM_CONVERSATION_ID 解析）
helm plugins doc builtin:workflow runs --current --json

# 持续订阅指定会话文档：首帧快照，随后逐条事件
helm plugins doc builtin:workflow runs --current --watch --json

# 导出前端组件脚本
helm plugins client herdr --output ./dist/herdr-client.mjs
```

`--conversation` 与 `--current` 互斥。会话文档必须提供会话上下文；`--watch` 对应按文档过滤的 SSE 订阅，不监听全局广播。正常中断订阅会释放连接。

---

#### helm plugins init

本地脚手架命令。在目标目录生成外部插件骨架，不访问 Hub。

```bash
# 生成到 <dataDir>/plugins/my-plugin/（默认 full 模板）
helm plugins init my-plugin

# 指定父目录与模板
helm plugins init my-plugin --dir ~/code --template minimal

# 目标目录非空时继续（同名文件被覆盖，不删除现有文件）
helm plugins init my-plugin --force
```

| 参数 / 标志 | 类型 | 说明 |
| :--- | :--- | :--- |
| `[name]` | 字符串 | 插件目录名与默认 id。字母数字开头，允许 `-` `_`，禁止 `builtin:` 前缀。也可用 `--name` 指定。 |
| `--dir <dir>` | 字符串 | 目标父目录。默认 `<dataDir>/plugins`；不存在时自动创建。 |
| `--template <t>` | 字符串 | 骨架模板：`full`（默认，含 doc/动作/前端面板）\| `minimal`（仅后端探针动作）。 |
| `--force` | 布尔 | 目标目录非空时继续。默认拒绝，防覆盖。 |

产出文件（full 模板）：

- `plugin.json`：清单（`id` / `main: index.ts` / `clientRoot: ./client`）。
- `index.ts`：后端入口（`export default` PluginDefinition，含 doc + increment 动作 + 前端面板声明）。
- `tsconfig.json`：本地类型检查配置（宿主运行时转译不依赖它，仅供编辑器与 CI）。
- `client/index.tsx`：前端组件（`SamplePanel`，引入 `@helm/plugin-client` 共享 Hook）。
- `README.md`：开发闭环说明。

minimal 模板仅生成 `plugin.json`（不声明 `clientRoot`）、`index.ts`（ping 探针动作）、`tsconfig.json` 与 `README.md`。

---

#### helm plugins doctor

外部插件源码静态自检。真实代际导入 + 临时宿主真实注册 + 前端模块真实编译（含悬空 `export` 校验），不维护第二套近似校验器。插件缺陷以逐项检查结果呈现；预检失败时命令返回非零退出码（报告仍完整输出）。

```bash
# 按目录绝对路径自检（--path 或 --dir 等价；位置参数为绝对路径时同义）
helm plugins doctor --path /root/code/my-plugin
helm plugins doctor /root/code/my-plugin

# 按已注册插件 id 自检（服务端解析其源目录）
helm plugins doctor my-plugin
helm plugins doctor --id my-plugin
```

| 参数 / 标志 | 类型 | 说明 |
| :--- | :--- | :--- |
| `[<id> | <dir>]` | 字符串 | 位置参数：绝对路径视为目录目标，否则视为插件 id。 |
| `--path <dir>` | 字符串 | 插件源目录绝对路径。与 `--id` 互斥。 |
| `--dir <dir>` | 字符串 | `--path` 的兼容别名（等价）。 |
| `--id <id>` | 字符串 | 已注册外部插件 id。与路径目标互斥。 |

检查项（按执行顺序，后继依赖前驱成功）：

1. `manifest`：plugin.json 合法性、`main` 越根、入口存在。
2. `backend`：TS 转译、模块代际导入、`default` 导出形状。
3. `register`：临时 PluginHost 真实执行 definePlugin（与生产同一校验链）。
4. `client`：声明的全部前端模块真实编译 + 具名导出悬空校验。

注意：doctor 是静态自检。`definePlugin` 顶层依赖 `ctx.host.*` 调用的插件会在 `register` 检查处如实失败——宿主调用应放入动作处理器、服务生命周期或钩子内。

---

#### helm plugins rescan

增量重扫描插件目录。只注册当前未注册的外部插件（默认停用）；已注册插件不重载、不干扰。

```bash
helm plugins rescan
helm plugins rescan --json
```

放入新插件目录后无需重启 Hub：rescan 发现后 `helm plugins enable <id>` 启用。

---

#### helm plugins reload <id>

外部插件受控热重载。修改插件代码后不重启 Hub 换新实例。

```bash
helm plugins reload my-plugin
helm plugins reload my-plugin --json
```

| 参数 | 类型 | 说明 |
| :--- | :--- | :--- |
| `<id>` | 字符串 | 已注册外部插件 id（含 `:` 时自动 URI 编码）。 |

重载链：

1. **在途任务预检**：插件存在在途任务（自定义任务、执行中 Tool、挂起 agent_spawn、provider 在途流）时 `409 plugin_has_live_tasks` 拒绝。
2. **dry-run 预检**：对源目录执行完整 doctor；任一失败则旧实例保持不动，返回 `422 plugin_reload_preflight_failed`（附完整 doctor 报告）——坏代码绝不打断在运行插件。
3. **切换**：注销旧实例，以新代际模块图重新注册；切换失败时用旧代定义回滚（`rolledBack: true`），旧实例继续可用。
4. **启用状态保持**：重载前后启用状态不变（之前启用则新实例照常启用，服务按同一 prepare→start 屏障启动）。

内置插件（`builtin:*`）禁止热重载（403）；修改内置插件需重启 Hub。

---

#### 动态插件命令映射机制

插件通过 `ctx.action()` 声明的动作，自动映射为 CLI 二级命令。
内置插件自动剥离 `builtin:` 前缀，`ctx.action` 的 `cli.command` 可覆写默认命令路径（如 `builtin:workflow` 的 `run` 动作注册为 `helm workflows run`）。
CLI 首选静态命令表；无匹配时拉取 `GET /api/actions` 动作清单动态生成命令。

```bash
# 检查当前所有可用动作
helm actions list

# 触发 Herdr 终端窗格列表查询
helm herdr list --json

# 归档已结束的后台 Worker
helm superagent archive_worker --worker-conversation-id 88 --json

# 启动工作流并等待终态（builtin:workflow 插件动作）
helm workflows run review.workflow.js --wait
```

映射规则如下：
1. 路径格式：`helm <plugin-id> <action-id>`（可被 `cli.command` 覆写）。
2. 参数转换：JSON Schema 的 camelCase 属性自动转换为 kebab-case 选项（如 `worktreeId` → `--worktree-id`）。
3. 位置参数：`cli.positional` 按序消费位置参数；`readFileInto` 把本地文件内容读入目标字段（如 `workflows run <file>` → `script`）。
4. 超时：`cli.timeoutMs` 覆盖请求默认超时，`0` 表示无超时（供长耗时动作如 `workflow run --wait`）。
5. 冲突保护：若选项名与保留字冲突，降级为通过 `--input <json>` 提交。

---

### 产物与技能文档

#### helm artifacts list / put / get

管理会话创建的文件产物。

```bash
# 列出当前会话产物
helm artifacts list --current

# 上传本地文件至会话
helm artifacts put ./test-report.html 42 --mime-type "text/html"

# 下载会话二进制产物
helm artifacts get art-101 --output ./downloaded.png
```

---

#### helm skills list / read

浏览与查阅系统加载的技能知识库。

```bash
# 列出所有技能
helm skills list

# 读取技能说明文档
helm skills read git-commit

# 按相对路径读取技能内部参考文件
helm skills read git-commit --path references/conventional.md
```

---

## helm-node 守护进程命令参考

`helm-node` 部署于受控计算节点。
守护进程自持控制信道，绝不向无关 PID 发送操作系统信号。

```bash
helm-node <command> [options]
```

---

### 核心管理命令

#### helm-node connect <hubUrl> --token <token>

前台启动受控节点并开启 WebSocket 反向连接。常用于开发调试与容器化部署。

```bash
helm-node connect http://192.168.1.10:3202 --token "node-1:sec-token-abc"
```

| 标志 | 类型 | 说明 |
| :--- | :--- | :--- |
| `--token <token>` | 字符串（必填） | 节点接入令牌（格式：`nodeId:secret`）。 |
| `--once` | 布尔 | 注册成功后单次执行完毕即退出。 |
| `--data-dir <dir>` | 字符串 | 指定状态文件保存目录。 |

---

#### helm-node start [-d|--daemon]

启动守护进程。添加 `-d` 标志后转入后台托管执行。

```bash
# 首次启动需传入中枢地址与令牌
helm-node start -d --hub http://192.168.1.10:3202 --token "node-1:sec-token-abc"

# 后续启动自动复用 node.json 绑定配置
helm-node start -d
```

后台启动流程受 `node.start.lock` 排他锁保护。
进程就绪后创建原子记录文件 `<dataDir>/node.pid`。

---

#### helm-node stop

优雅停止后台执行中的受控守护进程。

```bash
helm-node stop
helm-node stop --data-dir /opt/helm
```

停止流程经由本地受控 IPC 发送指令。
守护进程完成当前执行任务环境清理后退出，随后删除 pid 记录文件。

---

#### helm-node restart

重启后台守护进程。

```bash
helm-node restart
```

该命令先验证旧进程已安全终止，再启动新实例。

---

#### helm-node status

查询节点绑定信息、后台进程号与执行状态。

```bash
helm-node status
helm-node status --json
```

输出字段包含节点 ID、Hub 连通状态、进程 PID 与 `instanceId`。

---

#### helm-node upgrade

受控自升级。支持在线无损热替换。

```bash
# 检查是否存在新版本
helm-node upgrade --check

# 执行升级至指定版本
helm-node upgrade --version 0.2.1 --registry https://registry.npmmirror.com

# 忽略金丝雀隔离策略强制升级
helm-node upgrade --force
```

升级流程通过 stdio IPC 拉起候选进程。
新进程注册成功后，经由控制端点完成提交协议，旧进程平滑退出。

---

#### helm-node doctor

零副作用自检工具。全面诊断本地执行环境。

```bash
helm-node doctor
```

自检项目清单：
1. 凭据文件 `node.json` 权限（必须为 `0600`）。
2. 工作空间磁盘写入权限。
3. 控制中枢 Hub 端口连通性。
4. Herdr 本地 IPC 管道状态。

---

#### helm-node service install / uninstall / status

注册为操作系统自启动守护服务。跨平台适配主流服务管理器。

```bash
# 注册开机自启服务
helm-node service install --hub http://192.168.1.10:3202

# 查看服务执行态
helm-node service status

# 卸载自启服务
helm-node service uninstall
```

平台支撑映射表：
- Linux：`systemd --user` 用户级单元。
- macOS：`launchd` Agent 服务配置。
- Windows：`schtasks` 计划任务机制。

---

## Shell 与 jq 自动化脚本范例

所有返回 JSON 的命令均可通过 `jq` 管道过滤。

### 范例 1：自动化回答挂起审批

定时轮询待审批提问。自动批准可信申请。

```bash
#!/usr/bin/env bash
set -euo pipefail

# 获取首个挂起提问的 ID 与字段
ASK_ID=$(helm asks list --json | jq -r '.[0].id // empty')

if [ -n "$ASK_ID" ]; then
  echo "正在自动处理审批: $ASK_ID"
  helm asks answer "$ASK_ID" --answers '{"approved":true,"reason":"CI 自动核准"}'
fi
```

---

### 范例 2：同步执行工作流并解析产物

在 CI/CD 中触发代码审查工作流。获取审查报告评分。

```bash
#!/usr/bin/env bash
set -euo pipefail

# 启动工作流并同步等待终态
RESULT=$(helm workflows run code-review.workflow.js \
  --args '{"branch":"main"}' \
  --wait \
  --json)

# 提取执行状态与产物标识
STATUS=$(echo "$RESULT" | jq -r '.run.status')
SCORE=$(echo "$RESULT" | jq -r '.run.result.qualityScore')

echo "工作流终态: $STATUS，质量评分: $SCORE"

if [ "$STATUS" != "completed" ] || [ "$SCORE" -lt 80 ]; then
  echo "门禁检查未通过"
  exit 1
fi
```

---

### 范例 3：批量巡检阻塞会话

扫描所有处于 `blocked` 状态的会话。汇总关联角色与未完成原因。

```bash
#!/usr/bin/env bash
set -euo pipefail

helm conversations list --status blocked --json | jq -r '
  .[] | "会话 [#\(.id)] 标题: \(.title) | 角色: \(.profileId) | 工作目录: \(.cwd)"
'
```

---

### 范例 4：跨节点批量执行健康巡检

遍历所有在线节点。直接执行磁盘空间与内存自检。

```bash
#!/usr/bin/env bash
set -euo pipefail

# 提取全部在线节点 ID
NODES=$(helm nodes list --json | jq -r '.[] | select(.online == true) | .id')

for NODE in $NODES; do
  echo "=== 节点巡检: $NODE ==="
  helm env exec --node "$NODE" --cwd /tmp -- df -h /
done
```

---

### 范例 5：批量导出指定会话的所有文件产物

自动化下载目标会话下创建的所有构建文件。

```bash
#!/usr/bin/env bash
set -euo pipefail

CONV_ID=42
OUTPUT_DIR="./artifacts_export"
mkdir -p "$OUTPUT_DIR"

# 获取产物列表并逐个下载
helm artifacts list "$CONV_ID" --json | jq -c '.[]' | while read -r ITEM; do
  ART_ID=$(echo "$ITEM" | jq -r '.id')
  FILE_NAME=$(echo "$ITEM" | jq -r '.name')
  TARGET_PATH="${OUTPUT_DIR}/${FILE_NAME}"
  
  echo "下载产物 $ART_ID 至 $TARGET_PATH"
  helm artifacts get "$ART_ID" --output "$TARGET_PATH"
done
```
