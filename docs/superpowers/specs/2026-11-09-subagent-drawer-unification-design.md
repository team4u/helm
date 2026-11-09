# 子代理与工作流会话抽屉交互统一设计规范

## 1. 背景与现状

在现有 Web 控制台中，存在多处查看子代理会话的入口，但触发表现不一致：
- **工作流卡片（`WorkflowRunCard`）**：点击节点右侧的 `#{node.conversationId}` 按钮，触发的是左右并排分屏（`split: true`）；
- **子代理实时卡片（`SubagentLiveCard`）**：点击卡片主体，触发的是右侧滑出的会话抽屉（`conversation-drawer`）；
- **工作台任务抽屉（`WorkbenchDrawer`）**：在右侧工作台中点击工作流节点时触发分屏，并会触发 `maybeCollapseWorkbench` 强行收起工作台，打断了用户连续排查多个子任务的上下文；
- **移动端（Narrow Screen `<= 680px`）**：移动端宽度极为有限（375px~430px），分屏会导致主屏与分屏同时被严重挤压至不可用，急需收敛为单一的模态视图。

本规范确立全端统一的**右侧会话抽屉（Drawer Modal）**交互模型。

---

## 2. 核心架构与统一交互契约

### 2.1 触发行为彻底统一
系统内所有查看子代理/节点会话的主交互，一律触发统一的右侧抽屉模态框：

```
[触发源]
├── Workflow 节点行及其右侧 #{id} 按钮
├── 时间线 SubagentLiveCard 胶囊卡片主体
└── 工作台 (WorkbenchDrawer) 内的工作流节点与子代理卡片
            │
            ▼ (统一调用)
  store.setActiveModal({ kind: 'conversation-drawer', conversationId: targetId })
```

不再存在“部分入口静默分屏、部分入口开抽屉”的不对称行为。

### 2.2 工作台（Workbench）协同排查体验
- **层级与遮罩**：
  - 子会话抽屉 `ConversationDrawer`（`z-index: 69`）浮于工作台（`z-index: 60`）之上，并带有半透明背景遮罩（`z-index: 68`）。
- **保留工作台上下文**：
  - 在工作台内部点击子代理卡片或工作流节点时，**不再强行收起工作台**（移除或旁路会导致 `setWorkbenchOpen(false)` 的 `onNavigate` 行为）；
  - 用户查看完某个子代理会话后，按下 <kbd>Esc</kbd> 或点击遮罩关闭抽屉，工作台依然保持展开且保留在刚刚滚动的任务列表位置，支持连续逐项排查。

### 2.3 移动端与窄屏适配（`<= 680px`）
- **全屏覆盖**：在移动端媒体查询下，抽屉宽度自动扩展为 `100vw`，上下贴顶贴底（`inset: 0`），形成沉浸式二级页面。
- **顶栏操作净化**：
  - 移动端自动**隐藏「在分屏中查看」按钮**，避免用户在手机上误触导致屏幕破碎；
  - 顶栏保留显眼的高触控热区（`min-height: 44px`）「关闭」图标按钮，点击或手势均可快速退出。
- **微操舱适配**：底部输入框聚焦呼出软键盘时，页面自适应上推，保证打字与查看最新日志不被遮挡。

### 2.4 桌面端大屏进阶能力
桌面端大屏下，抽屉顶栏提供显式的进阶出口：
1. **「并在分屏中查看」**：关闭当前抽屉，并调用 `store.openTarget({ kind: 'conversation', conversationId }, { split: true })`，升格为左右对半分屏；
2. **「在主屏中打开」**：关闭当前抽屉，切为主路由全屏访问该会话；
3. **「关闭（<kbd>Esc</kbd>）」**：关闭抽屉，原地返回。

---

## 3. 受影响文件与改动清单

1. `packages/web/src/conversation/WorkflowRunCard.tsx`：
   - 将节点右侧 `#{node.conversationId}` 按钮的 `store.openTarget(..., { split: true })` 改造为调用 `store.setActiveModal({ kind: 'conversation-drawer', conversationId: node.conversationId })`；
   - 移除不必要的 `onNavigate?.()` 隐式收起工作台调用。
2. `packages/web/src/conversation/WorkbenchDrawer.tsx`：
   - 梳理工作流卡片与子代理卡片在工作台内的传递回调，确保点击子代理时工作台不被误关闭。
3. `packages/web/src/conversation/ConversationPane.tsx`：
   - 抽屉模式下顶栏的「在分屏中打开」按钮在移动端窄屏下添加 CSS 隐藏类（如 `hide-on-mobile` 或利用媒体查询）。
4. `packages/web/src/styles.css` & `packages/web/src/responsive.css`：
   - 优化移动端抽屉顶栏返回按钮的热区大小与内边距，确保触控体验符合规范。
5. `packages/web/test/` 单测：
   - 更新 `workflow-card-model.test.ts`、`subagent-live-card.test.ts` 相关断言，确保点击工作流子代理节点触发的是 `conversation-drawer` 模态而非分屏。

---

## 4. 验证标准

1. **类型检查与构建**：`pnpm typecheck` 零错误。
2. **自动化测试**：全仓单元测试 100% 通过（`pass 2025+`，`fail 0`）。
3. **交互验证**：
   - 桌面端：在时间线、工作流卡片、工作台任务列表中点击任何子代理，均统一滑出右侧抽屉；按 Esc 瞬间销单且工作台保持原位；
   - 移动端：模拟小屏尺寸（宽 375px），抽屉全宽展示，无分屏破碎，关闭按钮操作灵敏。
