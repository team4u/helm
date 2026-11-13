---
name: {{SKILL_ID}}
description: 操作 Helm 或查询宿主能力时使用；涵盖会话、模型、节点、插件动作、触发器与产物，按需查阅工作流和插件开发专题。
managedByPlugin: {{MANAGED_BY}}
---

# Helm CLI 速查

## 环境与 CLI 铁律

1. Helm 受管 `bash` 提供 `helm` CLI（PATH 前置）与会话环境；通常可直接调用，无需手工登录：
   - `HELM_ENV`（固定为 `1`，标识处于 Helm 受管执行环境）。
   - `HELM_HUB_URL`：Hub 地址；`HELM_TOKEN`：受管进程令牌（不要打印或写进提示词）。调用失败时按实际错误排查。
   - `HELM_CONVERSATION_ID`：当前会话 ID；`HELM_CWD`：会话工作目录；`HELM_NODE_ID`：绑定节点（本机时另有 `HELM_DATA_DIR`）。
2. 解析输出必加 `--json`（人类可读输出仅供展示，不做程序消费）。
3. 支持 `--current` 的命令用它选择当前会话（读取 `HELM_CONVERSATION_ID`）；其他命令按帮助传目标 ID。
4. 自省优先（不背诵易变细节）：用 `helm --help`、`helm <cmd> --help` 实时查询子命令精确参数；动态插件动作与入参 JSON Schema 以会话内 `<available_actions>` 目录、`run_action({ actionId, describe: true })` 只读自省或 `helm actions list --json` 为准，插件配置以 `helm plugins config <id> --json` 为准。
5. 会话正忙时 `helm send` 可用 `--when-busy steer|followUp|reject`（省略时默认 steer 插话引导）；等待本次回答加 `--wait`。

## 核心 CLI 命令全景（API 与 CLI 同权，全部支持 --json）

### 鉴权与状态
- `helm status`：鉴权状态（未配置可探测）。
- `helm setup --password <pwd>`：初始化管理员密码并登录（仅首次）。
- `helm login --password <pwd>`：登录并保存凭据至 cli-token。

### 会话
- `helm conversations list [--profile <id>] [--status <s>] [--tag <t>]`：默认仅顶层会话（降噪）；`--all` 含子代理等全部派生子会话，`--parent <id>` 精确列出某会话的直接子会话（与 --all 互斥）。
- `helm conversations get [id] [--current] [--limit N] [--cursor <c>]`（含分页时间线）
- `helm conversations create [--title <t>] [--profile-id <id>] [--node <nodeId>] [--cwd <dir>] [--model <m>] [--tags <t>]`
- `helm conversations update <id> --title/--model/--thinking/--profile-id/--node/--cwd/--pinned/--unread`
- `helm conversations reset [id] [--current] [--handoff <text>]`（重置上下文，handoff 作为首条消息）
- `helm conversations compact [id] [--current]` / `helm conversations fork <id> --entry-id <n> [--title <t>]` / `helm conversations delete <id>`
- `helm send <id> "<text>"` 或 `helm send --current "<text>"`：提交输入；支持 `--wait`、`--when-busy steer|followUp|reject`（省略默认 steer）、`--meta <json>`、`--attach <artifactIds>`、`--replace-from <entryId>`（从指定历史条目起覆盖重发，截断该条及后续上下文）；代理代发时用 `--origin agent`。
- `helm ask "<text>"`：一次性问答（内部创建会话并等待回答，stdout 默认只输出回答文本，`--json` 输出 `{conversationId,submissionId,entryId,answer,deleted}`）；stdin 管道内容（非 TTY）自动并入 prompt；`--profile/--title/--cwd/--model/--tags/--timeout <ms>/--delete-on-success`；失败时会话保留并在错误信封给出可查 conversationId。
- `helm conversations withdraw [id] [--current] --submission-id <n>`：撤回排队中的输入（已进入执行或已结算时如实返回 already_placed/settled）。
- `helm abort [id] [--current]`：中止当前回合；不要中止自己正在执行的回合。
- `helm events watch`：订阅全局 SSE 事件（持续运行，用 Ctrl+C 结束）。
- `helm search <query>`：全库全文检索（FTS5）。

