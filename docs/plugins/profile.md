# 角色与技能底座插件

`builtin:profile` 是系统常驻底座插件（`locked: true`，不可停用、不可卸载），为所有会话按其绑定的 `profileId` 注入人格定义（SYSTEM.md）、可用技能目录与跨 Profile 协作认知。长期记忆已拆分至独立的 [`builtin:memory`](memory.md)，本插件零记忆逻辑；内核与 `@helm/protocol` 对两者均无感知，全靠插件在 `before_turn` 注入。

## 启动自举

插件服务 `profile-skills` 在启动时完成两件事：

1. **同步受管系统技能 `helm-cli`**：经 `ctx.host.skills.ensureSkill` 把 `skills/helm-cli/`（SKILL.md + `references/workflows-and-agents.md` + `references/skill-and-plugin-dev.md`）以源码版本为准逐文件覆盖、缺失补齐。PluginHost 校验 SKILL.md frontmatter 的 `managedByPlugin` 绑定 `builtin:profile`，登记受管后常规写入接口统一 403 拒绝。
2. **补写默认 Profile 托管声明**：默认 `assistant` Profile 由内核 `ProfileService.ensureDefault` 先行创建；插件启动时若其 `profile.json` 缺少 `managedByPlugin`，经 `ctx.host.profiles.save` 显式补写 `builtin:profile`（已存在或已是其他值时原样保留，不做旧数据归一化）。默认 Profile 不存在属内核未初始化异常，如实上抛。

自举不重建被外部删除的资产——缺失告警与自愈见下文。生成式 UI 手册（`generative-ui` 技能）归 `builtin:json-render` 自举，随其启停进入或离开可用目录，与本插件无耦合。

## `before_turn` 注入流水线

每个回合开始前，插件按会话 Profile 注入以下段落（均实时重读配置，Profile 修改与插件启停在下一回合即时生效，不维护第二份持久目录）：

| 段落 ID | 触发条件 | 内容 |
| :--- | :--- | :--- |
| `profile.system` | SYSTEM.md 非空白 | SYSTEM.md 原始全文（人格、语气与行为准则） |
| `profile.assets-missing` | SYSTEM.md 缺失或为空 | `<profile_assets_missing>` 包裹的显式说明：本回合无该 Profile 人格，要求模型告知用户、谨慎回答、不假装特定人格 |
| `profile.skills` | 可用技能非空 | `<available_skills>` 包裹的技能目录（id/name/description/references），提示经 `load_skill` 按需加载 |
| `profile.catalog` | 当回合实际有 `subagent` / `SubagentWorkflow` 派工工具 | `<available_profiles>` 协作目录与委派指引 |

**资产缺失自愈防线**：外部误删 SYSTEM.md 时降级为空文本但不静默换人格——先向人类发一次性 warning 通知（按 profileId 独立去重，文件恢复即停、再次缺失可重新告警），再向模型注入 `profile.assets-missing` 显式说明，后续经 `helm profiles update --system` 等写入自愈重建（不是启动时自动恢复）。`not_found` 之外的 IO/权限错误如实上抛，不吞、不降级。

`profile.catalog` 的注入钩子以低于默认值的 priority（-100）运行，确保在默认优先级的工具剥离钩子（如 superagent 路由模式收敛、`builtin:workflow` 对达到层级上限的受管子代理剥离派工工具）之后、按届时的实际 `turn.tools` 决定注入与否——没有可用派工工具的回合不注入目录，避免教唆模型调用不存在的工具。不按 `parentConversationId` 一刀切排除（fork 会话或 SuperAgent 驻留 Worker 同样有父链，但只要当回合仍持有派工工具即保留完整协作能力）。

## 跨 Profile `@` 点名协同

用户在任意会话写 `让 @reviewer 审查` 时，`@` 只是文本点名：由当前智能体理解依赖并决定是否经 `subagent({ agentType: "reviewer", prompt })` 委派，补全不执行命令、不劫持消息转发。协作目录与补全共用同一候选计算（`computeCatalog`），排除规则四条：

- 排除当前会话自身 Profile（不能点名自己）；
- 排除 `humanSelectable: false`（superagent/watchdog 等常驻单例角色不面向人类）；
- 排除 `managedByPlugin` 指向未启用插件的托管角色（托管插件停用即隐藏）；
- 排除 `runtime.kind` 无任何已启用 `profile.runtime` UI 贡献对应的角色（外部运行时未被插件接管时原生执行行会显式拒绝，不进目录误导）。

候选摘要从各自 SYSTEM.md 的首个非标题自然段提取、单行化并限 100 Unicode 码点；候选缺 SYSTEM.md 时摘要留空（`undefined`），不告警、不伪造简介——认知缺失告警纪律只针对「当前会话绑定 Profile」的人格资产。目录只提供摘要，不把其他角色的完整 SYSTEM.md 或 MEMORY.md 注入当前会话。

补全与目录消费两个入口：

```bash
# 只读动作（幂等），自动映射 HTTP 与 helm CLI
helm profile list_mentionable --current --json
# 无调用上下文时显式指定目标会话
helm profile list_mentionable --input '{"query":"review","conversationId":42}' --json
```

