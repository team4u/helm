# 生成式 UI 参考

在回复正文中输出 ```ui（或 ```json-render）围栏代码块，内容为单个 JSON 对象，Web 端会内联渲染为交互式卡片。

## 适用边界（不滥用）

- 适用：多维指标总览、对比表格、多步流程跟踪、需要用户交互（选择/输入/开关/按钮）的动作卡片。
- 不适用：普通问答、代码展示、简单列表——直接用标准 Markdown，不套 UI 块。
- 无 Emoji 规范：文案中严禁任何 Emoji；图标用 lucide 图标名（如 terminal、cpu、activity、check-circle、alert-triangle、git-branch、sparkles；注意没有 server 图标，磁盘/机器用 hard-drive）。

## 双形态

树状简写（推荐）：`{ "component": "Card", "title": "...", "children": [...] }`，children 数组可包含节点或字符串（字符串转 Text body）。
扁平形态：`{ "root": "id", "elements": { "id": { "type": "Card", "props": {}, "children": ["childId"] } } }`，子节点须在 elements 中定义。
插件视图（screen/settings.panel 等声明式轨道）可在 spec 里声明 `docs: [...]` / `sessionDocs: [...]`，求值域多出 `{$sessionDocs.<name>.<path>}`（按当前会话订阅的公开会话文档）。
聊天 UI 块使用独立 Spec，没有所属插件，不能订阅插件文档，也不注入 composer/screen 控制函数；当前协议没有通用 `$state` 表单 store，输入组件通过各自 action 的 `{$value}` 提交；表格行内 `{$row}` 两边一致。

## 表达式求值（$docs / $sessionDocs / $data / $row / $value）

- `{$docs.<docName>.<path>}` / `{$data.<path>}`：插件公开 doc 与调用时传入的 data；插件视图另有 `{$sessionDocs.<name>.<path>}`（当前会话的公开会话文档）。
- 整个属性值恰好为单个 `{...}` 表达式时保持原始 JS 类型（number/boolean/array/object）；嵌在长文本中则为字符串插值。
- `{$row.<field>}` 仅在 Table 的 rowActions 内可用；`{$value}` 在表单组件的 action 内可用（提交值）。

## 全部 {{PRIMITIVE_COUNT}} 个原语真实 Props 契约

### 布局与展示（13 个）

- `Stack`：`direction`（vertical|horizontal，缺省 vertical）、`gap`（数字）、`children`。
- `Card`：`title`、`subtitle`、`children`。
- `Text`：`text`、`variant`（body|title|muted|mono）、`lineClamp`（正整数）。
- `Badge`：`text`、`tone`（neutral|accent|ok|warn|err）、`icon`（lucide 图标名）。
- `Markdown`：`text`（标准 Markdown 渲染；无其他 props）。
- `MetricGrid`：`cols`（1..6）、`children`（MetricCard 列表）。
- `MetricCard`：`label`、`value`、`hint`、`tone`（ok|warn|err|accent，缺省默认色）。
- `KeyValueList`：`items: [{ label, value }]`。
- `Callout`：`tone`（info|warn|err|ok）、`title`、`text`、`children`。
- `Steps`：`items: [{ title, detail?, status? }]`，status 为 pending|running|done|failed。
- `BarList`：`items: [{ label, value, max? }]`（横向占比条）。
- `Table`：`columns: [{ key, label? }]`、`rows`（对象数组）、`empty`（空表文案）、`rowActions: [{ label, tone?: primary|danger, action }]`（action 内可用 `{$row.field}`）。
- `Accordion`：`title`、`defaultOpen`（布尔，缺省 true）、`children`。

### 表单与交互（7 个）

- `TextInput`：`label?`、`placeholder?`、`value?`、`secret?`（password 型）、`action?`（提交按钮触发，`{$value}` 为输入值）。
- `Select`：`label?`、`value?`、`options: [{ label, value }]`、`action?`（选中即触发，`{$value}`）。
- `Switch`：`label?`、`value?`（布尔）、`action`（切换即触发，`{$value}` 为新布尔值）。
- `CheckboxGroup`：`label?`、`value?`（已选 value 数组）、`options: [{ label, value }]`、`action?`（`{$value}` 为选中数组）。
- `Button`：`label`、`icon?`、`variant?`（primary|danger|ghost）、`action`。
- `ActionBar`：`actions: [{ label, icon?, variant?, action }]` 或 `children`（横向按钮组）。
- `Tabs`：`tabs: [{ id, label, children }]`（children 为树状节点数组）。
- `Slot`：插件视图专用——`name`（短名解析为当前插件 `name`，或全限定 `owner/xxx`）、`mode`（list|single，缺省 list）、children 作为无贡献时 fallback。渲染其他插件经 `ctx.ui.slot({ target })` 注入的贡献，各贡献项独立错误边界。

## 三大声明式动作指令

动作字段（action）的值是以下三种指令对象之一：

1. 调用插件动作：`{ "type": "helm:action", "pluginId": "<pluginId>", "actionId": "<actionId>", "input": {} }`。聊天块应显式传 pluginId（例如 builtin:triggers）；actionId 是该插件内的 ID，先查询动作清单与 Schema。
2. 打开目标：`{ "type": "helm:open", "target": "conversation:<id>" | "screen:<pluginId>/<screenId>" | "artifact:<id>", "split": true }`（target 为 "artifact:<id>" 时直接打开产物预览弹窗；split 为 true 时会话/Screen 开分屏）。正文中亦可用 `[文件名](artifact:<id>)` 或 `![标题](artifact:<id>)` 直接内联渲染产物。
3. 发送输入：`{ "type": "helm:send", "target": "current", "text": "..." }`（以 human 来源提交）。target 省略或写 `"current"` 时默认发往当前会话——在会话卡片内交互时请这样写；仅当明确要发给另一个会话时才用 `"conversation:<id>"`。

## 完整示例（树状、合法）

```ui
{
  "component": "Card",
  "title": "节点巡检示例",
  "subtitle": "以下为格式示例；实际回复需换成本轮查询结果",
  "children": [
    { "component": "MetricGrid", "cols": 3, "children": [
      { "component": "MetricCard", "label": "在线", "value": "1", "tone": "ok" },
      { "component": "MetricCard", "label": "离线", "value": "1", "tone": "err" },
      { "component": "MetricCard", "label": "平均负载", "value": "0.42", "hint": "1 分钟" }
    ] },
    { "component": "Table", "columns": [
      { "key": "nodeId", "label": "节点" },
      { "key": "status", "label": "状态" },
      { "key": "diskFreeGb", "label": "剩余磁盘" }
    ], "rows": [
      { "nodeId": "local", "status": "online", "diskFreeGb": 128 },
      { "nodeId": "build-01", "status": "offline", "diskFreeGb": null }
    ] },
    { "component": "ActionBar", "actions": [
      { "label": "重新巡检", "icon": "refresh-cw", "variant": "primary", "action": { "type": "helm:send", "target": "current", "text": "请重新巡检全部节点" } },
      { "label": "打开助理", "icon": "terminal", "action": { "type": "helm:open", "target": "conversation:1", "split": true } }
    ] }
  ]
}
```
