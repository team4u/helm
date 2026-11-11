# 长期记忆插件

`builtin:memory` 是完全自治的长期记忆插件（默认启用、可停用），与 [`builtin:profile`](profile.md) 正交：内核与 `@helm/protocol` 对记忆零感知，全部记忆逻辑（存储、注入、工具、动作、UI）归口本插件。核心设计是「磁盘是全文唯一权威」——`MEMORY.md` 全文不进任何公共文档、不进全局首帧或 SSE 广播，Web 端经 `get` 动作按需读取。

## 两级启停控制

插件全局启停（`helm plugins enable/disable builtin:memory`）之上叠加单 Profile 开关（`configure` 动作），两级控制的真实语义：

| 插件状态 | 单 Profile 状态 | `before_turn` 行为 | `update_memory` |
| :--- | :--- | :--- | :--- |
| 启用（默认） | 开启（默认） | 注入 `memory.content` / `memory.guide` + 用法提示 | 正常原子写盘（64k 防线） |
| 启用 | 关闭 | 不读文件、不注入，并从本回合工具表剥离 `update_memory` | `403 memory_disabled_for_profile` |
| 停用 | 任意 | 不注入任何段落 | 工具已随插件卸载 |

开关影响后续调用与回合，不取消在途写入或已经开始的回合。关闭后磁盘文件保留，重新开启即恢复。Profile 删除后以相同 ID 重建时，私有状态标记仍按 ID 生效；本设计不提供 Profile 删除时的记忆状态清理。

## 存储防线：MemoryStore 与 64k 上限

`MemoryStore` 直接管理 `<dataDir>/profiles/<profileId>/MEMORY.md`，经公开宿主端口工作：`ctx.host.profiles.directory(id)` 获取目录、`ctx.host.withFileLock` 串行读改写、`ctx.host.atomicWriteFile` 原子落盘。插件不导入内核私有文件服务，也不从插件数据目录推算 Profile 路径。

`MAX_MEMORY_CHARS = 64_000` 上限在**文件锁内对合并后的最终内容**统一强制——这是防线的唯一权威点：跨会话同 Profile 并发 `append` 不可能各自「预读旧值 + 检查通过」后叠加突破上限；超限显式抛 `400 memory_limit_exceeded`（提示用 `replace` 整体精简），不写半截文件。所有写入路径（`update_memory` 工具、`set` 动作、`configure` 携带 text）走同一防线，无绕过参数。存量超限（外部手改绕过防线）时注入截断并附显式说明，绝不静默截断、不修改源文件。

文件锁约束同一 Hub 进程内使用该锁的调用方；可信插件、Shell 与其他进程可以绕过它——插件不是文件系统沙箱。

## 状态文档与初始化语义

插件私有 `ctx.doc('state')` 只存两个紧凑列表：`disabledProfiles`（单 Profile 开关）与 `initializedProfiles`（初始化标记）。初始化标记用于跨重启区分两种「文件不存在」：

- **从未初始化的合法 Profile**：首次需要记忆时惰性创建默认骨架（`# Memory`），不误报缺失；
- **已初始化后被外部删除**：显式 warning 通知（按 profileId 独立去重，恢复或写入即停、再删可重新告警）+ 注入 `memory.assets-missing` 段落，本回合按无记忆处理——绝不启动时无条件重建掩盖丢失。空白 MEMORY.md 是合法的 `memory.guide` 状态，无告警。

## `before_turn` 注入段落

| 段落 ID | 触发条件 | 内容 |
| :--- | :--- | :--- |
| `memory.content` | MEMORY.md 非空白 | `<memory>` 包裹全文 + `update_memory` 用法提示 |
| `memory.guide` | MEMORY.md 空白（合法态） | 仅 `update_memory` 用法提示（无内容、无告警） |
| `memory.assets-missing` | 已初始化后被外部删除 | `<memory_assets_missing>` 显式警告，要求提醒用户检查或经 `update_memory` 重建 |

用法提示由本插件动态注入（SYSTEM.md 不再硬编码 `update_memory` 指引），插件停用后该指引随之消失——不留幻影能力提示词。

## 动作契约（五端复用）

三个 `ctx.action` 自动映射 HTTP `POST /api/actions/builtin:memory/<action>`、CLI `helm memory <action>` 与 Web `invokeAction`。目标解析纪律统一：显式 `profileId` 优先；省略时从 `conversationId` 调用上下文解析（CLI 用 `--current`）；两者皆缺显式 `400 validation_error`，不猜测默认角色。Profile 不存在返回 `404 profile_not_found`。

### `helm memory get`

```bash
helm memory get --profile-id coder --json
helm memory get --current --json
```

返回 `{profileId, enabled, content, initialized}`；文件不存在如实返回空串（前端显示真实状态，不伪造内容）。

### `helm memory set`

```bash
helm memory set --current --text '偏好简洁回复。' --json
helm memory set --profile-id coder --text '新事实' --mode append --json
```

`--mode replace`（默认）整体替换、`append` 追加。Profile 已关闭时 `403 memory_disabled_for_profile`；超限 `400 memory_limit_exceeded`。

### `helm memory configure`

```bash
helm memory configure --current --enabled=false --json
helm memory configure --profile-id coder --enabled=true --json
helm memory configure --profile-id coder --enabled=true --text '# 重置后的记忆' --json
```

携带 `--text` 时先写文本、成功后才提交开关（失败不留半配置）。开启且尚无初始化标记时惰性创建文件（已有文件原样保留）。

## Web 单 Profile 插槽

插件经 `ctx.ui.slot({ target: 'builtin:profile/detail-section' })` 向角色详情抽屉注入：单 Profile「启用长期记忆」开关（即时生效）与 MEMORY.md 编辑器。编辑器与「取消角色编辑」独立保存，不随回滚；新建尚未落盘的 Profile 只提示先创建角色；异步切换 Profile 带代数竞争保护，保存期间继续编辑只提交保存开始时捕获的文本；加载失败显式显示错误，不伪装为关闭。