### Profile 与技能
- `helm profiles list` / `helm profiles get <id>`
- `helm profiles create [id] --name/--model/--thinking/--node/--cwd/--system[-file]/--skills/--all-skills/--starters/--input <json>`（扩展能力以当回合的插件动作与技能目录为准）
- `helm profiles update <id> ...`：语义化 flag 先 GET 再合并 PUT（不丢绑定字段）；`--input` 单独使用为全量替换。
- `helm profiles delete <id>`（默认 assistant 不可删）。
- `helm skills list` / `helm skills read <id> [--path references/xxx.md]`。内置 helm-cli 为系统受管只读技能，启动时按内置源码覆盖；需要扩展时创建自己的技能，不修改内置文件。

### 模型与网关
- `helm models list` / `helm models default [--set <provider/model>] [--thinking <level>]` / `helm models providers` / `helm models refresh [--provider <id>]` / `helm models filter [--provider <id> [--disable <modelId>... | --clear]]`（模型禁用集：无参数查看，全量替换语义）。
- `helm providers list` / `helm providers set --input <json>`（整体替换网关数组，严禁含密钥）。
- `helm credentials list` / `helm credentials set <id> --value <value>` / `helm credentials delete <id>`：服务端凭据管理。

### 节点与跨机执行
- `helm nodes list`：节点与在线状态；`helm nodes issue <nodeId>`：签发接入令牌（明文仅返回一次）；`helm nodes remove <nodeId>`；`helm nodes upgrade <nodeId> [--check]`：检查或执行节点升级；`helm nodes forward [<nodeId> | --current] <listenHost:listenPort> [<targetHost>:]<targetPort>`：前台本地 TCP 端口转发（事件流即持有者，Ctrl-C 退出并关闭）；`helm nodes forwards` / `helm nodes forward-inspect <forwardId>` / `helm nodes forward-stop <forwardId>`：活动转发清单/详情/停止。
- `helm env exec [--node <id>] [--cwd <dir>] [--timeout <ms>] [--stream] [--current] -- <command...>`：跨节点直接执行命令，超时单位毫秒。
- `helm worktrees list`：列出受管工作树登记（含已清理记录的元数据）；`helm worktrees inspect <worktreeId>`：只读检视（登记元数据 + 目标节点真实 git 状态/统计/有上限 diff 预览，可用 `--conversation-id <id>` / `--path <path> [--node-id <nodeId>]` 替代选择器，`--diff=false` 省略 diff 正文）；`helm worktrees cleanup [--worktree-id <id> | --conversation-id <id> | --current | --path <path> [--node-id <nodeId>]] [--delete-branch] [--force]`：清理受管工作树；默认拒绝脏工作区、未合入提交和在用/未确认停止的执行。

### 工作流
- `helm workflows list` / `helm workflows get <name>` / `helm workflows save [nameOrFile] [--from-run-id <id>] [--name <n>] [--overwrite]` / `helm workflows delete <name>` / `helm workflows run <nameOrFile> [--args <json>] [--resume-from-run-id <id>] [--current] [--wait]` / `helm workflows runs` / `helm workflows inspect <runId>` / `helm workflows abort <runId>` / `helm workflows steer <runId> --text <指导>`。工作流定义是跨会话资产（唯一真源为数据目录 `workflows/<name>.js`）：`save` 位置参数为本地脚本文件或目标名称，保存前自动语法预检、重复默认拒绝、`--overwrite` 才覆盖；`delete` 只删定义文件，不影响历史运行记录。`steer` 向运行中的后台原生子代理插话纠偏：仅 native 子代理 run 可 steer（DSL 工作流与外部 Herdr 执行显式拒绝），子会话归属 human 或事实已推进时拒绝。

