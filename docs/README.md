# Helm 文档中心

Helm 是轻量持久微内核多智能体编排系统。
系统集成持久状态机、确定性编排引擎与跨平台节点底座。
本文档中心提供完整的系统指南、开发手册与运维参考。

---

## 学习路径导航

根据你的目标选择对应的学习路线。

### 1. 初学者路径

适合首次接触 Helm 的工程师。
你可以快速建立本地开发环境并执行第一个多智能体工作流。

```mermaid
flowchart LR
    A["环境安装与配置"] --> B["登录与状态检查"]
    B --> C["启动首个会话"]
    C --> D["执行确定性工作流"]
```

1. [新手起步导览](getting-started/index.md)：阅读学习目标与核心概念
2. [环境准备与部署](getting-started/installation.md)：安装 Node.js、pnpm 与启动服务
3. [编写首个工作流](getting-started/first-workflow.md)：执行原生 JavaScript 编排脚本

---

### 2. 编排开发者路径

适合需要构建多智能体工程任务的开发者。
你可以掌握确定性编排、代码沙箱隔离与断点恢复机制。

```mermaid
flowchart LR
    A["原生 JS DSL 语法"] --> B["Worktree 沙箱隔离"]
    B --> C["代码门禁验证"]
    C --> D["流水记录与断点续跑"]
```

1. [原生 JavaScript DSL 手册](workflows/dsl-guide.md)：学习 agent、parallel 与 phase 接口
2. [Git Worktree 与代码门禁](workflows/worktree-and-gate.md)：使用独立工作树与自动化门禁
3. [状态流水与故障恢复](workflows/journaling-recovery.md)：掌握执行流水与安全断点续跑

---

### 3. 插件开发者路径

适合需要扩展 Helm 功能的系统开发者。
你可以通过前后端对称双 7 扩展点开发全功能插件。

```mermaid
flowchart LR
    A["微内核架构哲学"] --> B["双 7 扩展点机制"]
    B --> C["插件契约 definePlugin"]
    C --> D["交付前后端扩展"]
```

1. [极简微内核哲学](architecture/overview.md)：理解零业务角色硬编码设计
2. [前后端对称双 7 扩展点](architecture/extension-points.md)：掌握 7 大生命周期 Hook 与 7 大界面扩展
3. [插件系统设计与契约](plugins/overview.md)：掌握 `definePlugin(ctx)` 强类型规范
4. [自定义插件开发实战](plugins/plugin-development.md)：开发包含 Action 与前端视图的完整插件

---

### 4. 运维部署路径

适合负责 Helm 集群部署与节点管理的运维工程师。
你可以配置跨平台执行织网、守护进程服务与凭据隔离。

```mermaid
flowchart LR
    A["网络与端口规划"] --> B["凭据与隔离存储"]
    B --> C["EnvFabric 节点连接"]
    C --> D["系统守护进程管理"]
```

1. [安装与配置指南](getting-started/installation.md)：掌握端口约定、环境变量与凭据隔离
2. [EnvFabric 分布式执行底座](architecture/envfabric.md)：理解反向 WebSocket 与安全原子升级
3. [CLI 全量命令参考手册](cli/reference.md)：查询 `helm` 与 `helm-node` 运维命令

---

## 文档索引

### 新手入门 (Getting Started)

| 文档 | 说明 |
| :--- | :--- |
| [导览与学习路径](getting-started/index.md) | 快速了解文档结构与起步步骤 |
| [安装与部署配置](getting-started/installation.md) | 环境依赖、服务启动、端口约定与凭据隔离 |
| [编写首个工作流](getting-started/first-workflow.md) | 从零编写并执行确定性多智能体编排 |

### 架构与原理 (Architecture)

| 文档 | 说明 |
| :--- | :--- |
| [极简微内核哲学](architecture/overview.md) | 零业务角色硬编码与五包单向依赖设计 |
| [前后端对称双 7 扩展点](architecture/extension-points.md) | 后端 7 大 Hook 与前端 7 大扩展点详解 |
| [EnvFabric 分布式执行底座](architecture/envfabric.md) | 零 SSH 反向 WebSocket 连接与受管 Shell |
| [pi-durable 持久会话状态机](architecture/pi-durable.md) | 五态状态机、SQLite/FTS5 与 AskDoc 乐观锁 |

### 确定性工作流 (Workflows)

| 文档 | 说明 |
| :--- | :--- |
| [原生 JavaScript DSL 手册](workflows/dsl-guide.md) | `agent`、`parallel`、`phase` 编排语法规范 |
| [Git Worktree 与自动化门禁](workflows/worktree-and-gate.md) | 代码工作树隔离机制与自动化 Gate 验收 |
| [状态流水与故障恢复](workflows/journaling-recovery.md) | Journaling 执行流水、调用复用与断点续跑 |

### 插件系统与内置生态 (Plugins)

| 文档 | 说明 |
| :--- | :--- |
| [插件系统设计与契约](plugins/overview.md) | 宿主设计、Action 自动映射与在途任务保护 |
| [确定性编排 (Workflow)](workflows/dsl-guide.md) | `builtin:workflow` 插件与原生 JS DSL 编排 |
| [角色与技能底座 (Profile)](plugins/profile.md) | 角色资产、动态技能目录与跨 Profile `@` 点名协同 |
| [长期记忆 (Memory)](plugins/memory.md) | 按 Profile 管理的长期记忆、开关与更新工具 |
| [Herdr 终端协同主控 (Herdr)](plugins/herdr.md) | 终端 CLI Agent 调度、文件交接与原地自愈 |
| [SuperAgent 双层中枢 (SuperAgent)](plugins/superagent.md) | 零阻塞路由、驻留 Worker 与两层看门狗巡检 |
| [自动化触发器 (Triggers)](plugins/triggers.md) | Cron 定时编排与 Webhook 签名入站验签 |
| [动态模型网关 (Magpie)](plugins/magpie.md) | 原生多协议分发与动态模型目录热重载 |
| [自定义插件开发实战](plugins/plugin-development.md) | 前后端全栈插件开发、调试与打包发布 |

### 命令手册与规范 (Reference & Conventions)

| 文档 | 说明 |
| :--- | :--- |
| [CLI 全量命令参考手册](cli/reference.md) | `helm` 与 `helm-node` 命令行参考字典 |
| [Web 导航与 URL Hash 约定](conventions/web-navigation.md) | 前端路由深链、分屏与状态恢复规范 |
| [历史设计与交接归档](archive/README.md) | 早期版本架构演进与阶段性开发验收记录 |
