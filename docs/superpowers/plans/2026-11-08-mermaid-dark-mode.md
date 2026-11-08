# Mermaid 暗黑模式与主题联动实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Helm Web 前端的 Mermaid 图表提供与系统设计系统深度对齐的暗黑模式，并实现随主题切换即时无缝重绘。

**Architecture:** 抽离统一的 `mermaid-theme.ts` 配置工厂，在浅色模式下应用中性纸面风格、在暗黑模式下使用透明背景并精确映射 Helm 的冷灰与强调色变量；让 `MarkdownView`（内联展示）与 `MermaidPreviewModal`（全屏画板）订阅全局 store 的 `theme` 状态，在主题变更时调用带有主题签名的配置与 ID 重新渲染 SVG。

**Tech Stack:** React 19, TypeScript, Mermaid 12.2.0, Node.js test runner (`tsx --test`).

## Global Constraints

- 严禁在界面文案、按钮或卡片中使用任何 Emoji 表情图标；统一使用 lucide-react 线性矢量图标或纯文本。
- 工作目录必须为 `/root/code/helm`。
- 测试命令必须在 60 秒内完成，单测声明 `{ timeout: 60_000 }`。
- 遵循 Conventional Commits 中文提交信息。

---

### Task 1: 封装统一 Mermaid 主题配置模块与单元测试

**Files:**
- Create: `packages/web/src/conversation/mermaid-theme.ts`
- Test: `packages/web/test/mermaid-theme.test.ts`

**Interfaces:**
- Produces: `getMermaidConfig(theme: 'light' | 'dark'): MermaidConfig`

- [ ] **Step 1: 编写失败测试**

```typescript
// packages/web/test/mermaid-theme.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { getMermaidConfig } from '../src/conversation/mermaid-theme.js'

test('getMermaidConfig: 浅色模式返回 neutral 主题与透明背景', { timeout: 60_000 }, () => {
  const config = getMermaidConfig('light')
  assert.equal(config.theme, 'neutral')
  assert.equal(config.startOnLoad, false)
  assert.equal(config.suppressErrorRendering, true)
  assert.equal(config.themeVariables?.background, 'transparent')
  assert.equal(config.themeVariables?.darkMode, false)
})

test('getMermaidConfig: 暗黑模式返回 dark 主题并精确映射 Helm 调色板', { timeout: 60_000 }, () => {
  const config = getMermaidConfig('dark')
  assert.equal(config.theme, 'dark')
  assert.equal(config.startOnLoad, false)
  assert.equal(config.suppressErrorRendering, true)
  assert.equal(config.themeVariables?.darkMode, true)
  assert.equal(config.themeVariables?.background, 'transparent')
  assert.equal(config.themeVariables?.primaryColor, '#1c1f24')
  assert.equal(config.themeVariables?.primaryBorderColor, '#343843')
  assert.equal(config.themeVariables?.primaryTextColor, '#ededec')
  assert.equal(config.themeVariables?.lineColor, '#92959c')
})
```

- [ ] **Step 2: 运行测试以确认失败**

Run: `npx tsx --test packages/web/test/mermaid-theme.test.ts`
Expected: FAIL，因为 `mermaid-theme.js` 尚未创建。

- [ ] **Step 3: 编写最小实现**

```typescript
// packages/web/src/conversation/mermaid-theme.ts
import type { MermaidConfig } from 'mermaid'

export function getMermaidConfig(theme: 'light' | 'dark'): MermaidConfig {
  const isDark = theme === 'dark'
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    fontFamily: 'var(--font-sans)',
    theme: isDark ? 'dark' : 'neutral',
    themeVariables: isDark
      ? {
          darkMode: true,
          background: 'transparent',
          fontFamily: 'var(--font-sans)',
          mainBkg: '#1c1f24',
          nodeBorder: '#343843',
          primaryColor: '#1c1f24',
          primaryBorderColor: '#343843',
          primaryTextColor: '#ededec',
          lineColor: '#92959c',
          textColor: '#ededec',
          edgeLabelBackground: '#16181c',
          actorBkg: '#1c1f24',
          actorBorder: '#343843',
          actorTextColor: '#ededec',
          signalColor: '#92959c',
          signalTextColor: '#ededec',
          labelBoxBkgColor: '#1c1f24',
          labelBoxBorderColor: '#343843',
          labelTextColor: '#ededec',
          loopTextColor: '#ededec',
          noteBorderColor: '#343843',
          noteBkgColor: '#16181c',
          noteTextColor: '#ededec',
        }
      : {
          darkMode: false,
          background: 'transparent',
          fontFamily: 'var(--font-sans)',
        },
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx tsx --test packages/web/test/mermaid-theme.test.ts`
Expected: PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/web/src/conversation/mermaid-theme.ts packages/web/test/mermaid-theme.test.ts
git commit -m "feat(web): 封装 Mermaid 浅色与暗黑模式配置生成模块"
```

---

### Task 2: 改造 `MarkdownView.tsx` 实现内联流程图的主题感知与动态重绘

**Files:**
- Modify: `packages/web/src/conversation/MarkdownView.tsx:49-115`
- Test: `packages/web/test/mermaid-theme.test.ts`

**Interfaces:**
- Consumes: `getMermaidConfig` 来自 `packages/web/src/conversation/mermaid-theme.ts`
- Consumes: `useHelmStore().theme` 来自 `packages/web/src/lib/HelmStoreProvider.tsx`

- [ ] **Step 1: 编写失败测试**

在 `packages/web/test/mermaid-theme.test.ts` 中增加对 `MarkdownView.tsx` 代码静态契约或行为验证：

```typescript
test('MarkdownView 源码契约：MermaidBlock 依赖 theme 并使用 getMermaidConfig', { timeout: 60_000 }, () => {
  const fs = await import('node:fs')
  const content = fs.readFileSync(new URL('../src/conversation/MarkdownView.tsx', import.meta.url), 'utf8')
  assert.match(content, /import\s*\{[^}]*getMermaidConfig[^}]*\}\s*from\s*['"]\.\/mermaid-theme(?:\.js)?['"]/)
  assert.match(content, /useHelmStore\(\)/)
  assert.match(content, /getMermaidConfig\(theme\)/)
})
```

- [ ] **Step 2: 运行测试以确认失败**

Run: `npx tsx --test packages/web/test/mermaid-theme.test.ts`
Expected: FAIL，因为 `MarkdownView.tsx` 尚未引用 `getMermaidConfig`。

- [ ] **Step 3: 修改 `MarkdownView.tsx`**

在 `packages/web/src/conversation/MarkdownView.tsx` 中：
1. 导入 `getMermaidConfig` 与 `useHelmStore`；
2. 在 `MermaidBlock` 中获取 `const { theme } = useHelmStore()`；
3. 将 `useEffect` 的依赖数组从 `[code]` 改为 `[code, theme]`；
4. 在异步渲染块中调用 `mermaid.initialize(getMermaidConfig(theme))`；
5. 生成唯一的 render id：`const id = \`helm-mermaid-\${theme}-\${seq}-\${Math.random().toString(36).slice(2, 8)}\``。

