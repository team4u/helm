# Web 首版验收记录

本轮按「主代理制定样式、布局和共享契约，GLM 在独立 worktree 实现，主代理逐项复核与浏览器验收」完成。

## 结果

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck`（含全部包的生产构建） | 退出码 0 |
| `timeout 60s pnpm test` | 960 通过，0 失败、跳过、取消 |
| Web 专项测试 | 75 项，覆盖消息归一化、表达式、表格行操作、配置保存、SSE 与历史引用 |
| 生产构建浏览器新会话 | 无 JavaScript 页面错误 |
| axe WCAG 2A/2AA，主页面浅/深色 | 本次检查均 0 violation |
| axe WCAG 2A/2AA，Profile 对话框浅/深色 | 本次检查均 0 violation |

可访问性结果仅对应本轮实际打开的页面状态，不代表穷举全部组件与插件。

## 浏览器操作覆盖

使用 `agent-browser` 技能在真实 Chromium 中检查：

1. 首次设置主控密码、登录、主题切换。
2. 个人助理入口、自由会话导航、Profile 配置、插件启用后的导航和 screen 出现。
3. Herdr 已有 OverviewDoc 的真实只读窗格列表、SuperAgent 现有状态和图谱视图。
4. 实际执行一次 `bash` 工具，检查 Call/Result 同行、执行顺序、Markdown 表格、代码高亮、Mermaid SVG 与声明式消息卡片。
5. 真实审批卡以 `'true' / 'false'` 提交确认，处理后收起为单行记录。
6. 上传 Markdown 文件、发送附件；带中文文件名的登记产物可预览和下载，不再触发 Response Header 的 ByteString 错误。
7. 85 轮历史超出首批详情页，搜索最早输入的唯一标记，自动加载早期条目，将 FTS `input:<submissionId>` 映射为真实 entry ID 并定位高亮。
8. 临时 JSON Spec 样例的表格行操作打开正确会话；Switch 布尔参数通过后端 Schema 校验，public doc 经 SSE 更新画面。
9. 左右分屏的窄顶栏、390px 视口导航与上下分屏、明暗主题。
10. 停止并重启前端代理服务：保留已加载页面，显示连接中断提示，自动重连、重取可见会话详情与 public docs。

固定模型输出来自 SDK faux provider；持久会话、SQLite、HTTP、工具执行和附件落盘均走真实代码。此次没有使用真实模型凭据，因此不包含真实模型服务商的视觉能力验收。

## 验收中修复的问题

- 模型目录真实契约不含前端假定的 `id`：改为边界组装 provider/modelId。
- 表格行动作在注入 `$row` 之前求值：延迟到点击时处理，保持数字/布尔类型。
- KeyValueList 的 pointer key 提前转成数字导致显示破折号。
- 远端表单值更新、本地未保存输入保护、独立 pending key 和连点竞态。
- 插件 secret 掩码覆盖真实密钥；Profile PUT 被误当成局部更新丢失基础字段；旧记忆无修改时不再回写。
- SSE 序号检查、断线快照恢复、首次详情与新 entry 并发、同帧审批结算。
- 审批 confirm 值编码错误、工具折叠缓冲改变执行顺序、流式正文与已落库消息重复。
- 历史分页、FTS 引用定位、中文附件响应头、上传中提前发送。
- 小屏顶栏拥挤、侧栏嵌套交互、主题文本对比度、模态名称和键盘焦点。
- 五包拆分后集成测试仍引用旧 CLI 入口：仅将引用对齐到 `packages/cli/src/index.ts`。

## 界面样例

- [浅色分屏](screenshots/split-light.png)
- [深色分屏](screenshots/split-dark.png)
- [小屏布局](screenshots/mobile.png)
- [长历史搜索定位](screenshots/search-history.png)
- [中文附件预览](screenshots/artifact.png)

## 已知范围

- 外部插件 `client.tsx` 编译及动态加载尚未接通，当前明确提示使用 JSON Spec；内置插件的 JSON Spec 通道已可用。
- Hub 尚不托管 `packages/web/dist`，本轮通过 Vite 开发代理和生产 preview 联调。
- Mermaid 的部分图表代码块仍超过 Vite 默认 chunk 提示阈值，按需加载；该构建警告没有隐藏或提升阈值消除。
- 触发器业务模块没有在本轮修改。Web 只消费其已提供的通用 UI 贡献。

后续插件以 [界面基线](../README.md) 为入口；可重复的独立服务见 `scripts/web-acceptance.mjs`。
