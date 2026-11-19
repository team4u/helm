# 长期记忆插件

`builtin:memory` 解决「跨会话记住用户偏好与约定」的问题：按 Profile 维护一份 `MEMORY.md`，每回合注入模型上下文，并提供单 Profile 粒度的开关。适合想让助理记住稳定偏好的使用者，以及排查记忆丢失/超限的维护者。记忆与人格正交——SYSTEM.md 归 [`builtin:profile`](profile.md)，MEMORY.md 归本插件；内核与 `@helmx/protocol` 对记忆零感知。

## 当前状态

默认启用、非 `locked` 可停用。完全自治：`MemoryStore` 自管 `<dataDir>/profiles/<profileId>/MEMORY.md`，磁盘全文是唯一权威，不进任何公共文档。

## 能力和入口

### 工具与动作

- **`update_memory` 工具**：更新当前会话 Profile 的 MEMORY.md。`append` 追加、`replace` 替换全文；Profile 已关闭时执行期复核并返回 `403 memory_disabled_for_profile`。大小防线唯一权威点在 MemoryStore 文件锁内（合并后检查），跨会话同 Profile 并发 `append` 不可能叠加突破上限。
- **三个 `ctx.action`**（五端复用，CLI `helmx memory <action>`）：

| 动作 | CLI | 说明 |
| :--- | :--- | :--- |
| `get` | `helmx memory get` | 返回 `{profileId, enabled, content, initialized}`；文件不存在如实返回空串 |
| `set` | `helmx memory set --text <str> [--mode replace\|append]` | 写入 MEMORY.md；关闭的 Profile 403；超限 `400 memory_limit_exceeded` |
| `configure` | `helmx memory configure --enabled <bool> [--text <str>]` | 先写文本、成功后才提交开关，失败不留半配置；开启且未初始化时惰性创建文件 |

目标解析纪律统一：显式 `--profile-id` 优先；省略时从调用会话上下文解析（CLI `--current`）；两者皆缺显式 `400 validation_error`，不猜测默认角色。Profile 不存在返回 `404 profile_not_found`。

### `before_turn` 注入段落

| 段落 ID | 触发条件 | 内容 |
| :--- | :--- | :--- |
| `memory.content` | MEMORY.md 非空白 | `<memory>` 包裹全文 + `update_memory` 用法提示 |
| `memory.guide` | MEMORY.md 空白（合法态） | 仅用法提示，无告警 |
| `memory.assets-missing` | 已初始化后被外部删除 | `<memory_assets_missing>` 显式警告，按无记忆处理 |

Profile 关闭记忆时不读文件、不注入段落，并剥离 `update_memory` 工具。用法提示由本插件动态注入（SYSTEM.md 不硬编码），停用后指引随之消失，不留幻影提示词。

### Web 插槽

`ctx.ui.slot` 向 Profile 详情抽屉注入单 Profile 记忆开关与编辑器（`PROFILE_DETAIL_SECTION_SLOT`）。

## 配置与数据边界

- **存储**：`<dataDir>/profiles/<profileId>/MEMORY.md`；`MAX_MEMORY_CHARS = 64_000` 上限在文件锁内对合并后最终内容统一强制，所有写入路径（工具、`set`、`configure` 携带 text）共用同一防线，无绕过参数。存量超限（外部手改绕过防线）注入截断并显式说明，不静默截断、不修改源文件。超过 64000 字符需先 `replace` 精简。
- **插件状态**：私有 `ctx.doc('state')` 只存两个紧凑列表——`disabledProfiles`（开关）与 `initializedProfiles`（初始化标记，跨重启区分「从未初始化」与「已初始化后被删」）。插件无 `ctx.configSchema` 配置项。
- **文件锁边界**：锁约束同一 Hub 进程内使用该锁的调用方；可信插件、Shell 与其他进程可以绕过——插件不是文件系统沙箱。

## 停用与失败语义

停用本插件后：`update_memory` 工具、`helmx memory` 动态命令、Profile 详情抽屉的记忆编辑器与注入段落即时消失；磁盘 MEMORY.md 文件保留，重新启用即恢复。开关影响后续调用与回合，不取消在途写入。Profile 删除后以相同 ID 重建时，开关状态仍按 ID 生效；本设计不提供 Profile 删除时的记忆状态清理。

初始化语义的诚实边界：从未初始化的合法 Profile 首次需要记忆时惰性创建默认骨架（不误报缺失）；已初始化后被外部删除时显式 warning 通知（按 profileId 独立去重）+ 注入 `memory.assets-missing`，绝不启动时无条件重建掩盖丢失；文件恢复或工具写入后自愈。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口（动作/工具/钩子/插槽） | `packages/plugins/src/memory.ts` |
| MemoryStore（文件锁 + 64k 上限唯一权威点） | `packages/plugins/src/memory/store.ts` |
| 前端插槽组件 | `packages/plugins/src/memory/client/` |
| 测试 | `packages/plugins/test/memory-plugin.test.ts` |

## 相关文档

- [角色与技能底座](profile.md)：SYSTEM.md 注入（与本插件正交）
- [插件系统设计与契约](overview.md)：`ctx.doc` / `ctx.action` 宿主机制
- [CLI 命令参考](../cli/reference.md)：`helmx memory` 命令与 `--current`
