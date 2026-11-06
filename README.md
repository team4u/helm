# Helm

Helm 是以 `pi-durable` 为底座的持久会话微内核。共享契约位于 `@helm/protocol`，运行时与插件宿主位于 `@helm/kernel`，`@helm/node` 通过 HTTP 提供 CLI。

本阶段实现核心与常驻 `builtin:assistant`；Web 外壳、Herdr、Super-agent 和外部触发器后续接入。架构约束见 [AGENTS.md](./AGENTS.md)，目标设计见 [设计文档](./docs/20261106%20helm极简微内核与双7扩展点设计文档.md)。

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

`setup` 只允许首次初始化；后续终端使用 `pnpm helm login` 登录。CLI 将登录凭据 JSON（Hub 地址与 Token）写入数据目录中的 `cli-token`，权限为 `0600`；模型和插件密钥继续保存在 `credentials.json`。旧版 `credentials.json.cli` 在首次读取时持锁迁移，其他密钥保留。`HELM_TOKEN` 优先于磁盘凭据，显式提供时不读取凭据文件。

CLI 使用 `HELM_HUB_URL` 指定 Hub，默认 `http://127.0.0.1:3202`。支持指定会话的命令可通过 `--current` 读取 `HELM_CONVERSATION_ID`。内核受管 Shell 自动获得仅本进程有效的 `HELM_TOKEN` 和当前会话环境，可直接调用 CLI；该 Token 随进程关闭失效，其回显通过统一出站脱敏处理。

读取会话不会自动清除未读状态。`conversations get` 返回会话摘要和最近一页时间线，可用 `--limit`、`--cursor` 继续读取。删除会话会清理产物和搜索索引，并阻止后续访问；受 SDK 接口限制，SQLite 内部历史记录仍保留。根会话和启用插件登记托管的常驻会话受删除保护。

工作流在独立 Worker 中执行，使用 `vm` 约束确定性。所有外部操作通过宿主原语发起；`vm` 不作为恶意脚本的安全隔离边界。工作流恢复会复用成功的调用前缀；如果动作留下开始记录但没有完成记录，恢复会显式报告不确定状态。

`SecretStash` 将审批中的机密答案保存在内存中，持久状态和模型上下文使用脱敏引用。审批创建返回 `{ id, status, answers }`，明确区分回答、取消和已在其他界面处理；调用方可预分配 ID 来绑定外部状态监听。Shell 和进程内插件拥有宿主权限，可以访问其执行环境；此边界不承诺对可信执行代码隐藏机密。

SSE 首帧包含会话、审批、启用插件 UI 和工作流运行摘要；随后推送时间线条目、流式状态、公开插件文档和工作流更新。插件文档必须显式声明 `public: true` 才能通过 `helm plugins doc <id> <name>` 读取，仍需 Hub 鉴权。`helm workflows runs --json` 可查看运行摘要。

升级旧数据前应停机备份整个数据目录。模型迁移会把旧会话当前使用的非空模型保留为显式覆盖，因为旧版没有记录其来源；清除覆盖后可使用新继承规则。需要回退数据格式时恢复配套备份，并重新登录 CLI。Web 组件渲染与 `client.tsx` 编译交付随 Web 阶段实现。
