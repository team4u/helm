# 技能与插件自举开发参考

## 自举编写技能（~/.helm/skills/<id>/）

技能是模型按需加载的操作手册，SKILL.md 保持简短，细节放 references/。下列路径均是 Hub 数据目录下的路径；配置 HELM_DATA_DIR 时使用该目录。在远端节点执行的 bash 不能把当地 ~/.helm 当成 Hub 的资产目录。

```
~/.helm/skills/deploy-playbook/
  SKILL.md              # 必须：frontmatter + 索引级正文
  references/
    rollback.md         # 按需下钻子文件（可嵌套子目录）
    db-migrate.md
```

SKILL.md 骨架：

```markdown
---
name: deploy-playbook
description: 发布流程手册（模型靠这句话判断何时加载）
---

# 发布流程

遇对应场景先读参考文件：

- references/rollback.md：回滚步骤
- references/db-migrate.md：数据库迁移
```

要点：
- id 目录名限 [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}；references 内路径禁止绝对路径/`..`/反斜杠/符号链接（严格校验）。
- description 决定触发时机，写具体、写场景；正文不堆细节，索引指路。
- 写完 `helm skills list` 验证被识别，`helm skills read <id>` 验证可读。

## 开发外置插件（~/.helm/plugins/<dir>/）

优先使用 `helm plugins init <name>` 生成完整骨架（含 `plugin.json`、`index.ts`、`client/index.tsx`）；也可手工放置 `plugin.json` 声明 `{ "id": "my-plugin", "main": "index.ts", "clientRoot": "./client" }` 或约定入口（`index.ts` / `index.mjs` / `index.js`）。

服务端入口直接导出符合 PluginDefinition 的对象，其中 definePlugin(ctx) 注册能力；支持直接用 TypeScript（宿主按依赖闭包转译加载）：

```ts
// ~/.helm/plugins/my-plugin/index.ts
export default {
  id: "my-plugin",
  name: "我的插件",
  version: "0.1.0",
  clientRoot: "./client", // 前端组件放在 client/ 子目录时必须显式声明（缺省根为插件目录本身）
  definePlugin(ctx) {
    const state = ctx.doc("state", { count: 0 }, { public: true })
    ctx.action({
      id: "increment",
      description: "计数加一",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", properties: { count: { type: "number" } }, required: ["count"], additionalProperties: false },
      handler() {
        state.update(current => ({ count: current.count + 1 }))
        return state.get()
      },
    })
    ctx.ui.sidebarItem({ id: "my", label: "我的插件", icon: "terminal", target: "screen:my-plugin/main" })
    // client.module 相对 clientRoot 解析（此处对应 <插件目录>/client/index.tsx）
    ctx.ui.screen({
      id: "main", label: "计数器",
      client: { module: "index.tsx", export: "CounterScreen" },
    })
  },
}
```

client/index.tsx（共享宿主 React 与 SDK，不打包第二份 React）：

```tsx
import { usePluginContext, usePluginDoc } from '@helm/plugin-client'

export function CounterScreen() {
  const { callAction } = usePluginContext()
  const state = usePluginDoc<{ count: number }>('state')
  return (
    <div className="card">
      <div>计数：{state?.count ?? 0}</div>
      <button type="button" className="btn btn-primary" onClick={() => void callAction('increment', {})}>加一</button>
    </div>
  )
}
```

受控前端 npm 依赖与插件依赖：

- client.tsx 默认只允许 `react`、`react-dom`、`lucide-react`、`@helm/plugin-client` 与插件目录内相对导入；第三方裸 npm 包必须显式声明。
- 前端依赖可写在 `plugin.json`：

```json
{
  "clientRoot": "./client",
  "clientDependencies": ["dayjs", "katex"]
}
```

  也可写在 `package.json` 的 `helm.clientDependencies`：

```json
{
  "dependencies": { "dayjs": "^1.11.0" },
  "helm": { "clientDependencies": ["dayjs", "katex"] }
}
```

