# Web 导航与 URL Hash 开发约定

新增或修改会话入口、插件 Screen、分屏、工作台页签、管理弹窗或产物预览时，先阅读本文。排查刷新后位置丢失、深链失效、浏览器前进/后退或弹窗选中项同步问题时，也应阅读本文。

## 可恢复状态的边界

可定位界面必须支持复制链接直达、刷新恢复及浏览器前进/后退。

不是所有组件状态都要进入 URL。输入草稿、未保存表单、展开/悬停状态、命令面板和短暂消息高亮不属于位置。密钥、令牌及表单内容严禁写入 URL。

## 唯一导航机制

- 位置类型：`packages/web/src/lib/types.ts` 中的 `ResolvedTarget` / `ActiveModal`。
- Hash 契约：`packages/web/src/lib/url-hash-model.ts`。
- 浏览器同步：`packages/web/src/lib/HelmStoreProvider.tsx`。

组件使用 `store.openTarget / closeSplit / setWorkbenchOpen / setWorkbenchTab / setActiveModal`。不得另建平行路由、直接操作浏览器历史或用组件本地状态管理已有的全局导航位置。

## 新增界面的接入方式

- 新增会话、插件 Screen 或工作台面板时，复用现有目标 ID，无需新增路由分支或插件 ID 特判。
- 新增顶层弹窗类型时，同步补齐 `ActiveModal`、Hash 编解码、宿主渲染及测试。
- 插件内部子页面目前不会自动恢复。若需要独立深链，先明确位置契约，不自行拼接 Hash 参数。

## 弹窗选中项双向同步

列表内点选须写回 `activeModal`。外部 URL 导致的 `initial*Id` 变化须更新本地选中项，但不得用旧选中项反向覆盖 URL，也不得在关闭或切换弹窗后重开旧弹窗。

可复用 `packages/web/src/modals/list-modal-selection.ts` 的决策函数。

不得把“空列表”等同于“加载完成且目标不存在”。不得因导航同步重置本地事件刚创建的表单草稿。

## 历史记录与错误语义

- 切换主屏/分屏、开关工作台或持久弹窗时使用 push。
- 在同一列表弹窗内切换子项、在工作台内切换 Tab 时使用 replace。
- 历史策略统一维护在 `shouldPushLocationHistory`。
- 未认证时保留请求的深链。
- 合法但不存在的会话或不可用视图须显式提示。不得仅因初始数据尚未返回而回到默认页面。

## 导航验收

修改位置契约时，补齐编解码往返、特殊字符与非法输入测试。基础用例见 `packages/web/test/url-hash*.test.ts`。

验证直达后刷新、前进/后退、异步加载与弹窗内选中项同步。纯函数测试不能替代浏览器交互验收。
