# 全屏资源中心矩阵重构实施计划 (Primary Centers Redesign)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将智能体角色（Profiles）、技能中心（Skills）、计算节点（Nodes）、模型与凭证（Models & Providers）四大中心从局促的居中固定模态弹窗全面升格为系统一级全屏视图（自适应卡片网格主舞台 + 520px 右侧滑出抽屉），收敛全仓导航入口并物理淘汰旧模态。

**Architecture:** 
1. 扩充 `ResolvedTarget` 联合类型与双向 URL Hash（`#/profiles`, `#/skills`, `#/nodes`, `#/models`），集成历史栈防污染策略；
2. 每个中心按独立模块目录组织，严格分离纯函数数据模型（`*-model.ts`）、自适应卡片（`*Card.tsx`）、基于 Radix Dialog 的配置抽屉（`*DetailDrawer.tsx`）与主容器（`*Center.tsx`）；
3. 收敛 `App.tsx`、`Sidebar.tsx`、`CommandPaletteModal.tsx`，物理清理 4 大旧模态，补齐端到端全量回归测试。

**Tech Stack:** React 19, TypeScript, Radix UI Primitives (`@radix-ui/react-dialog`, `@radix-ui/react-select`, `@radix-ui/react-alert-dialog`), CSS Grid / Variables, `lucide-react` (via `HelmIcon`), Node.js Test Runner.

## Global Constraints

- **UI 极简零 Emoji 铁律**: 严禁在界面文案、左栏导航项、分组标题、按钮、状态徽章或卡片中使用任何 Emoji 表情图标；图标统一使用 `lucide-react` 线性矢量图标或纯文本排版。
- **Radix UI 唯一交互原语底座**: 凡涉及浮层、对话框、下拉、标签页、提示等交互组件，一律基于 `packages/web/src/ui/` 下的 Radix Primitives 封装组件；全仓严禁使用原生 `<select>`；表单与布局严格使用 `.form-grid`、`.section-flat`、`.list-item-btn`，严禁大面积内联样式。
- **移动端与自适应字号规范**: 保持紧凑克制，正文 13/14px，移动端（≤680px）与分屏下严禁输入框字号突兀放大；移动端抽屉与弹窗自适应 100% 宽。
- **前端保 Fast Refresh**: `.tsx` 组件文件只导出组件与 TS 类型；纯函数/常量/数据模型放独立模块。
- **单测防死锁规范**: 所有单元测试必须显式声明 `{ timeout: 60_000 }`（runner 为 `tsx --test`）。
- **工作目录与隔离**: 并行开发必须在专属 `git worktree` 下进行；历史仓库只读。

---

### Task 1: 路由契约与一级主舞台目标扩充 (`types.ts`, `url-hash-model.ts`)

**Files:**
- Modify: `packages/web/src/lib/types.ts`
- Modify: `packages/web/src/lib/url-hash-model.ts`
- Test: `packages/web/test/primary-centers-nav.test.ts`

**Interfaces:**
- Consumes: `ResolvedTarget` 联合类型定义
- Produces:
  ```ts
  // packages/web/src/lib/types.ts
  export type ResolvedTarget =
    | { kind: 'conversation'; conversationId: number }
    | { kind: 'screen'; pluginId: string; screenId: string; params?: Record<string, string> }
    | { kind: 'plugins'; pluginId?: string }
    | { kind: 'profiles'; profileId?: string }
    | { kind: 'skills'; skillId?: string }
    | { kind: 'nodes'; nodeId?: string }
    | { kind: 'models'; providerId?: string }
  ```
  - Hash 编码：
    - `profiles` -> `#/profiles`，带 `profileId` -> `#/profiles?id=<profileId>`
    - `skills` -> `#/skills`，带 `skillId` -> `#/skills?id=<skillId>`
    - `nodes` -> `#/nodes`，带 `nodeId` -> `#/nodes?id=<nodeId>`
    - `models` -> `#/models`，带 `providerId` -> `#/models?id=<providerId>`
  - 历史栈：从列表点开抽屉使用 `push`，抽屉内切换或关闭使用 `replace`。

- [ ] **Step 1: 编写路由契约双向编解码测试**

在 `packages/web/test/primary-centers-nav.test.ts` 中编写测试：
- 验证 `serializeHash` 与 `parseHash` 对 `profiles`, `skills`, `nodes`, `models` 的双向无损往返；
- 验证携带 `id` 参数时正确编码为 `?id=<id>`；
- 验证 `shouldPushLocationHistory`：跨视图切换与开抽屉 push，抽屉内切项与关抽屉 replace；
- 验证兼容解析：旧的 `#/c/1?modal=profiles|skills|nodes|providers` 正确被解析或转换。

