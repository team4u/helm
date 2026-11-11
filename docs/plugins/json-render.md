# JSON 卡片渲染插件

`builtin:json-render` 承载 Helm 的声明式 JSON 渲染策略（默认启用、可停用）：通过 `ctx.ui.markdownCodeBlock` 接管聊天消息中 ```` ```ui ```` 与 ```` ```json-render ```` 代码围栏，把模型输出的安全 JSON Spec 渲染为交互卡片（表单、列表、指标、图表原语）。这是机制与策略分离的典型案例——内核只提供 markdown 代码块扩展机制，本插件提供全部渲染策略；宿主核心不内置任何声明式 JSON 渲染轨道。

插件同时自举受管技能 `generative-ui`（SKILL.md + `references/primitives.md` + `references/actions.md`）：模型经目录发现该技能、按需下钻原语契约与动作指令，学会在回复正文中输出合法 Spec。技能随插件启停进入或离开可用技能目录。

## 双形态 Spec

渲染器接受两种等价的 JSON 形态：

**树状简写**（推荐）：`{ "component": "Card", "title": "...", "children": [...] }`。children 数组可混入节点对象或纯字符串（字符串转 `Text` body），嵌套结构直接表达层级。

```ui
{
  "component": "Card",
  "title": "节点巡检",
  "children": [
    { "component": "MetricGrid", "cols": 3, "children": [
      { "component": "MetricCard", "label": "在线", "value": "1", "tone": "ok" },
      { "component": "MetricCard", "label": "离线", "value": "1", "tone": "err" }
    ] }
  ]
}
```

**扁平形态**：`{ "root": "id", "elements": { "id": { "type": "Card", "props": {}, "children": ["childId"] } } }`。所有节点在 `elements` 中定义、以 ID 引用，适合深层复用与程序化生成。

聊天 UI 块是独立 Spec：没有所属插件，不能订阅插件文档、不注入 composer/screen 控制函数；当前协议没有通用 `$state` 表单 store，输入组件通过各自 action 的 `{$value}` 提交。

## 21 个标准原语

| 分类 | 原语（布局与展示 14 个） |
| :--- | :--- |
| 容器 | `Stack`（direction/gap）、`Card`（title/subtitle）、`Accordion`（title/defaultOpen）、`Slot`（插件视图专用子插槽） |
| 文本 | `Text`（variant/lineClamp）、`Markdown`、`Badge`（tone/icon） |
| 数据展示 | `MetricGrid` + `MetricCard`、`KeyValueList`、`Steps`、`BarList`、`Table`（columns/rows/rowActions） |
| 反馈 | `Callout`（tone/title/text） |

| 分类 | 原语（表单与交互 7 个） |
| :--- | :--- |
| 输入 | `TextInput`（secret 型密码框）、`Select`、`Switch`、`CheckboxGroup` |
| 动作 | `Button`（variant）、`ActionBar`（按钮组）、`Tabs`（页签） |

完整 Props 契约随技能下钻：`load_skill({ skillId: "generative-ui", path: "references/primitives.md" })`。Table 的 `rowActions` 内可用 `{$row.field}` 引用行数据；表单组件的 action 内可用 `{$value}` 引用提交值。文案遵守全局无 Emoji 规范，图标用 lucide 图标名。

## 安全表达式求值器

属性值支持数据绑定表达式，求值器是**纯路径解析器**——无 `eval`、无 `Function`、无任意 JS 执行。支持三种语法：

- 花括号点路径：`{$docs.index.workers}`、`{$data.entry.meta.summary}`、`{$row.conversationId}`、`{$value}`；
- 花括号带方括号字符串键：`{$docs["recall-graph"].nodes[0]}`；
- 斜杠 JSON Pointer：`/$docs/index/routerConversationId`。

求值域限定 `$docs`（插件公开文档）、`$sessionDocs`（当前会话公开会话文档）、`$data`（调用时传入数据）、`$row`（表格行）、`$value`（表单提交值）。属性读取只走 `Object.prototype.hasOwnProperty` 的自有键——原型链路径（`__proto__` / `constructor` / `prototype`）天然返回 undefined，无 getter 逃逸面。

**类型保持铁律**：整串恰好为单个 `{...}` 表达式或单个 `/$...` Pointer 时，返回底层 JS 原始类型（Array / boolean / number / object / null / string），绝不强转字符串；仅当表达式嵌于长文本中（如 `"conversation:{$row.conversationId}"`）才执行字符串插值。花括号内非 `$` 路径开头（如 JSON 示例 `{"enabled":true}`）视为普通文本原样保留。

## 三大声明式动作指令

action 字段的值是三种指令对象之一，仅由用户显式点击或提交触发（纯展示组件不得自动调用动作）：

| 指令 | 形态 | 说明 |
| :--- | :--- | :--- |
| `helm:action` | `{ "type": "helm:action", "pluginId", "actionId", "input" }` | 调用插件动作；聊天块应显式传 pluginId；actionId 先查动作清单与 Schema（`helm actions list --json`） |
| `helm:open` | `{ "type": "helm:open", "target", "split" }` | 打开会话（`conversation:<id>`）、插件 Screen（`screen:<pluginId>/<screenId>`）或产物预览（`artifact:<id>`）；`split: true` 开分屏 |
| `helm:send` | `{ "type": "helm:send", "target": "current", "text" }` | 以 human 来源向会话提交输入；target 省略或 `current` 发往当前会话，仅明确要发给另一会话时才用 `conversation:<id>` |

完整指令契约随技能下钻：`load_skill({ skillId: "generative-ui", path: "references/actions.md" })`。

## 停用语义

停用本插件后：`generative-ui` 技能因托管插件停用而离开可用技能目录（`load_skill` 对其返回 `403 skill_not_available`，模型目录中不再出现）；```` ```ui ```` 与 ```` ```json-render ```` 围栏回退为普通代码块展示，不渲染卡片。动作、工具与 UI 贡献即时消失，不留幻影提示词（技能目录由 `builtin:profile` 每回合实时重算，模型下一回合即看不到该技能），也不影响其他插件。
