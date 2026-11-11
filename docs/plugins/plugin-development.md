# 自定义插件开发实战

本文是外部插件的全栈开发指南：从脚手架初始化、后端 `definePlugin(ctx)` 编写、前端 `client.tsx` 单轨开发，到静态自检、受控热重载与受管包安装的完整闭环。插件系统设计与契约总览见 [overview.md](overview.md)；前端扩展点细节见 [extension-points.md](../architecture/extension-points.md)。

## 插件目录与 plugin.json 清单

外部插件统一存放在 `~/.helm/plugins/<pluginId>/`（`HELM_DATA_DIR` 覆盖时随数据目录）。推荐结构：

```text
~/.helm/plugins/sample-plugin/
├── plugin.json        # 插件清单（元数据与入口配置）
├── index.ts           # 后端入口（export default PluginDefinition）
├── tsconfig.json      # 本地类型检查配置（编辑器与 CI 用，运行时不依赖）
├── package.json       # 可选：npm 依赖声明
└── client/            # 前端组件源码目录（clientRoot）
    ├── index.tsx
    └── styles.css
```

```json
{
  "id": "sample-plugin",
  "name": "示例业务插件",
  "version": "1.0.0",
  "main": "index.ts",
  "clientRoot": "./client"
}
```

清单约束：`id` 仅允许字母、数字、下划线与连字符，**禁止冒号**（冒号保留给 `builtin:` 命名空间）与 `builtin:` 前缀；外部插件禁止 `locked`（宿主加载时自动剥离）；`main` 缺省时按约定顺序探测 `index.ts / index.tsx / index.mjs / index.mts / index.js`（TypeScript 优先），也支持 `package.json` 的 `helm.main` / `main` 回落（`.js` 后缀自动重写同名 TS 源）。`clientRoot` 缺省为插件目录本身，必须是插件目录内的非空相对路径。首次注册默认停用，经 `helm plugins enable` 显式激活。

## 开发闭环四步曲

### ① 脚手架：`helm plugins init`

本地命令（不访问 Hub），在目标目录生成插件骨架：

```bash
helm plugins init my-plugin                          # 生成到 ~/.helm/plugins/my-plugin/（默认 full 模板）
helm plugins init my-plugin --dir ~/code             # 生成到 ~/code/my-plugin/
helm plugins init my-plugin --template minimal       # 仅后端探针动作（无前端文件）
```

full 模板产出 `plugin.json`（含 `clientRoot: "./client"`）、`index.ts`（doc 与 `increment` 动作示例）、`tsconfig.json`、`client/index.tsx`（引入 `@helm/plugin-client` 共享 Hook 的示例面板）与 `README.md`；minimal 模板不含 `clientRoot` 与前端文件。目标目录非空时默认拒绝，`--force` 继续（同名文件被覆盖）。

### ② 后端：TypeScript 源码免构建直接加载

后端入口导出定义对象（外部加载器只接受对象形式的默认导出，不接受工厂函数）：

```typescript
import { type PluginDefinition } from '@helm/protocol';

export default {
  id: 'sample-plugin',
  name: '示例业务插件',
  version: '1.0.0',
  definePlugin(ctx) {
    // 1. 配置 Schema（secret: true 自动分离至 credentials.json 并入 SecretStash）
    ctx.configSchema({
      apiKey: { type: 'string', secret: true, description: '远端服务认证密钥' },
      retryCount: { type: 'number', default: 3 },
    });

    // 2. 持久状态文档
    const statsDoc = ctx.doc('stats', { totalCalls: 0 }, { public: true });

    // 3. 单点 Schema 动作（五端复用）
    ctx.action({
      id: 'send_notice',
      description: '发送业务通知消息',
      inputSchema: {
        type: 'object',
        properties: { target: { type: 'string' }, content: { type: 'string' } },
        required: ['target', 'content'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { success: { type: 'boolean' } },
        required: ['success'],
        additionalProperties: false,
      },
      exposeAsTool: true,
      async handler(input) {
        statsDoc.update((s) => ({ ...s, totalCalls: s.totalCalls + 1 }));
        return { success: true };
      },
    });

    // 4. 后台服务与在途任务声明
    let activeJobs = 0;
    ctx.service({
      id: 'worker-service',
      async start() {},
      async stop() {},
      liveTasks() {
        return activeJobs > 0 ? [`job-count:${activeJobs}`] : [];
      },
    });
  },
} satisfies PluginDefinition;
```

