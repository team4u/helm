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

## 每日 Dream（记忆自动整理）

`builtin:memory` 自带一个每日低峰时段的记忆整理服务（`memory-dream`），把近期候选合并进 MEMORY.md。全程零会话回合：整理调用 `ctx.host.completeText` 单次无工具补全，不创建/提交任何会话输入，因此梦境自身永远不会再次进入候选采集（不会自我喂食）。

### 候选采集（turn_settled，轻量有界）

每回合结算时收集候选，只保存有界真实文本，绝不读取/持久化完整会话：

- 采集条件：`outcome === 'completed'` 且 top-level、human-owned 会话，且该 Profile 记忆开启；
- 候选内容：本回合 `origin === 'human'` 输入的合并摘录（单条 ≤ 1500 字符）+ 可选的最终 assistant 文本摘录（≤ 800 字符，只取 `pi.assistant` 文本块，thinking/toolCall/工具输出结构性排除）；
- 机械低价值过滤（保守）：极短应答、斜杠命令、纯 shell 命令、以代码/日志行为主的粘贴；最终价值判断由梦境模型完成；
- 全部内容过 `ctx.host.redact` 脱敏；标题截断 120 字符；
- 存储仅落插件私有 `ctx.dataDir`（`<dataDir>/plugins/builtin%3Amemory/dream/<profileId>/candidates.json`），不进任何公共 doc/SSE；
- 上限：单 Profile 最多 64 条、TTL 14 天（双重裁剪），按 `(conversationId, humanText)` 去重；文件损坏显式告警重置（MEMORY.md 不受影响）。

### 每日调度（ctx.service）

- 默认每天本地 `03:00`（`hour` 可配 0..23）、时区默认取宿主系统 IANA 时区（可配），全局单配置；
- 重启恢复：`nextRunAt` 持久化于私有 doc；停机错过窗口则在启动时补跑一次（先落盘再挂 timer），否则按持久化时点恢复；
- 每日扫掠对每个「有候选且记忆开启且 Profile 存在」的 Profile 依次整理；无候选合法跳过（零模型调用）；
- 单 Profile 单飞：手动立即整理与扫掠共享同一 in-flight Promise（后到者等待结果）；
- `stop()`：置停标志、清 timer、abort 全部在途整理（AbortController 于任何 await 前注册，读文件阶段也可中止），等待收敛；`liveTasks` 暴露在途整理与采集任务，插件停用在途期间被 `409 plugin_has_live_tasks` 硬阻断（不可 force）。梦境调度不声明 `inUse`（停用即暂停整理、候选与 MEMORY.md 保留，重新启用按 `nextRunAt` 恢复）。

### 梦境执行与写回

