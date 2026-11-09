# 会话列表状态圆点视觉升级实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将左栏会话列表中的会话状态由文字徽章重构为极简状态圆点加颜色区分，移除文字展示并保留悬停提示与微弱呼吸动效。

**Architecture:** 在 `sidebar-model.ts` 中增加状态圆点类名与悬浮提示生成的纯函数；在 `styles.css` 中定义状态圆点及脉冲动效样式；在 `Sidebar.tsx` 中将原本渲染文字的 `StatusBadge` 替换为无文字的 `ConversationStatusDot`。

**Tech Stack:** React 19, TypeScript, CSS3 Animations, Node.js Test Runner (`tsx --test`).

## Global Constraints

- 严禁在界面文案、左栏导航项、分组标题、按钮、状态徽章或卡片中使用任何 Emoji 表情图标；
- 遵循 Helm 极简克制（Quiet Surface）设计系统与零 Emoji 铁律；
- 单测显式声明 `{ timeout: 60_000 }`；
- 所有改动在 `/root/code/helm` 下进行，提交遵循中文 Conventional Commits。

---

### Task 1: 状态圆点纯函数逻辑与单元测试

**Files:**
- Modify: `packages/web/src/shell/sidebar-model.ts`
- Test: `packages/web/test/shell-modals.test.ts`

**Interfaces:**
- Produces:
  - `conversationStatusDotClass(status: ConversationSummary['status']): string | null`
  - `conversationStatusTooltip(status: ConversationSummary['status'], doing?: string): string`

- [ ] **Step 1: 编写失败的单元测试**

在 `packages/web/test/shell-modals.test.ts` 中引入新函数并添加测试：

```typescript
import {
  conversationStatusBadgeClass,
  conversationStatusDotClass,
  conversationStatusLabel,
  conversationStatusTooltip,
} from '../src/shell/sidebar-model.js'

test('conversationStatusDotClass 仅对非 idle 状态返回圆点类名', { timeout: 60_000 }, () => {
  assert.equal(conversationStatusDotClass('idle'), null)
  assert.equal(conversationStatusDotClass('working'), 'status-dot status-dot-working')
  assert.equal(conversationStatusDotClass('blocked'), 'status-dot status-dot-blocked')
  assert.equal(conversationStatusDotClass('done'), 'status-dot status-dot-done')
  assert.equal(conversationStatusDotClass('error'), 'status-dot status-dot-error')
})

test('conversationStatusTooltip 生成准确悬停提示', { timeout: 60_000 }, () => {
  assert.equal(conversationStatusTooltip('idle'), '空闲')
  assert.equal(conversationStatusTooltip('blocked'), '待确认')
  assert.equal(conversationStatusTooltip('done'), '已完成')
  assert.equal(conversationStatusTooltip('error'), '异常')
  assert.equal(conversationStatusTooltip('working'), '运行中')
  assert.equal(conversationStatusTooltip('working', '正在分析代码'), '运行中: 正在分析代码')
})
```

- [ ] **Step 2: 运行测试以确认失败**

Run: `timeout 30s npx tsx --test packages/web/test/shell-modals.test.ts`
Expected: FAIL（`conversationStatusDotClass is not a function`）

- [ ] **Step 3: 在 `sidebar-model.ts` 中实现最小代码**

在 `packages/web/src/shell/sidebar-model.ts` 导出：

```typescript
/** 会话状态圆点样式类：idle 状态返回 null（不显示圆点）。 */
export function conversationStatusDotClass(
  status: ConversationSummary['status'],
): string | null {
  if (status === 'idle') return null
  switch (status) {
    case 'working':
      return 'status-dot status-dot-working'
    case 'blocked':
      return 'status-dot status-dot-blocked'
    case 'done':
      return 'status-dot status-dot-done'
    case 'error':
      return 'status-dot status-dot-error'
    default:
      return 'status-dot'
  }
}

/** 会话状态悬浮提示文案。 */
export function conversationStatusTooltip(
  status: ConversationSummary['status'],
  doing?: string,
): string {
  const base = conversationStatusLabel(status)
  if (status === 'working' && doing?.trim()) {
    return `${base}: ${doing.trim()}`
  }
  return base
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `timeout 30s npx tsx --test packages/web/test/shell-modals.test.ts`
Expected: PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/web/src/shell/sidebar-model.ts packages/web/test/shell-modals.test.ts
git commit -m "feat(web): 新增会话状态圆点类名与悬停提示纯函数"
```

