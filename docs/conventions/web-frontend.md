# Web 前端设计系统与开发约定

本文是 `@helmx/web` 与所有插件 `client.tsx` 前端代码的可执行贡献指南：编写或重构 Web 界面、新增主舞台/视图/弹窗/抽屉，或排查移动端样式与字号问题前，必须先阅读并遵守本文。五条硬铁律（零 Emoji、视图形态三级、Radix 唯一原语、唯一 Hash 导航、Fast Refresh）在仓库根 [AGENTS.md](../../AGENTS.md) 同步声明；导航与深链契约见[Web 导航与 URL Hash 约定](web-navigation.md)。

## 当前状态

Web 主控台基于 React 19 + Vite 6（`packages/web`），交互原语统一 Radix UI 封装，样式由 `src/styles.css` 聚合的 `src/styles/` 分片与 `src/responsive.css` 承载。本约定对内置界面与插件前端一体适用，违规会在代码评审被打回。

## 视图形态三级（硬契约）

界面按信息量与操作复杂度分三档。选择哪一档不是审美问题：海量内容禁止进入居中模态。

### 一级主舞台（Primary Stage）

- 适用：会话、插件 Screen、插件中心、模型/角色/技能/节点中心、应用中心等管理与市场类界面；
- 形态：占满中央视口，响应式多列自适应卡片网格，顶部集成检索框、多维分类切换与实时统计；
- **严禁将海量项、多维检索、管理与市场类界面塞进居中模态弹窗**。

### 右侧深度配置抽屉（Slide-out Detail Drawer）

- 适用：主舞台卡片点击后的深层详情、能力透视（Tools / Actions / Hooks 清单）、动态配置表单与设置面板扩展；
- 尺寸：桌面端固定宽度 520px~560px 贴右侧全高；移动端（≤680px）自适应 100% 全宽；
- 实现：基于 `@helmx/plugin-client` 的 Radix `Dialog` 原语封装，支持 Escape 退出、点击遮罩关闭与受管焦点圈定。

### 轻量居中模态（Centered Modal）

- 仅限轻量操作：危险二次确认、短表单创建、单一密钥/凭据录入、即时图片或 Mermaid 预览；
- 最大宽度克制在 480px~640px，避免多层嵌套卡片与臃肿滚动条。

## 设计系统原语与 CSS 架构

- **严禁大面积内联样式**（`style={{ ... }}`）：除极少数动态计算的尺寸/坐标外，排版、间距与颜色一律使用设计系统原语类与 CSS 变量；
- 常用通用类速查：分栏 `.modal-body-split` / `.modal-sidebar`；列表行 `.list-item-btn`；平坦分节 `.section-flat` 系列；表单 `.form-grid` / `.form-grid-label`；空状态 `.empty-state`；表格 `.helmx-table-wrap` / `.helmx-table`（统一内边距、12.5px 字体、表头 `var(--bg-subtle)`、`tr:hover`）；插件页面 `.screen-container` / `.screen-header` / `.screen-section`；键值 `.kv-grid` / `.kv-list`；提示横幅 `.callout`（`.callout-warn/-error/-ok`）；加载态 `.loading-state`；
- **插件布局原语组件**（`@helmx/plugin-client` 导出，优先复用不要手写 div+className）：`Screen`（页面容器+页头）、`ScreenSection`（分节）、`DataTable`（统一 loading/empty 的表格外壳）、`KvGrid`（键值概览）；
- **强制样式复用铁律**：全仓所有插件必须优先复用主框架设计系统原语，严禁在插件内复制通用表格、页面布局、键值列表或提示条样式；插件本地 `.css` 只写业务特异结构（如 Mermaid 缩放画布、Workflow DAG 卡片、Apps 启动台网格）。

### Radix UI 唯一无头交互原语底座

凡涉及浮层、对话框、下拉选择、标签页、气泡提示等复杂交互，**必须使用已有 Radix 封装**。共享实现位于 `packages/plugin-client/src/ui/`，经 `@helmx/plugin-client` 公开；Web 专有组件位于 `packages/web/src/ui/`。严禁原生控件或第三方重量级 UI 库：

| 场景 | 用什么 |
| :--- | :--- |
| 弹窗与抽屉 | SDK `Dialog` 封装；Web 危险确认用 `AlertDialog` |
| 下拉选择 | **全仓严禁原生 `<select>`**，统一 SDK `Select` / `MultiSelect`（无障碍 combobox 契约） |
| 下拉菜单与气泡 | Web `DropdownMenu`；共享气泡 SDK `Popover` |
| 标签页与分段 | SDK `Tabs` / `SegmentedControl` |
| 轻量提示 / 开关勾选 | Web `Tooltip`；SDK `Switch` / `Checkbox` |

SDK 不导入 Web store、路由或渲染实现。`HelmxStoreProvider` 经 `PluginClientHostContext` 注入真实数据与宿主能力；插件与宿主共享同一 SDK 上下文实例。