### 插件与动作
- `helm plugins list`（含 status: active|disabled|failed 与失败诊断）/ `helm plugins enable <id>` / `helm plugins disable <id> [--force]`（占用预检 409 plugin_in_use 时可 --force 强制；在途运行任务仍不可跳过）/ `helm plugins config <id> [--input <json>] [--set k=v] [--unset <key>]`（--unset 发送 null 删除显式覆写，可重复，与 --set 同 key 冲突时报错）/ `helm plugins client <id>`。
- `helm plugins doctor <id|dir>`：外部插件源码静态自检（真实代际导入+真实注册断言+client 真实编译与悬空 export 校验）；目标择一：目录绝对路径或已注册插件 id；预检失败项逐条列出，不静默。
- `helm plugins reload <id>`：外部插件受控热重载（先 doctor 预检，失败时旧实例保持不动；在途任务拒绝 409；启用状态保持）。
- `helm plugins rescan`：增量重扫描插件目录（只注册新外部插件，默认停用）。
- `helm plugins init [name] [--dir <父目录>] [--template minimal|full] [--force]`：本地脚手架生成外部插件骨架（默认 full：plugin.json + index.ts + tsconfig.json + client/index.tsx；minimal 仅后端），不访问 Hub。
- `helm plugins install <source> [--enable]`：从 `npm:<spec>`、`git:<repo>@<ref>`、HTTPS Git URL 或本地路径安装外部插件包并注册（默认停用，`--enable` 装后即启用）。source 由 Hub 服务端解析与获取（本地路径是 Hub 主机上的路径，不是客户端上传）；安装启用即在 Hub 进程内执行可信插件代码，无沙箱。
- `helm plugins update <id>`：更新受管安装的外部插件包并重载（源未变化时如实返回 changed:false）。
- `helm plugins remove <id> [--yes]`：移除受管安装的外部插件包（破坏性：停用并清理 Hub 主机上的安装目录与记录）。人类模式 TTY 需输入 yes 确认；非交互环境用 `--yes`；`--json` 不交互。
- `helm plugins doc <id> <name>`：读全局公共文档；会话文档加 `--conversation <n>`（或 `--current`），持续订阅加 `--watch`（专用 SSE，首帧即当前值，Ctrl-C 退出）。
- 动作发现以当回合目录与工具列表为准：系统提示的 `<available_actions>` 段列出当前启用且匹配本会话作用域、经 `run_action` 调用的插件动作；直接暴露的动作在模型工具列表展示。内置与外部插件同权，新插件无需改 SYSTEM.md 或内置技能即自动出现。目录每项含全限定 ID（`pluginId.actionId`）、描述、可用 CLI 命令与紧凑参数签名，也可附作者声明的指引；插件停用或动作不可达时条目自动消失。
- 目录是摘要不是完整契约：调用前优先 `run_action({ actionId: "<pluginId>.<actionId>", describe: true })` 只读获取该动作完整 manifest（含嵌套入参/出参 JSON Schema），不执行 handler、无副作用；describe 同样按启用状态与 scope 过滤，无 bash 的会话也能自省。有 bash 时也可用 `helm actions list --json`（全量清单）或 `helm <plugin> <action> --help`（单动作参数）。
- `run_action({ actionId, input })` 无需先读本技能即可直接调用目录中的动作；`exposeAsTool: true` 的动作另以独立工具形态出现在工具列表，调用语义等价。
- `helm <plugin> <action>`：动作自动映射为 CLI 顶层命令（剥离 `builtin:` 前缀，`cli.command` 可覆写；如 `helm my-plugin send_notice`），支持 `--input <json>` 传参。

### 审批、产物与逃生舱
- `helm asks list` / `helm asks answer <id> --answers <json> [--expected-state-seq <n>]`（CAS 乐观锁）/ `helm asks cancel <id>`。
- `helm artifacts list [id] [--current]` / `helm artifacts put <filePath> [id] [--name <n>] [--mime-type <m>]` / `helm artifacts get <id> [--output <path>]`。
- 生成文件供用户在 Web 查看时，用 write(..., artifact: true) 或 `helm artifacts put <path> --current` 登记产物；在回复正文中可用 `[文件名](artifact:<id>)` 或 `![图片](artifact:<id>)` 直接内联渲染。
- `helm api <METHOD> <path> [--input <json>] [--field k=v]`：原始 HTTP 逃生舱（如 `helm api GET /api/nodes`）。

## 按需读取专题手册

遇到对应专题时先读对应参考文件，再动手：

- 编排多代理/多阶段任务（subagent、SubagentWorkflow 确定性脚本）或与 Herdr 终端 Agent、SuperAgent Worker 协作前：
  `load_skill({ skillId: "helm-cli", path: "references/workflows-and-agents.md" })`。
- 自举编写新技能（~/.helm/skills/<id>/SKILL.md）或开发外置插件（~/.helm/plugins/<id>/）前：
  `load_skill({ skillId: "helm-cli", path: "references/skill-and-plugin-dev.md" })`。
- 开发或优化插件 client.tsx，尤其涉及重型依赖、动态 import、首次加载性能或异步 chunk 前：
  `load_skill({ skillId: "helm-cli", path: "references/plugin-client-code-splitting.md" })`。
- 交互式展示、微应用构建等扩展能力按当回合可用技能描述选择：先加载适用技能，再按其指引调用工具或 `<available_actions>` 中的动作；没有适用技能时用普通 Markdown，不引用目录外的手册。
