# 全屏插件中心（Plugin Center）重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将原本基于固定尺寸模态弹窗的插件页面彻底重构为独立的一级全屏插件中心（Plugin Center），通过响应式卡片网格（Marketplace Grid）、多维检索分类以及右侧深度配置抽屉（Detail Drawer），提供面向未来海量插件的极简、高效浏览与管理体验。

**Architecture:** 
1. 导航层将 `{ kind: 'plugins'; pluginId?: string }` 升格为 `ResolvedTarget` 一级主舞台目标，通过 `#/plugins` 与 `#/plugins?p=<id>` 提供完整的 URL Hash 路由、深链与历史恢复；
2. 业务层拆分为纯函数模型（`plugin-center-model.ts`）、响应式单卡片（`PluginCard.tsx`）、深度配置抽屉（`PluginDetailDrawer.tsx`）及主容器视图（`PluginCenter.tsx`）；
3. 全局入口（侧栏底栏、⌘K 命令面板、模型提供商配置）统一重定向至该全屏视图，彻底淘汰旧的 860px 局促弹窗。

**Tech Stack:** React 19, TypeScript, Radix UI (Dialog), Lucide React (纯线性矢量图标，严禁 Emoji), CSS Custom Properties, Node.js Test Runner (`tsx --test`).

## Global Constraints

- 严格遵守 `AGENTS.md`：必须在 `/root/code/helm` 下工作；
- 界面视觉铁律：UI 极简零 Emoji 规范（严禁在文案、标题、按钮、标签或卡片中使用任何 Emoji，统一使用 `lucide-react` 线性图标）；
- 架构单向依赖：`@helm/web` 依赖 `@helm/protocol`；
- 前端规范：`.tsx` 组件文件仅导出 React 组件（保障 Fast Refresh），纯函数模型放独立 `.ts`；
- 单测防死锁：所有单测显式声明 `{ timeout: 60_000 }`；
- 测试必须全部通过：每次任务执行完毕后验证全部回归用例。

---

### Task 1: 纯函数模型与分类过滤逻辑 (`plugin-center-model.ts`)

**Files:**
- Create: `packages/web/src/plugins/plugin-center-model.ts`
- Test: `packages/web/test/plugin-center-model.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PluginStatusFilter = 'all' | 'enabled' | 'disabled'
  export type PluginCategory = 'all' | 'builtin' | 'orchestration' | 'tools' | 'external'
  export interface PluginFilterState {
    query: string
    status: PluginStatusFilter
    category: PluginCategory
  }
  export interface PluginSummaryStats {
    total: number
    enabled: number
    disabled: number
    totalTools: number
    totalActions: number
  }
  export function derivePluginCategory(id: string): PluginCategory
  export function filterPlugins(plugins: PluginSummary[], filter: PluginFilterState): PluginSummary[]
  export function summarizePlugins(plugins: PluginSummary[]): PluginSummaryStats
  ```

- [ ] **Step 1: 编写失败的单元测试**

在 `packages/web/test/plugin-center-model.test.ts` 中编写测试：
- 测试分类推导（`builtin:assistant` -> `builtin`，`builtin:workflow`/`builtin:herdr`/`builtin:superagent` -> `orchestration`，自定义 -> `external`）；
- 测试搜索匹配（匹配 name、id、tools 数组项、actions 数组项，不区分大小写）；
- 测试状态筛选（`all`、`enabled`、`disabled`）；
- 测试统计汇总（总数、启用数、工具总数）。

- [ ] **Step 2: 运行测试并验证失败**

运行：`pnpm --filter @helm/web test -- test/plugin-center-model.test.ts`
预期：FAIL（模块尚未创建）

- [ ] **Step 3: 编写纯函数实现**

在 `packages/web/src/plugins/plugin-center-model.ts` 中实现：
- `derivePluginCategory`
- `filterPlugins`
- `summarizePlugins`

- [ ] **Step 4: 运行测试并验证通过**

运行：`pnpm --filter @helm/web test -- test/plugin-center-model.test.ts`
预期：PASS（所有断言 100% 通过）

- [ ] **Step 5: 提交代码**

```bash
git add packages/web/src/plugins/plugin-center-model.ts packages/web/test/plugin-center-model.test.ts
git commit -m "feat(web): 添加插件中心检索与分类纯函数模型"
```

---

### Task 2: 路由契约与一级主舞台目标升格 (`ResolvedTarget`)

**Files:**
- Modify: `packages/web/src/lib/types.ts`
- Modify: `packages/web/src/lib/url-hash-model.ts`
- Test: `packages/web/test/plugin-center-nav.test.ts`

