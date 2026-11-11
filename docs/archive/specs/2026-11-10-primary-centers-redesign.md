# 全屏资源中心矩阵重构设计规范 (Primary Centers Redesign)

**状态**: Approved  
**日期**: 2026-11-10  
**作者**: Antigravity  
**前置参考**:
- `docs/superpowers/specs/2026-11-10-plugin-center-redesign.md`（插件中心重构规范）
- `docs/conventions/web-frontend.md`（Web 前端设计系统与开发约定）
- `docs/conventions/web-navigation.md`（Web 导航与 URL Hash 开发约定）
- `AGENTS.md`（项目开发约定与架构铁律）

---

## 一、背景与重构目标

在完成了**全屏插件中心（Plugin Center, `#/plugins`）**的升格后，系统证明了「主舞台全屏自适应卡片网格流（Primary Stage Marketplace Grid）+ 右侧 520px-560px 深度配置/详情抽屉（Slide-out Detail Drawer）」架构在承载海量扩展项、多维检索与复杂配置上的巨大优势。

当前系统中仍有 4 个核心资源中心停留在早期的居中固定宽度模态弹窗（860px ~ 900px）中：
1. **智能体角色（Profiles）**：`ProfileEditorModal.tsx`
2. **技能中心（Skills）**：`SkillViewerModal.tsx`
3. **计算节点（Nodes）**：`NodesModal.tsx`
4. **模型与凭证（Models & Providers）**：`ProviderCatalog.tsx`

本次重构旨在将上述 4 个中心与插件中心全面对齐，彻底废弃局促的居中弹窗，升格为系统一级全屏视图，收敛全仓导航入口，建立对称、统一、具有极致工业级质感的 Web 桌面与移动端体验。

---

## 二、URL Hash 契约与导航架构

### 2.1 唯一事实来源：`ResolvedTarget`
在 `packages/web/src/lib/types.ts` 中，`ResolvedTarget` 联合类型扩充为 6 大一级视图：
```ts
export type ResolvedTarget =
  | { kind: 'conversation'; conversationId: number }
  | { kind: 'screen'; pluginId: string; screenId: string; params?: Record<string, string> }
  | { kind: 'plugins'; pluginId?: string }
  | { kind: 'profiles'; profileId?: string }
  | { kind: 'skills'; skillId?: string }
  | { kind: 'nodes'; nodeId?: string }
  | { kind: 'models'; providerId?: string }
```

### 2.2 双向 URL Hash 编解码表
在 `packages/web/src/lib/url-hash-model.ts` 中建立严格对称的双向编解码：

| 一级目标 | 基础网格路由 | 打开详情/配置抽屉 | 兼容旧 URL 重定向 |
| :--- | :--- | :--- | :--- |
| **插件中心** | `#/plugins` | `#/plugins?p=<pluginId>` | `#/c/1?modal=plugins` |
| **角色中心** | `#/profiles` | `#/profiles?id=<profileId>` | `#/c/1?modal=profiles` |
| **技能中心** | `#/skills` | `#/skills?id=<skillId>` | `#/c/1?modal=skills` |
| **计算节点** | `#/nodes` | `#/nodes?id=<nodeId>` | `#/c/1?modal=nodes` |
| **模型中心** | `#/models` | `#/models?id=<providerId>` | `#/providers` 或 `modal=providers` |

### 2.3 历史栈策略（`shouldPushLocationHistory`）
- **跨视图跳转**（如从会话切换到 `#/profiles`、从角色切换到 `#/models`）：使用 `pushState`；
- **打开抽屉**（从网格列表点击卡片展开详情抽屉）：使用 `pushState`（允许浏览器后退返回列表视图）；
- **抽屉内连续切换项**（抽屉已展开状态下点选其他卡片）：使用 `replaceState`（避免多次点选导致后退栈冗余污染）；
- **关闭抽屉**：使用 `replaceState` 恢复为基础路由（如 `#/profiles`）。

