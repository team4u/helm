# Magpie 动态模型网关插件

`builtin:magpie` 把 Magpie 动态模型网关接入 Helm（可选启用）：经 `ctx.provider` 注册 pi-ai 动态目录 Provider，宿主在服务启动前自动挂载、停用后自动注销——插件内不绕宿主手动挂卸。插件同时维护公开状态文档 `status` 驱动 Web 配置面板、命令面板与 `helm magpie` CLI，并在回合结算后后台静默刷新配额与路由。

## 多协议自动分发

Provider 按模型 `api` 类型自动匹配协议族并动态修正 BaseURL（每次推理请求读取当前生效配置，绝不依赖目录缓存中的静态地址）：

| 协议族 | 规范 | BaseURL 修正 |
| :--- | :--- | :--- |
| Anthropic | Messages | 网关根路径（如 `http://127.0.0.1:3425`） |
| OpenAI 兼容 | Chat Completions | 根路径 + `/v1` |
| Gemini | Google 协议 | 经 pi-ai compat 委托实现 |

模型经 `magpie/<model>` 形式的 ID 进入全局模型目录；本机 loopback 网关免登录即用（auth.check 恒有效）。

## 动态模型目录与本地缓存

模型目录不静态硬编码：Provider 的 `refreshModels` 经 `GET /v1/models` 从网关拉取最新清单，成功后原子写回内核持久缓存 `models-store.json`（按 provider 分区）；`allowNetwork: false` 的 cache-only 恢复只读磁盘缓存、不触网。目录恢复与发布按当前网关 root 过滤——切换网关后旧目录绝不冒充新网关的缓存。

诚实性契约在此是硬约束：网络失败（含默认 loopback 网关未运行）一律 throw，通用目录刷新（`helm models refresh` / `POST /api/models/refresh`）把失败显式呈现在 `errors['magpie']`，绝不静默吞成「刷新成功」。插件 `service.start` 的后台刷新失败只更新 `reachable: false / lastError`，不阻断插件启用与内核启动；手动 `refresh` 动作显式抛 `502 magpie_gateway_unreachable`。`reachable: false` 时的 `modelCount` 是缓存计数，绝不冒充实时刷新成功。

**配置快照代数守卫**：所有网关读取都以「读取时刻冻结的 root + token 快照」执行，发布前经 `sameGateway` 校验快照仍是当前生效配置——fetch 期间用户切换了网关地址时，挂起的旧结果不发布到新网关名下（显式 `409 magpie_gateway_changed`），杜绝脏数据覆盖。

## 状态文档与诊断

公开文档 `status` 实时汇总网关状态，供配置面板与 CLI 消费。核心字段：

| 字段 | 说明 |
| :--- | :--- |
| `gatewayUrl` | 当前生效网关根地址（配置切换后不残留旧 root） |
| `configuredRoot` / `local` | 是否显式配置 / 是否本机 loopback |
| `reachable` / `modelCount` / `groupCount` | 可达性与计数（不可达时模型数为缓存计数） |
| `lastRefreshedAt` / `lastError` | 最近成功刷新时间 / 最近错误（成功后清除，不残留旧结论） |
| `quotas` / `routes` | 配额快照与最近路由轨迹 |
| `diagnostics` | 显式诊断列表（配额/轨迹不可用原因如实记录，绝不把「没有配额」伪装成「配额为空」） |

数据源隔离纪律：非默认端口的本机网关与远端网关不读本机 `magpie` CLI 数据（那是另一个实例，无法证明目标一致），只用所选网关自身的 trace 并如实标注 `source`；仅 `http://127.0.0.1:3425` 默认实例信任 CLI 读取的组定义。

## 导出动作（五端复用）

| 动作 | CLI | 说明 |
| :--- | :--- | :--- |
| `status` | `helm magpie status` | 网关状态快照；配置切换后 doc 指向旧 root 时如实返回新 root 的空结论（不冒充） |
| `refresh` | `helm magpie refresh` | 强制网络刷新目录与配额路由；失败显式抛 `magpie_gateway_unreachable` |
| `quota` | `helm magpie quota` | 实时查询配额（`GET /v1/magpie/quotas`），可按模型归属 provider 过滤 |
| `groups` | `helm magpie groups` | 路由组列表与最近命中（本机默认实例 = CLI + trace 合并；否则仅 trace） |
| `group` | `helm magpie group <id>` | 单组定义与最近路由决策；无可用信息显式 `404 magpie_group_not_found`，绝不编造 |

另注册命令面板命令 `magpie-refresh`（`helm:action` 直连 refresh 动作）。

## turn_settled 后台静默刷新

每回合结算时，若该会话当前模型以 `magpie/` 开头（其他 Provider 的会话不触发任何网关读），插件后台异步刷新配额与路由，请求携带 `?kept=1`——只复用网关本地缓存指标、不问上游供应商、不消耗调用配额。刷新不 `await`，绝不阻塞回合结算；失败进 diagnostics 并发轻量通知，下一次结算重试。

## 机密隔离

网关 API Key 声明为 `secret: true`，持久化于 `credentials.json` 并入 `SecretStash` 全局脱敏。密钥只经 Bearer 头传输：动作输出、状态文档、错误文本（含网关错误页回显，统一剥离 Bearer 形态与已知 token 本体）中严禁出现明文密钥。本机 loopback 缺省凭据为 `magpie`，远端网关强制校验专属密钥。Web 配置面板（`settingsPanel` `Magpie 网关`）提供网关地址与密钥配置表单。