- `clientDependencies` 是前端 bundle 的精确裸说明符白名单；子路径（如 `lodash/map`）也必须逐项声明。解析根固定为插件自身目录，不能在外部插件代码中自定义 `npmDependencies` 解析根。
- 对受管安装，`helm plugins install` / `helm plugins update` 会补装声明的前端依赖且使用 `--no-save`；建议同时把包及版本范围写入 `package.json.dependencies`，保证安装可复现。未声明版本范围的裸包名按包管理器当前解析结果安装。
- `helm plugins doctor <dir>`、`helm apps validate <dir>` 与运行期 client 编译使用同一依赖边界；缺失依赖、未声明裸导入、相对路径越根都会显式失败，不能用普通 Markdown 或空组件假装通过。
- 插件间依赖可写在 `plugin.json.dependencies` 或 `package.json.helm.dependencies`，例如 `["base-plugin"]`；也可写在入口导出对象的 `dependencies` 字段（三处合并去重）。它只接受插件 ID，不接受 npm 版本范围。启用前依赖插件必须已注册且已启用；依赖环路会被拒绝；别人停用/卸载被你依赖的插件会被 `plugin_in_use` 拦下。
- 依赖声明本身不是调用机制，它只提供保障（依赖一定在、一定先启动、不会被抽走）。真正调用另一个插件的功能用 `ctx.host.invokeAction`：

```ts
// 依赖方：声明 dependencies 后，service start 时可安全调用对方动作
export default {
  id: 'my-plugin',
  dependencies: ['base-plugin'],
  definePlugin(ctx) {
    ctx.service({
      id: 'worker',
      async start() {
        const result = await ctx.host.invokeAction(
          'base-plugin', 'analyze', { text: 'hello' },
        ) as { score: number }
        // 调用经过防线：目标必须处于启用态（停用即显式报错，绝不静默空返回），
        // 输入经对方 inputSchema 校验，输出经 outputSchema 校验并统一脱敏。
      },
      async stop() {},
    })
  },
}
```

- 动态发现：`ctx.host.listActions()` 返回全部已启用插件的动作清单（pluginId / id / inputSchema / outputSchema / idempotent），可按需调用；调用前可用 `ctx.host.prepareAction(pluginId, actionId, input)` 做无副作用预检。
- 异步通信用事件总线：`await ctx.host.emitEvent('my-plugin:done', payload)` 发布（其他插件 `ctx.host.onEvent` 订阅）；`onEvent` 返回退订函数，插件停用时宿主自动解除。
- UI 组合用 `ctx.ui.slot` 向其他插件的命名插槽注入组件；前端跨插件读公开文档用 `usePluginDoc(name, pluginId)`，跨插件调动作用 `callAction(actionId, input, { pluginId })`。
- 不要直接 import 另一个插件的代码：插件是独立模块图（支持代际热重载），直接 import 会焊死两个插件的生命周期；跨插件一律走 invokeAction / 事件 / 插槽这些接口导向通道。

