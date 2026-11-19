# Mermaid 图表渲染插件

`builtin:mermaid` 解决「在聊天消息里渲染 Mermaid 图表」的问题：接管 ```mermaid 代码围栏，把 Mermaid 文本渲染为流程图、时序图、甘特图等矢量 SVG。适合输出架构图、时序图的使用者。它是内核 markdown 代码块扩展机制之上的普通消费者——宿主核心不感知任何具体图表库，与 [`builtin:json-render`](json-render.md) 同构。

## 当前状态

默认启用、可停用。停用后 ```mermaid 围栏回退为带语法高亮的普通代码块。

## 能力和入口

唯一注册点是 `ctx.ui.markdownCodeBlock({ id: 'mermaid-diagram', languages: ['mermaid'], client: ... })`，客户端组件 `MermaidCodeBlock` 负责渲染：

- **明暗主题自适应**：跟随宿主 `usePluginContext()` 的 `theme`（light → `neutral`、dark → `dark` 并覆盖主题变量），主题切换即时重绘；代码内容变化经 250ms 防抖后重绘；
- **缓存与代际守卫**：按 `(theme, code)` 缓存渲染 SVG（上限 200 条 LRU 淘汰）；渲染异步，参数变化推进代际计数，卸载或变更后迟到的异步结果一律丢弃；
- **源码与图表切换**：正常渲染内联 SVG，提供复制源码与放大预览模态；
- **失败显式诊断**：语法错误等渲染失败显式展示错误信息与可复制源码，绝不静默截取脏文本或留空白冒充成功。

### 受控 npm 依赖打包

Mermaid 库体量大且迭代频繁，本插件采用**受控 npm 依赖**机制打包进编译产物：

- 插件定义声明 `npmDependencies: { mermaid: <@helmx/plugins 包根> }`——版本由仓库 pnpm-lock 锁定，插件自身不携带依赖；
- 宿主编译器把该说明符解析进 bundle，逐文件 containment 校验（不越解析根）；依赖文件 hash 随缓存清单持久化，缓存命中时复查——解析根消失或文件变化即失效重编译，绝不静默复用旧产物；
- 浏览器端**零预加载**：宿主不预先加载任何图表库，`mermaid` 只在本插件编译产物 chunk 中按需 `import()`。

外部插件等价机制是在 `plugin.json` / `package.json` `helmx` 字段声明 `clientDependencies: string[]`，宿主映射为「解析根 = 插件自身目录」的受控依赖（代码内自指解析根对外部插件无效）。

## 配置与数据边界

插件自身无 `ctx.configSchema` 配置项、无持久文档、无后端动作。渲染完全在浏览器端完成，失败信息不回传服务端。

## 停用与失败语义

停用后 ```mermaid 围栏平滑回退普通代码块，其他插件的围栏渲染与宿主 Markdown 能力不受影响；重新启用即时恢复。找不到受控依赖（未安装）时插件加载显式报 `mermaid_dependency_missing`，不带病运行。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口 | `packages/plugins/src/mermaid.ts` |
| 前端渲染组件 | `packages/plugins/src/mermaid/client/` |
| 测试 | `packages/web/test/mermaid-theme.test.ts`、`markdown-codeblock-plugins.test.ts`、`packages/plugins/test/plugin-client.test.ts` |

## 相关文档

- [JSON 卡片渲染](json-render.md)：同属 `markdownCodeBlock` 扩展点的姊妹插件
- [插件开发实战](plugin-development.md)：外部插件 `clientDependencies` 声明
