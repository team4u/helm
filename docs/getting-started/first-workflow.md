# 编写首个工作流

本文带你用 5 分钟跑通仓库自带的 `demo/hello-orchestra.workflow.js`：并行两路翻译加一路汇总的确定性编排。途中会经过选定目标会话、运行、观察执行流水与断点恢复四个环节，为后续阅读 [DSL 手册](../workflows/dsl-guide.md)建立直觉。

## 示例脚本逐段解读

demo 脚本全文如下（`demo/hello-orchestra.workflow.js`）：

```javascript
export const meta = {
  name: "hello-orchestra",
  description: "最小编排演示：并行两路 + 汇总",
  phases: [{ title: "并行打招呼" }, { title: "汇总" }],
}

log(`参数 word = ${args.word}`)
phase("并行打招呼")
const replies = await parallel([
  () => agent(`把「${args.word}」翻译成英文，只回翻译结果，不要多余内容。`, { label: "翻译英文" }),
  () => agent(`把「${args.word}」翻译成日语，只回翻译结果，不要多余内容。`, { label: "翻译日语" }),
])

phase("汇总")
const joined = replies.filter(r => r !== null).join(" / ")
const summary = await agent(`把「${joined}」合成一句话介绍，只回这一句话。`, { label: "汇总" })

return { replies, summary }
```

四个关键构件：`meta` 是脚本顶部的纯静态字面量，引擎在执行前静态提取它（`phases` 让 Web 界面在首个 agent 运行前就能渲染阶段分组）；`args` 是外部传入的 JSON 参数，通过 `--args` 提供；`phase(title)` 声明进入某个业务阶段，后续的 `agent` / `action` 调用自动归入该阶段；`agent(prompt, options)` 派生一个子智能体执行任务并返回其文本结果。

`parallel(thunks)` 并发执行无依赖任务：单个任务普通失败折叠为 `null` 不中断其余任务（因此脚本里 `replies.filter(r => r !== null)` 是惯用防御）。最终 `return` 的值经 JSON 边界校验后成为 run 的 `result`。

## 运行前：确定目标会话

新启动的工作流 run 必须指定所属会话，引擎不使用任何缺省路由策略。先查看现有会话：

```bash
pnpm helm conversations list --json
```

没有合适会话时创建一个：

```bash
pnpm helm conversations create --title "工作流试验场" --json
```

记下输出中的会话 ID（下文以 `1` 为例）。在受管环境（脚本已绑定会话上下文）中可用 `--current` 读取 `HELM_CONVERSATION_ID` 代替显式 ID。

## 运行与观察

```bash
pnpm helm workflows run demo/hello-orchestra.workflow.js \
  --args '{"word":"开源"}' --conversation-id 1 --wait --json
```

位置参数既可以是本地脚本文件路径（文件内容被读取为 `script` 提交），也可以是已保存工作流名；`--args` 传任意 JSON；`--wait` 阻塞到终态并直接输出最终 run（`failed` / `aborted` 时以非零退出码报错，该命令无超时限制）。

结束后检查执行记录与单个 run 的详情：

```bash
pnpm helm workflows runs                  # 列出运行记录（--json 取结构化输出）
pnpm helm workflows inspect <runId> --json # 查看节点状态流水、阶段、耗时与产出
```

`inspect` 的输出包含每个节点（`agent` / `action`）的状态、归属子会话 ID、token 消耗与结果预览，是排障的第一入口。也可以在 Web 控制台打开对应会话：时间线上的工作流卡片展示阶段胶囊进度，点击任一 `agent` 节点可在分屏中查看该子会话的完整交互。

## 断点恢复与中止

当某一步因模型限流或环境问题失败时，不需要整体重跑。携带 `--resume-from-run-id` 重新启动，引擎会读取原 run 的 JSONL 流水账本，从第 0 位开始严格前缀匹配（调用位次 + 参数哈希 + 调用类型），已成功的前缀节点零 Token 复用，自首个失配点起转为实时执行：

```bash
pnpm helm workflows run demo/hello-orchestra.workflow.js \
  --args '{"word":"开源"}' --resume-from-run-id <failedRunId> --conversation-id 1 --wait
```

省略 `--conversation-id` 时恢复沿用原 run 记录的会话；显式指定与原会话不一致会被 `400 validation_error` 拒绝。恢复默认沿用历史 `args`，显式传入新 `args` 可覆盖。若账本中存在无法判定副作用状态的悬挂非幂等动作，恢复会以 `workflow_action_uncertain` 显式拒绝，需人工确认后处理——判定规则见[状态流水与故障恢复](../workflows/journaling-recovery.md)。

需要停止在途任务时：

```bash
pnpm helm workflows abort <runId>
```

中止会优雅终止脚本 Worker、中止在途子会话并释放执行资源。

## 边界与约束

- `workflows` / `worktrees` 命令由 `builtin:workflow` 插件动态注册，停用该插件后命令随动作清单一并消失。
- 同一 run 仍处 `running` 状态时不可恢复，需先等待终态或 `abort`。
- 恢复匹配的是「调用位次 + 完整参数哈希」：任何参数微调（包括附件 ID 顺序）都会使对应调用失配转为重跑。