- 模型解析：绑定该 Profile **真实存在的 top-level human-owned 会话**作为 `completeText` 的 conversationId（取最新 updatedAt）；无此类会话则合法跳过并显式记录 `no_conversation_for_model`，绝不创建隐藏会话；
- 输入 = 当前 MEMORY.md 全文 + 候选（按时间序）；系统提示词强制「只基于既有事实、保留偏好/纠正/长期约定/跨会话未完成事项、丢弃一次性杂讯、目标约 4000 字符、严格 JSON」；
- 输出严格校验：单一 JSON 对象 `{"memory": string}`（允许 ```json 围栏），非空白、≤ 64000 硬上限、≤ `max(8000, 当前长度+1000)` 预算（整理不得膨胀）；任何不合法即拒绝写回（`502 dream_output_invalid`，reason 机器可读），候选保留待重试；
- 写回为锁内 CAS：`MemoryStore.commitDreamMemory` 在**同一个 `withFileLock` 闭包内**重读当前文件、重算 hash、复核 64k 后原子写；期间被人类/工具改过（hash 不符）即放弃写回（`conflict`），绝不覆盖；
- 成功后按 id 精确消费候选（整理期间新采集的候选保留）、写诊断快照（`snapshots/`，保留最近 5 份且 14 天 TTL，坏输出快照附带 ≤128k 的原始模型输出）；提交后的簿记失败不回滚也不误报失败（显式 emitError，未消费候选下次无害重叠）。

### 动作（五端复用，CLI `helmx memory <action>`）

| 动作 | CLI | 说明 |
| :--- | :--- | :--- |
| `dream` | `helmx memory dream` | 立即整理（`--profile-id` 或 `--current` 选目标，纪律同 get/set）；无候选/无模型会话返回 `ran:false` + reason，坏输出显式抛错；目标 Profile 记忆关闭 403 |
| `dream_status` | `helmx memory dream_status` | 调度配置、nextRunAt、在途 Profile、各 Profile 候选数 / MEMORY.md 长度 / 上次整理结果（可选 `--profile-id`/`--current` 聚焦，无目标返回全局视图） |
| `dream_configure` | `helmx memory dream_configure` | 全局调度配置：`--enabled <bool>` 暂停/恢复自动整理、`--hour <0-23>`、`--timezone <IANA>`；至少一项，非法组合显式 400；暂停清除 nextRunAt |

默认自动应用（梦境结果直接写回 MEMORY.md，无人工确认环节；不信任时可 `dream_configure --enabled false` 暂停后手动 `dream`）。

## 配置与数据边界

- **存储**：`<dataDir>/profiles/<profileId>/MEMORY.md`；`MAX_MEMORY_CHARS = 64_000` 上限在文件锁内对合并后最终内容统一强制，所有写入路径（工具、`set`、`configure` 携带 text、梦境 CAS 写回）共用同一防线，无绕过参数。存量超限（外部手改绕过防线）注入截断并显式说明，不静默截断、不修改源文件。超过 64000 字符需先 `replace` 精简。
- **插件状态**：私有 `ctx.doc('state')` 只存两个紧凑列表——`disabledProfiles`（开关）与 `initializedProfiles`（初始化标记，跨重启区分「从未初始化」与「已初始化后被删」）；私有 `ctx.doc('dream')` 存梦境紧凑状态（全局调度配置、`nextRunAt`、各 Profile 最近一次整理结果，≤ 50 条）。候选全文与诊断快照只在插件私有 `ctx.dataDir` 文件中，有界且带 TTL。插件无 `ctx.configSchema` 配置项（梦境配置走 `dream_configure` 动作）。
- **文件锁边界**：锁约束同一 Hub 进程内使用该锁的调用方；可信插件、Shell 与其他进程可以绕过——插件不是文件系统沙箱。

## 停用与失败语义

停用本插件后：`update_memory` 工具、`helmx memory` 动态命令、Profile 详情抽屉的记忆编辑器与注入段落即时消失；磁盘 MEMORY.md 文件保留，重新启用即恢复。开关影响后续调用与回合，不取消在途写入。在途梦境整理/采集期间停用被 `liveTasks` 硬阻断（`409 plugin_has_live_tasks`，不可 force）；停用后梦境调度即暂停（不声明 `inUse`），候选与 MEMORY.md 保留，重新启用按持久化 `nextRunAt` 恢复。Profile 删除后以相同 ID 重建时，开关状态仍按 ID 生效；本设计不提供 Profile 删除时的记忆状态清理。

初始化语义的诚实边界：从未初始化的合法 Profile 首次需要记忆时惰性创建默认骨架（不误报缺失）；已初始化后被外部删除时显式 warning 通知（按 profileId 独立去重）+ 注入 `memory.assets-missing`，绝不启动时无条件重建掩盖丢失；文件恢复或工具写入后自愈。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口（动作/工具/钩子/插槽/梦境接线） | `packages/plugins/src/memory.ts` |
| MemoryStore（文件锁 + 64k 上限 + 梦境锁内 CAS 唯一权威点） | `packages/plugins/src/memory/store.ts` |
| Dream 引擎（候选采集/每日调度/严格 JSON/CAS 写回） | `packages/plugins/src/memory/dream.ts` |
| 前端插槽组件 | `packages/plugins/src/memory/client/` |
| 测试 | `packages/plugins/test/memory-plugin.test.ts` · `packages/plugins/test/memory-dream.test.ts` |

## 相关文档

- [角色与技能底座](profile.md)：SYSTEM.md 注入（与本插件正交）
- [插件系统设计与契约](overview.md)：`ctx.doc` / `ctx.action` 宿主机制
- [CLI 命令参考](../cli/reference.md)：`helmx memory` 命令与 `--current`