- [ ] **Step 2: 运行测试并验证失败**

运行：`pnpm --filter @helm/web test -- test/primary-centers-nav.test.ts`  
预期：FAIL（`types.ts` 与 `url-hash-model.ts` 尚未扩充这 4 个 target 分支）

- [ ] **Step 3: 实现路由编解码与历史栈规则**

修改 `packages/web/src/lib/types.ts` 与 `packages/web/src/lib/url-hash-model.ts`：
- 在 `ResolvedTarget` 加入 `profiles`, `skills`, `nodes`, `models` 目标定义；
- 更新 `parseTargetValue`、`formatTargetValue`、`isSameResolvedTarget`、`resolveTargetString`；
- 更新 `shouldPushLocationHistory` 抽屉与列表的栈判定。

- [ ] **Step 4: 运行测试并验证通过**

运行：`pnpm --filter @helm/web test -- test/primary-centers-nav.test.ts`  
预期：PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/web/src/lib/types.ts packages/web/src/lib/url-hash-model.ts packages/web/test/primary-centers-nav.test.ts
git commit -m "feat(web): 扩充角色、技能、节点与模型中心的一级路由与 URL Hash 契约"
```

---

### Task 2: 智能体角色中心全屏升格 (`packages/web/src/profiles/`)

**Files:**
- Create: `packages/web/src/profiles/profile-center-model.ts`
- Create: `packages/web/src/profiles/ProfileCard.tsx`
- Create: `packages/web/src/profiles/ProfileDetailDrawer.tsx`
- Create: `packages/web/src/profiles/ProfileCenter.tsx`
- Modify: `packages/web/src/styles.css`
- Test: `packages/web/test/profile-center.test.ts`

**Interfaces:**
- Consumes: `Profile`, `useHelmStore`, `Dialog`, `Select`, `Switch`, `AlertDialog`
- Produces:
  ```tsx
  export interface ProfileCenterProps {
    isSplit?: boolean
    onCloseSplit?: () => void
  }
  export function ProfileCenter(props: ProfileCenterProps): React.JSX.Element
  ```

- [ ] **Step 1: 编写角色中心模型、卡片与抽屉测试**

在 `packages/web/test/profile-center.test.ts` 中编写测试：
- 纯函数模型测试：`filterProfiles` 搜索与分类（全部/系统角色/自定义/Herdr）；
- SSR 直出断言：卡片展示图标、名称、默认模型徽章、绑定的技能标签；
- 抽屉交互断言：表单输入、模型下拉选择、脏表单防护、0 Emoji。

- [ ] **Step 2: 运行测试并验证失败**

运行：`pnpm --filter @helm/web test -- test/profile-center.test.ts`  
预期：FAIL

- [ ] **Step 3: 实现角色纯函数模型、卡片、抽屉与全屏容器**

1. `profile-center-model.ts`：纯函数过滤、搜索与分类计数；
2. `ProfileCard.tsx`：自适应网格卡片，展示 Bot 属性与技能胶囊；
3. `ProfileDetailDrawer.tsx`：520px 滑出抽屉，整合 System Prompt、记忆、技能勾选与保存，带脏表单保护；
4. `ProfileCenter.tsx`：顶部搜索与分类栏、网格流、新建角色草稿流程；
5. `styles.css`：补充样式类。

- [ ] **Step 4: 运行测试并验证通过**

运行：`pnpm --filter @helm/web test -- test/profile-center.test.ts`  
预期：PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/web/src/profiles/ packages/web/src/styles.css packages/web/test/profile-center.test.ts
git commit -m "feat(web): 实现全屏智能体角色中心（ProfileCenter）组件与详情编辑抽屉"
```

---

### Task 3: 技能中心全屏升格 (`packages/web/src/skills/`)

**Files:**
- Create: `packages/web/src/skills/skill-center-model.ts`
- Create: `packages/web/src/skills/SkillCard.tsx`
- Create: `packages/web/src/skills/SkillDetailDrawer.tsx`
- Create: `packages/web/src/skills/SkillCenter.tsx`
- Modify: `packages/web/src/styles.css`
- Test: `packages/web/test/skill-center.test.ts`

