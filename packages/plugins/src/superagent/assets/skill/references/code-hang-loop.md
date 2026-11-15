# 代码死循环与测试卡死处置

适用场景：owned 原生会话长时间 `working` 且停滞持续增长（如子代理写出死循环测试、构建或脚本挂死，不再产生任何事件）。

1. 先 `watchdog_inspect({ conversationId })` 现查会话状态、最近时间线与 `conversation.activeProcesses`：这是目标会话工作目录 `(nodeId ?? 'local', cwd)` 的进程占用快照，每项为 `{ pid, name, source, path }`。字段缺省表示探测失败（节点离线等），不得当作「无占用」。
2. 结合最近消息与 `activeProcesses` 定位卡死进程（如卡在工作树目录里的 `vitest`、`node`、`python`，按 `pid` / `name` / `source` / `path` 识别归属目录）。
3. 目标为 owned（helm/bot）会话时，用 `watchdog_recover({ conversationId, hint })`（`whenBusy: 'steer'`）把卡死进程的 `pid` 与 `name` 写进恢复提示，交给该会话自行终止进程并续跑；提示只陈述事实，不代替其决策。
4. human 归属会话与一切外部终端窗格绝对只读：仅诊断并通知人类，严禁按键、恢复注入或中止。
5. 停滞达到 `abortAfterMs` 时，0-Token 层（L1 `autoAbort`）已经 `abortConversationGuarded` 中止当前回合，外层 `goal()` 会携带错误上下文进入下一次重试；此处只需复核中止与重试结果并如实上报，不重复中止。
6. 恢复后必须复查会话状态与 `activeProcesses` 确认进程已退出，不得凭模型输出宣布恢复。
