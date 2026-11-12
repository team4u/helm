# Web 导航与 URL Hash 开发约定

新增或修改会话入口、插件 Screen、分屏、工作台页签、管理弹窗或产物预览时，先阅读并遵守本文。排查刷新后位置丢失、深链失效、浏览器前进/后退异常或弹窗选中项不同步等问题时，也应阅读本文。

## 1. 可恢复状态的边界

可定位的界面必须支持复制链接直达、刷新恢复与浏览器前进/后退。

不是所有组件状态都要进入 URL。输入草稿、未保存表单、展开/悬停状态、命令面板和短暂消息高亮不属于位置；密钥、令牌及表单内容严禁写入 URL。

## 2. 唯一导航机制

全站位置由单一模型管理，组件不得另建平行实现：

- 位置类型：`packages/web/src/lib/types.ts` 中的 `ResolvedTarget` / `ActiveModal`；
- Hash 契约：`packages/web/src/lib/url-hash-model.ts`（唯一编解码真源）;
- 浏览器同步：`packages/web/src/lib/HelmStoreProvider.tsx`。

组件使用 `store.openTarget / closeSplit / setScreenParams / setWorkbenchOpen / setWorkbenchTab / setActiveModal` 导航。不得另建平行路由、直接操作浏览器历史，或用组件本地状态管理已有的全局导航位置。

### 2.1 智能体待命目标（agent）与首次发送才落库

- `ResolvedTarget` 的 `{ kind: 'agent'; profileId; nodeId?; cwd? }` 表达智能体待命页：智能体是稳定的会话入口，不把删除会话等同离开智能体；
- Hash 形式：主屏 `#/a/<encodedProfileId>`，草稿环境用顶层查询参数 `node=<nodeId>&cwd=<cwd>` 序列化；分屏目标的环境编码在 `split` 值内部（`split=a/<id>?node=…&cwd=…`），两套命名空间互不串扰；仅 profileId 参与路径段（含斜杠/问号必须编码），环境参数空串视为未设置；
- 待命态是真草稿：不预创建会话、不伪造 ConversationSummary；首次真正发送才 create -> （可选 patch thinkingLevel）-> 上传附件 -> submitInput；create 锁定会话后模型/思考档位/起始环境一并锁定（重试复用，不显示可改而不生效的控件）；
- 待命草稿只存内存，身份是完整入口坐标（面板 + Profile + 继承的 node/cwd）：同 Profile 不同远端坐标互不串草稿，旧坐标草稿保留；「恢复默认」经唯一导航移除 URL 中的继承环境参数（刷新不复活），正文随坐标转移且不无声覆盖已有草稿；logout 释放全部待命草稿并作废在途首发任务的后续回包；
- 所有用户新建入口（Sidebar 名称/加号、会话页「新话题」、Composer `/new`、命令面板「新建对话」等）一律进入待命态，不 POST create；受管 singleton 依旧打开其真实会话；命令面板无当前 Profile 上下文时导航到角色中心选角色，不硬编码默认角色；`/clear` 仍重置当前会话上下文，待命页内 `/clear` `/compact` 显式提示需先创建会话，不作为普通输入发送；
- 删除导航集中在 Provider 的 `conversation.deleted` 管道：仅当被删的正是当前主屏目标时，以 `history: 'replace'` 回到该智能体待命态并继承被删会话的 `nodeId/cwd`（无 Profile 信息时显式回角色中心）；被删的是分屏目标只关闭对应分屏、是抽屉目标只关闭对应抽屉，均不影响主屏与其他目标；不选其他会话、不依赖组件快照；
- 声明式目标字符串 `agent:<id>` 同样解析为待命目标；`conversation:profile:<id>` 保持「查找常驻会话」语义（插件 singleton 不受影响）。

### 2.2 显式历史策略（history: 'push' | 'replace'）

