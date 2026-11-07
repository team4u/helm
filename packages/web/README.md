# Helm Web 界面基线

`@helm/web` 是面向人类使用的主控台。后续插件界面沿用此包的布局、语义色、控件与声明式渲染协议。

## 启动与验证

```bash
# 从仓库根目录启动 Hub（3202）与 Web（3201）
pnpm dev

# 分别启动
pnpm dev:kernel
pnpm dev:web

pnpm build
pnpm typecheck
timeout 60s pnpm test
```

Vite 只占用 `3201`，并代理 `/api` 到 `HELM_PORT`（缺省 `3202`）。Hub 和 Web 均默认只监听本机。构建产物在 `packages/web/dist`；目前 Hub 不托管该静态目录，可通过反向代理同源提供静态页面与 `/api`。

## 视觉与布局

- `src/styles.css` 定义 Quiet Surface 的全部基础变量和控件。`src/responsive.css` 统一窄面板、移动端、焦点和减少动画偏好。
- 桌面使用 248px 导航栏、主工作区、可选并排视图、340px 工作台。视口不足时，工作台改为覆盖式抽屉；小屏导航收进菜单，双视图改为上下排列。
- AI 正文直接铺在画布上。人类消息使用浅底胶囊。普通工具调用和结果合为 26px 一行，点击后查看完整入参与输出。
- 业务卡、失败工具、子代理入口和工作流摘要直接展示。长代码保持完整，横向滚动；不在复制或渲染前截断。
- 全界面使用纯文本和 `HelmIcon` 线性图标。颜色通过 `--fg`、`--fg-muted`、`--bg`、`--border`、`--accent`、`--ok`、`--warn`、`--err` 等语义变量取用，禁止插件自行硬编码另一套明暗色板。

## 插件如何复用

轻量界面优先使用 `ctx.ui` 的 JSON Spec。宿主已经消费全部 10 个注册方法，对应协议中的 7 类扩展点：侧栏条目/分组、全屏、时间线、工具、输入框胶囊/挂件、工作台、命令面板/设置。

```ts
ctx.ui.screen({
  id: 'jobs',
  label: '任务',
  icon: 'layers',
  docs: ['jobs'],
  json: {
    component: 'Stack',
    children: [
      { component: 'Text', variant: 'title', text: '任务列表' },
      {
        component: 'Table',
        columns: [
          { key: 'conversationId', label: '会话' },
          { key: 'title', label: '标题' },
        ],
        rows: '{$docs.jobs.rows}',
        rowActions: [{
          label: '并排查看',
          action: {
            type: 'helm:open',
            target: 'conversation:{$row.conversationId}',
            split: true,
          },
        }],
      },
    ],
  },
})
```

`docs` 必须引用插件已声明为 public 的文档。宿主先加载文档，再随 `plugin.doc.updated` 更新组件。组件树也支持 `{ root, elements }` 扁平形态。

### 标准原语

| 类别 | 组件 |
| --- | --- |
| 布局 | `Stack`、`Card`、`MetricGrid`、`Tabs`、`Accordion` |
| 展示 | `Text`、`Badge`、`Markdown`、`MetricCard`、`KeyValueList`、`Callout`、`Steps`、`BarList`、`Table` |
| 表单与动作 | `TextInput`、`Select`、`Switch`、`CheckboxGroup`、`Button`、`ActionBar` |

宿主动作是 `helm:action`（插件动作）、`helm:open`（会话或 screen，可分屏）、`helm:send`（提交消息）。完整属性以 `src/ui/spec-primitives.tsx` 和 `src/ui/spec-action.ts` 为准。

绑定支持 `{$docs.index.workers}`、`{$docs["recall-graph"].nodes}` 和 `/$docs/index/routerConversationId`。整串绑定返回数组、布尔、数字等原始值；混合文本才做字符串插值。表格动作在点击时才注入 `$row`；表单动作通过 `$value` 取得新值。

### React 控件与通用样式

复杂的宿主界面使用以下统一类名：

| 用途 | 入口 |
| --- | --- |
| 页面骨架 | `.helm-pane`、`.pane-topbar`、`.timeline-scroll` |
| 按钮 | `.btn` + `.btn-primary` / `.btn-danger` / `.btn-ghost` / `.btn-sm` |
| 状态 | `.badge` + `.badge-neutral` / `.badge-accent` / `.badge-ok` / `.badge-warn` / `.badge-err` |
| 数据 | `.list > .row`、`.jr-table-wrap > .jr-table`、`.tabular-nums` |
| 表单 | `.input`、`.select`、`.textarea`、`.config-fields` |
| 对话框 | `.modal-backdrop > .modal`、`.modal-header`、`.modal-body`、`.modal-footer` |
| 左右配置页 | `.asset-modal-body`、`.asset-modal-list` |

对话框需有 `role="dialog"`、`aria-modal="true"` 和名称；图标按钮必须带名称；字段的 label 必须关联 input。使用 `ModalFocusScope` 维护 Tab 焦点及关闭后返回。`.tsx` 只导出组件，数据转换和可测试逻辑放在 `.ts`。

## 数据和交互边界

- `src/lib/api.ts` 是 HTTP 唯一入口，携带 Bearer token。`/api/models` 返回 provider/modelId/available，客户端在边界生成用于选择的完整 ID。
- `src/lib/live-state.ts` 按 SSE `seq` 处理快照和增量，忽略重复帧，缺帧或格式异常时重连。重新连接后重取可见会话详情与插件文档，避免展示断线期间的旧状态。
- `helm.input` 作为输入显示来源；原生重复输入去重。工具按 callId 配对。搜索返回的 `input:<submissionId>` / `entry:<id>` 会映射到真实时间线条目，必要时继续加载历史分页。
- Profile PUT 整体替换基础配置。系统提示词与记忆仅在用户编辑过时提交，避免改名称覆盖后台新记忆。已配置密钥用占位提示呈现，未修改时不把 `******` 发回服务端。
- 文件上传期间禁止发送，15 MiB 超限给出明确错误。预览和下载通过带鉴权 fetch 取得 Blob，组件卸载时释放 ObjectURL。未知文件类型提示下载，不冒充文本。
- `ViewBoundary` 隔离声明式卡片的渲染错误。加载失败、连接中断、未配置模型都显示明确状态。

## 当前交付范围

个人助理对话、附件、审批、模型选择、搜索与分叉、角色与凭据编辑、插件设置、Herdr 总览、SuperAgent 图谱及 JSON Spec 扩展点已接入。Herdr/SuperAgent 的界面读取已有插件契约；触发器业务继续由其负责的 Agent 开发，Web 通用 screen 可渲染其 JSON Spec。

外部插件的 `client.tsx` 编译和动态加载尚未接通，当前会明确提示需要 JSON Spec；`window.__HELM_SHARED__` 不能视为已完成外部组件宿主。浏览器验收中的模型回复由 SDK faux provider 提供，不代表真实服务商模型联通验收。

## 可重复的浏览器验收服务

```bash
pnpm build
node scripts/web-acceptance.mjs
# 另一终端运行 pnpm dev:web，再访问 http://127.0.0.1:3201
```

该脚本新建独立临时数据目录、生成临时密码并打印，使用真实内核/SQLite/HTTP、真实本地 bash 工具、85 轮分页历史，以及一个临时注册的 JSON Spec 样例插件。样例包含表格行导航、布尔动作与 public doc 更新。它不读取用户运行数据，也不注册到生产实例。按 Ctrl+C 关闭服务；临时目录保留便于排查。
