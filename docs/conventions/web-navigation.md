# Web 导航与 URL Hash 开发约定

本文是 Web 端位置管理的可执行贡献指南：新增或修改会话入口、插件 Screen、分屏、工作台页签、管理弹窗或产物预览前先阅读本文；排查刷新后位置丢失、深链失效、浏览器前进/后退异常或弹窗选中项不同步时也应阅读。设计系统与视图形态约定见[Web 前端设计系统](web-frontend.md)。

## 当前状态与可恢复状态的边界

全站位置由唯一模型管理，可定位界面必须支持复制链接直达、刷新恢复与浏览器前进/后退。不是所有组件状态都要进 URL：输入草稿、未保存表单、展开/悬停状态、命令面板和短暂消息高亮不属于位置；**密钥、令牌及表单内容严禁写入 URL**。

## 唯一导航机制

组件不得另建平行实现，三个层次各司其职：

| 层次 | 位置 | 职责 |
| :--- | :--- | :--- |
| 位置类型 | `packages/web/src/lib/types.ts` | `ResolvedTarget` / `ActiveModal` / `SidebarSpace`（含 `spaceForTarget` 推导） |
| Hash 契约 | `packages/web/src/lib/url-hash-model.ts` | 唯一编解码真源（零 React/DOM 依赖的纯函数） |
| 浏览器同步 | `packages/web/src/lib/HelmStoreProvider.tsx` | 唯一写回路径与历史策略 |

组件统一调用 `store.openTarget / closeSplit / setScreenParams / setWorkbenchOpen / setWorkbenchTab / openSpace / setActiveModal` 导航。不得另建平行路由、直接操作 `history.*`，或用组件本地状态管理已有全局位置。

### 层级化路径树

| Hash | 目标 |
| :--- | :--- |
| `#/c/<id>` | 会话 |
| `#/a/<profileId>` | 智能体待命页 |
| `#/views/<pluginId>/<screenId>` | 插件全屏视图 |
| `#/settings/profiles[/<profileId>]` | 角色中心 |
| `#/settings/models[/<providerId> \| /defaults \| /<providerId>/defaults]` | 模型中心（`defaults` 保留段 = 全局默认 Tab） |
| `#/settings/skills[/<skillId>]` | 技能中心 |
| `#/settings/nodes[/<nodeId>]` | 节点中心 |
| `#/settings/plugins[/<pluginId>]` | 插件中心 |

侧栏空间（`conversations | views | settings`）由主屏目标唯一推导，不是独立 URL/Store 状态：Rail 点击经 `store.openSpace` 导航到该空间最近记忆的主屏目标（无记忆取空间缺省），经 push 入栈；已在当前空间 no-op 不产生历史项；记忆指向已失效目标时安全清理并回退缺省，绝不伪造不存在目标。浏览器前进/后退（hashchange/popstate）以 URL 为唯一事实来源。路径段内斜杠必须编码、冒号保留可读；非法段（含全部旧路径形态）静默回退默认主屏 `#/settings/profiles`。**首页落地**：空 Hash 进入不是导航意图——认证与资产就绪后主屏以 replace 落到对话空间缺省目标（最新根会话所属角色的待命页，无会话时首个可用角色），不入历史栈。

### 智能体待命目标与「首次发送才落库」

- `{ kind: 'agent'; profileId; nodeId?; cwd? }` 表达待命页：智能体是稳定会话入口，删除会话不等于离开智能体；
- 草稿环境用顶层查询参数 `node=<nodeId>&cwd=<cwd>` 序列化；分屏目标的环境编码在 `split` 值内部（`split=a/<id>?node=…&cwd=…`），两套命名空间互不串扰；
- **新建对话进待命页、首次发送才落库**：待命草稿不预创建会话；发送时按草稿环境创建真实会话并迁移（`replace` 不污染后退栈）。

### 历史策略红线

