# 应用中心与全栈微应用插件

`builtin:apps` 解决「把反复使用的工具台、看板、对账台沉淀为可打开的应用」的问题：为全栈微应用提供目录管理（`catalog`）、四阶段预检与一键发布，以及指导 AI 构建应用的 `app-builder` 受管技能。适合想让助理产出可复用工具的使用者，以及开发全栈微应用的插件作者。每个全栈微应用在底层就是携带至少一个 `ctx.ui.screen` 的标准受管外部插件（安装于 `<dataDir>/plugins/<appId>`）——不建第二套「套娃宿主」，发布后的应用天然享有动作五端映射与停用保护。

## 当前状态

默认启用、非 `locked` 可停用。遵循机制与策略分离：内核提供 `PluginHost` 受管包安装与编译机制，本插件承载应用级产品目录与生命周期编排。

## 能力和入口

### 五端动作（5 个）

| 动作 | CLI | Tool | 幂等 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `validate` | `helm apps validate <dir>` | 是 | 是 | 静态预检：宿主 `doctor` 真实四阶段（manifest → backend → register → client）+ 全栈应用硬性检查「至少一个 `ctx.ui.screen`」（缺失追加 `missing_app_screen` 失败项） |
| `publish` | `helm apps publish <dir>` | 是 | 否 | 先 validate（未通过 `422 app_validate_failed` 附完整诊断）；未安装或非同源时受管安装并启用，同源时热更新并确保启用（保留既有 `ctx.doc` 数据）；复核已启用 Screen 后登记 `catalog` 并 flush |
| `list` | `helm apps list` | 是 | 是 | 汇总全部应用（宿主插件/UI 清单左连接 `catalog`；孤儿 catalog 条目自动忽略） |
| `update_meta` | `helm apps update_meta <pluginId>` | 否 | 否 | 更新 catalog 元数据（`pinned` / `category` / `icon` / `workspaceDir` / `originConversationId`），不改插件本体；未登记 `404 app_not_published` |
| `remove` | `helm apps remove <pluginId>` | 否 | 否 | 卸载受管应用包并清理 catalog 登记；本地源码目录不受影响 |

### 公开文档 `catalog` 与应用中心视图

`ctx.doc('catalog', ..., { public: true })` 记录 `PluginSummary` 不承载的产品元数据：`pluginId` / `icon`（lucide 图标名）/ `category`（`productivity | devops | data | finance | automation | other`）/ `pinned` / `workspaceDir`（供 AI 修改后直接 publish 热更新）/ `originConversationId`（供跳回原对话继续迭代）/ `publishedAt` / `updatedAt`。

前端注册左栏「应用中心」入口（order 15）与全屏 `AppCenterScreen`：一级主舞台卡片网格（分类与关键字筛选，筛选状态写入 `sp.*` 深链参数）+ 右侧详情抽屉（Screen/Actions/Tools 清单、置顶与分类开关、跳回原对话分屏边看边改、从源码目录重新发布、卸载）。基于 `@helm/plugin-client` 的 `usePlugins()` 与 `usePluginDoc('catalog')` 实时渲染（SSE 驱动，无轮询）。

### 受管技能 `app-builder`

插件服务启动时自举受管技能 `app-builder`（SKILL.md + `references/fullstack-template.md`）：L1（`builtin:json-render` 的 ```ui 临时卡片）与 L2（全栈微应用）选型指引、目录规范与四步交付 SOP——初始化、编写、**强制 `apps_validate` 通过**、按用户意图 `apps_publish` 发布或输出草稿预览卡片。

### 脚手架

从零开发用 `helm plugins init <name> --template app` 起步：生成 public doc + 双 Schema 动作 + `ctx.ui.screen` 主视图 + 侧栏直达入口的完整骨架，产物无需发布即可通过 `helm plugins doctor` 与 `helm apps validate`，随后 `helm apps publish` 一键进应用中心。

## 配置与数据边界

- 插件自身无 `ctx.configSchema` 配置项；产品元数据全部在 `catalog` 公开文档。
- **跨节点路径守卫**：`validate` / `publish` 的相对路径按调用会话 `cwd`（无会话上下文时按 Hub cwd）解析。PluginHost 与 PackageManager 运行在 **Hub 主机**——会话绑定远端节点且传入相对路径时显式 `400 app_source_must_be_on_hub`，绝不在 Hub 本机猜同名路径冒充。
- **自指与内置保护**：禁止对 `builtin:apps` 自身或任何 `builtin:*` 插件执行 `publish / update_meta / remove`（`409 app_target_is_self` / `app_target_is_builtin`）。

## 停用与失败语义

停用本插件后：左栏入口、`helm apps` 动态命令、`app-builder` 技能与应用中心视图即时消失（不留幻影提示词）；**此前已发布的全栈微应用是独立受管外部插件，继续正常运行**，不受停用影响。发布链路失败语义如实：validate 未通过整体拒绝并附诊断；安装成功但启用失败显式 `422 app_enable_failed`（安装记录保留，可重试 enable）；安装后未发现已启用 Screen 显式 `422 missing_app_screen`。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口（动作/catalog/UI/技能自举） | `packages/plugins/src/apps.ts` |
| `app-builder` 技能资产 | `packages/plugins/src/apps/skill/` |
| 前端应用中心 | `packages/plugins/src/apps/client/` |
| 测试 | `packages/plugins/test/apps-plugin.test.ts`、`app-workflow.integration.test.ts`、`app-workflow-env-exec.integration.test.ts` |

## 相关文档

- [插件开发实战](plugin-development.md)：`helm plugins init --template app` 与全栈应用骨架
- [插件系统设计与契约](overview.md)：受管包生命周期与动作五端映射
- [Web 前端设计系统](../conventions/web-frontend.md)：主舞台卡片网格 + 详情抽屉的视图形态契约
