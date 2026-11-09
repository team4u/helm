# 子代理与工作流会话抽屉交互统一实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将工作流卡片节点子代理查看入口与时间线/工作台统一为“右侧滑出抽屉（ConversationDrawer）”，并在工作台排查时不关闭工作台，在手机移动端提供 100vw 全屏和无分屏的纯净体验。

**Architecture:** 
1. 交互入口统一：`WorkflowRunCard` 中的节点 `#{id}` 按钮统一调用 `store.setActiveModal({ kind: 'conversation-drawer', conversationId })`，彻底废弃默认分屏触发。
2. 工作台排查协同：在工作台打开子会话抽屉时不调用关闭工作台的回调，抽屉浮在工作台上方，关闭抽屉后无缝保持工作台列表滚动上下文。
3. 移动端与响应式适配：抽屉在 `<= 680px` 全宽 100vw，顶栏隐藏“分屏查看”按钮并优化关闭返回热区。

**Tech Stack:** React 19, TypeScript, CSS Variables, tsx runner (`pnpm test`).

## Global Constraints

- 严禁在界面文案、图标、状态徽章中使用任何 Emoji 表情字符，统一使用 `lucide-react`。
- 遵循极简克制与受控中文交互设计，单测声明 `{ timeout: 60_000 }`。
- 遵循 Conventional Commits 中文提交信息，不添加 `Co-Authored-By`。
- 在 `/root/code/helm` 下工作，修改必须保持全仓构建与单测通过。

---

### Task 1: 统一工作流卡片节点子会话入口为抽屉模态

**Files:**
- Modify: `packages/web/src/conversation/WorkflowRunCard.tsx`
- Test: `packages/web/test/workflow-run-card.test.ts`

**Interfaces:**
- Consumes: `store.setActiveModal({ kind: 'conversation-drawer', conversationId: number })`
- Produces: 点击节点右侧 `#{id}` 胶囊触发 `conversation-drawer` 抽屉，不再触发 `split: true`，且不触发会导致工作台收起的 `onNavigate?.()`。

- [ ] **Step 1: 编写测试断言**
在 `packages/web/test/workflow-run-card.test.ts` 中增加针对节点子会话抽屉入口文案与属性的断言：
```ts
test('SSR：agent 节点 conversationId 渲染子会话抽屉入口与阶段分组标题栏', { timeout: 60_000 }, () => {
  const html = renderCard(HELLO_RUN, { conversations: [summary(11, 'done', 1), summary(12, 'done', 1)] })
  assert.ok(html.includes('#11'), '应渲染子会话快捷入口 #11')
  assert.ok(html.includes('打开子会话抽屉 #11'), '应提示打开子会话抽屉而非分屏')
  assert.ok(html.includes('workflow-phase-header'), '应渲染阶段分组小标题栏')
  assert.ok(html.includes('workflow-node-duration'), '应渲染节点耗时')
})
```

- [ ] **Step 2: 运行测试验证失败**
Run: `pnpm --filter @helm/web test packages/web/test/workflow-run-card.test.ts`
Expected: FAIL 提示找不到 `打开子会话抽屉 #11`。

- [ ] **Step 3: 修改 `WorkflowRunCard.tsx` 实现**
修改 `packages/web/src/conversation/WorkflowRunCard.tsx`：
```tsx
          {node.conversationId !== undefined ? (
            <span
              className="btn btn-ghost btn-sm"
              role="button"
              title={`打开子会话抽屉 #${node.conversationId}`}
              onClick={(e) => {
                e.stopPropagation()
                store.setActiveModal({ kind: 'conversation-drawer', conversationId: node.conversationId! })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation()
                  store.setActiveModal({ kind: 'conversation-drawer', conversationId: node.conversationId! })
                }
              }}
            >
              {`#${node.conversationId}`}
            </span>
          ) : null}
```

- [ ] **Step 4: 运行测试验证通过**
Run: `pnpm --filter @helm/web test packages/web/test/workflow-run-card.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交更改**
```bash
git add packages/web/src/conversation/WorkflowRunCard.tsx packages/web/test/workflow-run-card.test.ts
git commit -m "feat(web): 统一工作流节点子会话入口为抽屉模态"
```

---

### Task 2: 保持工作台内连续排查上下文（不被点击打断）

**Files:**
- Modify: `packages/web/src/conversation/WorkbenchDrawer.tsx`
- Test: `packages/web/test/workflow-run-card.test.ts`

