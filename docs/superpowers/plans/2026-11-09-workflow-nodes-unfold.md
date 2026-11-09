# 工作流节点无折叠直出实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 彻底移除工作流节点外层的手风琴折叠壳与 chevron 箭头，让子代理节点直接以 SubagentLiveCard 扁平双层胶囊卡直出流动状态与数据。

**Architecture:** 
1. 节点层级拍平：移除 `WorkflowNodeRow` 外层的折叠按钮与 `openNodes` 状态，对 `node.conversationId !== undefined` 的节点直接渲染 `SubagentLiveCard`。
2. 动作节点扁平化：无会话的动作节点同样渲染为双层扁平胶囊，第 1 层为名称与状态，第 2 层为产出预览。
3. 样式与测试对齐：清理折叠相关样式，更新单测断言。

**Tech Stack:** React 19, TypeScript, CSS Variables, tsx runner (`pnpm test`).

## Global Constraints

- 严禁在界面文案、图标、状态徽章中使用任何 Emoji 表情字符，统一使用 `lucide-react`。
- 遵循极简克制交互设计，单测声明 `{ timeout: 60_000 }`。
- 遵循 Conventional Commits 中文提交信息，不添加 `Co-Authored-By`。
- 在 `/root/code/helm` 下工作，修改必须保持全仓构建与单测通过。

---

### Task 1: 重构 `WorkflowRunCard.tsx` 消除节点外层折叠

**Files:**
- Modify: `packages/web/src/conversation/WorkflowRunCard.tsx`
- Modify: `packages/web/src/styles.css`
- Test: `packages/web/test/workflow-run-card.test.ts`

**Interfaces:**
- Consumes: `WorkflowNodeState`, `SubagentLiveCard`
- Produces: 工作流节点直接平铺直出，最外层包含双层副栏，不再包含折叠箭头。

- [ ] **Step 1: 编写测试断言**
在 `packages/web/test/workflow-run-card.test.ts` 中增加针对无折叠箭头的断言：
```ts
test('SSR：工作流节点无折叠手风琴壳，最外层直接直出 SubagentLiveCard 与实时副栏', { timeout: 60_000 }, () => {
  const html = renderCard(HELLO_RUN, { conversations: [summary(11, 'done', 1), summary(12, 'done', 1)] })
  assert.ok(html.includes('subagent-live-card'), '应直接在最外层直出 SubagentLiveCard')
  assert.ok(!html.includes('workflow-node-line'), '不得再渲染带点击折叠的 workflow-node-line 按钮')
})
```

- [ ] **Step 2: 运行测试验证失败**
Run: `pnpm --filter @helm/web test packages/web/test/workflow-run-card.test.ts`
Expected: FAIL 提示依然包含了 `workflow-node-line`。

- [ ] **Step 3: 修改 `WorkflowRunCard.tsx` 实现**
修改 `packages/web/src/conversation/WorkflowRunCard.tsx`：
1. 移除 `openNodes` 状态与 `toggleNode`；
2. 对于 `node.conversationId !== undefined`，直接渲染 `SubagentLiveCard`（附带 Gate 与错误展示）；
3. 对于纯 action 节点，直接渲染扁平双层展示。

- [ ] **Step 4: 运行测试验证通过**
Run: `pnpm --filter @helm/web test packages/web/test/workflow-run-card.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交更改**
```bash
git add packages/web/src/conversation/WorkflowRunCard.tsx packages/web/src/styles.css packages/web/test/workflow-run-card.test.ts
git commit -m "feat(web): 重构工作流节点为直接直出形态并消除手风琴折叠"
```

---

### Task 2: 全仓验证与推送

**Files:**
- Test: 全仓构建与测试

- [ ] **Step 1: 执行全仓类型检查**
Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 2: 执行全仓自动化测试**
Run: `timeout 180s pnpm test`
Expected: PASS（2037+ 测试无失败）。

- [ ] **Step 3: 推送至远端仓库**
Run: `git push origin main`
Expected: 成功推送。
