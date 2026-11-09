# 常驻个人助理插件

本文介绍 `builtin:assistant` 个人助理插件的架构设计、根会话守护、独立资产注入、记忆管理与动态技能加载机制。

---

## 插件定位与架构总览

`builtin:assistant` 是 Helm 系统常驻内置插件。
该插件声明了 `locked: true` 属性。
系统禁止卸载或停用个人助理插件。
插件负责驱动单兵个人助理会话。
它为所有会话按 `profileId` 注入独立的人格与记忆。

```mermaid
flowchart TD
    subgraph Storage["Profile 资产存储 (~/.helm/profiles/<id>/)"]
        SysFile["SYSTEM.md 人格设定"]
        MemFile["MEMORY.md 长期记忆"]
    end

    subgraph Hook["before_turn 注入流水线"]
        Read["读取 Profile 资产"]
        Truncate["校验 64000 字符防线"]
        Skills["装配可用技能目录"]
        Sections["组装 Prompt Sections"]
    end

    subgraph Session["Conversation #1 根会话"]
        Model["大语言模型"]
        Tools["update_memory / load_skill"]
    end

    Storage --> Read
    Read --> Truncate
    Truncate --> Skills
    Skills --> Sections
    Sections --> Model
    Model --> Tools
    Tools --> Storage
```

---

## 常驻根会话 `#1` 守护机制

系统初始化时自动创建根会话 `Conversation #1`。
根会话作为用户日常交互的单兵主入口。

### 保护约束

1. **禁止删除**：
   - 系统拦截针对根会话的删除请求。
   - 接口返回 `403 root_conversation_protected` 错误。
2. **固定侧边栏入口**：
   - 插件通过 `ctx.ui.sidebarItem` 挂载固定入口。
   - 配置 `order: 0` 保证展示在左栏顶部。
   - 点击直达 `conversation:1` 视图。
3. **默认 Profile 绑定**：
   - 根会话默认绑定 `assistant` 专家画像。
   - 自动继承专属的人格定义与记忆存储。

---

## 独立资产注入机制

在每个交互回合开始前，插件通过 `before_turn` 钩子注入上下文。

```mermaid
sequenceDiagram
    participant Engine as 会话引擎
    participant Hook as assistant.before_turn
    participant Service as ProfileService
    participant Model as 大模型

    Engine->>Hook: 触发 before_turn 钩子
    Hook->>Service: 读取 SYSTEM.md 与 MEMORY.md
    Service-->>Hook: 返回资产文本
    Hook->>Hook: 组装 Prompt Sections
    Hook-->>Engine: 返回转换后的上下文载荷
    Engine->>Model: 发起模型推理
```

### 注入段落规范

1. **`assistant.system`**：
   - 注入 `SYSTEM.md` 的原始内容。
   - 定义智能体的基础人设、语气风格与行为准则。
2. **`assistant.memory`**：
   - 注入 `<memory>` 标签包裹的长期记忆内容。
3. **`assistant.skills`**：
   - 注入可用技能目录摘要。
   - 提示模型使用 `load_skill` 按需加载详细定义。

### 资产缺失自愈防线

若外部误删 `SYSTEM.md` 或 `MEMORY.md` 文件：

1. **降级为空文本**：
   - 系统不阻断当前回合执行。
2. **发送告警事件**：
   - 宿主触发 warning 级别系统通知。
   - 告知用户资产文件缺失。
3. **注入显式说明**：
   - 向模型注入 `<profile_assets_missing>` 段落。
   - 明确告知模型当前缺少人设与记忆。
   - 告诫模型谨慎回答，绝不伪造既往历史。
4. **自动重建自愈**：
   - 后续执行 `update_memory` 时会自动重建文件。

---

## 记忆管理与大小防线

智能体通过 `update_memory` 工具原子写回记忆。
系统设计了严格的字符上限防线。

### 工具接口定义

```json
{
  "name": "update_memory",
  "description": "更新当前会话 Profile 的 MEMORY.md。append 追加内容，replace 替换全文（超过 64000 字符需先 replace 精简）。",
  "parameters": {
    "type": "object",
    "properties": {
      "text": { "type": "string" },
      "mode": { "type": "string", "enum": ["append", "replace"] }
    },
    "required": ["text", "mode"]
  }
}
```

### 64000 字符防线机制

为防止系统提示词无界膨胀，系统强制执行记忆上限：

1. **单点权威防线**：
   - 在 `ProfileService.updateMemory` 文件锁内统一校验。
   - 并发追加操作在文件锁内排队执行。
   - 合并后长度超过 64000 字符时拒绝写入。
   - 接口返回 `400 memory_limit_exceeded` 错误。
2. **存量超限截断**：
   - 若用户通过外部编辑器修改导致文件超限。
   - 插件在 `before_turn` 注入时切片截断前 64000 字符。
   - 注入末尾附加截断说明，提示模型进行整理精简。
   - 插件绝不直接修改磁盘源文件。

---

## 动态技能按需加载

为了节约模型上下文，Helm 采用两层技能加载架构。

```mermaid
flowchart TD
    Catalog["Layer 1: 技能轻量目录 (全量注入)"] --> Model["大语言模型决策"]
    Model --> Tool["调用 load_skill 工具"]
    Tool --> Detail["Layer 2: 完整 SKILL.md 与参考文件"]
```

### 技能分层设计

1. **Layer 1 轻量目录**：
   - 在 `before_turn` 中注入所有可用技能的名称、描述与引用清单。
   - 单个技能摘要通常少于 100 字符。
2. **Layer 2 详细内容**：
   - 模型在需要时调用 `load_skill` 工具。
   - 支持读取 `SKILL.md` 核心流程。
   - 支持按需读取 `references/*.md` 子指引文件。

### 内置技能保护

系统启动时自动同步内置管理技能 `skills/helm-cli/`：

1. **版本强制对齐**：
   - 插件服务启动时校验内置技能资产。
   - 发现文件缺失或版本陈旧时自动覆盖修复。
2. **禁止常规修改**：
   - 内置管理技能禁止通过常规 API 篡改。
   - 保证系统命令调用指引的权威性。

---

## 产物管理机制 (Artifacts)

助理在执行任务时会产出报告、代码片段与设计图表。
插件通过产物机制解耦大文本传输。

1. **独立存储**：
   - 大文本写入 `.helm/artifacts/` 目录。
   - 分配唯一产物标识。
2. **轻量传递**：
   - 会话历史中只保留产物元数据与摘要。
   - 避免长文本重复占用后续回合上下文。
3. **前端渲染**：
   - 前端工作台面板自动根据产物类型渲染富文本视图。