**Interfaces:**
- Consumes: `SkillSummary`, `useHelmStore`, `Dialog`, `MarkdownView`
- Produces:
  ```tsx
  export interface SkillCenterProps {
    isSplit?: boolean
    onCloseSplit?: () => void
  }
  export function SkillCenter(props: SkillCenterProps): React.JSX.Element
  ```

- [ ] **Step 1: 编写技能中心测试**

在 `packages/web/test/skill-center.test.ts` 中编写测试：
- 纯函数模型测试：分类统计（全部/内置/工作区私有/插件扩展）；
- 卡片渲染测试：名称、来源标签、关联文件胶囊、触发条件展示；
- 抽屉测试：Markdown 直出、`references/` 关联文件树异步读取、`loadGeneration` 防竞态、0 Emoji。

- [ ] **Step 2: 运行测试并验证失败**

运行：`pnpm --filter @helm/web test -- test/skill-center.test.ts`  
预期：FAIL

- [ ] **Step 3: 实现技能纯函数模型、卡片、抽屉与全屏容器**

1. `skill-center-model.ts`：纯函数分类与多维检索；
2. `SkillCard.tsx`：技能摘要与触发场景展示；
3. `SkillDetailDrawer.tsx`：Markdown 渲染与关联源码文件树切换浏览；
4. `SkillCenter.tsx`：全景主舞台容器；
5. `styles.css`：补充技能中心样式。

- [ ] **Step 4: 运行测试并验证通过**

运行：`pnpm --filter @helm/web test -- test/skill-center.test.ts`  
预期：PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/web/src/skills/ packages/web/src/styles.css packages/web/test/skill-center.test.ts
git commit -m "feat(web): 实现全屏技能中心（SkillCenter）组件与深度代码预览抽屉"
```

---

### Task 4: 计算节点中心全屏升格 (`packages/web/src/nodes/`)

**Files:**
- Create: `packages/web/src/nodes/node-center-model.ts`
- Create: `packages/web/src/nodes/NodeCard.tsx`
- Create: `packages/web/src/nodes/NodeDetailDrawer.tsx`
- Create: `packages/web/src/nodes/NodeCenter.tsx`
- Modify: `packages/web/src/styles.css`
- Test: `packages/web/test/node-center.test.ts`

**Interfaces:**
- Consumes: `NodeInfo`, `nodesApi`, `Dialog`, `useHelmStore`
- Produces:
  ```tsx
  export interface NodeCenterProps {
    isSplit?: boolean
    onCloseSplit?: () => void
  }
  export function NodeCenter(props: NodeCenterProps): React.JSX.Element
  ```

- [ ] **Step 1: 编写计算节点中心测试**

在 `packages/web/test/node-center.test.ts` 中编写测试：
- 纯函数模型测试：在线/离线健康过滤、平台架构匹配；
- 卡片测试：脉冲状态指示灯、系统版本号、心跳延迟；
- 抽屉测试：节点体检/一键升级动作、Token 签发与格式化接入命令一键复制反馈、0 Emoji。

- [ ] **Step 2: 运行测试并验证失败**

运行：`pnpm --filter @helm/web test -- test/node-center.test.ts`  
预期：FAIL

- [ ] **Step 3: 实现节点纯函数模型、卡片、抽屉与全屏容器**

1. `node-center-model.ts`：节点健康状态判定与分类统计；
2. `NodeCard.tsx`：节点拓扑状态卡片；
3. `NodeDetailDrawer.tsx`：节点体检诊断与 Token 签发接入命令行；
4. `NodeCenter.tsx`：主舞台拓扑网格与签发操作入口；
5. `styles.css`：补充节点卡片与抽屉样式。

- [ ] **Step 4: 运行测试并验证通过**

运行：`pnpm --filter @helm/web test -- test/node-center.test.ts`  
预期：PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/web/src/nodes/ packages/web/src/styles.css packages/web/test/node-center.test.ts
git commit -m "feat(web): 实现全屏计算节点中心（NodeCenter）拓扑与诊断抽屉"
```

---

### Task 5: 模型与供应商中心全屏升格 (`packages/web/src/models/`)

**Files:**
- Create: `packages/web/src/models/model-center-model.ts`
- Create: `packages/web/src/models/ModelCard.tsx`
- Create: `packages/web/src/models/ModelDetailDrawer.tsx`
- Create: `packages/web/src/models/ModelCenter.tsx`
- Modify: `packages/web/src/styles.css`
- Test: `packages/web/test/model-center.test.ts`