### 2.4 分屏（Split View）正交支持
所有 4 个中心均支持在右分屏（`splitTarget`）中并排展示（如 `?split=models` 或 `?split=profiles%3Fid%3Dsuperagent`），主屏会话与右屏资源中心互不干扰。

---

## 三、四大中心详细架构设计

### 3.1 智能体角色中心 (`ProfileCenter`)

#### 1. 纯函数模型 (`packages/web/src/profiles/profile-center-model.ts`)
- `filterProfiles(profiles, search, filter)`: 支持角色名称、ID、System Prompt 片段、绑定技能的模糊匹配；
- `buildProfileCategoryCounts(profiles)`: 统计分类数量徽章：
  - `all`: 全部角色
  - `system`: 常驻系统级角色（如 `superagent`, `watchdog`）
  - `custom`: 自定义专家 Bot
  - `herdr`: 启用了 Herdr CLI 终端协同的角色

#### 2. 卡片组件 (`packages/web/src/profiles/ProfileCard.tsx`)
- 头部：角色线性矢量图标（`HelmIcon`）、角色名称、角色唯一 ID（`.mono`）、内置系统角色标记徽章（`system` 锁定徽章）；
- 中部：角色功能描述、默认绑定模型短名胶囊（如 `claude-3-5-sonnet`）；
- 底部：绑定的技能数量胶囊（`N Skills`）、工具列表（`Tools`）、Herdr 运行时状态指示；
- 交互：支持整卡点击打开右侧抽屉，键盘 Enter / Space 激活。

#### 3. 详情与配置抽屉 (`packages/web/src/profiles/ProfileDetailDrawer.tsx`)
- 抽屉容器：使用 Radix `Dialog` 封装，520px-560px 贴右滑入，移动端 100% 满宽；
- 头部：大图标、角色标题、编辑/新建状态切换、关闭按钮；
- 核心表单区（`.form-grid`）：
  - 基础信息：角色 ID（新建时输入，创建后只读）、角色显示名、描述；
  - 模型设置：默认模型选择（公共 `Select` 下拉组件，高度 30px，字号 12px）；
  - 提示词编辑：System Prompt 多行文本编辑器（代码字体、行高克制）；
  - 长期记忆：Memory 查看与更新；
  - 技能挂载：多选技能标签列表；
  - Herdr 协同：启用/配置 Herdr 终端运行时参数；
- 底部操作栏：保存按钮（带保存中状态）、删除角色危险操作（带二次确认 `AlertDialog`）；
- 脏表单防丢保护：未保存表单被切出时弹出提示，防止误丢草稿。

---

### 3.2 技能中心 (`SkillCenter`)

#### 1. 纯函数模型 (`packages/web/src/skills/skill-center-model.ts`)
- `filterSkills(skills, search, category)`: 搜索技能名、描述、触发词（triggers）；
- `buildSkillCategoryCounts(skills)`:
  - `all`: 全部技能
  - `builtin`: 内置核心技能（如 `assistant`, `workflow` 等）
  - `workspace`: 用户工作区私有技能（`.gemini/skills/`）
  - `plugins`: 外部插件贡献的技能

#### 2. 卡片组件 (`packages/web/src/skills/SkillCard.tsx`)
- 头部：技能线性图标、名称、来源徽章（内置 / 工作区 / 插件）；
- 中部：技能描述文本（多行截断）；
- 底部：关联参考文件数量徽章（`N References`）、触发关键词标签；
- 交互：点击打开抽屉，无原生模态弹窗。

#### 3. 详情抽屉 (`packages/web/src/skills/SkillDetailDrawer.tsx`)
- 抽屉容器：基于 Radix `Dialog` 封装；
- 顶部元信息：技能全名、路径（`.mono`）、版本与来源信息；
- 主体内容：
  - 技能主文档（`SKILL.md`）优雅 Markdown 渲染；
  - 关联文件树（`references/*.md`）：侧边文件导航，点击按需异步加载文件源码并提供高亮代码盒展示；
  - 并发保护：`loadGeneration` 代数防竞态，防止切换技能后迟到文件覆盖新内容。

---