扩展入口：
- 后端 Hook（{{HOOK_COUNT}} 个）：{{HOOK_NAMES}}；各 Hook 允许的 continue/transform/handled/block 结果以 protocol 契约为准。
- 前端 {{UI_METHOD_COUNT}} 个 ctx.ui 注册方法：基础 10 个（sidebarItem/sidebarSection、screen、timelineRenderer、markdownCodeBlock、toolView、composerPill/composerWidget、workbenchPanel、command、settingsPanel）+ 统一 UI 动作 action（target 三选一：conversation:header / conversation:row / timeline:entry；绑 actionId 后宿主代管按钮/pending/失败提示，scope 按标签过滤会话，timeline:entry 的 kinds/roles 过滤消息条目；宿主注入的真实 conversationId/entryId 强制覆盖 input 同名字段）+ profileRuntime（Profile 外部运行时元数据）+ slot（插件子插槽）+ artifactPreviewer（按 MIME/后缀预览产物）+ composerCompleter（输入引用候选源）。
- timelineRenderer/markdownCodeBlock/toolView/artifactPreviewer/composerCompleter 支持 priority（降序裁决，缺省 0；同优先级保持贡献顺序）；同一插件可声明多块 settings.panel（order 排序）。markdownCodeBlock 按围栏语言（languages）接管 Markdown 代码块渲染，无注册命中时回退普通代码块。
- `Profile.starters` 是静态配置的空白会话提示，不是 UI 扩展点；每 Profile 最多六项，label 最多 24 个 Unicode 码点，prompt 最多 4000 个码点。只在历史完整加载的真实空会话展示，点击回填草稿而不发送；已有草稿、附件、编辑或在途操作不覆盖。CLI 使用 `helm profiles update <id> --starters '<json数组>' --json`，传 `[]` 清空。
- command 的 slash（不含 / 的触发词）同时派生输入框 `/` 补全：保留词 {{RESERVED_SLASH_COMMANDS}} 与 skill: 前缀禁占，跨启用插件不得重名，声明 slash 必须绑定本插件 actionId（跨插件动作用 actionPluginId）。
- screen 组件收到 params/setParams：URL Hash 中主屏 `sp.<key>`、分屏 `ssp.<key>` 命名空间隔离，同屏双开互不串扰；setParams 默认 replace，`{push:true}` 入栈；组件不得自建路由或直接操作 history。
- composer.pill/widget 收到受控句柄 composer（draft/attachments/sending、setDraft/insertText/submit；submit() 失败 reject 且保留草稿）。
- `composerCompleter` 为 `@ / # / :` 声明纯数据补全源（`/` 留给命令/技能）：`source` 必须显式选择 `{kind:'action', actionId, actionPluginId?}` 或 `{kind:'doc'|'sessionDoc', name, itemsField}`。Action 输入 `{query, conversationId}`、输出 `{items:[{id,label,insertText,hint?,icon?}]}`，且必须 `idempotent: true`；文档源必须是本插件 public doc/sessionDoc 的顶层数组字段，不猜 `docs[0]`。补全只替换触发 token、只插入文本，不提交/执行。Web 防抖查询，CLI/Agent/Workflow 经同一 Action。
- `artifactPreviewer` 按 MIME（精确值或 `type/*`）和/或小写扩展名（如 `.csv`、`.topo.json`）匹配；至少声明一类，MIME 与后缀取 OR，按 scope 和 priority 裁决。组件接收宿主管理的 `blobUrl`、可选元数据名和最多 1 MiB 的文本；用户仍可切回默认预览与下载。client 仍是可信代码不是沙箱；展示不可信 HTML 时放入默认无权限的 `<iframe sandbox="">`，不注入宿主 DOM，不要声称 `allow-scripts` 无风险。
- `NODE_DETAIL_SECTION_SLOT` (`builtin:node/detail-section`) 是节点中心宿主保留插槽，不是 `builtin:node` 插件。用 `ctx.ui.slot` 注入已有节点的扩展区，Props 为 `{nodeId,isLocal,isOnline,isNew:false}`；不传令牌/连接命令，不在新节点接入表单挂载。
- `ctx.action({ id, description, inputSchema, outputSchema, idempotent?, handler })` 将 Schema 动作统一映射到 HTTP、CLI、Workflow action()、Web；`idempotent: true` 标记只读/幂等动作，失败或中断时允许工作流断链重跑；模型可经 run_action 调用，设置 exposeAsTool: true 才直接列为工具。
- `ctx.host.execEnv(req, opts?)` 经内核 EnvFabric 跨节点执行命令（复用 local / 远端 @helm/node 通道、SecretStash 注入与脱敏），纳入在途任务追踪（withTask）。
- `ctx.host.nodeFetch(nodeId): typeof fetch` / `ctx.host.openTunnel(nodeId, { host?, port }, signal?)` 经 EnvFabric 节点隧道跨节点访问目标节点视角的 HTTP(S)/SSE 服务，或获取任意 TCP 双工流（host 由节点解析，缺省 `127.0.0.1`；活动隧道计入在途任务追踪）。节点端无需部署配套插件代码。
- `ctx.doc(name, initial, { public: true })` 公开持久全局状态（进全局 SSE 首帧，更新广播全量）；前端组件经 `usePluginDoc(name)` 订阅。`ctx.configSchema` 的 secret 字段进入凭据存储，避免公开到 doc。
- `ctx.sessionDoc(name, initial, { public: true })` 按会话分片持久状态：句柄 `get/set/update/delete(conversationId, ...)`（如 `metrics.update(input.conversationId, cur => ({ count: cur.count + 1 }))`），前端组件用 `usePluginSessionDoc("metrics")` 按当前会话订阅；不进全局首帧与全局广播，公开时经专用 SSE（`GET /api/plugins/:id/docs/:name/events?conversationId=N`）只推给订阅该会话的客户端；会话删除级联清理，删除后写入被拒。会话级 UI 状态（如每会话任务列表、运行详情）一律用 sessionDoc 而非 doc，避免全局写放大；doc 与 sessionDoc 禁止同名。
- `ctx.service({ id, start, stop })` 管理后台服务；声明 liveTasks 可在停用前报告在途任务。

