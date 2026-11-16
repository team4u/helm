# 插件开发实战

本文是外部插件的全栈开发指南，面向准备为 Helm 编写插件的开发者：从 `helm plugins init` 脚手架起步，完成后端 `definePlugin(ctx)` 与前端 `client.tsx`，经 `doctor` 静态自检、`rescan` 发现、`enable` 启用、`reload` 热重载完成闭环。读完你应当能独立交付一个可安装、可诊断、可热更新的插件。契约总览见[插件系统设计与契约](overview.md)，Hook 与 UI 扩展点逐项契约见[扩展点详解](../architecture/extension-points.md)。

## 当前状态

外部插件加载与生命周期由内核 `PluginHost` 提供（`packages/kernel/src/plugins/`），产品组合根注入 `@helm/plugin-build` 构建实现（client.tsx 编译 + 后端 TS 转译）；未注入构建端口的宿主对 TS 源与 client UI 显式拒绝。插件是**可信进程内代码，没有沙箱**——安装启用即在 Hub 进程内以宿主权限执行，仅安装可信来源。

## 能力和入口：开发闭环四步曲

### ① 脚手架：`helm plugins init`

本地命令（不访问 Hub），三档模板：

```bash
helm plugins init my-plugin                          # 生成到 ~/.helm/plugins/my-plugin/（默认 full）
helm plugins init my-plugin --dir ~/code             # 生成到 ~/code/my-plugin/
helm plugins init my-plugin --template minimal       # 仅后端探针动作（无前端文件）
helm plugins init my-app --template app              # 全栈微应用骨架（可直接 apps validate/publish）
```

full 模板产出 `plugin.json`（含 `clientRoot: "./client"`）、`index.ts`（doc 与 `increment` 动作）、`tsconfig.json`、`client/index.tsx`（`@helm/plugin-client` 示例面板）与 `README.md`；minimal 仅后端 ping 探针；app 模板产出 public doc + 双 Schema 动作 + `ctx.ui.screen` 主视图 + 侧栏直达入口，生成目录无需发布即可通过 `helm plugins doctor` 与 `helm apps validate`。目标目录非空默认拒绝，`--force` 继续（同名文件被覆盖，不删除现有文件）。

### ② 插件目录与清单

外部插件统一存放在 `~/.helm/plugins/<pluginId>/`（`HELM_DATA_DIR` 覆盖时随数据目录）。推荐结构：

