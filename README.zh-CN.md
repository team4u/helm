# Helmx

[English](README.md) · **简体中文**

Helmx 用来在自己的机器上运行和管理编程助手。Hub 保存会话和任务记录，助手在你指定的机器和仓库里工作。你可以在浏览器里跟进，也可以用 `helmx` 命令操作。

## 先跑起来

安装 Node.js 24.12 或更新版本，然后执行：

```bash
npm install -g @helmx/cli
helmx update --watch
```

保持这个终端开着，访问 <http://127.0.0.1:3202>。设置管理员密码，在「模型与凭证中心」配置供应商凭据，再选一个默认模型。打开新会话，把工作目录设为你的项目，先问一句「这里的测试从哪儿跑？」需要给成员分配独立工作树时，在实际执行的机器上安装 Git。 [安装与 CLI 配置](docs/getting-started/installation.md)

## 试试 Swarm

在自己打开的顶层会话里发送：

```text
/skill:swarm 看看这个项目怎么跑测试。请一个成员读 CI 配置，另一个读测试脚本，核对后告诉我本地该跑哪些命令。保持文件原样。
```

当前会话负责分工。成员可以在共享看板上直接交接，你也能从右侧工作台点开成员会话，看它查了什么、为什么这么判断。实际写代码时，可以让开发成员各用一个 Git worktree。审查成员发现问题后，把意见发给负责修改的人即可。 [Swarm 实战](docs/getting-started/orchestration-guide.md)

## 把任务交给另一台机器

在 Windows、macOS 或 Linux 上装 `@helmx/node`，让它主动连接 Hub。远端机器只需能出站访问 Hub，无需开放入站 SSH。给会话选好节点和工作目录，读文件、改代码和跑命令就会在那台机器上进行。也可以用 TCP 端口转发访问节点能连到的服务。 [节点接入](docs/getting-started/installation.md#接入远端节点) · [EnvFabric 参考](docs/architecture/envfabric.md)

## 把经常跑的步骤存成工作流

流程固定后，可以用 JavaScript 写下来。比如让两个助手分别检查一处改动，再汇总审查结果。写代码的步骤可以在成员自己的工作树里跑测试，测试通过才算该步成功。失败后续跑时，引擎会复用仍与运行记录匹配的已完成步骤。 [第一个工作流](docs/getting-started/first-workflow.md) · [恢复规则](docs/workflows/journaling-recovery.md)

## 接上现有的终端工具

按需启用 Herdr 插件，就可以把任务交给终端窗格里的 Claude Code、Codex 等 CLI 助手，并用文件交回经过校验的结果。助手等你确认时，可以直接在终端操作，也可以在浏览器里审批。如果终端已处理，浏览器里的旧审批会失效。 [Herdr 终端协作](docs/plugins/herdr.md)

## 文档

- 定时跑任务或接收外部事件，见 [Cron 与 Webhook](docs/plugins/triggers.md) 和 [SuperAgent](docs/plugins/superagent.md)。
- 想把经常做的事做成浏览器里能直接打开的工具，见 [应用中心](docs/plugins/apps.md) 和 [插件开发](docs/plugins/plugin-development.md)。
- [文档目录](docs/README.md) 收录了 [CLI 手册](docs/cli/reference.md)、[架构说明](docs/architecture/overview.md) 和其他参考资料。

Helmx 采用单管理员账户。插件和 shell 命令以执行它们的进程权限运行。项目仍在开发，接口和数据格式可能随版本变化。 [部署与凭据](docs/getting-started/installation.md) · [插件权限](docs/plugins/overview.md)

[参与开发](AGENTS.md) · [MIT 许可证](LICENSE) · [第三方声明](THIRD_PARTY_NOTICES.md)
