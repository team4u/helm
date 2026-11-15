# Helm Web UI 样式系统对齐 Magpie 设计文档

- **创建日期**：2026-11-11
- **状态**：已批准 (Approved)
- **目标范围**：`packages/web/src/styles.css` 及 `responsive.css`
- **核心约束**：
  1. **纯样式改动**：不修改任何组件的 TypeScript / React 业务逻辑与 Props；
  2. **零 Emoji 铁律**：全界面严禁 Emoji，仅使用文本与 lucide-react 线性矢量图标；
  3. **单元测试防破裂**：保持 `@helm/web` 现有 801 个单元测试 100% 通过。

---

## 1. 目标与视觉原则

参考上级目录 `magpie`（`internal/gui/assets/app.css`）的设计精髓，将 Helm 的 Web 前端重塑为具备 **macOS HIG / 精致桌面原生 App 级质感（Quiet Surface）** 的现代极简控制台界面：

- **沉静纸面与低反光石墨**：浅色模式采用冷纸灰底色 `#f4f4f6` 搭配纯白卡片与淡分割线；深色模式采用深石墨色 `#1a1a1e` 搭配低饱和表面。
- **克制精巧的尺寸阶梯**：基础控件统一收敛在 `27px ~ 28px` 高度与 `12.5px` 字号阶梯，告别大面积松散粗重的 Web 控件。
- **标志性微质感原语**：
  - 分段控制器（Segmented Control）采用无边框凹陷轨与带苹果高精投影的 Thumb；
  - 滑动开关（Switch）采用极简墨黑/暖白（`var(--fg)`）反色开启质感；
  - 弹出层（Popover / Select Content）采用 24px 毛玻璃与超精细外发丝线投影。

---

## 2. 设计 Token 与调色板系统（Tokens & Palette）

### 2.1 浅色模式（Light Theme）
```css
:root,
:root[data-theme='light'] {
  color-scheme: light;
  --bg: #f4f4f6;
  --bg-elevated: #ffffff;
  --bg-subtle: #f9f9fb;
  --bg-inset: var(--bg-subtle);
  --bg-muted: #f1f1f4;
  --bg-hover: #e9e9ee;
  --bg-active: rgba(28, 28, 33, 0.08);
  --bg-backdrop: rgba(0, 0, 0, 0.28);

  --fg: #1c1c21;
  --fg-secondary: #4b4b53;
  --fg-muted: #85858d;
  --fg-subtle: #b9b9c2;
  --fg-on-solid: #ffffff;

  --border: #e3e3e8;
  --border-strong: #d0d0d6;
  --border-focus: #4f46e5;
  --line-2: #ececf0;

  /* 分段控制器与导航滑轨阴影 */
  --seg-track: #e6e6eb;
  --seg-thumb: #ffffff;
  --seg-edge: 0 1px 2px rgba(0, 0, 0, 0.14), 0 0 0 0.5px rgba(0, 0, 0, 0.08);

  /* 侧栏选中项 */
  --nav-active-bg: var(--bg-elevated);
  --nav-active-fg: var(--fg);
  --nav-active-muted: var(--fg-muted);

  /* 主强调色与语义指示色 */
  --accent: #4f46e5;
  --accent-bg: #eeedfd;
  --accent-border: rgba(79, 70, 229, 0.25);

  --ok: #189a58;
  --ok-bg: #e4f6ec;
  --ok-border: rgba(24, 154, 88, 0.24);

  --warn: #b45309;
  --warn-bg: #fbf0df;
  --warn-border: rgba(180, 83, 9, 0.24);

  --err: #d64545;
  --err-bg: #fbe9e9;
  --err-border: rgba(214, 69, 69, 0.24);

  /* 阴影层次 */
  --shadow-sm: 0 1px 1px rgba(0, 0, 0, 0.04);
  --shadow-md: 0 2px 8px rgba(20, 22, 30, 0.06), 0 0 0 0.5px rgba(20, 22, 30, 0.1);
  --shadow-lg: 0 16px 44px rgba(20, 22, 30, 0.16), 0 2px 8px rgba(20, 22, 30, 0.06), 0 0 0 0.5px rgba(20, 22, 30, 0.1);
  --pop-bg: rgba(255, 255, 255, 0.94);
}
```