**Interfaces:**
- Consumes: `ResolvedTarget` 联合类型定义
- Produces:
  ```ts
  // packages/web/src/lib/types.ts
  export type ResolvedTarget =
    | { kind: 'conversation'; id: number }
    | { kind: 'screen'; pluginId: string; screenId: string; params?: Record<string, string> }
    | { kind: 'plugins'; pluginId?: string }
  ```
  - Hash 编码：`plugins` -> `#/plugins`，`plugins` + `pluginId` -> `#/plugins?p=<pluginId>`
  - Hash 解码：识别 `#/plugins` 与 `#/plugins?p=<id>`

- [ ] **Step 1: 编写路由与导航失败测试**

在 `packages/web/test/plugin-center-nav.test.ts` 中编写测试：
- 验证 `serializeHash({ target: { kind: 'plugins' }, ... })` 输出 `#/plugins`；
- 验证 `serializeHash({ target: { kind: 'plugins', pluginId: 'builtin:workflow' }, ... })` 输出 `#/plugins?p=builtin%3Aworkflow`；
- 验证反向解析 `parseHash('#/plugins')` 与 `parseHash('#/plugins?p=builtin%3Aworkflow')` 正确还原 `ResolvedTarget`；
- 验证浏览器前进/后退/replace 时参数状态一致性。

- [ ] **Step 2: 运行测试并验证失败**

运行：`pnpm --filter @helm/web test -- test/plugin-center-nav.test.ts`
预期：FAIL（`types.ts` 与 `url-hash-model.ts` 尚未支持 `kind: 'plugins'`）

- [ ] **Step 3: 实现 Hash 契约编解码**

修改 `packages/web/src/lib/types.ts` 与 `packages/web/src/lib/url-hash-model.ts`：
- 在 `ResolvedTarget` 中加入 `{ kind: 'plugins'; pluginId?: string }`；
- 在 `parseHash` 中增加对 `plugins` 分支的处理；
- 在 `serializeHash` 中增加对 `target.kind === 'plugins'` 的序列化。

- [ ] **Step 4: 运行测试并验证通过**

运行：`pnpm --filter @helm/web test -- test/plugin-center-nav.test.ts`
预期：PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/web/src/lib/types.ts packages/web/src/lib/url-hash-model.ts packages/web/test/plugin-center-nav.test.ts
git commit -m "feat(web): 将全屏插件中心接入一级路由与 URL Hash 契约"
```

---

### Task 3: 插件卡片组件与响应式网格布局 (`PluginCard.tsx`)

**Files:**
- Create: `packages/web/src/plugins/PluginCard.tsx`
- Modify: `packages/web/src/styles.css`
- Test: `packages/web/test/plugin-card.test.ts`

**Interfaces:**
- Consumes: `PluginSummary` from `@helm/protocol`, `Switch` from `../ui/Switch.js`, `HelmIcon` from `../lib/icons.js`
- Produces:
  ```tsx
  export interface PluginCardProps {
    plugin: PluginSummary
    selected: boolean
    onSelect: () => void
    onToggle: (enabled: boolean) => Promise<void> | void
    toggling?: boolean
  }
  export function PluginCard(props: PluginCardProps): React.JSX.Element
  ```

- [ ] **Step 1: 编写卡片组件渲染与交互测试**

在 `packages/web/test/plugin-card.test.ts` 中编写测试：
- 验证卡片包含图标、名称、版本、锁定标签、Tools/Actions 胶囊徽章；
- 验证点击卡片主体触发 `onSelect`；
- 验证锁定插件（`locked: true`）的 Switch 处于禁用状态并显示锁定图标；
- 静态扫描组件代码与渲染输出中 0 Emoji。

- [ ] **Step 2: 运行测试并验证失败**

运行：`pnpm --filter @helm/web test -- test/plugin-card.test.ts`
预期：FAIL

- [ ] **Step 3: 实现卡片组件与 CSS 样式**

1. 创建 `packages/web/src/plugins/PluginCard.tsx`；
2. 在 `packages/web/src/styles.css` 中增加 `.plugin-center-grid`、`.plugin-card`、`.plugin-card-pill` 等样式类，支持发丝边框 `1px solid var(--border)` 与 hover 提亮。

- [ ] **Step 4: 运行测试并验证通过**

运行：`pnpm --filter @helm/web test -- test/plugin-card.test.ts`
预期：PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/web/src/plugins/PluginCard.tsx packages/web/src/styles.css packages/web/test/plugin-card.test.ts
git commit -m "feat(web): 实现插件中心卡片组件与网格流样式"
```

---

### Task 4: 详情与配置抽屉 (`PluginDetailDrawer.tsx`)

