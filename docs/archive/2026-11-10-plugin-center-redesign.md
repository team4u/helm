# 全屏插件中心（Plugin Center）重构设计规范

## 1. 目标与背景

当前 `@helm/web` 中的「插件与设置」采用固定尺寸居中模态弹窗（`PluginSettingsModal`，最大宽度 860px），内部由 240px 窄列表与右侧拥挤的配置表单构成。
随着系统能力不断扩展，未来将承载数十上百个核心内置插件、协同编排插件、模型网关插件、触发器连接器及三方外部扩展。现有弹窗结构局促，缺乏多维检索、分类组织与能力透视，无法满足未来插件生态的发展需求。

本规范定义全新的**全屏插件中心（Plugin Center）**：将插件视图提升为一级全屏视图，采用响应式卡片网格（Marketplace Grid）与右侧深度配置抽屉（Detail Drawer），提供高维搜索、分类过滤与能力清单透视，兼具极佳的视觉呈现与高效的管理体验。

---

## 2. 架构设计与导航契约

### 2.1 路由契约与一级目标升格

遵循 `docs/conventions/web-navigation.md` 的唯一事实来源原则，将插件中心升格为系统一级主舞台视图：

1. **类型扩展（`packages/web/src/lib/types.ts`）**：
   ```ts
   export type ResolvedTarget =
     | { kind: 'conversation'; id: number }
     | { kind: 'screen'; pluginId: string; screenId: string; params?: Record<string, string> }
     | { kind: 'plugins'; pluginId?: string }
   ```
2. **Hash 编解码契约（`packages/web/src/lib/url-hash-model.ts`）**：
   - 基础路由：`#/plugins` 直达插件中心；
   - 携带选中的插件：`#/plugins?p=<pluginId>`，打开插件中心并自动滑出该插件的配置抽屉；
   - 浏览器前进/后退/刷新时，完全保持当前插件中心的激活状态与抽屉展开状态；
   - 关闭抽屉时，平滑 `replace` 历史为 `#/plugins`，不污染后退栈。
3. **全局调用收敛**：
   - 侧边栏左下角原「插件与设置」齿轮按钮直接调用 `store.openTarget({ kind: 'plugins' })`；
   - 命令面板（⌘K）「插件与设置」动作直接导航至 `{ kind: 'plugins' }`；
   - 模型提供商设置中的「插件连接设置」链接直达 `{ kind: 'plugins', pluginId }`；
   - 废弃原先的全局小弹窗 `activeModal = { kind: 'plugin-settings' }`，保持架构简洁。

---

## 3. 界面布局与交互规范

严格遵守 `AGENTS.md` 铁律：**全界面极简克制，严禁使用任何 Emoji 图标**，统一使用 `lucide-react` 线性矢量图标与纯文本排版。

### 3.1 顶部工具与检索栏
- **全局搜索框**：支持对插件名称、插件 ID、暴露的 Tool 名称（如 `subagent`、`bash`）以及 Action 名称进行实时模糊匹配；
- **状态筛选器（SegmentedControl / Tabs）**：
  - `全部 (All)`：显示所有插件；
  - `已启用 (Enabled)`：仅显示处于运行激活态的插件；
  - `已停用 (Disabled)`：仅显示已停用插件。
- **分类标签过滤（Tag Pills）**：
  - `全部`、`核心系统`（`builtin:assistant` 等）、`协同编排`（`workflow`, `herdr`, `superagent` 等）、`外部扩展`（三方与自定义插件）；
- **统计徽章**：右上角呈现精简统计（如 `共 5 个插件 · 4 个已启用`）。

### 3.2 响应式卡片网格（Plugin Grid）
- 主视口采用 `grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))` 弹性网格；
- **单卡片（PluginCard）结构**：
  - **顶部**：插件线性图标、插件名称、ID 与版本徽章；常驻核心插件展示 `lock` 图标与「常驻」轻徽章；
  - **中部**：插件简短描述，未声明描述时根据类型展示默认能力标签；
  - **能力小胶囊（Feature Pills）**：
    - `N Tools`：暴露的模型调用工具数；
    - `M Actions`：声明的 HTTP/CLI 动作数；
    - `Hooks`：挂载的内核生命周期钩子数；
  - **底栏**：右下角提供高品质 Switch 快捷启停开关（不可卸载的核心插件禁用开关并标识锁定）。点击卡片其余区域触发打开右侧配置抽屉。

### 3.3 右侧配置与详情抽屉（PluginDetailDrawer）
- 宽度约 480px ~ 540px，利用 Radix UI Dialog / Sheet 原语构建；
- **抽屉内容区**：
  1. **插件头部**：大图标、完整名称、插件唯一 ID、版本、作者及锁定状态；
  2. **快速动作栏**：主启停按钮（带防重复提交状态）、停用前在途任务冲突检查（409 处理）；
  3. **能力清单透视**：
     - **Tools 清单**：列出所有注册的 Agent Tool；
     - **Actions 清单**：列出暴露的 CLI/HTTP 动作 ID；
     - **Hooks 清单**：列出拦截的内核扩展点；
  4. **动态配置项表单（PluginConfigForm）**：
     - 根据插件配置 Schema 自动渲染文本框、数字框、布尔开关；
     - Secret 密钥字段自动识别，输入密码保护，已配置留空保持原样，安全保存；
  5. **插件自定义扩展面板（SettingsPanels）**：
     - 若插件通过 UI 扩展点声明了 `settingsPanels`，利用 `PluginUiView` 完整挂载渲染。

---

## 4. 模块结构与职责边界

```
packages/web/src/plugins/
├── plugin-center-model.ts       # 纯函数模型：过滤、分类推导、能力汇总、统计计算
├── PluginCard.tsx              # 单张插件卡片视图组件
├── PluginDetailDrawer.tsx      # 右侧滑出式详情与配置抽屉
└── PluginCenter.tsx            # 全屏插件中心主视图容器
```

- **`plugin-center-model.ts`**：
  - `filterPlugins(plugins, query, statusFilter, categoryFilter)`：多维搜索与过滤纯函数；
  - `derivePluginCategory(plugin)`：根据 ID 与特征推导分类；
  - `summarizePlugins(plugins)`：统计总数、启用数、工具总数；
  - 100% 独立于 React DOM，全覆盖自动化单元测试。
- **`PluginCard.tsx`**：
  - 仅导出 React 组件，保障 Fast Refresh；无行内深色硬编码样式，严格遵循 CSS 变量与主题规范。
- **`PluginDetailDrawer.tsx`**：
  - 接入已有的 `pluginsApi.getConfig` 与 `pluginsApi.setConfig`，带请求代数防竞争保护。

---

## 5. 测试与验证策略

1. **纯函数逻辑单测（`test/plugin-center-model.test.ts`）**：
   - 测试按名称、ID、Tool、Action 的搜索匹配准确性；
   - 测试各种状态过滤与分类标签的边界；
   - 测试空列表与无匹配结果的健壮性。
2. **路由与导航单测（`test/plugin-center-nav.test.ts`）**：
   - 验证 `#/plugins` 与 `#/plugins?p=<id>` 的编解码往返；
   - 验证深链直达与抽屉关闭时的参数同步；
   - 保证浏览器前进后退历史栈正常。
3. **渲染契约测试（`test/plugin-center-render.test.ts`）**：
   - SSR 与 Node.js 环境下卡片网格与抽屉正常直出；
   - 静态断言验证全界面 0 Emoji 表情。