### 2.2 深色模式（Dark Theme）
```css
:root[data-theme='dark'] {
  color-scheme: dark;
  --bg: #1a1a1e;
  --bg-elevated: #232327;
  --bg-subtle: #1f1f23;
  --bg-inset: var(--bg-subtle);
  --bg-muted: #2d2d33;
  --bg-hover: #36363d;
  --bg-active: rgba(255, 255, 255, 0.09);
  --bg-backdrop: rgba(0, 0, 0, 0.55);

  --fg: #ededf1;
  --fg-secondary: #b9b9c1;
  --fg-muted: #8b8b94;
  --fg-subtle: #56565f;
  --fg-on-solid: #14142a;

  --border: #333339;
  --border-strong: #404048;
  --border-focus: #a5b4fc;
  --line-2: #2c2c32;

  --seg-track: rgba(255, 255, 255, 0.035);
  --seg-thumb: rgba(255, 255, 255, 0.15);
  --seg-edge: inset 0 0.5px 0 rgba(255, 255, 255, 0.08), 0 1px 2px rgba(0, 0, 0, 0.3);

  --nav-active-bg: rgba(255, 255, 255, 0.08);
  --nav-active-fg: var(--fg);
  --nav-active-muted: var(--fg-muted);

  --accent: #a5b4fc;
  --accent-bg: #2b2c47;
  --accent-border: rgba(165, 180, 252, 0.3);

  --ok: #6fd99b;
  --ok-bg: #1e3a2b;
  --ok-border: rgba(111, 217, 155, 0.28);

  --warn: #f2b544;
  --warn-bg: #3f3220;
  --warn-border: rgba(242, 181, 68, 0.3);

  --err: #f28b82;
  --err-bg: #45272a;
  --err-border: rgba(242, 139, 130, 0.3);

  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.28);
  --shadow-md: 0 4px 14px rgba(0, 0, 0, 0.4), 0 0 0 0.5px rgba(255, 255, 255, 0.08);
  --shadow-lg: 0 16px 44px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.3), 0 0 0 0.5px rgba(255, 255, 255, 0.1);
  --pop-bg: rgba(38, 38, 43, 0.96);
}
```

### 2.3 字体与字阶契约
- **无衬线字体栈**：`-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", system-ui, sans-serif`
- **等宽代码字体栈**：`ui-monospace, "SF Mono", Menlo, Monaco, Consolas, "Cascadia Mono", monospace`
- **字号阶梯**：
  - 大标题/主舞台顶栏：`15px` / `16px`（粗体）；
  - 列表行标题/弹窗标题：`13px` / `13.5px`（粗体）；
  - 核心控件（输入框、Select、按钮、分段选择）：统一为 **`12.5px`**；
  - 描述正文/表单标签：`12px`；
  - 次级辅助文本/Meta 信息：`11px` ~ `11.5px`；
  - 徽章/状态标签/计数胶囊：`10.5px` ~ `11px`（强制 `font-variant-numeric: tabular-nums`）。

---

## 3. 基础控件规范（Form Controls & Primitives）

### 3.1 按钮（Buttons）
1. **次级/默认按钮 (`.btn`)**：
   - 高度 `27px`，内边距 `0 10px`，圆角 `6px`，字号 `12.5px`，字重 `500`；
   - 底色 `var(--bg-elevated)`，边框 `1px solid var(--border)`，微阴影 `0 1px 1px rgba(0,0,0,.04)`；
   - Hover 时边框加深至 `--fg-muted`，底色切为 `--bg-subtle`，文字变 `--fg`。
2. **主要操作按钮 (`.btn-primary`)**：
   - 高度 `27px`，无边框，底色 `var(--accent)`，文字 `#ffffff`（深色 `#14142a`）；
   - Hover 时微调 `filter: brightness(1.08)`。
3. **幽灵/文本按钮 (`.btn-ghost`)**：
   - 高度 `27px`，透明底，无边框，默认色 `--fg-secondary`，Hover 时浮现 `--bg-muted`。
4. **危险按钮 (`.btn-danger`)**：
   - 底色 `var(--err-bg)`，文字 `var(--err)`，无粗边框，Hover 时底色加深。
5. **紧凑图标按钮 (`.icon-btn`, `.composer-icon-button`)**：
   - 尺寸 `26px × 26px`，圆角 `7px`，颜色 `--fg-muted`，Hover 为 `--bg-muted` + `--fg`。

### 3.2 输入框与搜索栏（Inputs & Search）
1. **通用输入框 (`input[type="text"]`, `input[type="password"]`, `.input`)**：
   - 高度收敛为 `27px`，内边距 `0 9px`，圆角 `7px`，字号 `12.5px`；
   - 边框 `1px solid var(--border)`，底色 `var(--bg-elevated)`；
   - 聚焦态：`border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);`。
