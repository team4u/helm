# 工作流与多智能体参考

## 跨 Profile 点名协同

- 用户写 `@<profileId>` 时，由当前会话理解任务并主持协作；它不是强制转发指令。引用、代码或示例里的 `@` 不表示授权执行任务。
- 若本回合提供 `<available_profiles>`，按其中的真实 ID 与摘要选择角色；调用 `agentType` 时不带 `@`。目录不存在时，不猜测角色 ID 或假装工具可用。
- 只传必要任务、结论与当前会话有权使用的附件，不默认复制主会话全部历史或读取其他角色的完整 SYSTEM.md / MEMORY.md。子会话各有对话上下文，但同一 Profile 的长期记忆由该 Profile 共享。
- 节点、目录和 Worktree 可能不同；没有自动同步文件。不要把一个节点的本地路径当作另一节点可访问的文件。附件授权只覆盖调用会话及其父链，不能凭子会话或兄弟会话的产物 ID 任意转交。
- 由主会话汇总各角色结论并处理冲突；多轮复核设置明确终止条件与轮数上限，不无限派生或争论。

## subagent 工具（模型内派生）

当前会话可调用 `subagent` 派生子代理；默认等待最终结果，`background: true` 在环境就绪后返回运行句柄并继续后台执行：
- 必选：`prompt`（任务指令）。
- 可选：`agentType`（Profile ID 或外部运行时标识如 `herdr:agy`、`herdr:claude@node-a`）、`schema`（JSON Schema 结构化输出）、`gate`（shell 验收命令，exit 非 0 即失败）、`cwd`、`isolation`（worktree）、`model`（provider/model）、`effort`、`attachments`（产物 ID 列表）、`resume`（上次 execution.conversationId / executionId，续接同一执行上下文）。
- 默认可派两级子代理：主会话是第 0 层，一级可继续派二级，二级为叶子。小任务直接执行；需要自主拆解的大方案交给一级负责人，无须额外授权参数。主会话可显式传 `maxSubagentDepth: 3`（整数 1..5）为大型任务提高上限，受管子代理只能继承或降低上限，不能自行提高。该值为相对任务树根的绝对层级，不是剩余层数。全局默认可通过插件中心或 `helm plugins config` 修改。
- 返回业务 result 与执行元数据（nodeId/conversationId/executionId/effectiveCwd/worktree）独立；后续可凭 resume 续接。
- 后台返回 `runId` 和实际 execution；父回合结束后继续执行，Schema 与 gate 都完成后自动汇报。`helm workflows inspect <runId> --json` 查询，`helm workflows abort <runId>` 中止。
- `isolation: "worktree"` 在目标节点分配独立 Git 工作树（原生及支持该能力的运行时）；基于源 HEAD，不包含源工作区未提交修改。任务结束、失败或取消后保留工作树与分支。
- 检视或合入后调用 `cleanup_worktree({ worktreeId: execution.worktree.id })`；也可按子会话 ID，或实际 `nodeId` + `path` 清理。未提交修改、未合入提交及在用工作树默认拒绝清理。`force: true` 仅显式允许丢弃修改，不绕过归属或占用检查。
- 只读检视（不执行任何写操作）：`helm worktrees list` 列出全部登记（含已清理记录元数据）；`helm worktrees inspect <worktreeId>` 返回登记元数据 + 目标节点真实 git 只读探测（当前分支/HEAD、未提交文件清单、领先基线提交数、diff 统计与有上限预览；`--conversation-id <id>` / `--path <path> [--node-id <nodeId>]` 可替代选择器）。仅登记记录可检视，不支持任意目录；目录缺失/已清理时如实返回 unavailableReason，git 失败显式报错。
- CLI：`helm worktrees cleanup --worktree-id <worktreeId> --json`；`--current` 使用当前子会话；`--path <path> --node-id <nodeId>` 精确选择节点目录。`--delete-branch` 同时删除分支（默认保留）。
- Hub 重启会将中断的后台运行明确标为失败并汇报；需要时凭原 execution 的 resume 标识续接，不自动重新派工或重跑 gate。
- 中断运行或外部执行失败后，若无法确认底层已停止，持久租约会阻止自动清理（worktree_execution_unknown）；先检查目标节点并续接收尾，或确认停止后通过 helm env exec 在原节点手动执行 Git 清理。force 不绕过此检查。

## SubagentWorkflow 确定性编排脚本

会话内编排**优先直接调用原生 `SubagentWorkflow` 工具**（无需先落临时文件再走 `bash`）：
- 入参：`script`（内联 JS 源码）、`scriptPath`（脚本文件路径）或 `name`（已保存工作流名）三者择一；可选 `args`（JSON 对象/数组或标量，原样传给脚本内 `args`；若以 JSON 字符串传入，内核会自动解析为对象）与 `resumeFromRunId`（断点重放）。
- 原生 `SubagentWorkflow` 工具自动绑定当前会话与工具调用行，在聊天时间线与右侧工作台实时展示多阶段进度、节点状态与子代理流，并在编排完成后直接返回完整 `summary`（含 `id`、`status`、`phases`、`nodes`、`result`）。
- 仅在终端或外部脚本调度时使用 CLI：`helm workflows run <nameOrFile> [--args <json>] [--resume-from-run-id <id>] [--current] [--wait]`（受管 `bash` 内默认读取 `HELM_CONVERSATION_ID` 归属当前会话，也可显式传 `--current`）：

