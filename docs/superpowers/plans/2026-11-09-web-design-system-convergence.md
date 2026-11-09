# Web 设计系统度量衡收敛与内联样式体系化重构计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 彻底解决 `@helm/web` 全仓 8 大核心样式割裂与 401 处内联样式堆叠问题，沉淀统一的原语级设计系统（按钮度量衡、弹窗分栏架构、列表项原语、表单网格、分段控制器、搜索框原语、平坦化卡片与空状态）。

**Architecture:** 
1. 遵循 Quiet Surface 极简微内核控制台设计哲学，强化机制与策略分离；
2. 在 `styles.css` 中建立度量衡精确、高复用、零特判的标准 UI 原语（Button / Icon Button / Segmented Control / Form Grid / Modal Split / Nav Item / Empty State / Search Box）；
3. 将全仓 5 大弹窗（Profile / Nodes / Plugin / Skill / Provider）、工作台、Composer、侧边栏的硬编码内联样式（401 处）系统性替换为设计系统原语类；
4. 严格遵守零 Emoji 规范与既有测试契约，保持 Fast Refresh 与 SSR 兼容。

**Tech Stack:** React 19, TypeScript, CSS Variables, Lucide React icons, Node.js test runner (`tsx --test`).

## Global Constraints

- 绝不在任何界面文案、侧栏、徽章、按钮或卡片中使用 Emoji 表情；
- 保持现有的测试用例断言契约不变（包括 `.btn-send` 的 32x32 与 50% 圆角、`.pane-parent-nav-btn` 的 999px 胶囊圆角、`split-toggle-btn` 等）；
- `.tsx` 文件只导出组件，纯函数/常量放独立模块；
- 所有改动必须通过 `pnpm --filter @helm/web typecheck`、`pnpm --filter @helm/web test` 与 `pnpm --filter @helm/web build`；
- 所有开发工作在 worktree 隔离分支 `refactor/web-design-system-convergence`（`/tmp/helm-web-design-system-convergence`）进行。

---

### Task 1: 设计系统基础原语与 CSS Token 补齐

**Files:**
- Modify: `packages/web/src/styles.css`
- Modify: `packages/web/src/responsive.css`
- Test: `packages/web/test/design-system-primitives.test.ts` (新建测试保护原语契约)

**Interfaces:**
- Consumes: CSS Variables (`--bg-subtle`, `--accent-bg`, `--border`, `--radius-sm`, etc.)
- Produces: 
  - Token: `--bg-inset: var(--bg-subtle)`
  - Buttons: `.btn` (32px), `.btn-sm` (28px), `.btn-xs` (22px), `.btn-icon` (32px), `.btn-icon-sm` (28px), `.btn-icon-xs` (22px)
  - Segmented Control: `.segmented-control`, `.segmented-control-btn`, `.segmented-control-btn.is-active`
  - Modal Split: `.modal-body-split` / `.asset-modal-body`, `.modal-sidebar` / `.asset-modal-list` (240px)
  - List Nav Items: `.list-item-btn` (`hover`, `.is-active`, `[aria-pressed='true']`)
  - Form Grid: `.form-grid` (130px 1fr), `.form-grid-label`, `.form-grid-align-start`
  - Quiet Surfaces: `.section-flat`, `.empty-state`, `.empty-state-icon`, `.empty-state-title`, `.search-box`

- [ ] **Step 1: 编写设计系统原语契约单测**

创建 `packages/web/test/design-system-primitives.test.ts`，断言核心原语类在 `styles.css` 中准确存在：
- `--bg-inset` 变量已声明；
- `.btn` 高度为 32px，`.btn-sm` 高度为 28px；
- `.btn-icon`, `.btn-icon-sm`, `.btn-icon-xs` 定义了严格的正方形与 `padding: 0`；
- `.segmented-control` 与 `.segmented-control-btn` 规则存在；
- `.modal-sidebar` 与 `.asset-modal-list` 包含 `width: 240px`；
- `.form-grid` 包含 `grid-template-columns: 130px 1fr`；
- `.list-item-btn` 包含主题选中态背景 `--nav-active-bg`。

- [ ] **Step 2: 运行单测验证失败**

Run: `cd /tmp/helm-web-design-system-convergence/packages/web && pnpm tsx --test test/design-system-primitives.test.ts`
Expected: FAIL

- [ ] **Step 3: 在 `styles.css` 与 `responsive.css` 中实现标准原语**

编辑 `packages/web/src/styles.css`：
1. `:root` 与 `:root[data-theme='dark']` 增加 `--bg-inset: var(--bg-subtle);`；
2. 调整 `.btn` 为 `height: 32px;`，`.btn-sm` 为 `height: 28px;`，`.btn-xs` 为 `height: 22px;`；
3. 增加标准纯图标按钮原语：
   ```css
   .btn-icon { width: 32px; height: 32px; padding: 0 !important; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
   .btn-icon-sm { width: 28px; height: 28px; padding: 0 !important; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
   .btn-icon-xs { width: 22px; height: 22px; padding: 0 !important; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
   ```
