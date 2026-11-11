# 会话列表空闲状态隐藏与批量删除设计规范

**日期**：2026-11-09  
**模块**：`@helm/web`  
**涉及文件**：
- `packages/web/src/shell/Sidebar.tsx`
- `packages/web/src/conversation/WorkbenchDrawer.tsx`
- `packages/web/src/lib/icons.tsx`
- `packages/web/src/styles.css`
- `packages/web/test/shell-modals.test.ts`

---

## 1. 目标与背景

1. **空闲状态隐藏**：在会话列表中，多数会话绝大部分时间都处于 `idle`（空闲）状态，一直展示灰色「空闲」徽章造成视觉干扰。修改为 `idle` 状态不展示任何徽章，仅展示非空闲状态（`working`、`blocked`、`done`、`error`）。
2. **移除单条删除**：为了防止在会话行悬停操作时误触删除，移除单行操作栏中的删除（垃圾桶）按钮，会话删除操作统一收敛为批量删除。
3. **新增批量选择与删除**：提供批处理模式，支持多选会话、全选可删除会话、二次确认并执行批量删除，同时自动处理活跃会话的回退保护与受控会话的不可删除限制。

---

## 2. 详细设计

### 2.1 会话状态徽章呈现
- 在 `packages/web/src/shell/Sidebar.tsx` 的 `StatusBadge` 组件中：
  ```tsx
  function StatusBadge({ conv }: { conv: ConversationSummary }) {
    if (conv.status === 'idle') return null
    return (
      <span className={conversationStatusBadgeClass(conv.status)} title={conv.doing ?? ''}>
        {conv.status === 'working' && conv.doing ? conv.doing : conversationStatusLabel(conv.status)}
      </span>
    )
  }
  ```
- 在 `packages/web/src/conversation/WorkbenchDrawer.tsx` 的独立子会话列表渲染中，同样增加 `child.status !== 'idle'` 条件保护，不展示空闲状态。
- `conversationStatusLabel` 和 `conversationStatusBadgeClass` 底层函数保留对 `idle` 的映射能力与已有单元测试。

### 2.2 移除单条删除
- 在 `packages/web/src/shell/Sidebar.tsx` 的 `AgentConversationRow` 组件中：
  - 移除单个 `HoverIconButton` 垃圾桶图标及点击触发的 `removeConversation`。
  - 行内悬停快捷操作仅保留「在右屏分屏打开」与「重命名会话」。

### 2.3 批量选择与批量删除

#### 2.3.1 批量模式状态管理
在 `Sidebar.tsx` 的 `AgentStandingsGroup`（或 `Sidebar` 顶层）管理批量模式状态：
```ts
const [batchMode, setBatchMode] = useState(false)
const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
const [deleting, setDeleting] = useState(false)
```

#### 2.3.2 会话删除权限与受保护判定
定义辅助函数判断会话是否允许被人类删除：
```ts
export function isConversationDeletable(conv: ConversationSummary): boolean {
  // 1) 根会话 #1 永远保护，不可删除
  if (conv.id === ROOT_CONVERSATION_ID) return false
  // 2) 仅人类拥有或管理的会话可直接删除，bot/插件托管的受保护会话不可删除
  if ((conv.ownedBy ?? 'human') !== 'human') return false
  return true
}
```

#### 2.3.3 UI 呈现与交互
1. **模式切换按钮**：
   - 在「智能体」分组头部（`sidebar-group-header`）增加一个操作按钮（图标 `check-square`），title="批量管理会话"。
   - 处于批量模式时高亮该按钮。
2. **批量操作工具栏**：
   - 处于 `batchMode` 时，在智能体列表上方展开紧凑的操作工具栏：
     - `已选 N 项` 文本展示；
     - `全选` / `清空` 按钮（仅全选当前列表中 `isConversationDeletable` 为 true 的会话）；
     - `删除所选 (N)` 危险操作按钮（红色，`disabled={selectedCount === 0 || deleting}`）；
     - `退出` 按钮（清空选择并关闭批量模式）。
3. **会话行 Checkbox**：
   - 批量模式下，在每个会话行（`AgentConversationRow` 以及单条常驻 Agent）左侧渲染复选框：
     - 若可删除，渲染可勾选的 `<input type="checkbox" ...>`；
     - 若不可删除（如 `#1`），渲染禁用状态的复选框并带有 `title="受保护会话不可删除"`；
     - 点击整行或点击复选框即可切换选中状态。
4. **批量删除执行流程**：
   - 用户点击「删除所选 (N)」时，弹出确认提示框（`window.confirm` 或内嵌确认）：确认后执行。
   - 并发执行：
     ```ts
     const ids = Array.from(selectedIds)
     const results = await Promise.allSettled(ids.map((id) => conversationsApi.remove(id)))
     ```
   - 统计成功与失败数量，调用 `store.pushNotice` 弹出通知。
   - 若当前激活的会话（`store.primaryTarget`）在此次被删除了，自动调用 `store.openTarget({ kind: 'conversation', conversationId: ROOT_CONVERSATION_ID })`，避免停留失效会话。
   - 退出批量管理模式或重置 `selectedIds`。

---

## 3. 测试与验证计划

1. **单元测试**：
   - 在 `packages/web/test/shell-modals.test.ts` 中新增/更新测试：
     - 测试 `isConversationDeletable` 逻辑（`ROOT_CONVERSATION_ID` 返回 false、`ownedBy: 'bot'` 返回 false、普通人类会话返回 true）。
     - 验证 `StatusBadge` 逻辑：`idle` 状态不输出内容，非 `idle` 正常输出。
2. **构建与类型检查**：
   - 运行 `pnpm --filter @helm/web build`、`pnpm --filter @helm/web typecheck` 和 `pnpm test`。
3. **端到端体验验证**：
   - 验证侧栏中空闲会话不再出现「空闲」徽章；
   - 验证会话项不再有单条删除按钮；
   - 验证点击「批量管理」能够多选、全选、取消选择，并能成功批量删除所选会话。