```js
export const meta = {
  name: "audit-report",
  description: "对仓库跑安全审计并汇总报告",
  phases: [{ title: "审计" }, { title: "复核" }],
}

const reports = await pipeline(
  args.files,
  file => agent(`只读审查 ${file}，返回问题与依据。`, { phase: "审计" }),
  (report, file) => agent(`复核 ${file} 的报告：${report}`, { phase: "复核" }),
)
return { reports: reports.filter(report => report !== null) }
```

### 脚本内可用 API（由宿主注入；无模块加载器，不能 import/require）

- `meta`：必须是纯字面量对象（`export const meta = { name, description, phases? }`，phases 为 `[{ title, detail?, model? }]`）；禁止模板串/变量/函数调用。
- `args`：运行时经 `--args` 或工具入参传入的 JSON（对象/数组/标量，经反序列化注入；缺省 undefined，可自由约定形状）。
- `agent(prompt, opts?)`：调用同一子代理执行接口并等待真实结果；opts 为 `{ label?, phase?, model?, agentType?, isolation?("worktree"), gate?, resume?, effort?, schema?, attachments?, maxSubagentDepth? }`。脚本用 pipeline/parallel 表达并发，节点不提前返回后台句柄。
- `pipeline(items, ...stages)`：对每个 item 依序过全部 stage（同一 item 串行、不同 item 并行），单条失败该项置 null 不炸全局；优先于 parallel 组织批量任务。
- `parallel(thunks)`：全量并发，单项失败置 null。
- `action(actionId, input?, opts?)`：零 Token 确定性调用宿主动作总线（`pluginId.actionId` 全限定或无冲突短名；输入输出经 schema 校验；opts 支持 `{ idempotent?, label?, phase? }`）。
  - 内建跨节点命令动作：`action("env.exec", { command, cwd?, nodeId?, env?, timeoutMs?, allowFailure? }, { idempotent?, label?, phase? })`（无冲突时可用短名 `"exec"`），底层复用内核 EnvFabric 跨节点通道、SecretStash 机密注入与脱敏，返回 `{ ok, exitCode, output, timedOut }`。
- `phase(title)` / `log(message)`：进度标注与日志。
- `workflow(ref, args?)`：按名或 `{ scriptPath }` 嵌套子工作流（仅一层深）。
- `budget.spent()`：已消耗输出字节；`budget.total` 为 null、`budget.remaining()` 为 Infinity，不能据此承诺成本预算。
- `schema` 用于验证子代理结果，`gate` 在子代理实际工作目录中运行 shell 命令；非零退出表示失败。批量结果需检查 null，不能把部分失败汇报成全部完成。

### 确定性铁律（违反即失败，断点重放的根基）

- 禁用 `Date.now()` / `Math.random()` / 无参 `new Date()` / `eval` / `Function` 构造器；需要时间戳请在脚本返回后补，或经 args 传入。
- 脚本结果与全部 agent/action 入参出参都必须可 JSON 序列化（不可序列化直接拒绝）。

### 断点重放（resumeFromRunId）

调用 `SubagentWorkflow({ resumeFromRunId: "<runId>", ... })`（或 CLI `helm workflows run <name> --resume-from-run-id <runId> --current --wait`）读取旧账本；匹配的已完成节点直接重放结果，agent/action 与已通过的 gate 不重复执行。参数变化（包括 gate 命令）会使对应节点重新执行。
`agent(..., { resume: "<label>" })` 则是续接代理上下文，与账本重放不同；不要同时指定 agentType/model/isolation/effort，schema、gate、本轮 attachments 与 maxSubagentDepth 可以随续接提交；层级授权变化会使旧账本缓存失配。续接不自动继承上轮附件；附件 ID 或顺序变化也会影响账本匹配。原生子会话须仍存在、归属当前父会话且空闲；外部运行时还受其清理生命周期限制，失效时如实报错，不假装续接成功。

## 与 builtin:herdr 终端 Agent 路由

- 启用 builtin:herdr 后，agentType 形如 `herdr:<kind>` 或 `herdr:<kind>@<nodeId>`（kind 如 agy/claude/codex/pi 等，由 Herdr 校验）会被 herdr 插件拦截：在目标节点 Herdr 后台标签页开窗格执行。
- 也可建 Profile：`runtime: { kind: "herdr", agent: "<kind>", nodeId?, workspace?, env? }`，之后 `agentType` 直接用该 Profile ID。
- 结果经工作目录下 `.helm/wf-out-<safeId>.json|.md` 交接文件回传（subagent 原地追问自愈）；终端 blocked 状态实时桥接为带 expectedStateSeq CAS 乐观锁的 AskDoc 审批卡（人类已在终端按键则 Web 端自动 superseded）。

## 与 builtin:superagent 后台 Worker 协作

启用 builtin:superagent 后，通过 `helm actions list --json` 查询 dispatch_worker、inspect_worker、archive_worker 等动作及 Schema，再用 `helm superagent <action> --input <json> --json` 调用。它们负责非阻塞派工、跟踪和归档；专属中枢会话还提供 recall_context、subscribe_thread 等工具，看门狗会话提供 watchdog_inspect / watchdog_recover / watchdog_abort。
Watchdog 对 ownedBy: human 的会话或终端窗格只允许只读诊断和通知，不得发送按键或中止。