### 3.3 计算节点中心 (`NodeCenter`)

#### 1. 纯函数模型 (`packages/web/src/nodes/node-center-model.ts`)
- `filterNodes(nodes, search, statusFilter)`: 匹配节点名称、ID、平台操作系统（linux / darwin / windows）与架构（x64 / arm64）；
- `buildNodeCategoryCounts(nodes)`:
  - `all`: 全部节点
  - `online`: 当前在线心跳正常节点
  - `offline`: 离线或失联节点
  - `local`: 本地宿主节点

#### 2. 卡片组件 (`packages/web/src/nodes/NodeCard.tsx`)
- 头部：平台图标（`HelmIcon` 对应系统标识）、节点名、唯一 Node ID；
- 中部：在线状态指示灯（脉冲绿灯 / 灰色离线灯）、版本号（如 `helm-node v0.1.0`）；
- 底部：延迟心跳时间、最近活跃时间（`lastSeenAt` 相对时间格式化）；
- 交互：点击打开节点体检与配置抽屉。

#### 3. 详情与操作抽屉 (`packages/web/src/nodes/NodeDetailDrawer.tsx`)
- 模式切换：
  - **节点详情模式**：展示节点系统配置、路径信息、工作树分配情况、版本检查与一键升级操作（调用 `nodesApi.upgrade`）；
  - **接入签发模式**（顶栏点击「+ 接入节点」）：签发新 Node 接入 Token，直接生成并直出 `helm-node start --token=...` 格式化命令块，带一键复制按钮与操作反馈。

---

### 3.4 模型与供应商中心 (`ModelCenter`)

#### 1. 纯函数模型 (`packages/web/src/models/model-center-model.ts`)
- `filterProviders(providers, search, category)`: 搜索供应商名称（Anthropic / OpenAI / DeepSeek / Ollama 等）及所含模型名称；
- `buildProviderCategoryCounts(providers, credentials)`:
  - `all`: 全部供应商
  - `configured`: 已配置可用凭据
  - `cloud`: 主流商业云端 API
  - `local`: 本地私有端点（Ollama / vLLM）

#### 2. 卡片组件 (`packages/web/src/models/ModelCard.tsx`)
- 头部：供应商图标/Logo、供应商名称、接入状态徽章（已连接 / 未配置）；
- 中部：预置模型清单概要（如 `claude-3-7-sonnet`, `deepseek-r1` 等）；
- 底部：已启用模型数徽章（`N Models Enabled`）、端点类型（云端 API / 本地私有）；
- 交互：点击打开供应商凭证与模型配置抽屉。

#### 3. 凭证与配置抽屉 (`packages/web/src/models/ModelDetailDrawer.tsx`)
- 凭证安全表单：
  - API Key 字段：密文展示掩码（`••••••••`），提示“已配置（留空保持不变）”，表单提交时空输入不覆盖后端密文；
  - Base URL 字段：支持自定义 API 代理或本地端点；
- 模型启用开关清单：多选开关（`Switch`）启用或停用具体模型；
- 连通性测试：提供「测试连接」按钮，验证凭据可用性与当前延迟（ms）。

---

## 四、全局入口收敛与旧模态彻底淘汰

### 4.1 物理删除旧模态
在 `packages/web/src/modals/` 目录中物理删除以下文件及其专属样式，彻底清理历史代码：
- `ProfileEditorModal.tsx`
- `SkillViewerModal.tsx`
- `NodesModal.tsx`
- `ProviderCatalog.tsx`（及 `provider-auth.css`）

