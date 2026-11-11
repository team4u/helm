# Helm Web UI 样式对齐 Magpie 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Helm Web UI 样式系统（颜色、字号阶梯、阴影、圆角、表单原语、弹窗抽屉、分段控制器与开关）全面对齐 Magpie 桌面客户端质感，保持 100% 纯 CSS 改造与零业务逻辑改动。

**Architecture:** 在 `packages/web/src/styles.css` 中原位替换设计系统根变量（Tokens）并重构 Radix UI 交互原语与通用布局样式规则，辅以 `packages/web/test/design-system-primitives.test.ts` 进行样式规格与回归断言，确保 801 个测试持续通过。

**Tech Stack:** CSS (CSS Variables, Flexbox, Grid, Backdrop-Filter), React 19, Radix UI Primitives, TypeScript, Node.js Test Runner (`tsx --test`).

## Global Constraints

- 纯样式改动，严禁修改任何组件的 TypeScript / React 业务逻辑与 Props；
- 零 Emoji 铁律：全界面仅使用纯文本与 `lucide-react` 线性矢量图标；
- 基础控件（输入框、按钮、Select 触发器）统一收敛至 `27px ~ 28px` 高度与 `12.5px` 字阶；
- 开关（Switch）开启态使用极简墨黑/暖白（`var(--fg)`）；
- 所有改动必须通过 `pnpm --filter @helm/web test` 保持 100% 测试通过。

---

### Task 1: 基础设计 Token 与调色板重置

**Files:**
- Modify: `packages/web/src/styles.css:10-120`
- Modify: `packages/web/test/design-system-primitives.test.ts`

**Interfaces:**
- Produces: CSS Variables `--bg: #f4f4f6`, `--bg-elevated: #ffffff`, `--bg-subtle: #f9f9fb`, `--bg-muted: #f1f1f4`, `--fg: #1c1c21`, `--border: #e3e3e8`, `--line-2: #ececf0`, `--accent: #4f46e5`, `--seg-track`, `--seg-thumb`, `--seg-edge`, `--pop-bg` 及深色模式配对变量。

- [ ] **Step 1: 编写设计系统 Token 的单测断言**

在 `packages/web/test/design-system-primitives.test.ts` 中添加对 Magpie 核心变量存在性与色值的断言：

```typescript
test('styles.css 包含 Magpie 基础调色板与分段控制器变量', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const css = fs.readFileSync(path.resolve(__dirname, '../src/styles.css'), 'utf-8')

  assert.match(css, /--bg:\s*#f4f4f6;/)
  assert.match(css, /--fg:\s*#1c1c21;/)
  assert.match(css, /--accent:\s*#4f46e5;/)
  assert.match(css, /--line-2:\s*#ececf0;/)
  assert.match(css, /--seg-track:\s*#e6e6eb;/)
  assert.match(css, /--seg-thumb:\s*#ffffff;/)
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter @helm/web test`
Expected: FAIL（未找到 `--bg: #f4f4f6` 等变量）

- [ ] **Step 3: 更新 `packages/web/src/styles.css` 根部 Tokens**

