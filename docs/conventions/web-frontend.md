# Web 前端设计系统与开发约定

编写、重构 Web 界面、新增主舞台/视图/弹窗/抽屉、排查移动端样式或字号问题时，必须先阅读并遵守本文。

## 1. 视图形态分级与职责边界（告别局促模态）

- **一级主舞台（Primary Stage）**：
  - 适用场景：会话（`conversation`）、通用视图（`screen`）、插件中心（`plugins`）及未来市场/资源大厅。
  - 特征：占满中央视口，响应式多列自适应卡片网格（Marketplace Grid），顶部集成检索框、多维分类切换与实时统计。
  - **严禁将海量项、多维检索、管理与市场类界面塞进居中模态弹窗中**（旧 860px 居中弹窗反模式彻底废弃）。
- **右侧深度配置抽屉（Slide-out Detail Drawer）**：
  - 适用场景：主舞台卡片点击后的深层详情、能力透视（Tools / Actions / Hooks 清单）、动态配置表单、设置面板扩展。
  - 尺寸契约：桌面端固定宽度 520px ~ 560px，固定贴附右侧全高展开；移动端（≤680px）自适应 100% 全宽。
  - 原语契约：基于 Radix `Dialog` 原语封装，支持 Escape 键退出、点击外部遮罩关闭与受管焦点圈定。
- **轻量居中模态（Centered Modal）**：
  - 仅限于轻量操作：危险二次确认、短表单创建、单一密钥/凭据录入、即时图片/Mermaid 预览。
  - 最大宽度克制在 480px ~ 640px，避免多层嵌套卡片与臃肿滚动条。

## 2. 设计系统原语与 CSS 架构

- **严禁大面积内联样式（`style={{ ... }}`）**：除极少数需要动态计算的尺寸/坐标外，所有排版、间距与颜色一律使用设计系统原语类与 CSS 变量。
- **核心布局与表单原语**：
  - 分栏结构：`.asset-modal-body` / `.modal-body-split`（两栏分屏）、`.asset-modal-list` / `.modal-sidebar`（标准 240px 侧栏）；
  - 列表项：`.list-item-btn`（标准行高与 hover/active 激活背景 `--nav-active-bg`）；
  - 平坦化区域：`.section-flat`、`.section-flat-header`、`.section-flat-title`（彻底移除嵌套卡片）；
  - 表单网格：`.form-grid`、`.form-grid-label`（两列弹性自适应，标签支持锁图标与必填星号）；
  - 空状态：`.empty-state`（线性矢量图标 + 居中说明文本）。
- **以 Radix UI 为唯一无头交互原语底座**：
  - 凡涉及浮层、对话框、下拉选择、标签页、气泡提示等复杂交互组件，**必须统一使用或封装 `packages/web/src/ui/` 下基于 `@radix-ui/react-*` 的公共原语**，严禁使用原生控件（如 `<select>`），严禁随意引入第三方重量级 UI 库：
    - **弹窗与抽屉（`Dialog` / `AlertDialog`）**：全屏抽屉与居中模态统一基于 `packages/web/src/ui/Dialog.tsx` 与 `AlertDialog.tsx`；
    - **下拉菜单（`Select`）**：**全仓严禁使用原生 `<select>`**，统一使用 `packages/web/src/ui/Select.tsx`（高度统一 30px，字号 12px，无障碍 combobox 契约）；
    - **下拉与气泡（`DropdownMenu` / `Popover`）**：操作菜单与弹出浮层统一使用 `packages/web/src/ui/DropdownMenu.tsx` 与 `Popover.tsx`；
    - **标签页（`Tabs`）**：分段控制与视图切换统一使用 `packages/web/src/ui/Tabs.tsx`；
    - **轻量提示（`Tooltip`）**：悬浮说明统一使用 `packages/web/src/ui/Tooltip.tsx`；
    - **开关与勾选（`Switch` / `Checkbox`）**：布尔值与启停控制统一使用 `packages/web/src/ui/Switch.tsx` 与 `Checkbox.tsx`。
  - **严禁手写简陋交互浮层**：严禁用原生 `div` + `position: absolute` + 随意 `onClick` 拼凑浮层，杜绝缺乏键盘无障碍（WAI-ARIA）、Focus Trap 焦点逃逸、Escape 键无法退出与遮罩穿透问题。
  - **SSR 与单元测试防破裂契约**：所有基于 Radix 的封装原语必须保证在 Node / SSR（`renderToString`）测试环境下可用（统一采用 `typeof window === 'undefined'` 或 `inline` 属性降级直接渲染 children，避免 Portal 导致测试断言拿到空 DOM）。

## 3. 字体层次与移动端响应式规范

- **极简紧凑的字体阶梯**：
  - 主文本与输入框：`13px` / `14px`；
  - 辅助文本与表单标签：`12px`；
  - 状态徽章与胶囊计数：`11px`；
  - 面板与分组标题：`13px` / `14px`（粗体）；
  - 顶栏与主舞台大标题：`15px` / `16px`。
- **移动端与分屏字号铁律**：
  - 严禁任何输入框（`<input>` / `<textarea>`）在移动端或分屏宽度下字体突兀放大或失真；必须严格保持与全局紧凑克制的设计层次一致；
  - 移动端通过精确的 CSS 规则覆盖，消除平台默认放大渲染异常。
- **移动端响应式断点（`@media (max-width: 680px)`）**：
  - 弹窗与抽屉在移动端必须 `width: 100vw; max-width: 100vw; left: 0; right: 0;` 自适应全宽；
  - 头部容器必须配置 `flex-wrap: wrap`，标题截断保底，右上角关闭按钮绝对可用；
  - 操作按钮组折行到底部或自适应排列，禁止溢出视口产生横向滚动条。

## 4. UI 极简零 Emoji 铁律

- Web 界面与所有插件 UI 遵循极简克制风格，**严禁在界面文案、左栏导航项、分组标题、按钮、状态徽章或卡片中使用任何 Emoji 表情图标**；
- 图标统一使用 `lucide-react` 线性矢量图标（通过 `HelmIcon` 组件）或纯文本排版。

## 5. 组件生命周期与 Fast Refresh

- `.tsx` 文件**只导出 React 组件与 TypeScript 类型**；
- 纯数据转换、枚举映射、排序与过滤纯函数，必须剥离到单独的 `*-model.ts` 文件中；
- 异步数据加载（如配置读取、远程状态）必须引入代数竞争保护（`loadGeneration.current += 1`），避免切换目标后旧请求结果反向覆盖新状态。
