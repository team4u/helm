# 三大声明式动作指令

动作字段（action）的值是以下三种指令对象之一：

1. 调用插件动作：`{ "type": "helm:action", "pluginId": "<pluginId>", "actionId": "<actionId>", "input": {} }`。聊天块应显式传 pluginId（例如 builtin:triggers）；actionId 是该插件内的 ID，先查询动作清单与 Schema（`helm actions list --json`）。
2. 打开目标：`{ "type": "helm:open", "target": "conversation:<id>" | "screen:<pluginId>/<screenId>" | "artifact:<id>", "split": true }`（target 为 "artifact:<id>" 时直接打开产物预览弹窗；split 为 true 时会话/Screen 开分屏）。正文中亦可用 `[文件名](artifact:<id>)` 或 `![标题](artifact:<id>)` 直接内联渲染产物。
3. 发送输入：`{ "type": "helm:send", "target": "current", "text": "..." }`（以 human 来源提交）。target 省略或写 `"current"` 时默认发往当前会话——在会话卡片内交互时请这样写；仅当明确要发给另一个会话时才用 `"conversation:<id>"`。

## 安全边界

- 纯展示组件（Text/Markdown/Badge/Metric 等）不得自动调用动作；动作仅在用户显式点击/提交时触发。
- 表单输入值经 `{$value}` 提交，组件本身不执行任意 JS；求值器只解析数据路径，无 eval。
