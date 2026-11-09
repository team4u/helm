# 工作流节点无折叠直出与子代理卡片统一规范

## 1. 目标与背景

在现有的工作流卡片（`WorkflowRunCard`）中，各个节点被包裹在折叠手风琴（`WorkflowNodeRow`）内，带有展开/收起箭头图标。用户必须手动点击展开才能看到节点内的 `SubagentLiveCard` 及其第 2 层流动副栏。

本规范彻底消除工作流节点的折叠外壳，将工作流内的子代理节点直接以扁平双层胶囊卡（`SubagentLiveCard`）形态渲染，实现最外层实时直出流动状态与数据。

---

## 2. 交互与布局契约

### 2.1 子代理节点（`node.conversationId !== undefined`）
- **直接直出**：在所属阶段组下方直接渲染为 [`SubagentLiveCard`](file:///root/code/helm/packages/web/src/conversation/SubagentLiveCard.tsx)，不包裹带有 `chevron` 的手风琴按钮；
- **元数据贯通**：
  - 节点显示标签优先采用 `node.label`；
  - 关联的工作树（`node.worktree`）、耗时与执行状态（`toolStatus`）直接传递；
  - 若节点声明 Gate（`node.gate`）且已出结果，Gate 状态与错误摘要自然融入卡片副栏或紧凑底部；
- **交互契约**：点击卡片直接调用 `store.setActiveModal({ kind: 'conversation-drawer', conversationId })` 打开侧边抽屉。

### 2.2 动作节点（纯 `action` 节点，无子会话）
- **扁平双层胶囊**：采用与子代理卡片对齐的双层视觉结构：
  - 第 1 层：动作图标 +「动作」徽章 + 动作名称 + 状态徽章 + 耗时；
  - 第 2 层：执行产出摘要或 Gate 命令，出错时展示错误信息；
  - 全程零 `chevron` 折叠。

### 2.3 阶段分组（Phase Groups）
- 工作流卡片内部如果存在 `phases` 声明，阶段头部保留轻量序号和进度（例如 `1. 调研 (1/2)`）；
- 阶段下方直接平铺该阶段的子代理/动作卡片，多节点之间紧凑垂直排列（`gap: 8px`）。

---

## 3. 受影响文件清单

1. `packages/web/src/conversation/WorkflowRunCard.tsx`：
   - 移除 `WorkflowNodeRow` 中的外层折叠按钮与 `open` 状态管理；
   - 子代理节点直接渲染 `SubagentLiveCard`；
   - 动作节点拍平为无折叠的直接卡片。
2. `packages/web/src/styles.css`：
   - 移除手风琴折叠相关的多余样式，调整节点间距与工作流内部卡片对齐。
3. `packages/web/test/workflow-run-card.test.ts`：
   - 更新单测断言，验证不再渲染节点折叠箭头，最外层直接露出双层副栏和流式信息。

---

## 4. 验证标准

1. `pnpm typecheck` 全部通过。
2. `pnpm test` 全仓单元测试 100% 通过（2037+ 测试无失败）。
3. 工作流运行中，无需任何点击即可在最外层直接观察到子代理的实时 doing / 思考流与状态徽章。
