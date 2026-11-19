# 新手起步导览

本页帮助你用最短时间建立 Helmx 的核心概念地图，并给出一条从安装到跑通第一次对话、Swarm 对等协同与确定性工作流的最短路径。各概念只做定位级介绍，机制细节由链接文档承接。

## 核心概念速查

| 概念 | 说明 |
| :--- | :--- |
| **微内核 Kernel** | `@helmx/kernel` 只保留持久会话、跨节点执行底座、Model/Auth 与插件宿主四块通用机制，零业务角色硬编码 |
| **会话 Conversation** | 绑定 `(nodeId, cwd)` 物理坐标的持久状态机：全量落盘 SQLite/FTS5，支持中断续接、归属权保护与全文检索 |
| **角色 Profile** | 由 `builtin:profile` 管理的角色资产：每个 `profileId` 对应独立的系统提示词、技能白名单、默认模型与目标节点目录 |
| **Swarm 对等协同** | 由 `builtin:swarm` 提供：在顶层会话按需开启零常驻协同小队，动态拆角、序号黑板交接、复用 Git Worktree、纯事件自愈 |
| **工作流 Workflow** | 由 `builtin:workflow` 提供：原生 JavaScript 编排脚本，在沙箱内确定性执行，支持 JSONL 前缀重放断点续跑与 Gate 门禁 |
| **节点 Node** | 承载命令执行的计算机器：内建 `local` 节点；远端 Linux / macOS / Windows 机器部署 `helmx-node` 后经反向 WebSocket 接入 |
| **插件 Plugin** | 经 `definePlugin(ctx)` 声明的扩展单元：`ctx.action` 单点声明自动映射为 HTTP / CLI / Tool / Workflow / Web UI 五端能力 |

一个直观的分工例子：会话决定「在哪台机器的哪个目录工作」，Profile 决定「由什么角色、用什么技能来执行」，**Swarm** 负责「临时拉一支工程小队并行改代码 + 交叉审改」，**Workflow** 负责「把成熟套路固化为可重放、可断点续跑的 JS 流水线」——而这些业务策略全部由插件承载，内核只守住通用机制与安全红线。

## 三步上手

### 第一步：60 秒安装并初始化

推荐使用已发布的 npm 制品（前置条件：Node.js `>= 24.12.0` 与 Git；需要 Docker 部署或源码开发见[安装与配置指南](installation.md)）：

```bash
# 1. 全局安装控制 CLI 并拉起本机 Hub（自动安装 @helmx/hub 并托管 Web 控制台）
npm install -g @helmx/cli
helmx update --watch

# 2. 另开终端初始化管理员、配置模型 API Key 并选定默认模型
helmx setup --password '<your-admin-password>'
helmx models providers --json
helmx credentials set <provider-id> --value '<api-key>'
helmx models refresh --json
helmx models default --set '<provider>/<model>' --json
```

完成后在浏览器打开 `http://127.0.0.1:3202` 即可进入 Web 主控台。

### 第二步：会话对话与体验 Swarm 对等协同

会话是 Helmx 的基本交互单元：绑定 `(nodeId, cwd)`，全部对话与工具记录落盘可检索，既可在 Web 主控台交互，也可用 CLI 驱动：

```bash
helmx conversations list --json
helmx send 1 "分析这个仓库的目录结构与测试入口" --wait
```

遇到需要并行拆解与交叉审查的复杂任务时，直接在顶层人类会话里启用 **Swarm 对等协同**：

```text
/skill:swarm 重构导出模块为流式实现，前后端并行改代码并配只读 reviewer 交叉验收
```

主控会自动建组、按任务动态拆角并为并发写成员分配独立 Git Worktree，全过程在会话时间线、Composer「进行中」活动托盘与右侧 Workbench 编排面板实时可见。完整用法与四种编排原语的选型策略见[多智能体编排选型与实战指南](orchestration-guide.md)。

### 第三步：运行首个确定性工作流

需要可复用、可断点续跑的确定性编排时，运行任意 JS 工作流脚本（新启动的 run 必须显式指定目标会话 `--conversation-id <id>` 或在受管上下文用 `--current`，引擎不做缺省路由）：

```bash
# 源码仓内可直接运行自带 demo（npm 安装环境可自建任意 .workflow.js 文件）
helmx workflows run demo/hello-orchestra.workflow.js \
  --args '{"word":"开源"}' --conversation-id 1 --wait --json
```

完整演示（含 Web 界面观察、JSONL 前缀重放与失败恢复语义）见[编写首个工作流](first-workflow.md)。

## 进阶阅读

- **选型与实战**：[多智能体编排选型与实战指南](orchestration-guide.md) · [Swarm 对等协同插件](../plugins/swarm.md)
- **架构与机制**：[微内核架构总览](../architecture/overview.md) · [生命周期 Hook 与全界面扩展点](../architecture/extension-points.md) · [EnvFabric 分布式执行底座](../architecture/envfabric.md) · [pi-durable 持久会话状态机](../architecture/pi-durable.md)
- **编排与可靠性**：[原生 JavaScript DSL 手册](../workflows/dsl-guide.md) · [Git Worktree 与代码门禁](../workflows/worktree-and-gate.md) · [状态流水与故障恢复](../workflows/journaling-recovery.md)
- **插件与微应用**：[插件系统设计与契约](../plugins/overview.md) · [插件开发实战](../plugins/plugin-development.md) · [应用中心与微应用工坊](../plugins/apps.md)
- **命令参考**：[CLI 全量命令参考手册](../cli/reference.md)
