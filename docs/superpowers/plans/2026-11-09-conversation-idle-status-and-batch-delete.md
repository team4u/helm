# 会话列表空闲状态隐藏与批量删除实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 会话列表中隐藏空闲状态标签，移除单行删除功能，并提供全功能批量选择与批量删除。

**Architecture:** 在 `@helm/web` 前端层，更新 `StatusBadge` 状态过滤，抽离 `isConversationDeletable` 权限判断纯函数；在 `Sidebar` 引入批量管理模式，并联动 `conversationsApi.remove` 实现安全的批量删除与视图重定向。

**Tech Stack:** React 19, TypeScript, Lucide Icons, Node.js (`tsx --test`).

## Global Constraints

- 遵循极简克制风格，禁止在界面与代码文案中使用任何 Emoji 表情图标（图标统一采用 Lucide 矢量图标）。
- 绝不损坏 `#1` 根会话的保护机制（前端禁用删除，后端 403 兜底）。
- 单测防死锁：所有测试显式声明 `{ timeout: 60_000 }`。
- 不引入重依赖，不破坏 Fast Refresh。

---

### Task 1: 隐藏空闲状态徽章与移除单条删除

**Files:**
- Modify: `packages/web/src/shell/Sidebar.tsx:58-64`
- Modify: `packages/web/src/shell/Sidebar.tsx:415-510`
- Modify: `packages/web/src/conversation/WorkbenchDrawer.tsx:55-65`
- Test: `packages/web/test/shell-modals.test.ts`

**Interfaces:**
- `StatusBadge({ conv }: { conv: ConversationSummary })`: 当 `conv.status === 'idle'` 时返回 `null`。
- `AgentConversationRow`: 移除 `HoverIconButton` 垃圾桶图标及 `removeConversation`。

- [ ] **Step 1: 修改 StatusBadge 隐藏空闲状态**
  在 `packages/web/src/shell/Sidebar.tsx` 中让 `StatusBadge` 在 `conv.status === 'idle'` 时直接返回 `null`。
  并在 `packages/web/src/conversation/WorkbenchDrawer.tsx` 中当 `child.status !== 'idle'` 时才渲染状态徽章。

- [ ] **Step 2: 移除 AgentConversationRow 中的单条删除按钮**
  在 `packages/web/src/shell/Sidebar.tsx` 中移除 `removeConversation` 函数及对应的删除按钮。

- [ ] **Step 3: 运行已有测试并验证基本修改**
  运行 `pnpm --filter @helm/web test` 确保无已有测试被破坏。

- [ ] **Step 4: 提交 Task 1 代码**
  ```bash
  git commit -m "feat(web): 会话列表隐藏空闲状态徽章并移除单条删除按钮"
  ```

---

### Task 2: 注册图标与实现批量选择状态/判断逻辑 (Model)

**Files:**
- Modify: `packages/web/src/lib/icons.tsx`
- Modify: `packages/web/src/shell/sidebar-model.ts`
- Test: `packages/web/test/shell-modals.test.ts`

**Interfaces:**
- `isConversationDeletable(conv: ConversationSummary): boolean`
  - 输入：`conv` 会话摘要
  - 返回：若 `conv.id === 1` 或 `conv.ownedBy !== 'human'` 返回 `false`，否则返回 `true`。
- `filterDeletableConversations(conversations: ConversationSummary[]): ConversationSummary[]`
- `HelmIcon name="check-square"`: 注册 Lucide `CheckSquare` 图标。

- [ ] **Step 1: 在 `icons.tsx` 中引入并注册 `CheckSquare` 图标**
  从 `lucide-react` 导入 `CheckSquare`，并在 `ICON_MAP` 中注册 `'check-square': CheckSquare`。

- [ ] **Step 2: 编写 `isConversationDeletable` 测试**
  在 `packages/web/test/shell-modals.test.ts` 中添加测试：
  - 测试 `#1`（ROOT_CONVERSATION_ID）返回 `false`
  - 测试 `ownedBy: 'bot'` 返回 `false`
  - 测试普通人类会话返回 `true`

- [ ] **Step 3: 在 `sidebar-model.ts` 中实现 `isConversationDeletable` 与 `filterDeletableConversations`**
  导出纯函数实现并使 Step 2 的单测通过。

- [ ] **Step 4: 运行单测确认通过**
  运行 `pnpm --filter @helm/web test`。

- [ ] **Step 5: 提交 Task 2 代码**
  ```bash
  git commit -m "feat(web): 注册 check-square 图标并实现会话可删除性判断函数"
  ```

---

### Task 3: 侧边栏批量管理与批量删除交互实现

**Files:**
- Modify: `packages/web/src/shell/Sidebar.tsx`
- Modify: `packages/web/src/styles.css`
- Test: `packages/web/test/shell-modals.test.ts`

**Interfaces:**
- 批量模式入口：侧栏智能体分组头部提供「批量管理」按钮（`check-square` 图标，点击切换 `batchMode`）。
- 批量操作栏组件 `BatchActionBar`：
  - `已选 N 项`
  - `全选` / `清空`
  - `删除所选 (N)`（点击触发二次确认并批量调用 `conversationsApi.remove`）
  - `退出`
- 会话行复选框：批量模式下在会话项左侧展示复选框，可删除会话支持勾选，不可删除会话置灰并带提示。
- 活跃会话保护：若被删除的会话包含当前正在查看的会话，自动安全重定向至 `#1` 根会话。

- [ ] **Step 1: 在 `styles.css` 中添加批量工具栏样式**
  添加 `.sidebar-batch-bar` 等紧凑现代样式，支持深浅色模式。

- [ ] **Step 2: 在 `Sidebar.tsx` 中实现批量管理状态与组件**
  - 在 `AgentStandingsGroup` 或 `Sidebar` 顶层提供 `batchMode`、`selectedIds`、`setBatchMode` 等状态支持。
  - 渲染 `BatchActionBar`，实现全选、取消选择、批量删除（含二次确认弹窗和 `store.pushNotice`）。
  - 在 `AgentConversationRow` 与常驻 Agent 行中添加复选框与行点击选中逻辑。

- [ ] **Step 3: 编写/更新批量删除前端交互与回归测试**
  在 `packages/web/test/shell-modals.test.ts` 中增加针对批量选择状态和删除重定向逻辑的测试用例。

- [ ] **Step 4: 运行测试确保全部通过**
  ```bash
  pnpm --filter @helm/web test
  ```

- [ ] **Step 5: 提交 Task 3 代码**
  ```bash
  git commit -m "feat(web): 侧边栏支持会话批量选择与批量删除"
  ```

---

### Task 4: 全局构建、类型检查与全套测试验证

**Files:**
- 全局检验

- [ ] **Step 1: 运行构建与类型检查**
  ```bash
  pnpm build && pnpm typecheck
  ```

- [ ] **Step 2: 运行全量测试套件**
  ```bash
  pnpm test
  ```

- [ ] **Step 3: 最终审查与验收确认**
  确认代码符合 AGENTS.md 约定：无 Emoji、无静默降级、API/CLI 兼容性不受影响。
