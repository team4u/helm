# 触发器插件：Cron 与 Webhook 入站连接器

`builtin:triggers` 是系统的入站连接器（可选启用）：Cron 定时器与 Webhook 接收器两大连接器把外部事件经共享投递 helper 送入内核 `trigger` 管道，统一 `defang` 防逃逸包裹后路由到目标会话。管理界面基于 `client.tsx` React 单轨实现（`TriggersManagerScreen` 与 `TriggersSettingsPanel`），不再有声明式 JSON 管理界面。

## Cron 定时编排

Cron 模块支持标准五字段表达式（分 时 日 月 周，cron-parser 驱动），IANA 时区（默认 UTC）。任务配置持久化于公共文档 `crons`（纯 JSON，`lastRunAt / nextRunAt / lastError` 随调度推进）。调度语义有四条硬保证：

1. **至多一次**：调度点触发时先推进 `nextRunAt` 并 `await doc.flush()` 真实落盘，再投递。claim 落盘失败绝不投递（否则崩溃窗口产生重复投递）。持久 claim 与异步输入提交不构成原子事务——claim 落盘后、投递完成前崩溃则该次丢失，这是如实声明的诚实语义，不承诺 exactly-once。
2. **单飞保护**：同一 job 并发 tick 只允许一个在途执行，上次回合未完成时跳过并发触发。
3. **重启补跑策略（`catchUp`）**：`true` 时重启后对错过时段合并补跑最近一次（不逐段重放历史）；`false` 时跳至未来首个时点（跳过同样 claim+flush，防重启回跳重算）。
4. **分段防溢出**：定时器间隔超过 32 位上限（约 24.8 天）时先以安全窗口触发再续排，杜绝定时器提前误触发；timer 均 unref 不阻退出。

写回按 `(id, rev)` 双键校验：delete 后重建的同 ID 任务即换代（`rev` 为新 UUID），在途 tick 的 claim/lastError 绝不污染新任务。投递失败如实写 `lastError` 并发 notification；本计划点不重试（至多一次语义），下个时点照常调度。

### Cron 管理动作

| 动作 | CLI | 关键参数 |
| :--- | :--- | :--- |
| `cron_create` | `helm cron create` | `--id`（1..64 位 `[A-Za-z0-9_-]`，禁点号）、`--schedule`、`--text` 必填；可选 `--timezone`、`--description`、`--enabled`、`--catchUp`、`--target-conversation-id` / `--target-profile-id`（互斥）、`--thread-key` |
| `cron_delete` | `helm cron delete <id>` | 删除任务；在途投递自然终止，被删任务不可能复活 |
| `cron_trigger` | `helm cron trigger <id>` | 手动立即真实投递一次（不写 doc、不影响后续计划调度） |
| `cron_list` | `helm cron list` | 列出全部任务含调度状态（`lastRunAt / nextRunAt / lastError`） |

已启用的 cron 任务是停用预检的占用项：`inUse()` 声明非空时 `helm plugins disable builtin:triggers` 默认 `409 plugin_in_use`，`--force` 可知情越过。

`cron_create` 在会话动作目录（`<available_actions>`）附三条使用指引（随插件启停与 scope 自动注入/清理）：五字段周期 cron 语义、显式 IANA 时区与投递目标、触发只把 `text` 文本投递到目标会话而非任意 shell 定时器。

## Webhook 签名入站

Webhook 模块提供经验签的公网入站接口。宿主为插件挂载公开路由 `POST /api/plugins/builtin:triggers/routes/webhook/:id`（`public: true` 跳过 Token 鉴权，插件自行验签）。完整握手：

1. **体积上限**：请求体流式限制 256 KiB，超限立即 cancel reader 并返回 `413 payload_too_large`（不吞完整 body 到内存）；
2. **HMAC-SHA256 验签**：请求必须携带 `x-helm-signature: sha256=<hex>` 请求头，签名覆盖原始 body 字节；比对使用 `crypto.timingSafeEqual` 常时比较（正则保证等长后才比较，不因长度分支泄漏时序）。无签名或错签名 `401`，ID 不存在 `404`，坏 UTF-8 显式 `400`（`fatal: true` 解码，绝不静默替换字符）；
3. **配置一致性复核**：读 body 期间端点可能被删除或重建——投递前复核 secret 与 `createdAt` 均未变化，已变更返回 `409 webhook_changed` 请发送方按当前密钥重发；
4. **投递**：验签通过后经共享 helper 投递，返回 `202 {accepted: true}`；投递失败显式 `500 webhook_dispatch_failed`，绝不静默截取文本冒充成功。

