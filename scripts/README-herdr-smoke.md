# herdr-smoke.mjs — `builtin:herdr` 真链路手工验收脚本

独立手工验收脚本，**不纳入 `pnpm test`**（依赖真实 Herdr 服务、真实 pi CLI 与真实模型凭据，会产生真实模型调用）。由人工在合并最终代码后执行：

```bash
pnpm build                                  # 先产出 packages/kernel/dist
node scripts/herdr-smoke.mjs                # 默认 provider=magpie model=zhipu/glm-5.3
node scripts/herdr-smoke.mjs --json         # stdout 恰好一个最终 JSON（进度在 stderr）
node scripts/herdr-smoke.mjs --keep-tmp     # 成功后保留临时根（含完整 herdr server 日志）
node scripts/herdr-smoke.mjs --timeout-ms 600000   # 放宽总超时（60000..1800000）
```

默认加载脚本同仓的 `packages/kernel/dist/app.js`；可用 `HERDR_SMOKE_KERNEL_APP=/path/to/app.js` 指向其他编译产物（如另一 worktree 的 build）。

退出码 0 = 全部验收项 PASS 且清理无失败；非 0 = 存在 FAIL（验收项失败或清理失败）。进度与 `PASS/FAIL` 逐项写 stderr；失败现场与日志保留在临时根，绝不删除。注：当前主干 dist 尚未包含 `builtin:herdr` 注册（app.ts 集成待合并），脚本会如实报「未注册的插件：builtin:herdr」——这正是等待合并后验收的预期行为，绝不静默跳过。

## 验证内容（全部真实组件，零 mock / 零 skip）

1. **真实编译产物**：`packages/kernel/dist/app.js` 的 `createHelm`（未 build 即显式失败）。
2. **真实插件生命周期**：`plugins.setConfig('builtin:herdr', { session, socketPath, startupTimeoutMs: 30000 })` → `plugins.enable`。
3. **真实 Profile API**：`kernel.profiles.save({ id: 'herdr-smoke-pi', runtime: { kind: 'herdr', agent: 'pi', args: [...] } })`。
4. **真实 GLM 模型**：预检 `pi --list-models` 确认目标模型在列（凭据不可用则显式失败，绝不换默认模型），Profile args 传 `--provider magpie --model zhipu/glm-5.3 --thinking off -a --no-session`。
5. **真实工作流**：`workflows.run(script)` → `wait`：
   - 节点一：`agent(prompt, { label:'task', agentType:'herdr-smoke-pi', isolation:'worktree', schema:{answer:number}, gate })`——插件经 `herdr worktree create --trust-repository` 建隔离工作树，pi 在其中创建 `artifact.txt`（三行），gate 真实验证；
   - 节点二：`agent(prompt, { resume:'task' })` 在**同一 Herdr pane** 续聊。
6. **原始 run 断言**：结果字段（`first.answer === 3`、`second` 非空）、两节点 `executionId` 相同、Gate 仅第一节点 `ok=true` 且 shell 侧 `gate-count` 铁证恰好一行、worktree 目录/分支在 run 结算后保留、`artifact.txt` 内容逐字节核对、真实 `session.snapshot`（protocol 22）确认 pane 已全部关闭。
7. **`resumeFromRunId` 严格重放（引擎修复目标契约）**：
   - `result2` 与 `result1` **深相等**（`assert.deepStrictEqual`）；
   - 重放 run 的两个 agent 节点均 `done` 且 `cached=true`（缓存命中而非 live 重跑）；
   - 经透明包装**生产 transport**（`createHerdrTransport`，同 dist 目录导入，只计数不改行为）计数的 `agent.start` / `agent.prompt` RPC 调用**零增长**（原始 run 的计数不硬编码，允许一次合法自愈，只比较重放前后）；
   - Gate 不重跑（`gate-count` 仍恰好一行）；
   - snapshot 无新 pane/workspace（零新资源）。

缓存节点不要求携带原 run 的 `executionId`/`worktree` 元数据（原 run 已验证过这些），重放只验证**无新调用、无新资源、结果一致**。

### 引擎修复目标（背景）

旧引擎实现中 `journalResumes`（账本含 `agent({resume})` 行）会全局关闭前缀重放（`prefixIntact=false`），导致 `resumeFromRunId` 对含 resume 的脚本 **live 重跑全部副作用**——包括已确认成功的 action 与 agent，这是引擎缺陷而非可接受的验收替代。正在修复的契约：**相同脚本的全部成功 agent/resume/action 前缀可直接缓存重放，只有试图 live 续接缓存上下文时才显式失败**。本脚本按修复后的契约断言；在缺陷未修复的引擎上运行会在「深相等 / cached=true / 零新增调用」处如实 FAIL。

## 传输层与计数

- 导入与 `app.js` 同目录的 `builtin-plugins/herdr/transport.js` 的 `createHerdrTransport`（生产实现）；
- `createTracedTransport` 透明包装：仅按 `method` 计数 `agent.start` / `agent.prompt`，`call` 与其余方法完全透传，**绝不 mock 返回**；
- 包装后的 transport 注入 `createHelm({ herdrTransport })`，脚本自身的 `session.snapshot` 每次调用带有限 `timeoutMs`（复用生产实现，无自制 raw socket 读取）。

## 隔离与安全边界

- **独立 headless session**：`spawn('herdr', ['--session', <唯一名>, 'server'])` 前台子进程（监听 `error` 事件，ENOENT 等启动失败显式报错），stdout/stderr 全量落 `<tmp>/logs/herdr-server.log`；等待**自己的 socket**（`<tmp>/xdg/herdr/sessions/<name>/herdr.sock`）可连接且 `session.snapshot` 应答后才继续。
- **环境净化与 socket 解析**：生产 transport 的优先级是 `socketPath > HERDR_SOCKET_PATH > session`（session 经 `XDG_CONFIG_HOME` 推导路径）。脚本将内核配置的 `socketPath`、进程 `HERDR_SOCKET_PATH` 与 `XDG_CONFIG_HOME` 三者全部指向同一隔离 socket——任何优先级下解析结果一致；同时剔除继承的全部 `HERDR_*` 定位变量（`PANE_ID/TAB_ID/WORKSPACE_ID/...`），绝不触碰用户现有 session / pane / 主 Herdr 进程。
- **清理纪律**：只 `herdr --session <name> server stop` 自己创建的 session（15s 超时，之后 SIGTERM→SIGKILL 兜底）；成功且清理无失败时，先验证 worktree 目录/分支确实保留，再仅当 `git rev-parse --git-common-dir` 属于本次临时仓库时移除自己创建的 worktree；**任一清理失败 => 整体 FAIL、exit 1、保留全部现场与日志**。清理阶段有独立有界预算，总超时后仍确保关闭自己的 server。
- **机密**：不打印任何 token / env / auth 文件内容；错误信息只含命令输出尾部。
- **端口**：不监听任何端口（内核以库形态进程内运行，不起 Hub server）。
- **总超时**：`--timeout-ms`（默认 180000，范围 60000..1800000）覆盖主流程；等待 socket 只做 250ms 连接退避，不用 sleep 猜流程完成。

## 依赖

- node >= 24（`node:sqlite`）、已 `pnpm build` 的内核产物（含 `dist/builtin-plugins/herdr/transport.js`）；
- PATH 上的 `herdr`（>= 0.9.5 / protocol 22）、`pi`、`git`；
- `~/.pi/agent/auth.json` 内目标模型的真实凭据（本机为 magpie 网关）。
