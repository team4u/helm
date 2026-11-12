# Helm 文档中心

Helm 是极简持久微内核多智能体编排系统：内核只保留持久会话、跨平台节点执行底座、Model/Auth 与插件宿主四块通用机制，编排引擎、角色资产、终端协同等一切业务能力由插件提供。本文档中心是全部文档的总索引，先按角色选读入口，再按目录深入。

## 按角色快速入门

**初次使用者**：读[新手起步导览](getting-started/index.md)建立概念地图，按[安装与配置指南](getting-started/installation.md)跑起 Hub 与 Web 控制台，再用[编写首个工作流](getting-started/first-workflow.md)完成第一次确定性编排。

**编排开发者**：从[原生 JavaScript DSL 手册](workflows/dsl-guide.md)掌握 `agent` / `parallel` / `pipeline` / `action` 原语；需要代码沙箱与验收时读 [Git Worktree 与代码门禁](workflows/worktree-and-gate.md)，需要断点续跑与恢复语义时读[状态流水与故障恢复](workflows/journaling-recovery.md)。

**插件开发者**：先读[极简微内核哲学](architecture/overview.md)与[生命周期 Hook 与全界面扩展点](architecture/extension-points.md)理解机制边界，再读[插件系统设计与契约](plugins/overview.md)和[自定义插件开发实战](plugins/plugin-development.md)上手 `definePlugin(ctx)`。

**运维与节点管理**：按[安装与配置指南](getting-started/installation.md)规划端口与凭据，读 [EnvFabric 分布式执行底座](architecture/envfabric.md)了解远端节点零 SSH 接入，日常操作查 [CLI 全量命令参考手册](cli/reference.md)。

## 文档索引

### 新手入门

| 文档 | 说明 |
| :--- | :--- |
| [新手起步导览](getting-started/index.md) | 核心概念速查与三步上手路径 |
| [安装与配置指南](getting-started/installation.md) | 环境依赖、服务启动、端口规划、环境变量与凭据隔离 |
| [编写首个工作流](getting-started/first-workflow.md) | 从选定目标会话到运行、观察、恢复 `demo` 工作流 |

### 架构与原理

| 文档 | 说明 |
| :--- | :--- |
| [极简微内核哲学](architecture/overview.md) | 零业务角色硬编码与五包单向依赖设计 |
| [生命周期 Hook 与全界面扩展点](architecture/extension-points.md) | 后端可组合 Hook 与前端全界面插槽契约 |
| [EnvFabric 分布式执行底座](architecture/envfabric.md) | 反向 WebSocket 连接、受管 Shell、节点透传隧道与安全自升级 |
| [pi-durable 持久会话状态机](architecture/pi-durable.md) | 五态状态机、SQLite/FTS5、机密隔离与 CAS 乐观锁 |

### 确定性工作流

| 文档 | 说明 |
| :--- | :--- |
| [原生 JavaScript DSL 手册](workflows/dsl-guide.md) | 执行模型、`meta` 约束与全部原语的权威参考 |
| [Git Worktree 与代码门禁](workflows/worktree-and-gate.md) | WorktreeIsolation 生命周期、租约、Gate 验收与安全清理 |
| [状态流水与故障恢复](workflows/journaling-recovery.md) | Journal 记账、前缀重放、不确定性判定与两阶段恢复 |

### 插件系统与内置生态

| 文档 | 说明 |
| :--- | :--- |
| [插件系统设计与契约](plugins/overview.md) | 宿主架构、`definePlugin(ctx)` 契约与动作五端映射 |
| [工作流编排插件](plugins/workflow.md) | `builtin:workflow`：三个模型工具、六个动作与运行面板 |
| [角色与技能底座](plugins/profile.md) | `builtin:profile`：角色资产、技能目录与 `load_skill` |
| [长期记忆](plugins/memory.md) | `builtin:memory`：按 Profile 管理的 `MEMORY.md` 与开关 |
| [应用中心与微应用工坊](plugins/apps.md) | `builtin:apps`：全栈微应用目录、`validate/publish` 与 `app-builder` 技能 |
| [Herdr 终端协同](plugins/herdr.md) | `builtin:herdr`：终端 CLI Agent 调度、文件交接与远程审批 |
| [SuperAgent 双层中枢](plugins/superagent.md) | `builtin:superagent`：零阻塞路由、驻留 Worker 与看门狗 |
| [自动化触发器](plugins/triggers.md) | `builtin:triggers`：Cron 与 Webhook 入站连接器 |
| [动态模型网关](plugins/magpie.md) | `builtin:magpie`：多协议分发与模型目录热重载 |
| [JSON 卡片渲染](plugins/json-render.md) | `builtin:json-render`：声明式 JSON Spec 渲染原语与技能 |
| [Mermaid 图表渲染](plugins/mermaid.md) | `builtin:mermaid`：聊天内 Mermaid 围栏渲染 |
| [自定义插件开发实战](plugins/plugin-development.md) | 前后端全栈插件开发、调试与发布 |

### 命令手册与开发规范

| 文档 | 说明 |
| :--- | :--- |
| [CLI 全量命令参考手册](cli/reference.md) | `helm` 与 `helm-node` 全量命令字典（含 `--json` 与 `--current`） |
| [Web 前端设计系统与开发约定](conventions/web-frontend.md) | 视图形态分级、Radix 原语与移动端规范 |
| [Web 导航与 URL Hash 约定](conventions/web-navigation.md) | 深链、分屏与刷新恢复的路由规范 |
| [历史设计与交接归档](archive/README.md) | 早期架构演进与阶段性验收记录（只读） |
