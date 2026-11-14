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
  "clientRoot": "./client",
  "clientDependencies": ["chart.js"],
  "dependencies": ["builtin:profile"]
}
```

清单约束：`id` 仅允许字母、数字、下划线与连字符，**禁止冒号**（冒号保留给 `builtin:` 命名空间）与 `builtin:` 前缀；外部插件禁止 `locked`（宿主加载时自动剥离）；`main` 缺省时按约定顺序探测 `index.ts / index.tsx / index.mjs / index.mts / index.js`（TypeScript 优先），也支持 `package.json` 的 `helm.main` / `main` 回落（`.js` 后缀自动重写同名 TS 源）。`clientRoot` 缺省为插件目录本身，必须是插件目录内的非空相对路径。首次注册默认停用，经 `helm plugins enable` 显式激活。

可选字段 `clientDependencies` 与 `dependencies` 同样支持声明在 `package.json` 的 `helm` 字段（`helm.clientDependencies` / `helm.dependencies`，与 plugin.json 同名同义，两边声明合并去重）：

- **`clientDependencies: string[]`** —— 前端受控 npm 依赖说明符（裸包名或子路径，如 `chart.js`、`@scope/pkg/lib.js` 子路径需逐项声明）。宿主把它们映射为「解析根 = 插件自身目录」的受控 npm 依赖：client.tsx 中的同名裸导入会被解析进 `<插件目录>/node_modules` 并逐文件 containment 校验后打进 bundle；未声明的裸依赖编译期显式拒绝，已声明但未安装的依赖在编译期给出「不可解析/未安装」诊断（受管安装/更新会按清单自动补装）。版本建议同时声明在 `package.json` 的 `dependencies` / `devDependencies`（受管安装优先取该 range，保证可复现）。在代码内声明 `npmDependencies`（自指任意解析根）对外部插件无效——宿主一律剥离，前端依赖只认清单声明。
- **`dependencies: string[]`** —— 插件间依赖（仅插件 ID，如 `["builtin:profile"]`，不做版本解析）。启用前依赖必须已注册且已启用（仅注册未启用不满足，缺失/未启用分别报 `plugin_dependency_missing` / `plugin_dependency_not_enabled`）；依赖图成环在注册时拒绝（`plugin_dependency_cycle`）。全局服务启动屏障按依赖拓扑序 prepare/start（被依赖者先启），stop/关停按逆拓扑序。停用被依赖插件时，依赖它的已启用插件会作为 `plugin_in_use` 占用项拦截（传递依赖者同样计入；确认后可 `--force`，强制停用后依赖者会被显式标记为故障态，不会静默潜伏）。注意 `package.json` 顶层的 `dependencies` 保持 npm 运行时依赖语义，不会被误读为插件间依赖。

插件定义对象（代码内）也可直接声明 `dependencies`（与清单声明合并去重）；`PluginSummary`（`helm plugins list --json` / Web 插件中心）会透出归一后的 `dependencies` 字段。

## 开发闭环四步曲

### ① 脚手架：`helm plugins init`

本地命令（不访问 Hub），在目标目录生成插件骨架：

```bash
helm plugins init my-plugin                          # 生成到 ~/.helm/plugins/my-plugin/（默认 full 模板）
helm plugins init my-plugin --dir ~/code             # 生成到 ~/code/my-plugin/
helm plugins init my-plugin --template minimal       # 仅后端探针动作（无前端文件）
helm plugins init my-app --template app              # 全栈微应用骨架（可直接 apps validate/publish）
```

full 模板产出 `plugin.json`（含 `clientRoot: "./client"`）、`index.ts`（doc 与 `increment` 动作示例）、`tsconfig.json`、`client/index.tsx`（引入 `@helm/plugin-client` 共享 Hook 的示例面板）与 `README.md`；minimal 模板不含 `clientRoot` 与前端文件；app 模板产出全栈微应用骨架（public doc + 双 Schema 动作 + `ctx.ui.screen` 主视图 + 侧栏入口，前端仅用宿主原语），生成目录无需发布即可通过 `helm plugins doctor` 与 `helm apps validate`，经 `helm apps publish` 一键发布到应用中心（同形样本：仓库 `apps/todo-demo`）。目标目录非空时默认拒绝，`--force` 继续（同名文件被覆盖）。

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

    // 3. 单点 Schema 动作（五端复用 + 会话动作目录自动发现）
    ctx.action({
      id: 'send_notice',
      description: '发送业务通知消息',
      promptGuidelines: [
        '发送前核对目标与内容；失败时如实报告，不自动重复发送',
      ],
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

#### 动作自动发现与会话目录

动作注册后由运行时自动发现：启用且匹配会话 `scope`、未设置 `exposeAsTool: true` 的动作投射进系统提示 `prompt.actions` 段的 `<available_actions>` 目录，每项含全限定 ID（`pluginId.actionId`）、description、可用 CLI 命令与紧凑参数签名（仅当 `run_action` 元工具存在时生成）。直接暴露的动作在模型工具列表展示，其工具被剥离时也不会借目录重新推荐。内置与外部插件同权——新插件启用后动作自动出现在目录，**无需修改 SYSTEM.md 或任何内置技能**；插件停用、动作注销或对本会话 scope 不可达时条目自动清理，不留幻影提示词。

三种暴露方式的边界：

| 方式 | 会话内形态 | 适用场景 |
| :--- | :--- | :--- |
| 自动发现（缺省） | 仅在 `<available_actions>` 目录列出一条摘要，经 `run_action({ actionId, input })` 按需调用 | 大多数动作；目录成本最低 |
| `exposeAsTool: true` | 派生具有稳定安全别名的独立模型工具（参数 schema 即 inputSchema），不重复列入动作目录 | 高频/需要模型主动选用的动作 |
| `ctx.tool(spec)` | 不进五端映射与目录，仅模型可见的专用工具 | 非业务能力的会话内机制（如内置的 subagent） |

`PluginActionSpec` 可选声明 `promptGuidelines: string[]`（非空使用要点）与 `promptSnippet: string`（完整段落）。经 `run_action` 可达的动作在目录条目中展示这些指引；直接暴露的动作沿用工具指引投射，在工具实际激活时注入。两条路径不会重复注入指引。指引只写简短的使用纪律；长手册请自举受管技能（见下文「自举受管技能」），不要塞进指引字段。

目录是摘要不是完整契约：模型获取完整 schema 优先用 `run_action({ actionId: '<pluginId>.<actionId>', describe: true })` 只读自省——返回该动作完整 manifest（含嵌套 inputSchema/outputSchema），不执行 handler、无副作用，同样按启用状态与 scope 过滤，无 bash 的会话也可用；有 bash 时 `helm actions list --json` 与 `helm <plugin> <action> --help` 等价可用。`scope`（`ConversationScope`：conversationIds / tags / profileIds / modelProviders 组合）同时约束目录可见性、`describe` 与实际调用——人工 HTTP/CLI 不受 scope 限制。

### ③ 前端：client.tsx 单轨与共享 SDK

视图类扩展点统一采用 React 组件单轨（`UiSpecBase` 只接受 `client: ClientComponentRef`，不再接受声明式 JSON Spec）。需要纯数据驱动界面时依赖 [`builtin:json-render`](json-render.md) 的能力，不在视图声明中写 `json` 字段。

`@helm/plugin-client` 是独立的浏览器 SDK 包，插件可以直接依赖它进行类型检查，无需把 `tsconfig.paths` 指向 Web 应用源码或其他包的 `node_modules`。SDK 不导入 Web 的 store 与路由实现；应用通过宿主端口接入真实数据、文档订阅、导航及渲染能力。

运行时，该说明符被构建器虚拟化为宿主全局命名空间（`globalThis.__helm_shared_plugin_client`），与宿主使用同一份 SDK、React 和上下文实例。可导入符号清单（`PLUGIN_CLIENT_SHARED_EXPORTS` 唯一真源）：

| 分类 | 符号 |
| :--- | :--- |
| Hooks | `usePluginContext`（`callAction / submitInput / openScreen / openSplitScreen / openConversationDrawer / openArtifact / openWorkbench / notify / theme / composer` 等）、`usePluginDoc(docName, pluginId?)`、`usePluginSessionDoc(docName, options?)`、`useConversations()`、`useConversation(id)`、`usePlugins()`、`useToolActivity(callId, active)` |
| 无障碍底座组件 | `Switch`、`Select` / `MultiSelect`、`Checkbox`、`Tabs` 系列、`SegmentedControl`、`Dialog` 系列、`ViewBoundary`、`Callout` |
| 布局原语 | `Screen`、`ScreenSection`、`DataTable`、`KvGrid`（见下方速查） |
| 内容展示 | `HelmIcon`（lucide 线性图标宿主封装）、`MarkdownView`、`CodeBlockView`、`CopyButton` |
| 格式化纯函数 | `formatTime`（`MM-DD HH:mm` 紧凑时间，缺失返回空串）、`formatCompactTimestamp`（`MM-DD HH:mm:ss` 日志时间戳，0/缺失返回占位符）、`formatDurationMs`（毫秒时长摘要） |
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

### 自举受管技能（service.start + ensureSkill）

动作目录指引适合简短要点；需要完整手册时用受管技能自举，内置与外部插件使用相同端口。

SKILL.md 与 references 放在插件目录内随源码维护，service 启动时写入宿主技能库：

```text
my-plugin/
├── index.ts
└── skill-assets/
    ├── SKILL.md
    └── references/rollback.md
```

```typescript
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = join(dirname(fileURLToPath(import.meta.url)), 'skill-assets');
// skill-assets/SKILL.md 的 frontmatter 声明：
// name: deploy-guide
// description: 部署与回滚任务需要的操作手册
// managedByPlugin: my-plugin

ctx.service({
  id: 'skill-bootstrap',
  async start() {
    await ctx.host.skills.ensureSkill({
      id: 'deploy-guide',
      skillMd: readFileSync(join(skillDir, 'SKILL.md'), 'utf8'),
      references: {
        'rollback.md': readFileSync(join(skillDir, 'references/rollback.md'), 'utf8'),
      },
    })
  },
  async stop() {},
})
```

三个生效条件：

1. **`managedByPlugin` 必须是本插件 ID**：宿主校验 frontmatter 绑定，防冒名托管；受管技能常规写入接口只读（403）。
2. **随插件启停**：停用时技能自动退出可用目录（模型不再看到、`load_skill` 失败），重新启用后恢复；停用不留幻影提示词。
3. **受 Profile.skills 白名单过滤**：Profile 限定技能目录时需显式勾选该技能才可见；全量目录 Profile 则自动可见。内置 helm-cli 同受此规则约束（限定目录且未勾选时同样不可加载），不是始终可用。
