# 后端生命周期 Hook 与前端全界面扩展点

插件是 Helm 唯一的策略扩展面：后端通过 7 个可组合生命周期 Hook 介入会话调用链，前端通过 `ctx.ui.*` 的 16 个注册方法重塑全部界面。本文给出两侧扩展点的完整契约、宿主协调架构与公开数据的投影规则。类型唯一真源在 `packages/protocol/src/plugin.ts` 与 `ui.ts`。

## 宿主内部协调架构

`PluginHost` 是插件生命周期的唯一协调者：管理注册（register）、启用（enable）、停用（disable）与注销（unregister）状态机，同插件的启停操作经 per-plugin 队列串行；停用先把 phase 置为 `deactivating` 再进入 await，期间新的 `invokeAction / executeTool / runHook` 一律拒绝，绝不让任务进入正在拆毁的注册表。每个启用周期递增 epoch：旧 `definePlugin` 上下文（含 doc 句柄与宿主生命周期资源）在新周期或停用后立即失效，防止异步残留注册污染新周期。

服务启动遵循**全局 prepare → start 屏障**：`PluginHost.start` 先对全体已启用服务执行 `prepare()`（如 `builtin:workflow` 在 `prepareRecovery` 中先于 SDK 调度器恢复持久标记中断任务取消），再依次 `start()`；热启用同样先 prepare 后 start。停用预检分两层：`liveTasks()` 声明在途运行任务（非空即 `409 plugin_has_live_tasks`，不可 force 跳过），`inUse()` 声明持久生效资源（非空默认 `409 plugin_in_use`，可显式 `--force`），`liveWorktrees()` 声明在途工作树占用供清理链拒绝误碰。

宿主内的子注册表分工如下：

| 组件 | 职责 |
| :--- | :--- |
| `CapabilityRegistry` | 动作、工具与原始路由的注册、Schema 校验与五端映射 |
| `PluginDocRegistry` | 全局 `ctx.doc` 与按会话分片 `ctx.sessionDoc` 的持久化与发布 |
| `UiRegistry` | 界面声明校验、跨插件冲突裁决（priority），通过注入端口请求客户端构建产物 |
| `RuntimeToolRegistry` | 注册与热更新内核/插件工具；`run_action` 调用与只读 `describe` |
| `HookBridge` | 每次模型请求按 scope 裁剪插件工具；钩子链收敛后投射 `prompt.tools.*` 与 `prompt.actions`，清理不可达能力的旧指引 |
| `AssetReloader` | 纯文件资产（Profile/技能）的热重载协调 |

