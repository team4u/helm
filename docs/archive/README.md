# 历史文档归档

本目录保存 Helm 项目早期开发交接记录、阶段验收报告与阶段特性设计文档。这些文件记录特定历史节点的设计决策与验证数据，仅用于演进追溯；归档文档只读，不再随代码演进修改，保留当时的提交节点、测试统计与设计语境。

现行权威契约一律以 `docs/` 主目录文档为准。如需了解当前框架架构与使用方法，请阅读 [文档中心](../README.md)。

## 一、早期开发交接与阶段验收记录

本目录下的 8 篇文档，时间跨度为 2026-11-06 至 2026-11-08，覆盖微内核地基交付到插件机制收口的早期迭代：

| 文档 | 归档日期 | 内容说明 |
|---|---|---|
| [20261106-核心开发交接.md](./20261106-核心开发交接.md) | 2026-11-06 | 极简微内核、持久会话状态机与 CLI 基础能力交付记录 |
| [20261106-helm极简微内核与双7扩展点设计文档.md](./20261106-helm极简微内核与双7扩展点设计文档.md) | 2026-11-06 | 初始系统架构设计方案，定义双 7 扩展点与四大内置插件架构 |
| [20261107-Herdr开发交接.md](./20261107-Herdr开发交接.md) | 2026-11-07 | `builtin:herdr` 插件实现、CLI Agent 委派与节点通道集成记录 |
| [20261107-Herdr总览修复验收.md](./20261107-Herdr总览修复验收.md) | 2026-11-07 | Herdr 节点状态总览修复与终端窗格同步验收记录 |
| [20261107-SuperAgent开发交接.md](./20261107-SuperAgent开发交接.md) | 2026-11-07 | `builtin:superagent` 独立中枢、驻留 Worker 与两层巡检机制交付记录 |
| [20261107-Triggers开发交接.md](./20261107-Triggers开发交接.md) | 2026-11-07 | `builtin:triggers` 定时器与 Webhook 入站连接器交付记录 |
| [20261108-核心地基加固验收.md](./20261108-核心地基加固验收.md) | 2026-11-08 | 内核并发状态机、CAS 乐观锁与事件总线加固验收记录 |
| [20261108-插件收口与界面隔离验收.md](./20261108-插件收口与界面隔离验收.md) | 2026-11-08 | 插件动态加载、界面隔离与样式规范收口验收记录 |

## 二、阶段特性设计文档归档（specs/）

[specs/](./specs/) 目录收录原 `docs/superpowers/specs/` 下的 14 篇阶段特性设计文档（2026-11-08 至 2026-11-11），记录 Web 界面、插件治理与编排交互在各阶段的方案推演与取舍。其中多数方案已落地并可能在其后迭代中调整，具体实现以当前代码与主目录文档为准：

| 文档 | 日期 | 内容说明 |
|---|---|---|
| [2026-11-08-mermaid-dark-mode-design.md](./specs/2026-11-08-mermaid-dark-mode-design.md) | 2026-11-08 | Mermaid 图表暗黑主题适配、主题联动重绘与全屏预览背景对齐 |
| [20261109-Web界面扩展机制与会话投影设计文档.md](./specs/20261109-Web界面扩展机制与会话投影设计文档.md) | 2026-11-09 | 消除宿主对内置插件的界面硬编码，统一扩展机制与会话投影 |
| [2026-11-09-conversation-idle-status-and-batch-delete-design.md](./specs/2026-11-09-conversation-idle-status-and-batch-delete-design.md) | 2026-11-09 | 会话列表空闲状态隐藏与批量删除交互设计 |
| [2026-11-09-conversation-status-dot-design.md](./specs/2026-11-09-conversation-status-dot-design.md) | 2026-11-09 | 会话列表状态圆点视觉升级规范 |
| [2026-11-09-docs-overhaul-design.md](./specs/2026-11-09-docs-overhaul-design.md) | 2026-11-09 | 全套开源框架文档重构设计（受控中文与零 Emoji 风格基线） |
| [2026-11-09-subagent-drawer-unification-design.md](./specs/2026-11-09-subagent-drawer-unification-design.md) | 2026-11-09 | 子代理与工作流会话抽屉交互统一（分屏与抽屉入口收敛） |
| [2026-11-09-workflow-nodes-unfold-live-card-design.md](./specs/2026-11-09-workflow-nodes-unfold-live-card-design.md) | 2026-11-09 | 工作流节点无折叠直出与子代理扁平双层胶囊卡规范 |
| [20261110-长期记忆插件化与Profile按需启停设计文档.md](./specs/20261110-长期记忆插件化与Profile按需启停设计文档.md) | 2026-11-10 | 拆分 `builtin:assistant` 为 `builtin:profile` 与 `builtin:memory` 的依据 |
| [2026-11-10-plugin-center-redesign.md](./specs/2026-11-10-plugin-center-redesign.md) | 2026-11-10 | 全屏插件中心：卡片网格 + 深度配置抽屉取代居中弹窗 |
| [2026-11-10-primary-centers-redesign.md](./specs/2026-11-10-primary-centers-redesign.md) | 2026-11-10 | 全屏资源中心矩阵重构（插件中心推广到多资源视图） |
| [2026-11-10-profile-tags-grouping-design.md](./specs/2026-11-10-profile-tags-grouping-design.md) | 2026-11-10 | 基于 Tag 的 Profile 团队归组与 `@` 补全点名整组角色 |
| [20261111-插件治理与故障隔离增强设计文档.md](./specs/20261111-插件治理与故障隔离增强设计文档.md) | 2026-11-11 | 外部插件故障隔离、持久占用预检、结算钩子隔离与配置溯源 |
| [20261111-全栈微应用生成与应用中心插件设计文档.md](./specs/20261111-全栈微应用生成与应用中心插件设计文档.md) | 2026-11-11 | AI 生成全栈微应用与应用中心的可行性方案推演 |
| [2026-11-11-magpie-styling-alignment-design.md](./specs/2026-11-11-magpie-styling-alignment-design.md) | 2026-11-11 | Web 样式系统对齐 Magpie 视觉（纯样式改动约束） |

## 维护原则

1. **只读保存**：归档文档不再随代码演进修改；
2. **保持原貌**：保留历史提交节点、测试用例统计与当时的设计语境；
3. **查阅新版**：现行架构与使用方法以 `docs/` 主目录文档为准。