**Files:**
- Create: `packages/web/src/plugins/PluginDetailDrawer.tsx`
- Modify: `packages/web/src/styles.css`
- Test: `packages/web/test/plugin-detail-drawer.test.ts`

**Interfaces:**
- Consumes: `PluginSummary`, `PluginConfigForm`, `PluginUiView`, `Dialog` 原语
- Produces:
  ```tsx
  export interface PluginDetailDrawerProps {
    plugin: PluginSummary | null
    open: boolean
    onClose: () => void
    onToggleEnabled: (plugin: PluginSummary) => Promise<void>
    toggling: boolean
  }
  export function PluginDetailDrawer(props: PluginDetailDrawerProps): React.JSX.Element
  ```

- [ ] **Step 1: 编写详情抽屉测试**

在 `packages/web/test/plugin-detail-drawer.test.ts` 中编写测试：
- 验证抽屉在 `open=true` 时渲染插件详细元信息、Hooks 标签、Tools 清单与 Actions 清单；
- 验证支持关闭按钮与 Escape 退出；
- 验证当插件配置 Schema 存在时挂载 `PluginConfigForm`；
- 验证当存在自定义 `settingsPanels` 时正确挂载 `PluginUiView`。

- [ ] **Step 2: 运行测试并验证失败**

运行：`pnpm --filter @helm/web test -- test/plugin-detail-drawer.test.ts`
预期：FAIL

- [ ] **Step 3: 实现详情与配置抽屉**

创建 `packages/web/src/plugins/PluginDetailDrawer.tsx`：
- 使用 `@radix-ui/react-dialog` 原语实现右侧平滑滑出（`plugin-drawer-content`）；
- 抽屉内组织：顶部元信息、启停控制栏、暴露能力折叠与清单透视、动态配置项表单、扩展设置面板；
- 增加防并发竞争的代数请求保护 `configGeneration`。

- [ ] **Step 4: 运行测试并验证通过**

运行：`pnpm --filter @helm/web test -- test/plugin-detail-drawer.test.ts`
预期：PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/web/src/plugins/PluginDetailDrawer.tsx packages/web/src/styles.css packages/web/test/plugin-detail-drawer.test.ts
git commit -m "feat(web): 实现基于 Radix 的插件详情与深度配置抽屉"
```

---

### Task 5: 插件中心容器集成与全局入口收敛 (`PluginCenter.tsx` & 全局对接)

**Files:**
- Create: `packages/web/src/plugins/PluginCenter.tsx`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/shell/Sidebar.tsx`
- Modify: `packages/web/src/modals/CommandPaletteModal.tsx`
- Modify: `packages/web/src/modals/ProviderCatalog.tsx`
- Delete: `packages/web/src/modals/PluginSettingsModal.tsx`（旧小弹窗正式退役）
- Test: `packages/web/test/plugin-center-integration.test.ts`

- [ ] **Step 1: 编写集成测试**

在 `packages/web/test/plugin-center-integration.test.ts` 中编写端到端集成测试：
- 验证在主舞台渲染 `PluginCenter` 时包含统计徽章、分类过滤器、卡片网格；
- 验证搜索框键入后实时过滤卡片；
- 验证点击卡片打开抽屉并同步 URL Hash；
- 静态扫描全仓排除旧的 `PluginSettingsModal` 引用；
- 验证全界面绝对零 Emoji。

- [ ] **Step 2: 运行测试并验证失败**

运行：`pnpm --filter @helm/web test -- test/plugin-center-integration.test.ts`
预期：FAIL

- [ ] **Step 3: 编写 PluginCenter 并替换全局调用入口**

1. 创建 `packages/web/src/plugins/PluginCenter.tsx`；
2. 在 `packages/web/src/App.tsx` 的主舞台判断中增加 `store.target.kind === 'plugins'` 分支；
3. 将 `Sidebar.tsx` 底栏齿轮按钮点击改为 `store.openTarget({ kind: 'plugins' })`，并在处于插件中心视图时高亮显示；
4. 将 `CommandPaletteModal.tsx` 与 `ProviderCatalog.tsx` 改为调用 `openTarget({ kind: 'plugins', pluginId })`；
5. 删除 `PluginSettingsModal.tsx`，清理其样式与导入。

- [ ] **Step 4: 运行全量构建与所有单测**

运行：`pnpm build && pnpm typecheck && pnpm test`
预期：全仓构建成功，所有单测 100% 全部通过。

- [ ] **Step 5: 提交代码并推送主线**

```bash
git add -A
git commit -m "feat(web): 完成全屏插件中心重构，收敛全局导航并淘汰旧弹窗"
git push origin main
```
