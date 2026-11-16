# @helm/web

Helm 面向人类的响应式主控台（React 19 + Vite 6）。本文只覆盖本包的职责、开发命令、构建产物、测试与限制；项目总览见仓库根 [AGENTS.md](../../AGENTS.md) 与[文档中心](../../docs/README.md)。

## 职责

- 渲染会话时间线、Composer、侧栏、各管理中心（角色/模型/技能/节点/插件）与工作台；
- 经 `PluginClientHostContext` 向 `@helm/plugin-client` 浏览器 SDK 注入真实数据与宿主能力，动态加载并渲染全部插件 `client.tsx` 编译产物（`<PluginUiView />`）；
- 消费 SSE 全局快照/增量（`src/lib/live-state.ts`）与按会话分片的插件会话文档专用 SSE（`src/lib/session-docs.ts`）。

本包不承载业务能力：声明式 JSON 卡片与 Mermaid 图表分别是 `builtin:json-render` / `builtin:mermaid` 插件经 `markdownCodeBlock` 扩展点提供；Web 自身不反向依赖任何插件。SDK 也不得依赖本包。

## 开发命令

```bash
# 从仓库根：Hub（3202）与 Web（3201）并行启动
HELM_PORT=3202 pnpm dev

# 或分别启动（dev:web 需内核已在 3202）
pnpm dev:kernel
pnpm dev:web          # vite --port 3201 --strictPort

pnpm build            # typecheck + vite build
pnpm typecheck        # 含测试 tsconfig
pnpm test:unit        # web 属 unit 档（happy-dom）
```

端口铁律：dev 固定 `3201`（`strictPort: true`，代理 `/api` 与 `/ws` 到 Hub），**永不占用 3000/3001/3002/3101/3102**。Hub 与 Web 默认只监听本机。

## 构建产物

`dist/`（Vite 产物）。该产物同时被 `@helm/payload` 组装进 npm payload（`web/dist/`，由 Hub 入口以 `HELM_WEB_DIST_DIR` 显式定位），也被桌面端 `assemble-hub` 组装进安装包。

## 测试

`test/*.test.ts(x)`：happy-dom 单测（属仓库 unit 档，`--test-isolation` 合片）。真实浏览器验收服务在 `scripts/web-acceptance.mjs`（独立临时数据目录、真实内核与 HTTP、临时注册含 `client.tsx` 夹具的样例插件）。测试纪律（显式 `{ timeout: 60_000 }`、禁对 DOM 节点 `assert.equal/deepEqual` 等）见 [AGENTS.md](../../AGENTS.md)。

## 限制

- 需要内核 Hub 在 3202 运行（dev 模式经 Vite 代理；生产由 Hub 静态托管）；
- 插件前端不是本包职责：写插件界面请开发 `client.tsx` 并复用 `@helm/plugin-client`，不向本包添加插件专属代码；
- 界面约定（零 Emoji、Radix 唯一原语、唯一 Hash 导航、Fast Refresh）是硬契约，见 [Web 前端设计系统](../../docs/conventions/web-frontend.md) 与 [Web 导航约定](../../docs/conventions/web-navigation.md)。