要点：
- 外部插件 id 禁止 `builtin:` 前缀、禁止与已注册插件重名、不可自封 locked；放入目录后 `helm plugins rescan` 增量发现（或重启 Hub 自动发现），默认停用注册。
- 受管安装：`helm plugins install <source>` 支持 `npm:<spec>`、`git:<repo>@<ref>`、HTTPS Git URL 与本地路径四种 source（由 Hub 服务端解析获取；本地路径指 Hub 主机上的路径）；`helm plugins update <id>` 更新、`helm plugins remove <id> [--yes]` 移除（破坏性操作需确认，非交互用 --yes）；安装记录（PluginPackageRecord）由安装器持久化，PluginSummary 附可选 managed 元数据。安装启用即在 Hub 进程内执行可信插件代码，无沙箱，仅装可信来源。手管目录（init + rescan）方式继续可用。
- 启用：`helm plugins enable my-plugin`；修改入口代码后用 `helm plugins reload my-plugin` 受控热重载（先静态自检预检，失败时旧实例保持不动，无需重启 Hub）。停用/启用仅重建已有定义的生命周期。停用或卸载遇在途任务会显式拒绝（409 plugin_has_live_tasks）。
- 不要在自己的回合内重启 Hub；先完成结果交付，再安排进程重启。
- 前端 React 组件（client.tsx）经 esbuild 动态编译，可 import react / react-dom / lucide-react / @helm/plugin-client（宿主共享实例，不打包第二份 React）。@helm/plugin-client 另共享无障碍底座组件：Switch、Select、MultiSelect、Checkbox、Tabs/TabsList/TabsTrigger/TabsContent、SegmentedControl、HelmIcon、ViewBoundary、Callout、Dialog/DialogPortal/DialogOverlay/DialogContent/DialogTitle/DialogDescription/DialogClose/DialogTrigger、MarkdownView、MarkdownText、CodeBlockView、CopyButton、PluginSlot，以及轻量布局原语 Screen（页面容器+页头）、ScreenSection（分节）、DataTable（组合式表格外壳，统一 loading/empty，表头/数据行由 children JSX 表达）、KvGrid（items: Array<{key,value}> 键值概览），及通用格式化纯函数 formatTime（MM-DD HH:mm）、formatCompactTimestamp（MM-DD HH:mm:ss）、formatDurationMs（毫秒时长摘要）——通用结构优先复用这些原语与 formatter，不要另造原生控件、重复 formatter 或新 CSS 主题。
- 共享 Hook：useToolActivity(callId, active) 报告所在时间线回合的工具后台活动；usePluginDoc(name, pluginId?) 响应式订阅公开全局文档（可跨插件寻址）；usePluginSessionDoc(name, {conversationId?, pluginId?}?) 按当前会话订阅公开会话文档（多组件共享订阅，引用归零退订，重连首帧恢复）；useConversations() 全部会话摘要；useConversation(id) 单会话实时视图（summary/detail/live/pendingAsks）；usePlugins() 宿主插件清单与 Screen 贡献响应式快照（plugins + screens，SSE 实时同步，应用中心类视图据此感知已安装应用及其主视图启停）；<PluginSlot name> 声明子插槽；usePluginContext() 提供 callAction(actionId, input, {pluginId?, conversationId?})（可跨插件）、submitInput(text, {conversationId?, whenBusy?})、openScreen/openSplitScreen/openConversationDrawer/openArtifact/openWorkbench、notify 等。
- 插件视图样式写在 clientRoot 内本地 .css（import 引入，esbuild 合并为保留导出 __helmClientCss，宿主托管注入与回收），不得写宿主 styles.css。
- UI 文案严禁 Emoji；图标用 lucide 图标名。
- 完整扩展点与 client.tsx 单轨机制见仓库内 docs/architecture/extension-points.md 与 docs/plugins/plugin-development.md。
- client.tsx 涉及重型依赖、动态 import、首屏性能或异步 chunk 时，先读取 `references/plugin-client-code-splitting.md`；该手册规定 AI 应写的源码形态、禁止触碰的宿主桥接内部、验证命令与失败处理。
