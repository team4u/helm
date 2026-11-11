---
name: app-builder
description: 构建可反复使用的全栈微应用（带前后端与持久状态的工具台、看板、对账台、追踪器）并发布到应用中心时使用；涵盖 L1 临时卡片与 L2 全栈应用的选型、目录规范、validate/publish SOP 与代码模板。
managedByPlugin: builtin:apps
---

# 全栈微应用构建（应用中心）

当用户需要一个「能反复使用、有自己界面与持久数据」的工具时，按本技能的 SOP 交付。

## L1 还是 L2：先做选型

- **L1 临时卡片（```ui 代码块）**：只在当前对话内展示一次的数据表格、指标、确认表单；随对话沉底、无持久状态、无后端逻辑。生成方式见 generative-ui 技能（`load_skill({ skillId: "generative-ui" })`）。
- **L2 全栈微应用（本技能）**：用户明确要求「保存/发布/以后还能打开」的工具台，或需要跨对话持久数据、自定义后端动作、独立界面。产物是标准 helm 插件包，经 `builtin:apps` 发布到应用中心。

拿不准时问用户一句话，不要替用户猜。

## L2 交付 SOP（四步，不可跳步）

### 1. 规划与目录初始化

默认在当前工作区 `<cwd>/apps/<app-id>/` 下创建：

```
apps/<app-id>/
  plugin.json          # { "id": "<app-id>", "main": "index.ts", "clientRoot": "./client" }
  index.ts             # 后端：clientRoot: "./client" + ctx.doc / ctx.action / ctx.ui.screen
  client/index.tsx     # 前端：主 Screen 组件
  client/styles.css    # 本地样式（可选）
```

- `app-id` 用 kebab-case（如 `bill-desk`），禁止 `builtin:` 前缀；
- **clientRoot 必填**：前端组件放在 `client/` 子目录时，`index.ts` 的 `PluginDefinition`（或 `plugin.json`）必须显式声明 `clientRoot: './client'`——未声明时默认根是插件目录本身，`apps_validate` 会因找不到 `index.tsx` 报 client 模块不存在；
- 界面文案与图标遵守零 Emoji 铁律；图标用 lucide 图标名（如 layout-grid、list-checks、wallet）。

### 2. 全栈编码约束

后端 `index.ts`（标准 `PluginDefinition`）：

- `ctx.doc('<name>', initialState, { public: true })` 持久化业务数据；**写操作后 `await doc.flush()`**；
- `ctx.action({ id, description, inputSchema, outputSchema, exposeAsTool: true, handler })` 编写增删改查或跨节点逻辑（`ctx.host.execEnv` 跨节点执行）；动作自动获得 HTTP / CLI / Agent Tool / Workflow / Web 五端映射；
- **必须注册至少一个 `ctx.ui.screen({ id: 'main', label: '...', client: { module: 'index.tsx', export: 'MainScreen' } })`**——这是全栈应用的硬性要求，validate 会强制检查；
- **默认不注册 `ctx.ui.sidebarItem`**（应用入口由应用中心统一收敛，防止左栏膨胀）。

前端 `client/index.tsx`：

- 从 `@helm/plugin-client` 导入 `usePluginContext`（`callAction` / `openScreen` / `notify`）、`usePluginDoc` 订阅公开文档；
- 复用共享 UI 原语（`HelmIcon`、`Tabs`、`Select`、`Switch`、`Dialog`、`Callout` 等），不造原生控件；
- 样式用宿主 CSS 变量（`var(--bg-elevated)`、`var(--border)` 等）保持暗色/亮色自适应；本地 `.css` 文件经 import 打包，不写宿主 styles.css；
- 组件文件只导出组件与类型（保 Fast Refresh）；`client/index.tsx` 中引用的模块路径必须真实存在且具名导出匹配。

完整可运行模板：`load_skill({ skillId: "app-builder", path: "references/fullstack-template.md" })`

### 3. 强制静态自检（Zero-Broken-App）

编写或修改代码后**必须**调用 `apps_validate` 工具（CLI：`helm apps validate <dir> --json`）。它执行真实四阶段检查：manifest / 后端 TS 转译 / 真实注册断言 / client esbuild 编译与导出校验，外加「至少一个 ctx.ui.screen」检查。

- 返回 `ok: false` 时按 `checks` 报告逐项修复（当场改 TS 类型、Schema 或 React 导出错误），直至 `ok: true`；
- **严禁跳过预检直接交付**；严禁伪造检查结果。

### 4. 发布或草稿交付

- 用户要直接可用或升级已有应用：调用 `apps_publish`（传 `dir` 绝对路径、`icon`（lucide 名）、`category`（productivity/devops/data/finance/automation/other））。成功后在回复正文输出 ```ui 交付卡片，含「在右屏并排打开应用」（`{ "type": "helm:open", "target": "screen:<appId>/main", "split": true }`）与「进入应用中心」（`{ "type": "helm:open", "target": "screen:builtin:apps/center" }`）按钮；
- 用户要先审阅：只做 `apps_validate`，输出 ```ui 预览卡片（应用结构摘要 + 「一键发布到应用中心」按钮，绑 `{ "type": "helm:action", "pluginId": "builtin:apps", "actionId": "publish", "input": { "dir": "<absDir>", "category": "..." } }`），等用户点击；
- 升级已发布应用：改同一工作区源码后再次 `apps_publish`（同源走 update 热重载，数据保留）。

## 边界事实（如实告知用户）

- **无沙箱**：发布的应用是进程内可信插件代码，拥有宿主权限（可读写文件、跨节点执行），只发布可信来源的代码；
- 路径边界：`validate` / `publish` 只接受 **Hub 本机**（local 节点）路径；会话绑定远端节点时显式报错，不在 Hub 本机猜同名路径；
- 发布产物安装在 `<dataDir>/plugins/<appId>`（受管副本，非 symlink）：改源码后需再次 publish 同步；`helm apps remove` 卸载。
