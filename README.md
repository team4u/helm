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

默认监听 `127.0.0.1:3202`，数据目录为 `~/.helm`。通过 `HELM_DATA_DIR` 可指定独立数据目录；通过 `HELM_MODEL=provider/model` 选择启动模型。模型凭据使用凭据服务配置，未配置模型时提交输入会返回显式错误。

```bash
pnpm helm --help
pnpm helm setup --password '请替换为至少八位的管理员密码'
pnpm helm status --json
pnpm helm conversations list --json
```

`setup` 只允许首次初始化；后续终端使用 `pnpm helm login` 登录。CLI 将登录凭据写入数据目录中的 `credentials.json`，权限为 `0600`。也可通过 `HELM_TOKEN` 指定令牌。

CLI 使用 `HELM_HUB_URL` 指定 Hub，默认 `http://127.0.0.1:3202`。支持指定会话的命令可通过 `--current` 读取 `HELM_CONVERSATION_ID`。读取会话不会自动清除未读状态。删除会话会清理产物和搜索索引，并阻止后续访问；受 SDK 接口限制，SQLite 内部历史记录仍保留。

工作流在独立 Worker 中执行，使用 `vm` 约束确定性。所有外部操作通过宿主原语发起；`vm` 不作为恶意脚本的安全隔离边界。工作流恢复会复用成功的调用前缀；如果动作留下开始记录但没有完成记录，恢复会显式报告不确定状态。

`SecretStash` 将审批中的机密答案保存在内存中，持久状态和模型上下文使用脱敏引用。Shell 和进程内插件拥有宿主权限，可以访问其执行环境；此边界不承诺对可信执行代码隐藏机密。