动作与工具的认知入口均由声明驱动：`ctx.action` 默认进入 `<available_actions>` 目录，`exposeAsTool: true` 则使用独立工具声明，`ctx.tool` 提供模型专用工具。`promptSnippet` / `promptGuidelines` 仅在对应能力对当前会话可达时注入；动作目录依赖最终工具集保留 `run_action`。完整参数 Schema 可用 `run_action({ actionId, describe: true })` 按需只读获取，不执行 handler。内置与外部插件使用相同机制，具体范式见 [插件开发指南](../plugins/plugin-development.md#动作自动发现与会话目录)。

## 后端：7 个生命周期 Hook

Hook 覆盖从外部事件入站到回合终态结算的完整调用链。处理器签名与载荷类型见 `HookPayloadMap`；注册时 `priority` 数值较大者先执行，同优先级按注册顺序（稳定排序）。

```typescript
export type HookName =
  | 'trigger'      // 外部入站事件（cron/webhook 经 defang 防逃逸信封）
  | 'input'        // 每次提交输入（human/agent/trigger 三种 origin）
  | 'before_turn'  // 大模型回合推理前，可原地改写 tools/sections/messages
  | 'tool_call'    // 工具开始执行前（唯一允许 block 的门控点）
  | 'tool_result'  // 工具执行返回后
  | 'agent_spawn'  // 子代理派生（支持 around continuation）
  | 'turn_settled' // 回合终态（completed | failed | aborted 统一覆盖）
```

| Hook | 触发时机 | 典型应用 | 允许的控制流 |
| :--- | :--- | :--- | :--- |
| `trigger` | 外部事件投递入站 | ThreadKey 直通 Worker、定向投递 | `continue / transform / handled` |
| `input` | 输入提交 | 输入审计、上下文预处理 | `continue / transform / handled` |
| `before_turn` | 回合推理前 | 注入记忆段落、动态增删工具 | `continue / transform` |
| `tool_call` | 工具执行前 | 权限门控、敏感参数二次确认 | `continue / transform / handled / block` |
| `tool_result` | 工具返回后 | 产物登记、结果格式化 | `continue / transform / handled` |
| `agent_spawn` | 子代理派生 | 接管外部运行时或包裹隔离生命周期 | `continue / transform / handled` + `around` |
| `turn_settled` | 回合终态结算 | 向中枢汇报、更新召回图谱 | `continue / transform / handled` |

四种控制流的语义：`continue` 放行；`transform` 原地改写载荷交由后续处理器与内核消费；`handled` 短路接管并终止默认行为；`block` 门控拦截并附带显式 reason（仅 `tool_call` 允许）。非法产物——缺 action、未知 action、该钩子不允许的组合、`transform` 缺 value、`block` 缺 reason——在宿主处显式抛 `invalid_hook_result`，绝不静默当 continue。内核不内置巡检定时器，也不存在 `watchdog_tick` Hook：周期性巡检由插件自管服务调度，终端侧诊断由 `builtin:herdr` 经通用进程内事件（`diagnostics.collect`）采集。

### agent_spawn 的 around 包装器

`agent_spawn` 额外提供受控 continuation（第二参数 `next`），这是编排类插件包裹资源生命周期的关键机制：

- 不调用 `next` 而返回 `handled` = 完全接管（`builtin:herdr` 用此路径把派生请求改道到远端 Herdr 窗格）；
- `await next(finalRequest)` = around 包裹：宿主恰好一次执行后续管道与原生执行行，插件可在 `next` 前分配资源、在 `next` 后按成败收敛（finally 语义）。`builtin:workflow` 以 priority 200 注册（先于 herdr 的 100 执行 = 更外层），在 `next` 前分配 Worktree、在 `next` 后按结果决定保留或清理；
- `next` 仅可调用一次，重复调用或与 `handled/transform` 混用显式拒绝；包裹期间抛错如实上抛，宿主不吞。

`AgentSpawnRequest.isolation`（如 `'worktree'`）是插件层策略 metadata，内核不解释该值：由具备对应能力的插件经 continuation 改写最终请求的 cwd/元数据兑现；无插件兑现而原样到达原生执行行时显式返回 `unsupported_runtime`，绝不静默忽略。

## 前端：全界面扩展点（client.tsx 单轨）

视图类扩展点统一采用 `client.tsx` React 组件单轨：`UiSpecBase` 只接受 `client: ClientComponentRef`（模块相对路径 + 具名导出），不再接受声明式 JSON Spec——JSON 渲染能力由 `builtin:json-render` 插件提供。组件与宿主共享同一份 React 运行时（`@helm/plugin-client` 虚拟化为全局命名空间，不打包第二份 React）。运行时元数据（`profileRuntime`）与输入补全（`composerCompleter`）是纯数据声明，不涉及组件。

`ctx.ui` 全部 16 个注册方法：

| 方法 | surface | 说明 |
| :--- | :--- | :--- |
| `sidebarItem(spec)` | `sidebar.item` | 左栏导航项；`target` 如 `'conversation:1'`、`'conversation:profile:superagent'`、`'screen:builtin:superagent/recall-graph'` |
| `sidebarSection(spec)` | `sidebar.section` | 可折叠分组；`filterTag` 过滤会话（如已归档 worker 分组） |
| `screen(spec)` | `screen` | 全屏自定义视图，支持左右 Split View 并排展示 |
| `timelineRenderer(spec)` | `timeline.renderer` | 按 `kinds`（entry kind 列表）与 `matchMeta`（`data.renderer` 匹配，AND 组合）接管时间线条目 |
| `markdownCodeBlock(spec)` | `markdown.codeBlock` | 按围栏语言（`languages` 精确匹配小写化）接管 Markdown 代码块渲染 |
| `toolView(spec)` | `tool.view` | 按 `toolNames` 接管工具调用卡片；`replaceRow: true` 时完全替换外层默认工具行 |
| `composerPill(spec)` | `composer.pill` | 输入框下方快捷药丸按钮 |
| `composerWidget(spec)` | `composer.widget` | 展开式输入区小部件（组件收 `ComposerScopeProps.composer` 受控句柄） |
| `composerCompleter(spec)` | `composer.completer` | `@ / # / :` 触发的候选数据源（纯数据，无 client） |
| `artifactPreviewer(spec)` | `artifact.previewer` | 按 `mimeTypes`（精确或 `type/*`）或 `extensions`（含点号小写后缀，OR 组合）匹配产物预览 |
| `workbenchPanel(spec)` | `workbench.panel` | 会话右侧抽屉面板；`badge` 声明 doc 驱动的动态角标 |
| `command(spec)` | `command` | 全局命令（⌘K）；`slash` 同时派生输入框 `/xxx` 菜单 |
| `settingsPanel(spec)` | `settings.panel` | 设置面板（同一插件可声明多个） |
| `profileRuntime(spec)` | `profile.runtime` | Profile 外部运行时元数据（id/kind/label/icon/agentSuggestions） |
| `action(spec)` | `ui.action` | 统一微操作：`target: 'conversation:header' \| 'conversation:row' \| 'timeline:entry'` |
| `slot(spec)` | `plugin.slot` | 向 `<ownerPluginId>/<slotName>` 子插槽注入组件 |

### priority 裁决与公共约束

`timelineRenderer`、`toolView`、`markdownCodeBlock`、`composerCompleter` 与 `artifactPreviewer` 均支持 `priority`：数值较大者优先，缺省 0，同优先级保持贡献顺序。高优先级插件停用后由剩余候选接管；`markdownCodeBlock` 同一插件重复声明同 `id` 时以最后一次为准。`command.slash` 不得占用宿主保留词（`new / clear / compact`）与 `skill:` 命名空间，也不得与其他启用插件重名。所有 `spec.scope`（`ConversationScope`：conversationIds/tags/profileIds/modelProviders 字段间 AND、字段内 OR）同时约束可见性与执行。

### 参数化视图与输入区受控句柄

Screen 组件接收 `ScreenProps`：`pluginId / screenId / isSplit / params / setParams`。主屏参数在 URL Hash 中编码为 `sp.<key>`，分屏参数编码为 `ssp.<key>`——两边展示同一 Screen 时参数互相独立。`setParams(patch)` 默认替换历史记录，值为 `undefined` 删除对应键，`{ push: true }` 新增历史记录；组件不得直接操作 `history` 或自建路由。

输入区组件通过 `ComposerScopeProps.composer` 获得受控句柄：

```typescript
export interface ComposerController {
  readonly draft: string
  readonly attachments: ReadonlyArray<ConversationAttachmentRef>
  readonly sending: boolean
  setDraft(text: string): void
  insertText(text: string): void
  submit(text?: string, options?: { whenBusy?: WhenBusy }): Promise<void>
}
```

省略 `submit` 的文本参数时提交当前草稿及附件；显式提供文本时不消费原草稿；失败必须经 Promise 拒绝并展示诊断，不得视作发送成功。输入区子插槽继承同一控制器。

### 微操作、宿主保留插槽与产物预览

微操作 `ctx.ui.action({ target, actionId?, client?, ... })` 以 target 区分三类容器：`conversation:header`（顶栏，`placement: 'toolbar' | 'menu'` 直出按钮或收纳菜单）、`conversation:row`（左栏会话行菜单）、`timeline:entry`（消息操作栏，`kinds`/`roles` 过滤）。声明 `actionId` 时由宿主代管按钮、pending 状态与失败通知（`actionPluginId` 可显式指向另一插件）；声明 `client` 时自渲染。`actionId` 与 `client` 二选一，两者皆缺在注册边界拒绝；调用上下文固定为实际会话，`input` 不得覆盖宿主注入的 `conversationId` / `entryId`。

宿主保留两个详情子插槽常量：`PROFILE_DETAIL_SECTION_SLOT`（`builtin:profile/detail-section`，传 `ProfileDetailSlotProps`：`profileId / isNew / disabled`）与 `NODE_DETAIL_SECTION_SLOT`（`builtin:node/detail-section`，仅已有节点挂载，传 `NodeDetailSlotProps`：`nodeId / isLocal / isOnline / isNew: false`；`builtin:node` 是宿主保留命名空间，不代表节点底座依赖同名插件）。插槽不传接入令牌，也不隐式借用当前会话。空白会话引导是 `Profile.starters` 静态配置（最多六项，label ≤ 24 码点、prompt ≤ 4000 码点），不是 UI 扩展点。

`artifactPreviewer` 组件收到 `ArtifactPreviewerProps`：`size` 来自真实 Blob；`name` 未获得元数据时省缺（不用 artifactId 冒充）；`text` 仅提供最多 1 MiB 的解码文本，二进制或超限为 `null`；`blobUrl` 由宿主管理生命周期，插件不得撤销。插件预览保留宿主默认视图与下载；插件失败显示诊断而非改用其他内容冒充。`client.tsx` 是可信代码，不因进入产物预览而成为沙箱——展示不可信 HTML 必须用 `iframe sandbox` 且默认不授予脚本、同源、表单或导航权限；禁止把产物 HTML 直接注入宿主 DOM。

### 输入补全数据源

`composerCompleter` 是可序列化数据声明（`Omit<UiSpecBase, 'client'>`），不接受 client 回调。`trigger` 为 `'@' | '#' | ':'`（`/` 保留给宿主命令与技能）。`source` 三种：

- `{ kind: 'action', actionId, actionPluginId? }`：绑定声明为 `idempotent: true` 的查询动作，输入 `{ query, conversationId }`，输出 `{ items: ComposerCompletionItem[] }`。目标节点与目录由服务端读取真实会话解析，不信任浏览器自报坐标。
- `{ kind: 'doc', name, itemsField }`：读取贡献插件自己的公开文档顶层数组字段。
- `{ kind: 'sessionDoc', name, itemsField }`：同上，但按会话分片、按需订阅，不进全局广播。

每个候选提供 `id / label / insertText` 与可选 `hint / icon`；选中仅替换光标前的触发词，不提交输入或执行命令。异步查询防抖并防止旧请求覆盖新会话、新草稿或已停用源。动作源复用既有 Action HTTP 端点，不新增补全专用 RPC。

### 插件间组合

插件视图可从 `@helm/plugin-client` 导入 `<PluginSlot name="cards" />`，其他插件用 `ctx.ui.slot({ id, target: 'owner-plugin/cards', ... })` 注入；短名相对当前插件，全限定名显式指定。`mode="list"` 渲染全部命中贡献（priority 降序、order 升序稳定排列），`mode="single"` 只取第一项；每个子项重新绑定贡献者插件上下文并有独立错误边界；循环引用与过深嵌套显示错误提示，不继续递归。

## client.tsx 单轨渲染机制

组件经 `ClientComponentRef { module, export }` 声明：`module` 是相对插件 `clientRoot` 的源文件路径（禁止绝对路径与 `../` 越根），`export` 是具名导出名。产品层注入 `@helm/plugin-build` 的构建实现，由它使用 esbuild 按源内容 hash（含本地依赖）编译缓存；内核只消费构建端口，编译产物不打包第二份 React。插件定义未声明 `clientRoot` 时，一切 client 引用在注册边界拒绝——不存在无法编译的悬空引用。受控 npm 依赖统一经 `npmDependencies`（说明符 → 解析根）声明：内置插件指向 `@helm/plugins` 包根；外部插件在清单声明 `clientDependencies`（plugin.json 或 package.json `helm.clientDependencies`，说明符为裸包名/子路径），宿主归一映射到插件自身目录（`<插件目录>/node_modules`）并走同一编译链（doctor / 受管 install/update / reload / 运行期同一口径），编译器逐文件 containment 校验并随依赖 hash 复查——未声明的裸依赖显式拒绝，已声明未安装给出可诊断错误，不放开任意裸依赖。

插件自有样式的托管链：本地 CSS 及根内 `@import` 由 esbuild 合并，通过保留导出 `__helmClientCss`（`PLUGIN_CLIENT_CSS_EXPORT`）内联为插件 JS 文本数据；宿主确认模块导入成功且加载仍有效后注入 `<style data-helm-plugin-css>`，入口更新时替换，停用/卸载或登出时回收。宿主样式表不承载插件业务类；资源 URL 支持 `data:` 与显式 HTTP(S)/协议相对地址，本地资源 URL 与远程 `@import` 显式拒绝。编译、导出校验或加载失败时宿主显示明确错误与重试入口，不把空白静默冒充加载成功。

`builtin:json-render` 与 `builtin:mermaid` 是扩展点之上的普通消费者：前者承载 JSON DSL、求值器、界面原语与生成式技能，停用后宿主不再解析插件 JSON Spec；后者经 `ctx.ui.markdownCodeBlock({ id, languages: ['mermaid'], client })` 接管 ```mermaid 围栏，停用后回退普通代码块。两者停用时动作、工具与 UI 贡献即时消失，无内存降级或宿主内置替代渲染。

## 公开数据与会话分片投影

`ctx.doc(name, initial, { public: true })` 进入全局 SSE 首帧 `pluginDocs` 与 `plugin.doc.updated` 广播，适合全局设置或紧凑导航摘要（如 `builtin:workflow` 的 `run-badges` 只含计数、色调与底部短文案）。私有文档不公开。句柄的 `get/set/update` 同步镜像，`flush()` 等待底层排队写真正落盘——副作用执行前必须 `await flush()`，防止「未落盘就派生副作用」。

`ctx.sessionDoc(name, initial, { public: true })` 按 `conversationId` 持久化分片：不进全局首帧，也不向普通 `/api/events` 发送会话文档事件。读写句柄为 `get/set/update/delete(conversationId, ...)` 加 `listConversationIds()`；会话删除清理其文档，过期句柄或删除后的写入报错。客户端 `usePluginSessionDoc(name)` 使用当前槽位会话，也可显式指定 `{ conversationId, pluginId }`；同一文档的多个挂载组件共享订阅，引用归零时断开。专用 SSE 首帧提供当前值与水位，后续只传该元组的更新，重连重新取首帧。

HTTP 与 CLI 同权访问会话文档：

```bash
# 一次读取
curl "$HUB_HUB_URL/api/plugins/builtin%3Aworkflow/docs/runs?conversationId=42"
helm plugins doc builtin:workflow runs --conversation 42 --json
helm plugins doc builtin:workflow runs --current --json        # 从 HELM_CONVERSATION_ID 解析

# 持续订阅（专用 SSE：GET /api/plugins/:id/docs/:name/events?conversationId=N）
helm plugins doc builtin:workflow runs --current --watch --json
```

`builtin:workflow` 是这一投影模型的基准用例：完整运行摘要放入会话文档 `runs`（每会话只写自己的 run）；全局 `workflow.updated` 事件仅含 `id / conversationId / status` 提示，不旁路广播完整摘要；`workflow.settled` 经 `ctx.host.emitEvent(..., { broadcast: false })` 仅交给进程内监听器并等待终态清理完成；摘要无变化时不重复发布。这样全局首帧与广播通道免于运行详情的写放大，而 `runs` 明细按需订阅。