4. 增加 `.segmented-control` 与 `.segmented-control-btn`；
5. 增加 `.modal-body-split`, `.modal-sidebar`, `.asset-modal-body`, `.asset-modal-list` (240px 默认宽度)；
6. 增加 `.list-item-btn`；
7. 增加 `.form-grid`, `.form-grid-label`, `.form-grid-align-start`；
8. 增加 `.section-flat`, `.search-box`, `.empty-state`。
在 `responsive.css` 中补齐移动端适配（如 `.form-grid` 在窄屏下自动切换为单列）。

- [ ] **Step 4: 运行单测验证通过**

Run: `cd /tmp/helm-web-design-system-convergence/packages/web && pnpm tsx --test test/design-system-primitives.test.ts`
Expected: PASS

- [ ] **Step 5: 提交 Task 1 代码**

Run: `git commit -m "feat(web): 沉淀统一设计系统原语与度量衡对齐规范"`

---

### Task 2: 核心管理弹窗（Nodes / Profile / Plugin / Skill）结构与表单重构

**Files:**
- Modify: `packages/web/src/modals/NodesModal.tsx`
- Modify: `packages/web/src/modals/ProfileEditorModal.tsx`
- Modify: `packages/web/src/modals/PluginSettingsModal.tsx`
- Modify: `packages/web/src/modals/SkillViewerModal.tsx`
- Test: `packages/web/test/shell-modals.test.ts`

**Interfaces:**
- Consumes: Task 1 中的 `.modal-body-split`, `.modal-sidebar`, `.list-item-btn`, `.form-grid`, `.section-flat`, `.empty-state`, `--bg-inset`
- Produces: 彻底移除 178 处内联样式，统一 240px 侧栏与主题高亮选中态

- [ ] **Step 1: 重构 `NodesModal.tsx`**
  - 将侧栏宽度内联 `style={{ width: 230 }}` 替换为 `.asset-modal-list`；
  - 将 9 处嵌套 `<section className="card">` 替换为平坦的 `<section className="section-flat">`；
  - 列表项使用 `.list-item-btn`，移除所有内联 `style={{ width: '100%', background: ... }}`；
  - 替换 3 处硬编码 `var(--bg-inset)` 为标准的 `mono` 代码展示区块；
  - 表单网格应用 `.form-grid`。

- [ ] **Step 2: 重构 `ProfileEditorModal.tsx`**
  - 将侧栏宽度内联 `style={{ width: 210 }}` 替换为 `.asset-modal-list`；
  - 角色列表项使用 `.list-item-btn`；
  - 表单网格移除内联 `gridTemplateColumns: '110px 1fr'`，统一采用 `.form-grid` 与 `.form-grid-label`；
  - 空状态统一为 `.empty-state`。

- [ ] **Step 3: 重构 `PluginSettingsModal.tsx`**
  - 将侧栏宽度内联 `style={{ width: 230 }}` 替换为 `.asset-modal-list`；
  - 表单配置项统一使用 `.form-grid`（移除 `170px 1fr` 硬编码）；
  - 移除 Modal 内部嵌套的 `.card`，使用 `.section-flat`。

- [ ] **Step 4: 重构 `SkillViewerModal.tsx`**
  - 将侧栏内联 `style={{ width: 240 }}` 替换为 `.asset-modal-list`；
  - 技能列表按钮切换为 `.list-item-btn`；
  - 详情平坦化展示。

- [ ] **Step 5: 运行全量 Modal 测试与类型检查**

Run: `cd /tmp/helm-web-design-system-convergence && pnpm --filter @helm/web test && pnpm --filter @helm/web typecheck`
Expected: PASS (429 tests)

- [ ] **Step 6: 提交 Task 2 代码**

Run: `git commit -m "refactor(web): 重构四大管理弹窗分栏、表单网格与列表原语"`

---

### Task 3: 模型供应商弹窗（ProviderAuthModal & ProviderCatalog）收敛

