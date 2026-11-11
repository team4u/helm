# Web 前端设计系统与开发约定

编写或重构 Web 界面、新增主舞台/视图/弹窗/抽屉，或排查移动端样式与字号问题时，必须先阅读并遵守本文。

## 1. 视图形态分级与职责边界

界面按信息量与操作复杂度分为三档。选择哪一档不是审美问题，而是硬性契约：海量内容禁止进入居中模态。

### 一级主舞台（Primary Stage）

- 适用场景：会话（`conversation`）、通用视图（`screen`）、插件中心、应用中心等管理与市场类界面。
- 形态：占满中央视口，响应式多列自适应卡片网格（Marketplace Grid），顶部集成检索框、多维分类切换与实时统计。
- **严禁将海量项、多维检索、管理与市场类界面塞进居中模态弹窗**（旧 860px 居中弹窗反模式已彻底废弃）。

### 右侧深度配置抽屉（Slide-out Detail Drawer）

- 适用场景：主舞台卡片点击后的深层详情、能力透视（Tools / Actions / Hooks 清单）、动态配置表单与设置面板扩展。
- 尺寸契约：桌面端固定宽度 520px~560px，贴右侧全高展开；移动端（≤680px）自适应 100% 全宽。
- 实现契约：基于 `packages/web/src/ui/` 的 Radix `Dialog` 原语封装，支持 Escape 退出、点击遮罩关闭与受管焦点圈定。

### 轻量居中模态（Centered Modal）

- 仅限轻量操作：危险二次确认、短表单创建、单一密钥/凭据录入、即时图片或 Mermaid 预览。
- 最大宽度克制在 480px~640px，避免多层嵌套卡片与臃肿滚动条。

## 2. 设计系统原语与 CSS 架构

- **严禁大面积内联样式（`style={{ ... }}`）**：除极少数动态计算的尺寸/坐标外，排版、间距与颜色一律使用设计系统原语类与 CSS 变量。
- 核心布局与表单原语：
  - 分栏结构：`.asset-modal-body` / `.modal-body-split`（两栏分屏）、`.asset-modal-list` / `.modal-sidebar`（标准 240px 侧栏）；
  - 列表项：`.list-item-btn`（标准行高与 hover/active 激活背景 `--nav-active-bg`）；
  - 平坦化区域：`.section-flat`、`.section-flat-header`、`.section-flat-title`（移除嵌套卡片）；
  - 表单网格：`.form-grid`、`.form-grid-label`（两列弹性自适应，标签支持锁图标与必填星号）；
  - 空状态：`.empty-state`（线性矢量图标 + 居中说明文本）；
  - 通用表格原语：`.helm-table-wrap` / `.table-wrap` 与 `.helm-table` / `.table`（统一 8px 10px 内边距、12.5px 字体、`border-collapse: collapse`、表头背景 `var(--bg-subtle)`、`tr:hover`、`.table-actions` 与 `.table-empty`）；
  - 插件页面与分节原语：`.screen-container`（统一内边距与纵向滚动）、`.screen-header` / `.screen-title` / `.screen-subtitle`、`.screen-section` / `.screen-section-title`；
  - 键值概览原语：`.kv-grid` / `.kv-list`（两列自适应）、`.kv-key`、`.kv-val`；
  - 提示横幅原语：`.callout`（`.callout-warn` / `.callout-error` / `.callout-ok`，统一边框、浅色背景与圆角）；
  - 加载中原语：`.loading-state`。
- **强制样式复用铁律（杜绝各车间私有复制）**：
  - **全仓所有内置插件与外部插件必须优先复用主框架设计系统原语**，严禁在插件内私自复制通用表格、通用页面布局、通用键值列表或通用提示条样式；
  - 仅限插件独有的特异性业务结构（如 Mermaid 图表缩放画布、Workflow DAG 执行图卡片、Apps 启动台卡片网格）允许在插件 client CSS 内编写专属规则；所有通用排版与组件样式必须统一收敛在主框架中，确保全平台视觉与交互风格绝对统一。

### Radix UI 唯一无头交互原语底座

凡涉及浮层、对话框、下拉选择、标签页、气泡提示等复杂交互组件，**必须统一使用 `packages/web/src/ui/` 下基于 `@radix-ui/react-*` 的公共原语**，严禁使用原生控件，严禁引入第三方重量级 UI 库：

- **弹窗与抽屉（`Dialog` / `AlertDialog`）**：全屏抽屉与居中模态统一基于 `ui/Dialog.tsx` 与 `AlertDialog.tsx`；
- **下拉选择（`Select`）**：**全仓严禁使用原生 `<select>`**，统一使用 `ui/Select.tsx`（高度统一 30px，字号 12px，无障碍 combobox 契约）；
- **下拉菜单与气泡（`DropdownMenu` / `Popover`）**：操作菜单与弹出浮层统一使用对应封装；
- **标签页（`Tabs`）**：分段控制与视图切换统一使用 `ui/Tabs.tsx`；
- **轻量提示（`Tooltip`）**：悬浮说明统一使用 `ui/Tooltip.tsx`；
- **开关与勾选（`Switch` / `Checkbox`）**：布尔值与启停控制统一使用对应封装。

**严禁手写简陋交互浮层**：不得用原生 `div` + `position: absolute` + 随意 `onClick` 拼凑浮层，杜绝缺乏键盘无障碍（WAI-ARIA）、Focus Trap 焦点逃逸、Escape 无法退出与遮罩穿透问题。

**SSR 与单元测试防破裂契约**：所有 Radix 封装原语必须保证在 Node / SSR（`renderToString`）测试环境下可用——统一以 `typeof window === 'undefined'` 或 `inline` 属性降级直接渲染 children，避免 Portal 导致测试断言拿到空 DOM。

## 3. 字体层次与移动端响应式规范

### 极简紧凑的字体阶梯

| 用途 | 字号 |
| :--- | :--- |
| 主文本与输入框 | 13px / 14px |
| 辅助文本与表单标签 | 12px |
| 状态徽章与胶囊计数 | 11px |
| 面板与分组标题 | 13px / 14px（粗体） |
| 顶栏与主舞台大标题 | 15px / 16px |

### 移动端与分屏字号铁律

- 严禁任何输入框（`<input>` / `<textarea>`）在移动端或分屏宽度下字号突兀放大或失真，必须保持与全局紧凑层次一致；
- 通过精确的 CSS 规则覆盖，消除平台默认的点击放大渲染异常。

### 移动端响应式断点（`@media (max-width: 680px)`）

- 弹窗与抽屉必须 `width: 100vw; max-width: 100vw; left: 0; right: 0;` 自适应全宽；
- 头部容器必须配置 `flex-wrap: wrap`，标题截断保底，右上角关闭按钮绝对可用；
- 操作按钮组折行到底部或自适应排列，禁止溢出视口产生横向滚动条。

## 4. UI 极简零 Emoji 铁律

Web 界面与所有插件 UI 遵循极简克制风格，**严禁在界面文案、左栏导航项、分组标题、按钮、状态徽章或卡片中使用任何 Emoji 表情图标**。图标统一使用 `lucide-react` 线性矢量图标（经 `HelmIcon` 组件）或纯文本排版。

## 5. 组件生命周期与 Fast Refresh

- `.tsx` 文件**只导出 React 组件与 TypeScript 类型**；
- 纯数据转换、枚举映射、排序与过滤纯函数必须剥离到单独的 `*-model.ts` 文件；
- 异步数据加载（配置读取、远程状态等）必须引入代数竞争保护（`loadGeneration.current += 1`），避免切换目标后旧请求结果反向覆盖新状态。