---

### Task 2: 状态圆点 CSS 样式及动效

**Files:**
- Modify: `packages/web/src/styles.css`

**Interfaces:**
- Produces: CSS classes `.status-dot`, `.status-dot-working`, `.status-dot-blocked`, `.status-dot-done`, `.status-dot-error`, `@keyframes status-dot-pulse`

- [ ] **Step 1: 在 `styles.css` 中添加状态圆点样式并清理旧样式**

在 `packages/web/src/styles.css` 中定义 `.status-dot` 相关样式：

```css
/* 会话状态圆点与呼吸动效 */
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-block;
  vertical-align: middle;
}

.status-dot-working {
  background: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-bg);
  animation: status-dot-pulse 1.8s ease-in-out infinite;
}

.status-dot-blocked {
  background: var(--warn);
  box-shadow: 0 0 0 2px var(--warn-bg);
}

.status-dot-done {
  background: var(--ok);
  box-shadow: 0 0 0 2px var(--ok-bg);
}

.status-dot-error {
  background: var(--err);
  box-shadow: 0 0 0 2px var(--err-bg);
}

@keyframes status-dot-pulse {
  0%, 100% {
    box-shadow: 0 0 0 1.5px var(--accent-bg);
    opacity: 0.85;
  }
  50% {
    box-shadow: 0 0 0 3.5px var(--accent-bg);
    opacity: 1;
  }
}
```

- [ ] **Step 2: 验证样式并检查 CSS 语法**

Run: `pnpm build:web` 或检查样式编译
Expected: PASS

- [ ] **Step 3: 提交代码**

```bash
git add packages/web/src/styles.css
git commit -m "style(web): 新增会话列表状态圆点与呼吸动效样式"
```

---

### Task 3: 重构 Sidebar.tsx 组件渲染状态圆点

**Files:**
- Modify: `packages/web/src/shell/Sidebar.tsx`
- Test: `packages/web/test/shell-modals.test.ts`

**Interfaces:**
- Consumes: `conversationStatusDotClass`, `conversationStatusTooltip` from `sidebar-model.ts`
- Modifies: `StatusBadge` -> `ConversationStatusDot` (不输出文字，仅渲染 `<span className={dotClass} title={tooltip} role="status" aria-label={tooltip} />`)

- [ ] **Step 1: 更新 `Sidebar.tsx`**

将 `Sidebar.tsx` 中的 `StatusBadge` 组件改写为状态圆点：

```tsx
function ConversationStatusDot({ conv }: { conv: ConversationSummary }) {
  const dotClass = conversationStatusDotClass(conv.status)
  if (!dotClass) return null
  const tooltip = conversationStatusTooltip(conv.status, conv.doing)
  return (
    <span
      className={dotClass}
      title={tooltip}
      aria-label={tooltip}
      role="status"
    />
  )
}
```

替换 `AgentStandingItem`、`AgentConversationRow` 与 `ConversationRow` 中的 `<StatusBadge conv={...} />` 为 `<ConversationStatusDot conv={...} />`。

- [ ] **Step 2: 运行测试**

Run: `timeout 30s npx tsx --test packages/web/test/shell-modals.test.ts`
Expected: PASS

- [ ] **Step 3: 提交代码**

```bash
git add packages/web/src/shell/Sidebar.tsx
git commit -m "feat(web): 侧栏会话列表状态改为颜色圆点展示"
```

---

### Task 4: 全量类型检查与回归测试验收

**Files:**
- Test: 全仓单测与类型检查

- [ ] **Step 1: 运行 TypeScript 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0，无任何类型错误

- [ ] **Step 2: 运行全量单元测试**

Run: `pnpm test`
Expected: 1945+ tests 全部 pass，0 failures

- [ ] **Step 3: 最终验证与核对**
核对侧栏会话列表中文字徽章已完全移除，仅剩状态圆点；无 Emoji，符合项目铁律。
