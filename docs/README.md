# Helmx 文档中心

Helmx 是极简持久微内核多智能体主控台：内核（`@helmx/kernel`）只保留持久会话、跨平台节点执行底座、Model/Auth 与插件宿主四块通用机制；**Swarm 对等协同**、**确定性 JS 工作流**、**Git Worktree 隔离**、**Herdr 终端协同**、**全栈微应用**与 **SuperAgent 中枢**全部通过插件装配。本文档中心是全部文档的总索引：先按读者角色选入口，再按目录深入。

## 按读者角色选读

**初次使用者**：读[新手起步导览](getting-started/index.md)快速建立概念地图，按[安装与配置指南](getting-started/installation.md) 60 秒安装并启动 Hub，读[多智能体编排选型与实战指南](getting-started/orchestration-guide.md)掌握 Swarm / Workflow / Subagent / SuperAgent 的组合用法，再用[编写首个工作流](getting-started/first-workflow.md)跑通第一次确定性编排。只查命令行直接看 [CLI 全量命令参考手册](cli/reference.md)。

**多智能体协作与编排开发者**：
- 动态分工、Writer ↔ 只读 Verifier 交叉审改与序号黑板协同 → 读[多智能体编排选型与实战指南](getting-started/orchestration-guide.md)与 [Swarm 对等协同插件](plugins/swarm.md)；
- 确定性脚本与断点续跑 → 读[原生 JavaScript DSL 手册](workflows/dsl-guide.md)、[Git Worktree 与代码门禁](workflows/worktree-and-gate.md)、[状态流水与故障恢复](workflows/journaling-recovery.md)与[工作流编排插件](plugins/workflow.md)；
- 调度 23 种真实终端 CLI（Claude Code / Codex / pi 等）→ 读 [Herdr 终端协同](plugins/herdr.md)。

**插件与微应用开发者**：先读[微内核架构总览](architecture/overview.md)与[生命周期 Hook 与全界面扩展点](architecture/extension-points.md)理解机制边界，再读[插件系统设计与契约](plugins/overview.md)、[插件开发实战](plugins/plugin-development.md)与[应用中心与微应用工坊](plugins/apps.md)上手 `definePlugin(ctx)` 与全栈微应用发布。

**Web 界面开发者**：读 [Web 前端设计系统与开发约定](conventions/web-frontend.md)（视图形态分级、Radix 原语底座、零 Emoji 与移动端规范）与 [Web 导航与 URL Hash 约定](conventions/web-navigation.md)（深链、分屏参数与前进后退语义）；`@helmx/plugin-client` 的共享原语契约随[插件系统设计与契约](plugins/overview.md)一并给出。

**运维与多节点管理**：按[安装与配置指南](getting-started/installation.md)选择 npm 制品、Docker 容器或源码部署拓扑，读 [EnvFabric 分布式执行底座](architecture/envfabric.md)了解远端节点零 SSH 反向接入、TCP 透传隧道与安全自升级，日常运维查 [CLI 全量命令参考手册](cli/reference.md)。

**贡献者与发布维护**：读仓库根 [AGENTS.md](../AGENTS.md)（开发约定、测试分层与多智能体协作规范）、[发布流程](releasing.md)（`pnpm release` 本地编排与 `release.yml` 三制品发布流水线）；早期架构演进与阶段验收记录在[历史归档](archive/README.md)（只读，不反映现状）。

## 文档索引

### 新手入门与实战

| 文档 | 说明 |
| :--- | :--- |
| [新手起步导览](getting-started/index.md) | 核心概念速查与三步上手路径 |
| [安装与配置指南](getting-started/installation.md) | npm 三制品一键安装、Docker Hub + 宿主机节点、源码开发模式、端口与凭据隔离 |
| [多智能体编排选型与实战指南](getting-started/orchestration-guide.md) | Subagent / Swarm / Workflow / SuperAgent 四象限选型，Swarm 协同实战与跨节点/Herdr 组合 |
| [编写首个工作流](getting-started/first-workflow.md) | 从选定目标会话到运行、观察、断点恢复 `demo` 工作流 |

### 架构与内核机制

| 文档 | 说明 |
| :--- | :--- |
| [微内核架构总览](architecture/overview.md) | 四块通用机制、零业务角色硬编码、单向包拓扑与产品组合根 |
| [生命周期 Hook 与全界面扩展点](architecture/extension-points.md) | 后端 7 个生命周期 Hook 与前端 16 个 `ctx.ui` 扩展点完整契约 |
| [EnvFabric 分布式执行底座](architecture/envfabric.md) | 反向 WebSocket 零 SSH 接入、受管 Shell、文件互斥、TCP 透传隧道与安全自升级 |
| [pi-durable 持久会话状态机](architecture/pi-durable.md) | 五态状态机、SQLite/FTS5、SecretStash 机密隔离、归属权红线与 CAS 乐观锁审批 |