**Interfaces:**
- Consumes: `ProviderConfig`, `CredentialSummary`, `ModelDescriptor`, `Dialog`, `Switch`
- Produces:
  ```tsx
  export interface ModelCenterProps {
    isSplit?: boolean
    onCloseSplit?: () => void
  }
  export function ModelCenter(props: ModelCenterProps): React.JSX.Element
  ```

- [ ] **Step 1: 编写模型与供应商中心测试**

在 `packages/web/test/model-center.test.ts` 中编写测试：
- 纯函数模型测试：供应商分类（商业云端/本地私有/已配置）、模型列表过滤；
- 卡片测试：供应商接入徽章、启用模型数统计、测速延迟；
- 抽屉测试：API Key 掩码防覆写、Base URL、模型启用 Switch 清单、测试连通性、0 Emoji。

- [ ] **Step 2: 运行测试并验证失败**

运行：`pnpm --filter @helm/web test -- test/model-center.test.ts`  
预期：FAIL

- [ ] **Step 3: 实现模型纯函数模型、卡片、抽屉与全屏容器**

1. `model-center-model.ts`：供应商与凭证分类汇总；
2. `ModelCard.tsx`：供应商接入卡片；
3. `ModelDetailDrawer.tsx`：API Key 安全配置表单与模型启用开关列表；
4. `ModelCenter.tsx`：全屏供应商网格流与顶栏工具；
5. `styles.css`：补充模型中心样式。

- [ ] **Step 4: 运行测试并验证通过**

运行：`pnpm --filter @helm/web test -- test/model-center.test.ts`  
预期：PASS

- [ ] **Step 5: 提交代码**

```bash
git add packages/web/src/models/ packages/web/src/styles.css packages/web/test/model-center.test.ts
git commit -m "feat(web): 实现全屏模型与供应商中心（ModelCenter）与凭证抽屉"
```

---

### Task 6: 全局主舞台挂载、导航收敛、旧模态物理清理与端到端集成 (`App.tsx`, `Sidebar.tsx`, 物理删除)

**Files:**
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/shell/Sidebar.tsx`
- Modify: `packages/web/src/modals/CommandPaletteModal.tsx`
- Delete: `packages/web/src/modals/ProfileEditorModal.tsx`
- Delete: `packages/web/src/modals/SkillViewerModal.tsx`
- Delete: `packages/web/src/modals/NodesModal.tsx`
- Delete: `packages/web/src/modals/ProviderCatalog.tsx`
- Delete: `packages/web/src/modals/provider-auth.css`
- Modify: 历史依赖旧 modal 文件源码读取的单测文件
- Test: `packages/web/test/primary-centers-integration.test.ts`

- [ ] **Step 1: 编写全中心端到端集成测试**

在 `packages/web/test/primary-centers-integration.test.ts` 中编写集成测试：
- 验证主舞台根据 `store.primaryTarget.kind` 渲染对应的全屏中心；
- 验证侧栏 5 大底栏按钮激活高亮与路由跳转；
- 验证 ⌘K 命令面板直达各大中心与子项抽屉；
- 静态扫描全仓物理排除旧四大模态残留；
- 验证全界面绝对零 Emoji。

- [ ] **Step 2: 运行测试并验证失败**

运行：`pnpm --filter @helm/web test -- test/primary-centers-integration.test.ts`  
预期：FAIL

- [ ] **Step 3: 挂载主舞台、收敛侧栏、物理删除旧模态并迁移历史单测**

1. `App.tsx`：在主舞台和分屏舞台挂载 `profiles`, `skills`, `nodes`, `models` 四大中心组件；增加历史深链重定向守卫；
2. `Sidebar.tsx`：将底栏 5 大按钮统一改为 `openTarget({ kind: ... })` 并设置当前高亮状态；
3. `CommandPaletteModal.tsx`：内置命令与子项全部直达对应一级视图与抽屉；
4. 物理删除 4 大旧模态文件；
5. 更新历史单测中读取旧模态文件的断言点，迁移到新抽屉/组件契约。

- [ ] **Step 4: 运行全量构建与所有单测**

```bash
pnpm build && pnpm typecheck && pnpm test
```
预期：全仓所有包构建成功，类型检查 0 错误，全量 2470+ 单元测试 100% 全部通过。

- [ ] **Step 5: 提交代码并推送主线**

```bash
git add -A
git commit -m "feat(web): 完成全屏资源中心矩阵全面重构，收敛全局导航并彻底淘汰旧模态"
git push origin main
```
