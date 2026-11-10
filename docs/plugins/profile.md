# 常驻角色与技能底座插件

本文介绍 `builtin:profile` 角色与技能底座插件的架构设计、启动自举、资产注入与技能加载机制。长期记忆（`MEMORY.md` / `update_memory`）已拆分至独立的 [`builtin:memory`](memory.md) 插件，本插件零记忆逻辑。

---

## 插件定位与架构总览

`builtin:profile` 是 Helm 系统常驻内置底座插件。
该插件声明了 `locked: true` 属性。
系统禁止卸载或停用本插件。
它为所有会话按 `profileId` 注入独立的人格定义（SYSTEM.md）与可用技能目录。

```mermaid
flowchart td
    subgraph Storage["Profile 资产存储 (~/.helm/profiles/<id>/)"]
        SysFile["SYSTEM.md 人格设定"]
    end

    subgraph Hook["before_turn 注入流水线"]
        Read["读取 SYSTEM.md"]
        Skills["装配可用技能目录"]
        Sections["组装 Prompt Sections"]
    end

    subgraph Session["任意绑定该 Profile 的会话"]
        Model["大语言模型"]
        Tools["load_skill"]
    end

    Storage --> Read
    Read --> Skills
    Skills --> Sections
    Sections --> Model
    Model --> Tools
```

---

## 启动自举

插件服务（`profile-skills`）在启动时完成两件事：

1. **系统级内置技能同步**：调用 `SkillService.ensureSkill` 同步 `skills/helm-cli/`（SKILL.md + references），以源码版本为准逐文件覆盖，缺失补齐；常规写入接口对受管技能统一 403 拒绝。
2. **默认 Profile 托管声明**：若默认角色 `assistant` 的 `profile.json` 缺少 `managedByPlugin`，显式补写 `builtin:profile`（已存在时原样保留，不做归一化）。

默认 `assistant` Profile 由内核 `ProfileService.ensureDefault` 先行创建（`profile.json` + `SYSTEM.md`）。

---

## 独立资产注入机制

在每个交互回合开始前，插件通过 `before_turn` 钩子注入上下文。

### 注入段落规范

1. **`profile.system`**：
   - 注入 `SYSTEM.md` 的原始内容。
   - 定义智能体的基础人设、语气风格与行为准则。
2. **`profile.skills`**：
   - 注入可用技能目录摘要（`<available_skills>` 包裹）。
   - 提示模型使用 `load_skill` 按需加载详细定义。
3. **`profile.assets-missing`**：
   - SYSTEM.md 缺失或为空时注入显式说明（`<profile_assets_missing>` 包裹）。
   - 告诫模型谨慎回答，绝不伪造特定人格。

### 资产缺失自愈防线

若外部误删 `SYSTEM.md`：

1. **降级为空文本**：系统不阻断当前回合执行。
2. **发送告警事件**：宿主触发 warning 级别系统通知（按 `profileId` 独立去重）。
3. **注入显式说明**：向模型注入 `profile.assets-missing` 段落。
4. **自动重建自愈**：后续执行 `profiles update --system` 等写入时可自愈重建。

---

## 跨 Profile 点名与协同目录

### 职责边界

用户在任意普通 Profile 会话中写 `让 @reviewer 审查，再让 @tester 验证`，仍由当前智能体理解依赖、委派任务并汇总结论。`@` 只补全文本，不是执行命令，也不会通过 `input` 钩子劫持或转发消息。引用、代码中的点名不应触发自动派工。

这部分是插件策略：不修改 `@helm/protocol`、`profile.json` 或内核会话模型。角色简介从各自 `SYSTEM.md` 的首个非标题自然段提取，单行化并限制到 100 个 Unicode 码点；跳过 Frontmatter、标题和代码块，不额外维护 `description` 字段。目录只提供摘要，不将其他角色的完整 SYSTEM.md 或 MEMORY.md 注入当前会话。

### 补全与目录使用同一候选集

插件注册只读动作 `list_mentionable` 和 `trigger: '@'` 的 `composerCompleter`。候选显示 `@<id> · <name>`，并提示默认节点、目录和职责摘要；选择后插入 `@<id> `。会话产物仍由宿主提供，不因角色点名而变成新附件。

动作复用标准插件接口，无需新增专用 HTTP 路由或 CLI 命令实现：

```bash
helm profile list_mentionable --input '{"query":"review","conversationId":42}' --json
# 受管 shell 内沿用 HELM_CONVERSATION_ID
helm profile list_mentionable --current --json
```

动作会校验真实会话。若调用带有当前会话上下文，不能用输入中的其他 `conversationId` 冒充该会话。

目录计算排除当前 Profile、`humanSelectable: false` 的内部角色、所属插件已停用的受管角色，以及没有活动 `profile.runtime` UI 声明的外部运行时角色。运行时发现不按 `builtin:<kind>` 猜测插件 ID；未声明该扩展点的外部运行时不会被目录主动推荐，但不改变原有显式 `agent_spawn` 调用机制。候选不是在线健康检查，节点离线、模型未配置等执行故障仍由执行边界显式报告。

