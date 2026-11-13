# Helm Web 主控台

`@helm/web` 是面向人类的响应式主控台，基于 React 19 + Vite 6 与 Radix UI 无头交互原语构建。开发模式下 Vite 固定占用 `3201`（`strictPort: true`），并将 `/api` 与 `/ws` 反向代理到 Hub（默认 `3202`，可用 `HELM_PORT` 覆盖）；Hub 与 Web 默认只监听本机。

## 启动与验证

```bash
# 从仓库根目录：Hub（3202）与 Web（3201）并行启动
HELM_PORT=3202 pnpm dev

# 或分别启动（dev:web 需内核已在 3202）
pnpm dev:kernel
pnpm dev:web

# 构建、类型检查与测试（按仓库分层执行，勿依赖 Unix timeout 命令）
pnpm build
pnpm typecheck
pnpm test:unit
```

构建产物位于 `packages/web/dist`。可重复的浏览器验收服务见 `scripts/web-acceptance.mjs`：独立临时数据目录、真实内核与 HTTP、临时注册的样例插件（含 `client.tsx` 夹具）。

## 架构要点

### 视图形态分级

界面按信息量分级为三档，禁止把海量内容塞进居中弹窗：

- **一级主舞台（Primary Stage）**：会话、插件 Screen、插件中心、应用中心等，占满中央视口，采用响应式卡片网格，顶部集成检索与分类；
- **右侧深度配置抽屉（Detail Drawer）**：主舞台卡片点击后的详情、能力透视与动态配置表单，桌面端固定宽度 520px~560px，移动端（≤680px）自适应全宽；
- **轻量居中模态（Centered Modal）**：仅限危险确认、短表单、凭据录入等轻量操作，宽度克制在 480px~640px。

### Radix UI 唯一交互原语底座

`src/ui/` 下基于 `@radix-ui/react-*` 封装全部交互原语：`Dialog`、`AlertDialog`、`Select`、`DropdownMenu`、`Popover`、`Tabs`、`Tooltip`、`Switch`、`Checkbox`。全仓严禁使用原生 `<select>` 与手写无 WAI-ARIA / Focus Trap 的浮层；所有原语在 SSR 与单测环境下可直出降级渲染（`renderToString` 不依赖 Portal）。视觉层由 `src/styles.css` 入口按级联顺序聚合的 `src/styles/` 分片（Quiet Surface 语义变量与控件类，@import 顺序即规则顺序，调整前先核对覆盖关系）与 `src/responsive.css`（窄面板、移动端与减少动画偏好）统一承载，插件不得硬编码另一套色板。

### 插件前端单轨机制（client.tsx）

插件视图统一经 `client.tsx` 编译为 ESM bundle（`GET /api/plugins/:id/client.mjs`，按 `contentHash` 缓存，停用即失效），由 `<PluginUiView />` 动态加载。编译期将 `react`、`react-dom`、`lucide-react` 与 `@helm/plugin-client` 虚拟化为 `globalThis.__helm_shared_*` 命名空间引用，运行时与宿主共享同一实例，绝不打包第二份 React；插件本地 CSS 经 `__helmClientCss` 导出托管注入与回收。

`@helm/plugin-client` 共享 SDK 提供响应式 Hook（`usePluginContext`、`usePluginDoc`、`usePluginSessionDoc`、`useConversations`、`useConversation`、`usePlugins`、`useToolActivity`）、布局原语（`Screen`、`ScreenSection`、`DataTable`、`KvGrid`）、无障碍控件（`Select` / `MultiSelect` / `Switch` / `Checkbox` / `Tabs` / `Dialog` 系列）、内容组件（`MarkdownView` / `CodeBlockView` / `Callout` / `ViewBoundary`）与 `PluginSlot` 插件间子插槽原语，导出符号唯一真源为 `@helm/protocol` 的 `PLUGIN_CLIENT_SHARED_EXPORTS`。声明式 JSON 卡片与 Mermaid 图表不是宿主内置能力，分别由 `builtin:json-render` 与 `builtin:mermaid` 插件通过 `markdownCodeBlock` 扩展点提供，停用后对应围栏回退普通代码块。

### 状态同步与 URL Hash 导航

- `src/lib/api.ts` 是 HTTP 唯一入口，统一携带 Bearer token；
- `src/lib/live-state.ts` 按 SSE `seq` 处理全局快照与增量：忽略重复帧，缺帧或格式异常时重连并重取可见状态；
- `src/lib/session-docs.ts` 按需订阅会话分片文档（如工作流 `runs`）的专用 SSE，不进入全局首帧；错误显式暴露给订阅者，绝不静默降级；
- 全站位置由 `src/lib/url-hash-model.ts` 唯一管理：主屏 `sp.*` 与分屏 `ssp.*` 参数命名空间隔离，支持复制链接直达、刷新恢复与浏览器前进/后退；组件经 `HelmStoreProvider` 暴露的 `openTarget / closeSplit / setScreenParams` 等方法导航，不得另建平行路由。

## 规范指引

编写或重构界面、新增视图/弹窗/抽屉、排查移动端样式或深链问题时，先阅读并遵守：

- [Web 前端设计系统与开发约定](../../docs/conventions/web-frontend.md)：视图形态分级、Radix 原语底座、字体阶梯与零 Emoji 铁律；
- [Web 导航与 URL Hash 开发约定](../../docs/conventions/web-navigation.md)：可恢复状态边界、Screen 参数契约与历史记录语义。

`.tsx` 组件文件只导出组件与类型，纯函数放独立 `*-model.ts` 模块，保持 Fast Refresh 不失效。
