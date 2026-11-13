# 应用中心与全栈微应用工坊插件

`builtin:apps` 是 Helm 全栈微应用的目录管理与生命周期编排插件（默认启用、非 `locked` 可停用）。遵循微内核「机制与策略分离」原则：内核提供 `PluginHost` 受管包安装与编译机制，本插件在此之上承载应用级产品目录（`catalog`）、全栈应用四阶段预检与一键发布动作、左栏「应用中心」全屏启动台（`AppCenterScreen`）以及指导 AI 构建应用的 `app-builder` 受管技能。

每个全栈微应用在底层就是携带至少一个 `ctx.ui.screen` 的标准受管外部插件（安装于 `<dataDir>/plugins/<appId>`）——不建第二套「套娃宿主」。因此发布后的应用天然享有动作五端映射（HTTP / CLI `helm <appId> <action>` / Agent Tool / Workflow / Web）、`ctx.doc` 持久化与 `409 plugin_has_live_tasks` 停用保护。

## 脚手架与种子样本

从零开发全栈微应用用 `helm plugins init <name> --template app` 起步：生成 public doc + 双 Schema 动作 + `ctx.ui.screen` 主视图 + 侧栏直达入口的完整骨架，产物无需发布即可通过 `helm plugins doctor` 与 `helm apps validate` 四阶段预检，随后 `helm apps publish` 一键进应用中心。仓库 `apps/todo-demo` 是同形的可复用种子样本（四动作 TODO 应用，含就地 validate/publish 用法说明）。

## 公开文档 `catalog` 与发现合并规则

插件声明公开持久文档 `ctx.doc<AppsCatalogDoc>('catalog', { apps: {} }, { public: true })`，记录 `PluginSummary` 不承载的应用产品元数据：

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `pluginId` | `string` | 对应受管外部插件的 ID |
| `icon` | `string` | 应用显示图标（lucide 图标名，缺省 `'layout-grid'`） |
| `category` | `AppCategory` | 业务分类：`productivity` / `devops` / `data` / `finance` / `automation` / `other` |
| `pinned` | `boolean` | 是否在应用中心置顶收藏 |
| `workspaceDir` | `string?` | 开发该应用的工作区源码绝对路径（供 AI 修改后直接 `publish` 热更新） |
| `originConversationId` | `number?` | 首次生成或最近迭代该应用的会话 ID（供一键跳回原对话继续迭代） |
| `publishedAt` / `updatedAt` | `number` | 首次发布与最近更新时间戳（epoch 毫秒） |

后端 `list` 动作与前端 `AppCenterScreen` 将宿主 `plugins` + `screens` 与 `catalog.apps` **左连接（Left Join）**：凡属于外部插件（`!id.startsWith('builtin:')`）且满足「声明了至少一个 `ctx.ui.screen`」或「已在 `catalog.apps` 登记」的插件，均作为全栈应用展示；内置插件不混入用户应用列表；已被 `helm plugins remove` 卸载的孤儿 `catalog` 条目自动忽略并在下次变更时清理。

## 五端动作（5 个）

5 个 `ctx.action` 自动映射为 HTTP `POST /api/actions/builtin%3Aapps/<action>`、CLI `helm apps <action>`、Agent Tool、Workflow `action()` 与 Web `callAction`：

| 动作 | CLI 映射 | 暴露为 Tool | 幂等 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `validate` | `helm apps validate <dir>` | 是 | 是 | 对工作区应用目录执行静态预检：调用宿主 `ctx.host.plugins.doctor({ dir })` 真实执行 `manifest -> backend -> register -> client` 四阶段检查，并额外强制校验至少声明一个 `ctx.ui.screen`（缺失追加 `missing_app_screen` 失败项） |
| `publish` | `helm apps publish <dir>` | 是 | 否 | 发布或升级工作区全栈应用：先执行 `validate`（未通过 `422 app_validate_failed` 拒绝，附完整诊断）；未安装或非同源时调 `install(dir, { enable: true })`，已安装且同源时调 `update(pluginId)` 热更新并确保启用（保留已有 `ctx.doc` 数据）；复核已启用 `Screen` 后登记 `catalog` 并 `await catalog.flush()` |
| `list` | `helm apps list` | 是 | 是 | 汇总全部全栈应用（宿主插件/UI 清单左连接 `catalog`） |
| `update_meta` | `helm apps update_meta <pluginId>` | 否 | 否 | 更新已发布应用的 `catalog` 元数据（`pinned` / `category` / `icon` / `workspaceDir` / `originConversationId`），不改插件本体；未登记应用返回 `404 app_not_published` |
| `remove` | `helm apps remove <pluginId>` | 否 | 否 | 调用 `ctx.host.plugins.remove(pluginId)` 卸载受管应用包并清理 `catalog` 登记（本地工作区源码目录不受影响） |