**Files:**
- Modify: `packages/web/src/modals/ProviderCatalog.tsx`
- Modify: `packages/web/src/modals/ProviderAuthModal.tsx`
- Modify: `packages/web/src/modals/provider-auth.css`
- Test: `packages/web/test/mobile-modals.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `.segmented-control`, `.search-box`, `.list-item-btn`, `.empty-state`
- Produces: 规范的 Catalog 筛选栏、统一的搜索框、符合 Quiet Surface 的空状态

- [ ] **Step 1: 将分类筛选胶囊收拢为标准 `.segmented-control`**
  - 在 `ProviderCatalog.tsx` 中将 `.provider-filters` 替换为标准 `.segmented-control`；
  - 按钮样式应用 `.segmented-control-btn`。

- [ ] **Step 2: 收敛搜索框与供应商列表**
  - 将手写定位图标的 `.provider-search` 替换为 `.search-box` 原语；
  - 列表选中态统一使用 `--nav-active-bg` 与主题 token，去除手写阴影与异构边框。

- [ ] **Step 3: 收敛平坦化与空状态**
  - 将 `ProviderCatalog` 中大号营销插画风格空状态收敛为符合 Helm 极简气质的 `.empty-state`；
  - 去除不符合规范的多余样式规则。

- [ ] **Step 4: 测试验证**

Run: `cd /tmp/helm-web-design-system-convergence && pnpm --filter @helm/web test`
Expected: PASS

- [ ] **Step 5: 提交 Task 3 代码**

Run: `git commit -m "refactor(web): 收敛模型供应商弹窗分段控制器与搜索原语"`

---

### Task 4: 侧边栏、工作台抽屉与 Composer 纯图标按钮及交互控件重构

**Files:**
- Modify: `packages/web/src/shell/Sidebar.tsx`
- Modify: `packages/web/src/conversation/WorkbenchDrawer.tsx`
- Modify: `packages/web/src/conversation/Composer.tsx`
- Modify: `packages/web/src/modals/CommandPaletteModal.tsx`
- Modify: `packages/web/src/conversation/ArtifactPreviewModal.tsx`
- Modify: `packages/web/src/shell/AuthGate.tsx`
- Test: `packages/web/test/composer-layout.test.ts`
- Test: `packages/web/test/subagent-parent-nav.test.ts`

**Interfaces:**
- Consumes: `.btn-icon`, `.btn-icon-sm`, `.btn-icon-xs`, `.segmented-control`, `.search-box`
- Produces: 彻底消除侧边栏、抽屉、Composer 工具栏中手写的 `width/height/padding` 内联样式

- [ ] **Step 1: 重构 `Sidebar.tsx` 与 `AuthGate.tsx` 纯图标按钮**
  - 将 `Sidebar.tsx` 的 `ActionButton` 从内联 `style={{ height: 22, width: 22, padding: 0 }}` 替换为 `btn btn-ghost btn-icon-xs`；
  - 将 `AuthGate.tsx` 的内联 `style={{ height: 34 }}` 切换为标准控件高度体系。

- [ ] **Step 2: 重构 `WorkbenchDrawer.tsx` 关闭按钮与面板**
  - 将 `workbench-close-btn` 从内联 `style={{ width: 26, height: 26, padding: 0 }}` 替换为 `btn btn-ghost btn-icon-sm workbench-close-btn`；
  - 空状态改用 `.empty-state`。

- [ ] **Step 3: 重构 `Composer.tsx` 交互控件**
  - 刷新按钮切换为 `btn btn-ghost btn-icon-sm composer-model-refresh-btn`（去除内联 width 28 / height 28）；
  - 思考档位切换 row 替换为 `.segmented-control` 原语；
  - 模型搜索输入框使用 `.search-box` 原语结构；
  - 附件删除按钮应用 `.btn-icon-xs`（去除内联 height 16 / padding 0 3px）。

- [ ] **Step 4: 重构 `ArtifactPreviewModal.tsx` 与 `CommandPaletteModal.tsx`**
  - `ArtifactPreviewModal` 富文本/源码切换收敛为 `.segmented-control`（替换手写 `.btn-group`）；
  - `CommandPaletteModal` 关闭按钮应用 `.btn-icon-xs`，搜索框结构统一。

- [ ] **Step 5: 验证布局测试**

Run: `cd /tmp/helm-web-design-system-convergence && pnpm --filter @helm/web test`
Expected: PASS

- [ ] **Step 6: 提交 Task 4 代码**

Run: `git commit -m "refactor(web): 全局统一纯图标按钮原语并收拢分段切换器"`

---

### Task 5: 剩余零散页面内联样式清理与全仓地毯式验收

**Files:**
- Modify: `packages/web/src/conversation/AskDock.tsx`
- Modify: `packages/web/src/conversation/ConversationTimeline.tsx`
- Modify: `packages/web/src/conversation/MarkdownView.tsx`
- Modify: `packages/web/src/conversation/MermaidPreviewModal.tsx`
- Modify: `packages/web/src/shell/ToastOverlay.tsx`
- Test: 全量前端测试套件

**Interfaces:**
- Consumes: 全套设计系统原语
- Produces: 全仓内联样式数量大幅下降，统一的提示条与状态体系

- [ ] **Step 1: 清理 `AskDock.tsx` 与 `ConversationTimeline.tsx` 的内联样式**
  - 统一错误提示条为标准 `.callout` / `.jr-callout`；
  - 清理手写的 flex-direction 与 gap 内联样式。

- [ ] **Step 2: 清理 `MarkdownView.tsx` 与 `MermaidPreviewModal.tsx`**
  - 统一预览弹窗操作栏与工具按钮。

- [ ] **Step 3: 统计内联样式数量并核验削减效果**

Run: `grep -rn "style={{" packages/web/src | wc -l`
Expected: 从 401 处大幅削减（保留部分由数据动态驱动的必要内联样式，如颜色/位置/高宽比）。

- [ ] **Step 4: 运行全量测试、类型检查与 Vite 生产构建**

Run:
```bash
cd /tmp/helm-web-design-system-convergence
pnpm --filter @helm/web typecheck
pnpm --filter @helm/web test
pnpm --filter @helm/web build
```
Expected: 全部 PASS，0 错误，0 失败。

- [ ] **Step 5: 提交 Task 5 代码**

Run: `git commit -m "refactor(web): 清理剩余零散内联样式并完成设计系统全量收敛"`
