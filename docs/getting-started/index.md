# 新手起步导览

本页帮助你用最短时间建立 Helm 的概念地图，并给出一条从安装到运行首个工作流的最短路径。各概念只做定位级介绍，机制细节由链接文档承接。

## 核心概念速查

| 概念 | 说明 |
| :--- | :--- |
| **内核** | `@helm/kernel` 只保留持久会话、节点执行底座、Model/Auth 与插件宿主四块机制，零业务角色硬编码 |
| **会话 Conversation** | 绑定 `(nodeId, cwd)` 物理坐标的持久状态机：全量落盘 SQLite/FTS5，支持中断续接与全文检索 |
| **角色 Profile** | 由 `builtin:profile` 管理的角色资产：每个 `profileId` 对应独立的系统提示词与可用技能目录 |
| **工作流 Workflow** | 原生 JavaScript 编排脚本，由 `builtin:workflow` 插件在 Worker + `node:vm` 沙箱中确定性执行 |
| **节点 Node** | 承载命令执行的计算机器：内建 `local` 节点，远端机器部署 `helm-node` 守护进程后经反向 WebSocket 接入 |
| **插件 Plugin** | 经 `definePlugin(ctx)` 声明的扩展单元：注册工具、动作、Hook 与界面贡献，动作自动映射为 HTTP 端点与 CLI 命令 |

一个直观的分工例子：会话说「在哪个节点的哪个目录工作」，Profile 决定「这个会话由什么角色扮演、会什么技能」，工作流决定「一批子智能体按什么脚本协作」，而这三者的具体实现都不在内核里。

## 三步上手

**第一步：安装与初始化**。按[安装与配置指南](installation.md)确认 Node.js 24.12+、pnpm 9+ 与 Git 2.30+，然后启动前后端（`HELM_PORT=3202 pnpm dev`），初始化管理员并完成 CLI 登录。完成后 Web 控制台在 `3201` 端口可用，内核 Hub 在 `3202` 端口可用。

**第二步：会话与交互**。会话是 Helm 的基本交互单元。既可以在 Web 控制台直接对话，也可以用 CLI 驱动：

```bash
pnpm helm conversations list --json        # 查看现有会话
pnpm helm send <id> "分析这个仓库的测试结构" --wait
```

**第三步：首个工作流**。新工作流必须指定目标会话。选定或创建会话后，运行仓库自带的演示脚本并观察执行：

```bash
pnpm helm conversations list --json
pnpm helm workflows run demo/hello-orchestra.workflow.js \
  --args '{"word":"开源"}' --conversation-id 1 --wait --json
```

完整过程（含 Web 界面观察与断点恢复）见[编写首个工作流](first-workflow.md)。

## 进阶阅读

- **架构**：[极简微内核哲学](../architecture/overview.md)、[生命周期 Hook 与全界面扩展点](../architecture/extension-points.md)、[EnvFabric 分布式执行底座](../architecture/envfabric.md)、[pi-durable 持久会话状态机](../architecture/pi-durable.md)
- **编排**：[原生 JavaScript DSL 手册](../workflows/dsl-guide.md)、[Git Worktree 与代码门禁](../workflows/worktree-and-gate.md)、[状态流水与故障恢复](../workflows/journaling-recovery.md)
- **插件**：[插件系统设计与契约](../plugins/overview.md)、[自定义插件开发实战](../plugins/plugin-development.md)
- **参考**：[CLI 全量命令参考手册](../cli/reference.md)
