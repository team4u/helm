# Helmx 文档

第一次使用 Helmx，从 [安装并发出第一条消息](getting-started/index.md) 开始。已经在用，可以按手头的任务找对应的页面。

## 使用 Helmx

| 要做的事 | 文档 |
| --- | --- |
| 安装 Hub、添加模型、连接节点或用 Docker 部署 | [安装与配置](getting-started/installation.md) |
| 让几个助手一起改代码、互相审查 | [Swarm 实战与编排选型](getting-started/orchestration-guide.md) |
| 用 JavaScript 跑一次并行任务 | [第一个工作流](getting-started/first-workflow.md) |
| 把聊好的需求派出去，按项目查看进度和验收 | [从对话创建任务](getting-started/orchestration-guide.md#把聊好的需求交给独立执行会话) |
| 查命令和参数 | [CLI 命令参考](cli/reference.md) |

## 工作流参考

- [JavaScript 编排 API](workflows/dsl-guide.md)
- [Git Worktree、测试门禁与清理](workflows/worktree-and-gate.md)
- [运行记录、断点续跑与重启恢复](workflows/journaling-recovery.md)

## 插件手册

| 插件 | 用途 |
| --- | --- |
| [Swarm](plugins/swarm.md) | 派工、交接、审查和结单 |
| [Workflow](plugins/workflow.md) | 子代理和脚本运行 |
| [受管工作树](plugins/worktree.md) | 分配隔离工作树、登记租约和安全清理 |
| [Herdr](plugins/herdr.md) | 终端助手、文件交接和浏览器审批，按需启用 |
| [SuperAgent](plugins/superagent.md) | 后台任务路由、驻留 Worker 和巡检，按需启用 |
| [Profile](plugins/profile.md) | 角色提示词、技能和协作候选 |
| [长期记忆](plugins/memory.md) | 按 Profile 保存偏好和约定 |
| [应用中心](plugins/apps.md) | 检查、发布和管理微应用 |
| [Cron 与 Webhook](plugins/triggers.md) | 定时投递与接收外部事件 |
| [Magpie](plugins/magpie.md) | 网关模型目录、配额和路由 |
| [JSON 卡片](plugins/json-render.md) | 在聊天里展示表格、表单和操作按钮 |
| [Mermaid](plugins/mermaid.md) | 在聊天里渲染图表 |
| [Token 速率](plugins/token-speed.md) | 查看生成速度和首字延迟估算 |
| [任务看板](plugins/tasks.md) | 派发独立执行会话并跟踪验收闭环 |

## 开发 Helmx 和插件

- [架构总览](architecture/overview.md) · [EnvFabric 节点执行](architecture/envfabric.md) · [持久会话与审批](architecture/pi-durable.md)
- [插件契约](plugins/overview.md) · [插件开发教程](plugins/plugin-development.md) · [后端 Hook 和前端扩展点](architecture/extension-points.md)
- [前端组件和样式约定](conventions/web-frontend.md) · [导航和分屏约定](conventions/web-navigation.md)
- [仓库开发约定](../AGENTS.md) · [发布流程](releasing.md) · [历史设计归档](archive/README.md)
