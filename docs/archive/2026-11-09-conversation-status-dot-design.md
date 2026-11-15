# 会话列表状态圆点视觉升级设计文档

- **创建日期**：2026-11-09
- **状态**：已批准 (Approved)
- **范围**：`packages/web`（侧边栏会话列表状态展示）

## 1. 背景与目标

当前 Helm Web 界面左侧栏的会话列表（包括智能体站位行、历史会话子列表、插件分组会话列表）使用带文字的圆角徽章展示会话状态（如“运行中”、“待确认”、“已完成”、“异常”）。
文字徽章在侧栏狭窄的元数据区中占据较宽宽度，容易造成视觉噪点，且与会话编号 `#id`、远端节点标识及悬停操作按钮挤占空间。

**目标**：
- 将会话列表的状态从文字徽章改为极简克制的状态圆点（Status Dot）和语义颜色来区分状态，完全移除文字展示；
- 空闲（`idle`）状态不显示任何圆点，保持列表整洁；
- 运行中（`working`）状态提供极微弱的呼吸动效（pulse halo），增强即时感知；
- 保留辅助提示（Tooltip / `title`），鼠标悬停圆点时显示具体状态名称以及 `conv.doing` 实时详情；
- 遵循 Helm 极简克制（Quiet Surface）与零 Emoji 铁律。

## 2. 状态映射与视觉规范

### 2.1 状态与颜色规范

| 会话状态 (`conv.status`) | 呈现策略 | 圆点背景色 (`background`) | 外发光圈 (`box-shadow`) | 动效 | 悬浮 Tooltip 格式 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `idle` (空闲) | 不渲染 | - | - | 无 | - |
| `working` (运行中) | 渲染圆点 | `var(--accent)` | `0 0 0 2px var(--accent-bg)` | 1.8s 微弱呼吸动效 | `运行中` 或 `运行中: {doing}` |
| `blocked` (待确认) | 渲染圆点 | `var(--warn)` | `0 0 0 2px var(--warn-bg)` | 无 (静止) | `待确认` |
| `done` (已完成) | 渲染圆点 | `var(--ok)` | `0 0 0 2px var(--ok-bg)` | 无 (静止) | `已完成` |
| `error` (异常) | 渲染圆点 | `var(--err)` | `0 0 0 2px var(--err-bg)` | 无 (静止) | `异常` |

### 2.2 CSS 类设计

在 `packages/web/src/styles.css` 中定义：

```css
/* 状态圆点基础样式 */
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-block;
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

同时清理旧的 `.agent-standing .nav-item-meta .badge` 宽度截断限制。

## 3. 代码变更与组件结构

### 3.1 纯逻辑模型 (`packages/web/src/shell/sidebar-model.ts`)
- 新增纯函数 `conversationStatusDotClass(status: ConversationSummary['status']): string | null`：
  - `idle` 返回 `null`；
  - 其余状态返回 `'status-dot status-dot-<status>'`。
- 新增纯函数 `conversationStatusTooltip(status: ConversationSummary['status'], doing?: string): string`：
  - 生成悬浮提示，格式如 `运行中: {doing}` 或状态中文标签。
- 保留现有的 `conversationStatusLabel` 和 `conversationStatusBadgeClass`，保持其他潜在消费者或测试的兼容。

### 3.2 界面组件 (`packages/web/src/shell/Sidebar.tsx`)
- 将现有的 `StatusBadge` 重构为 `StatusDot` / `ConversationStatusDot`：
  - 若状态为 `idle` 或类名为 `null`，返回 `null`；
  - 渲染 `<span className={dotClass} title={tooltip} aria-label={tooltip} role="status" />`；
- 在以下三个会话入口保留位置：
  1. `AgentStandingItem`（未折叠且存在主会话时）；
  2. `AgentConversationRow`（历史会话子列表）；
  3. `ConversationRow`（插件自定义 section 列表）。

## 4. 测试与验证

1. **单元测试 (`packages/web/test/shell-modals.test.ts`)**：
   - 验证 `conversationStatusDotClass` 对五种状态的输出（`idle` 为 null，其余返回对应 class）；
   - 验证 `conversationStatusTooltip` 生成正确的提示文案（含 `doing` 拼接）；
   - 确保原有 `conversationStatusLabel` 契约仍满足。
2. **全仓测试运行**：
   - 执行 `pnpm test` 和 `pnpm typecheck`，确认全部通过。