将 `:root, :root[data-theme='light']` 与 `:root[data-theme='dark']` 替换为 Magpie 的精确色值与投影变量，包含字体栈 `--font-sans` 和 `--font-mono`。

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm --filter @helm/web test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/styles.css packages/web/test/design-system-primitives.test.ts
git commit -m "style(web): 更新基础设计 Token 与调色板对齐 Magpie"
```

---

### Task 2: 按钮系统与图标交互控件对齐

**Files:**
- Modify: `packages/web/src/styles.css:2220-2260` 及相关按钮样式规则
- Test: `packages/web/test/design-system-primitives.test.ts`

**Interfaces:**
- Produces: `.btn` (27px, 6px radius, 微阴影), `.btn-primary` (27px, Indigo 无边框), `.btn-ghost`, `.btn-danger`, `.icon-btn`, `.composer-icon-button`.

- [ ] **Step 1: 编写按钮样式规范的单测断言**

在 `packages/web/test/design-system-primitives.test.ts` 中添加对按钮核心尺寸的正则校验：

```typescript
test('styles.css 按钮系统高度收敛至 27px 且主要按钮无粗外框', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const css = fs.readFileSync(path.resolve(__dirname, '../src/styles.css'), 'utf-8')

  assert.match(css, /\.btn\s*\{[^}]*height:\s*27px;/)
  assert.match(css, /\.btn\s*\{[^}]*border-radius:\s*6px;/)
  assert.match(css, /\.btn-primary\s*\{[^}]*background:\s*var\(--accent\);/)
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter @helm/web test`
Expected: FAIL

- [ ] **Step 3: 重写 `styles.css` 中的按钮类**

更新 `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-danger`, `.icon-btn`, `.composer-icon-button`, `.btn-send`：高度统一为 `27px`（或微调至 Magpie 标准），默认按钮带微投影 `0 1px 1px rgba(0,0,0,.04)`，主要按钮使用 `var(--accent)` 无边框。

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm --filter @helm/web test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/styles.css packages/web/test/design-system-primitives.test.ts
git commit -m "style(web): 重构按钮系统与图标按钮样式对齐 Magpie"
```

---

### Task 3: 表单输入框、搜索栏与 Radix Select 下拉组件对齐

**Files:**
- Modify: `packages/web/src/styles.css:1350-1650, 2570-2610`
- Test: `packages/web/test/design-system-primitives.test.ts`

**Interfaces:**
- Produces: `.input`, `input[type="text"]`, `textarea`, `.search-input`, `.helm-select-trigger` (27px, 7px radius, 12.5px font), `.helm-select-popover` (blur 24px, 11px radius), `.helm-select-option` (28px height).

- [ ] **Step 1: 编写输入框与 Select 尺寸规则测试**

在 `packages/web/test/design-system-primitives.test.ts` 中添加断言：

```typescript
test('styles.css 输入框与 Select 触发器收敛至 27px 与 7px 圆角', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const css = fs.readFileSync(path.resolve(__dirname, '../src/styles.css'), 'utf-8')

  assert.match(css, /\.helm-select-trigger\s*\{[^}]*height:\s*27px;/)
  assert.match(css, /\.helm-select-trigger\s*\{[^}]*border-radius:\s*7px;/)
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter @helm/web test`
Expected: FAIL

- [ ] **Step 3: 更新 `styles.css` 表单与 Select 样式规则**

将 `.helm-select-trigger`, `.input`, `input[type="text"]`, `input[type="password"]` 高度更新为 `27px`，圆角设为 `7px`，字号为 `12.5px`；设置 `.helm-select-popover` 背景为 `var(--pop-bg)` 与 `backdrop-filter: blur(24px)`；调整聚焦外光晕为 `color-mix(in srgb, var(--accent) 22%, transparent)`。

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm --filter @helm/web test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/styles.css packages/web/test/design-system-primitives.test.ts
git commit -m "style(web): 统一输入框与下拉选择器为 27px 紧凑质感"
```

---

### Task 4: 滑动开关 Switch、复选框 Checkbox 与分段控制器 SegmentedControl

**Files:**
- Modify: `packages/web/src/styles.css:1725-1820, 3750-3795`
- Test: `packages/web/test/design-system-primitives.test.ts`

**Interfaces:**
- Produces: `.helm-switch` (28x16, ink on-state, 12px white thumb), `.helm-checkbox` (15x15), `.segmented-control` (track, 24px button, seg-edge shadow).

- [ ] **Step 1: 编写开关与分段控制器测试断言**

在 `packages/web/test/design-system-primitives.test.ts` 中添加断言：

```typescript
test('styles.css 开关开启态为墨黑色且分段控制器具备 Magpie 投影', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const css = fs.readFileSync(path.resolve(__dirname, '../src/styles.css'), 'utf-8')

  assert.match(css, /\.helm-switch\.is-checked\s*\{[^}]*background:\s*var\(--fg\);/)
  assert.match(css, /\.segmented-control\s*\{[^}]*background:\s*var\(--seg-track\);/)
  assert.match(css, /var\(--seg-edge\)/)
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter @helm/web test`
Expected: FAIL

- [ ] **Step 3: 更新 `styles.css` 中的 Switch 与 SegmentedControl**

1. `.helm-switch`：移除边框，未开启底色为 `var(--border)`，开启底色为 `var(--fg)`；thumb 尺寸 `12px × 12px`，位移 `12px`；
2. `.segmented-control`：移除外边框，背景使用 `var(--seg-track)`，圆角 `7px`；`.segmented-control-btn` 高度 `24px`，选中态叠加 `box-shadow: var(--seg-edge)`。

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm --filter @helm/web test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/styles.css packages/web/test/design-system-primitives.test.ts
git commit -m "style(web): 对齐 Magpie 极简滑动开关与分段控制器"
```

---

### Task 5: 列表卡片、行发丝线、居中弹窗、详情抽屉与全局滚动条

**Files:**
- Modify: `packages/web/src/styles.css:270-360, 2360-2430, 4150-4220` 等
- Test: `packages/web/test/design-system-primitives.test.ts`

**Interfaces:**
- Produces: `.card` / `.list` (12px radius), `.row + .row` / `.list-item-btn` (44-48px min-height, border-top 1px solid var(--line-2)), `.dialog-content` (14px radius, 0 0 0 1px var(--border), 0 24px 60px rgba(0,0,0,.32)), 8px overlay scrollbars.

- [ ] **Step 1: 编写列表卡片与弹窗样式的单测断言**

在 `packages/web/test/design-system-primitives.test.ts` 中添加断言：

```typescript
test('styles.css 弹窗具备 14px 圆角与 Magpie 大深影，滚动条采用 8px 胶囊', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const css = fs.readFileSync(path.resolve(__dirname, '../src/styles.css'), 'utf-8')

  assert.match(css, /\.dialog-content\s*\{[^}]*border-radius:\s*14px;/)
  assert.match(css, /::-webkit-scrollbar\s*\{[^}]*width:\s*8px;/)
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter @helm/web test`
Expected: FAIL

- [ ] **Step 3: 更新 `styles.css` 结构性组件与滚动条**

1. 将 `.card`, `.list`, `.section-flat` 圆角升级为 `12px`，行间分割引入 `1px solid var(--line-2)`；
2. 弹窗 `.dialog-content` 圆角更新为 `14px`，阴影对齐 `0 0 0 1px var(--border), 0 24px 60px rgba(0, 0, 0, 0.32), 0 2px 8px rgba(0, 0, 0, 0.12)`；遮罩增加 `backdrop-filter: blur(8px) saturate(1.1)`；
3. 左栏导航 `.nav-item` 激活态应用纯白卡片加 `--seg-edge` 边缘投影（深色为微透白光）；
4. WebKit 滚动条设置为 `width: 8px; height: 8px;`，滑块透明槽带 2px 间距。

- [ ] **Step 4: 运行全体测试验证通过**

Run: `pnpm --filter @helm/web test`
Expected: PASS (所有 801 个测试全部通过)

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/styles.css packages/web/test/design-system-primitives.test.ts
git commit -m "style(web): 完善列表发丝线、弹窗抽屉与内嵌滚动条"
```

---

### Task 6: 全局构建、全套测试与最终验证

- [ ] **Step 1: 运行全仓构建与类型检查**

Run: `pnpm build && pnpm typecheck`
Expected: 成功，零错误退出。

- [ ] **Step 2: 运行全仓测试**

Run: `pnpm test`
Expected: 所有测试套件全数通过。

- [ ] **Step 3: 最终状态检查与提交**

```bash
git status
```
