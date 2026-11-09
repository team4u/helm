# builtin:superagent 开发交接

本阶段已完成主设计 §4.3 的后端插件、HTTP/CLI 管理动作和声明式 UI 贡献，实现提交为 `main@4d9f0ca`。构建、型检、全仓 **748/748**、六项跨模块验收与两套编译后冒烟均通过，失败、取消、跳过均为 0。整理提交未改变已验证的源码或测试，后续仅提交本文档。主设计文档中的用户独立修改不属于本阶段提交。

## 范围与入口

- `packages/kernel/src/builtin-plugins/superagent.ts`：配置、自举、L0 路由、中枢工具、Worker 派生与归档、结算汇报、RecallGraph 和 UI 声明。
- `packages/kernel/src/builtin-plugins/superagent/contracts.ts`：工厂依赖、三份业务文档及模块协作契约。
- `packages/kernel/src/builtin-plugins/superagent/assets.ts`：两个 Profile 与 Watchdog 技能包的缺失文件自举。
- `packages/kernel/src/builtin-plugins/superagent/watchdog.ts`：两层巡检、只读诊断、恢复与中止的执行守卫、授权 Ask 与生命周期清理。
- `createHelm` 默认注册停用的 `builtin:superagent`；启停状态沿用 `config.json.pluginEnabled`，配置沿用插件配置存储。

## 行为与边界

启用插件后，先补齐缺失的 `superagent`、`watchdog` Profile 和 `watchdog-playbooks` 技能包，再动态创建「SuperAgent 中枢」与「巡检看门狗」。两个会话的 ID 持久化在公开 `index` 文档中，启用期间受删除保护；根会话 `#1` 保持个人助理入口。已有用户资产不覆盖，部分初始化失败后可补齐缺失文件。

`dispatch_worker` 创建带 `worker` 标签的持久会话，按 Profile 点将，并在输入被 SDK 接受后返回，不等待模型回合结束。Worker 可在自身回合中调用 `subagent` 或 `SubagentWorkflow`。ThreadKey 订阅命中时直接投递 Worker；归档会立即解绑订阅，被直接删除的目标则在下一次该订阅事件到达时清除失效映射，并将原事件投递中枢。归档保留历史和产物，移除活跃索引及订阅，并将标签改为 `worker-archived`。

Worker 的 completed、failed、aborted 终态统一写入 `recall-graph`。回合消费的输入只要含 agent 或 trigger 来源，就向中枢投递带 `meta.renderer='superagent:worker-report'` 的汇报；纯 human 回合只更新 RecallGraph。中枢与 Watchdog 不向自身重复汇报。摘要来自真实时间线和产物元数据，不额外调用模型生成摘要。

Watchdog 用目标类别、机器、目标 ID 和权威状态序号区分异常，所有变更操作在执行前复核目标当前状态和持久归属。人类会话与终端窗格仅允许诊断和通知。Watchdog 的模型工具同时受声明白名单与执行钩子限制，不能经 bash、subagent 或 run_action 绕过归属守卫。

Herdr 的 `state_change_seq` 只反映状态翻转，不包含 working 内部活动。外部探针的 `stalledMs` 明确采用 `since-last-state-change` 口径；同一状态持续很久不能单独作为自动中止依据。缺少权威水位的目标只通知，不唤醒可执行模型。Herdr 终端审批继续使用原有单飞 CAS 桥，不由 SuperAgent 重复创建按键审批。

公开 `routing` 文档仅投射真实配置中的路由模式，供输入框开关展示；它不是第二份配置来源。中枢动作声明 Profile scope，并在执行时确认真实中枢 ID；Watchdog 动作也确认真实巡检会话，人工无会话上下文的 HTTP/CLI 调用仍需鉴权且不能绕过目标归属守卫。

## 通用机制修复

本阶段补齐 Watchdog 探针的目标类别、原生会话 ID、机器与权威水位；内核公开 `getConversationOwnership`，已删除会话不再保留可执行的归属授权。UI 契约新增 `UiSpecBase.docs` 及注册边界校验。