加载机制：宿主基于 Node 24 `module.registerHooks` 钩子加载源码，对 `.ts` / `.tsx` 文件用 esbuild transform（不打包），按依赖闭包逐文件转译。`import.meta.url` 始终指向插件目录内的真实源文件；裸 npm 说明符从插件自身目录解析（可自带 `node_modules`），`@helm/*` 协议包与宿主共享同一实例、不重复加载。加载器不承诺解析 `tsconfig` 的 `paths` 别名，插件源码不要依赖。插件根注册成功后常驻宿主进程；停用不卸载已加载模块（同进程重新启用不重复初始化），完全重载代码走 `helm plugins reload`。`definePlugin` 顶层不要调用 `ctx.host.*` 运行时能力（doctor 的 register 检查会如实失败）——宿主调用应放入动作处理器、服务生命周期或钩子内。

### ③ 前端：client.tsx 单轨与共享 SDK

视图类扩展点统一采用 React 组件单轨（`UiSpecBase` 只接受 `client: ClientComponentRef`，不再接受声明式 JSON Spec）。需要纯数据驱动界面时依赖 [`builtin:json-render`](json-render.md) 的能力，不在视图声明中写 `json` 字段。

组件从 `@helm/plugin-client` 导入共享能力——该说明符被编译器虚拟化为宿主全局命名空间（`globalThis.__helm_shared_plugin_client`），绝不打包第二份 React。可导入符号清单（`PLUGIN_CLIENT_SHARED_EXPORTS` 唯一真源）：

| 分类 | 符号 |
| :--- | :--- |
| Hooks | `usePluginContext`（`callAction / submitInput / openConversationDrawer / openArtifact / openWorkbench / notify / theme / composer` 等）、`usePluginDoc(docName, pluginId?)`、`usePluginSessionDoc(docName, options?)`、`useConversations()`、`useConversation(id)`、`useToolActivity(callId, active)` |
| 无障碍底座组件 | `Switch`、`Select` / `MultiSelect`、`Checkbox`、`Tabs` 系列、`SegmentedControl`、`Dialog` 系列、`ViewBoundary`、`Callout` |
| 布局原语 | `Screen`、`ScreenSection`、`DataTable`、`KvGrid`（见下方速查） |
| 内容展示 | `HelmIcon`（lucide 线性图标宿主封装）、`MarkdownView`、`CodeBlockView`、`CopyButton` |
| 插件间组合 | `PluginSlot` |

#### 布局原语速查（优先复用，不要手写 CSS）

全部为组合式、无状态、SSR 安全（无 Portal、无浏览器副作用），只复用宿主通用类，不引入新 CSS 主题：

| 原语 | 用途 | 关键 Props |
| :--- | :--- | :--- |
| `Screen` | 全屏页面容器 + 页头 | `title` / `subtitle` / `actions`（可组合页头）；需要图标等复杂页头时传 `header` 整体替换 |
| `ScreenSection` | 页面分节 | `title`（分节标题）、`titleExtra`（标题右侧补充） |
| `DataTable` | 表格外壳，统一 loading/empty | `loading` / `loadingLabel`、`empty` / `emptyLabel`、`columns`（占位行 colSpan，缺省自动推断）；表头与数据行由 children JSX 自由表达 |
| `KvGrid` | 键值概览两列网格 | `items: Array<{ key, value }>` |