候选查询与每轮提示词均重读资产和活动插件状态。修改 SYSTEM.md、增删 Profile 或启停插件，会在下一次查询或回合生效，不维护第二份持久目录。缺失 SYSTEM.md 会发送去重告警，不伪造职责摘要；权限或其他 I/O 故障显式传播。

### 当前会话主持编排

满足顶层会话、Workflow 已启用且对应工具可用等条件时，`before_turn` 增加 `profile.catalog` 段落，包含 `<available_profiles>` 和协作指引。没有可委派角色时不注入。被派生的子会话不提供团队目录或角色补全，默认专注自身任务。

不注入目录只是认知引导，不是工具权限沙箱或硬性递归深度限制。宿主或其他插件若在后续钩子中移除工具，应同步移除引用该工具的提示词，不能仅凭曾经注册过工具就要求模型调用。

- 单次委派使用 `subagent({ agentType: "reviewer", prompt })`；需要后台执行时使用已有 `background: true`。
- 多阶段或多轮协同使用 [Workflow DSL](../workflows/dsl-guide.md)，通过真实 Profile ID 点名，用 `resume` 续接同一执行上下文。主会话负责传递必要结论、限制复核轮数并决定何时结束。
- 节点与目录遵循已有执行优先级；没有配置时继承当前会话，不把缺省节点一律显示为 `local`。不同节点和目录之间没有自动文件同步。
- 原生子会话有独立对话历史，但同一 Profile 的长期记忆仍由 `builtin:memory` 按 Profile 共享。Herdr 等外部运行时由对应插件执行，不能假设其认知资产注入或持久化行为与原生会话相同。
- 原生 `resume` 仍校验父子归属、会话存在性与忙闲状态。外部执行上下文还受父回合或 Workflow 结算清理约束，不承诺跨回合永久可续接。
- 附件只使用调用会话及父链授权的产物；子会话、兄弟会话的产物不自动获得转交权限。

### 发布与验证

本次不增加存储字段或数据库结构，不需要数据迁移。正常更新代码后生效；停用 `builtin:workflow` 后不再推荐这套协作入口，回退代码则移除本次目录与补全行为。

验证应覆盖：摘要提取与 XML 转义、角色与插件启停过滤、上下文身份校验、顶层与子会话差异、缺失文件和 I/O 故障，以及已有技能加载行为不变。Workflow 附件还需验证初调与续接透传、非法输入拒绝和附件变化导致账本失配。真实模型是否按自然语言意图委派，需要带模型环境验证；不能以补全候选出现代替这项验证。

---

## 动态技能按需加载

为了节约模型上下文，Helm 采用两层技能加载架构。

```mermaid
flowchart TD
    Catalog["Layer 1: 当前 Profile 可用技能目录"] --> Model["大语言模型决策"]
    Model --> Tool["调用 load_skill 工具"]
    Tool --> Detail["Layer 2: 完整 SKILL.md 与参考文件"]
```

### 技能分层设计

1. **Layer 1 轻量目录**：在 `before_turn` 中按当前会话的 Profile 配置注入可用技能的名称、描述与引用清单。
2. **Layer 2 详细内容**：模型在需要时调用 `load_skill` 工具读取 SKILL.md 或 `references/*.md` 子文件。

### Profile 可用技能配置

`profile.json` 的 `skills` 字段控制当前 Profile 的技能目录与 `load_skill`：

| 配置 | 行为 |
| --- | --- |
| 省略 `skills` | 所有当前可用技能；新安装的技能自动可用 |
| `"skills": []` | 不提供任何技能 |
| `"skills": ["helm-cli", "git-commit"]` | 只提供指定 ID 的技能 |

托管技能还要求其 `managedByPlugin` 对应插件处于启用状态。每次回合与工具调用均读取当前配置；不需要重建会话。

```bash
helm profiles update coder --skills '["helm-cli","git-commit"]' --json
helm profiles update coder --skills '[]' --json
helm profiles update coder --all-skills --json
```

此配置是技能发现与加载策略，不是权限沙箱。

### 内置技能保护

系统启动时自动同步内置管理技能 `skills/helm-cli/`：版本强制对齐、禁止常规 API 篡改。

---

## Profile 详情抽屉子插槽

本插件提供 `builtin:profile/detail-section` 子插槽（协议常量 `PROFILE_DETAIL_SECTION_SLOT`）：
Web 的角色详情抽屉在该位置挂载 `<PluginSlot ownerPluginId="builtin:profile" name={PROFILE_DETAIL_SECTION_SLOT} slotProps={{ profileId, isNew, disabled }} />`。
其他插件（如 `builtin:memory`）经 `ctx.ui.slot` 向该插槽注入单 Profile 级别的扩展区块，宿主不硬编码任何插件业务字段。

---

## 左栏 Profile 站位导航

插件注册 `ctx.ui.sidebarItem({ id: 'assistant', target: 'conversation:profile:assistant', order: 0 })`：
- 指向 Profile 而非某一具体会话（该 Profile 的会话全部删除后站位仍在，点击可新建会话）；
- 不依赖任何特定会话 ID 存在。