### 4.2 侧栏底栏入口全面收敛 (`Sidebar.tsx`)
侧栏底栏 5 大核心功能图标统一升级为一级主舞台导航入口，并在当前处于对应视图时高亮：
```tsx
// 1. 智能体角色
onClick={() => store.openTarget({ kind: 'profiles' })}
className={store.primaryTarget.kind === 'profiles' ? 'btn-active active' : ''}

// 2. 模型与供应商
onClick={() => store.openTarget({ kind: 'models' })}
className={store.primaryTarget.kind === 'models' ? 'btn-active active' : ''}

// 3. 技能中心
onClick={() => store.openTarget({ kind: 'skills' })}
className={store.primaryTarget.kind === 'skills' ? 'btn-active active' : ''}

// 4. 计算节点
onClick={() => store.openTarget({ kind: 'nodes' })}
className={store.primaryTarget.kind === 'nodes' ? 'btn-active active' : ''}

// 5. 插件中心
onClick={() => store.openTarget({ kind: 'plugins' })}
className={store.primaryTarget.kind === 'plugins' ? 'btn-active active' : ''}
```

### 4.3 ⌘K 命令面板收敛 (`CommandPaletteModal.tsx`)
命令面板中的快捷项直接派发一级路由：
- 打开智能体角色 -> `store.openTarget({ kind: 'profiles' })`
- 打开模型与供应商 -> `store.openTarget({ kind: 'models' })`
- 打开技能中心 -> `store.openTarget({ kind: 'skills' })`
- 打开计算节点 -> `store.openTarget({ kind: 'nodes' })`
- 打开插件中心 -> `store.openTarget({ kind: 'plugins' })`
子项（如特定 profile / skill / node / model）搜索命中后，携带参数直达打开对应抽屉（如 `openTarget({ kind: 'profiles', profileId: p.id })`）。

### 4.4 主容器舞台分支与历史深链容错 (`App.tsx`)
- 主舞台根据 `store.primaryTarget.kind` 分支渲染：
  - `conversation`: `<ConversationPane />`
  - `plugins`: `<PluginCenter />`
  - `profiles`: `<ProfileCenter />`
  - `skills`: `<SkillCenter />`
  - `nodes`: `<NodeCenter />`
  - `models`: `<ModelCenter />`
  - `screen`: `<ScreenHost />`
- 挂载守卫容错：当捕获历史深链中的 `modal=profiles|skills|nodes|providers` 时，自动无感重定向至对应的一级全屏视图与抽屉参数，并清除模态状态。

---

## 五、架构铁律与工程规范

1. **UI 极简零 Emoji 铁律**：
   Web 界面文案、按钮、徽章、状态指示或卡片中**严禁使用任何 Emoji**；图标一律采用 `HelmIcon`（`lucide-react` 线性矢量图标）与标准设计系统类排版。
2. **Radix UI 唯一无头交互原语底座**：
   所有抽屉基于 Radix `Dialog` 封装；下拉菜单一律使用公共 `Select`（30px 高度、12px 字号）；开关统一使用 `Switch`；布局严格使用 `.form-grid`、`.section-flat`、`.list-item-btn`，严禁大面积内联样式。
3. **Fast Refresh 规范**：
   所有 `.tsx` 组件文件**只导出 React 组件与 TypeScript 类型/接口**；所有数据处理、纯函数、转换模型存放在独立的 `*-model.ts` 中。
4. **单测防死锁规范**：
   所有测试套件必须显式声明 `{ timeout: 60_000 }`；测试覆盖 SSR 纯文本渲染、DOM 键盘交互、路由 Hash 往返、并发代数防竞态以及零 Emoji 静态检查。

---

## 六、实施与任务分解路线图 (Roadmap)

按子代理驱动开发（SDD）模式分解为 6 个高内聚独立任务：

- **Task 1: 全局路由契约扩充与 Hash 编解码体系 (`types.ts`, `url-hash-model.ts`)**
- **Task 2: 智能体角色中心全屏升格 (`packages/web/src/profiles/`)**
- **Task 3: 技能中心全屏升格 (`packages/web/src/skills/`)**
- **Task 4: 计算节点中心全屏升格 (`packages/web/src/nodes/`)**
- **Task 5: 模型与供应商中心全屏升格 (`packages/web/src/models/`)**
- **Task 6: 全局主舞台挂载、导航收敛、旧模态物理清理与全套测试回归 (`App.tsx`, `Sidebar.tsx`, `CommandPaletteModal.tsx`, 物理删除旧文件)**
