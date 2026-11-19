# Magpie 动态模型网关插件

`builtin:magpie` 解决「把 Magpie 网关的模型目录接入 Helmx 并诊断配额与路由」的问题：经 `ctx.provider` 注册动态目录 Provider，把 `magpie/<model>` 形式的模型接入全局目录，并提供状态快照、目录刷新、配额查询与路由组诊断动作。适合使用 Magpie 多协议模型网关的使用者。本插件只做接入与诊断，不改变内核 Model/Auth 机制。

## 当前状态

默认启用，随 `createHelmx()` 启动即挂载，可按需 `helmx plugins disable builtin:magpie` 停用。Provider 由宿主在服务启动前挂载、停用后注销，插件内不绕宿主手动挂卸。

## 能力和入口

### 动态目录与多协议分发

模型目录不静态硬编码：Provider `refreshModels` 经 `GET /v1/models` 从网关拉取，成功后原子写回内核持久缓存（`models-store.json` 按 provider 分区）；`allowNetwork: false` 的 cache-only 恢复只读缓存不触网。目录恢复与发布按当前网关 root 过滤——切换网关后旧目录绝不冒充新网关缓存。协议族由目录项 `native_endpoints` 判定并动态修正 BaseURL（绝不依赖目录缓存静态地址）：Anthropic Messages 挂网关根、OpenAI Responses 与 Chat Completions 挂根 + `/v1`。本机 loopback 网关免登录即用。

### 动作（五端复用）

| 动作 | CLI | 说明 |
| :--- | :--- | :--- |
| `status` | `helmx magpie status` | 状态快照（可达性、模型数、配额、路由轨迹）；配置切换后 doc 指向旧 root 时如实返回新 root 的空结论，不冒充 |
| `refresh` | `helmx magpie refresh` | 强制刷新目录与配额路由；失败显式抛 `502 magpie_gateway_unreachable` |
| `quota` | `helmx magpie quota [--model <id>]` | 实时查询配额（`GET /v1/magpie/quotas`），可按模型归属 provider 过滤 |
| `groups` | `helmx magpie groups` | 路由组列表与最近命中；本机默认实例读 magpie CLI + 网关 trace（`source: 'cli+trace'`），其余只用所选网关 trace（`source: 'gateway-trace'`） |
| `group` | `helmx magpie group <id>` | 单组定义与最近路由决策；无可用信息显式 `404 magpie_group_not_found` |

### 状态文档与后台刷新

公开文档 `status` 实时汇总：`gatewayUrl` / `configuredRoot` / `local` / `reachable` / `modelCount` / `groupCount` / `lastRefreshedAt` / `lastError`（成功后清除不残留）/ `quotas` / `routes` / `diagnostics`（配额/轨迹不可用原因如实记录，绝不把「没有配额」伪装成「配额为空」）。驱动设置面板（`magpie-panel`）与命令面板（`magpie-refresh`）。`turn_settled` 后对使用 `magpie/` 前缀模型的会话后台静默刷新配额路由（`?kept=1`，不问供应商、不阻塞回合）。

## 配置与数据边界

| 配置 | 类型 | 缺省 | 说明 |
| :--- | :--- | :--- | :--- |
| `gatewayUrl` | string | `http://127.0.0.1:3425` | 网关地址（可填 `http://host:3425`） |
| `apiKey` | string（secret） | 空 | API Key；本机 loopback 缺省 `magpie`，远端网关填写对应密钥。secret 字段分离至 credentials.json，绝不进 doc / 动作输出 / 错误文本 |

诚实性契约（硬约束）：

- **网络失败一律显式**：通用目录刷新（`helmx models refresh`）把失败呈现在 `errors['magpie']`；插件 `service.start` 的后台刷新失败只更新 `reachable: false` / `lastError`，不阻断启用与内核启动；`reachable: false` 时 `modelCount` 是缓存计数，绝不冒充实时刷新成功；
- **配置快照代数守卫**：所有网关读取以「读取时刻冻结的 root + token 快照」执行，发布前 `sameGateway` 校验快照仍是当前生效配置——fetch 期间切换网关时旧结果不发布到新网关名下；
- **数据源隔离**：非默认端口本机网关与远端网关不读本机 magpie CLI 数据（无法证明 CLI 指向同一实例），只用所选网关 trace 并如实标注 `source`。

## 停用与失败语义

停用后 Provider 注销（`magpie/` 模型从目录消失）、动作与动态命令、设置面板与命令面板即时消失；持久缓存保留，重新启用后按当前网关 root 恢复。`service.stop` 置停用信号并中止在途网关读取，停用后不再写 doc。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口 | `packages/plugins/src/magpie.ts` |
| 网关 / 目录 / 配额 / 路由解析 | `packages/plugins/src/magpie/gateway.ts`、`catalog.ts`、`quota.ts`、`routing.ts` |
| Provider 注册 | `packages/plugins/src/magpie/provider.ts` |
| 前端设置面板 | `packages/plugins/src/magpie/client/` |
| 测试 | `packages/plugins/test/magpie-plugin.test.ts`、`magpie-app.integration.test.ts`、`packages/web/test/magpie-client-interactions.test.tsx` |

## 相关文档

- [插件系统设计与契约](overview.md)：`ctx.provider` 生命周期与配置 secret 分离
- [CLI 命令参考](../cli/reference.md)：`helmx magpie` / `helmx models` 命令
- [安装与配置指南](../getting-started/installation.md)：模型网关与凭据规划