### 路径解析与诚实性边界

- **跨节点路径守卫**：`validate` 与 `publish` 的相对路径按调用会话绑定的 `cwd`（无会话上下文时按 Hub `cwd`）解析为绝对路径。由于 `PluginHost` 与 `PluginPackageManager` 运行在 Hub 主机上，当调用会话绑定在远端节点（`nodeId !== 'local'`）且传入相对路径时，显式拒绝并抛出 `400 app_source_must_be_on_hub`——绝不在 Hub 本机猜同名路径冒充。
- **自指与内置插件保护**：禁止对 `builtin:apps` 自身或任何 `builtin:*` 内置插件执行 `publish / update_meta / remove`（返回 `409 app_target_is_self` / `app_target_is_builtin`）；宿主 `ctx.host.plugins` 端口同样在入口处拦截插件对自身的 `update / remove / disable`（`409 plugin_self_lifecycle_forbidden`），防止单插件生命周期队列自等待死锁。

## 受管技能 `app-builder`

插件服务 `app-builder-skill` 在启动时经 `ctx.host.skills.ensureSkill` 自举受管技能 `app-builder`（`SKILL.md` + `references/fullstack-template.md`，声明 `managedByPlugin: builtin:apps`）：

- **L1 与 L2 选型**：单次对话内展示的临时表格/表单选 L1（`builtin:json-render` 的 ```` ```ui ```` 卡片）；需要跨对话持久状态、自定义后端动作或反复打开的独立工具台选 L2（全栈微应用）。
- **四步交付 SOP（Zero-Broken-App）**：① 在 `<cwd>/apps/<app-id>/` 初始化 `plugin.json`、`index.ts`（显式声明 `clientRoot: './client'` 与至少一个 `ctx.ui.screen`，默认不注册 `sidebarItem` 以免左栏膨胀）、`client/index.tsx`；② 编写后端 `ctx.doc` / `ctx.action` 与前端 `@helm/plugin-client` 组件（遵守零 Emoji 铁律与样式复用规范）；③ **强制调用 `apps_validate`**，未通过时按 `checks` 当场修复直至 `ok: true`，严禁跳过预检直接交付；④ 按用户意图调用 `apps_publish` 直接发布，或仅输出带「一键发布到应用中心」动作按钮的草稿预览卡片。

## 应用中心视图（`AppCenterScreen`）

插件在左栏注册「应用中心」入口（`target: 'screen:builtin:apps/center'`，order 15）与全屏视图 `AppCenterScreen`，基于 `@helm/plugin-client` 的 `usePlugins()` 与 `usePluginDoc('catalog')` 实时渲染（SSE 驱动，无轮询）：

- **一级主舞台卡片网格**：支持按分类（全部 / 已置顶 / 效率工具 / 运维监控 / 数据看板 / 财务记账 / 自动化 / 其他）与关键字筛选，筛选状态与选中详情应用编码在 `ScreenProps.params`（`sp.*` / `ssp.*` 深链可恢复）；卡片提供「打开应用」（主屏）、「分屏打开」（右屏并排）与详情抽屉入口；
- **右侧详情与管理抽屉**：展示应用的全部 `Screen` 视图、后端 `Actions` / `Tools` 清单、分类与置顶开关、关联工作区源码目录 `workspaceDir`，支持一键跳回 `originConversationId` 原对话并开启右屏分屏边看边改、从源码目录重新发布热更新，以及卸载应用。

## 停用语义

停用 `builtin:apps` 后：左栏「应用中心」入口、`helm apps …` 动态命令与 `app-builder` 技能即时从系统中消失（不留幻影提示词）；此前已通过本插件发布到 `<dataDir>/plugins/<appId>` 的全栈微应用作为独立受管外部插件继续正常运行，不受 `builtin:apps` 停用的影响。