真实 SDK 回归发现，原 `waitForIdle` 的结算计数在异步 `turn_settled` 完成前已结束，而关停只等待最后一项并发结算。现在监听器返回 Promise，计数持续至异步副作用完成，关停汇合所有并发回调。结算快照在序号推进后构造，回调与读取接口观察一致的终态；关停还会等待已进入管道的巡检完成，防止插件释放后继续写旧文档。内核进入关闭阶段后拒绝提交新输入，插件通过注入的生命周期状态阻止关停时再次唤醒模型。

## 操作入口

```bash
pnpm helm plugins enable builtin:superagent --json
pnpm helm plugins doc builtin:superagent index --json
pnpm helm plugins doc builtin:superagent subscriptions --json
pnpm helm plugins doc builtin:superagent recall-graph --json
pnpm helm superagent dispatch_worker --prompt '检查项目并汇报结果' --profile-id assistant --json
pnpm helm superagent set_router_mode --input '{"enabled":false}' --json
```

其他动作的参数以 `pnpm helm superagent <动作> --help` 为准。动作由 `ctx.action` 自动映射，HTTP、CLI、Agent 与 Workflow 使用同一 Schema；人工无会话上下文的调用仍需 Hub 鉴权，Watchdog 目标归属守卫始终生效。

## 最终验收

最终功能提交为 `4d9f0ca`。下列检查针对同一份源码与测试执行；提交整理前后 `packages/` 逐字节无差异，未改变已验证代码。

| 检查 | 结果 | 完整日志 |
| --- | --- | --- |
| `pnpm typecheck`（包含 `pnpm build`） | 退出 0，生产与测试代码均通过 | `/tmp/helm-superagent-final-typecheck.log` |
| `timeout 50s pnpm test` | **748/748**；失败、取消、跳过均 0；约 16.3 秒 | `/tmp/helm-superagent-final-test.log` |
| 主插件 + Watchdog + 六项跨模块验收 | **53/53**，亦包含在全仓结果中 | `/tmp/helm-superagent-combined-final-candidate.log` |
| 编译后核心冒烟 | 退出 0；鉴权、脱敏、CLI、工作流等待、SSE snapshot | `/tmp/helm-superagent-final-built-core.log` |
| `timeout 50s pnpm exec node scripts/superagent-smoke.mjs` | 退出 0；启停、保护、动作、配置和 ID 重启恢复；无模型调用 | `/tmp/helm-superagent-final-repo-smoke.log` |

六项跨模块验收覆盖：默认停用零业务资产与动态常驻自举；模型请求工具收敛和人类目标保护；非阻塞派工与三终态汇报；ThreadKey 直投、归档与删除回退；真实 HTTP/CLI 共用 Schema 和配置持久化；先等 snapshot 再观察 UI 与公共文档增量、停用清空 UI。模型响应来自受控 faux provider，SDK Harness、SQLite、HTTP/SSE 和 CLI 子进程均为真实实现。

本轮额外保留的确定性 RED 证据：异步结算等待与并发关停为 `/tmp/helm-superagent-settlement-red.log`；回调水位与读取接口错位为 `/tmp/helm-superagent-settlement-seq-red.log`。对应修复已进入上述全绿代码。早期验收失败来自不完整的测试 Profile、错误响应消费顺序、删除目标后的清理时机断言，以及事件发生后才订阅 SSE；均已修正真实握手与资产，未通过跳过或削弱断言获取通过结果。

编译后插件冒烟已保存为仓内脚本，可复跑：

```bash
cd /root/code/helm
pnpm build
timeout 50s node scripts/superagent-smoke.mjs
```

本阶段没有执行真实外网模型或浏览器端验收，也没有重跑上一阶段的真实 Herdr/GLM 冒烟。Web 外壳尚未实现，UI 交付声明及事件消费契约；triggers、外部插件编译器和真实 SSH 远端端到端仍属后续范围。
