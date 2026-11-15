# builtin:token-speed — 实时解码速率

输入区状态行的实时解码速率（tok/s）只读插件：**默认停用**，显式启用后经 `COMPOSER_STATUS_SLOT`（`builtin:composer/status`）在宿主输入区状态区显示。算法参考本机 [pi-token-speed](https://www.npmjs.com/package/pi-token-speed) 扩展（时间滑动窗口 / burst-stall 平滑 / 工具执行暂停时钟 / 终值对账），按 helm 观察层的可观察事实重写。

## 机制与策略分离

- **内核只透传事实**：`ConversationLive.generation` 携带当前 generation 的 `attempt` 与受限 message 投影（text / thinking / toolCall name+arguments、供应商累计 `usage.output`），随既有 75ms live 节流帧流动，零速率计算、零额外持久写。停用本插件不改变内核行为。
- **策略全在插件**：滑动窗口速率、chars/4 估算、TTFT、burst/stall 平滑、provider usage 终值对账、工具执行时间剔除、显示格式。
- **高频会话级状态只进 sessionDoc**：`speed` 公共会话文档（专用 SSE 按需订阅）承载每会话速率状态，写入按 250ms 节流（首测 / 阶段变化 / 终态立即写），绝不进全局 `ctx.doc` 或 conversation summary。

## 数据流

```
内核 conversation.live 帧（generation 事实）
  └─ ctx.host.onEvent('conversation.live') → 状态机（token-speed/tracker.ts）
内核 conversation.entry（pi.assistant 最终 usage.output）
  └─ ctx.host.onEvent('conversation.entry') → FIFO 对账最近未对账解码段
ctx.hook.onTurnSettled
  ├─ conversation.status === 'working'：工具轮 handOver 的中间结算，链继续累计
  └─ 其余：链终点 → 终态对账值写入 sessionDoc（phase: 'settled'）
ctx.host.onEvent('conversation.deleted') → 状态机与会话文档彻底清理
sessionDoc('speed', public) → client.tsx TokenSpeedStatusBadge（专用 SSE）
```

## 算法口径（诚实性）

- **段（segment）**：同一 generation attempt 的连续内容增长；attempt 变化或内容快照大幅回退（message 清空 / 工具轮 handOver）都视为新段——重试与 partial 重放绝不重复累计；小幅回退（provider 在 `*_end` 重发整块文本）不重置。
- **解码净耗时（decodeMs）**：各段「首增长帧 → 末增长帧」之和。工具执行时间落在 generation 缺席帧（tools 阶段），段间自然拼接，绝不计入；两端各保守少计至多约一个节流窗（live 75ms × partial 提交 100ms 双重粒度）。
- **TTFT**：起点是插件**首次观测到空 generation 的帧时间**（SDK 不提供请求开始锚点，内核不伪造），终点是首次有效内容帧；中途接入（启用 / 重启发生在流中）拿不到起点时省略，不伪造；tooltip 如实标注「起点为插件首次观测，非请求精确起点」。
- **速率（tps）**：时间滑动窗口（默认 1000ms，可配 100–30000ms）内新增生成量 / 实际时间跨度；窗口内全部事件同段同刻（网关缓冲后一次冲刷）时跨度向前延伸到同段前驱事件（停滞期计入有效吞吐）；跨段绝不延伸；跨度下限 100ms 防尖峰。无可靠值（首字前 / 窗口滑空 / 工具暂停）不显示，**绝不以 0.0 tok/s 冒充**。
- **token 口径（source）**：优先用 `generation.message.usage.output` 供应商累计增量；无推进时退回 chars/4 估算（与内核 `estimateTokens` 同一保守口径，text/thinking/toolCall 参数全计）；`conversation.entry` 的最终 `usage.output` 是权威值，到达即对账覆盖该段流式口径；`mixed` 如实标注。
- **终态（phase: 'settled'）**：回合结算时输出 `outputTokens / decodeMs` 对账速率，保留显示到下一回合首测；中止 / 失败回合按实际观测结算，无可测累计时清空（不残留旧回合值）。

## 配置

| 字段 | 类型 | 缺省 | 说明 |
| :--- | :--- | :--- | :--- |
| `slidingWindowMs` | number | 1000 | 时间滑动窗口（毫秒，100–30000）；慢服务器建议 3000–15000（对齐 pi-token-speed 指引），从下一回合生效 |

## 启停

```bash
helm plugins enable builtin:token-speed   # 状态区出现速率徽标
helm plugins disable builtin:token-speed  # 徽标与文档订阅即时消失，无幻影残留
```

无动作 / 无工具 / 无 CLI 命令（纯只读展示，不触发五端映射义务）。

## 实现索引

- 生产者：`packages/plugins/src/token-speed.ts`（工厂 + 事件接线 + sessionDoc 发布节流）
- 契约：`packages/plugins/src/token-speed/contracts.ts`（文档形状、事件载荷守卫、常量）
- 算法：`packages/plugins/src/token-speed/tracker.ts`（纯状态机，时间注入可测）
- 前端：`packages/plugins/src/token-speed/client/index.tsx`（`TokenSpeedStatusBadge`）
- 测试：`packages/plugins/test/token-speed.test.ts`；内核事实透传：`packages/kernel/test/live-generation.test.ts`