### 机密隔离与创建边界

验签密钥只持久化于 `credentials.json` 的 `pluginSecrets['builtin:triggers']['webhook:<id>']`（恒 0600，经 `ctx.host.secrets` 绑定本插件命名空间），并注册全局 `SecretStash` 脱敏；公共文档只存元数据（`hasSecret` 布尔协作契约），绝不包含原始密钥。

**严禁模型会话创建密钥**：`webhook_create` 检测到 `conversationId` 调用上下文（`run_action` / workflow）时显式 `403 webhook_secret_context_forbidden` 拒绝——raw secret 经工具参数已进入该会话模型上下文，handler 拒绝无法清理已入上下文的秘密。密钥仅允许人工 HTTP/CLI（`helm webhook create`）配置。`webhook_create` 的会话目录指引如实声明同一契约：secret 只由人工配置、模型不生成不代填不回显；这是运行时强制（handler 拒绝）加协作纪律的双层约束，不是权限沙箱声明。create 无跨存储事务：先写 doc 并 flush 真实冲刷，再写 secret；secret 写失败回滚移除 doc 条目，回滚失败聚合显式上抛。已配置端点同样构成 `inUse()` 停用占用项。

### Webhook 管理动作

| 动作 | CLI | 说明 |
| :--- | :--- | :--- |
| `webhook_create` | `helm webhook create` | `--id --secret` 必填；可选 `--description` 与定向参数（同 cron）；`targetProfileId` 创建时即校验存在 |
| `webhook_list` | `helm webhook list` | 列出端点元数据（不含 secret） |
| `webhook_delete` | `helm webhook delete <id>` | 先删 doc（下线入口）再删 secret；secret 删除失败显式报错（残留无入口不再可利用，人工可清理） |

## 共享投递与目标解析

Cron（`targetProfileId` 第二参）与 Webhook（envelope 携带已解析 target）共用 `delivery.ts` 的同一投递 helper：`targetConversationId` 优先（与 `targetProfileId` 互斥）；仅 `targetProfileId` 时取该 Profile 现有会话中最低 ID，无会话则校验存在后创建新会话（绝不发给错误角色）；均无时保持缺省，由内核 `trigger` 管道解析——缺省选择最新的无父链、human-owned 的 assistant 会话，没有候选时同进程并发共享一次在途创建。原始显式目标在 trigger 钩子前校验（失效目标显式报错，不允许被 ThreadKey 路由改写掩盖）。宿主关闭中（`ctx.host.isClosing`）显式拒绝投递，防 close 期触发新回合。

事件文本经内核 `dispatchTrigger` 统一 `defang` 防逃逸包裹，隔离不可信外部文本，防止模型把外部输入误判为系统指令；连接器绝不双层包裹。`source` 约定 `cron:<id>` / `webhook:<id>`，envelope ID 含计划点或随机 UUID（同点稳定，跨重启幂等）。

## 管理界面（client.tsx React 单轨）

触发器管理界面完全由 React 组件实现，遵循极简无 Emoji 规范（图标用 lucide 线性名）：

- **`TriggersManagerScreen`**（全屏 Screen，左栏 `触发器管理` 入口）：经 `usePluginDoc` 实时订阅 `crons` 与 `webhooks` 公共文档，渲染 Cron 任务表（schedule / timezone / 状态 / 下次触发 / lastError）与 Webhook 端点表（ID / 目标 / 创建时间）；行内动作「立即触发」「删除」经 `ctx.callAction` 调用真实动作端点；
- **`TriggersSettingsPanel`**（设置面板）：展示当前任务与端点总数概览，引导经 CLI 或管理屏幕维护配置。