2. **搜索输入框（`.search-input`）**：
   - 高度 `28px`，圆角 `8px`，背景 `var(--bg-muted)`，无默认边框；
   - 聚焦态：背景切为纯卡片色并向外泛开 Indigo 光晕。

### 3.3 下拉选择器（Select - Radix UI 原语封装）
1. **触发器 (`.helm-select-trigger`)**：
   - 高度 `27px`（紧凑 sm 为 `24px`），内边距 `0 8px 0 9px`，圆角 `7px`，字号 `12.5px`；
   - 边框 `1px solid var(--border)`，微投影 `0 1px 1px rgba(0,0,0,0.04)`；
   - 右侧 Chevron 图标展开时平滑旋转 180°。
2. **下拉浮层 (`.helm-select-popover`)**：
   - 边框 `1px solid var(--border)`，投影 `var(--shadow-lg)`，圆角 `11px`，内边距 `4px`；
   - 背景采用毛玻璃 `background: var(--pop-bg); backdrop-filter: blur(24px);`；
   - 下拉选项 (`.helm-select-option`) 高度 `28px`，圆角 `6px`，字号 `12.5px`。

### 3.4 开关（Switch）与复选框（Checkbox）
1. **滑动开关 (`.helm-switch`)**：
   - 尺寸 `28px × 16px`，圆角 `10px`，无边框，未开启底色为 `--border`；
   - **开启态底色**：标志性墨黑色 `var(--fg)`；
   - 圆点滑块：`12px × 12px` 纯白小球，带 `box-shadow: 0 1px 2px rgba(0,0,0,0.25)`，开启向右平滑位移 `12px`。
2. **复选框 (`.helm-checkbox`)**：
   - 尺寸 `15px × 15px`，圆角 `4px`，边框 `1px solid var(--border-strong)`；
   - 选中态：底色 `var(--fg)`，对勾图标 `var(--bg-elevated)`。

### 3.5 分段控制器（SegmentedControl & Tabs）
1. **分段控制器 (`.segmented-control`)**：
   - 滑轨无边框，内嵌浅灰轨 `background: var(--seg-track)`，圆角 `7px`，内边距 `2px`；
   - 滑块项 (`.segmented-control-btn`) 高度 `24px`，内边距 `0 12px`，字号 `12.5px`；
   - 激活态浮起为 `var(--seg-thumb)`，叠加微发丝边缘阴影 `var(--seg-edge)`。

---

## 4. 结构性容器与布局（Containers & Structure）

### 4.1 列表卡片与行间发丝线
- 外层卡片 (`.card`, `.list`, `.section-flat`)：圆角 `12px`，边框 `1px solid var(--border)`；
- 列表内部行间分割：去除外边距堆叠，统一通过 `border-top: 1px solid var(--line-2)` 发丝线分割；
- 列表行高收敛至 `44px ~ 48px`，左右内边距 `12px ~ 14px`。

### 4.2 弹窗与抽屉（Modals & Drawers）
- 遮罩层：`background: rgba(0, 0, 0, 0.28); backdrop-filter: blur(8px) saturate(1.1);`；
- 居中模态：圆角 `14px`，投影为 Magpie 经典大深影 `box-shadow: 0 0 0 1px var(--border), 0 24px 60px rgba(0, 0, 0, .32), 0 2px 8px rgba(0, 0, 0, .12);`；
- 右侧 520px 详情抽屉：全高平滑滑出，左侧边框 `1px solid var(--border)`。

### 4.3 侧栏（Sidebar）
- 顶栏高度 `46px`，底部通过 `1px solid var(--line-2)` 分割；
- 导航项高 `28px ~ 30px`，字号 `12.5px ~ 13px`；
- 激活态：浅色采用带微边缘发丝阴影的纯白卡片（`background: var(--bg-elevated); box-shadow: var(--seg-edge)`），深色采用微透石墨光。

### 4.4 滚动条（Overlay Scrollbars）
- 细胶囊滑块：宽度/高度 `8px`，透明槽；
- 居中 4px 悬浮条效果（`background-clip: padding-box`），悬停变深为 `--fg-muted`。

---

## 5. 验证与回归保证

- 运行 `pnpm --filter @helm/web test` 确保 801 个测试全数通过；
- 构建与类型检查 `pnpm build && pnpm typecheck` 验证零语法与资源引用错误；
- 在浅色与深色模式下分别验证控件、弹窗、下拉、开关的一致性。