- `store.openTarget(target, { history })` 只标记下一拍的历史策略；实际 pushState/replaceState 仍由 HelmStoreProvider 的唯一地址栏写回 effect 执行，组件不得直接调用 `history.*`；
- 约定：删除回退与 draft->真实会话迁移强制 `replace`（不污染后退栈）；普通手动导航继续 push；`replace` 只替换当前历史项，不能也不宣称清空整个历史栈；
- 访问更早已删除的会话深链：显式提示不存在，不得自动路由循环或静默跳转。

## 3. 插件 Screen 路由参数

`screen` 目标可携带字符串参数（`ResolvedTarget.params`），共三类入口：

1. 声明式目标字符串 `screen:<pluginId>/<screenId>?k1=v1&k2=v2`（`sidebarItem.target` / `helm:open` / `ctx.openScreen`）；
2. 地址栏命名空间参数：主屏 `sp.<k>=<v>`，分屏 `ssp.<k>=<v>`——两套命名空间互不冲突，同一 screen 双开时参数各自独立；
3. 组件内 `setParams(patch, { push? })`——经 `store.setScreenParams` 唯一导航机制消费，值为 `undefined` 时删除键。

约束如下：

- 参数键非空且匹配 `^[A-Za-z0-9._-]+$`；`__proto__` / `constructor` / `prototype` 等原型键一律拒绝；
- 声明式目标字符串采用严格解析：非法编码、空键值、重复键判整体无效（目标返回 null）；地址栏中不合法的 `sp.*` / `ssp.*` 项静默丢弃；
- 参数按字典序稳定序列化；主屏切回会话或关闭分屏时，对应命名空间参数随之丢弃；
- 同一 screen 仅参数变化默认 `replace`（避免筛选器每次按键污染后退栈），显式 `{ push: true }` 才入栈；跨 screen 或切会话沿用既有 `push`；
- `setParams` 不直接操作 `history`，`push` 标记由 HelmStoreProvider 的唯一写回路径消费。

## 4. 新增界面的接入方式

- 新增会话、插件 Screen 或工作台面板时，复用现有目标 ID，无需新增路由分支或插件 ID 特判；
- 新增顶层弹窗类型时，同步补齐 `ActiveModal`、Hash 编解码、宿主渲染与测试；
- 插件内部子页面目前不自动恢复；若需要独立深链，先明确位置契约，不自行拼接 Hash 参数。插件 Screen 的路由参数（`sp.*` / `ssp.*`）不属于此限制，由宿主统一编解码与恢复（见上节）。

## 5. 弹窗选中项双向同步

列表内点选必须写回 `activeModal`。外部 URL 导致的 `initial*Id` 变化须更新本地选中项，但不得用旧选中项反向覆盖 URL，也不得在关闭或切换弹窗后重开旧弹窗。可复用 `packages/web/src/modals/list-modal-selection.ts` 的决策函数。

两条语义红线：不得把「空列表」等同于「加载完成且目标不存在」；不得因导航同步重置本地事件刚创建的表单草稿。

## 6. 历史记录与错误语义

- 切换主屏/分屏、开关工作台或持久弹窗时使用 push；
- 在同一列表弹窗内切换子项、在工作台内切换 Tab、在同一 screen 内仅改参数、在同一 agent 待命目标内仅改草稿环境时使用 replace；
- 历史策略统一维护在 `shouldPushLocationHistory`，调用方可经 `openTarget({ history })` 显式覆写下一拍；
- 未认证时保留请求的深链；
- 合法但不存在的会话或不可用视图必须显式提示，不得仅因初始数据尚未返回而回到默认页面（角色资产未加载时待命页显式区分「加载中」与「不存在」）。

## 7. 导航验收

修改位置契约时，补齐编解码往返、特殊字符与非法输入测试；基础用例见 `packages/web/test/url-hash*.test.ts`（含 Screen 参数纯函数与浏览器式交互历史测试）。

纯函数测试不能替代浏览器交互验收：需实际验证直达后刷新、前进/后退、异步加载与弹窗内选中项同步。
