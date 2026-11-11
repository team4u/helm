# Mermaid 图表渲染插件

`builtin:mermaid` 为聊天消息提供 Mermaid 图表渲染能力（默认启用、可停用）：通过 `ctx.ui.markdownCodeBlock({ languages: ['mermaid'] })` 接管 ```` ```mermaid ```` 代码围栏，把 Mermaid 文本渲染为流程图、时序图、甘特图等矢量 SVG。与 `builtin:json-render` 一样，它是内核 markdown 代码块扩展机制之上的普通消费者——宿主核心不感知任何具体图表库。

## 受控 npm 依赖打包

Mermaid 图表库体量可观，且版本迭代频繁。本插件采用**受控 npm 依赖**机制把它打包进编译产物：

- 插件定义声明 `npmDependencies: { mermaid: <内核包根> }`——解析根绑定内核包根（其 `node_modules` 内由 pnpm-lock 锁定的 mermaid 版本），插件自身不携带依赖、版本随锁文件演进；
- 宿主 `PluginClientCompiler` 编译时把该说明符解析进 bundle，逐文件 containment 校验（不越解析根）；依赖文件内容 hash 随缓存清单持久化，缓存命中时复查——解析根消失或文件变化即失效重编译，绝不静默复用旧产物；
- 浏览器端**零预加载**：宿主不预先加载任何图表库，`mermaid` 只在本插件的编译产物 chunk 中按需 `import()`，未启用本插件或页面无图表时零成本。

外部插件不支持 `npmDependencies`（仅内置插件可声明）；外部插件如需第三方前端依赖，应自行打包进 client 源码。

## 渲染行为

客户端组件 `MermaidCodeBlock` 的实现要点：

- **明暗主题自适应**：渲染配置跟随宿主 `usePluginContext()` 的 `theme`（light 用 `neutral` 主题、dark 用 `dark` 主题并覆盖主题变量），主题切换即时重绘无闪烁；代码内容变化经 250ms 防抖后重绘；
- **缓存与代际守卫**：按 `(theme, code)` 缓存渲染 SVG（上限 200 条 LRU 淘汰），命中即免重绘；渲染是异步的，任何参数变化（含缓存命中路径）都推进代际计数，卸载或参数变更后迟到的异步结果一律丢弃，绝不覆盖缓存命中态；
- **源码与图表切换**：正常渲染为内联 SVG 图表，提供复制源码按钮与放大预览模态（`MermaidPreviewModal`）；
- **失败显式诊断**：渲染失败（语法错误等）显式展示错误信息与可复制源码，绝不静默截取脏文本或留空白冒充成功。

## 停用语义

停用本插件后 ```` ```mermaid ```` 围栏平滑回退为普通代码块（带语法高亮的源码展示），不再渲染图表；其他插件的围栏渲染与宿主 Markdown 能力不受影响。重新启用后图表渲染即时恢复。