**严禁手写简陋交互浮层**：不得用原生 `div` + `position: absolute` + 随意 `onClick` 拼凑浮层，杜绝缺乏 WAI-ARIA、Focus Trap 焦点逃逸、Escape 无法退出与遮罩穿透。

**SSR 与单测防破裂契约**：所有 Radix 封装原语必须可在 Node / `renderToString` 环境直出降级渲染（不依赖 Portal），避免测试断言拿到空 DOM。

## 字体层次与移动端规范

### 字体阶梯

| 用途 | 字号 |
| :--- | :--- |
| 工作台主文本与输入框（侧栏、顶栏、表单、按钮、抽屉） | 13px / 14px |
| 会话阅读档：AI 正文、人类提问胶囊与 Composer 输入框 | 15px |
| 会话内代码块与工具输出代码 | 13px（行内代码 0.88em） |
| 思考过程正文 | 13.5px |
| 辅助文本与表单标签 | 12px |
| 状态徽章与胶囊计数 | 11px |
| 顶栏与主舞台大标题 | 15px / 16px |

- 会话与产物/工作区 Markdown 预览共用同一套阅读档排版（`.msg-ai-block` 与 `.artifact-markdown-preview` 内的 `.msg-ai-body`：正文 15px / 行高 1.65，标题阶梯按 em 比例）；
- **提问与输入字号一致**：人类提问胶囊与 Composer 输入框（含待命页）均为 15px / 行高 1.55，桌面、移动与分屏同字号。

### 移动端（`@media (max-width: 680px)`）

- 弹窗与抽屉 `width: 100vw; max-width: 100vw; left: 0; right: 0;` 全宽自适应；
- 头部容器 `flex-wrap: wrap`，标题截断保底，关闭按钮绝对可用；
- **严禁任何输入框在移动端或分屏宽度下字号突兀放大**（平台点击放大渲染异常须用精确 CSS 覆盖消除）。

## 零 Emoji 铁律

界面文案、导航、标题、按钮、徽章、卡片**严禁任何 Emoji**。图标统一 `lucide-react` 线性矢量图标（经 `HelmxIcon` 组件）或纯文本排版。

## Fast Refresh 与数据加载

- `.tsx` 组件文件**只导出 React 组件与 TypeScript 类型**；纯数据转换、枚举映射、排序过滤纯函数剥离到独立 `*-model.ts` 模块；
- 异步数据加载必须引入代数竞争保护（`loadGeneration.current += 1`），避免切换目标后旧请求反向覆盖新状态。

## 会话工具展示

- 常规工具保留 26px 单行轨迹与 `StepGroup` 折叠；专属展开体按工具语义呈现（`edit` 展示变更、`bash` 展示命令与输出尾部），提供原始数据入口；
- 待执行、成功、失败与未知状态必须如实区分：`oldText / newText` 只是片段对比不代表已落盘；成功后的差异只消费内核实际执行结果，禁止重读当前文件冒充历史快照；失败态不承诺「未写入」；
- `edit` 结果遵循 `@helmx/protocol` 的 `EditToolResult` 与 `EDIT_TOOL_RESULT_SCHEMA`，Web 在消费边界校验；
- 内容折叠与数据截断须分清：折叠可展开已有全文，截断明确说明部分数据未传回，不提供虚假「展开全部」；脱敏影响行号映射时省略差异正文并明确标记。

## 表单真实性与整体替换保存契约

- **真实编辑入口铁律**：凡渲染为可编辑的表单控件，保存链路必须真实持久化该字段；无法落盘的配置只读展示并指明真实修改路径（范例：模型中心供应商抽屉——插件网关配置只读标注「由插件 X 的配置管理」并指引插件中心，仅自定义网关端点可编辑）。必填字段清空保存必须显式报错；
- **整体替换（PUT）保存契约**：抽屉表单以最近一次完整详情为基底，仅覆写表单暴露字段，未暴露字段原样回传；可选绑定字段显式表达空值语义（非空写入、置空显式删除键，防止基底复活旧绑定）；
- **绑定类 Select 选项集**：提供「未绑定」空值项、资源全量（在线/离线标注）与未知值回退项；既有绑定不在列表时只读呈现原值并标注未知，不静默清空。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| Web 应用入口与路由装配 | `packages/web/src/App.tsx`、`main.tsx` |
| Web 专有 UI 组件 | `packages/web/src/ui/` |
| 共享 SDK 原语 | `packages/plugin-client/src/ui/`、`primitives.tsx` |
| 样式分片与响应式 | `packages/web/src/styles/`、`responsive.css` |
| 浏览器验收服务 | `scripts/web-acceptance.mjs` |
| 测试 | `packages/web/test/*.test.ts(x)`（happy-dom 单测）；`packages/plugin-client/test/` |

## 相关文档

- [Web 导航与 URL Hash 约定](web-navigation.md)：位置契约、深链与历史语义
- [插件开发实战](../plugins/plugin-development.md)：client.tsx 单轨与共享 SDK
- [微内核架构总览](../architecture/overview.md)：Web 与 SDK 的包依赖方向
