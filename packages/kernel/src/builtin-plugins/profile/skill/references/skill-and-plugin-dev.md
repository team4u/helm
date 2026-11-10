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

目录结构（入口二选一）：`plugin.json` 声明 `{ "id": "my-plugin", "main": "index.mjs" }`，或直接放约定入口（index.mjs / index.js / plugin.mjs / plugin.js）。

服务端入口直接导出符合 PluginDefinition 的对象，其中 definePlugin(ctx) 注册能力；无需运行时包装函数或前端包导入：

```js
// ~/.helm/plugins/my-plugin/index.mjs
export default {
  id: "my-plugin",
  name: "我的插件",
  version: "0.1.0",
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
    ctx.ui.screen({
      id: "main", label: "计数器", docs: ["state"],
      json: { component: "Card", title: "计数器", children: [
        { component: "Text", text: "{$docs.state.count}" },
        { component: "Button", label: "加一", action: { type: "helm:action", actionId: "increment", input: {} } },
      ] },
    })
  },
}
```

扩展入口：
- 后端 Hook（{{HOOK_COUNT}} 个）：{{HOOK_NAMES}}；各 Hook 允许的 continue/transform/handled/block 结果以 protocol 契约为准。
- 前端 {{UI_METHOD_COUNT}} 个 ctx.ui 注册方法：基础 10 个（sidebarItem/sidebarSection、screen、timelineRenderer、toolView、composerPill/composerWidget、workbenchPanel、command、settingsPanel）+ 三类微操作（conversationHeaderAction/conversationRowAction/timelineEntryAction：绑 actionId 后宿主代管按钮/pending/失败提示，scope 按标签过滤会话，kinds/roles 过滤消息条目；宿主注入的真实 conversationId/entryId 强制覆盖 input 同名字段）+ profileRuntime（Profile 外部运行时元数据，宿主通用表单渲染）+ slot（向 `owner/插槽名` 注入内容供其他插件 `<PluginSlot />` 或声明式 `Slot` 原语消费）。
- timelineRenderer/toolView 支持 priority（降序裁决，缺省 0；高优先级插件停用后剩余候选自动接管）；同一插件可声明多块 settings.panel（order 排序）。
- command 的 slash（不含 / 的触发词）同时派生输入框 `/` 补全：保留词 {{RESERVED_SLASH_COMMANDS}} 与 skill: 前缀禁占，跨启用插件不得重名，声明 slash 必须绑定本插件 actionId（跨插件动作用 actionPluginId）。
- screen 组件收到 params/setParams：URL Hash 中主屏 `sp.<key>`、分屏 `ssp.<key>` 命名空间隔离，同屏双开互不串扰；setParams 默认 replace，`{push:true}` 入栈；组件不得自建路由或直接操作 history。
- composer.pill/widget 收到受控句柄 composer（draft/attachments/sending、setDraft/insertText/submit；submit() 失败 reject 且保留草稿）。
- `ctx.action({ id, description, inputSchema, outputSchema, idempotent?, handler })` 将 Schema 动作统一映射到 HTTP、CLI、Workflow action()、Web；`idempotent: true` 标记只读/幂等动作，失败或中断时允许工作流断链重跑；模型可经 run_action 调用，设置 exposeAsTool: true 才直接列为工具。
- `ctx.host.execEnv(req, opts?)` 经内核 EnvFabric 跨节点执行命令（复用 local / 远端 @helm/node 通道、SecretStash 注入与脱敏），纳入在途任务追踪（withTask）。
- `ctx.doc(name, initial, { public: true })` 公开持久全局状态（进全局 SSE 首帧，更新广播全量）；界面通过 docs 列表订阅。`ctx.configSchema` 的 secret 字段进入凭据存储，避免公开到 doc。
- `ctx.sessionDoc(name, initial, { public: true })` 按会话分片持久状态：句柄 `get/set/update/delete(conversationId, ...)`；不进全局首帧与全局广播，公开时经专用 SSE（`GET /api/plugins/:id/docs/:name/events?conversationId=N`）只推给订阅该会话的客户端；会话删除级联清理，删除后写入被拒。会话级 UI 状态（如每会话任务列表、运行详情）一律用 sessionDoc 而非 doc，避免全局写放大；doc 与 sessionDoc 禁止同名。
- `ctx.service({ id, start, stop })` 管理后台服务；声明 liveTasks 可在停用前报告在途任务。

要点：
- 外部插件 id 禁止 `builtin:` 前缀、禁止与已注册插件重名、不可自封 locked；放入目录后重启 Hub 自动发现并默认停用注册。
- 启用：`helm plugins enable my-plugin`；修改入口代码后需重启 Hub 重新导入。停用/启用仅重建已有定义的生命周期。停用或卸载遇在途任务会显式拒绝（409 plugin_has_live_tasks）。
- 不要在自己的回合内重启 Hub；先完成结果交付，再安排进程重启。
- 前端 React 组件（client.tsx）经 esbuild 动态编译，可 import react / react-dom / lucide-react / @helm/plugin-client（宿主共享实例，不打包第二份 React）。
- 共享 Hook：useToolActivity(callId, active) 报告所在时间线回合的工具后台活动；usePluginDoc(name, pluginId?) 响应式订阅公开全局文档（可跨插件寻址）；usePluginSessionDoc(name, {conversationId?, pluginId?}?) 按当前会话订阅公开会话文档（多组件共享订阅，引用归零退订，重连首帧恢复）；<PluginSlot name> 声明子插槽；usePluginContext() 提供 callAction(actionId, input, {pluginId?, conversationId?})（可跨插件）、submitInput(text, {conversationId?, whenBusy?})、openScreen/openSplitScreen/openConversationDrawer/openArtifact/openWorkbench、notify 等。
- 插件视图样式写在 clientRoot 内本地 .css（import 引入，esbuild 合并为保留导出 __helmClientCss，宿主托管注入与回收），不得写宿主 styles.css。
- UI 文案严禁 Emoji；图标用 lucide 图标名。
- 完整扩展点与双轨机制见仓库内 docs/architecture/extension-points.md 与 docs/plugins/plugin-development.md。

### sessionDoc 示例（每会话分片）

```js
definePlugin(ctx) {
    // 每会话独立分片：只在订阅该会话的客户端间流动，不广播全局
    const metrics = ctx.sessionDoc("metrics", { count: 0 }, { public: true })
    ctx.action({
      id: "increment",
      inputSchema: { type: "object", properties: { conversationId: { type: "integer" } }, required: ["conversationId"], additionalProperties: false },
      handler(input) {
        metrics.update(input.conversationId, (current) => ({ count: current.count + 1 }))
        return metrics.get(input.conversationId)
      },
    })
    // 声明式轨道按当前会话订阅；client.tsx 用 usePluginSessionDoc("metrics")
    ctx.ui.workbenchPanel({
      id: "metrics", label: "会话指标", sessionDocs: ["metrics"],
      json: { component: "Text", text: "{$sessionDocs.metrics.count}" },
    })
  }
```