- push：切换主屏/分屏、开关工作台、持久弹窗、Rail 空间切换；
- replace：同一弹窗内切换子项、工作台内切 Tab、同一 screen 仅改参数、待命目标仅改草稿环境、删除回退与草稿→真实会话迁移；
- `replace` 只替换当前历史项，不能也不宣称清空整个历史栈；历史策略统一维护在 `shouldPushLocationHistory`，调用方可经 `openTarget({ history })` 覆写下一拍；
- 访问已删除会话的深链显式提示不存在，不得路由循环或静默跳转。

## 插件 Screen 路由参数

`screen` 目标可携带字符串参数（`ResolvedTarget.params`），三类入口：

1. 声明式目标字符串 `screen:<pluginId>/<screenId>?k1=v1`（`sidebarItem.target` / `helm:open` / `ctx.openScreen`）；
2. 地址栏命名空间参数：主屏 `sp.<k>=<v>`，分屏 `ssp.<k>=<v>`——两套命名空间互不冲突，同一 screen 双开时参数各自独立；
3. 组件内 `setParams(patch, { push? })`——经 `store.setScreenParams` 消费，值为 `undefined` 时删除键。

约束：参数键非空且匹配 `^[A-Za-z0-9._-]+$`；`__proto__` / `constructor` / `prototype` 等原型键一律拒绝；声明式目标字符串严格解析（非法编码、空键值、重复键判整体无效），地址栏不合法 `sp.*` / `ssp.*` 项静默丢弃；参数按字典序稳定序列化；主屏切回会话或关闭分屏时对应命名空间参数随之丢弃；同一 screen 仅参数变化默认 `replace`（避免筛选器每次按键污染后退栈），显式 `{ push: true }` 才入栈。

## 新增界面的接入方式

- 新增会话、插件 Screen 或工作台面板：复用现有目标 ID，无需新增路由分支或插件 ID 特判；
- 新增顶层弹窗类型：同步补齐 `ActiveModal`、Hash 编解码（`modal=<kind>` + `id=<选中项>` 形态）、宿主渲染与测试；
- 插件内部子页面不自动恢复；需要独立深链先明确位置契约，不自行拼接 Hash。`sp.*` / `ssp.*` 由宿主统一编解码与恢复，不受此限制。

## 弹窗选中项双向同步

列表内点选必须写回 `activeModal`。外部 URL 导致的 `initial*Id` 变化须更新本地选中项，但不得用旧选中项反向覆盖 URL，也不得在关闭或切换后重开旧弹窗。可复用 `packages/web/src/modals/list-modal-selection.ts` 的决策函数。两条语义红线：不得把「空列表」等同「加载完成且目标不存在」；不得因导航同步重置本地刚创建的表单草稿。

## 错误语义与验收

- 未认证时保留请求的深链；合法但不存在的会话或不可用视图必须显式提示，不得因初始数据未返回而回退默认页（待命页显式区分「加载中」与「不存在」）；
- 修改位置契约时补齐编解码往返、特殊字符与非法输入测试（基础用例 `packages/web/test/url-hash*.test.ts`，含浏览器式交互历史测试）；
- 纯函数测试不能替代浏览器交互验收：需实际验证直达后刷新、前进/后退、异步加载与弹窗内选中项同步（可用 `scripts/web-acceptance.mjs` 的真实浏览器验收服务）。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| Hash 编解码纯函数 | `packages/web/src/lib/url-hash-model.ts` |
| 位置类型与空间推导 | `packages/web/src/lib/types.ts` |
| 浏览器同步与历史策略 | `packages/web/src/lib/HelmStoreProvider.tsx` |
| 弹窗选中项决策 | `packages/web/src/modals/list-modal-selection.ts` |
| 测试 | `packages/web/test/url-hash*.test.ts` |

## 相关文档

- [Web 前端设计系统](web-frontend.md)：视图形态与组件约定
- [插件开发实战](../plugins/plugin-development.md)：`ctx.openScreen` 与声明式目标
- [JSON 卡片渲染](../plugins/json-render.md)：`helm:open` 动作指令的目标语法
