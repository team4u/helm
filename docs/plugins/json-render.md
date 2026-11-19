# JSON 卡片渲染插件

`builtin:json-render` 解决「让模型在回复正文中输出可交互卡片」的问题：接管聊天消息中 ```ui 与 ```json-render 代码围栏，把安全 JSON Spec 渲染为表单、列表、指标、图表等原语卡片，并自举 `generative-ui` 技能教模型产出合法 Spec。适合想让会话输出结构化交互内容的使用者与提示词作者。这是机制与策略分离的典型案例——内核只提供 markdown 代码块扩展机制，全部渲染策略在本插件，宿主核心零声明式 JSON 渲染轨道。

## 当前状态

默认启用、可停用。停用后 ```ui 围栏回退普通代码块展示。

## 能力和入口

### 双形态 Spec

渲染器接受两种等价 JSON 形态：

- **树状简写**（推荐）：`{ "component": "Card", "title": "...", "children": [...] }`，children 可混入节点对象或纯字符串（转 `Text`），嵌套表达层级；
- **扁平形态**：`{ "root": "id", "elements": { "id": { "type": "Card", "props": {}, "children": ["childId"] } } }`，按 ID 引用，适合深层复用与程序化生成。

聊天 UI 块是独立 Spec：没有所属插件，不能订阅插件文档、不注入 composer/screen 控制函数；当前协议没有通用 `$state` 表单 store，输入组件通过各自 action 的 `{$value}` 提交。

### 21 个标准原语

| 分类 | 原语 |
| :--- | :--- |
| 容器 | `Stack`、`Card`、`Accordion`、`Slot`（插件视图专用子插槽） |
| 文本 | `Text`、`Markdown`、`Badge` |
| 数据展示 | `MetricGrid` + `MetricCard`、`KeyValueList`、`Steps`、`BarList`、`Table`（`rowActions` 内可用 `{$row.field}` 引用行数据） |
| 反馈 | `Callout` |
| 输入 | `TextInput`（secret 型密码框）、`Select`、`Switch`、`CheckboxGroup` |
| 动作 | `Button`、`ActionBar`、`Tabs` |

完整 Props 契约随技能下钻：`load_skill({ skillId: "generative-ui", path: "references/primitives.md" })`。

### 安全表达式求值器

属性值支持数据绑定表达式，求值器是**纯路径解析器**——无 `eval`、无 `Function`、无任意 JS 执行。三种语法：花括号点路径（`{$docs.index.workers}`、`{$row.conversationId}`、`{$value}`）、花括号方括号字符串键（`{$docs["recall-graph"].nodes[0]}`）、斜杠 JSON Pointer（`/$docs/index/routerConversationId`）。求值域限定 `$docs`（插件公开文档）、`$sessionDocs`、`$data`、`$row`、`$value`；原型链路径（`__proto__` / `constructor` / `prototype`）天然返回 undefined。整串恰为单个表达式时保持底层 JS 类型不强转字符串；花括号内非 `$` 开头视为普通文本。

### 三大声明式动作指令

action 字段是三种指令对象之一，仅由用户显式点击或提交触发：

| 指令 | 形态 | 说明 |
| :--- | :--- | :--- |
| `helmx:action` | `{ "type": "helmx:action", "pluginId", "actionId", "input" }` | 调用插件动作；actionId 先查动作清单与 Schema |
| `helmx:open` | `{ "type": "helmx:open", "target", "split" }` | 打开会话（`conversation:<id>`）、Screen（`screen:<pluginId>/<screenId>`）或产物（`artifact:<id>`）；`split: true` 分屏 |
| `helmx:send` | `{ "type": "helmx:send", "target": "current", "text" }` | 以 human 来源向会话提交输入 |

完整契约随技能下钻：`load_skill({ skillId: "generative-ui", path: "references/actions.md" })`。

### 受管技能 `generative-ui`

插件服务启动时自举受管技能（SKILL.md + `references/primitives.md` + `references/actions.md`，`managedByPlugin: builtin:json-render`），随插件启停进入/离开可用技能目录。

## 配置与数据边界

插件自身无 `ctx.configSchema` 配置项、无持久文档、无后端动作——全部能力是 `ctx.ui.markdownCodeBlock`（`languages: ['ui', 'json-render']`）声明的前端渲染与受管技能。渲染在浏览器端完成，卡片求值只读公开文档快照。

## 停用与失败语义

停用后：`generative-ui` 技能离开可用目录（`load_skill` 对其返回 `403 skill_not_available`，模型目录下一回合即不可见）；```ui / ```json-render 围栏回退普通代码块展示。不留幻影提示词，不影响其他插件。非法 Spec（未知组件、坏 JSON、求值越界）在卡片内显式呈现错误，不静默留空白冒充成功。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口 | `packages/plugins/src/json-render.ts` |
| 技能资产 | `packages/plugins/src/json-render/skill/` |
| 前端渲染组件 | `packages/plugins/src/json-render/client/` |
| 测试 | `packages/plugins/test/json-render-dsl.test.ts`、`json-render-evaluator.test.ts`、`json-render-send-target.test.ts` |

## 相关文档

- [插件系统设计与契约](overview.md)：`markdownCodeBlock` 扩展点与受管技能机制
- [Mermaid 图表](mermaid.md)：同属代码围栏扩展的姊妹插件
