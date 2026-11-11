---
name: generative-ui
description: 在回复正文中输出交互式卡片/表单/表格（ui 代码块）时使用；涵盖原语 Props 契约、表达式求值与三大动作指令。
managedByPlugin: builtin:json-render
---

# 生成式 UI 参考

在回复正文中输出 ```ui 代码块，内容为单个 JSON 对象，Web 端会内联渲染为交互式卡片。

## 适用边界（不滥用）

- 适用：多维指标总览、对比表格、多步流程跟踪、需要用户交互（选择/输入/开关/按钮）的动作卡片。
- 不适用：普通问答、代码展示、简单列表——直接用标准 Markdown，不套 UI 块。
- 无 Emoji 规范：文案中严禁任何 Emoji；图标用 lucide 图标名（如 terminal、cpu、activity、check-circle、alert-triangle、git-branch；注意没有 server 图标，磁盘/机器用 hard-drive）。

## 双形态

树状简写（推荐）：`{ "component": "Card", "title": "...", "children": [...] }`，children 数组可包含节点或字符串（字符串转 Text body）。
扁平形态：`{ "root": "id", "elements": { "id": { "type": "Card", "props": {}, "children": ["childId"] } } }`，子节点须在 elements 中定义。

聊天 UI 块使用独立 Spec，没有所属插件，不能订阅插件文档，也不注入 composer/screen 控制函数；当前协议没有通用 `$state` 表单 store，输入组件通过各自 action 的 `{$value}` 提交；表格行内 `{$row}` 同理。插件视图（screen/settings.panel 等声明式轨道）可订阅插件文档，求值域多出 `{$sessionDocs.<name>.<path>}`。

## 表达式求值（$docs / $sessionDocs / $data / $row / $value）

- `{$docs.<docName>.<path>}` / `{$data.<path>}`：插件公开 doc 与调用时传入的 data；插件视图另有 `{$sessionDocs.<name>.<path>}`（当前会话的公开会话文档）。
- 整个属性值恰好为单个 `{...}` 表达式时保持原始 JS 类型（number/boolean/array/object）；嵌在长文本中则为字符串插值。
- `{$row.<field>}` 仅在 Table 的 rowActions 内可用；`{$value}` 在表单组件的 action 内可用（提交值）。

## 按需下钻

- 全部原语真实 Props 契约（21 个）：`load_skill({ skillId: "generative-ui", path: "references/primitives.md" })`
- 三大声明式动作指令：`load_skill({ skillId: "generative-ui", path: "references/actions.md" })`

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
