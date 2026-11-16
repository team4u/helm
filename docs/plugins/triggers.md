# 触发器插件：Cron 与 Webhook 入站连接器

`builtin:triggers` 解决「让外部世界定时或经 HTTP 事件驱动会话」的问题：Cron 定时器与 Webhook 接收器把事件经共享投递 helper 送入内核 `trigger` 管道，统一 `defang` 防逃逸包裹后路由到目标会话。适合需要定时巡检、接收外部系统回调的使用者。

## 当前状态

默认启用、非 `locked` 可停用。管理界面为 client.tsx React 单轨（`TriggersManagerScreen` 与 `TriggersSettingsPanel`）。

## 能力和入口

### Cron 定时编排

标准五字段 cron（分 时 日 月 周，cron-parser 驱动），IANA 时区（默认 UTC）。任务持久化于公共文档 `crons`。调度语义四条硬保证：

1. **至多一次**：调度点先推进 `nextRunAt` 并 `await doc.flush()` 真实落盘，再投递。持久 claim 与异步输入提交不构成原子事务——claim 落盘后、投递完成前崩溃则该次丢失，如实声明，不承诺 exactly-once；
2. **单飞保护**：同一 job 并发 tick 只允许一个在途；
3. **重启补跑（`catchUp`）**：`true` 重启后对错过时段合并补跑最近一次；`false` 跳至未来首个时点；
4. **分段防溢出**：定时器间隔超 32 位上限（约 24.8 天）时先以安全窗口触发再续排，timer unref 不阻退出。

写回按 `(id, rev)` 双键校验：delete 后重建同 ID 即换代（`rev` 新 UUID），在途 tick 不污染新任务。投递失败如实写 `lastError` 并发 notification；本计划点不重试，下个时点照常。

| 动作 | CLI | 说明 |
| :--- | :--- | :--- |
| `cron_create` | `helm cron create` | `--id`（1..64 位 `[A-Za-z0-9_-]`，禁点号）/ `--schedule` / `--text` 必填；可选 `--timezone` / `--description` / `--enabled` / `--catchUp` / `--target-conversation-id`（与 `--target-profile-id` 互斥）/ `--thread-key`。会话动作目录附三条使用指引（五字段语义、IANA 时区与投递目标、触发只投递 text 文本而非任意 shell 定时器） |
| `cron_delete` | `helm cron delete <id>` | 删除任务；在途投递自然终止，不复活 |
| `cron_trigger` | `helm cron trigger <id>` | 手动立即真实投递一次（失败抛错，不影响后续计划调度） |
| `cron_list` | `helm cron list` | 全部任务含 `lastRunAt` / `nextRunAt` / `lastError` |

### Webhook 签名入站

宿主挂载公开路由 `POST /api/plugins/builtin:triggers/routes/webhook/:id`（`public: true` 跳过 Token 鉴权，插件自行验签）。握手链：请求体流式限制 256 KiB（超限 `413 payload_too_large`）→ HMAC-SHA256 验签（`x-helm-signature: sha256=<hex>` 覆盖原始 body 字节，`timingSafeEqual` 常时比较；无签名/错签名 401，ID 不存在 404，坏 UTF-8 显式 400）→ 配置一致性复核（读 body 期间端点被删/重建返回 `409 webhook_changed`）→ 投递（`202 {accepted: true}`；失败显式 `500 webhook_dispatch_failed`）。

| 动作 | CLI | 说明 |
| :--- | :--- | :--- |
| `webhook_create` | `helm webhook create` | `--id` / `--secret` 必填；可选 `--description` 与定向参数。**secret 仅允许人工 HTTP/CLI 配置**：检测到会话调用上下文（`run_action` / workflow）显式 `403 webhook_secret_context_forbidden`——raw secret 经工具参数已进入模型上下文，handler 拒绝无法清理已入上下文的秘密 |
| `webhook_list` | `helm webhook list` | 端点元数据（不含 secret） |
| `webhook_delete` | `helm webhook delete <id>` | 先删 doc（下线入口）再删 secret；secret 删除失败显式报错 |

### 共享投递与目标解析

Cron 与 Webhook 共用 `delivery.ts` 投递 helper：`targetConversationId` 优先（与 `targetProfileId` 互斥）；仅 `targetProfileId` 时取该 Profile 现有会话中最低 ID，无会话则校验存在后创建；均无时由内核 `trigger` 管道解析（最新无父链 human-owned assistant 会话）。显式目标失效在 trigger 钩子前显式报错，不被 ThreadKey 路由掩盖。宿主关闭中（`isClosing`）拒绝投递。事件文本经内核 `dispatchTrigger` 统一 `defang` 防逃逸包裹，连接器绝不双层包裹。

### 管理界面

左栏「触发器管理」入口 + `manager` 全屏 Screen（订阅 crons/webhooks 公共 doc；行内「立即触发」「删除」经 `ctx.callAction` 调真实动作端点）+ 设置面板概览。

## 配置与数据边界

插件自身无 `ctx.configSchema` 配置项；任务与端点定义即配置，持久化于公共文档 `crons` / `webhooks`。**验签密钥只持久化于 `credentials.json` 的 `pluginSecrets['builtin:triggers']['webhook:<id>']`**（恒 0600，经 `ctx.host.secrets` 绑定命名空间）并注册全局脱敏；公共文档只存元数据（`hasSecret` 布尔协作契约），绝不包含原始密钥。create 无跨存储事务：先写 doc 并 flush，再写 secret；secret 写失败回滚移除 doc 条目，回滚失败聚合显式上抛。

## 停用与失败语义

已启用的 cron 任务与已配置 webhook 端点是 `inUse()` 停用占用项：`helm plugins disable builtin:triggers` 默认 `409 plugin_in_use` 并列出占用清单，`--force` 可知情越过（磁盘配置保留，重新启用后恢复）。停用后动态命令、管理界面与调度器即时消失。cron 文档损坏（坏 JSON、缺字段、重复 ID）显式抛 `cron_doc_corrupt`，绝不静默重置。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口 | `packages/plugins/src/triggers.ts` |
| Cron 调度 / Webhook / 投递 | `packages/plugins/src/triggers/cron.ts`、`webhook.ts`、`delivery.ts` |
| 前端管理界面 | `packages/plugins/src/triggers/client/` |
| 测试 | `packages/plugins/test/triggers.test.ts`、`triggers-cron.test.ts`、`triggers-webhook.test.ts` |

## 相关文档

- [SuperAgent 双层中枢](superagent.md)：`threadKey` 直通路由与 `mutedSources` 的消费方
- [插件系统设计与契约](overview.md)：`ctx.route` 公开路由与 `inUse` 停用预检
- [CLI 命令参考](../cli/reference.md)：`helm cron` / `helm webhook` 动态命令
