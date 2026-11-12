# 插件 client.tsx 性能与代码分割

本文面向开发 Helm 插件的 AI。默认原则：**AI 只写标准 TypeScript/React 与标准 ESM `import()`；宿主负责编译、分包、鉴权、缓存、预加载和失效。**

## 先判断是否需要本手册

遇到以下任一情况，先读取本手册再修改插件代码：

- client.tsx 引入 Mermaid、编辑器、图表、解析器、地图或其他重型依赖；
- 用户反馈插件首次打开慢、网络下载大、主线程解析慢；
- 需要使用 `import()`、异步 chunk 或拆分 bundle；
- 需要检查插件 client 产物体积、gzip 体积或 chunk 缓存；
- 需要排查插件停用、重载、刷新后的 chunk 加载失败。

普通的小型插件不需要为了分包增加额外抽象。

## AI 应该如何写插件代码

### 首屏和低频功能分开

首屏必需、体积很小的代码使用静态 import：

```tsx
import { useState } from 'react'
import { usePluginContext } from '@helm/plugin-client'
import './styles.css'
```

重量大、低频使用或只在用户操作后需要的功能使用标准动态 import：

```tsx
async function openAdvancedView(source: string) {
  const { renderAdvancedView } = await import('./advanced-view.ts')
  return renderAdvancedView(source)
}
```

如果第三方库本身支持动态 import，优先动态加载该库：

```tsx
const { default: chart } = await import('chart-library')
```

内置插件可以通过受控 `npmDependencies` 声明该依赖；外部插件在 `plugin.json.clientDependencies` 或 `package.json.helm.clientDependencies` 中逐项声明裸包名或子路径说明符（宿主将其映射为解析根指向插件自身目录的受控依赖，并在受管安装时自动补装），未声明的裸 npm 说明符会被编译器显式拒绝。

### 保持入口模块轻量

入口模块只放：

- 宿主扩展点导出的组件；
- 首屏必须的状态和事件处理；
- 小型纯函数；
- 低体积样式入口。

不要在入口模块顶层静态引入只在按钮点击、弹窗打开或特定数据类型出现时才需要的重型库。

### 动态导入保持标准 ESM 语义

动态导入必须是普通的标准写法：

```ts
const mod = await import('./feature.ts')
```

不要手工改写为宿主桥接调用。编译器会分析动态 import，生成主模块、共享 chunk 和按需 chunk，并在产物阶段改写为宿主加载桥。

## AI 禁止触碰的内部机制

插件源码禁止：

- 直接调用 `globalThis.__helm_import_chunk`；
- 直接读写 `globalThis.__helm_chunk_share`；
- 手写 `/api/plugins/<id>/client.mjs` chunk URL；
- 读取、拼接或伪造 `contentHash`；
- 把 Bearer token 放入 URL；
- 依赖 Blob URL 的相对路径；
- 手工创建或缓存 chunk 文件名；
- 用 `eval`、`new Function` 或字符串拼接执行模块代码；
- 为了绕过编译器边界，把 clientRoot 外部文件复制进运行期路径。

这些机制属于宿主实现。插件只声明正常模块依赖。

## 导入与共享依赖规则

允许从 `@helm/plugin-client` 导入宿主共享 Hook、组件和上下文；允许使用宿主声明的共享 React、React DOM、lucide-react 说明符。不要在插件中复制 React 或手写宿主共享全局变量。

插件本地相对依赖必须位于 `clientRoot` 内。外部插件不得依赖未声明的裸 npm 包；编译器会显式拒绝，而不是静默寻找 node_modules。

插件样式应从 clientRoot 内相对导入：

```tsx
import './styles.css'
```

不要修改宿主 `packages/web/src/styles.css` 来承载插件业务样式。不要把本地图片、字体或 CSS 资源 URL 当作插件静态资源端点；按现有插件开发规则使用内联 `data:` 或显式 HTTP(S) 地址。

## 运行时行为

宿主会自动完成：

1. 使用 esbuild 分析入口和动态 import；
2. 生成主模块、共享异步 chunk 和私有异步 chunk；
3. 对产物生成 content hash 与 gzip；
4. 通过 Bearer 鉴权的 HTTP 端点按需返回 chunk；
5. 对同一模块和 chunk 合并并发请求；
6. 按依赖拓扑顺序加载共享 chunk；
7. 在停用、重载、登出或缓存代际变化后清理 chunk；
8. 对旧 hash 返回显式过期错误，不把旧模块静默当作新模块使用。

因此，AI 不应实现第二套加载器，也不应在组件中根据网络状态手写 fallback。加载失败必须保留宿主的显式错误语义。

## 失败处理规则

动态依赖加载失败时：

- 不要返回空组件冒充成功；
- 不要吞掉 import 错误；
- 不要把源码文本伪装成已渲染结果；
- 在组件层显示明确错误和重试入口；
- 保留用户可复制的源码或输入内容（如果该组件处理用户输入）。

异步 render 结果必须有卸载、参数变化或缓存代际守卫，迟到结果不得覆盖新状态。

## 开发验证

外部插件先执行真实自检：

```bash
helm plugins doctor <plugin-id-or-directory>
```

修改代码后使用受控热重载：

```bash
helm plugins reload <plugin-id>
```

检查入口产物：

```bash
helm plugins client <plugin-id> --module client.tsx --json
```

如果需要检查异步 chunk：

```bash
helm plugins client <plugin-id> --module client.tsx --chunk <chunk-name> --json
```

不要只根据源码行数或理论值判断优化完成。应以实际编译结果、gzip 字节数、浏览器 Network 面板和真实图表/功能操作为准。

相关测试：

```bash
pnpm typecheck
pnpm --filter @helm/kernel test test/plugin-client.test.ts
pnpm --filter @helm/web test test/plugin-client-chunks.test.ts
pnpm --filter @helm/web test test/plugin-client-css.test.ts test/plugin-client-runtime.test.ts
```

测试 case 遵守项目约定，显式设置 `{ timeout: 60_000 }`。命令失败时如实报告失败项和日志，不要用空实现、mock 数据或静默降级伪造通过。

## 完成标准

插件 client.tsx 相关修改只有同时满足以下条件才可宣称完成：

- 入口和组件导出符合 clientRoot / ClientComponentRef 契约；
- 重型低频依赖使用标准动态 import，首屏不无条件加载；
- 没有直接触碰宿主 chunk 桥、hash 或 Bearer URL；
- `helm plugins doctor` 通过；
- 相关 kernel/web 测试通过；
- 失败路径仍显示明确诊断；
- 如声称优化了性能，必须提供实际主包和 chunk 的 gzip 体积或浏览器网络验证结果。
