# 原语 Props 契约（21 个）

## 布局与展示（14 个）

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
- `Slot`：插件视图专用——`name`（短名解析为当前插件 `name`，或全限定 `owner/xxx`）、`mode`（list|single，缺省 list）、children 作为无贡献时 fallback。渲染其他插件经 `ctx.ui.slot({ target })` 注入的贡献，各贡献项独立错误边界。

## 表单与交互（7 个）

- `TextInput`：`label?`、`placeholder?`、`value?`、`secret?`（password 型）、`action?`（提交按钮触发，`{$value}` 为输入值）。
- `Select`：`label?`、`value?`、`options: [{ label, value }]`、`action?`（选中即触发，`{$value}`）。
- `Switch`：`label?`、`value?`（布尔）、`action`（切换即触发，`{$value}` 为新布尔值）。
- `CheckboxGroup`：`label?`、`value?`（已选 value 数组）、`options: [{ label, value }]`、`action?`（`{$value}` 为选中数组）。
- `Button`：`label`、`icon?`、`variant?`（primary|danger|ghost）、`action`。
- `ActionBar`：`actions: [{ label, icon?, variant?, action }]` 或 `children`（横向按钮组）。
- `Tabs`：`tabs: [{ id, label, children }]`（children 为树状节点数组）。
