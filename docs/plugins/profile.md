# 角色与技能底座插件

`builtin:profile` 解决「会话知道自己是谁、能用什么」的问题：按会话绑定的 Profile 注入人格定义（SYSTEM.md）、工作区项目约定（AGENTS.md）、可用技能目录与跨 Profile 协作认知，并提供 `load_skill` 工具按需下钻技能手册。适合配置角色的使用者、编写技能的插件作者，以及排查「模型为什么看不到某技能」的维护者。长期记忆已拆分至独立的 [`builtin:memory`](memory.md)，本插件零记忆逻辑；内核与 `@helmx/protocol` 对两者均无感知。

## 当前状态

系统常驻底座插件：`locked: true`，不可停用、不可卸载（停用返回 `403 plugin_locked`）。默认 `assistant` Profile 的托管元数据由本插件自举。

## 能力和入口

### 启动自举

插件服务 `profile-skills` 在启动时完成两件事：

1. **同步受管系统技能 `helmx-cli`**：经 `ctx.host.skills.ensureSkill` 把 `skills/helmx-cli/`（SKILL.md + references）以源码版本为准逐文件覆盖、缺失补齐。PluginHost 校验 SKILL.md frontmatter 的 `managedByPlugin` 绑定 `builtin:profile`，受管技能常规写入接口 403 拒绝。技能目录同时合入机器级共享来源 `~/.agents/skills`。
2. **补写默认 Profile 托管声明**：默认 `assistant` Profile 由内核先行创建；插件启动时若其 `profile.json` 缺少 `managedByPlugin`，显式补写 `builtin:profile`（已存在时原样保留，不做旧数据归一化）。默认 Profile 不存在属内核未初始化异常，如实上抛。

### `before_turn` 注入流水线

每回合开始前按会话 Profile 注入以下段落（均实时重读，Profile 修改与插件启停在下一回合即时生效）：

| 段落 ID | 触发条件 | 内容 |
| :--- | :--- | :--- |
| `profile.system` | SYSTEM.md 非空白 | SYSTEM.md 原始全文 |
| `profile.assets-missing` | SYSTEM.md 缺失或为空 | `<profile_assets_missing>` 显式说明：本回合无该 Profile 人格，要求模型告知用户、不假装特定人格 |
| `profile.agents` | 会话靶点工作区存在非空白 AGENTS.md | `<project_instructions path="...">` 项目约定全文（先脱敏，超 64000 字符显式截断） |
| `profile.agents-unavailable` | 远端节点离线、宿主能力未接线、AGENTS.md 为特殊文件或超 256 KiB 读取上限等 | `<project_instructions_unavailable>` 显式说明原因，绝不静默降级为「无文件」 |
| `profile.skills` | 可用技能非空 | `<available_skills>` 目录（id/name/description/references） |
| `profile.catalog` | 当回合实际有 `subagent` / `SubagentWorkflow` 派工工具 | `<available_profiles>` 协作目录与 `@` 点名委派指引 |
| `profile.workspace-boundary` | Profile 开启 `restrictToCwd` | `<workspace_boundary>` 边界声明：点名会话 cwd 与 `path_outside_workspace` 拒绝语义，避免模型反复试错 |

`Profile.restrictToCwd`（`helmx profiles update <id> --restrict-to-cwd`）是模型护栏而非 OS 沙箱：内核文件工具（read/write/edit/register_artifact）在路径解析咽喉点做词法包含校验（绝对路径与 `../` 越界显式报 `path_outside_workspace`），`agent_spawn` 入口拒绝受限父会话的显式越界 `cwd`（插件经 hook 重写的受管 worktree 属宿主能力不受影响）；bash 保持自身权限边界（cwd 内符号链接仍是用户文件系统现实），硬隔离应绑定专用节点部署。

目录注入钩子以低于默认值的 priority 运行（`-100`），看到的是默认优先级钩子（如路由模式工具剥离）收敛后的最终工具清单——无派工工具的回合（含达到深度上限的叶子子代理）不注入目录，避免教唆调用不存在的工具；不按 `parentConversationId` 一刀切排除（fork / SuperAgent worker 有父链但应保留协作能力）。

**资产缺失自愈防线**：外部误删 SYSTEM.md 时按空处理但不静默换人格——先向人类发一次性 warning 通知（按 profileId 独立去重，恢复即停、再删可重新告警），再注入 `profile.assets-missing`；后续经 `helmx profiles update --system` 等写入自愈重建。`not_found` 之外的 IO/权限错误如实上抛。

### 工具、动作与 UI

- **`load_skill` 工具**：读取技能 SKILL.md 或目录内参考文件（`path` 示例 `references/guide.md`）。可用性实时判定：Profile 白名单外或托管插件停用返回 `403 skill_not_available`；技能不存在 `404 not_found`。这是认知目录边界，不是权限沙箱——bash/API 仍可读文件。
- **`list_mentionable` 动作**（幂等）：`@` 补全源。身份裁决以调用上下文会话为唯一可信来源，无上下文时接受显式 `--conversation-id` / `--profile-id`（待命草稿态），三者都缺显式 `400 validation_error`。CLI：`helmx profile list_mentionable`。
- **`composerCompleter`** `profile-mentions`：`@` 触发的补全源（复用宿主通用补全渲染）。
- **`sidebarItem`** `assistant`：左栏个人助理站位，指向 `conversation:profile:assistant`（不依赖某一具体会话存在，会话全部删除后站位仍在）。

## 配置与数据边界

本插件自身**无 `ctx.configSchema` 配置项**。Profile 的技能白名单（`Profile.skills`：缺省全部、`[]` 禁用全部、非空白名单）与 SYSTEM.md 归 Profile 配置管理（`helmx profiles create/update`）。插件不持有自己的持久文档——技能目录每回合从 `ctx.host.skills.list()` 现读。

## 停用与失败语义

不可停用（locked）。故障面主要是资产读取：SYSTEM.md 缺失按上文显式告警与注入处理；AGENTS.md 读取失败显式注入 `profile.agents-unavailable`；Profile 不存在属配置异常，`500 profile_not_found` 显式报错。候选 Profile 摘要读取的 `not_found` 只影响该候选的 `summary` 字段（undefined，不伪造简介），其余错误如实上抛。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口 | `packages/plugins/src/profile.ts` |
| AGENTS.md 读取与注入 | `packages/plugins/src/profile/agents-md.ts` |
| 协作目录计算与渲染 | `packages/plugins/src/profile/catalog.ts` |
| helmx-cli 技能资产 | `packages/plugins/src/profile/skill/`（构建后随包分发） |
| 测试 | `packages/plugins/test/profile-agents-md.test.ts`、`profile-collaboration.test.ts`、`profile-collaboration.integration.test.ts`、`profile-starters.test.ts` |

## 相关文档

- [长期记忆](memory.md)：MEMORY.md 注入与单 Profile 开关（与本插件正交）
- [插件系统设计与契约](overview.md)：受管技能与技能目录的宿主机制
- [CLI 命令参考](../cli/reference.md)：`helmx profiles` / `helmx skills` 命令