```text
~/.helm/plugins/sample-plugin/
├── plugin.json        # 插件清单
├── index.ts           # 后端入口（export default PluginDefinition）
├── tsconfig.json      # 本地类型检查（编辑器与 CI 用，运行时不依赖）
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

清单约束与入口发现：

- `id` 仅允许字母、数字、下划线与连字符，**禁止冒号**（冒号保留给 `builtin:` 命名空间）与 `builtin:` 前缀；外部插件禁止 `locked`（宿主加载时自动剥离）；
- `main` 缺省时按约定顺序探测 `index.ts / index.tsx / index.mjs / index.mts / index.js`（TypeScript 优先），也支持 `package.json` 的 `helm.main` / `main` 回落（`.js` 后缀自动重写同名 TS 源）；`main` 越出插件目录（含符号链接）显式拒绝；
- `clientRoot` 缺省为插件目录本身，必须是插件目录内的非空相对路径；未声明时一切 `client` 组件引用在注册边界拒绝（不允许无法编译的悬空引用）；
- `clientDependencies: string[]` 是前端受控 npm 依赖说明符（裸包名或子路径）：宿主映射为「解析根 = 插件自身目录」的受控依赖，client.tsx 中同名裸导入解析进 `<插件目录>/node_modules` 并逐文件 containment 校验后打进 bundle；未声明的裸依赖编译期显式拒绝。版本建议同时声明在 `package.json` 的 `dependencies`（受管安装优先取该 range）。在代码内声明 `npmDependencies` 自指解析根对外部插件无效；
- `dependencies: string[]` 是插件间依赖（仅插件 ID）：启用前依赖必须已注册且已启用（缺失/未启用分别 `409 plugin_dependency_missing` / `plugin_dependency_not_enabled`）；依赖图成环在注册时拒绝；`package.json` 顶层 `dependencies` 保持 npm 运行时依赖语义，不会被误读。

首次注册默认停用，经 `helm plugins enable <id>` 显式激活。

### ③ 后端：TypeScript 源码免构建直接加载

后端入口导出定义对象（外部加载器只接受对象形式默认导出，不接受工厂函数）：

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

    // 2. 持久状态文档（紧凑状态；单文档 JSON 上限 2 MiB）
    const statsDoc = ctx.doc('stats', { totalCalls: 0 }, { public: true });

    // 3. 单点 Schema 动作（五端复用 + 会话动作目录自动发现）
    ctx.action({
      id: 'send_notice',
      description: '发送业务通知消息',
      promptGuidelines: ['发送前核对目标与内容；失败时如实报告，不自动重复发送'],
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

    // 4. 后台服务与在途任务声明（停用预检消费）
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

加载机制：宿主经 Node `module.registerHooks` 钩子加载源码，`.ts` / `.tsx` 经插件构建端口同步转译（不打包）按依赖闭包逐文件处理；`import.meta.url` 始终指向插件目录内真实源文件；裸 npm 说明符从插件自身目录解析（可自带 `node_modules`），`@helm/*` 协议包与宿主共享同一实例。加载器不承诺解析 `tsconfig` `paths` 别名。插件根注册成功后常驻宿主进程；停用不卸载已加载模块，完全重载代码走 `helm plugins reload`。**`definePlugin` 顶层不要调用 `ctx.host.*`**（doctor 的 register 检查会如实失败）——宿主调用应放入动作处理器、服务生命周期或钩子内。

#### `ctx.action` 五端映射与暴露方式

一次 Schema 声明自动映射：HTTP（`POST /api/actions/<pluginId>/<actionId>`）、CLI（`helm <plugin> <action>`，`cli.command` 可覆写路径、`cli.positional` 按序消费位置参数、`readFileInto` 读本地文件入字段、`cli.timeoutMs: 0` 表示无超时）、Agent Tool（`exposeAsTool: true` 直接入工具列表）、Workflow（`action('pluginId.actionId', input)`）与 Web UI（`ctx.callAction`）。三种暴露方式的边界：

| 方式 | 会话内形态 | 适用场景 |
| :--- | :--- | :--- |
| 自动发现（缺省） | `<available_actions>` 目录摘要，经 `run_action` 按需调用 | 大多数动作；目录成本最低 |
| `exposeAsTool: true` | 独立模型工具（schema 即 inputSchema），不重复列目录 | 高频/需模型主动选用 |
| `ctx.tool(spec)` | 不进五端映射与目录，仅模型可见 | 非业务能力的会话内机制 |

目录随插件启停自动增删，无需修改 SYSTEM.md。完整契约获取：`run_action({ actionId, describe: true })` 只读自省，或 `helm actions list --json`。`scope`（conversationIds / tags / profileIds / modelProviders）同时约束目录可见性、describe 与调用；人工 HTTP/CLI 不受 scope 限制。`idempotent: true` 声明是安全重试承诺，工作流账本据此做前缀缓存复用与恢复重跑。

### ④ 前端：client.tsx 单轨与共享 SDK

视图类扩展点统一 React 组件单轨（`UiSpecBase` 只接受 `client: ClientComponentRef`）。`@helm/plugin-client` 是独立浏览器 SDK，可直接依赖做类型检查；运行时被构建器虚拟化为宿主全局命名空间（`globalThis.__helm_shared_plugin_client`），与宿主共享同一份 SDK、React 与上下文实例。主要符号（唯一真源 `PLUGIN_CLIENT_SHARED_EXPORTS`）：

| 分类 | 符号 |
| :--- | :--- |
| Hooks | `usePluginContext`（`callAction / submitInput / openScreen / openSplitScreen / openConversationDrawer / openArtifact / notify / theme / composer` 等）、`usePluginDoc`、`usePluginSessionDoc`、`useConversations`、`useConversation`、`usePlugins`、`useToolActivity` |
| 无障碍控件 | `Switch`、`Select` / `MultiSelect`、`Checkbox`、`Tabs` / `SegmentedControl`、`Dialog` 系列、`ViewBoundary`、`Callout` |
| 布局原语 | `Screen`、`ScreenSection`、`DataTable`（统一 loading/empty）、`KvGrid` |
| 内容展示 | `HelmIcon`、`MarkdownView`、`CodeBlockView`、`CopyButton`、`formatTime` 等格式化纯函数 |
| 插件间组合 | `PluginSlot` |

```tsx
import { usePluginDoc, HelmIcon, Screen, ScreenSection, DataTable, KvGrid } from '@helm/plugin-client';

export function SampleWidget() {
  const stats = usePluginDoc<{ totalCalls: number; failedCalls: number }>('stats');
  return (
    <Screen title={<><HelmIcon name="activity" size={14} />业务运行状态</>}>
      <ScreenSection title="概览">
        <KvGrid items={[{ key: '累计调用', value: stats?.totalCalls ?? 0 }]} />
      </ScreenSection>
    </Screen>
  );
}
```

后端注册组件引用（module 为相对 clientRoot 的路径、export 为具名导出名）：

```typescript
ctx.ui.workbenchPanel({ id: 'sample-widget-panel', label: '业务监控', client: { module: 'index.tsx', export: 'SampleWidget' } });
```

- **样式托管链**：插件样式以 clientRoot 内本地 `.css` 导入（`import './styles.css'`），不得写进宿主样式表。编译器按依赖顺序合并 CSS（根内本地 `@import` 允许；根外、符号链接逃逸与远程 `@import` 拒绝），经保留导出 `__helmClientCss` 内联进插件 JS；宿主注入 `<style data-helm-plugin-css>`，停用/卸载或登出时回收。`url()` 支持 `data:` 内联与 HTTP(S) 绝对地址，本地相对与片段资源 URL 显式拒绝。可复用宿主设计变量（`var(--fg-muted)`）与通用类（`.badge`、`.btn`）。
- **两条硬纪律**：界面文案与状态徽标**严禁 Emoji**，图标统一 lucide 线性名；`client.tsx` 是可信代码而非沙箱——展示不可信 HTML 必须用 `<iframe sandbox srcDoc>` 且默认不授予脚本、同源、表单或导航权限，不得直接注入宿主 DOM。

### 自检、发现、启用与热重载

```bash
# 静态自检（真实执行，不是近似检查）
helm plugins doctor /root/code/my-plugin     # 按目录
helm plugins doctor my-plugin                # 按已注册插件 id

# 增量发现：放入新插件目录后无需重启 Hub（只注册未注册的，默认停用）
helm plugins rescan
helm plugins enable my-plugin

# 受控热重载：不重启 Hub 重载插件代码
helm plugins reload my-plugin
```

- **doctor 四层检查**逐项真实执行：manifest 合法性与入口越根 → backend TS 转译与代际导入 → register 临时 PluginHost 真实执行 `definePlugin`（与生产同一校验链：action/tool/ui/doc/service/provider 形状、重复、scope）→ client 编译并校验具名导出真实存在（悬空 `export` 在此暴露，不留到运行期渲染空白）。检查使用独立代际号（`?helmgen=N`）与临时内存 doc store，不影响已注册实例；doctor 专用后端对 `ctx.host.*` 一律 501 显式拒绝——`definePlugin` 顶层依赖宿主调用的插件在此如实失败，这是设计而非缺陷。
- **reload 安全链**：在途任务预检（`409 plugin_has_live_tasks`）→ dry-run 完整 doctor 预检（失败则旧实例保持不动，`422 plugin_reload_preflight_failed` 附完整报告）→ 新代际切换（失败用旧代回滚）→ 启用状态保持。内置插件禁止热重载（403）。
- **受管包安装**（区别于手放置入目录）：`helm plugins install npm:<spec>|git:<repo>[@<ref>]|<https-git-url>|<本地路径> [--enable]`、`helm plugins update <id>`、`helm plugins remove <id> [--yes]`。安装启用即在 Hub 内执行可信插件代码，无沙箱；来源由 Hub 解析，本地路径相对 Hub 主机。

## 常见进阶模式

### 节点详情子插槽

```typescript
import { NODE_DETAIL_SECTION_SLOT } from '@helm/protocol';
ctx.ui.slot({ id: 'node-inspection', target: NODE_DETAIL_SECTION_SLOT, client: { module: 'client.tsx', export: 'NodeInspectionSection' } });
```

组件接收 `{ nodeId, isLocal, isOnline, isNew: false }`，按 `nodeId` 调用插件自己的 Action 获取诊断。`builtin:profile` 的 `PROFILE_DETAIL_SECTION_SLOT` 同理（Props `{ profileId, isNew, disabled }`）。

### 产物预览器与输入补全源

```typescript
ctx.ui.artifactPreviewer({ id: 'csv', label: '数据表', mimeTypes: ['text/csv'], extensions: ['.csv', '.tsv'], priority: 10, client: { module: 'client.tsx', export: 'CsvPreview' } });
```

组件接收 `ArtifactPreviewerProps`：`text` 在二进制或超过 1 MiB 时为 `null`（必须明确提示而非展示空表冒充结果）；`blobUrl` 由宿主管理、组件不得撤销。

补全源三种数据源：`{ kind: 'doc', name, itemsField }`（公开文档顶层数组字段）、`{ kind: 'action', actionId }`（须声明 `idempotent: true`；输入 `{ query, conversationId }` 输出 `{ items: Array<{id, label, insertText, hint?, icon?}> }`）、`{ kind: 'sessionDoc', ... }`。补全只插入 `insertText`，不执行、不发送、不审批。

### 自举受管技能

动作目录指引适合简短要点；需要完整手册时用受管技能自举（内置与外部插件同一端口）：

```text
my-plugin/
├── index.ts
└── skill-assets/
    ├── SKILL.md          # frontmatter: name / description / managedByPlugin: my-plugin
    └── references/rollback.md
```

```typescript
ctx.service({
  id: 'skill-bootstrap',
  async start() {
    await ctx.host.skills.ensureSkill({
      id: 'deploy-guide',
      skillMd: readFileSync(join(skillDir, 'SKILL.md'), 'utf-8'),
      references: { 'rollback.md': readFileSync(join(skillDir, 'references/rollback.md'), 'utf-8') },
    });
  },
  async stop() {},
});
```

三个生效条件：`managedByPlugin` 必须是本插件 ID（宿主校验防冒名，受管技能常规写入接口 403）；随插件启停进出可用目录（停用不留幻影提示词）；受 `Profile.skills` 白名单过滤（限定目录的 Profile 需显式勾选才可见）。

## 配置、数据与错误边界

- **配置**：`ctx.configSchema` 声明字段（`type: string/number/boolean` + `label` / `description` / `default`）；`secret: true` 自动分离至 `credentials.json` `pluginSecrets.<pluginId>` 并入 SecretStash 脱敏。插件中心与 `helm plugins config <id>` 同权读写。
- **数据**：专属数据目录 `<dataDir>/plugins/<id>/`；`ctx.doc` / `ctx.sessionDoc` 按 <id> 划分命名空间；单文档超 2 MiB 显式 `413 plugin_doc_too_large`，大体量内容落盘文件资产。
- **错误边界**：所有外部输入（HTTP body、动作入参、事件载荷）在入口边界 Schema 校验，非法显式拒绝；能力不支持、节点离线（`409 node_offline`）、交接失败必须显式报错附诊断，绝不静默降级、绝不编造 fallback 数据；错误信封统一 `{ error: { code, message, details? } }`。加载/启用失败置 `status: failed` 附结构化 `error`（`stage: scan | load | define | enable`），不拖垮内核。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 外部加载器与入口探测 | `packages/kernel/src/plugins/external-loader.ts`、`scan-visitor.ts` |
| 清单解析（plugin.json / package.json helm 字段） | `packages/kernel/src/plugins/plugin-manifest.ts` |
| doctor 四阶段 | `packages/kernel/src/plugins/plugin-doctor.ts` |
| 受管包安装 | `packages/kernel/src/plugins/package-manager.ts`、`package-store.ts` |
| client 编译实现 | `packages/plugin-build/` |
| 共享浏览器 SDK | `packages/plugin-client/` |
| CLI 脚手架模板 | `packages/cli/src/commands/scaffold-templates.ts` |
| 测试 | `packages/kernel/test/plugins.test.ts` 与 `plugin-*.test.ts`（生命周期、依赖、doctor、受管包）、`packages/cli/test/`（init/doctor/reload 命令）、`packages/plugin-build/test/`、`packages/plugin-client/test/` |

## 相关文档

- [插件系统设计与契约](overview.md)：`definePlugin(ctx)` 能力面、五端映射与停用预检
- [生命周期 Hook 与全界面扩展点](../architecture/extension-points.md)：7 个 Hook 与 16 个 UI surface
- [应用中心](apps.md)：全栈微应用的发布与目录
- [Web 前端设计系统](../conventions/web-frontend.md)：视图形态、字号与零 Emoji 铁律