```tsx
import { usePluginDoc, HelmIcon, Screen, ScreenSection, DataTable, KvGrid } from '@helm/plugin-client';

export function SampleWidget() {
  const stats = usePluginDoc<{ totalCalls: number; failedCalls: number }>('stats');
  const rows = usePluginDoc<Array<{ id: number; name: string }>>('rows');
  return (
    <Screen
      title={<><HelmIcon name="activity" size={14} />业务运行状态</>}
      subtitle={<>累计调用：{stats?.totalCalls ?? 0}</>}
    >
      <ScreenSection title="概览">
        <KvGrid
          items={[
            { key: '累计调用', value: stats?.totalCalls ?? 0 },
            { key: '失败调用', value: stats?.failedCalls ?? 0 },
          ]}
        />
      </ScreenSection>
      <ScreenSection title="记录" titleExtra={rows === undefined ? undefined : `共 ${rows.length} 条`}>
        <DataTable loading={rows === undefined} empty={(rows?.length ?? 0) === 0}>
          <thead>
            <tr>
              <th>ID</th>
              <th>名称</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((row) => (
              <tr key={row.id}>
                <td>{row.id}</td>
                <td>{row.name}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </ScreenSection>
    </Screen>
  );
}
```

**样式复用铁律**：通用结构（页面容器、分节、表格、键值概览、提示横幅、加载态）一律优先复用上述原语或宿主通用类；插件本地 `.css` 只写业务特异结构（如 Mermaid 缩放画布、DAG 执行图卡片）。不要为通用结构新增一套 CSS 主题。

后端注册组件引用（module 为相对 clientRoot 的路径、export 为具名导出名）：

```typescript
ctx.ui.workbenchPanel({
  id: 'sample-widget-panel',
  label: '业务监控',
  client: { module: 'index.tsx', export: 'SampleWidget' },
});
```

**样式托管链**：插件业务样式以 clientRoot 内本地 `.css` 导入（`import './styles.css'`），不得写进宿主样式表。编译器用 esbuild 按依赖顺序合并 CSS（支持根内本地 `@import`，根外、符号链接逃逸与远程 `@import` 拒绝），经保留导出 `__helmClientCss` 内联进插件 JS（插件源码不得占用该导出名）；宿主确认模块导入成功后注入 `<style data-helm-plugin-css>`，入口更新时替换、停用/卸载或登出时回收。`url()` 支持 `data:` 内联与 HTTP(S) 绝对地址；本地相对与片段资源 URL 显式拒绝（无插件静态资源端点，请改用内联资源）。可复用宿主设计变量（`var(--fg-muted)`、`var(--border)`）与通用类（`.badge`、`.btn`）。

两条硬纪律：界面文案与状态徽标**严禁 Emoji**，图标统一 lucide 线性名；`client.tsx` 是**可信代码而非安全沙箱**——展示不可信 HTML 必须用 `<iframe sandbox srcDoc>` 且默认不授予脚本、同源、表单或导航权限（不要同时授予 `allow-scripts` 与 `allow-same-origin`），不得直接注入宿主 DOM。

### ④ 自检、发现、热重载与包管理

```bash
# 静态自检（真实执行，不是近似检查）：manifest -> backend 转译 -> register 临时宿主 -> client 编译与导出校验
helm plugins doctor /root/code/my-plugin     # 按目录
helm plugins doctor my-plugin                # 按已注册插件 id

# 增量发现：放入新插件目录后无需重启 Hub（只注册未注册的，默认停用）
helm plugins rescan
helm plugins enable my-plugin

# 受控热重载：不重启 Hub 重载插件代码
helm plugins reload my-plugin
```

`doctor` 四层检查逐项真实执行：manifest 合法性与入口越根、TS 转译与模块代际导入、临时 PluginHost 真实执行 `definePlugin`（与生产同一校验链：action/tool/ui/doc/service/provider 形状、重复、scope）、对声明的全部 client 模块真实编译并校验具名导出真实存在（悬空 `export` 引用在此暴露，不留到运行期渲染空白）。