### 确定性工作流

| 文档 | 说明 |
| :--- | :--- |
| [原生 JavaScript DSL 手册](workflows/dsl-guide.md) | 执行模型、`meta` 约束与 `agent / goal / parallel / pipeline / workflow / action` 全部原语 |
| [Git Worktree 与代码门禁](workflows/worktree-and-gate.md) | Worktree 隔离生命周期、持久租约、Gate 恰好一次验收与六道清理防线 |
| [状态流水与故障恢复](workflows/journaling-recovery.md) | JSONL 账本记账、前缀重放、不确定性判定与 Hub 重启无感原位恢复 |

### 插件系统与 12 个内置插件

| 文档 | 说明 |
| :--- | :--- |
| [插件系统设计与契约](plugins/overview.md) | 宿主架构、`definePlugin(ctx)` 契约、五端一源 `ctx.action` 与停用预检 |
| [插件开发实战](plugins/plugin-development.md) | 外部插件前后端开发、`doctor` 四阶段自检、`rescan / enable / reload` 闭环 |
| [Swarm 对等协同](plugins/swarm.md) | `builtin:swarm`：扁平对等序号黑板、正交 `wake`、`turn_settled` 纯事件自愈与会话内协同看板 |
| [工作流编排](plugins/workflow.md) | `builtin:workflow`：`subagent` / `SubagentWorkflow` / `cleanup_worktree`、DSL 引擎与 Worktree 租约 |
| [角色与技能底座](plugins/profile.md) | `builtin:profile`：角色 `SYSTEM.md`、工作区 `AGENTS.md`、技能目录与 `load_skill`（locked 常驻） |
| [长期记忆](plugins/memory.md) | `builtin:memory`：按 Profile 管理的 `MEMORY.md` 注入与开关 |
| [应用中心与微应用工坊](plugins/apps.md) | `builtin:apps`：全栈微应用目录、`validate/publish` 与 `app-builder` 技能 |
| [Herdr 终端协同](plugins/herdr.md) | `builtin:herdr`：23 种终端 CLI Agent 调度、文件交接自愈与 CAS 审批桥（按需启用） |
| [SuperAgent 双层中枢](plugins/superagent.md) | `builtin:superagent`：零阻塞路由、驻留 Worker、RecallGraph 与两层看门狗（按需启用） |
| [自动化触发器](plugins/triggers.md) | `builtin:triggers`：Cron 定时调度与 HMAC-SHA256 Webhook 入站连接器 |
| [动态模型网关](plugins/magpie.md) | `builtin:magpie`：多协议分发、模型目录热重载与配额路由组诊断 |
| [JSON 卡片渲染](plugins/json-render.md) | `builtin:json-render`：回复内 ```ui 交互卡片声明式渲染与 `generative-ui` 技能 |
| [Mermaid 图表渲染](plugins/mermaid.md) | `builtin:mermaid`：聊天内 Mermaid 围栏渲染与停用回退 |
| [Token 速率徽标](plugins/token-speed.md) | `builtin:token-speed`：输入区实时解码速率（tok/s）、TTFT 与终态对账 |

默认启用（10 个）：`profile`（locked 常驻）、`workflow`、`swarm`、`memory`、`apps`、`triggers`、`magpie`、`json-render`、`mermaid`、`token-speed`；按需启用（2 个）：`herdr`、`superagent`。表格按读者主题排序，不以行位置表示启用状态。

### 命令手册与开发规范

| 文档 | 说明 |
| :--- | :--- |
| [CLI 全量命令参考手册](cli/reference.md) | `helmx` 与 `helmx-node` 全量命令字典（含 `--json` 与 `--current`） |
| [Web 前端设计系统与开发约定](conventions/web-frontend.md) | 视图形态分级、Radix 原语、零 Emoji 与移动端规范 |
| [Web 导航与 URL Hash 约定](conventions/web-navigation.md) | 深链、分屏与刷新恢复的路由规范 |
| [发布流程](releasing.md) | `pnpm release` 编排、`release.yml` 职责链与三制品发布门槛 |
| [历史设计与交接归档](archive/README.md) | 早期架构演进与阶段性验收记录（只读，不代表当前状态） |
