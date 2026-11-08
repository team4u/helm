# Mermaid 流程图暗黑模式深度适配设计

## 一、背景与问题

在 Helm Web 界面中，当切换至暗黑模式（`data-theme="dark"`）时，时间线中的 Mermaid 图表（如流程图、时序图、状态图等）以及全屏预览画板存在以下问题：
1. **写死浅色中性主题**：`MarkdownView.tsx` 与 `MermaidPreviewModal.tsx` 中硬编码了 `theme: 'neutral'`，输出的 SVG 包含大量纯白/浅灰填充与深色描边，在深黑背景（`#0f1012`）中极为刺眼不协调。
2. **缺乏主题响应联动**：`MermaidBlock` 的渲染 `useEffect` 仅监听 `[code]`，未订阅 `useHelmStore().theme`。当用户在侧栏或通过快捷键切换主题时，已渲染的图表无法即时重绘，只能保持旧主题。
3. **全屏预览背景脱节**：`MermaidPreviewModal` 的画布底色已为深色 `var(--bg)`，但内部直接承载了浅色 SVG，反差突兀。

## 二、目标与原则

1. **深度融入 Helm 设计系统**：暗色模式下的图表背景设为透明，节点填充色、描边色、字体、连线及强调色严格与 Helm CSS 变量（`--bg-subtle: #1c1f24`、`--border-strong: #343843`、`--fg: #ededec`、`--fg-muted: #92959c`、`--accent: #6b8afd`、`--font-sans`）对齐。
2. **即时无感联动**：监听全局 `theme`（`light` / `dark`），主题切换时防抖重新渲染 SVG，无需刷新页面。
3. **内联与全屏预览一致性**：内联 `MermaidBlock` 与全屏 `MermaidPreviewModal` 共享同一套配置与主题状态。
4. **遵守 UI 规范**：遵循极简克制风格，零 Emoji，保持线性和高对比度的清晰排版。

## 三、具体设计与实现

### 1. 抽取通用主题配置模块 (`mermaid-theme.ts`)

在 `packages/web/src/conversation/mermaid-theme.ts` 中封装 `getMermaidConfig(theme: 'light' | 'dark')`：

- **浅色模式**：
  - `theme: 'neutral'`
  - `themeVariables: { background: 'transparent', fontFamily: 'var(--font-sans)' }`
- **暗色模式**：
  - `theme: 'dark'`
  - `themeVariables`:
    - `darkMode: true`
    - `background: 'transparent'`
    - `fontFamily: 'var(--font-sans)'`
    - `mainBkg: '#1c1f24'`（对应 `var(--bg-subtle)`）
    - `nodeBorder: '#343843'`（对应 `var(--border-strong)`）
    - `primaryColor: '#1c1f24'`
    - `primaryBorderColor: '#343843'`
    - `primaryTextColor: '#ededec'`（对应 `var(--fg)`）
    - `lineColor: '#92959c'`（对应 `var(--fg-muted)`）
    - `textColor: '#ededec'`
    - `edgeLabelBackground: '#16181c'`（对应 `var(--bg-elevated)`）
    - **时序图 (Sequence) 变量**：
      - `actorBkg: '#1c1f24'`
      - `actorBorder: '#343843'`
      - `actorTextColor: '#ededec'`
      - `signalColor: '#92959c'`
      - `signalTextColor: '#ededec'`
      - `labelBoxBkgColor: '#1c1f24'`
      - `labelBoxBorderColor: '#343843'`
      - `labelTextColor: '#ededec'`
      - `loopTextColor: '#ededec'`
      - `noteBorderColor: '#343843'`
      - `noteBkgColor: '#16181c'`
      - `noteTextColor: '#ededec'`

### 2. 内联渲染组件 (`MarkdownView.tsx` -> `MermaidBlock`)

- 从 `useHelmStore()` 读取 `theme`。
- 将 `theme` 加入 `useEffect` 依赖项（`[code, theme]`）。
- 渲染前调用 `mermaid.initialize(getMermaidConfig(theme))`。
- 生成唯一 DOM ID 时带上主题与序列号前缀（例如 `helm-mermaid-${theme}-${seq}-${random}`），避免不同主题下的 SVG 缓存冲突。

### 3. 全屏预览弹窗 (`MermaidPreviewModal.tsx`)

- 支持感知当前主题；当在全屏弹窗开启状态下用户切换主题，或者打开弹窗时，弹窗自动根据当前主题渲染匹配的 SVG。
- 画布图层背景保持透明，直接透出 `modal-fullscreen-backdrop` 的全局背景色 `var(--bg)`。

### 4. 样式调整 (`styles.css`)

- 确保 `.mermaid-body` 与 `.mermaid-svg-host` 背景为 `transparent`。
- 确保 SVG 中的文字与连线在不同主题下均有足够对比度。

## 四、验证方案

1. **单测覆盖**：
   - 增加对 `getMermaidConfig` 的单元测试，验证浅色/暗色主题配置参数正确。
   - 验证 `MarkdownView` 与 `MermaidPreviewModal` 在主题切换时能正确传入并使用新的配置。
2. **端到端测试/手动体验**：
   - 在暗黑模式下渲染包含流程图（Flowchart）与时序图（Sequence Diagram）的 Markdown。
   - 检查图表节点背景、文字颜色、连线与标签是否与暗色背景融合。
   - 动态切换明暗模式，观察图表是否平滑重绘且无样式残留。