`reload` 的安全链：在途任务（自定义任务、执行中 Tool、挂起 `agent_spawn`、provider 在途流）`409 plugin_has_live_tasks` 拒绝且先于一切；dry-run 预检对源目录执行完整 doctor，任一失败旧实例保持不动（`422 plugin_reload_preflight_failed` 附完整报告）——坏代码绝不打断在运行插件；预检通过后注销旧实例、以新代际模块图（`?helmgen=<n>` 标记沿相对导入传播，npm 包与 Node 内置不带标记、与宿主共享同一实例）重新注册，新实例注册失败用旧代定义回滚（同一 `definePlugin` 引用，无重复初始化）；启用状态前后保持不变。内置插件禁止热重载（403）。

受管包安装（区别于手放置入目录）：

```bash
helm plugins install npm:<spec>|git:<repo>@<ref>|<https-git-url>|<本地路径> [--enable]
helm plugins update <id>          # 更新受管安装的插件包并重载
helm plugins remove <id> [--yes]  # 停用并清理 Hub 主机安装目录（破坏性，不可恢复）
```

安装启用即在 Hub 内执行可信插件代码，无沙箱；来源语法由 Hub 解析，本地路径相对 Hub 主机。

## 常见进阶模式

### 节点详情子插槽

向已有节点的详情抽屉注入扩展区块（新节点接入表单不挂载）：

```typescript
import { NODE_DETAIL_SECTION_SLOT } from '@helm/protocol';

ctx.ui.slot({
  id: 'node-inspection',
  target: NODE_DETAIL_SECTION_SLOT,
  client: { module: 'client.tsx', export: 'NodeInspectionSection' },
});
```

组件接收 `{ nodeId, isLocal, isOnline, isNew: false }`，按 `nodeId` 调用插件自己的 Action 获取诊断。插槽不传接入令牌、连接命令，也不隐式借用当前会话。`builtin:profile` 的 `PROFILE_DETAIL_SECTION_SLOT` 同理（Props 为 `{ profileId, isNew, disabled }`）。

### 产物预览器

按 MIME 类型或扩展名接管产物预览：

```typescript
ctx.ui.artifactPreviewer({
  id: 'csv',
  label: '数据表',
  mimeTypes: ['text/csv'],
  extensions: ['.csv', '.tsv'],
  priority: 10,
  client: { module: 'client.tsx', export: 'CsvPreview' },
});
```

组件接收 `ArtifactPreviewerProps`：`text` 在二进制或超过 1 MiB 时为 `null`（组件必须明确提示而非展示空表冒充结果）；`blobUrl` 由宿主管理、组件不得撤销；`name` 元数据未就绪时缺省。用户可切回宿主默认预览并下载原件。

### 输入补全源

三种数据源声明（详见 [extension-points.md](../architecture/extension-points.md)）：

```typescript
// doc 源：公开文档顶层数组字段直接作为候选
ctx.doc('references', { items: [...] }, { public: true });
ctx.ui.composerCompleter({
  id: 'references', label: '项目引用', trigger: '#',
  source: { kind: 'doc', name: 'references', itemsField: 'items' },
});

// action 源：远端查询（须声明 idempotent: true）
ctx.ui.composerCompleter({
  id: 'workspace-files', label: '工作区文件', trigger: '@',
  source: { kind: 'action', actionId: 'search_files' },
});
```

action 源的输入 Schema 为 `{ query, conversationId }`，输出 `{ items: Array<{id, label, insertText, hint?, icon?}> }`；服务端从真实会话解析 `(nodeId, cwd)` 坐标查询目标节点，不在浏览器拼接 shell。会话级候选用 `ctx.sessionDoc` + `source.kind: 'sessionDoc'`。补全只插入 `insertText`，不执行、不发送、不审批。

### 配置角色引导词

`Profile.starters` 是纯静态配置（非 UI 扩展点）：

```bash
helm profiles update reviewer --starters '[{"label":"审查改动","prompt":"请审查当前工作区的未提交改动。"}]' --json
helm profiles update reviewer --starters '[]' --json
```

最多六项；label ≤ 24 码点、prompt ≤ 4000 码点。仅真正空白且历史已加载完整的会话显示；点击回填后由用户确认发送，不覆盖草稿与附件。