**Interfaces:**
- Consumes: `WorkbenchDrawer` 内部的 `WorkflowRunCard` 与 `SubagentLiveCard`。
- Produces: 点击工作台内的卡片打开子代理抽屉时，不调用 `maybeCollapseWorkbench(store)`；仅在真正需要切换主屏路由时才收起工作台。

- [ ] **Step 1: 编写测试断言**
检查并确认工作台内部的子代理卡片与工作流卡片在打开抽屉时不会强制派发收起事件。
在 `packages/web/test/workflow-run-card.test.ts` 中验证 `inWorkbench` 下的节点点击属性正确。

- [ ] **Step 2: 运行测试验证基准状态**
Run: `pnpm --filter @helm/web test packages/web/test/workflow-run-card.test.ts`
Expected: PASS。

- [ ] **Step 3: 修改 `WorkbenchDrawer.tsx` 实现**
在 `packages/web/src/conversation/WorkbenchDrawer.tsx` 中：
`WorkflowRunCard` 与 `SubagentLiveCard` 传递给子项的导航行为仅打开抽屉模态，不强行将工作台设置关闭，移除无意义的 `onNavigate={() => maybeCollapseWorkbench(store)}`（或将其隔离给仅非抽屉的跳转场景）。

- [ ] **Step 4: 运行测试验证**
Run: `pnpm --filter @helm/web test packages/web/test/workflow-run-card.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交更改**
```bash
git add packages/web/src/conversation/WorkbenchDrawer.tsx
git commit -m "fix(web): 在工作台内打开子会话抽屉时不强制收起工作台"
```

---

### Task 3: 移动端与窄屏适配（隐藏分屏按钮与触控优化）

**Files:**
- Modify: `packages/web/src/conversation/ConversationPane.tsx`
- Modify: `packages/web/src/styles.css`
- Modify: `packages/web/src/responsive.css`
- Test: `packages/web/test/mobile-modals.test.ts`

**Interfaces:**
- Consumes: `.conversation-drawer-split-btn`, `.conversation-drawer-close-btn`
- Produces: 窄屏下 `@media (max-width: 680px)` 自动隐藏分屏按钮，关闭按钮保持至少 44px 触控高热区。

- [ ] **Step 1: 编写测试验证断言**
在 `packages/web/test/mobile-modals.test.ts` 中增加针对移动端媒体查询规则或抽屉类名的单测断言：
```ts
test('移动端响应式样式包含子会话抽屉全宽与分屏按钮隐藏规则', { timeout: 60_000 }, () => {
  const css = readFileSync('packages/web/src/responsive.css', 'utf-8')
  assert.ok(css.includes('.conversation-drawer-split-btn'), '应包含隐藏抽屉分屏按钮规则')
  assert.ok(css.includes('.conversation-drawer'), '应包含抽屉移动端规则')
})
```

- [ ] **Step 2: 运行测试验证失败**
Run: `pnpm --filter @helm/web test packages/web/test/mobile-modals.test.ts`
Expected: FAIL 提示缺少 `.conversation-drawer-split-btn`。

- [ ] **Step 3: 修改代码与样式**
1. 在 `packages/web/src/conversation/ConversationPane.tsx` 中为抽屉的“并在分屏中查看”按钮加上 `conversation-drawer-split-btn` 类名，为“关闭”按钮加上 `conversation-drawer-close-btn` 类名。
2. 在 `packages/web/src/responsive.css` 中在 `@media (max-width: 680px), (pointer: coarse)` 下增加：
```css
  .conversation-drawer-split-btn { display: none !important; }
  .conversation-drawer-close-btn { min-height: 44px; min-width: 44px; }
```

- [ ] **Step 4: 运行测试验证通过**
Run: `pnpm --filter @helm/web test packages/web/test/mobile-modals.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交更改**
```bash
git add packages/web/src/conversation/ConversationPane.tsx packages/web/src/styles.css packages/web/src/responsive.css packages/web/test/mobile-modals.test.ts
git commit -m "style(web): 优化子代理会话抽屉在移动端的响应式与触控体验"
```

---

### Task 4: 全仓类型检查与端到端自动化测试

**Files:**
- Test: 全仓单测与构建

- [ ] **Step 1: 执行全仓类型检查**
Run: `pnpm typecheck`
Expected: PASS（构建成功，无类型报错）。

- [ ] **Step 2: 执行全仓自动化测试**
Run: `timeout 180s pnpm test`
Expected: PASS（2025+ 测试全部通过，0 failed）。

- [ ] **Step 3: 推送至远程仓库**
Run: `git push origin main`
Expected: 成功推送。
