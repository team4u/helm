# builtin:token-speed — 实时解码速率

输入区状态行的实时解码速率（tok/s）只读插件：**默认停用**，显式启用后经 `COMPOSER_STATUS_SLOT`（`builtin:composer/status`）在宿主输入区状态区显示。算法参考本机 [pi-token-speed](https://www.npmjs.com/package/pi-token-speed) 扩展（时间滑动窗口 / burst-stall 平滑 / 工具执行暂停时钟 / 终值对账），按 helm 观察层的可观察事实重写。

## 机制与策略分离

- **内核只透传事实**：`ConversationLive.generation` 携带当前 generation 的 `taskId / attempt` 与受限 message 投影（text / thinking / toolCall name+arguments、供应商累计 `usage.output`），随既有 75ms live 节流帧流动，零速率计算、零额外持久写。停用本插件不改变内核行为。
- **策略全在插件**：滑动窗口速率、chars/4 估算、TTFT、burst/stall 平滑、provider usage 终值对账、工具执行时间剔除、显示格式。
- **高频会话级状态只进 sessionDoc**：`speed` 公共会话文档（专用 SSE 按需订阅）承载每会话速率状态，写入按 250ms 节流（首测 / 阶段变化 / 终态立即写），绝不进全局 `ctx.doc` 或 conversation summary。

## 数据流

```
内核 conversation.live 帧（generation 事实）
  └─ ctx.host.onEvent('conversation.live') → 状态机（token-speed/tracker.ts）
内核 conversation.entry（信封校验后按 kind 分流）
  ├─ pi.reset / pi.compaction / helm.rewind：上下文失效 marker → 彻底清空该
  │   会话速率状态（状态机 + 节流指纹 + speed 文档），不回读旧上下文、
  │   不回退旧 TPS
  └─ pi.assistant 完成事实（taskId / usage.output / stopReason）→ 按请求
      身份精确对账对应解码段（aborted / error 尝试计数与时间作废；无
      taskId 的 entry 身份不明不关联）
ctx.hook.onTurnSettled
  ├─ conversation.status === 'working'：工具轮 handOver 的中间结算，链继续累计
  ├─ outcome === 'failed' / 'aborted'：未完成回答绝不冒充正常终态，直接清空
  │   当前测量（含文档）
  └─ 其余（completed 链终点）：终态对账值写入 sessionDoc（phase: 'settled'）
ctx.host.onEvent('conversation.deleted') → 状态机与会话文档彻底清理
sessionDoc('speed', public) → client.tsx TokenSpeedStatusBadge（专用 SSE）
```

## 生命周期与清理语义

本插件的数据全部是**派生测量**（可由新流量重建，无迁移、无静默回退）：

- **启用周期开始**（启动或中途启用；服务 `prepare` 屏障，先于任何服务 `start` 与输入恢复）：清空上一周期遗留的全部 `speed` 会话文档（含已结算终态）。重启或中途启用无法取得完整测量，**宁可显示空，绝不把上周期的 decoding/tools 实时态冒充当前**；停用期间持久行保留（会话文档承诺跨停用存活），下一周期 `prepare` 统一清理。
- **运行期**：completed 终态（`phase: 'settled'`）保留显示到下一回合首测覆盖——这是本插件选择的简单语义（最后一次真实结算结果继续可见）；失败 / 中止回合直接清空，不残留旧值。
- **上下文失效**：`pi.reset` / `pi.compaction` / `helm.rewind` 落库即旧上下文失效，其上的速率事实对新上下文不可归属，彻底清空，绝不回退显示旧 TPS。
- **停用**：UI 贡献、事件监听与文档订阅即时消失（无幻影残留）；服务 `stop` 清内存态。

## 算法口径（诚实性）

- **一切速率都是观测估算**：输入是内核 live 节流帧（75ms）叠加 pi-durable partial 提交节流（约 100ms）的累计快照，不是逐 token 事件；所有基于帧时间的速率（含终态对账速率）都只是帧粒度近似——**即使终态 token 数经 provider usage 对账准确，时间仍是观测近似**。徽标文本一律加 `≈` 前缀（移动端无 title 也能看到估算口径），tooltip 明示「时间为节流帧观测近似，非服务器精确解码时间」。
- **段（segment）**：以 `(taskId, attempt)` 标识一次模型请求。工具轮切换由任务身份区分，重试由 attempt 区分；即使工具帧被节流合并，仍能正确分段。内容回退不用于猜测身份，已完成请求的迟到快照不会复活旧测量。已完成段超过缓存上限时折叠为累计值，长回合不丢计数。
- **解码净耗时（decodeMs）**：各段「首增长帧 → 末增长帧」之和，段间的工具执行和请求等待不计入。实时窗口在新请求开始时重置，避免跨请求混算。两端时间受 SDK partial 提交和 live 节流影响，并非服务器解码时间。
- **TTFT**：起点是插件**首次观测到空 generation 的帧时间**（SDK 不提供请求开始锚点，内核不伪造），终点是首次有效内容帧；中途接入（启用 / 重启发生在流中）拿不到起点时省略，不伪造；tooltip 如实标注「起点为插件首次观测，非请求精确起点」。
- **速率（tps）**：时间滑动窗口（默认 1000ms，可配 100–30000ms）内新增生成量 / 实际时间跨度；窗口内全部事件同段同刻（网关缓冲后一次冲刷）时跨度向前延伸到同段前驱事件（停滞期计入有效吞吐）；跨段绝不延伸；跨度下限 100ms 防尖峰。无可靠值（首字前 / 窗口滑空 / 工具暂停）不显示，**绝不以 0.0 tok/s 冒充**。
- **token 口径（source）**：优先用 `generation.message.usage.output` 供应商累计增量；无推进时退回 chars/4 估算（与内核 `estimateTokens` 同一保守口径，text/thinking/toolCall 参数全计）；`conversation.entry` 的最终 `usage.output` 是权威值，到达即对账覆盖该段流式口径；`mixed` 如实标注。
- **终态（phase: 'settled'）**：仅将计数与观测时长可配对的成功响应汇总计算速率；中途启用仅观测到后半段、或整个响应只有一个增长帧时，不用整条 usage 除以残缺时长。累计 token 数仍如实保留。无可测响应时不显示速率；有可靠观测时保留显示到下一回合首测。失败 / 中止回合与上下文失效 marker 直接清空（见「生命周期与清理语义」）。

## 配置

| 字段 | 类型 | 缺省 | 说明 |
| :--- | :--- | :--- | :--- |
| `slidingWindowMs` | number | 1000 | 时间滑动窗口（毫秒，100–30000）；慢服务器建议 3000–15000（对齐 pi-token-speed 指引），从下一回合生效 |

## 启停

```bash
helm plugins enable builtin:token-speed   # 状态区出现速率徽标；上周期遗留测量被清空，由新流量重建
helm plugins disable builtin:token-speed  # 徽标与文档订阅即时消失，无幻影残留；重启用时 prepare 再清上周期持久行
```

无动作 / 无工具 / 无 CLI 命令（纯只读展示，不触发五端映射义务）。

## 实现索引

- 生产者：`packages/plugins/src/token-speed.ts`（工厂 + 事件接线 + sessionDoc 发布节流 + 生命周期服务）
- 契约：`packages/plugins/src/token-speed/contracts.ts`（文档形状、事件载荷守卫、常量）
- 算法：`packages/plugins/src/token-speed/tracker.ts`（纯状态机，时间注入可测）
- 前端：`packages/plugins/src/token-speed/client/index.tsx`（`TokenSpeedStatusBadge`）
- 测试：`packages/plugins/test/token-speed.test.ts`（算法 + 装配 + 生命周期）、`packages/plugins/test/token-speed-metering.test.ts`（重试、工具轮、迟到快照和长回合计量）；真实组合层集成：`packages/plugins/test/token-speed.integration.test.ts`；内核事实透传：`packages/kernel/test/live-generation.test.ts`
