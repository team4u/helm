# herdr-smoke.mjs — `builtin:herdr` 真链路手工验收脚本

独立手工验收脚本，**不纳入 `pnpm test`**（依赖真实 Herdr 服务、真实 pi CLI 与真实模型凭据，会产生真实模型调用）。由人工在合并最终代码后执行：

```bash
pnpm build                                  # 先产出 packages/kernel/dist
node scripts/herdr-smoke.mjs                # 默认 provider=magpie model=zhipu/glm-5.3
node scripts/herdr-smoke.mjs --json         # 机器可读汇总
node scripts/herdr-smoke.mjs --keep-tmp     # 成功后保留临时根（含完整 herdr server 日志）
node scripts/herdr-smoke.mjs --timeout-ms 600000   # 放宽总超时（60000..1800000）
```

退出码 0 = 全部验收项 PASS；非 0 = 存在 FAIL（stdout 逐项输出 `PASS/FAIL`，失败现场与日志保留在临时根，绝不删除）。

## 验证内容（全部真实组件，零 mock / 零 skip）

1. **真实编译产物**：`packages/kernel/dist/app.js` 的 `createHelm`（未 build 即显式失败）。
2. **真实插件生命周期**：`plugins.setConfig('builtin:herdr', { session, socketPath, startupTimeoutMs: 30000 })` → `plugins.enable`。
3. **真实 Profile API**：`kernel.profiles.save({ id: 'herdr-smoke-pi', runtime: { kind: 'herdr', agent: 'pi', args: [...] } })`。
4. **真实 GLM 模型**：预检 `pi --list-models` 确认目标模型在列（凭据不可用则显式失败，绝不换默认模型），Profile args 传 `--provider magpie --model zhipu/glm-5.3 --thinking off -a --no-session`（均经 `pi --help` 核实）。
5. **真实工作流**：`workflows.run(script)` → `wait`：
   - 节点一：`agent(prompt, { label:'task', agentType:'herdr-smoke-pi', isolation:'worktree', schema:{answer:number}, gate })`——插件经 `herdr worktree create --trust-repository` 建隔离工作树，pi 在其中创建 `artifact.txt`（三行），gate 用 `wc -l` 真实验证；
   - 节点二：`agent(prompt, { resume:'task' })` 在**同一 Herdr pane** 续聊。
6. **结算断言**：结果字段（`first.answer === 3`、`second` 非空）、两节点 `executionId` 相同、Gate 仅第一节点且 `ok=true`、worktree 目录/分支在 run 结算后保留、`artifact.txt` 内容逐字节核对、真实 `session.snapshot`（protocol 22，官方 socket RPC 一连接一请求）确认本 workflow pane 已全部关闭。
7. **`resumeFromRunId` 重放**：结果结构等价、`replayedFrom` 标记正确、重放 run 同样完整清理。

## 已知源码语义差异（重要）

主任务曾预期「重放无新 pane 和模型调用」。经源码核实（`packages/kernel/src/workflow/runtime.ts`）：账本中含 `agent({resume})` 的行携带 `resumed: true` 标记，引擎据此将**整个账本视为不可前缀重放**（`journalResumes → prefixIntact=false`）——这是刻意设计：resume 续接的是活的终端会话，无法靠重放文本复现。因此本脚本的 resumeFromRunId 是 **live 重跑**（新 pane + 真实模型调用 + 新 worktree 分支）。脚本如实断言两种语义下都成立的不变量（结果结构等价 + 双 run 清理完整 + Gate 仅首节点），并在 stdout 输出 NOTE 说明，绝不伪造「零模型调用」断言。

## 隔离与安全边界

- **独立 headless session**：`spawn('herdr', ['--session', <唯一名>, 'server'])` 前台子进程，stdout/stderr 全量落 `<tmp>/logs/herdr-server.log`；等待**自己的 socket**（`<tmp>/xdg/herdr/sessions/<name>/herdr.sock`）可连接且 `session.snapshot` 应答后才继续。
- **环境净化**：子进程与本脚本进程（加载内核前）都剔除全部继承的 `HERDR_*`（`HERDR_SOCKET_PATH/PANE_ID/TAB_ID/WORKSPACE_ID/...`），设置独立 `XDG_CONFIG_HOME` 与显式 `HERDR_SOCKET_PATH`——绝不触碰用户现有 session / pane / 主 Herdr 进程。
- **清理纪律**：只 `herdr --session <name> server stop` 自己创建的 session；成功路径先验证 worktree 目录/分支确实保留，再仅当 `git rev-parse --git-common-dir` 属于本次临时仓库时移除自己创建的 worktree；失败路径保留全部现场与日志。所有失败分支同样走 finally 清理。
- **机密**：不打印任何 token / env / auth 文件内容；错误信息只含命令输出尾部。
- **端口**：不监听任何端口（内核以库形态进程内运行，不起 Hub server）。
- **总超时**：`--timeout-ms`（默认 180000，范围 60000..1800000）覆盖全流程；等待 socket 只做 250ms 连接退避，不用 sleep 猜流程完成。

## 依赖

- node >= 24（`node:sqlite`）、已 `pnpm build` 的内核产物；
- PATH 上的 `herdr`（>= 0.9.5 / protocol 22）、`pi`、`git`；
- `~/.pi/agent/auth.json` 内目标模型的真实凭据（本机为 magpie 网关）。
