# Token 速率插件

`builtin:token-speed` 解决「直观看到当前会话解码有多快」的问题：在宿主输入区状态行显示实时解码速率（tok/s）、首字延迟与终态对账值。适合关心模型响应速度的使用者。它是机制与策略分离的典型案例——内核只透传 `ConversationLive.generation` 通用流式事实（taskId + attempt + 受限 message 投影），零速率计算；滑动窗口、chars/4 估算、TTFT、burst/stall 平滑、按 taskId 对账、工具执行时间剔除等全部策略在本插件。算法参考本机 pi-token-speed 扩展（npm 包）按 helm 观察层事实重写。

## 当前状态

默认停用，显式 `helm plugins enable builtin:token-speed` 启用。纯只读展示：无动作、无工具、无 CLI 命令（不触发五端映射义务）。

## 能力和入口

### 展示与数据流

经 `ctx.ui.slot` 注入 `COMPOSER_STATUS_SLOT`（宿主输入区状态行），组件 `TokenSpeedStatusBadge` 经专用 SSE 订阅公共会话文档 `speed`（`ctx.sessionDoc`，写入按 120ms 节流并在窗口尾部延迟补写末帧；首测 / 阶段变化 / 速率首现 / 终态立即写）。徽标文本一律加 `≈` 前缀——一切速率都是节流帧观测估算，tooltip 明示口径。

```
内核 conversation.live 帧（generation 事实）→ 状态机（tracker.ts）
conversation.entry：pi.reset / pi.compaction / helm.rewind → 彻底清空该会话状态
                    pi.assistant 完成事实 → 按请求身份精确对账补算尾帧
turn_settled：failed/aborted → 清空当前测量；completed 链终点 → 终态写入 sessionDoc
conversation.deleted → 状态机与会话文档彻底清理
```

### 算法口径（诚实性）

- **段（segment）**：以 `(taskId, attempt)` 标识一次模型请求；工具轮切换由任务身份区分、重试由 attempt 区分；已完成段超缓存上限折叠为累计值，长回合不丢计数；
- **解码净耗时**：各段「首增长帧 → 末增长观测」之和，工具执行与请求等待不计入；工具执行期保持最近有效速率显示并明示暂停计时，不断流、不以 0.0 冒充；
- **TTFT**：起点锚为本回合首个非废弃段首次观测到空 generation 的帧时间（SDK 不提供请求开始锚点，内核不伪造；中途接入拿不到起点时省略）；终点是首次有效内容帧或 `pi.assistant` 落库时刻；
- **速率**：时间滑动窗口内新增生成量 / 实际跨度；跨度下限 100ms 防尖峰，跨段绝不延伸；终态只汇总计数与观测时长可配对的成功响应，中途启用仅观测到后半段时不用整条 usage 除以残缺时长；
- **token 口径**：优先 `usage.output` 供应商累计增量，无推进时退回 chars/4 估算（与内核 `estimateTokens` 同口径），`mixed` 如实标注。

## 配置与数据边界

| 配置 | 类型 | 缺省 | 说明 |
| :--- | :--- | :--- | :--- |
| `slidingWindowMs` | integer | 1000 | 时间滑动窗口（100..30000 毫秒）；慢服务器建议 3000–15000；从下一回合生效 |

会话速率状态只进 public `sessionDoc`（专用 SSE 按需订阅），绝不进全局 `ctx.doc` 或 conversation summary。

## 停用与失败语义

本插件数据全部是**派生测量**（可由新流量重建，无迁移、无回退）：

- **启用周期开始**（`prepare` 屏障，先于任何服务 start 与输入恢复）：清空上一周期遗留的全部 `speed` 会话文档——重启或中途启用拿不到完整测量，宁可显示空，绝不把上周期 decoding/tools 态冒充当前；
- **上下文失效**：`pi.reset` / `pi.compaction` / `helm.rewind` 落库即彻底清空该会话状态，不回读旧上下文、不回退旧 TPS；
- **失败/中止回合**：直接清空当前测量，未完成回答绝不冒充正常终态；completed 终态保留显示到下一回合首测覆盖；
- **停用**：UI 贡献、事件监听与文档订阅即时消失，无幻影残留；内核照常透传事实，零额外计算。

## 源码与测试入口

| 内容 | 位置 |
| :--- | :--- |
| 插件入口（事件接线 + 节流发布 + 生命周期） | `packages/plugins/src/token-speed.ts` |
| 契约与常量 | `packages/plugins/src/token-speed/contracts.ts` |
| 纯状态机（时间注入可测） | `packages/plugins/src/token-speed/tracker.ts` |
| 前端徽标 | `packages/plugins/src/token-speed/client/index.tsx` |
| 测试 | `packages/plugins/test/token-speed.test.ts`、`token-speed-metering.test.ts`（重试、工具轮、迟到快照、长回合计量）、`token-speed.integration.test.ts`（真实组合层）；内核事实透传 `packages/kernel/test/live-generation.test.ts` |

## 相关文档

- [插件系统设计与契约](overview.md)：`ctx.sessionDoc` 分片与专用 SSE 机制
- [微内核架构总览](../architecture/overview.md)：内核只透传通用流式事实的边界