身份裁决纪律：调用上下文会话（Web 补全 / CLI `--current` 注入的外层 `conversationId`）是唯一可信来源；`input.conversationId` 仅在无上下文时作为 CLI 显式目标且必须经真实 `getConversation` 校验。两者都缺显式 `400 validation_error`，绝不猜测默认会话。Web 侧声明 `trigger: '@'`、`priority: 100` 的 `composerCompleter` 绑定该动作（`source: { kind: 'action', actionId: 'list_mentionable' }`）。

## 两层技能按需加载

为节约模型上下文，技能采用两层加载：Layer 1 是 `before_turn` 注入的轻量目录（名称、描述与引用清单）；Layer 2 是模型按需调用 `load_skill` 工具读取 SKILL.md 全文或 `references/*.md` 子文件。工具执行时按会话当前 Profile 白名单与插件启停状态**实时判定**可用性（与目录注入同规则）：白名单外或托管插件停用返回 `403 skill_not_available`，技能不存在返回 `404 not_found`（不泄漏内容）；路径穿越、绝对路径与软链在 `SkillService.readFile` 边界拒绝。

`profile.json` 的 `skills` 字段控制当前 Profile 的技能目录与 `load_skill`：

| 配置 | 行为 |
| :--- | :--- |
| 省略 `skills` | 全部当前可用技能；新安装的技能自动可用 |
| `"skills": []` | 禁用全部技能 |
| `"skills": ["helm-cli", "git-commit"]` | 仅白名单内技能可用 |

托管技能额外要求其 `managedByPlugin` 对应插件处于启用状态。此配置是技能发现与加载策略，不是权限沙箱——bash 与其他工具仍可读文件。

### 机器级共享只读根（~/.agents/skills）

除 `~/.helm/skills`（或 `HELM_DATA_DIR` 覆盖值）用户可写根外，内核自动合入机器级共享只读根 `~/.agents/skills`（pi 生态技能库，如 git-commit、herdr、actiondock 等）：

- **只读合入**：helm 对该根只扫描与读取，不写不删；摘要带 `source: 'agents'` 标识，且强制剥离其 frontmatter 可能携带的 `managedByPlugin`（共享技能不得伪装受管插件技能）。
- **同名优先级**：按 id 去重，`~/.helm/skills` 条目绝对优先——受管技能（helm-cli / generative-ui 等）永不被外部同名遮蔽；用户往 dataDir 放同名技能即形成「本地覆盖」，对被覆盖 id 调 `writeFile` 也只写 dataDir 副本。
- **条目过滤**：共享根是第三方内容，helm 不拥有其质量——根整体不存在视为空；单条目坏数据（非法 id、缺 SKILL.md、frontmatter 坏、软链目录、`node_modules`/隐藏目录噪音）跳过该条目，不拖垮整个技能目录；非 ENOENT 的真实 IO 错误如实上抛。安全校验（路径穿越、软链、realpath 包含）与 dataDir 完全同强度。
- **白名单照常生效**：`profile.skills` 白名单与插件启停过滤对共享技能同样适用（普通目录条目口径）；外部技能可直接选入白名单。
- **热生效**：每次回合重新读目录，共享根增删技能下一回合即生效，无需重启。

```bash
helm profiles update coder --skills '["helm-cli","git-commit"]' --json
helm profiles update coder --skills '[]' --json
helm profiles update coder --all-skills --json   # 删除 skills 键，恢复全部
```

## `Profile.starters` 空白会话引导词

`profile.json` 的 `starters` 字段（`[{label, prompt}]`）是纯静态配置，不是 UI 扩展点：仅真正空白且历史已加载完整的会话显示引导卡片，点击回填草稿后由用户确认发送。上限六项；label 去首尾空白后最多 24 个 Unicode 码点，prompt 非纯空白、最多 4000 码点。草稿、附件、历史编辑与在途上传不被覆盖。

```bash
helm profiles update reviewer --starters '[{"label":"审查改动","prompt":"请审查当前工作区的未提交改动。"}]' --json
helm profiles update reviewer --starters '[]' --json   # 清空恢复宿主默认
```

## 详情抽屉子插槽与左栏站位

本插件提供 `builtin:profile/detail-section` 子插槽（协议常量 `PROFILE_DETAIL_SECTION_SLOT`）：Web 角色详情抽屉在该位置挂载 `<PluginSlot>`，传递 `{ profileId, isNew, disabled }`。其他插件经 `ctx.ui.slot({ target: PROFILE_DETAIL_SECTION_SLOT })` 注入单 Profile 级扩展区块——[`builtin:memory`](memory.md) 的记忆开关与编辑器即挂载于此。宿主不硬编码任何插件业务字段。

左栏注册 `sidebarItem`（`target: 'conversation:profile:assistant'`，order 0）作为 assistant Profile 站位导航：指向 Profile 而非某一具体会话——该 Profile 的会话全部删除后站位仍在，点击可新建会话，不依赖任何固定会话 ID 存在。