- [ ] **Step 4: 运行测试验证通过**

Run: `npx tsx --test packages/web/test/mermaid-theme.test.ts`
Expected: PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/web/src/conversation/MarkdownView.tsx packages/web/test/mermaid-theme.test.ts
git commit -m "feat(web): MarkdownView Mermaid 流程图订阅主题并即时重绘"
```

---

### Task 3: 改造 `MermaidPreviewModal.tsx` 全屏预览与样式微调

**Files:**
- Modify: `packages/web/src/conversation/MermaidPreviewModal.tsx`
- Modify: `packages/web/src/styles.css:1614-1667`
- Test: `packages/web/test/mermaid-theme.test.ts`

**Interfaces:**
- Consumes: `getMermaidConfig` 来自 `packages/web/src/conversation/mermaid-theme.ts`
- Consumes: `useHelmStore().theme` 来自 `packages/web/src/lib/HelmStoreProvider.tsx`

- [ ] **Step 1: 编写失败测试**

在 `packages/web/test/mermaid-theme.test.ts` 中增加对 `MermaidPreviewModal.tsx` 的静态契约验证：

```typescript
test('MermaidPreviewModal 源码契约：全屏画板支持主题重绘与透明图层', { timeout: 60_000 }, () => {
  const fs = await import('node:fs')
  const content = fs.readFileSync(new URL('../src/conversation/MermaidPreviewModal.tsx', import.meta.url), 'utf8')
  assert.match(content, /import\s*\{[^}]*getMermaidConfig[^}]*\}\s*from\s*['"]\.\/mermaid-theme(?:\.js)?['"]/)
  assert.match(content, /getMermaidConfig\(theme\)/)
})
```

- [ ] **Step 2: 运行测试以确认失败**

Run: `npx tsx --test packages/web/test/mermaid-theme.test.ts`
Expected: FAIL，因为 `MermaidPreviewModal.tsx` 尚未改造。

- [ ] **Step 3: 修改 `MermaidPreviewModal.tsx` 与 `styles.css`**

1. 在 `MermaidPreviewModal.tsx` 中引入 `useHelmStore` 和 `getMermaidConfig`；
2. 当 `theme` 发生变化时，如果用户在弹窗中，自动使用新主题重新渲染 SVG，或外层传入的 SVG 随主题刷新；
3. 在 `styles.css` 中确保 `.mermaid-body` 与 `.mermaid-svg-layer` 的背景色为透明，不产生白色底色覆盖。

- [ ] **Step 4: 运行测试验证通过**

Run: `npx tsx --test packages/web/test/mermaid-theme.test.ts packages/web/test/mobile-modals.test.ts`
Expected: PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/web/src/conversation/MermaidPreviewModal.tsx packages/web/src/styles.css packages/web/test/mermaid-theme.test.ts
git commit -m "feat(web): MermaidPreviewModal 支持暗黑模式全屏渲染与透明画布"
```

---

### Task 4: 全局测试与回归验证

**Files:**
- Test: `packages/web/test/*.test.ts`

- [ ] **Step 1: 运行 Web 包类型检查与所有相关测试**

Run: `pnpm --filter @helm/web typecheck`
Expected: PASS，零类型错误。

Run: `npx tsx --test packages/web/test/mermaid-theme.test.ts packages/web/test/mobile-modals.test.ts`
Expected: PASS，所有 Mermaid 相关单测通过。

- [ ] **Step 2: 提交最终成果**

```bash
git status
```
确认工作区干净，无未追踪或遗留临时文件。
